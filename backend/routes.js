
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs'); 
const { getVideos, saveVideo, deleteVideo, db } = require('./database');
const { startStream, stopStream, isStreaming } = require('./streamEngine');

// Helper: Reset harian jika tanggal berubah
const syncUserUsage = (userId) => {
    return new Promise((resolve) => {
        const today = new Date().toISOString().split('T')[0];
        db.get("SELECT last_usage_reset, usage_seconds FROM users WHERE id = ?", [userId], (err, row) => {
            if (row && row.last_usage_reset !== today) {
                db.run("UPDATE users SET usage_seconds = 0, last_usage_reset = ? WHERE id = ?", [today, userId], () => {
                    resolve(0);
                });
            } else {
                resolve(row ? row.usage_seconds : 0);
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
const upload = multer({ storage });

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
  const id = await saveVideo({ user_id: userId, filename: file.filename, path: file.path, size: file.size, type });
  db.run("UPDATE users SET storage_used = storage_used + ? WHERE id = ?", [file.size, userId]);
  res.json({ success: true, id, type });
});

router.delete('/videos/:id', async (req, res) => {
  const userId = req.session.user.id;
  db.get("SELECT path, size FROM videos WHERE id = ? AND user_id = ?", [req.params.id, userId], (err, row) => {
    if (row) {
      if (fs.existsSync(row.path)) fs.unlinkSync(row.path);
      db.run("UPDATE users SET storage_used = storage_used - ? WHERE id = ?", [row.size, userId]);
      deleteVideo(req.params.id).then(() => res.json({ success: true }));
    } else res.status(404).json({ error: "File not found" });
  });
});

router.get('/stream/status', async (req, res) => {
    const usage = await syncUserUsage(req.session.user.id);
    res.json({ active: isStreaming(), usage_seconds: usage });
});

router.post('/playlist/start', async (req, res) => {
  const { ids, rtmpUrl, coverImageId, loop } = req.body;
  const userId = req.session.user.id;

  if (!ids || ids.length === 0) return res.status(400).json({ error: "Pilih minimal 1 media" });
  if (!rtmpUrl) return res.status(400).json({ error: "RTMP URL Kosong." });

  const currentUsage = await syncUserUsage(userId);

  db.get(`
    SELECT p.allowed_types, p.daily_limit_hours 
    FROM users u JOIN plans p ON u.plan_id = p.id 
    WHERE u.id = ?`, [userId], (err, plan) => {
    
    // Cek Batasan Waktu
    if (currentUsage >= plan.daily_limit_hours * 3600) {
        return res.status(403).json({ error: `Batas waktu harian (${plan.daily_limit_hours} jam) sudah habis.` });
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
          startStream(playlistPaths, rtmpUrl, { userId, loop: !!loop, coverImagePath: finalCoverPath });
          res.json({ success: true, message: `Streaming dimulai.` });
      } catch (e) { res.status(500).json({ error: "Engine Error: " + e.message }); }
    });
  });
});

router.post('/stream/stop', (req, res) => {
  const success = stopStream();
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
