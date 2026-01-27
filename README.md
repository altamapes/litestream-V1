
# LiteStream VPS Dashboard

Aplikasi streaming ringan untuk VPS spesifikasi rendah (1 Core, 1GB RAM).

## 🔄 Alur Kerja Pengembangan (Workflow)

Ikuti alur ini agar aplikasi Anda aman dan mudah di-update:

1.  **AI Studio (Coding)**
    *   Minta fitur baru atau perbaikan bug di sini.
    *   Copy kode yang diberikan AI.

2.  **GitHub (Penyimpanan)**
    *   Paste kode ke file di komputer/repo GitHub Anda.
    *   Lakukan Commit & Push:
        ```bash
        git add .
        git commit -m "Update fitur X"
        git push origin main
        ```

3.  **VPS (Production)**
    *   Masuk ke VPS, lalu jalankan perintah update otomatis:
        ```bash
        ./deploy.sh
        ```

---

## ⚠️ SOLUSI ERROR "Refused to Connect" / "Module Not Found"

Jika Anda melihat error `Cannot find module`, jalankan perintah ini di terminal VPS Anda:

```bash
# 1. Masuk ke folder backend
cd ~/litestream/backend

# 2. Hapus sisa instalasi yang rusak (jika ada)
rm -rf node_modules package-lock.json

# 3. Install ulang semua dependency secara bersih
npm install

# 4. Restart aplikasi menggunakan PM2
pm2 restart litestream || pm2 start server.js --name "litestream"
```

## Persiapan Awal di VPS
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install ffmpeg -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install pm2 -g
```

## Tips Troubleshooting
- **Cek Port**: `sudo ss -tulpn | grep :3000`. Jika tidak ada, berarti server belum jalan.
- **Cek Log Real-time**: `pm2 logs litestream`. Ini akan menunjukkan jika ada error seperti password salah atau database terkunci.
- **Firewall**: Jika server sudah jalan tapi tidak bisa diakses, buka port: `sudo ufw allow 3000/tcp`.

## Fitur Utama
- **Ultra-Low CPU**: Menggunakan mode `-c copy` untuk video.
- **Audio-to-Video Engine**: Streaming MP3 dengan background gambar (preset ultrafast).
- **SQLite Database**: Ringan & tanpa setup rumit.
