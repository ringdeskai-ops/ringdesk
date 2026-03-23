#!/bin/bash
# AiRingDesk Deploy Script
# Usage: bash deploy.sh [version]
# Example: bash deploy.sh v1.0.0
# Example: bash deploy.sh (deploys latest master)

set -e

APP_DIR="/var/www/vhosts/airingdesk.com/httpdocs"
DB_PATH="$APP_DIR/ringdesk.db"
BACKUP_DIR="/root/backups"
DATE=$(date +%Y%m%d_%H%M%S)

echo "🚀 AiRingDesk Deploy — $(date)"
echo "================================"

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup database
echo "📦 Backing up database..."
cp $DB_PATH $BACKUP_DIR/ringdesk_$DATE.db
echo "✅ Database backed up to $BACKUP_DIR/ringdesk_$DATE.db"

# Backup current app
echo "📦 Backing up app..."
cp $APP_DIR/app.js $BACKUP_DIR/app_$DATE.js
echo "✅ App backed up"

# Pull from GitHub
cd $APP_DIR
echo "⬇️  Pulling from GitHub..."
if [ -n "$1" ]; then
  echo "📌 Deploying version: $1"
  git fetch --tags
  git checkout $1
else
  echo "📌 Deploying latest master"
  git pull origin master
fi

# Install dependencies if package.json changed
echo "📦 Checking dependencies..."
npm install --production 2>/dev/null && echo "✅ Dependencies OK"

# Restart app
echo "🔄 Restarting app..."
pm2 restart airingdesk --update-env
sleep 3

# Check status
STATUS=$(pm2 jlist | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const p=JSON.parse(d).find(p=>p.name==='airingdesk');console.log(p?p.pm2_env.status:'unknown')")
if [ "$STATUS" = "online" ]; then
  echo "✅ App is online!"
else
  echo "❌ App status: $STATUS — check logs with: pm2 logs airingdesk"
fi

echo "================================"
echo "✅ Deploy complete — $(date)"
echo ""
echo "Useful commands:"
echo "  pm2 logs airingdesk     — view logs"
echo "  pm2 status              — check status"
echo "  bash deploy.sh v1.0.0   — rollback to v1.0.0"
