#!/bin/bash
set -e
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  SatFocus Blog Automation — Setup"
echo "═══════════════════════════════════════════════════════════════"

BLOG_DIR="/var/www/vhosts/airingdesk.com/httpdocs/satfocus-blog"
AIRINGDESK_DIR="/var/www/vhosts/airingdesk.com/httpdocs"
KEY_PATH="/root/.ssh/satfocus_krystal_rsa"

# Symlink node_modules from AiRingDesk
mkdir -p "$BLOG_DIR/output"
if [ -d "$AIRINGDESK_DIR/node_modules/better-sqlite3" ]; then
  ln -sf "$AIRINGDESK_DIR/node_modules" "$BLOG_DIR/node_modules" 2>/dev/null || true
  echo "✅ Symlinked node_modules from AiRingDesk"
else
  cd "$BLOG_DIR"
  npm init -y > /dev/null 2>&1
  npm install better-sqlite3 @anthropic-ai/sdk uuid
  echo "✅ Installed dependencies"
fi

# Generate SSH key for Krystal
if [ ! -f "$KEY_PATH" ]; then
  ssh-keygen -t rsa -b 4096 -f "$KEY_PATH" -N "" -C "satfocus-blog-auto"
  echo ""
  echo "🔑 SSH key generated. Now run:"
  echo ""
  echo "  ssh-copy-id -i $KEY_PATH.pub aismarts@tajfun-lon.krystal.uk"
  echo ""
  echo "Enter your Krystal password when prompted (one time only)."
else
  echo "✅ SSH key already exists"
fi

# Install cron job
CRON_CMD="cd $BLOG_DIR && /usr/bin/node satfocus-blog-gen.js >> $BLOG_DIR/cron.log 2>&1"
if crontab -l 2>/dev/null | grep -q "satfocus-blog-gen"; then
  echo "✅ Cron job already exists"
else
  (crontab -l 2>/dev/null; echo ""; echo "# SatFocus Blog Auto-Generator (Mon,Tue,Thu,Fri 09:00 UTC)"; echo "0 9 * * 1,2,4,5 $CRON_CMD") | crontab -
  echo "✅ Cron job installed: Mon,Tue,Thu,Fri at 09:00 UTC"
fi

echo ""
echo "✅ Setup complete! Next steps:"
echo "  1. ssh-copy-id -i $KEY_PATH.pub aismarts@tajfun-lon.krystal.uk"
echo "  2. node satfocus-blog-gen.js --preview"
echo ""
