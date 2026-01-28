
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
// STRATEGI PAMUNGKAS: PSEUDO-INFINITE PLAYLIST
// ============================================================================
const createInfinitePlaylistFile = (files, outputPath, loop) => {
    // Gunakan path absolut yang sangat aman
    const safeFiles = files.map(f => {
        const absPath = path.isAbsolute(f) ? f : path.join(__dirname, 'uploads', path.basename(f));
        // Escape single quotes: ' -> '\''
        return `file '${absPath.replace(/'/g, "'\\''")}'`;
    });
    
    let content = [];
    
    // Jika loop, kita duplikasi list agar menjadi sangat panjang.
    // Kita kurangi sedikit jumlah loop tapi pastikan stream_loop flag aktif juga.
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
  
  // Filter file MP3
  const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));
  
  const streamId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  
  return new Promise(async (resolve, reject) => {
    let command = ffmpeg();
    let lastProcessedSecond = 0;
    let playlistPath = null;
    let hasStarted = false;

    console.log(`[Stream ${streamId}] Starting... LOOP: ${loop}`);

    // ---------------------------------------------------------
    // INPUT 0: VISUAL (GAMBAR/VIDEO)
    // ---------------------------------------------------------
    if (coverImagePath && fs.existsSync(coverImagePath)) {
        if (coverImagePath.endsWith('.mp4')) {
             command.input(coverImagePath).inputOptions([
                 '-stream_loop', '-1', // Loop video background
                 '-re'                 // Realtime reading
             ]);
        } else {
             command.input(coverImagePath).inputOptions([
                 '-loop', '1',       // Loop gambar selamanya
                 '-re',              // Realtime Reading (PENTING)
                 '-framerate', '25'  // 25 FPS (Standard PAL, lebih aman)
             ]);
        }
    } else {
        command.input('color=c=black:s=1280x720:r=25').inputFormat('lavfi').inputOptions(['-re']);
    }

    // ---------------------------------------------------------
    // INPUT 1: AUDIO (PLAYLIST)
    // ---------------------------------------------------------
    if (mp3Files.length > 0) {
        playlistPath = path.join(__dirname, 'uploads', `playlist_${streamId}.txt`);
        createInfinitePlaylistFile(mp3Files, playlistPath, loop);

        // Opsi Input Audio
        const audioInputOptions = [
            '-f', 'concat',
            '-safe', '0'
        ];

        // FORCE LOOP FLAG pada demuxer level juga
        if (loop) {
            audioInputOptions.unshift('-stream_loop', '-1'); 
        }

        command.input(playlistPath).inputOptions(audioInputOptions);
    } else {
        command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputFormat('lavfi');
    }

    // ---------------------------------------------------------
    // FILTERS & MAPPING
    // ---------------------------------------------------------
    
    const filters = [
        // Video
        { filter: 'scale', options: '1280:720:force_original_aspect_ratio=decrease', inputs: '0:v', outputs: 'scaled' },
        { filter: 'pad', options: '1280:720:(ow-iw)/2:(oh-ih)/2:color=black', inputs: 'scaled', outputs: 'padded' },
        { filter: 'format', options: 'yuv420p', inputs: 'padded', outputs: 'v_out' },

        // Audio
        { filter: 'aresample', options: '44100', inputs: '1:a', outputs: 'a_out' }
    ];

    command.complexFilter(filters);

    // ---------------------------------------------------------
    // OUTPUT OPTIONS
    // ---------------------------------------------------------
    command.outputOptions([
        '-map [v_out]', '-map [a_out]',
        
        '-c:v libx264', 
        '-preset ultrafast', 
        '-tune zerolatency',
        '-g 50',             // Keyframe per 2 detik (25fps * 2)
        '-b:v 1500k',        
        '-maxrate 2000k',
        '-bufsize 4000k', 

        '-c:a aac', 
        '-b:a 128k', 
        '-ar 44100',
        '-ac 2',

        '-f flv',
        '-flvflags no_duration_filesize'
    ]);

    // ---------------------------------------------------------
    // EVENTS
    // ---------------------------------------------------------
    command
      .on('start', (commandLine) => {
        console.log(`[FFmpeg] Stream Started: ${streamId}`);
        // console.log("Command:", commandLine); // Debugging
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
