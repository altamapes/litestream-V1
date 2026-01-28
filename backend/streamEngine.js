
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { db } = require('./database');

// MARKER: PASTIKAN INI MUNCUL DI LOG
console.log("\n==================================================");
console.log("!!! LITESTREAM ENGINE V3 (FINAL) LOADED SUCCESS !!!");
console.log("==================================================\n");

// Store active streams
const activeStreams = new Map();

const killZombieProcesses = () => {
    return new Promise((resolve) => {
         console.log('[System] Cleaning up zombie FFmpeg processes...');
         exec('pkill -f ffmpeg', (err, stdout, stderr) => {
             activeStreams.clear();
             console.log('[System] Clean. All streams reset.');
             resolve();
         });
    });
}

// ============================================================================
// GENERATOR PLAYLIST (Loop Logic)
// ============================================================================
const createInfinitePlaylistFile = (files, outputPath, loop) => {
    // Validasi file existence
    const validFiles = files.filter(f => {
        const absPath = path.isAbsolute(f) ? f : path.join(__dirname, 'uploads', path.basename(f));
        return fs.existsSync(absPath);
    });

    if (validFiles.length === 0) return false;

    const safeFiles = validFiles.map(f => {
        const absPath = path.isAbsolute(f) ? f : path.join(__dirname, 'uploads', path.basename(f));
        // Escape single quote untuk FFmpeg concat demuxer
        return `file '${absPath.replace(/'/g, "'\\''")}'`;
    });
    
    let content = [];
    // Jika loop, duplikasi 50x untuk membuat durasi virtual panjang
    const loopCount = loop ? 50 : 1; 
    
    for (let i = 0; i < loopCount; i++) {
        content = content.concat(safeFiles);
    }
    
    fs.writeFileSync(outputPath, content.join('\n'));
    return outputPath;
};

const startStream = (inputPaths, rtmpUrl, options = {}) => {
  const { userId, loop = false, coverImagePath, title } = options;
  const files = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  
  // ==================================================
  // MODE DETECTION LOGIC (V3 - Simplified)
  // ==================================================
  // Cek file pertama. 
  const firstFile = files[0] || '';
  const firstExt = path.extname(firstFile).toLowerCase();
  
  // Tentukan Mode:
  // Video Mode = File berakhiran .mp4, .mkv, .mov, .avi
  // Radio Mode = Sisanya (terutama .mp3) ATAU jika user maksa pakai cover image
  const isVideoFile = ['.mp4', '.mkv', '.mov', '.avi'].includes(firstExt);
  const isRadioMode = !isVideoFile || (coverImagePath && fs.existsSync(coverImagePath));
  
  const streamId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  
  return new Promise(async (resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;
    let playlistPath = null;
    let hasStarted = false;

    console.log(`[Stream ${streamId}] Starting... Mode: ${isRadioMode ? 'RADIO (MP3)' : 'VIDEO (MP4)'}`);

    // Buat Playlist
    playlistPath = path.join(__dirname, 'uploads', `playlist_${streamId}.txt`);
    const playlistCreated = createInfinitePlaylistFile(files, playlistPath, loop);
    
    if (!playlistCreated) {
        return reject(new Error("File media tidak ditemukan di server!"));
    }

    // ==================================================
    // PIPELINE CONFIGURATION
    // ==================================================
    
    if (isRadioMode) {
        // --- MODE RADIO (Visual Statis + Audio Playlist) ---
        
        // INPUT 0: Visual (Cover Image atau Black Screen)
        if (coverImagePath && fs.existsSync(coverImagePath)) {
            if (coverImagePath.endsWith('.mp4')) {
                 command.input(coverImagePath).inputOptions(['-stream_loop', '-1', '-re']);
            } else {
                 command.input(coverImagePath).inputOptions(['-loop', '1', '-re', '-framerate', '25']);
            }
        } else {
            // Fallback Black Screen jika MP3 tidak ada cover
            command.input('color=c=black:s=1280x720:r=25').inputOptions(['-f', 'lavfi', '-re']);
        }

        // INPUT 1: Playlist Audio
        command.input(playlistPath).inputOptions([
            '-f', 'concat',
            '-safe', '0',
            ...(loop ? ['-stream_loop', '-1'] : []) 
        ]);

        // FILTER V3: Strict Mapping
        // Input 0 (Visual) -> v_out
        // Input 1 (Audio)  -> a_out
        command.complexFilter([
            '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[v_out]',
            '[1:a]aresample=44100,aformat=channel_layouts=stereo[a_out]'
        ]);

    } else {
        // --- MODE VIDEO (Video Playlist) ---
        
        // INPUT 0: Playlist Video
        command.input(playlistPath).inputOptions([
            '-f', 'concat',
            '-safe', '0',
            '-re',
            ...(loop ? ['-stream_loop', '-1'] : [])
        ]);

        // FILTER V3: Direct Mapping
        // Input 0 berisi Video DAN Audio.
        // Kita ambil Video -> v_out, Audio -> a_out
        command.complexFilter([
            '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[v_out]',
            '[0:a]aresample=44100,aformat=channel_layouts=stereo[a_out]'
        ]);
    }

    // ==================================================
    // OUTPUT CONFIGURATION
    // ==================================================
    command.outputOptions([
        '-map [v_out]', 
        '-map [a_out]',
        
        // Video Encoding (Superfast untuk VPS)
        '-c:v libx264', 
        '-preset ultrafast', 
        '-tune zerolatency',
        '-g 60',             // Keyframe tiap 2 detik (30fps)
        '-b:v 2500k',        
        '-maxrate 3000k',
        '-bufsize 6000k', 
        '-pix_fmt yuv420p',

        // Audio Encoding
        '-c:a aac', 
        '-b:a 128k', 
        '-ar 44100',
        '-ac 2',

        // RTMP Output
        '-f flv',
        '-flvflags no_duration_filesize'
    ]);

    // ==================================================
    // EVENTS
    // ==================================================
    command
      .on('start', (cmd) => {
        console.log(`[Stream ${streamId}] FFmpeg Spawned.`);
        // console.log("Debug CMD:", cmd); // Uncomment jika perlu debug command lengkap
        hasStarted = true;
        
        activeStreams.set(streamId, { 
            command, 
            userId, 
            playlistPath, 
            startTime: Date.now(), 
            platform: rtmpUrl.includes('youtube') ? 'YouTube' : 'Custom',
            name: title || `Stream ${streamId.substr(0,4)}`
        });

        if (global.io) {
            global.io.emit('stream_started', { streamId });
        }
        resolve(streamId);
      })
      .on('progress', (progress) => {
        // Tracker Durasi
        const currentTimemark = progress.timemark; 
        let totalSeconds = 0;
        if(currentTimemark) {
            const parts = currentTimemark.split(':');
            if(parts.length === 3) totalSeconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parseFloat(parts[2]));
        }
        
        const diff = Math.floor(totalSeconds - lastProcessedSecond);
        if (diff >= 5) { 
            lastProcessedSecond = totalSeconds;
            db.get(`SELECT u.usage_seconds FROM users u WHERE u.id = ?`, [userId], (err, row) => {
                if (row) {
                    const newUsage = row.usage_seconds + diff;
                    db.run("UPDATE users SET usage_seconds = ? WHERE id = ?", [newUsage, userId]);
                    
                    if (global.io) global.io.emit('stats', { 
                        streamId, 
                        duration: progress.timemark, 
                        bitrate: progress.currentKbps ? Math.round(progress.currentKbps) + ' kbps' : 'Stable' 
                    });
                }
            });
        }
      })
      .on('error', (err) => {
        if (!hasStarted) {
            console.error(`[Start Error] ${err.message}`);
            reject(new Error("FFmpeg Gagal Start: " + err.message));
        } else if (!err.message.includes('SIGKILL')) {
            console.error(`[Stream Error] ${err.message}`);
            if (err.message.includes('Output with label')) {
                 console.error(">>> ERROR FILTER GRAPH: Cek input file Anda. Pastikan Video memiliki Audio track.");
            }
        }
        cleanupStream(streamId);
      })
      .on('end', () => {
        console.log(`[Stream ${streamId}] Ended.`);
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
    try { 
        stream.command.kill('SIGKILL'); 
    } catch (e) {}
    cleanupStream(streamId);
    return true;
  }
  return false;
};

const getActiveStreams = (userId) => {
    const list = [];
    activeStreams.forEach((v, k) => { 
        if (v.userId === userId) list.push({ id: k, platform: v.platform, startTime: v.startTime, name: v.name }); 
    });
    return list;
};

module.exports = { startStream, stopStream, getActiveStreams, killZombieProcesses };
