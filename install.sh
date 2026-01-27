
#!/bin/bash
set -e

echo "🚀 LiteStream VPS Auto-Installer"
echo "================================="

# 1. Update System
echo "📦 Updating System Repositories..."
sudo apt-get update && sudo apt-get upgrade -y

# 2. Install FFmpeg & Tools
echo "🎥 Installing FFmpeg & Git..."
sudo apt-get install -y ffmpeg git curl unzip

# 3. Install Node.js v20 (LTS)
echo "🟢 Installing Node.js v20..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "   Node.js already installed."
fi

# 4. Install PM2
echo "⚡ Installing PM2 Process Manager..."
sudo npm install -g pm2

# 5. Install Project Dependencies
echo "📚 Installing Project Dependencies..."
npm run install-all

# 6. Create Uploads Directory
mkdir -p backend/uploads

# 7. Start Application
echo "🔥 Starting LiteStream..."
npm run prod

# 8. Setup Startup Hook
echo "⚙️ Configuring PM2 Startup..."
pm2 save
pm2 startup | tail -n 1 > startup_script.sh
chmod +x startup_script.sh
./startup_script.sh
rm startup_script.sh

echo "================================="
echo "✅ INSTALLATION COMPLETE!"
echo "   Access Dashboard at: http://$(curl -s ifconfig.me):3000"
echo "================================="
