# Deploy — Marketing Platform

Lightweight SSH deploy guide for the marketing platform changes on branch
`claude/airingdesk-marketing-platform-22FR8`.

No new npm dependencies. No manual SQL. New tables are auto-created on boot.

---

## 1. SSH into your VPS

```bash
ssh user@185.249.74.165
cd /path/to/ringdesk     # whatever directory holds server.js
```

## 2. Pull the branch

```bash
git fetch origin claude/airingdesk-marketing-platform-22FR8
git checkout claude/airingdesk-marketing-platform-22FR8
```

If you want to merge it into your main deploy branch instead:

```bash
git checkout main
git merge --no-ff origin/claude/airingdesk-marketing-platform-22FR8
```

## 3. Restart `server.js`

Pick the command that matches how you currently run the server.

### Option A — pm2 (most common)

```bash
pm2 restart server            # or whatever process name you used
pm2 logs server --lines 30    # verify startup, no errors
```

### Option B — systemd

```bash
sudo systemctl restart ringdesk
sudo systemctl status ringdesk
sudo journalctl -u ringdesk -n 50 --no-pager
```

### Option C — screen / tmux

```bash
# attach to existing session
screen -r ringdesk            # or: tmux attach -t ringdesk
# Ctrl+C to stop, then re-run:
node server.js
# detach: Ctrl+A then D  (screen)  |  Ctrl+B then D  (tmux)
```

### Option D — Docker

```bash
docker compose pull           # if pulling from a registry
docker compose up -d --build  # rebuild + restart container
docker compose logs -f --tail=50 app
```

### Not sure which you use?

```bash
ps -ef | grep -E "node.*server.js" | grep -v grep
pm2 list 2>/dev/null || true
systemctl list-units --type=service | grep -i ring || true
```

## 4. Verify it's live

From your iMac terminal (or the VPS itself):

```bash
curl https://api.ringdesk.io/api/marketing/health
# → {"status":"ok","leads":0,"subscribers":0,"events_24h":0}

curl https://api.ringdesk.io/api/marketing/track.js | head -5
# → should print the tracking JS
```

## 5. Install the tracking snippet on AiRingDesk.com

Add this to the `<head>` of every page (or the global template / layout file):

```html
<script src="https://api.ringdesk.io/api/marketing/track.js" async></script>
```

Then tag any existing contact / demo form with `data-rd-lead`:

```html
<form data-rd-lead data-rd-thanks="We'll be in touch within 24 hours!">
  <input name="name" placeholder="Your name" required />
  <input name="email" type="email" placeholder="Email" required />
  <input name="business" placeholder="Business name" />
  <textarea name="message" placeholder="How can we help?"></textarea>
  <button type="submit">Get a demo</button>
</form>
```

Newsletter signup (only the `email` field is required):

```html
<form data-rd-subscribe>
  <input name="email" type="email" placeholder="Your email" required />
  <button type="submit">Subscribe</button>
</form>
```

The **Marketing → Install** tab in the Platform dashboard also shows these
snippets with copy-to-clipboard buttons.

## 6. Open the Marketing dashboard

Log in to `https://app.ringdesk.io` as a super-admin / admin user. You'll see a
new **📣 Marketing** tab in the sidebar with four sub-tabs:

- **Overview** — KPIs, 30-day lead chart, pipeline, top sources & pages
- **Leads** — inbox with filters, search, status pipeline, notes
- **Subscribers** — newsletter list + CSV export
- **Install** — the snippets you just deployed

## Rollback (if something breaks)

```bash
git checkout main       # or whatever your previous deploy branch was
pm2 restart server      # or the equivalent for your setup
```

The new tables (`marketing_leads`, `marketing_subscribers`, `marketing_events`)
are additive — they do **not** touch existing tables. Leaving them in place is
safe; they just won't be written to.

If you want to drop the marketing data entirely:

```bash
sqlite3 ringdesk.db <<SQL
DROP TABLE IF EXISTS marketing_leads;
DROP TABLE IF EXISTS marketing_subscribers;
DROP TABLE IF EXISTS marketing_events;
SQL
```

## Environment variables

No new required env vars. The tracking snippet uses `SERVER_URL` (already in
`.env.example`) to point forms at the API. If `SERVER_URL` is unset, the
snippet derives the origin from its own `<script src>` URL as a fallback.

## What got added

- **3 new SQLite tables**: `marketing_leads`, `marketing_subscribers`, `marketing_events` (+ 4 indexes)
- **9 new API endpoints**: 4 public (leads, subscribe, track, track.js, unsubscribe) + 5 admin (list/update/delete leads, list subscribers, export CSV, stats, health)
- **New Marketing tab** in `Platform.jsx` (visible to superadmin + admin roles)
- **Tracking snippet** served from `/api/marketing/track.js`
- **Rate limiting** on public endpoints (per IP, sliding 1-min window)
- **Zero new npm dependencies**
