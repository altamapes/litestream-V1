
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const { db } = require('./database');

let currentCommand = null;
let activeInputStream = null; 
let currentStreamLoopActive = false; 
let currentStreamUserId = null;
let currentPlaylistPath = null;

const startStream = (inputPaths, rtmpUrl, options = {}) => {
  if (currentCommand) {
    stopStream();
  }

  const files = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  const isAllAudio = files.every(f => f.toLowerCase().endsWith('.mp3'));
  const shouldLoop = !!options.loop;
  currentStreamUserId = options.userId;
  
  currentStreamLoopActive = true;

  return new Promise((resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;

    if (isAllAudio) {
      const mixedStream = new PassThrough();
      activeInputStream = mixedStream;
      let fileIndex = 0;

      const playNextSong = () => {
        if (!currentStreamLoopActive) return;
        const currentFile = files[fileIndex];
        const songStream = fs.createReadStream(currentFile);
        songStream.pipe(mixedStream, { end: false });

        songStream.on('end', () => {
           fileIndex++;
           if (fileIndex >= files.length) {
             if (shouldLoop) {
               fileIndex = 0; 
               playNextSong(); 
             } else {
               mixedStream.end();
             }
           } else {
             playNextSong();
           }
        });
        songStream.on('error', (err) => {
           fileIndex++;
           playNextSong();
        });
      };

      playNextSong();

      const videoFilter = [
        'scale=1280:720:force_original_aspect_ratio=decrease',
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black',
        'format=yuv420p'
      ].join(',');

      let imageInput = options.coverImagePath;
      if (!imageInput || !fs.existsSync(imageInput)) {
        command.input('color=c=black:s=1280x720:r=24').inputOptions(['-f lavfi', '-re']);
      } else {
        command.input(imageInput).inputOptions(['-loop 1', '-framerate 2', '-re']); 
      }

      command.input(mixedStream).inputFormat('mp3').inputOptions(['-re']); 

      command.outputOptions([
        '-map 0:v', '-map 1:a', `-vf ${videoFilter}`,
        '-c:v libx264', '-preset ultrafast', '-r 24', '-g 48', '-keyint_min 48', '-sc_threshold 0',
        '-b:v 3000k', '-minrate 3000k', '-maxrate 3000k', '-bufsize 6000k', '-nal-hrd cbr',
        '-c:a aac', '-b:a 128k', '-ar 44100', '-af aresample=async=1',
        '-f flv', '-flvflags no_duration_filesize'
      ]);

    } else {
      // Use unique playlist name to prevent collisions
      const uniqueId = Date.now() + '_' + Math.random().toString(36).substring(7);
      currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
      
      const playlistContent = files.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(currentPlaylistPath, playlistContent);

      const videoInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
      if (shouldLoop) videoInputOpts.unshift('-stream_loop', '-1');

      command.input(currentPlaylistPath).inputOptions(videoInputOpts);
      command.outputOptions(['-c copy', '-f flv', '-flvflags no_duration_filesize']);
    }

    currentCommand = command
      .on('start', (commandLine) => {
        if (global.io) global.io.emit('log', { type: 'start', message: `Stream Started.` });
      })
      .on('progress', (progress) => {
        if (!currentStreamUserId) return;

        // Hitung selisih detik sejak progress terakhir
        const currentTimemark = progress.timemark; 
        const parts = currentTimemark.split(':');
        const totalSeconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parseFloat(parts[2]));
        const diff = Math.floor(totalSeconds - lastProcessedSecond);

        if (diff >= 5) { // Update DB setiap 5 detik penggunaan
            lastProcessedSecond = totalSeconds;
            
            db.get(`
                SELECT u.usage_seconds, p.daily_limit_hours 
                FROM users u JOIN plans p ON u.plan_id = p.id 
                WHERE u.id = ?`, [currentStreamUserId], (err, row) => {
                if (row) {
                    const newUsage = row.usage_seconds + diff;
                    const limitSeconds = row.daily_limit_hours * 3600;

                    db.run("UPDATE users SET usage_seconds = ? WHERE id = ?", [newUsage, currentStreamUserId]);

                    if (newUsage >= limitSeconds) {
                        if (global.io) global.io.emit('log', { type: 'error', message: 'Batas penggunaan harian tercapai! Stream dimatikan otomatis.' });
                        stopStream();
                    }

                    if (global.io) {
                        global.io.emit('stats', { 
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
        if (err.message.includes('SIGKILL')) return;
        currentCommand = null;
        cleanupPlaylist();
        reject(err);
      })
      .on('end', () => {
        currentCommand = null;
        cleanupPlaylist();
        resolve();
      });

    currentCommand.save(rtmpUrl);
  });
};

const cleanupPlaylist = () => {
  if (currentPlaylistPath && fs.existsSync(currentPlaylistPath)) {
    try {
      fs.unlinkSync(currentPlaylistPath);
      currentPlaylistPath = null;
    } catch (e) {
      console.error("Failed to delete playlist file:", e);
    }
  }
};

const stopStream = () => {
  currentStreamLoopActive = false;
  currentStreamUserId = null;
  if (activeInputStream) {
      try { activeInputStream.end(); } catch(e) {}
      activeInputStream = null;
  }
  if (currentCommand) {
    try { currentCommand.kill('SIGKILL'); } catch (e) {}
    currentCommand = null;
    cleanupPlaylist();
    return true;
  }
  return false;
};

const isStreaming = () => !!currentCommand;

module.exports = { startStream, stopStream, isStreaming };
