
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

const initDB = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("PRAGMA foreign_keys = ON");

      // 1. Buat Tabel Plans dengan kolom daily_limit_hours
      db.run(`CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT UNIQUE, 
        max_storage_mb INTEGER, 
        allowed_types TEXT, 
        max_active_streams INTEGER,
        price_text TEXT,
        features_text TEXT,
        daily_limit_hours INTEGER DEFAULT 24
      )`);

      // Migrasi kolom baru jika belum ada
      db.all("PRAGMA table_info(plans)", (err, columns) => {
        if (err || !columns) return;
        const hasPrice = columns.some(c => c.name === 'price_text');
        const hasFeatures = columns.some(c => c.name === 'features_text');
        const hasLimit = columns.some(c => c.name === 'daily_limit_hours');
        
        if (!hasPrice) db.run("ALTER TABLE plans ADD COLUMN price_text TEXT");
        if (!hasFeatures) db.run("ALTER TABLE plans ADD COLUMN features_text TEXT");
        if (!hasLimit) db.run("ALTER TABLE plans ADD COLUMN daily_limit_hours INTEGER DEFAULT 24");
      });

      // 2. Buat Tabel Users dengan kolom tracking penggunaan waktu
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        password_hash TEXT, 
        role TEXT DEFAULT 'user',
        plan_id INTEGER DEFAULT 1,
        storage_used INTEGER DEFAULT 0,
        usage_seconds INTEGER DEFAULT 0,
        last_usage_reset TEXT,
        FOREIGN KEY(plan_id) REFERENCES plans(id)
      )`);

      db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err || !columns) return;
        const hasUsage = columns.some(c => c.name === 'usage_seconds');
        const hasReset = columns.some(c => c.name === 'last_usage_reset');
        if (!hasUsage) db.run("ALTER TABLE users ADD COLUMN usage_seconds INTEGER DEFAULT 0");
        if (!hasReset) db.run("ALTER TABLE users ADD COLUMN last_usage_reset TEXT");
      });

      db.run(`CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, filename TEXT NOT NULL, path TEXT NOT NULL, size INTEGER, type TEXT DEFAULT 'video', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS stream_settings (key TEXT PRIMARY KEY, value TEXT)`);

      // 3. Seeding Data Plans (UPDATE: ID 1 allow 3 streams)
      const plans = [
        [1, 'Paket Free Trial', 2048, 'video,audio', 3, 'Gratis', 'Max 720p, Batasan 5 Jam/hari, Multi-Stream Ready', 5],
        [2, 'Paket Pro (Creator)', 10240, 'video,audio', 5, 'Rp 100.000', 'Max 1080p, 24 Jam Non-stop, Multi-Target', 24],
        [3, 'Paket Radio 24/7', 5120, 'audio', 3, 'Rp 75.000', 'Khusus Radio MP3, Visualisasi Cover, Shuffle Playlist', 24],
        [4, 'Paket Sultan (Private)', 25600, 'video,audio', 10, 'Rp 250.000', 'Dedicated VPS, Unlimited Platform, Setup Dibantu Full', 24]
      ];
      
      plans.forEach(p => {
        db.run(`INSERT OR IGNORE INTO plans (id, name, max_storage_mb, allowed_types, max_active_streams, price_text, features_text, daily_limit_hours) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, p);
        // Force update limits to ensure existing DB gets new values
        db.run(`UPDATE plans SET max_active_streams = ?, daily_limit_hours = ? WHERE id = ?`, [p[4], p[7], p[0]]);
      });

      // Seeding Default Settings
      const defaultSettings = [
        ['landing_title', 'Broadcast Anywhere <br> from <span class="text-indigo-400">Any VPS.</span>'],
        ['landing_desc', 'Server streaming paling ringan di dunia. Dirancang khusus untuk VPS 1GB RAM.'],
        ['landing_btn_reg', 'Daftar Sekarang'],
        ['landing_btn_login', 'Login Member']
      ];
      defaultSettings.forEach(s => db.run(`INSERT OR IGNORE INTO stream_settings (key, value) VALUES (?, ?)`, s));

      // Seeding Admin
      const adminUser = 'admin';
      const adminPass = 'admin123';
      const hash = bcrypt.hashSync(adminPass, 10);
      db.get("SELECT id FROM users WHERE username = ?", [adminUser], (err, row) => {
        if (!row) {
          db.run(`INSERT INTO users (username, password_hash, role, plan_id) VALUES (?, ?, 'admin', 4)`, [adminUser, hash]);
        }
        resolve();
      });
    });
  });
};

const getVideos = (userId) => new Promise((res, rej) => db.all("SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC", [userId], (err, rows) => err ? rej(err) : res(rows)));
const saveVideo = (data) => new Promise((res, rej) => db.run("INSERT INTO videos (user_id, filename, path, size, type) VALUES (?, ?, ?, ?, ?)", [data.user_id, data.filename, data.path, data.size, data.type || 'video'], function(err) { err ? rej(err) : res(this.lastID); }));
const deleteVideo = (id) => new Promise((res, rej) => db.run("DELETE FROM videos WHERE id = ?", [id], (err) => err ? rej(err) : res()));

module.exports = { initDB, getVideos, saveVideo, deleteVideo, db, dbPath };
