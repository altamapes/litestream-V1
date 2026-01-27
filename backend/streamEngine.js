
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const { db } = require('./database');

// Store active streams: key = streamId, value = { command, userId, playlistPath, activeInputStream, loop: boolean }
const activeStreams = new Map();

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
      const mixedStream = new PassThrough();
      activeInputStream = mixedStream;
      let fileIndex = 0;

      const playNextSong = () => {
        if (!activeStreams.has(streamId) && hasStarted) return; // Stop if stream removed
        
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

      // OPTIMIZED FOR LOW END VPS (1 Core, 1GB RAM)
      // Reduced resolution to 720p, bitrate to 2000k, fps to 20
      const videoFilter = [
        'scale=1280:720:force_original_aspect_ratio=decrease',
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black',
        'format=yuv420p'
      ].join(',');

      // Input 1: Image/Color
      if (!coverImagePath || !fs.existsSync(coverImagePath)) {
        command.input('color=c=black:s=1280x720:r=20').inputOptions(['-f lavfi', '-re']);
      } else {
        command.input(coverImagePath).inputOptions(['-loop 1', '-framerate 1', '-re']); 
      }

      // Input 2: Audio Stream
      command.input(mixedStream).inputFormat('mp3').inputOptions(['-re']); 

      command.outputOptions([
        '-map 0:v', '-map 1:a', `-vf ${videoFilter}`,
        '-c:v libx264', '-preset ultrafast', '-tune zerolatency', '-r 20', '-g 40', '-keyint_min 40', '-sc_threshold 0',
        '-b:v 2000k', '-minrate 2000k', '-maxrate 2000k', '-bufsize 4000k', '-nal-hrd cbr',
        '-c:a aac', '-b:a 96k', '-ar 44100', '-af aresample=async=1',
        '-f flv', '-flvflags no_duration_filesize'
      ]);

    } 
    // --- VIDEO HANDLING (UPDATED) ---
    else {
      const uniqueId = streamId;
      currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
      
      const playlistContent = files.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(currentPlaylistPath, playlistContent);

      const videoInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
      if (loop) videoInputOpts.unshift('-stream_loop', '-1');

      command.input(currentPlaylistPath).inputOptions(videoInputOpts);
      
      // PERBAIKAN: Menggunakan transcoding (libx264 + aac) alih-alih copy
      // Ini memastikan kompatibilitas RTMP meski input MP4 berbeda-beda codec.
      // Setting disesuaikan untuk VPS Low-End (720p, Ultrafast preset).
      command.outputOptions([
        '-c:v libx264',
        '-preset ultrafast', 
        '-tune zerolatency',
        '-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black',
        '-r 30',              // Stabil di 30 FPS
        '-g 60',              // Keyframe interval 2 detik (Wajib untuk YouTube/FB)
        '-b:v 2500k',         // Bitrate Video
        '-maxrate 2500k',
        '-bufsize 5000k',
        '-c:a aac',           // Encode audio ke AAC (Standar RTMP)
        '-ar 44100',
        '-b:a 128k',
        '-f flv',
        '-flvflags no_duration_filesize'
      ]);
    }

    // --- EVENTS ---
    command
      .on('start', (commandLine) => {
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
      .on('error', (err) => {
        if (!hasStarted) {
            // Reject promise if startup fails
            reject(new Error(err.message));
        }
        
        if (!err.message.includes('SIGKILL') && hasStarted) {
            console.error(`Stream ${streamId} Error:`, err.message);
        }
        cleanupStream(streamId);
      })
      .on('end', () => {
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

module.exports = { startStream, stopStream, isStreaming, getActiveStreams };
