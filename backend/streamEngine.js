
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const { exec } = require('child_process');
const { db } = require('./database');

// Store active streams: key = streamId, value = { command, userId, playlistPath, activeInputStream, loop: boolean }
const activeStreams = new Map();

const killZombieProcesses = () => {
    return new Promise((resolve) => {
         console.log('Cleaning up zombie FFmpeg processes...');
         exec('pkill -f ffmpeg', (err, stdout, stderr) => {
             activeStreams.clear();
             console.log('System clean. All streams reset.');
             resolve();
         });
    });
}

// Helper to check for audio stream
const checkFileHasAudio = (filePath) => {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error(`[FFprobe Error] ${filePath}:`, err);
                resolve(false);
            } else {
                const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');
                resolve(hasAudio);
            }
        });
    });
};

const startStream = (inputPaths, rtmpUrl, options = {}) => {
  const { userId, loop = false, coverImagePath, title, description } = options;
  const files = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  const isAllAudio = files.every(f => f.toLowerCase().endsWith('.mp3'));
  
  // Generate Unique Stream ID
  const streamId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  
  return new Promise(async (resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;
    let currentPlaylistPath = null;
    let activeInputStream = null;
    let hasStarted = false;

    // =========================================================
    // 1. AUDIO MODE (MP3) - WORKING PERFECTLY
    // =========================================================
    if (isAllAudio) {
      if (!coverImagePath || !fs.existsSync(coverImagePath)) {
        command.input('color=c=black:s=1280x720:r=25').inputOptions(['-f lavfi', '-re']);
      } else {
        command.input(coverImagePath).inputOptions(['-loop 1', '-framerate 25', '-re']); 
      }

      const mixedStream = new PassThrough();
      activeInputStream = mixedStream;
      let fileIndex = 0;

      const playNextSong = () => {
        if (hasStarted && !activeStreams.has(streamId)) {
            try { mixedStream.end(); } catch(e){}
            return;
        }
        if (fileIndex >= files.length) {
            if (loop) {
                fileIndex = 0;
            } else {
                mixedStream.end(); 
                return;
            }
        }
        const currentFile = files[fileIndex];
        const songStream = fs.createReadStream(currentFile);
        songStream.pipe(mixedStream, { end: false });
        songStream.on('end', () => {
           fileIndex++;
           setTimeout(playNextSong, 10);
        });
        songStream.on('error', (err) => {
           console.error(`Error reading file ${currentFile}:`, err);
           fileIndex++;
           playNextSong();
        });
      };

      playNextSong();

      command.input(mixedStream)
             .inputFormat('mp3')
             .inputOptions(['-re']);

      command.complexFilter([
          { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
          { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
          { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },
          { filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'resampled' },
          { filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' }
      ], ['v_out', 'a_out']);

      command.outputOptions([
        '-c:v libx264', '-preset ultrafast', '-tune zerolatency', 
        '-r 25', '-g 50', '-keyint_min 50', '-sc_threshold 0', 
        '-b:v 3000k', '-minrate 3000k', '-maxrate 3000k', '-bufsize 6000k', '-nal-hrd cbr', 
        '-c:a aac', '-b:a 128k', '-ar 44100',
        '-f flv', '-flvflags no_duration_filesize'
      ]);
    } 
    // =========================================================
    // 2. VIDEO MODE (MP4) - UPDATED FOR SILENT VIDEO SUPPORT
    // =========================================================
    else {
      
      // Deteksi apakah file pertama memiliki audio
      // Jika tidak, kita harus menginject silence
      let hasFileAudio = true;
      try {
          hasFileAudio = await checkFileHasAudio(files[0]);
          console.log(`[Stream ${streamId}] Audio detected: ${hasFileAudio}`);
      } catch(e) { console.error('Audio check failed', e); }

      // -- SKENARIO A: Single File Loop (Movie Filter) --
      if (files.length === 1 && loop) {
          const videoPath = path.resolve(files[0]).replace(/\\/g, '/');
          
          command.input('anullsrc=channel_layout=stereo:sample_rate=44100')
                 .inputFormat('lavfi')
                 .inputOptions(['-re']); 

          // Build filter graph
          const filters = [
              // 1. Video Source
              {
                  filter: 'movie',
                  options: { filename: videoPath, loop: 0 }, 
                  outputs: 'raw_v'
              },
              // 2. Video Processing
              { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: 'raw_v', outputs: 'scaled' },
              { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
              { filter: 'fps', options: 'fps=30', inputs: 'padded', outputs: 'fps_v' },
              { filter: 'setpts', options: 'N/FRAME_RATE/TB', inputs: 'fps_v', outputs: 'v_out' }
          ];

          // 3. Audio Handling
          if (hasFileAudio) {
              // Jika ada audio, gunakan amovie
              filters.push({
                  filter: 'amovie',
                  options: { filename: videoPath, loop: 0 },
                  outputs: 'raw_a'
              });
              filters.push({ filter: 'aresample', options: '44100:async=1', inputs: 'raw_a', outputs: 'resampled' });
              filters.push({ filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' });
          } else {
              // Jika TIDAK ada audio, gunakan input #0 (anullsrc) sebagai audio
              filters.push({ filter: 'aresample', options: '44100', inputs: '0:a', outputs: 'resampled' });
              filters.push({ filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' });
          }

          command.complexFilter(filters, ['v_out', 'a_out']);

      } 
      // -- SKENARIO B: Playlist / Non-Loop --
      else {
          const uniqueId = streamId;
          currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
          
          const safeFiles = files.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`);
          let playlistContent = safeFiles.join('\n');

          if (loop) {
             const oneSet = '\n' + playlistContent;
             for(let i=0; i<100; i++) playlistContent += oneSet;
          }

          fs.writeFileSync(currentPlaylistPath, playlistContent);

          command.input(currentPlaylistPath)
                 .inputOptions(['-f', 'concat', '-safe', '0', '-re']);
                 
          const filters = [
             { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
             { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
             { filter: 'fps', options: 'fps=30', inputs: 'padded', outputs: 'fps_v' },
             { filter: 'setpts', options: 'N/FRAME_RATE/TB', inputs: 'fps_v', outputs: 'v_out' }
          ];

          if (hasFileAudio) {
             // Audio normal dari video
             filters.push({ filter: 'aresample', options: '44100:async=1', inputs: '0:a', outputs: 'resampled' });
             filters.push({ filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' });
          } else {
             // Inject Silence Source as Input #1
             command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputFormat('lavfi');
             // Map input 1:a (silence)
             filters.push({ filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'resampled' });
             filters.push({ filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' });
          }

          command.complexFilter(filters, ['v_out', 'a_out']);
      }

      // -- OUTPUT OPTIONS (Common) --
      command.outputOptions([
        '-map [v_out]', '-map [a_out]',
        '-c:v libx264', '-preset ultrafast', '-tune zerolatency',
        '-r 30', '-g 60', 
        '-pix_fmt yuv420p',
        '-b:v 2500k', '-minrate 2500k', '-maxrate 2500k', '-bufsize 5000k',
        '-nal-hrd cbr',
        '-c:a aac', '-ar 44100', '-b:a 128k', '-ac 2',
        '-f flv', '-flvflags no_duration_filesize'
      ]);
    }

    // --- EVENTS ---
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream ${streamId} started`);
        hasStarted = true;
        activeStreams.set(streamId, { 
            command, 
            userId, 
            playlistPath: currentPlaylistPath,
            activeInputStream, 
            startTime: Date.now(),
            platform: rtmpUrl.includes('youtube') ? 'YouTube' : 'Custom',
            name: title || `Stream ${streamId.substr(0,4)}`
        });
        
        if (global.io) {
            global.io.emit('log', { type: 'start', message: `Stream ${streamId} Started.`, streamId });
            global.io.emit('stream_started', { streamId });
        }
        resolve(streamId);
      })
      .on('progress', (progress) => {
        const currentTimemark = progress.timemark; 
        let totalSeconds = 0;
        if(currentTimemark) {
            const parts = currentTimemark.split(':');
            if(parts.length === 3) {
                 totalSeconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parseFloat(parts[2]));
            }
        }
        
        const diff = Math.floor(totalSeconds - lastProcessedSecond);

        if (diff >= 5) { 
            lastProcessedSecond = totalSeconds;
            db.get(`SELECT u.usage_seconds, p.daily_limit_hours FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = ?`, [userId], (err, row) => {
                if (row) {
                    const newUsage = row.usage_seconds + diff;
                    const limitSeconds = row.daily_limit_hours * 3600;
                    db.run("UPDATE users SET usage_seconds = ? WHERE id = ?", [newUsage, userId]);

                    if (newUsage >= limitSeconds) {
                        if (global.io) global.io.emit('log', { type: 'error', message: 'Quota exceeded for user.', streamId });
                        stopStream(streamId);
                    }

                    if (global.io) {
                        global.io.emit('stats', { 
                            streamId,
                            duration: progress.timemark, 
                            bitrate: progress.currentKbps ? Math.round(progress.currentKbps) + ' kbps' : 'N/A',
                            usage_remaining: Math.max(0, limitSeconds - newUsage)
                        });
                    }
                }
            });
        }
      })
      .on('error', (err, stdout, stderr) => {
        if (!hasStarted) {
            console.error(`[FFmpeg Error Start] ${err.message}`);
            reject(new Error(err.message));
        } else {
            if (!err.message.includes('SIGKILL') && !err.message.includes('write after end')) {
                console.error(`[FFmpeg Error Stream ${streamId}] ${err.message}`);
                if(stderr) console.error(stderr);
            }
        }
        cleanupStream(streamId);
      })
      .on('end', () => {
        console.log(`[FFmpeg] Stream ${streamId} ended cleanly.`);
        if (global.io) global.io.emit('log', { type: 'end', message: `Stream ${streamId} Ended.`, streamId });
        cleanupStream(streamId);
      });

    command.save(rtmpUrl);
  });
};

const cleanupStream = (streamId) => {
  const stream = activeStreams.get(streamId);
  if (!stream) return;

  if (stream.playlistPath && fs.existsSync(stream.playlistPath)) {
    try { fs.unlinkSync(stream.playlistPath); } catch (e) {}
  }
  
  activeStreams.delete(streamId);
  if (global.io) global.io.emit('stream_ended', { streamId });
};

const stopStream = (streamId) => {
  const stream = activeStreams.get(streamId);
  if (stream) {
    console.log(`[Stream] Stopping ${streamId}...`);
    // Force close Node.js stream first
    if (stream.activeInputStream) {
        try { 
            stream.activeInputStream.unpipe();
            stream.activeInputStream.end(); 
            stream.activeInputStream.destroy();
        } catch(e) {}
    }
    // Then kill FFmpeg
    try { stream.command.kill('SIGKILL'); } catch (e) {}
    cleanupStream(streamId);
    return true;
  }
  return false;
};

const getActiveStreams = (userId) => {
    const list = [];
    activeStreams.forEach((v, k) => {
        if (v.userId === userId) {
            list.push({ 
                id: k, 
                platform: v.platform, 
                startTime: v.startTime,
                name: v.name
            });
        }
    });
    return list;
};

const isStreaming = () => activeStreams.size > 0;

module.exports = { startStream, stopStream, isStreaming, getActiveStreams, killZombieProcesses };
