
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

// Helper: Generate Playlist Content (Used for Both Video and Audio now)
const createPlaylistFile = (files, outputPath) => {
    // Format Concat Demuxer: file '/path/to/file'
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
    let createdFiles = []; // Track temp files to delete later
    let hasStarted = false;

    console.log(`[Stream ${streamId}] Preparing... Video: ${videoFiles.length}, Audio: ${mp3Files.length}`);

    // =========================================================
    // STRATEGY: CONCAT DEMUXER (The Standard Way)
    // Kita buat file .txt playlist untuk audio agar FFmpeg membacanya sebagai 1 list yang bisa di-loop.
    // =========================================================

    // 1. SETUP VIDEO INPUT (MASTER CLOCK)
    // Input ini MENGGUNAKAN -re (Realtime) agar stream berjalan sesuai waktu dunia nyata.
    
    if (videoFiles.length > 0) {
        // --- KASUS: ADA FILE VIDEO (MP4) ---
        if (videoFiles.length === 1 && loop) {
            // Single Video Loop
            command.input(videoFiles[0]).inputOptions([
                '-re',              // Read input at native frame rate (Master Clock)
                '-stream_loop', '-1' // Loop infinite
            ]);
        } else {
            // Multiple Videos (Playlist)
            const vidListPath = path.join(__dirname, 'uploads', `vlist_${streamId}.txt`);
            createPlaylistFile(videoFiles, vidListPath);
            createdFiles.push(vidListPath);
            
            const inputOpts = ['-f', 'concat', '-safe', '0', '-re'];
            if (loop) inputOpts.unshift('-stream_loop', '-1');
            
            command.input(vidListPath).inputOptions(inputOpts);
        }
    } else {
        // --- KASUS: GAMBAR DIAM (AUDIO ONLY) ---
        // Kita gunakan gambar sebagai video stream
        let imageInput = coverImagePath;
        if (!imageInput || !fs.existsSync(imageInput)) {
             // Fallback: Generate black video if no image
             command.input('color=c=black:s=1280x720:r=30').inputFormat('lavfi').inputOptions(['-re']);
        } else {
             // Loop Image Forever
             command.input(imageInput).inputOptions([
                 '-loop', '1',      // Loop image stream
                 '-re',             // Realtime reading
                 '-framerate', '30' // Force 30fps
             ]);
        }
    }

    // 2. SETUP AUDIO INPUT (SLAVE)
    // PENTING: JANGAN gunakan -re di sini. 
    // Biarkan audio ditarik secepat mungkin mengikuti kebutuhan Video Master Clock.
    
    if (mp3Files.length > 0) {
        // Buat playlist audio selalu, meskipun cuma 1 file.
        // Ini lebih stabil daripada input file langsung untuk looping.
        const audioListPath = path.join(__dirname, 'uploads', `alist_${streamId}.txt`);
        createPlaylistFile(mp3Files, audioListPath);
        createdFiles.push(audioListPath);

        command.input(audioListPath).inputOptions([
            '-f', 'concat',      // Gunakan demuxer concat
            '-safe', '0',        // Izinkan path absolut
            '-stream_loop', '-1' // Loop playlist audio ini selamanya
        ]);

        // Mapping Complex Filter
        // Kita pastikan audio di-resample agar sinkron jika ada drift waktu
        command.complexFilter([
            // Video: Scale to 720p standard
            { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
            { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'v_out' },
            
            // Audio: Async Resample (KUNCI ANTI-PUTUS)
            // 'async=1' mengisi gap timestamp audio jika terjadi lag saat looping
            { filter: 'aresample', options: '44100:async=1', inputs: '1:a', outputs: 'resampled' },
            { filter: 'aformat', options: 'sample_fmts=fltp:channel_layouts=stereo', inputs: 'resampled', outputs: 'a_out' }
        ]);

        command.outputOptions(['-map [v_out]', '-map [a_out]']);

    } else {
        // --- KASUS: VIDEO ONLY (TANPA AUDIO EXTERNAL) ---
        // Cek apakah video punya audio bawaan
        
        const filters = [
             { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
             { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'v_out' }
        ];
        
        // Kita tidak tahu pasti video punya audio atau tidak tanpa probe detail tiap file.
        // Asumsi: Jika user tidak upload mp3, kita gunakan audio dari video (0:a) jika ada, atau silent.
        // Agar aman, kita map 0:v dan 0:a. Jika 0:a tidak ada, ffmpeg biasanya fail.
        // Solusi aman: Generate silent audio backup.
        
        // Kita tambahkan input dummy silence
        command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputFormat('lavfi');
        
        // Coba gunakan audio dari video (input 0), jika gagal fallback ke silence (input 1)
        // Note: Logic complex filter "amix" bisa menggabungkan keduanya.
        
        // Simplifikasi: Map video saja, biarkan FFmpeg handle audio mapping otomatis dari input 0.
        // Jika butuh explicit filter:
        command.complexFilter(filters);
        command.outputOptions(['-map [v_out]', '-map 0:a?']); // ? artinya map jika ada streamnya
    }

    // --- Output Options (Optimized for Stability) ---
    command.outputOptions([
        '-c:v libx264', '-preset ultrafast', '-tune zerolatency',
        '-r 30', '-g 60', 
        '-pix_fmt yuv420p',
        '-b:v 2500k', '-minrate 2500k', '-maxrate 2500k', '-bufsize 5000k',
        
        '-c:a aac', '-ar 44100', '-b:a 128k', '-ac 2',
        
        '-f flv', '-flvflags no_duration_filesize'
    ]);

    // --- Event Handling ---
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream ${streamId} started.`);
        // console.log(`[FFmpeg] Command: ${commandLine}`); // Uncomment for debug
        hasStarted = true;
        activeStreams.set(streamId, { 
            command, 
            userId, 
            tempFiles: createdFiles, // Store list of files to delete
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
            if (global.io) global.io.emit('log', { type: 'error', message: 'Stream Error: ' + err.message, streamId });
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
  
  // Bersihkan file playlist temporary
  if (stream.tempFiles && Array.isArray(stream.tempFiles)) {
      stream.tempFiles.forEach(f => {
          if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) {}
      });
  }

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
