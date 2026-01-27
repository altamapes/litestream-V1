
#!/bin/bash

echo "🚀 Memulai Update LiteStream..."

# 1. Tarik kode terbaru dari GitHub
echo "📥 Mengambil kode terbaru dari GitHub..."
git pull origin main

# 2. Install dependencies (Root & Backend)
echo "📦 Menginstall package..."
npm run install-all

# 3. Pastikan folder uploads tersedia
if [ ! -d "backend/uploads" ]; then
  mkdir -p backend/uploads
  echo "📁 Folder uploads dibuat."
fi

# 4. Restart aplikasi di PM2
echo "🔄 Merestart server via PM2..."
npm run prod

echo "✅ Update Selesai! Dashboard dapat diakses di port 3000."
pm2 status
