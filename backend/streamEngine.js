
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
// STRATEGI BARU: PSEUDO-INFINITE PLAYLIST
// Alih-alih flag '-stream_loop -1' (yang sering error timestamp),
// Kita tulis ulang daftar file sebanyak 500x di dalam file .txt.
// Bagi FFmpeg, ini adalah satu daftar putar linear yang sangat panjang.
// ============================================================================
const createInfinitePlaylistFile = (files, outputPath, loop) => {
    // Bersihkan path file agar aman
    const safeFiles = files.map(f => `file '${f.replace(/'/g, "'\\''")}'`);
    
    let content = [];
    
    if (loop) {
        // Jika mode LOOP: Ulangi daftar lagu sebanyak 500 kali
        // Jika 1 album (10 lagu @ 3 menit) = 30 menit.
        // 500 kali = 15.000 menit = 250 Jam (10 Hari nonstop).
        // Cukup 'Infinite' untuk praktisnya.
        for (let i = 0; i < 500; i++) {
            content = content.concat(safeFiles);
        }
    } else {
        content = safeFiles;
    }
    
    fs.writeFileSync(outputPath, content.join('\n'));
    return outputPath;
};

const startStream = (inputPaths, rtmpUrl, options = {}) => {
  const { userId, loop = false, coverImagePath, title } = options;
  const files = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  
  // Filter file MP3
  const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));
  
  const streamId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  
  return new Promise(async (resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;
    let playlistPath = null;
    let hasStarted = false;

    console.log(`[Stream ${streamId}] Starting Mode: PSEUDO-INFINITE (Brute Force Loop)`);

    // ---------------------------------------------------------
    // INPUT 0: VISUAL (GAMBAR/VIDEO) - MASTER CLOCK
    // ---------------------------------------------------------
    // Kita gunakan '-re' (Realtime) HANYA pada input visual.
    // Ini menjadi 'jantung' detak waktu stream.
    
    if (coverImagePath && fs.existsSync(coverImagePath)) {
        if (coverImagePath.endsWith('.mp4')) {
             // Jika Video
             command.input(coverImagePath).inputOptions([
                 '-stream_loop', '-1', // Loop video
                 '-re'                 // Realtime limit
             ]);
        } else {
             // Jika Gambar (JPG/PNG)
             command.input(coverImagePath).inputOptions([
                 '-loop', '1',       // Loop gambar selamanya
                 '-re',              // Realtime limit (PENTING)
                 '-framerate', '25'  // FPS Standard YouTube (Jangan terlalu rendah)
             ]);
        }
    } else {
        // Fallback Layar Hitam
        command.input('color=c=black:s=1280x720:r=25').inputFormat('lavfi').inputOptions(['-re']);
    }

    // ---------------------------------------------------------
    // INPUT 1: AUDIO (PSEUDO-INFINITE LIST)
    // ---------------------------------------------------------
    // Kita gunakan concat demuxer biasa, tapi filenya sudah berisi perulangan 500x.
    // JANGAN GUNAKAN '-stream_loop' disini agar timestamp linear & mulus.
    
    if (mp3Files.length > 0) {
        playlistPath = path.join(__dirname, 'uploads', `playlist_${streamId}.txt`);
        createInfinitePlaylistFile(mp3Files, playlistPath, loop);

        command.input(playlistPath).inputOptions([
            '-f', 'concat',      // Protokol Concat
            '-safe', '0'         // Izinkan path absolut
            // HAPUS '-stream_loop -1' (Kita sudah loop manual di text file)
        ]);
    } else {
        command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputFormat('lavfi');
    }

    // ---------------------------------------------------------
    // FILTERS
    // ---------------------------------------------------------
    // Tidak perlu 'asetpts' rumit karena input concat sudah linear.
    // Cukup pastikan format visual dan sample rate audio benar.
    
    const filters = [
        // Visual: Scale 720p, format YUV420P (Wajib YouTube)
        { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
        { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
        { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },

        // Audio: Resample ke 44.1kHz standar
        { filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'a_out' }
    ];

    command.complexFilter(filters);

    // ---------------------------------------------------------
    // OUTPUT OPTIONS
    // ---------------------------------------------------------
    command.outputOptions([
        '-map [v_out]', '-map [a_out]',
        
        // Video Codec (H.264)
        '-c:v libx264', 
        '-preset ultrafast', // Hemat CPU VPS
        '-tune zerolatency', // Streaming Mode
        '-g 50',             // Keyframe tiap 2 detik (25fps * 2) - YouTube Suka ini
        '-b:v 2000k',        // Bitrate Video (Cukup tajam, tidak terlalu berat)
        '-maxrate 2500k',
        '-bufsize 5000k',    // Buffer cukup besar untuk menahan fluktuasi

        // Audio Codec (AAC)
        '-c:a aac', 
        '-b:a 128k', 
        '-ar 44100',
        '-ac 2',

        // System Tuning
        '-max_muxing_queue_size 9999', // Mencegah error 'Too many packets' saat loading playlist
        '-f flv',
        '-flvflags no_duration_filesize'
    ]);

    // ---------------------------------------------------------
    // EVENTS
    // ---------------------------------------------------------
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream Started: ${streamId}`);
        hasStarted = true;
        
        activeStreams.set(streamId, { 
            command, 
            userId, 
            playlistPath, 
            startTime: Date.now(), 
            platform: rtmpUrl.includes('youtube') ? 'YouTube' : 'Custom',
            name: title || `Radio ${streamId.substr(0,4)}`
        });

        if (global.io) {
            global.io.emit('log', { type: 'start', message: `Radio Started.`, streamId });
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

    // Start Streaming
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
