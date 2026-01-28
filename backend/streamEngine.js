
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { db } = require('./database');

// MARKER: PASTIKAN INI MUNCUL DI LOG
console.log("\n==================================================");
console.log("!!! LITESTREAM ENGINE V5 (LOW CPU EDITION) !!!");
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

const getSystemFontPath = () => {
    const fonts = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
        'C:\\Windows\\Fonts\\arial.ttf'
    ];
    return fonts.find(function(f) { return fs.existsSync(f); }) || null;
};

const createPlaylistFile = (files) => {
    const uniqueId = Date.now() + '_' + Math.random().toString(36).substring(7);
    const playlistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
    
    let list = [...files];
    // Duplikasi list agar buffer ffmpeg tidak kosong saat loop
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
    console.log(`[StreamEngine ${streamId}] Initializing (Low CPU Mode)...`);

    let targets = (Array.isArray(destinations) ? destinations : [destinations]).filter(function(d) { return d && d.trim(); });
    if (targets.length === 0) throw new Error("No destinations provided");

    let files = (Array.isArray(inputPaths) ? inputPaths : [inputPaths]).filter(function(f) { return fs.existsSync(f); });
    if (files.length === 0) throw new Error("Files missing.");

    const audioExts = ['.mp3', '.aac', '.wav', '.m4a', '.flac', '.ogg'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

    const hasAudio = files.some(function(f) { return audioExts.includes(path.extname(f).toLowerCase()); });
    const hasVideo = files.some(function(f) { return !audioExts.includes(path.extname(f).toLowerCase()) && !imageExts.includes(path.extname(f).toLowerCase()); });
    
    const isStaticMode = !hasVideo && hasAudio; 
    const isSlideshowMode = !hasVideo && !hasAudio; 

    let finalImage = null;
    let tempBgPath = null;
    
    if (isStaticMode || isSlideshowMode) {
        let coverImage = options.coverImagePath;
        if (isSlideshowMode && files.length > 0 && !coverImage) coverImage = files[0];
        
        if (coverImage) {
            finalImage = await preProcessImage(coverImage, options.userId);
            if (finalImage && finalImage !== coverImage) tempBgPath = finalImage;
        }
    }

    return new Promise(function(resolve, reject) {
        const command = ffmpeg();
        let inputCount = 0;
        let playlistPath = null;
        
        // OPTIMISASI CPU 1: Kurangi Analyze Duration
        command.inputOptions(['-analyzeduration 10000000', '-probesize 10000000']);
        
        // OPTIMISASI CPU 2: FPS Rendah
        // Mode Radio: 10 FPS (Sangat ringan)
        // Mode Video: 23 FPS (Standar minimal, lebih ringan dari 30)
        const FPS = (isStaticMode || isSlideshowMode) ? 10 : 23;
        const BITRATE = (isStaticMode || isSlideshowMode) ? '1000k' : '2000k';

        // --- INPUT CONFIGURATION ---
        if (isStaticMode || isSlideshowMode) {
            // Static/Radio
            if (finalImage) {
                if (finalImage.endsWith('.mp4')) {
                     command.input(finalImage).inputOptions(['-stream_loop', '-1', '-re']);
                } else {
                     command.input(finalImage).inputOptions(['-loop 1', `-framerate ${FPS}`, '-re']);
                }
            } else {
                command.input(`color=c=black:s=1280x720:r=${FPS}`).inputOptions(['-f lavfi', '-re']);
            }
            inputCount++;

            if (isSlideshowMode) {
                command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputOptions(['-f lavfi', '-re']);
            } else {
                if (files.length === 1 && options.loop) {
                    command.input(files[0]).inputOptions(['-stream_loop', '-1', '-re']);
                } else {
                    playlistPath = createPlaylistFile(files);
                    const opts = ['-f', 'concat', '-safe', '0', '-re'];
                    if (options.loop) opts.unshift('-stream_loop', '-1');
                    command.input(playlistPath).inputOptions(opts);
                }
            }
            inputCount++;
            
            command.outputOptions(['-map 0:v', '-map 1:a']);
            
            // Filter ringan untuk resize
            command.complexFilter([
                `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`
            ]);

        } else {
            // Video Mode
            const videoFiles = files.filter(function(f) { 
                return !audioExts.includes(path.extname(f).toLowerCase()) && !imageExts.includes(path.extname(f).toLowerCase()); 
            });
            
            if (videoFiles.length > 0) {
                // Gunakan Playlist untuk keamanan loop
                playlistPath = createPlaylistFile(videoFiles);
                const opts = ['-re', '-f', 'concat', '-safe', '0'];
                if (options.loop) opts.unshift('-stream_loop', '-1');
                command.input(playlistPath);
                command.inputOptions(opts);
                inputCount++;
            } else {
                // Fallback
                command.input(files[0]).inputOptions(['-re', '-stream_loop', '-1']);
                inputCount++;
            }

            // Simple Filter
            let filters = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1';
            command.outputOptions(`-vf ${filters}`);
            command.outputOptions(['-map 0:v', '-map 0:a?']); 
        }

        // --- OPTIMISASI CPU 3: ENCODING SUPER RINGAN ---
        const encOpts = [
            // Video
            '-c:v libx264', 
            '-preset ultrafast', 
            '-tune zerolatency', 
            '-profile:v baseline', // Profile paling enteng
            
            // Limit Resource
            '-threads 1',          // Paksa 1 thread (PENTING untuk VPS 1 Core agar tidak thrashing)
            
            // x264 Aggressive Hacks (Kualitas turun dikit, CPU turun banyak)
            '-x264-params', 'subme=0:me_range=4:rc_lookahead=10:me=dia:no_deblock=1',
            
            // Rate Control
            `-b:v ${BITRATE}`, 
            `-maxrate ${BITRATE}`, 
            `-bufsize ${parseInt(BITRATE)*2}k`, 
            `-r ${FPS}`, 
            `-g ${FPS*2}`, // Keyframe interval 2 detik
            
            // Format
            '-pix_fmt yuv420p', 
            
            // Audio (AAC LC Low Profile)
            '-c:a aac', 
            '-b:a 96k',   // Turunkan bitrate audio dikit
            '-ar 44100', 
            '-ac 2',
            
            // Output
            '-f flv', 
            '-flvflags no_duration_filesize'
        ];

        if (targets.length === 1) {
            command.output(targets[0]).outputOptions(encOpts);
        } else {
            const tee = targets.map(function(t) { return `[f=flv:onfail=ignore]${t}`; }).join('|');
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
             console.log(`[StreamEngine ${streamId}] STARTED (V5 LOW CPU).`);
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

        if (inputCount === 0) {
            reject(new Error("Internal Error: No inputs specified."));
            return;
        }

        try { command.run(); } catch (e) { reject(new Error("Engine failed: " + e.message)); }
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
