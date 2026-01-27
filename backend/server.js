
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const dotenv = require('dotenv');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const { initDB, db } = require('./database');

dotenv.config();

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

global.io = io;

// INCREASED LIMITS HERE
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: __dirname }),
  secret: 'litestream_vps_super_secret_saas',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const isAuthenticated = (req, res, next) => {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  const query = `
    SELECT u.*, p.name as plan_name, p.max_storage_mb, p.allowed_types 
    FROM users u 
    LEFT JOIN plans p ON u.plan_id = p.id 
    WHERE u.username = ?`;

  db.get(query, [username], async (err, user) => {
    if (err) return res.status(500).json({ success: false, error: 'DB Error' });
    if (!user) return res.status(401).json({ success: false, error: 'User tidak ditemukan' });

    try {
      const match = await bcrypt.compare(password, user.password_hash);
      if (match) {
        // Logika Fallback: Jika plan tidak ditemukan (null), berikan default Free Trial
        const finalPlanName = user.plan_name || 'Standard Plan';
        const finalMaxStorage = user.max_storage_mb || 500;
        const finalAllowedTypes = user.allowed_types || 'audio';

        req.session.user = { 
          id: user.id, 
          username: user.username, 
          role: user.role,
          plan_id: user.plan_id || 1,
          plan_name: finalPlanName,
          max_storage_mb: finalMaxStorage,
          allowed_types: finalAllowedTypes
        };

        return req.session.save(() => {
          res.json({ success: true });
        });
      }
    } catch (e) {}
    
    res.status(401).json({ success: false, error: 'Password salah' });
  });
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.run("INSERT INTO users (username, password_hash, role, plan_id) VALUES (?, ?, ?, ?)", [username, hash, 'user', 1], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'User sudah ada' });
    res.json({ success: true, message: 'Registrasi Berhasil' });
  });
});

app.get('/api/check-auth', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  
  db.get("SELECT storage_used, plan_id FROM users WHERE id = ?", [req.session.user.id], (err, row) => {
    if (row) {
      db.get("SELECT name as plan_name, max_storage_mb, allowed_types FROM plans WHERE id = ?", [row.plan_id], (err, p) => {
        const fullUser = { 
          ...req.session.user, 
          storage_used: row.storage_used, 
          plan_name: p ? p.plan_name : req.session.user.plan_name,
          max_storage_mb: p ? p.max_storage_mb : req.session.user.max_storage_mb,
          allowed_types: p ? p.allowed_types : req.session.user.allowed_types
        };
        res.json({ authenticated: true, user: fullUser });
      });
    } else {
        res.json({ authenticated: false });
    }
  });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

const routes = require('./routes');
// UPDATE: Whitelist '/landing-content'
app.use('/api', (req, res, next) => {
  if (['/login', '/register', '/check-auth', '/plans-public', '/landing-content'].includes(req.path)) return next();
  return isAuthenticated(req, res, next);
}, routes);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));
app.use(express.static(path.join(__dirname, '../')));

initDB().then(() => {
  server.listen(3000, '0.0.0.0', () => console.log("LITESTREAM READY: Port 3000"));
});
