#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# SatFocus Blog v3 — Deployment Script
# Run on AiRingDesk VPS as root
# ═══════════════════════════════════════════════════════════════
set -e
DIR="/var/www/vhosts/airingdesk.com/httpdocs/satfocus-blog"
echo ""
echo "═══ SatFocus Blog v3 — Deploying ═══"

# Backup old script
if [ -f "$DIR/satfocus-blog-gen.js" ]; then
  cp "$DIR/satfocus-blog-gen.js" "$DIR/satfocus-blog-gen.js.bak"
  echo "✅ Backed up old script"
fi

# The new v3 script should already be at $DIR/satfocus-blog-v3.js
if [ ! -f "$DIR/satfocus-blog-v3.js" ]; then
  echo "❌ satfocus-blog-v3.js not found in $DIR"
  echo "   Copy it there first, then re-run."
  exit 1
fi

# Update cron to use v3
CRON_CMD="cd $DIR && /usr/bin/node satfocus-blog-v3.js >> $DIR/cron.log 2>&1"
# Remove old cron entries
crontab -l 2>/dev/null | grep -v "satfocus-blog" > /tmp/crontab.tmp || true
echo "" >> /tmp/crontab.tmp
echo "# SatFocus Blog v3 (Mon,Tue,Thu,Fri 09:00 UTC)" >> /tmp/crontab.tmp
echo "0 9 * * 1,2,4,5 $CRON_CMD" >> /tmp/crontab.tmp
crontab /tmp/crontab.tmp
rm /tmp/crontab.tmp
echo "✅ Cron updated to v3"

echo ""
echo "═══ Deployment complete ═══"
echo ""
echo "Commands:"
echo "  cd $DIR"
echo "  node satfocus-blog-v3.js --list          # View topics"
echo "  node satfocus-blog-v3.js --rewrite        # Rewrite ALL posts (AEO/GEO)"
echo "  node satfocus-blog-v3.js --force           # Generate next post"
echo "  node satfocus-blog-v3.js --regen           # Rebuild HTML only"
echo "  node satfocus-blog-v3.js --preview --force  # Preview without upload"
echo ""
echo "To rewrite existing posts with the new AI-era prompt:"
echo "  node satfocus-blog-v3.js --rewrite"
echo ""
