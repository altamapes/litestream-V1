
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

// Helper: Create Playlist File for Concat Demuxer
const createPlaylistFile = (files, outputPath) => {
    // Format Concat: file '/path/to/file.mp3'
    const content = files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(outputPath, content);
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

    console.log(`[Stream ${streamId}] Starting Mode: STABLE RADIO (Native Loop + Timestamp Fix)`);

    // ---------------------------------------------------------
    // INPUT 0: VISUAL (GAMBAR) - MASTER CLOCK
    // ---------------------------------------------------------
    // Kita gunakan gambar sebagai penentu kecepatan stream (-re).
    // Framerate 15fps cukup untuk gambar diam (sangat ringan).
    
    if (coverImagePath && fs.existsSync(coverImagePath)) {
        if (coverImagePath.endsWith('.mp4')) {
             // Jika Video
             command.input(coverImagePath).inputOptions(['-stream_loop', '-1', '-re']);
        } else {
             // Jika Gambar (JPG/PNG)
             command.input(coverImagePath).inputOptions([
                 '-loop', '1',       // Loop gambar
                 '-re',              // Realtime Reading (PENTING AGAR TIDAK BUFFERING)
                 '-framerate', '15'  // 15 FPS cukup untuk radio, hemat bandwidth & CPU
             ]);
        }
    } else {
        // Fallback Layar Hitam
        command.input('color=c=black:s=1280x720:r=15').inputFormat('lavfi').inputOptions(['-re']);
    }

    // ---------------------------------------------------------
    // INPUT 1: AUDIO (PLAYLIST)
    // ---------------------------------------------------------
    
    if (mp3Files.length > 0) {
        // Buat file playlist.txt sementara
        playlistPath = path.join(__dirname, 'uploads', `playlist_${streamId}.txt`);
        createPlaylistFile(mp3Files, playlistPath);

        command.input(playlistPath).inputOptions([
            '-f', 'concat',      // Gunakan fitur concat demuxer
            '-safe', '0',        // Izinkan path file bebas
            ...(loop ? ['-stream_loop', '-1'] : []) // Loop di level input (sebelum dibaca)
        ]);
    } else {
        command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputFormat('lavfi');
    }

    // ---------------------------------------------------------
    // COMPLEX FILTER (THE FIX)
    // ---------------------------------------------------------
    // 1. [0:v] Video di-scale dan setpts dibuat realtime.
    // 2. [1:a] Audio di-resample DAN timestamp dibuat ulang (asetpts).
    //    'asetpts=N/SR/TB' membuat timestamp monoton naik terus menerus 
    //    berdasarkan jumlah sample, mengabaikan reset timestamp saat loop terjadi.
    
    const filters = [
        // Video Logic
        { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
        { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
        { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },

        // Audio Logic (THE SECRET SAUCE)
        // aresample=async=1: Sinkronisasi drift waktu
        // asetpts=N/SR/TB: Generate timestamp baru yang linear (Anti-Putus)
        { filter: 'aresample', options: '44100:async=1', inputs: '1:a', outputs: 'resampled' },
        { filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' }
    ];

    command.complexFilter(filters);

    // ---------------------------------------------------------
    // OUTPUT OPTIONS
    // ---------------------------------------------------------
    command.outputOptions([
        '-map [v_out]', '-map [a_out]',
        
        // Video Encoding (Sangat Ringan)
        '-c:v libx264', 
        '-preset ultrafast', // Prioritas kecepatan CPU
        '-tune zerolatency', // Mengurangi latency
        '-r 15',             // Output 15 FPS (Sesuai input)
        '-g 30',             // Keyframe tiap 2 detik (15*2) - Wajib untuk YouTube
        '-b:v 1000k',        // Bitrate visual rendah (cukup untuk static image)
        '-maxrate 1500k',
        '-bufsize 3000k',

        // Audio Encoding
        '-c:a aac', 
        '-b:a 128k', 
        '-ar 44100',
        '-ac 2',

        // Protocol RTMP/FLV
        '-f flv',
        '-flvflags no_duration_filesize'
    ]);

    // ---------------------------------------------------------
    // EVENTS
    // ---------------------------------------------------------
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream Started: ${streamId}`);
        // console.log(commandLine); // Debug command
        hasStarted = true;
        
        activeStreams.set(streamId, { 
            command, 
            userId, 
            playlistPath, // Simpan path untuk dihapus nanti
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
        // Logic Usage Database
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
  
  // Hapus file playlist temp
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
