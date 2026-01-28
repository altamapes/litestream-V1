
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
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

// ============================================================================
// GENERATOR PLAYLIST ANTI-PUTUS (Brute Force Loop)
// ============================================================================
const createInfinitePlaylistFile = (files, outputPath, loop) => {
    // 1. Pastikan path absolut dan escape karakter aneh untuk FFmpeg concat demuxer
    const safeFiles = files.map(f => {
        // Jika path belum absolut, gabungkan dengan folder uploads
        const absPath = path.isAbsolute(f) ? f : path.join(__dirname, 'uploads', path.basename(f));
        // Escape single quote (') menjadi ('\'') agar FFmpeg tidak error membaca nama file
        return `file '${absPath.replace(/'/g, "'\\''")}'`;
    });
    
    let content = [];
    
    // 2. Logika Loop:
    // Jika Loop aktif, kita duplikasi daftar lagu/video sebanyak 100 kali.
    // Ini menciptakan "Virtual Timeline" yang sangat panjang (ratusan jam).
    // FFmpeg melihatnya sebagai satu file panjang, sehingga timestamp tidak pernah reset.
    const loopCount = loop ? 100 : 1; 
    
    for (let i = 0; i < loopCount; i++) {
        content = content.concat(safeFiles);
    }
    
    fs.writeFileSync(outputPath, content.join('\n'));
    return outputPath;
};

const startStream = (inputPaths, rtmpUrl, options = {}) => {
  const { userId, loop = false, coverImagePath, title } = options;
  const files = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  
  // DETEKSI MODE:
  // Jika ada coverImagePath, berarti ini RADIO MODE (Mp3 + Gambar).
  // Jika tidak ada cover, berarti ini VIDEO MODE (MP4).
  const isRadioMode = !!(coverImagePath && fs.existsSync(coverImagePath));
  
  const streamId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  
  return new Promise(async (resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;
    let playlistPath = null;
    let hasStarted = false;

    console.log(`[Stream ${streamId}] Mode: ${isRadioMode ? 'RADIO (Image+Audio)' : 'VIDEO (Movie)'} | Loop: ${loop}`);

    // Persiapkan Playlist File (Untuk Audio maupun Video)
    playlistPath = path.join(__dirname, 'uploads', `playlist_${streamId}.txt`);
    createInfinitePlaylistFile(files, playlistPath, loop);

    // ==================================================
    // KONFIGURASI INPUT
    // ==================================================
    
    if (isRadioMode) {
        // --- MODE 1: RADIO (Gambar + Audio) ---
        
        // INPUT 0: Visual (Gambar/Video Loop)
        if (coverImagePath.endsWith('.mp4')) {
             command.input(coverImagePath).inputOptions(['-stream_loop', '-1', '-re']);
        } else {
             // Gambar statis diloop
             command.input(coverImagePath).inputOptions(['-loop', '1', '-re', '-framerate', '25']);
        }

        // INPUT 1: Playlist Audio (MP3s)
        command.input(playlistPath).inputOptions([
            '-f', 'concat',
            '-safe', '0',
            // Jika user minta loop, kita juga pasang flag stream_loop sebagai backup layer kedua
            ...(loop ? ['-stream_loop', '-1'] : []) 
        ]);

        // FILTER: Ambil Video dari Input 0, Audio dari Input 1
        const filters = [
            { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
            { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
            { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },
            { filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'a_out' }
        ];
        command.complexFilter(filters);

    } else {
        // --- MODE 2: VIDEO (Film/Clip) ---
        
        // INPUT 0: Playlist Video (MP4s)
        // Kita gunakan -re (realtime) di sini karena videonya sendiri yang menentukan durasi
        command.input(playlistPath).inputOptions([
            '-f', 'concat',
            '-safe', '0',
            '-re',
            ...(loop ? ['-stream_loop', '-1'] : [])
        ]);

        // FILTER: Ambil Video & Audio dari Input 0 (Satu sumber)
        const filters = [
            { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
            { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
            { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },
            { filter: 'aresample', options: '44100', inputs: '0:a', outputs: 'a_out' }
        ];
        command.complexFilter(filters);
    }

    // ==================================================
    // OUTPUT OPTIONS (Standard YouTube/FB/Twitch)
    // ==================================================
    command.outputOptions([
        '-map [v_out]', '-map [a_out]',
        
        // Video Codec
        '-c:v libx264', 
        '-preset ultrafast', // Paling ringan untuk VPS
        '-tune zerolatency',
        '-g 50',             // Keyframe wajib tiap 2 detik
        '-b:v 2000k',        // Bitrate dinaikkan sedikit agar gambar tajam
        '-maxrate 2500k',
        '-bufsize 5000k', 

        // Audio Codec
        '-c:a aac', 
        '-b:a 128k', 
        '-ar 44100',
        '-ac 2',

        // Format FLV untuk RTMP
        '-f flv',
        '-flvflags no_duration_filesize'
    ]);

    // ==================================================
    // EVENT HANDLERS
    // ==================================================
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream Started: ${streamId}`);
        // console.log("CMD:", commandLine);
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
            global.io.emit('log', { type: 'start', message: `Stream Started.`, streamId });
            global.io.emit('stream_started', { streamId });
        }
        resolve(streamId);
      })
      .on('progress', (progress) => {
        // Hitung penggunaan durasi user
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
            reject(new Error(err.message));
        } else if (!err.message.includes('SIGKILL')) {
            console.error(`[Stream Error] ${err.message}`);
        }
        cleanupStream(streamId);
      })
      .on('end', () => {
        console.log(`[FFmpeg] Stream Ended Cleanly: ${streamId}`);
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
    } catch (e) {
        console.log("Error killing FFmpeg:", e.message);
    }
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

const isStreaming = () => activeStreams.size > 0;

module.exports = { startStream, stopStream, isStreaming, getActiveStreams, killZombieProcesses };
