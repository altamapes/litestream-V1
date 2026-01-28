
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { db } = require('./database');

// MARKER: PASTIKAN INI MUNCUL DI LOG
console.log("\n==================================================");
console.log("!!! LITESTREAM ENGINE V6 (STABLE LOW CPU) !!!");
console.log("==================================================\n");

const activeStreams = new Map();
let lastProcessedSecond = {}; 

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

const createPlaylistFile = (files) => {
    const uniqueId = Date.now() + '_' + Math.random().toString(36).substring(7);
    const playlistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
    
    let list = [...files];
    if (list.length < 5) list = [...list, ...list, ...list]; 

    const content = list.map(function(f) {
        const safePath = path.resolve(f).replace(/'/g, "'\\''");
        const ext = path.extname(f).toLowerCase();
        if (['.jpg','.png','.jpeg','.webp'].includes(ext)) return `file '${safePath}'\nduration 10`;
        return `file '${safePath}'`;
    }).join('\n');
    
    const last = files[files.length-1];
    if(['.jpg','.png','.jpeg','.webp'].includes(path.extname(last).toLowerCase())) {
        content += `\nfile '${path.resolve(last).replace(/'/g, "'\\''")}'`;
    }

    fs.writeFileSync(playlistPath, content);
    return playlistPath;
};

const preProcessImage = (input, userId) => {
    return new Promise(function(resolve) {
        if (!input || !fs.existsSync(input)) return resolve(null);
        if(input.endsWith('.mp4')) return resolve(input);

        const output = path.join(__dirname, 'uploads', `bg_${userId}_${Date.now()}.jpg`);
        ffmpeg(input)
            .outputOptions(['-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720', '-update', '1', '-frames:v', '1'])
            .save(output)
            .on('end', function() { resolve(output); })
            .on('error', function(e) { resolve(input); });
    });
};

const startStream = async (inputPaths, destinations, options = {}) => {
    const streamId = Date.now().toString().slice(-6);
    const userId = options.userId;
    console.log(`[StreamEngine ${streamId}] Initializing (V6 Low CPU)...`);

    let targets = (Array.isArray(destinations) ? destinations : [destinations]).filter(function(d) { return d && d.trim(); });
    if (targets.length === 0) throw new Error("No destinations provided");

    let files = (Array.isArray(inputPaths) ? inputPaths : [inputPaths]).filter(function(f) { return fs.existsSync(f); });
    if (files.length === 0) throw new Error("Files missing or not found on disk.");

    const audioExts = ['.mp3', '.aac', '.wav', '.m4a', '.flac', '.ogg'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

    const hasAudio = files.some(function(f) { return audioExts.includes(path.extname(f).toLowerCase()); });
    const hasVideo = files.some(function(f) { return !audioExts.includes(path.extname(f).toLowerCase()) && !imageExts.includes(path.extname(f).toLowerCase()); });
    
    // Strict Mode Logic
    let isStaticMode = false;
    if (hasAudio && !hasVideo) isStaticMode = true; // Audio Only
    
    let isVideoMode = false;
    if (hasVideo) isVideoMode = true; // Video (mixed or single)

    let finalImage = null;
    let tempBgPath = null;
    
    // Pre-process cover image if needed
    if (isStaticMode) {
        let coverImage = options.coverImagePath;
        // Jika tidak ada cover, dan ini slideshow (banyak gambar + audio), pakai gambar pertama
        if (!coverImage && files.some(f => imageExts.includes(path.extname(f).toLowerCase()))) {
            coverImage = files.find(f => imageExts.includes(path.extname(f).toLowerCase()));
        }
        
        if (coverImage) {
            finalImage = await preProcessImage(coverImage, options.userId);
            if (finalImage && finalImage !== coverImage) tempBgPath = finalImage;
        }
    }

    return new Promise(function(resolve, reject) {
        const command = ffmpeg();
        let playlistPath = null;
        
        // --- OPTIMISASI CPU LEVEL 2 (Aggressive) ---
        const FPS = isStaticMode ? 10 : 23; 
        const BITRATE = isStaticMode ? '1000k' : '2000k';
        
        command.inputOptions(['-analyzeduration 10000000', '-probesize 10000000']);

        // --- INPUT BUILDER ---
        if (isStaticMode) {
            console.log(`[StreamEngine ${streamId}] Mode: STATIC AUDIO (Low CPU)`);
            
            // INPUT 0: VISUAL
            if (finalImage) {
                if (finalImage.endsWith('.mp4')) {
                     command.input(finalImage).inputOptions(['-stream_loop', '-1', '-re']);
                } else {
                     command.input(finalImage).inputOptions(['-loop 1', `-framerate ${FPS}`, '-re']);
                }
            } else {
                // FIXED: Gunakan inputFormat('lavfi') agar fluent-ffmpeg mendeteksi ini sebagai input valid
                command.input(`color=c=black:s=1280x720:r=${FPS}`).inputFormat('lavfi').inputOptions(['-re']);
            }

            // INPUT 1: AUDIO
            // Cek apakah user upload gambar saja (Slideshow) atau Audio file
            const audioOnlyFiles = files.filter(f => audioExts.includes(path.extname(f).toLowerCase()));
            
            if (audioOnlyFiles.length > 0) {
                 if (audioOnlyFiles.length === 1 && options.loop) {
                    command.input(audioOnlyFiles[0]).inputOptions(['-stream_loop', '-1', '-re']);
                } else {
                    playlistPath = createPlaylistFile(audioOnlyFiles);
                    const opts = ['-f', 'concat', '-safe', '0', '-re'];
                    if (options.loop) opts.unshift('-stream_loop', '-1');
                    command.input(playlistPath).inputOptions(opts);
                }
            } else {
                // Slideshow tanpa file audio (Silent)
                command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputFormat('lavfi').inputOptions(['-re']);
            }
            
            // Mapping Wajib: Video dari Input 0, Audio dari Input 1
            command.outputOptions(['-map 0:v', '-map 1:a']);
            
            // Filter ringan untuk resize/pad
            command.complexFilter([
                `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`
            ]);

        } else {
            console.log(`[StreamEngine ${streamId}] Mode: VIDEO (Low CPU)`);
            
            const videoFiles = files.filter(f => !audioExts.includes(path.extname(f).toLowerCase()) && !imageExts.includes(path.extname(f).toLowerCase()));
            
            if (videoFiles.length > 0) {
                playlistPath = createPlaylistFile(videoFiles);
                const opts = ['-re', '-f', 'concat', '-safe', '0'];
                if (options.loop) opts.unshift('-stream_loop', '-1');
                command.input(playlistPath);
                command.inputOptions(opts);
            } else {
                // Fallback terakhir (jarang terjadi)
                command.input(files[0]).inputOptions(['-re', '-stream_loop', '-1']);
            }

            let filters = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1';
            command.outputOptions(`-vf ${filters}`);
            command.outputOptions(['-map 0:v', '-map 0:a?']); 
        }

        // --- ENCODING SETTINGS (Low CPU) ---
        const encOpts = [
            '-c:v libx264', 
            '-preset ultrafast', 
            '-tune zerolatency', 
            '-profile:v baseline', 
            '-threads 1', // WAJIB UNTUK VPS 1 CORE
            
            // Hack x264 untuk CPU Rendah
            '-x264-params', 'subme=0:me_range=4:rc_lookahead=10:me=dia:no_deblock=1',
            
            `-b:v ${BITRATE}`, `-maxrate ${BITRATE}`, `-bufsize ${parseInt(BITRATE)*2}k`, 
            `-r ${FPS}`, `-g ${FPS*2}`,
            '-pix_fmt yuv420p', 
            
            '-c:a aac', '-b:a 96k', '-ar 44100', '-ac 2',
            '-f flv', '-flvflags no_duration_filesize'
        ];

        // Output Handling
        if (targets.length === 1) {
            command.output(targets[0]).outputOptions(encOpts);
        } else {
            const tee = targets.map(t => `[f=flv:onfail=ignore]${t}`).join('|');
            command.output(tee).outputOptions(encOpts).outputOptions('-f tee');
        }

        lastProcessedSecond[streamId] = 0;
        
        activeStreams.set(streamId, {
            command: command, 
            userId: options.userId, 
            name: options.title || options.streamName,
            startTime: Date.now(), 
            playlistPath: playlistPath, 
            tempBgPath: tempBgPath,
            config: { inputPaths: inputPaths, destinations: destinations, options: options }, 
            platform: destinations[0].includes('youtube') ? 'YouTube' : 'Custom',
            isManualStop: false
        });

        command.on('start', function(cmdLine) {
             console.log(`[StreamEngine ${streamId}] STARTED.`);
             if (global.io) {
                 global.io.emit('log', { type: 'start', message: `Stream Started.` });
                 global.io.emit('stream_started', { streamId });
             }
             resolve(streamId);
        });

        command.on('progress', function(p) { trackUsage(p, streamId, options.userId); });
        
        command.on('error', function(err) {
            if (!err.message.includes('SIGKILL')) console.error(`[StreamEngine ${streamId}] Error:`, err.message);
            cleanup(streamId);
        });

        command.on('end', function() {
            console.log(`[StreamEngine ${streamId}] Ended.`);
            cleanup(streamId);
        });

        // Failsafe: Pastikan command.run() dipanggil
        try { 
            // Validasi tambahan sebelum run
            // @ts-ignore
            if (command._inputs.length === 0) {
                 reject(new Error("Internal Error: No inputs prepared."));
                 return;
            }
            command.run(); 
        } catch (e) { 
            reject(new Error("Engine failed: " + e.message)); 
        }
    });
};

const cleanup = (id) => {
    const s = activeStreams.get(id);
    if (!s) return;
    try { if(s.playlistPath) fs.unlinkSync(s.playlistPath); } catch(e){}
    try { if(s.tempBgPath) fs.unlinkSync(s.tempBgPath); } catch(e){}
    delete lastProcessedSecond[id];
    activeStreams.delete(id);
    if (global.io) global.io.emit('stream_ended', { streamId: id });
};

const trackUsage = (p, id, userId) => {
    if (!p.timemark) return;
    const t = p.timemark.split(':');
    let sec = 0;
    if (t.length === 3) sec = (+t[0]) * 3600 + (+t[1]) * 60 + (+parseFloat(t[2]));
    const last = lastProcessedSecond[id] || 0;
    const diff = sec - last;
    if (diff > 5) { 
        lastProcessedSecond[id] = sec;
        db.run("UPDATE users SET usage_seconds = usage_seconds + ? WHERE id = ?", [Math.floor(diff), userId]);
        if (global.io) global.io.emit('stats', { streamId: id, duration: p.timemark, bitrate: p.currentKbps ? Math.round(p.currentKbps) + ' kbps' : 'Stable' });
    }
};

const stopStream = async (id) => {
    const realId = (typeof id === 'object') ? id.streamId : id;
    const s = activeStreams.get(realId);
    if (s && s.command) {
        s.isManualStop = true;
        try { s.command.kill('SIGKILL'); } catch(e) {}
        cleanup(realId);
        return true;
    }
    return false;
};

const getActiveStreams = (userId) => {
    const list = [];
    activeStreams.forEach(function(v, k) {
        if (v.userId === userId) {
            list.push({ id: k, name: v.name || 'Stream ' + k, startTime: v.startTime, platform: v.platform || 'Custom' });
        }
    });
    return list;
};

const isStreaming = () => activeStreams.size > 0;

module.exports = { startStream, stopStream, getActiveStreams, killZombieProcesses, isStreaming };
