
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

// Helper: Generate Playlist Content (Used for Video Only Mode)
const createPlaylistFile = (files, outputPath) => {
    const safeFiles = files.map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`);
    const content = safeFiles.join('\n');
    fs.writeFileSync(outputPath, content);
    return outputPath;
};

// ============================================================================
// THE MAGIC SAUCE: NODE.JS INFINITE AUDIO PIPE
// Mengalirkan data MP3 secara terus menerus ke FFmpeg tanpa henti.
// Bagi FFmpeg, ini adalah satu file audio yang sangat panjang (infinite).
// ============================================================================
const createInfiniteAudioStream = (files, loop) => {
    const outStream = new PassThrough();
    let currentIdx = 0;
    let isActive = true;
    let currentReadStream = null;

    const streamNext = () => {
        if (!isActive) return;
        
        if (currentIdx >= files.length) {
            if (!loop) {
                outStream.end(); // Stop if no loop requested
                return;
            }
            currentIdx = 0; // Loop back to start
        }

        const filePath = files[currentIdx];
        if (!fs.existsSync(filePath)) {
            currentIdx++;
            streamNext();
            return;
        }

        // Create stream for current file
        currentReadStream = fs.createReadStream(filePath);
        
        // Pipe to output, but DO NOT close output when this file ends ({ end: false })
        currentReadStream.pipe(outStream, { end: false });

        currentReadStream.on('end', () => {
            currentIdx++;
            streamNext(); // Play next file immediately
        });
        
        currentReadStream.on('error', (err) => {
            console.error(`Error reading ${filePath}:`, err);
            currentIdx++;
            streamNext();
        });
    };

    // Start the loop
    streamNext();
    
    // Method to kill the loop externally
    outStream.kill = () => {
        isActive = false;
        if (currentReadStream) currentReadStream.destroy();
        outStream.end(); 
        outStream.destroy();
    };
    
    return outStream;
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
    let currentPlaylistPath = null;
    let audioStreamNode = null; // Reference to our Node.js Pipe
    let hasStarted = false;

    // =========================================================
    // MODE 3: HYBRID (VIDEO CLIP + MP3 AUDIO)
    // Solusi: Video Loop via FFmpeg (Master), Audio Loop via Node Pipe (Slave)
    // =========================================================
    if (videoFiles.length > 0 && mp3Files.length > 0) {
        console.log(`[Stream ${streamId}] Mode: HYBRID (Visual: MP4, Audio: Node Pipe)`);
        
        // --- INPUT 0: VISUAL (VIDEO) ---
        // Video menggunakan -re (Realtime) sebagai master clock.
        // Kita loop video ini agar visual tidak pernah habis.
        if (videoFiles.length === 1 && loop) {
             command.input(videoFiles[0]).inputOptions([
                '-stream_loop', '-1',
                '-re' 
             ]);
        } else {
             currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_v_${streamId}.txt`);
             createPlaylistFile(videoFiles, currentPlaylistPath);
             const vidInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
             if (loop) vidInputOpts.unshift('-stream_loop', '-1');
             command.input(currentPlaylistPath).inputOptions(vidInputOpts);
        }

        // --- INPUT 1: AUDIO (MP3) ---
        // Menggunakan Node.js Pipe. FFmpeg menerima ini sebagai stream audio 'live' tak terbatas.
        // Tidak perlu flag loop atau re disini, karena data dikirim oleh Node.js.
        audioStreamNode = createInfiniteAudioStream(mp3Files, loop);
        command.input(audioStreamNode).inputFormat('mp3');

        // COMPLEX FILTER
        command.complexFilter([
            // Video Processing (Input 0)
            { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
            { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
            { filter: 'fps', options: 'fps=30', inputs: 'padded', outputs: 'fps_v' },
            { filter: 'setpts', options: 'N/FRAME_RATE/TB', inputs: 'fps_v', outputs: 'v_out' },
            
            // Audio Processing (Input 1)
            { filter: 'aresample', options: '44100:async=1', inputs: '1:a', outputs: 'resampled' },
            { filter: 'aformat', options: 'sample_fmts=fltp:channel_layouts=stereo', inputs: 'resampled', outputs: 'a_out' }
        ]);
        
        // Perbesar buffer agar tidak putus saat transisi lagu
        command.addOption('-max_muxing_queue_size', '9999');
    }

    // =========================================================
    // MODE 1: AUDIO ONLY (IMAGE + MP3)
    // Solusi: Image Loop via FFmpeg (Master), Audio Loop via Node Pipe (Slave)
    // =========================================================
    else if (videoFiles.length === 0 && mp3Files.length > 0) {
        console.log(`[Stream ${streamId}] Mode: AUDIO ONLY (Image + Node Pipe)`);

        // --- INPUT 0: COVER IMAGE ---
        if (!coverImagePath || !fs.existsSync(coverImagePath)) {
            command.input('color=c=black:s=1280x720:r=25').inputOptions(['-f', 'lavfi', '-re']);
        } else {
            // Gambar di-loop infinite oleh FFmpeg, menjadi patokan waktu stream (-re)
            command.input(coverImagePath).inputOptions(['-loop', '1', '-framerate', '25', '-re']); 
        }

        // --- INPUT 1: AUDIO ---
        // Menggunakan Node.js Pipe.
        audioStreamNode = createInfiniteAudioStream(mp3Files, loop);
        command.input(audioStreamNode).inputFormat('mp3');
      
        command.complexFilter([
            // Video (Image) Processing
            { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
            { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
            { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },
            
            // Audio Processing
            { filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'resampled' },
            { filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' }
        ]);
    } 

    // =========================================================
    // MODE 2: VIDEO ONLY (MP4 Original)
    // Tetap menggunakan metode Playlist Concat karena Video Container (MP4)
    // lebih kompleks strukturnya daripada MP3, lebih aman pakai concat demuxer.
    // =========================================================
    else {
      let hasFileAudio = false;
      try {
          hasFileAudio = await checkFileHasAudio(files[0]);
          console.log(`[Stream ${streamId}] Audio Detected: ${hasFileAudio}`);
      } catch(e) {}

      if (files.length === 1 && loop) {
          command.input(files[0]).inputOptions([
              '-re', 
              '-stream_loop', '-1', 
              '-fflags', '+genpts',
              '-map_metadata', '-1' 
          ]);
      } else {
          const uniqueId = streamId;
          currentPlaylistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
          createPlaylistFile(files, currentPlaylistPath);
          
          const vidInputOpts = ['-f', 'concat', '-safe', '0', '-re'];
          if (loop) vidInputOpts.unshift('-stream_loop', '-1');
          
          command.input(currentPlaylistPath).inputOptions(vidInputOpts);
      }

      // Input #1: Silence (Backup)
      command.input('anullsrc=channel_layout=stereo:sample_rate=44100')
             .inputFormat('lavfi');

      const filters = [
          { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
          { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
          { filter: 'fps', options: 'fps=30', inputs: 'padded', outputs: 'fps_v' },
          { filter: 'setpts', options: 'N/FRAME_RATE/TB', inputs: 'fps_v', outputs: 'v_out' }
      ];

      if (hasFileAudio) {
          filters.push({ filter: 'aresample', options: '44100:async=1', inputs: '0:a', outputs: 'resampled' });
          filters.push({ filter: 'aformat', options: 'sample_fmts=fltp:channel_layouts=stereo', inputs: 'resampled', outputs: 'formatted' });
          filters.push({ filter: 'asetpts', options: 'N/SR/TB', inputs: 'formatted', outputs: 'a_out' });
      } else {
          filters.push({ filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'resampled' });
          filters.push({ filter: 'asetpts', options: 'N/SR/TB', inputs: 'resampled', outputs: 'a_out' });
      }

      command.complexFilter(filters);
      command.addOption('-max_muxing_queue_size', '4096');
    }

    // --- Output Options (Common) ---
    command.outputOptions([
        '-map [v_out]', '-map [a_out]',
        '-c:v libx264', '-preset ultrafast', '-tune zerolatency',
        '-r 30', '-g 60', 
        '-pix_fmt yuv420p',
        '-b:v 2500k', '-minrate 2500k', '-maxrate 2500k', '-bufsize 5000k',
        '-nal-hrd cbr',
        '-c:a aac', '-ar 44100', '-b:a 128k', '-ac 2',
        '-f flv', '-flvflags no_duration_filesize'
    ]);

    // --- Event Handling ---
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream ${streamId} started.`);
        console.log(`[FFmpeg] Command: ${commandLine}`);
        hasStarted = true;
        activeStreams.set(streamId, { 
            command, 
            userId, 
            playlistPath: currentPlaylistPath,
            audioStreamNode, // SIMPAN REFERENCE AGAR BISA DI-KILL
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
  
  // 1. Bersihkan Playlist File jika ada
  if (stream.playlistPath && fs.existsSync(stream.playlistPath)) try { fs.unlinkSync(stream.playlistPath); } catch (e) {}
  
  // 2. MATIKAN NODE.JS AUDIO PIPE LOOP JIKA ADA
  // Ini penting agar memory tidak bocor dan loop berhenti
  if (stream.audioStreamNode && typeof stream.audioStreamNode.kill === 'function') {
      console.log(`[Stream ${streamId}] Killing Node Audio Pipe...`);
      stream.audioStreamNode.kill();
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
