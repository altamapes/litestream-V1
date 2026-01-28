
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

// ============================================================================
// THE MAGIC SAUCE: NODE.JS INFINITE AUDIO PIPE
// Mengalirkan data MP3 secara terus menerus ke FFmpeg tanpa henti.
// Bagi FFmpeg, ini adalah satu file audio yang sangat panjang (infinite).
// Timestamp tidak akan pernah reset.
// ============================================================================
const createInfiniteAudioStream = (files, loop) => {
    const outStream = new PassThrough();
    let currentIdx = 0;
    let streamActive = true;
    let currentReadStream = null;

    const playNext = () => {
        if (!streamActive) return;

        if (currentIdx >= files.length) {
            if (!loop) {
                outStream.end(); 
                return;
            }
            currentIdx = 0; // Loop kembali ke file pertama
        }

        const filePath = files[currentIdx];
        
        if (!fs.existsSync(filePath)) {
            console.error(`File missing: ${filePath}, skipping...`);
            currentIdx++;
            playNext();
            return;
        }

        // Baca file MP3 dan kirim ke Pipe utama
        currentReadStream = fs.createReadStream(filePath);
        
        // { end: false } PENTING: Jangan tutup pipa output saat lagu ini habis
        currentReadStream.pipe(outStream, { end: false });

        currentReadStream.on('end', () => {
            currentIdx++;
            playNext(); // Sambung lagu berikutnya secara instan
        });

        currentReadStream.on('error', (err) => {
            console.error(`Error reading ${filePath}:`, err);
            currentIdx++;
            playNext();
        });
    };

    // Mulai pemutaran
    playNext();

    // Fungsi untuk mematikan loop dari luar
    outStream.kill = () => {
        streamActive = false;
        if (currentReadStream) currentReadStream.destroy();
        outStream.end();
        outStream.destroy();
    };

    return outStream;
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
    let audioStreamNode = null;
    let hasStarted = false;

    console.log(`[Stream ${streamId}] Starting Mode: INFINITE RADIO (MP3 + Image)`);

    // ---------------------------------------------------------
    // INPUT 0: VISUAL (GAMBAR/VIDEO LOOP) - MASTER CLOCK (-re)
    // ---------------------------------------------------------
    // Kita gunakan gambar sebagai "jangkar" waktu.
    // '-re' dipasang di sini agar FFmpeg berjalan real-time (1x speed).
    
    if (coverImagePath && fs.existsSync(coverImagePath)) {
        // Jika file adalah Video (MP4), jadikan visual loop
        if (coverImagePath.endsWith('.mp4')) {
             command.input(coverImagePath).inputOptions(['-stream_loop', '-1', '-re']);
        } else {
             // Jika Gambar (JPG/PNG), loop sebagai video stream
             command.input(coverImagePath).inputOptions([
                 '-loop', '1',       // Loop gambar selamanya
                 '-re',              // Realtime reading (PENTING)
                 '-framerate', '20'  // Hemat CPU, 20fps cukup untuk gambar diam
             ]);
        }
    } else {
        // Fallback jika tidak ada gambar: Layar Hitam
        command.input('color=c=black:s=1280x720:r=20').inputFormat('lavfi').inputOptions(['-re']);
    }

    // ---------------------------------------------------------
    // INPUT 1: AUDIO (NODE JS PIPE) - SLAVE
    // ---------------------------------------------------------
    // Di sini kita masukkan pipa "tak terbatas" kita.
    // JANGAN pakai -re di sini, biarkan FFmpeg menarik audio sebutuhnya mengikuti video.
    
    if (mp3Files.length > 0) {
        audioStreamNode = createInfiniteAudioStream(mp3Files, loop);
        command.input(audioStreamNode).inputFormat('mp3');
    } else {
        // Fallback Silence jika user lupa pilih MP3
        command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputFormat('lavfi');
    }

    // ---------------------------------------------------------
    // COMPLEX FILTER
    // ---------------------------------------------------------
    command.complexFilter([
        // 1. Proses Visual: Scale ke 720p, pastikan pixel format yuv420p (wajib untuk YouTube)
        { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
        { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
        { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },

        // 2. Proses Audio: Resample agar sample rate konsisten & generate timestamp (asetpts)
        // aresample=async=1 membantu sinkronisasi jika ada sedikit jitter dari pipe
        { filter: 'aresample', options: '44100:async=1', inputs: '1:a', outputs: 'resampled' },
        { filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' }
    ]);

    // ---------------------------------------------------------
    // OUTPUT OPTIONS (TUNED FOR STABILITY)
    // ---------------------------------------------------------
    command.outputOptions([
        '-map [v_out]', '-map [a_out]',
        
        // Video Codec (H.264) - Sangat Cepat (ultrafast) untuk hemat CPU VPS
        '-c:v libx264', 
        '-preset ultrafast', 
        '-tune zerolatency',
        '-g 40', // Keyframe interval (setiap 2 detik untuk 20fps)
        '-b:v 1500k', // Bitrate visual (cukup untuk gambar diam)
        '-maxrate 1500k', 
        '-bufsize 3000k',

        // Audio Codec (AAC)
        '-c:a aac', 
        '-b:a 128k', 
        '-ar 44100',
        '-ac 2', // Stereo

        // Format Output FLV (RTMP)
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
            audioStreamNode, // Simpan referensi pipe untuk dimatikan nanti
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
        // Hitung usage per 5 detik
        const currentTimemark = progress.timemark; 
        let totalSeconds = 0;
        if(currentTimemark) {
            const parts = currentTimemark.split(':');
            if(parts.length === 3) totalSeconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parseFloat(parts[2]));
        }
        
        const diff = Math.floor(totalSeconds - lastProcessedSecond);
        if (diff >= 5) { 
            lastProcessedSecond = totalSeconds;
            // Update DB Usage
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
  
  // KILL THE NODE.JS AUDIO PIPE
  // Ini wajib dilakukan agar loop pembacaan file berhenti
  if (stream.audioStreamNode && typeof stream.audioStreamNode.kill === 'function') {
      console.log(`[Stream ${streamId}] Stopping Audio Pipe Loop...`);
      stream.audioStreamNode.kill();
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
