
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// Helper untuk mengubah command SQLite menjadi Promise
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
    });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const ensureColumn = async (tableName, columnName, columnDef) => {
    try {
        const columns = await dbAll(`PRAGMA table_info(${tableName})`);
        const exists = columns.some(c => c.name === columnName);
        if (!exists) {
            console.log(`Adding column ${columnName} to ${tableName}...`);
            await dbRun(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
        }
    } catch (e) {
        console.error(`Error ensuring column ${columnName}:`, e.message);
    }
};

const initDB = async () => {
    try {
        await dbRun("PRAGMA foreign_keys = ON");

        // 1. Buat Tabel Plans
        await dbRun(`CREATE TABLE IF NOT EXISTS plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            name TEXT UNIQUE, 
            max_storage_mb INTEGER, 
            allowed_types TEXT, 
            max_active_streams INTEGER,
            price_text TEXT,
            features_text TEXT,
            daily_limit_hours INTEGER DEFAULT 24,
            limit_type TEXT DEFAULT 'daily'
        )`);

        // Migrasi Kolom Plans (Pastikan selesai sebelum seeding)
        await ensureColumn('plans', 'price_text', 'TEXT');
        await ensureColumn('plans', 'features_text', 'TEXT');
        await ensureColumn('plans', 'daily_limit_hours', 'INTEGER DEFAULT 24');
        await ensureColumn('plans', 'limit_type', "TEXT DEFAULT 'daily'");

        // 2. Buat Tabel Users
        await dbRun(`CREATE TABLE IF NOT EXISTS users (
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

        await ensureColumn('users', 'usage_seconds', 'INTEGER DEFAULT 0');
        await ensureColumn('users', 'last_usage_reset', 'TEXT');

        // 3. Tabel Videos
        await dbRun(`CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            user_id INTEGER, 
            filename TEXT NOT NULL, 
            path TEXT NOT NULL, 
            size INTEGER, 
            type TEXT DEFAULT 'video', 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, 
            is_locked INTEGER DEFAULT 0, 
            thumbnail TEXT
        )`);
        
        await ensureColumn('videos', 'is_locked', 'INTEGER DEFAULT 0');
        await ensureColumn('videos', 'thumbnail', 'TEXT');

        await dbRun(`CREATE TABLE IF NOT EXISTS stream_settings (key TEXT PRIMARY KEY, value TEXT)`);

        // 4. Seeding Data Plans (Aman karena kolom sudah pasti ada)
        const plans = [
            [1, 'Paket Free Trial', 2048, 'video,audio', 3, 'Gratis', 'Max 720p, Total 5 Jam (Trial Habis = Stop), Multi-Stream Ready', 5, 'total'],
            [2, 'Paket Pro (Creator)', 10240, 'video,audio', 5, 'Rp 100.000', 'Max 1080p, 24 Jam Non-stop, Multi-Target', 24, 'daily'],
            [3, 'Paket Radio 24/7', 5120, 'audio', 3, 'Rp 75.000', 'Khusus Radio MP3, Visualisasi Cover, Shuffle Playlist', 24, 'daily'],
            [4, 'Paket Sultan (Private)', 25600, 'video,audio', 10, 'Rp 250.000', 'Dedicated VPS, Unlimited Platform, Setup Dibantu Full', 24, 'daily']
        ];
        
        for (const p of plans) {
            await dbRun(`INSERT OR IGNORE INTO plans (id, name, max_storage_mb, allowed_types, max_active_streams, price_text, features_text, daily_limit_hours, limit_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, p);
            
            // Force update untuk memastikan data lama terupdate dengan skema baru
            await dbRun(`UPDATE plans SET max_active_streams = ?, daily_limit_hours = ?, limit_type = ?, features_text = ? WHERE id = ?`, 
                   [p[4], p[7], p[8], p[6], p[0]]);
        }

        // Seeding Settings
        const defaultSettings = [
            ['landing_title', 'Broadcast Anywhere <br> from <span class="text-indigo-400">Any VPS.</span>'],
            ['landing_desc', 'Server streaming paling ringan di dunia. Dirancang khusus untuk VPS 1GB RAM.'],
            ['landing_btn_reg', 'Daftar Sekarang'],
            ['landing_btn_login', 'Login Member']
        ];
        for (const s of defaultSettings) {
            await dbRun(`INSERT OR IGNORE INTO stream_settings (key, value) VALUES (?, ?)`, s);
        }

        // Seeding Admin
        const adminUser = 'admin';
        const row = await dbGet("SELECT id FROM users WHERE username = ?", [adminUser]);
        if (!row) {
            const adminPass = 'admin123';
            const hash = bcrypt.hashSync(adminPass, 10);
            await dbRun(`INSERT INTO users (username, password_hash, role, plan_id) VALUES (?, ?, 'admin', 4)`, [adminUser, hash]);
        }

        console.log("Database initialized successfully.");

    } catch (err) {
        console.error("Database Initialization Error:", err);
        // Jangan throw error agar server tidak crash total, tapi log errornya
    }
};

const getVideos = (userId) => new Promise((res, rej) => db.all("SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC", [userId], (err, rows) => err ? rej(err) : res(rows)));
const saveVideo = (data) => new Promise((res, rej) => db.run("INSERT INTO videos (user_id, filename, path, size, type, thumbnail) VALUES (?, ?, ?, ?, ?, ?)", [data.user_id, data.filename, data.path, data.size, data.type || 'video', data.thumbnail], function(err) { err ? rej(err) : res(this.lastID); }));
const deleteVideo = (id) => new Promise((res, rej) => db.run("DELETE FROM videos WHERE id = ?", [id], (err) => err ? rej(err) : res()));

const toggleVideoLock = (id, userId) => new Promise((res, rej) => {
    db.get("SELECT is_locked FROM videos WHERE id = ? AND user_id = ?", [id, userId], (err, row) => {
        if (err || !row) return rej(new Error('File not found'));
        const newVal = row.is_locked ? 0 : 1;
        db.run("UPDATE videos SET is_locked = ? WHERE id = ?", [newVal, id], (err) => err ? rej(err) : res(newVal));
    });
});

module.exports = { initDB, getVideos, saveVideo, deleteVideo, toggleVideoLock, db, dbPath };
