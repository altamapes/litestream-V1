
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
      
      // Video Filter: Scale, Pad, and Noise (to keep bitrate active)
      const videoFilter = [
        'scale=1280:720:force_original_aspect_ratio=decrease',
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black',
        'noise=alls=1:allf=t+u', 
        'format=yuv420p'
      ].join(',');

      // Input 0: Image/Color (Background)
      if (!coverImagePath || !fs.existsSync(coverImagePath)) {
        command.input('color=c=black:s=1280x720:r=25').inputOptions(['-f lavfi', '-re']);
      } else {
        command.input(coverImagePath).inputOptions(['-loop 1', '-framerate 25', '-re']); 
      }

      // Input 1: Audio Stream
      // FIX LOOP STOPPING: Use CONCAT method even for single file if LOOP is ON
      if (files.length === 1 && loop) {
          const uniqueId = streamId;
          currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_audio_${uniqueId}.txt`);
          
          // Create a wrapper playlist for the single file
          // "stream_loop" works perfectly on concat inputs, but sometimes fails on raw mp3 inputs
          const playlistContent = `file '${path.resolve(files[0]).replace(/'/g, "'\\''")}'`;
          fs.writeFileSync(currentPlaylistPath, playlistContent);

          command.input(currentPlaylistPath)
                 .inputOptions([
                     '-f concat', 
                     '-safe 0', 
                     '-stream_loop -1', // Loop the playlist infinitely
                     '-re'              // Read at native speed
                 ]);
      } 
      // Multi-file playlist logic (Manual Piping via Node Stream)
      else {
          const mixedStream = new PassThrough();
          activeInputStream = mixedStream;
          let fileIndex = 0;

          const playNextSong = () => {
            if (!activeStreams.has(streamId) && hasStarted) return; 
            
            if (fileIndex >= files.length) {
                if (loop) { fileIndex = 0; } 
                else { mixedStream.end(); return; }
            }

            const currentFile = files[fileIndex];
            const songStream = fs.createReadStream(currentFile);
            
            songStream.pipe(mixedStream, { end: false });

            songStream.on('end', () => {
               fileIndex++;
               playNextSong();
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

      // OUTPUT OPTIONS (Force High Bitrate CBR for YouTube)
      command.outputOptions([
        '-map 0:v', '-map 1:a', `-vf ${videoFilter}`,
        '-c:v libx264', '-preset ultrafast', '-tune zerolatency', 
        '-r 25', '-g 50', '-keyint_min 50', '-sc_threshold 0', 
        
        // FORCE 3000kbps Constant Bitrate
        '-b:v 3000k',       
        '-minrate 3000k',   
        '-maxrate 3000k',   
        '-bufsize 6000k',   
        '-nal-hrd cbr',     
        '-x264-params nal-hrd=cbr', 
        
        '-c:a aac', '-b:a 128k', '-ar 44100', '-af aresample=async=1',
        '-f flv', '-flvflags no_duration_filesize'
      ]);

    } 
    // --- VIDEO HANDLING ---
    else {
      const videoFilter = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black';
      
      if (files.length === 1) {
          // Single Video File
          const singleFile = files[0];
          command.input(singleFile);
          
          const inputOpts = ['-re']; 
          if (loop) inputOpts.unshift('-stream_loop', '-1');
          command.inputOptions(inputOpts);

      } else {
          // Playlist Video
          const uniqueId = streamId;
          currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
          
          const playlistContent = files.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n');
          fs.writeFileSync(currentPlaylistPath, playlistContent);

          const videoInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
          if (loop) videoInputOpts.unshift('-stream_loop', '-1');

          command.input(currentPlaylistPath).inputOptions(videoInputOpts);
      }
      
      // Video Output Options
      command.outputOptions([
        '-c:v libx264',
        '-preset ultrafast', 
        '-tune zerolatency',
        `-vf ${videoFilter}`,
        '-pix_fmt yuv420p',
        '-r 30', '-g 60',            
        '-b:v 3000k',       
        '-minrate 3000k',   
        '-maxrate 3000k',   
        '-bufsize 6000k',   
        '-nal-hrd cbr',     
        '-max_muxing_queue_size 9999', 
        '-c:a aac', '-ar 44100', '-b:a 128k', '-ac 2',            
        '-af aresample=async=1', 
        '-bsf:a aac_adtstoasc',
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
            platform: rtmpUrl.includes('youtube') ? 'YouTube' : (rtmpUrl.includes('facebook') ? 'Facebook' : (rtmpUrl.includes('twitch') ? 'Twitch' : 'Custom')),
            name: title || `Stream ${streamId.substr(0,4)}`,
            description: description || ''
        });
        
        if (global.io) global.io.emit('log', { type: 'start', message: `Stream ${streamId} Started.`, streamId });
        resolve(streamId);
      })
      .on('progress', (progress) => {
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
