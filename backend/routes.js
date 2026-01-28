
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const ffmpeg = require('fluent-ffmpeg'); // ADDED
const { getVideos, saveVideo, deleteVideo, toggleVideoLock, db } = require('./database');
const { startStream, stopStream, isStreaming, getActiveStreams } = require('./streamEngine');

// Helper: Reset harian jika tanggal berubah, KECUALI paket tipe 'total'
const syncUserUsage = (userId) => {
    return new Promise((resolve) => {
        const today = new Date().toISOString().split('T')[0];
        // Join with plans to get limit_type
        db.get(`SELECT u.last_usage_reset, u.usage_seconds, p.limit_type 
                FROM users u 
                LEFT JOIN plans p ON u.plan_id = p.id 
                WHERE u.id = ?`, [userId], (err, row) => {
            
            if (row) {
                // Logic: Reset hanya jika hari berubah DAN limit_type adalah 'daily'
                // Jika limit_type = 'total', jangan pernah reset usage_seconds
                if (row.limit_type === 'daily' && row.last_usage_reset !== today) {
                    db.run("UPDATE users SET usage_seconds = 0, last_usage_reset = ? WHERE id = ?", [today, userId], () => {
                        resolve(0);
                    });
                } else {
                    // Jika total, atau hari belum berubah, kembalikan usage saat ini
                    resolve(row.usage_seconds);
                }
            } else {
                resolve(0);
            }
        });
    });
};

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: "Unauthorized: Admin only" });
};

const checkStorageQuota = (req, res, next) => {
  const userId = req.session.user.id;
  db.get(`
    SELECT u.storage_used, p.max_storage_mb 
    FROM users u JOIN plans p ON u.plan_id = p.id 
    WHERE u.id = ?`, [userId], (err, row) => {
    if (err) return res.status(500).json({ error: "DB Error" });
    const incomingSize = parseInt(req.headers['content-length'] || 0);
    const usedMB = row.storage_used / (1024 * 1024);
    const incomingMB = incomingSize / (1024 * 1024);
    if (usedMB + incomingMB > row.max_storage_mb) {
      return res.status(400).json({ error: "Storage Penuh!" });
    }
    next();
  });
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, path.join(__dirname, 'uploads')); },
  filename: (req, file, cb) => { cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_')); }
});

// UPDATE: Set explicit limit to 1GB
const upload = multer({ 
    storage,
    limits: { fileSize: 1024 * 1024 * 1024 } 
});

router.get('/plans-public', (req, res) => {
  db.all("SELECT * FROM plans", (err, rows) => res.json(rows));
});

router.get('/landing-content', (req, res) => {
    const keys = ['landing_title', 'landing_desc', 'landing_btn_reg', 'landing_btn_login'];
    const placeholders = keys.map(() => '?').join(',');
    db.all(`SELECT key, value FROM stream_settings WHERE key IN (${placeholders})`, keys, (err, rows) => {
        const settings = {};
        if(rows) rows.forEach(r => settings[r.key] = r.value);
        res.json(settings);
    });
});

router.get('/plans', isAdmin, (req, res) => db.all("SELECT * FROM plans", (err, rows) => res.json(rows)));

router.put('/plans/:id', isAdmin, (req, res) => {
  const { name, max_storage_mb, allowed_types, price_text, features_text, daily_limit_hours } = req.body;
  db.run(`UPDATE plans SET 
          name = ?, max_storage_mb = ?, allowed_types = ?, price_text = ?, features_text = ?, daily_limit_hours = ?
          WHERE id = ?`, 
    [name, max_storage_mb, allowed_types, price_text, features_text, daily_limit_hours, req.params.id], 
    function(err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true });
    }
  );
});

router.get('/users', isAdmin, (req, res) => {
    db.all("SELECT u.id, u.username, u.role, u.storage_used, u.usage_seconds, u.plan_id, p.name as plan_name FROM users u JOIN plans p ON u.plan_id = p.id", (err, rows) => res.json(rows));
});

router.put('/users/:id', isAdmin, (req, res) => {
    const { plan_id } = req.body;
    db.run("UPDATE users SET plan_id = ? WHERE id = ?", [plan_id, req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

router.get('/videos', async (req, res) => res.json(await getVideos(req.session.user.id)));

router.post('/videos/upload', checkStorageQuota, upload.single('video'), async (req, res) => {
  const userId = req.session.user.id;
  if (!req.file) return res.status(400).json({ error: "Pilih file dulu" });
  const file = req.file;
  const ext = path.extname(file.filename).toLowerCase();
  let type = (ext === '.mp3') ? 'audio' : (['.jpg','.png','.jpeg'].includes(ext) ? 'image' : 'video');
  
  // START THUMBNAIL GENERATION
  let thumbnail = null;
  if (type === 'video') {
      const thumbName = `thumb_${path.basename(file.filename, ext)}.png`;
      try {
          await new Promise((resolve) => {
              ffmpeg(file.path)
                .screenshots({
                    timestamps: ['10%'], // Take snapshot at 10% duration
                    filename: thumbName,
                    folder: path.join(__dirname, 'uploads'),
                    size: '320x180'
                })
                .on('end', () => { thumbnail = thumbName; resolve(); })
                .on('error', (e) => { console.error('Thumb Gen Error:', e); resolve(); });
          });
      } catch (e) { console.error('Thumb Gen Exception:', e); }
  }

  const id = await saveVideo({ user_id: userId, filename: file.filename, path: file.path, size: file.size, type, thumbnail });
  db.run("UPDATE users SET storage_used = storage_used + ? WHERE id = ?", [file.size, userId]);
  res.json({ success: true, id, type, thumbnail });
});

router.put('/videos/:id/lock', async (req, res) => {
    try {
        const newState = await toggleVideoLock(req.params.id, req.session.user.id);
        res.json({ success: true, locked: newState });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/videos/:id', async (req, res) => {
  const userId = req.session.user.id;
  db.get("SELECT path, size, is_locked, thumbnail FROM videos WHERE id = ? AND user_id = ?", [req.params.id, userId], (err, row) => {
    if (row) {
      if (row.is_locked) {
          return res.status(403).json({ error: "File terkunci! Buka gembok dulu." });
      }
      if (fs.existsSync(row.path)) fs.unlinkSync(row.path);
      // Delete thumbnail if exists
      if (row.thumbnail) {
          const thumbPath = path.join(__dirname, 'uploads', row.thumbnail);
          if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      }
      db.run("UPDATE users SET storage_used = storage_used - ? WHERE id = ?", [row.size, userId]);
      deleteVideo(req.params.id).then(() => res.json({ success: true }));
    } else res.status(404).json({ error: "File not found" });
  });
});

router.get('/stream/status', async (req, res) => {
    const userId = req.session.user.id;
    const usage = await syncUserUsage(userId);
    const activeStreams = getActiveStreams(userId);
    res.json({ 
        active: activeStreams.length > 0, 
        streams: activeStreams, 
        usage_seconds: usage 
    });
});

router.post('/playlist/start', async (req, res) => {
  const { ids, rtmpUrl, coverImageId, loop, title, description } = req.body;
  const userId = req.session.user.id;

  if (!ids || ids.length === 0) return res.status(400).json({ error: "Pilih minimal 1 media" });
  if (!rtmpUrl) return res.status(400).json({ error: "RTMP URL Kosong." });

  const currentUsage = await syncUserUsage(userId);
  const activeStreams = getActiveStreams(userId);

  db.get(`
    SELECT p.allowed_types, p.daily_limit_hours, p.max_active_streams, p.limit_type
    FROM users u JOIN plans p ON u.plan_id = p.id 
    WHERE u.id = ?`, [userId], (err, plan) => {
    
    // Cek Batasan Waktu
    if (currentUsage >= plan.daily_limit_hours * 3600) {
        const errorMsg = plan.limit_type === 'total' 
            ? `Kuota Trial ${plan.daily_limit_hours} Jam telah habis. Silakan upgrade paket.`
            : `Batas harian (${plan.daily_limit_hours} jam) sudah habis.`;
        return res.status(403).json({ error: errorMsg });
    }

    // Cek Limit Max Active Streams
    if (activeStreams.length >= plan.max_active_streams) {
        return res.status(403).json({ error: `Maksimal ${plan.max_active_streams} stream berjalan sekaligus untuk paket ini.` });
    }

    const placeholders = ids.map(() => '?').join(',');
    db.all(`SELECT * FROM videos WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, userId], async (err, items) => {
      if (!items || items.length === 0) return res.status(404).json({ error: "Media tidak ditemukan" });

      const videoFiles = items.filter(i => i.type === 'video');
      const audioFiles = items.filter(i => i.type === 'audio');
      const imageFiles = items.filter(i => i.type === 'image');

      let playlistPaths = [];
      let finalCoverPath = null;

      if (videoFiles.length > 0) {
        if (!plan.allowed_types.includes('video')) return res.status(403).json({ error: "Hanya Audio yang didukung paket ini." });
        playlistPaths = videoFiles.map(v => v.path);
      } 
      else if (audioFiles.length > 0) {
        playlistPaths = audioFiles.map(a => a.path);
        if (coverImageId) {
            const cov = await new Promise(r => db.get("SELECT path FROM videos WHERE id=?", [coverImageId], (e,row)=>r(row)));
            if(cov) finalCoverPath = cov.path;
        }
        if (!finalCoverPath && imageFiles.length > 0) finalCoverPath = imageFiles[0].path; 
      } 

      try {
          // startStream kini return Promise<streamId>
          const streamId = await startStream(playlistPaths, rtmpUrl, { userId, loop: !!loop, coverImagePath: finalCoverPath, title, description });
          res.json({ success: true, message: `Streaming dimulai.`, streamId });
      } catch (e) { res.status(500).json({ error: "Engine Error: " + e.message }); }
    });
  });
});

router.post('/stream/stop', (req, res) => {
  const { streamId } = req.body;
  if (!streamId) return res.status(400).json({error: "Stream ID diperlukan"});
  
  const success = stopStream(streamId);
  res.json({ success });
});

router.get('/settings', (req, res) => {
    const keys = ['rtmp_url', 'stream_platform', 'stream_key', 'custom_server_url', 'landing_title', 'landing_desc', 'landing_btn_reg', 'landing_btn_login'];
    const placeholders = keys.map(()=>'?').join(',');
    db.all(`SELECT key, value FROM stream_settings WHERE key IN (${placeholders})`, keys, (err, rows) => {
        const settings = {};
        if(rows) rows.forEach(r => settings[r.key] = r.value);
        res.json(settings);
    });
});

router.post('/settings', (req, res) => {
    const stmt = db.prepare("INSERT OR REPLACE INTO stream_settings (key, value) VALUES (?, ?)");
    Object.keys(req.body).forEach(key => stmt.run(key, String(req.body[key] || '')));
    stmt.finalize();
    res.json({ success: true });
});

router.put('/profile', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    const userId = req.session.user.id;
    db.get("SELECT * FROM users WHERE id = ?", [userId], async (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        const match = await bcrypt.compare(currentPassword, user.password_hash);
        if (!match) return res.status(400).json({ error: "Password salah." });
        try {
            let query = "UPDATE users SET username = ?";
            let params = [username];
            if (newPassword && newPassword.length >= 6) {
                const newHash = await bcrypt.hash(newPassword, 10);
                query += ", password_hash = ?";
                params.push(newHash);
            }
            query += " WHERE id = ?";
            params.push(userId);
            db.run(query, params, () => {
                req.session.user.username = username;
                res.json({ success: true, message: "Profil diperbarui." });
            });
        } catch (e) { res.status(500).json({ error: "Server Error" }); }
    });
});

module.exports = router;
