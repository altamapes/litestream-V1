
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

const startStream = (inputPaths, rtmpUrl, options = {}) => {
  const { userId, loop = false, coverImagePath, title, description } = options;
  const files = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  const isAllAudio = files.every(f => f.toLowerCase().endsWith('.mp3'));
  
  // Generate Unique Stream ID
  const streamId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  
  return new Promise((resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;
    let currentPlaylistPath = null;
    let activeInputStream = null;
    let hasStarted = false;

    // --- AUDIO HANDLING ---
    if (isAllAudio) {
      
      // 1. INPUT BACKGROUND IMAGE (Input 0)
      // Gunakan -loop 1 agar gambar tidak pernah habis (infinite video source)
      // Gunakan -re untuk membaca input secara realtime (native speed)
      if (!coverImagePath || !fs.existsSync(coverImagePath)) {
        command.input('color=c=black:s=1280x720:r=25')
               .inputOptions(['-f lavfi', '-re']);
      } else {
        command.input(coverImagePath)
               .inputOptions(['-loop 1', '-framerate 25', '-re']); 
      }

      // 2. INPUT AUDIO (Input 1)
      if (files.length === 1 && loop) {
          // KASUS 1: SINGLE FILE LOOP (Paling sering error di YouTube)
          // Solusi: Gunakan -stream_loop -1 SEBELUM input file (-i)
          // Ini loop native FFmpeg, lebih ringan dari playlist wrapper
          
          command.inputOption('-stream_loop -1'); // Infinite loop audio input
          command.input(files[0]);
          command.inputOptions(['-re']); // Read at native speed

      } else {
          // KASUS 2: MULTIPLE FILES / SINGLE NO-LOOP
          // Menggunakan Node Stream untuk menggabungkan file secara manual
          // FFmpeg melihatnya sebagai 1 stream panjang tanpa putus
          
          const mixedStream = new PassThrough();
          activeInputStream = mixedStream;
          let fileIndex = 0;

          const playNextSong = () => {
            if (!activeStreams.has(streamId) && hasStarted) return; 
            
            if (fileIndex >= files.length) {
                if (loop) { 
                    fileIndex = 0; 
                    console.log(`[Stream ${streamId}] Loop playlist...`);
                } else { 
                    mixedStream.end(); 
                    return; 
                }
            }

            const currentFile = files[fileIndex];
            const songStream = fs.createReadStream(currentFile);
            
            // Pipe tanpa menutup mixedStream saat 1 lagu habis
            songStream.pipe(mixedStream, { end: false });

            songStream.on('end', () => {
               fileIndex++;
               playNextSong(); // Lanjut lagu berikutnya
            });
            
            songStream.on('error', (err) => {
               console.error(`Error reading file ${currentFile}:`, err);
               fileIndex++;
               playNextSong();
            });
          };

          playNextSong();
          command.input(mixedStream).inputFormat('mp3').inputOptions(['-re']);
      }

      // 3. COMPLEX FILTERS (THE MAGIC FIX)
      // Kita harus membuat timestamp BARU (PTS) agar YouTube tidak bingung saat loop reset.
      // [0:v] -> setpts=N/FRAME_RATE/TB (Video waktu terus maju berdasarkan frame count)
      // [1:a] -> asetpts=N/SR/TB (Audio waktu terus maju berdasarkan sample rate)
      
      command.complexFilter([
          // Filter Video: Scale + Pad + SetPTS (Wajib untuk loop)
          {
            filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease',
            inputs: '0:v', outputs: 'scaled'
          },
          {
            filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black',
            inputs: 'scaled', outputs: 'padded'
          },
          {
            filter: 'format', options: 'yuv420p',
            inputs: 'padded', outputs: 'formatted'
          },
          {
            filter: 'setpts', options: 'N/FRAME_RATE/TB', // CRITICAL: RE-GENERATE VIDEO TIMESTAMP
            inputs: 'formatted', outputs: 'v_out'
          },
          
          // Filter Audio: Resample + SetPTS (Wajib untuk loop)
          {
            filter: 'aresample', options: '44100', // Pastikan sample rate standar
            inputs: '1:a', outputs: 'resampled'
          },
          {
            filter: 'asetpts', options: 'N/SR/TB', // CRITICAL: RE-GENERATE AUDIO TIMESTAMP
            inputs: 'resampled', outputs: 'a_out'
          }
      ], ['v_out', 'a_out']); // Map output filter ke encoder

      // 4. OUTPUT OPTIONS
      command.outputOptions([
        '-c:v libx264', '-preset ultrafast', '-tune zerolatency', 
        '-r 25', '-g 50', '-keyint_min 50', '-sc_threshold 0', 
        
        // Bitrate Stability
        '-b:v 3000k', '-minrate 3000k', '-maxrate 3000k', '-bufsize 6000k',   
        '-nal-hrd cbr', 
        
        '-c:a aac', '-b:a 128k', '-ar 44100',
        
        '-f flv', '-flvflags no_duration_filesize'
      ]);

    } 
    // --- VIDEO HANDLING (Existing logic improved) ---
    else {
      
      if (files.length === 1) {
          command.input(files[0]);
          const inputOpts = ['-re']; 
          if (loop) inputOpts.unshift('-stream_loop', '-1'); // Native Loop
          command.inputOptions(inputOpts);
      } else {
          // Video Playlist logic (Concat demuxer is safest for video files)
          const uniqueId = streamId;
          currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
          const playlistContent = files.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n');
          fs.writeFileSync(currentPlaylistPath, playlistContent);

          const videoInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
          if (loop) videoInputOpts.unshift('-stream_loop', '-1');
          command.input(currentPlaylistPath).inputOptions(videoInputOpts);
      }
      
      // Video Filters with Timestamp Fix
      command.complexFilter([
         {
            filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease',
            inputs: '0:v', outputs: 'scaled'
         },
         {
            filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black',
            inputs: 'scaled', outputs: 'padded'
         },
         {
            filter: 'setpts', options: 'N/FRAME_RATE/TB', // Fix video timestamp gap
            inputs: 'padded', outputs: 'v_out'
         },
         {
            filter: 'aresample', options: 'async=1',
            inputs: '0:a', outputs: 'resampled'
         },
         {
            filter: 'asetpts', options: 'N/SR/TB', // Fix audio timestamp gap
            inputs: 'resampled', outputs: 'a_out'
         }
      ], ['v_out', 'a_out']);

      command.outputOptions([
        '-c:v libx264', '-preset ultrafast', '-tune zerolatency',
        '-pix_fmt yuv420p', '-r 30', '-g 60',            
        '-b:v 3000k', '-minrate 3000k', '-maxrate 3000k', '-bufsize 6000k',   
        '-nal-hrd cbr',     
        '-c:a aac', '-ar 44100', '-b:a 128k', '-ac 2',            
        '-f flv', '-flvflags no_duration_filesize'
      ]);
    }

    // --- EVENTS ---
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream ${streamId} started`);
        console.log(`[FFmpeg Cmd] ${commandLine}`); 
        hasStarted = true;
        activeStreams.set(streamId, { 
            command, 
            userId, 
            playlistPath: currentPlaylistPath,
            activeInputStream,
            startTime: Date.now(),
            platform: rtmpUrl.includes('youtube') ? 'YouTube' : (rtmpUrl.includes('facebook') ? 'Facebook' : (rtmpUrl.includes('twitch') ? 'Twitch' : 'Custom')),
            name: title || `Stream ${streamId.substr(0,4)}`,
            description: description || ''
        });
        
        if (global.io) {
            global.io.emit('log', { type: 'start', message: `Stream ${streamId} Started.`, streamId });
            global.io.emit('stream_started', { streamId });
        }
        resolve(streamId);
      })
      .on('progress', (progress) => {
        // ... (Logika kuota user tetap sama)
        const currentTimemark = progress.timemark; 
        const parts = currentTimemark.split(':');
        const totalSeconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parseFloat(parts[2]));
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
            if (stderr) console.error(`[FFmpeg Stderr] ${stderr}`);
            reject(new Error(err.message));
        } else {
            if (!err.message.includes('SIGKILL')) {
                console.error(`[FFmpeg Error Stream ${streamId}] ${err.message}`);
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
    if (stream.activeInputStream) {
        try { stream.activeInputStream.end(); } catch(e) {}
    }
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
