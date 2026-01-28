
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const { exec } = require('child_process');
const { db } = require('./database');

// Store active streams
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

// Robust Audio Checker
const checkFileHasAudio = (filePath) => {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error(`[FFprobe Error] ${filePath}:`, err);
                resolve(false); 
            } else {
                const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
                resolve(!!audioStream);
            }
        });
    });
};

// Helper: Generate Playlist Content
const createPlaylistFile = (files, outputPath) => {
    // Generate file list for ffmpeg concat demuxer
    const safeFiles = files.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`);
    const content = safeFiles.join('\n');
    fs.writeFileSync(outputPath, content);
    return outputPath;
};

const startStream = (inputPaths, rtmpUrl, options = {}) => {
  const { userId, loop = false, coverImagePath, title, description } = options;
  const files = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  
  // CLASSIFY FILES
  const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));
  const videoFiles = files.filter(f => !f.toLowerCase().endsWith('.mp3')); 

  const streamId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  
  return new Promise(async (resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;
    let currentPlaylistPath = null;
    let hasStarted = false;

    // =========================================================
    // MODE 3: HYBRID (VIDEO CLIP + MP3 AUDIO)
    // "Mp4 sebagai visual, MP3 sebagai suara"
    // =========================================================
    if (videoFiles.length > 0 && mp3Files.length > 0) {
        console.log(`[Stream ${streamId}] Mode: HYBRID (Visual: MP4, Audio: Playlist Concat)`);
        
        // --- INPUT 0: VISUAL (VIDEO) ---
        // Video selalu di-loop visualnya
        command.input(videoFiles[0]).inputOptions([
            '-stream_loop', '-1', 
            '-re'
        ]);

        // --- INPUT 1: AUDIO (MP3) ---
        // FORCE PLAYLIST STRATEGY (Paling Stabil untuk Loop)
        const uniqueId = streamId;
        currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_audio_${uniqueId}.txt`);
        createPlaylistFile(mp3Files, currentPlaylistPath);
        
        // Urutan opsi sangat krusial: -stream_loop HARUS sebelum -i (input)
        const audioInputOptions = ['-f', 'concat', '-safe', '0', '-re'];
        
        // Jika loop aktif, tambahkan opsi loop ke demuxer concat
        if (loop) {
            // Unshift agar berada di paling depan: -stream_loop -1 -f concat ...
            audioInputOptions.unshift('-stream_loop', '-1'); 
        }

        command.input(currentPlaylistPath).inputOptions(audioInputOptions);

        // COMPLEX FILTER
        command.complexFilter([
            // Video Processing (Input 0) - Ambil Video Saja
            { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
            { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
            { filter: 'fps', options: 'fps=30', inputs: 'padded', outputs: 'fps_v' },
            { filter: 'setpts', options: 'N/FRAME_RATE/TB', inputs: 'fps_v', outputs: 'v_out' },
            
            // Audio Processing (Input 1) - Ambil Audio Saja
            { filter: 'aresample', options: '44100:async=1', inputs: '1:a', outputs: 'resampled' },
            { filter: 'aformat', options: 'sample_fmts=fltp:channel_layouts=stereo', inputs: 'resampled', outputs: 'a_out' }
        ]);
        
        command.addOption('-max_muxing_queue_size', '4096');
    }

    // =========================================================
    // MODE 1: AUDIO ONLY (IMAGE + MP3)
    // =========================================================
    else if (videoFiles.length === 0 && mp3Files.length > 0) {
        console.log(`[Stream ${streamId}] Mode: AUDIO ONLY (Image + Playlist Concat)`);

        // --- INPUT 0: COVER IMAGE ---
        if (!coverImagePath || !fs.existsSync(coverImagePath)) {
            command.input('color=c=black:s=1280x720:r=25').inputOptions(['-f', 'lavfi', '-re']);
        } else {
            // Loop image infinite
            command.input(coverImagePath).inputOptions(['-loop', '1', '-framerate', '25', '-re']); 
        }

        // --- INPUT 1: AUDIO ---
        // FORCE PLAYLIST STRATEGY
        const uniqueId = streamId;
        currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_music_${uniqueId}.txt`);
        createPlaylistFile(mp3Files, currentPlaylistPath);

        const musicInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
        if (loop) {
            // Force infinite loop pada level concat demuxer
            musicInputOpts.unshift('-stream_loop', '-1');
        }

        command.input(currentPlaylistPath).inputOptions(musicInputOpts);
      
        command.complexFilter([
            // Video (Image) Processing
            { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
            { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
            { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },
            
            // Audio Processing
            { filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'resampled' },
            { filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' }
        ]);
    } 

    // =========================================================
    // MODE 2: VIDEO ONLY (MP4 Original)
    // =========================================================
    else {
      let hasFileAudio = false;
      try {
          hasFileAudio = await checkFileHasAudio(files[0]);
          console.log(`[Stream ${streamId}] Audio Detected: ${hasFileAudio}`);
      } catch(e) {}

      // Untuk Video juga kita standarisasi menggunakan Playlist agar konsisten
      // Kecuali user benar-benar hanya 1 file video (simple loop)
      if (files.length === 1 && loop) {
          command.input(files[0]).inputOptions([
              '-re', 
              '-stream_loop', '-1', // Loop input video standard
              '-fflags', '+genpts',
              '-map_metadata', '-1' 
          ]);
      } else {
          // Playlist Logic
          const uniqueId = streamId;
          currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
          createPlaylistFile(files, currentPlaylistPath);
          
          const vidInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
          if (loop) vidInputOpts.unshift('-stream_loop', '-1');
          
          command.input(currentPlaylistPath).inputOptions(vidInputOpts);
      }

      // Input #1: Silence (Cadangan jika video bisu)
      command.input('anullsrc=channel_layout=stereo:sample_rate=44100')
             .inputFormat('lavfi');

      const filters = [
          // Video: Scale & Pad
          { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
          { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
          { filter: 'fps', options: 'fps=30', inputs: 'padded', outputs: 'fps_v' },
          { filter: 'setpts', options: 'N/FRAME_RATE/TB', inputs: 'fps_v', outputs: 'v_out' }
      ];

      if (hasFileAudio) {
          // Gunakan audio dari Video (Input 0)
          filters.push({ filter: 'aresample', options: '44100:async=1', inputs: '0:a', outputs: 'resampled' });
          filters.push({ filter: 'aformat', options: 'sample_fmts=fltp:channel_layouts=stereo', inputs: 'resampled', outputs: 'formatted' });
          filters.push({ filter: 'asetpts', options: 'N/SR/TB', inputs: 'formatted', outputs: 'a_out' });
      } else {
          // Gunakan silence (Input 1)
          filters.push({ filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'resampled' });
          filters.push({ filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' });
      }

      command.complexFilter(filters);
      command.addOption('-max_muxing_queue_size', '4096');
    }

    // --- Output Options (Common) ---
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

    // --- Event Handling ---
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream ${streamId} started.`);
        console.log(`[FFmpeg] Command: ${commandLine}`);
        hasStarted = true;
        activeStreams.set(streamId, { 
            command, userId, playlistPath: currentPlaylistPath, 
            startTime: Date.now(), platform: rtmpUrl.includes('youtube') ? 'YouTube' : 'Custom',
            name: title || `Stream ${streamId.substr(0,4)}`
        });
        if (global.io) {
            global.io.emit('log', { type: 'start', message: `Stream Started.`, streamId });
            global.io.emit('stream_started', { streamId });
        }
        resolve(streamId);
      })
      .on('progress', (progress) => {
        const currentTimemark = progress.timemark; 
        let totalSeconds = 0;
        if(currentTimemark) {
            const parts = currentTimemark.split(':');
            if(parts.length === 3) totalSeconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parseFloat(parts[2]));
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
                        if (global.io) global.io.emit('log', { type: 'error', message: 'Quota exceeded.', streamId });
                        stopStream(streamId);
                    }
                    if (global.io) global.io.emit('stats', { streamId, duration: progress.timemark, bitrate: progress.currentKbps ? Math.round(progress.currentKbps) + ' kbps' : 'N/A' });
                }
            });
        }
      })
      .on('error', (err) => {
        if (!hasStarted) {
            console.error(`[Start Error] ${err.message}`);
            reject(new Error(err.message));
        } else if (!err.message.includes('SIGKILL')) {
            console.error(`[Stream Error] ${err.message}`);
        }
        cleanupStream(streamId);
      })
      .on('end', () => {
        console.log(`[FFmpeg] Stream ${streamId} ended.`);
        cleanupStream(streamId);
      });

    command.save(rtmpUrl);
  });
};

const cleanupStream = (streamId) => {
  const stream = activeStreams.get(streamId);
  if (!stream) return;
  if (stream.playlistPath && fs.existsSync(stream.playlistPath)) try { fs.unlinkSync(stream.playlistPath); } catch (e) {}
  activeStreams.delete(streamId);
  if (global.io) global.io.emit('stream_ended', { streamId });
};

const stopStream = (streamId) => {
  const stream = activeStreams.get(streamId);
  if (stream) {
    try { stream.command.kill('SIGKILL'); } catch (e) {}
    cleanupStream(streamId);
    return true;
  }
  return false;
};

const getActiveStreams = (userId) => {
    const list = [];
    activeStreams.forEach((v, k) => { if (v.userId === userId) list.push({ id: k, platform: v.platform, startTime: v.startTime, name: v.name }); });
    return list;
};

const isStreaming = () => activeStreams.size > 0;

module.exports = { startStream, stopStream, isStreaming, getActiveStreams, killZombieProcesses };
