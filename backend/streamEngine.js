
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { db } = require('./database');

// MARKER: PASTIKAN INI MUNCUL DI LOG UNTUK KONFIRMASI UPDATE
console.log("\n==================================================");
console.log("!!! LITESTREAM ENGINE V4 (USER LOGIC) LOADED !!!");
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
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        'C:\\Windows\\Fonts\\arial.ttf'
    ];
    return fonts.find(function(f) { return fs.existsSync(f); }) || null;
};

// Generate Playlist with strict escaping
const createPlaylistFile = (files) => {
    const uniqueId = Date.now() + '_' + Math.random().toString(36).substring(7);
    const playlistPath = path.join(__dirname, 'uploads', `playlist_${uniqueId}.txt`);
    
    // Duplicate list multiple times to help buffering
    let list = [...files];
    if (list.length < 5) list = [...list, ...list, ...list]; 

    const content = list.map(function(f) {
        // Safe path escaping for FFmpeg concat demuxer
        const safePath = path.resolve(f).replace(/'/g, "'\\''");
        const ext = path.extname(f).toLowerCase();
        // Image duration for slideshows
        if (['.jpg','.png','.jpeg','.webp'].includes(ext)) return `file '${safePath}'\nduration 10`;
        return `file '${safePath}'`;
    }).join('\n');
    
    // Hack for last image frame (FFmpeg quirk)
    const last = files[files.length-1];
    if(['.jpg','.png','.jpeg','.webp'].includes(path.extname(last).toLowerCase())) {
        content += `\nfile '${path.resolve(last).replace(/'/g, "'\\''")}'`;
    }

    fs.writeFileSync(playlistPath, content);
    return playlistPath;
};

// Optimize Image with fallback
const preProcessImage = (input, userId) => {
    return new Promise(function(resolve) {
        if (!input || !fs.existsSync(input)) return resolve(null);
        
        // Skip processing if it's already a video acting as cover
        if(input.endsWith('.mp4')) return resolve(input);

        const output = path.join(__dirname, 'uploads', `bg_${userId}_${Date.now()}.jpg`);
        ffmpeg(input)
            .outputOptions(['-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720', '-update', '1', '-frames:v', '1'])
            .save(output)
            .on('end', function() { resolve(output); })
            .on('error', function(e) {
                console.error("[StreamEngine] Image process failed:", e.message);
                resolve(input); // Fallback to original
            });
    });
};

const startStream = async (inputPaths, destinations, options = {}) => {
    // Adaptasi parameter agar kompatibel dengan pemanggilan dari server.js
    // server.js memanggil: startStream(paths, rtmpUrl, options)
    // Code user memanggil: startStream(paths, destinations, options)
    // Jadi ini sudah cocok.

    const streamId = Date.now().toString().slice(-6);
    const userId = options.userId;
    console.log(`[StreamEngine ${streamId}] Initializing for User ${userId}...`);

    // 1. Validate Destinations
    let targets = (Array.isArray(destinations) ? destinations : [destinations]).filter(function(d) { return d && d.trim(); });
    if (targets.length === 0) throw new Error("No destinations provided");

    // 2. Validate Files
    let files = (Array.isArray(inputPaths) ? inputPaths : [inputPaths]).filter(function(f) { return fs.existsSync(f); });
    if (files.length === 0) throw new Error("All selected files are missing or unreadable.");

    const audioExts = ['.mp3', '.aac', '.wav', '.m4a', '.flac', '.ogg'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

    const hasAudio = files.some(function(f) { return audioExts.includes(path.extname(f).toLowerCase()); });
    const hasVideo = files.some(function(f) { return !audioExts.includes(path.extname(f).toLowerCase()) && !imageExts.includes(path.extname(f).toLowerCase()); });
    
    // Mode Logic
    const isStaticMode = !hasVideo && hasAudio; // Audio + Image/Black
    const isSlideshowMode = !hasVideo && !hasAudio; // Image Only

    // 3. Prepare Image Input (For Static/Slideshow)
    let finalImage = null;
    let tempBgPath = null;
    
    if (isStaticMode || isSlideshowMode) {
        let coverImage = options.coverImagePath;
        // Jika tidak ada cover, tapi ini slideshow, ambil gambar pertama sebagai cover loop base
        if (isSlideshowMode && files.length > 0 && !coverImage) coverImage = files[0];
        
        if (coverImage) {
            finalImage = await preProcessImage(coverImage, options.userId);
            if (finalImage && finalImage !== coverImage) tempBgPath = finalImage;
        }
    }

    // 4. Build Command
    return new Promise(function(resolve, reject) {
        const command = ffmpeg();
        let inputCount = 0;
        let playlistPath = null;
        
        // GLOBAL OPTIONS
        command.inputOptions(['-analyzeduration 20000000', '-probesize 20000000']);
        
        // STREAM SETTINGS
        const FPS = (isStaticMode || isSlideshowMode) ? 20 : 30;
        const BITRATE = (isStaticMode || isSlideshowMode) ? '1500k' : '2500k';

        // --- INPUT CONFIGURATION ---
        
        if (isStaticMode || isSlideshowMode) {
            // >>> STATIC/RADIO MODE <<<
            console.log(`[StreamEngine ${streamId}] Mode: STATIC/RADIO`);

            // INPUT 0: VISUAL
            if (finalImage) {
                // Image loop
                // Cek jika finalImage adalah video (cover bergerak)
                if (finalImage.endsWith('.mp4')) {
                     command.input(finalImage).inputOptions(['-stream_loop', '-1', '-re']);
                } else {
                     command.input(finalImage).inputOptions(['-loop 1', `-framerate ${FPS}`, '-re']);
                }
            } else {
                // Black screen fallback
                command.input(`color=c=black:s=1280x720:r=${FPS}`).inputOptions(['-f lavfi', '-re']);
            }
            inputCount++;

            // INPUT 1: AUDIO
            if (isSlideshowMode) {
                // Silent Audio for slideshow
                // Menggunakan lavfi anullsrc sering error di VPS tertentu, kita gunakan input virtual lain atau 
                // jika user punya file dummy. Untuk amannya kita pakai anullsrc tapi dengan format strict.
                command.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputOptions(['-f lavfi', '-re']);
            } else {
                // Audio Files
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
            
            // Map Video (0) and Audio (1) explicitly
            // Ini kuncinya: kita tidak pakai [v_out], langsung index.
            command.outputOptions(['-map 0:v', '-map 1:a']);
            
            // Filter hanya untuk memastikan format pixel, tanpa label output
            command.complexFilter([
                '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p',
                '[1:a]aresample=44100,aformat=channel_layouts=stereo'
            ]);

        } else {
            // >>> VIDEO MODE (MP4, etc) <<<
            console.log(`[StreamEngine ${streamId}] Mode: VIDEO`);
            
            // Filter only valid video files for playlist
            const videoFiles = files.filter(function(f) { 
                return !audioExts.includes(path.extname(f).toLowerCase()) && !imageExts.includes(path.extname(f).toLowerCase()); 
            });
            
            if (videoFiles.length > 0) {
                if (videoFiles.length === 1) {
                    // SINGLE FILE
                    console.log(`[StreamEngine ${streamId}] Single Video: ${videoFiles[0]}`);
                    const opts = ['-re']; 
                    if (options.loop) opts.push('-stream_loop', '-1');
                    
                    // Explicitly add input and options
                    command.input(videoFiles[0]);
                    command.inputOptions(opts);
                } else {
                    // PLAYLIST
                    playlistPath = createPlaylistFile(videoFiles);
                    console.log(`[StreamEngine ${streamId}] Playlist Video: ${playlistPath}`);
                    const opts = ['-re', '-f', 'concat', '-safe', '0'];
                    if (options.loop) opts.unshift('-stream_loop', '-1');
                    
                    command.input(playlistPath);
                    command.inputOptions(opts);
                }
                inputCount++;
            } else {
                // Fallback (Force first file)
                console.warn(`[StreamEngine ${streamId}] Warning: Video fallback used.`);
                const opts = ['-re'];
                if (options.loop) opts.push('-stream_loop', '-1');
                command.input(files[0]);
                command.inputOptions(opts);
                inputCount++;
            }

            // FILTER & MAPPING
            // Gunakan -vf simple string agar tidak perlu complex filter graph
            let filters = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1';
            
            // Watermark text (optional, but safe)
            // const font = getSystemFontPath();
            // if(font) filters += `,drawtext=text='LiteStream':fontfile='${font}':fontcolor=white:fontsize=24:x=w-tw-20:y=h-th-20:box=1:boxcolor=black@0.5`;
            
            command.outputOptions(`-vf ${filters}`);
            
            // Map Video (0:v) and Audio (0:a)
            // Tanda tanya (?) berarti "ambil audio jika ada, jika tidak abaikan biar gak error"
            command.outputOptions(['-map 0:v', '-map 0:a?']); 
        }

        // --- ENCODING ---
        const encOpts = [
            '-c:v libx264', 
            '-preset ultrafast', 
            '-tune zerolatency', 
            '-profile:v baseline',
            `-b:v ${BITRATE}`, `-maxrate ${BITRATE}`, `-bufsize ${BITRATE}`, 
            `-r ${FPS}`, `-g ${FPS*2}`,
            '-pix_fmt yuv420p', 
            
            // AUDIO ENCODING
            '-c:a aac', 
            '-b:a 128k', 
            '-ar 44100', 
            '-ac 2',
            
            // OUTPUT FORMAT
            '-f flv', 
            '-flvflags no_duration_filesize',
            '-max_muxing_queue_size 9999'
        ];

        // --- OUTPUTS ---
        if (targets.length === 1) {
            command.output(targets[0]).outputOptions(encOpts);
        } else {
            const tee = targets.map(function(t) { return `[f=flv:onfail=ignore]${t}`; }).join('|');
            command.output(tee).outputOptions(encOpts).outputOptions('-f tee');
        }

        // --- EXECUTION ---
        lastProcessedSecond[streamId] = 0;
        
        activeStreams.set(streamId, {
            command: command, 
            userId: options.userId, 
            name: options.title || options.streamName, // Adaptasi field title
            startTime: Date.now(), 
            playlistPath: playlistPath, 
            tempBgPath: tempBgPath,
            config: { inputPaths: inputPaths, destinations: destinations, options: options }, 
            platform: destinations[0].includes('youtube') ? 'YouTube' : 'Custom', // Helper untuk UI
            isManualStop: false
        });

        // Debug logging
        command.on('start', function(cmdLine) {
             console.log(`[StreamEngine ${streamId}] STARTED.`);
             // console.log(`CMD: ${cmdLine}`); // Uncomment for full debug
             if (global.io) {
                 global.io.emit('log', { type: 'start', message: `Stream Started.` });
                 global.io.emit('stream_started', { streamId });
             }
             resolve(streamId);
        });

        command.on('progress', function(p) { trackUsage(p, streamId, options.userId); });
        
        command.on('error', function(err) {
            if (!err.message.includes('SIGKILL')) console.error(`[StreamEngine ${streamId}] Error:`, err.message);
            // Jangan cleanup di sini agar loop restart bisa bekerja jika diimplementasikan
            // handleStreamExit(streamId); 
            // Untuk versi simple, kita cleanup saja
            cleanup(streamId);
        });

        command.on('end', function() {
            console.log(`[StreamEngine ${streamId}] Ended.`);
            cleanup(streamId);
        });

        if (inputCount === 0) {
            reject(new Error("Internal Error: No inputs specified for FFmpeg."));
            return;
        }

        try {
            command.run();
        } catch (e) {
            console.error(`[StreamEngine ${streamId}] CRASH ON RUN:`, e);
            reject(new Error("Engine failed to start: " + e.message));
        }
    });
};

const cleanup = (id) => {
    const s = activeStreams.get(id);
    if (!s) return;
    
    if (s.playlistPath && fs.existsSync(s.playlistPath)) {
        try { fs.unlinkSync(s.playlistPath); } catch(e){}
    }
    if (s.tempBgPath && fs.existsSync(s.tempBgPath)) {
        try { fs.unlinkSync(s.tempBgPath); } catch(e){}
    }
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
    
    if (diff > 5) { // Update db tiap 5 detik durasi video
        lastProcessedSecond[id] = sec;
        db.run("UPDATE users SET usage_seconds = usage_seconds + ? WHERE id = ?", [Math.floor(diff), userId]);
        
        if (global.io) global.io.emit('stats', { 
            streamId: id, 
            duration: p.timemark, 
            bitrate: p.currentKbps ? Math.round(p.currentKbps) + ' kbps' : 'Stable' 
        });
    }
};

const stopStream = async (id) => {
    // Handle object wrapper or direct id
    const realId = (typeof id === 'object') ? id.streamId : id;
    
    const s = activeStreams.get(realId);
    if (s && s.command) {
        s.isManualStop = true;
        try {
            s.command.kill('SIGKILL');
        } catch(e) { console.error("Kill error", e); }
        cleanup(realId);
        return true;
    }
    return false;
};

// Fungsi ini disesuaikan agar mengembalikan Array, bukan Object, supaya cocok dengan server.js
const getActiveStreams = (userId) => {
    const list = [];
    activeStreams.forEach(function(v, k) {
        if (v.userId === userId) {
            list.push({ 
                id: k, 
                name: v.name || 'Stream ' + k, 
                startTime: v.startTime, 
                platform: v.platform || 'Custom'
            });
        }
    });
    return list;
};

const isStreaming = () => activeStreams.size > 0;

module.exports = { startStream, stopStream, getActiveStreams, killZombieProcesses, isStreaming };
