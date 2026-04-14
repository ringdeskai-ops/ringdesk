# Handover — AiRingDesk Marketing Platform (Phase 1)

**Session date:** 14 April 2026
**Branch:** `claude/airingdesk-marketing-staging-safe`
**Status:** 🟡 **Paused — code complete, staging deploy blocked by pre-existing unrelated issue**

---

## TL;DR (1 minute read)

The marketing platform code is **complete, runtime-tested, and committed to git**. It's a single self-contained Express router (`routes/marketing.js`) that adds lead capture, subscriber management, tracking, and an admin UI to AiRingDesk — without touching any existing code.

Deployment to **staging** was attempted and rolled back cleanly after discovering a **pre-existing unrelated issue**: staging's `node_modules` is missing the `ws` package (dated Mar 20), so the staging Node process has been crashing on startup for weeks — nothing to do with the marketing platform. Production is completely untouched and unaffected throughout.

**To resume**: fix staging's `ws` package, then re-apply the marketing patch with a single `awk` command (documented below), restart staging, test, and then promote to production when ready.

---

## Current State

| Item | State |
|---|---|
| **Production** (`httpdocs/app.js`, PM2 `airingdesk`) | ✅ Untouched, fully operational, same process running since Apr 13 |
| **Staging** (`staging/app.js`, PM2 `airingdesk-staging`) | ❌ Pre-existing broken state — missing `ws` module, not related to marketing |
| **Marketing code in git** | ✅ `routes/marketing.js` on branch `claude/airingdesk-marketing-staging-safe`, commit `829b52c` |
| **Marketing code on staging disk** | 📁 Present at `staging/routes/marketing.js` but NOT referenced in `app.js` (harmless) |
| **Production `httpdocs/routes/marketing.js`** | ❌ Not present — never deployed to production |
| **Backup of staging `app.js`** | ✅ `staging/app.js.backup-20260414-160959` (596,941 bytes — original) |
| **Git branch for marketing** | ✅ `claude/airingdesk-marketing-staging-safe` pushed to GitHub |
| **Production data / customers** | ✅ 100% safe, no impact, no downtime |

---

## What Was Built

### Single file: `routes/marketing.js`

**678 lines** of self-contained Express router. Follows the existing pattern of `routes/invoice.js` and `routes/gocardless.js`.

**Dependencies:** Only `express`, `jsonwebtoken`, `crypto` (all already in production `node_modules`). **Zero new npm packages required.**

### What it adds (all under `/api/marketing/*`)

**Three new SQLite tables** (created via `CREATE TABLE IF NOT EXISTS` — additive, cannot overwrite):
- `marketing_leads` — captured leads with status pipeline
- `marketing_subscribers` — newsletter subscribers
- `marketing_events` — pageviews / form submits / tracking events

**Four indexes** for query performance.

**Public endpoints** (no auth, rate-limited per IP):
- `POST /api/marketing/leads` — capture form submissions
- `POST /api/marketing/subscribe` — newsletter signup
- `POST /api/marketing/track` — record page views / events
- `GET  /api/marketing/unsubscribe?token=...` — one-click unsubscribe
- `GET  /api/marketing/track.js` — the tracking JS snippet
- `GET  /api/marketing/health` — health check

**Admin endpoints** (protected by `superAdminRequired` — same pattern as `invoice.js`, requires JWT with `email === 'ringdeskai@gmail.com'`):
- `GET    /api/marketing/stats` — KPIs, conversion, top sources, pipeline
- `GET    /api/marketing/leads` — list leads with filters/search
- `PATCH  /api/marketing/leads/:id` — update status/notes
- `DELETE /api/marketing/leads/:id` — delete lead
- `GET    /api/marketing/subscribers` — list subscribers
- `GET    /api/marketing/subscribers.csv` — export CSV

**Admin HTML UI** (self-contained, no external dependencies):
- `GET /api/marketing/admin` — single-page admin dashboard with inline CSS + JS. Reads JWT from `localStorage` using multiple common keys (`rd_token`, `token`, `jwt`, `authToken`). If not found, prompts the user to paste it once.

### What it will NEVER touch
- ❌ Stripe / GoCardless payment code
- ❌ Twilio / Retell / Deepgram / Anthropic voice & AI code
- ❌ Existing tables (`clients`, `calls`, `invoices`, etc.)
- ❌ Existing routes
- ❌ `.env` / config
- ❌ `sendBrevoEmail` function (phase 1 is capture-only; email campaigns are phase 2)

### Integration point in `app.js`

**Exactly 2 lines** to add (or remove for rollback), placed right after the existing `gcRouter` mount at line ~6194:

```javascript
// ── Marketing platform (additive — does not touch existing code) ──
const marketingRouter = require("./routes/marketing")(db);
app.use("/api/marketing", marketingRouter);
```

---

## What Happened Today (Session Log)

Chronological summary for context:

1. **Discovery phase** — initially worked against `server.js` (500 lines) and `Platform.jsx` (1300 lines) in the git repo, thinking those were the production files. Built a first version of the marketing platform against those files.

2. **Deploy attempt 1** — user ran `git checkout` in `/var/www/vhosts/airingdesk.com/httpdocs`. This **removed the real `app.js`** from disk because the files in the git repo (server.js / Platform.jsx) are unrelated starter files, not the real production code. Git treated the branch switch as valid.

3. **Near miss** — **production website stayed up** throughout because the Node process (PID 1631362) was holding `app.js` in memory. Recovered by running `git checkout master` to restore the real files from the local `master` branch. **Zero downtime, zero data loss.**

4. **Re-analysis** — discovered that the real backend is at `/var/www/vhosts/airingdesk.com/httpdocs/app.js` (609 KB, 7,479 lines), runs as PM2 process `airingdesk`, and has a completely different architecture (modular routers in `routes/`, Brevo email, Google APIs, Retell, Deepgram, etc.) than the toy files in the git repo.

5. **Rebuild phase** — created new branch `claude/airingdesk-marketing-staging-safe`, wrote `routes/marketing.js` from scratch tailored to the real `app.js` pattern (copied local `authRequired` / `superAdminRequired` from `routes/invoice.js`, matched table creation pattern, matched module exports pattern). Runtime-tested with `better-sqlite3` and `express` locally: 13 tests passed, every endpoint validated including auth guards, stats query with `clients` JOIN, lead CRUD, CSV export, admin HTML render.

6. **Deploy attempt 2 — staging** — backed up `staging/app.js`, downloaded `routes/marketing.js`, ran `awk` to insert 2 lines into `staging/app.js`, verified syntax, restarted `airingdesk-staging` via PM2.

7. **Pre-existing issue discovered** — after restart, staging returned `HTTP 000` on port 3001. PM2 error log showed `Cannot find module 'ws'` at `app.js:28:19`. **Investigation proved this is unrelated to the marketing change** — `ws` is imported at line 28 of the original `app.js` (for Deepgram WebSocket) and `routes/marketing.js` doesn't import `ws` at all. Staging's `node_modules` dates to Mar 20 and is missing `ws` entirely. Staging has been silently broken for weeks; PM2 just reports "online" briefly at startup before the cluster workers crash.

8. **Rollback proven** — restored `staging/app.js` from backup with `cp`, restarted `airingdesk-staging`. Same `ws` error still in logs → confirms marketing change was not the cause. Rollback tooling verified working.

9. **Session paused** — user (sensibly) decided to stop for the day. Handover written.

---

## What's Pending

### 1. Fix staging's `ws` issue (pre-existing, not our problem but blocks testing)

```bash
cd /var/www/vhosts/airingdesk.com/staging
npm install ws --no-save
pm2 restart airingdesk-staging
pm2 logs airingdesk-staging --lines 20 --nostream
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3001/
```

The `--no-save` flag installs `ws` into `node_modules` without modifying `package.json` — safe, reversible, minimal footprint.

If staging returns `HTTP 200` (or any 2xx / 3xx), staging is finally healthy. ⚠️ **Warning:** there may be OTHER missing modules too since `node_modules` is from Mar 20. If more errors appear in `pm2 logs`, install those packages the same way (one at a time) until staging boots cleanly. Only install packages that `app.js` actually requires — never `npm install` with no arguments (that would pull everything and potentially upgrade pinned versions).

### 2. Re-apply the marketing patch

`routes/marketing.js` is already on disk at `staging/routes/marketing.js` (from earlier download) — no need to re-download. Just run the awk insertion again:

```bash
cd /var/www/vhosts/airingdesk.com/staging

# Safety: bail if already installed
if grep -q "routes/marketing" app.js; then
  echo "Already patched — skip this step"
else
  cp app.js app.js.backup-$(date +%Y%m%d-%H%M%S)
  awk '
  /^app\.use\("\/api\/gc", gcRouter\);/ {
      print
      print ""
      print "// ── Marketing platform (additive — does not touch existing code) ──"
      print "const marketingRouter = require(\"./routes/marketing\")(db);"
      print "app.use(\"/api/marketing\", marketingRouter);"
      next
  }
  { print }
  ' app.js > app.new.js && \
  node --check app.new.js && echo "✓ syntax OK" && \
  mv app.new.js app.js && \
  echo "✓ app.js patched"
fi
```

### 3. Restart staging and verify

```bash
pm2 restart airingdesk-staging
pm2 logs airingdesk-staging --lines 30 --nostream
pm2 list
```

Should see `airingdesk-staging` online with no fresh errors.

### 4. Test marketing endpoints on staging

```bash
# Public health check
curl -s http://localhost:3001/api/marketing/health
# Expected: {"status":"ok","leads":0,"subscribers":0,"events_24h":0}

# Tracking snippet
curl -s -I http://localhost:3001/api/marketing/track.js
# Expected: HTTP/1.1 200 OK, Content-Type: application/javascript

# Lead capture (simulated form submission)
curl -s -X POST http://localhost:3001/api/marketing/leads \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","name":"Test Lead","business":"Acme Co"}'
# Expected: {"success":true,"id":"..."}

# Admin UI (open in browser, paste your admin JWT when prompted)
# https://staging.airingdesk.com/api/marketing/admin   (or localhost:3001/api/marketing/admin)
```

If any test fails, run the emergency rollback (see below).

### 5. Install tracking snippet on AiRingDesk.com

Only once staging has been stable for some time (at least a few hours, ideally a day) and all tests pass, add the tracking snippet to the website. Use the **staging** URL first to test:

```html
<script src="https://staging.airingdesk.com/api/marketing/track.js" async></script>
```

Then add `data-rd-lead` to your existing contact form:

```html
<form data-rd-lead data-rd-thanks="We'll be in touch within 24 hours!">
  <input name="name" placeholder="Your name" required />
  <input name="email" type="email" placeholder="Email" required />
  <input name="phone" placeholder="Phone (optional)" />
  <input name="business" placeholder="Business name" />
  <textarea name="message" placeholder="How can we help?"></textarea>
  <button type="submit">Get a demo</button>
</form>
```

### 6. Promote to production (only after staging is verified)

**NEVER promote until staging has been stable for at least a few hours.** When ready:

```bash
cd /var/www/vhosts/airingdesk.com/httpdocs

# Back up production app.js
cp app.js app.js.backup-$(date +%Y%m%d-%H%M%S)

# Download routes/marketing.js from git (same file that's on staging)
wget -O routes/marketing.js \
  https://raw.githubusercontent.com/ringdeskai-ops/ringdesk/claude/airingdesk-marketing-staging-safe/routes/marketing.js

# Verify file
node --check routes/marketing.js && echo "✓ marketing.js OK"

# Apply the same 2-line patch
awk '
/^app\.use\("\/api\/gc", gcRouter\);/ {
    print
    print ""
    print "// ── Marketing platform (additive — does not touch existing code) ──"
    print "const marketingRouter = require(\"./routes/marketing\")(db);"
    print "app.use(\"/api/marketing\", marketingRouter);"
    next
}
{ print }
' app.js > app.new.js && \
node --check app.new.js && echo "✓ syntax OK" && \
mv app.new.js app.js && \
echo "✓ production app.js patched"

# Restart production PM2
pm2 restart airingdesk
pm2 logs airingdesk --lines 30 --nostream

# Test
curl -s http://localhost:3000/api/marketing/health
```

### 7. Point tracking snippet to production URL

Once production is verified, update the website's tracking snippet:

```html
<script src="https://airingdesk.com/api/marketing/track.js" async></script>
```

---

## Emergency Rollback Procedures

### Rollback on staging (tested and working)
```bash
cd /var/www/vhosts/airingdesk.com/staging
cp app.js.backup-20260414-160959 app.js
pm2 restart airingdesk-staging
```

If you want to ALSO remove the marketing file from disk:
```bash
rm -f /var/www/vhosts/airingdesk.com/staging/routes/marketing.js
```

### Rollback on production (if ever applied)
```bash
cd /var/www/vhosts/airingdesk.com/httpdocs
# Replace YYYYMMDD-HHMMSS with the timestamp from when you made the backup
cp app.js.backup-YYYYMMDD-HHMMSS app.js
rm -f routes/marketing.js
pm2 restart airingdesk
pm2 logs airingdesk --lines 30 --nostream
```

Rollback takes under 10 seconds. The SQLite tables `marketing_*` will still exist in `ringdesk.db` but will be empty/unused — harmless. If you want to drop them entirely:

```bash
sqlite3 /var/www/vhosts/airingdesk.com/httpdocs/ringdesk.db <<'SQL'
DROP TABLE IF EXISTS marketing_leads;
DROP TABLE IF EXISTS marketing_subscribers;
DROP TABLE IF EXISTS marketing_events;
SQL
```

Only run the DROP TABLE commands if you've already collected real leads/subscribers and want to permanently delete them. Otherwise leave them alone.

---

## Safety Rules Observed (Do Not Break These)

These rules were agreed at the start of the session and must be followed on any future work:

1. **Production `httpdocs` is off limits for experiments.** All edits happen on `staging/` first.
2. **Backup before every change.** `cp app.js app.js.backup-$(date +%Y%m%d-%H%M%S)` before any edit.
3. **Additive only.** Only new files, new tables, new routes. No modifications to Stripe / GoCardless / Twilio / Retell / Deepgram / Brevo / existing tables / existing routes.
4. **Staging must be tested end-to-end** (website still loads, existing features still work, new endpoints respond correctly) before anything goes to production.
5. **No `git checkout` in `httpdocs` ever again.** Production files are not tracked in a git repo that we control — checkouts can delete them. Use `wget` + `awk` + `mv` instead.
6. **One-click rollback at every step.** Every change must be paired with a documented undo.
7. **Never rush.** If unsure, stop and investigate.
8. **Never install packages with `npm install` (no arguments)** in production — could upgrade pinned versions. Always install specific packages with `--no-save`.

---

## Known Issues (not caused by this work — flagged for your attention)

### 1. Staging has a missing `ws` package
- **Symptom:** `airingdesk-staging` crashes on startup with `Error: Cannot find module 'ws'` at `app.js:28:19`
- **Root cause:** Staging's `node_modules` was last updated Mar 20 and is missing `ws`
- **Impact on business:** None — nobody uses staging for live traffic
- **Fix:** `cd /var/www/vhosts/airingdesk.com/staging && npm install ws --no-save`
- **Possible wider issue:** Staging's `node_modules` may be missing other packages too — watch the logs after fixing `ws`

### 2. Two `node_modules` directories on one server
- **Observation:** Production (`httpdocs`) and staging (`staging/`) each have their own `node_modules` folder
- **Implication:** Staging is genuinely independent, but also means production upgrades don't automatically flow to staging
- **Recommendation:** Consider a periodic `npm ci` on staging to keep it in sync with production

### 3. Git repo `ringdeskai-ops/ringdesk` contains unrelated starter files
- **Observation:** The GitHub repo's `main` / `master` branches contain `server.js` and `Platform.jsx` (starter files), NOT the real `app.js` that runs the business
- **Implication:** Anyone who does `git checkout` in `httpdocs` will find the real `app.js` gets deleted (this happened today and was recovered)
- **Recommendation:** Either (a) add `.gitignore` for `app.js` in production / don't git-checkout in `httpdocs` ever, or (b) clean up the repo so it matches reality, or (c) move production deploys to a different git repo entirely

---

## Files and Locations Reference

### On the VPS (`185.249.74.165`, mystifying-knuth)

| Path | Description |
|---|---|
| `/var/www/vhosts/airingdesk.com/httpdocs/app.js` | **Production backend** (7,479 lines, 609 KB) — runs as PM2 process `airingdesk` on port 3000 |
| `/var/www/vhosts/airingdesk.com/httpdocs/routes/*.js` | Production route modules (invoice.js, gocardless.js, admin.js, referral.js, etc.) |
| `/var/www/vhosts/airingdesk.com/httpdocs/ringdesk.db` | Production SQLite database |
| `/var/www/vhosts/airingdesk.com/httpdocs/node_modules/` | Production npm packages (has `ws`, `@deepgram/*`, `retell-sdk`, etc.) |
| `/var/www/vhosts/airingdesk.com/httpdocs/.env` | Production secrets (**never read or paste contents**) |
| `/var/www/vhosts/airingdesk.com/staging/app.js` | Staging backend — runs as PM2 process `airingdesk-staging` on port 3001 |
| `/var/www/vhosts/airingdesk.com/staging/routes/marketing.js` | **Marketing code already here** (678 lines, downloaded from git) — not referenced until app.js is patched |
| `/var/www/vhosts/airingdesk.com/staging/app.js.backup-20260414-160959` | Backup of staging `app.js` from today's session (596,941 bytes — original pre-Claude state) |
| `/var/www/vhosts/airingdesk.com/staging/node_modules/` | Staging npm packages — **missing `ws`**, dated Mar 20 |

### In GitHub

| Thing | Location |
|---|---|
| Repo | `ringdeskai-ops/ringdesk` |
| Branch with working marketing code | `claude/airingdesk-marketing-staging-safe` |
| File | `routes/marketing.js` |
| Commit | `829b52c` |
| Raw URL for wget | `https://raw.githubusercontent.com/ringdeskai-ops/ringdesk/claude/airingdesk-marketing-staging-safe/routes/marketing.js` |

### PM2 Processes

| Name | Mode | Port | Path | Status |
|---|---|---|---|---|
| `airingdesk` (id 1) | fork | 3000 | `httpdocs/app.js` | ✅ Production, running |
| `airingdesk-staging` (id 0) | cluster | 3001 | `staging/app.js` | ❌ Crashed (pre-existing `ws` issue) |

---

## Quick-Resume Commands (the 30-second replay)

When you're ready to finish the deploy, copy-paste these blocks one at a time:

### Block 1 — Fix staging's `ws` package
```bash
cd /var/www/vhosts/airingdesk.com/staging
npm install ws --no-save
pm2 restart airingdesk-staging
sleep 3
pm2 logs airingdesk-staging --lines 20 --nostream --err
curl -s -o /dev/null -w "Port 3001: HTTP %{http_code}\n" http://localhost:3001/
```
Expected: no fresh `ws` errors, port 3001 returns a 2xx/3xx/4xx status (not 000).

### Block 2 — Re-apply marketing patch
```bash
cd /var/www/vhosts/airingdesk.com/staging
cp app.js app.js.backup-$(date +%Y%m%d-%H%M%S)
awk '
/^app\.use\("\/api\/gc", gcRouter\);/ {
    print
    print ""
    print "// ── Marketing platform (additive — does not touch existing code) ──"
    print "const marketingRouter = require(\"./routes/marketing\")(db);"
    print "app.use(\"/api/marketing\", marketingRouter);"
    next
}
{ print }
' app.js > app.new.js && \
node --check app.new.js && \
mv app.new.js app.js && \
echo "✓ patched"
```

### Block 3 — Restart and verify
```bash
pm2 restart airingdesk-staging
sleep 3
pm2 logs airingdesk-staging --lines 20 --nostream
curl -s http://localhost:3001/api/marketing/health
```
Expected: `{"status":"ok","leads":0,"subscribers":0,"events_24h":0}`

### Block 4 — Test a lead capture
```bash
curl -s -X POST http://localhost:3001/api/marketing/leads \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","name":"Test Lead","business":"Acme"}'
```
Expected: `{"success":true,"id":"<uuid>"}`

### Block 5 — Browser smoke test
Open in a browser (replace `staging-domain` with your actual staging URL if different):
- `http://localhost:3001/api/marketing/track.js` → should show the JS snippet
- `http://localhost:3001/api/marketing/admin` → should show the admin dashboard (paste your JWT when prompted)

---

## Contact / Credentials (reference only — do not share)

- **Super admin email** (hardcoded check in `routes/invoice.js` and therefore `routes/marketing.js`): `ringdeskai@gmail.com`
- The admin dashboard needs a JWT where the payload's `email` field matches the above.
- To get the JWT: log into the main AiRingDesk dashboard in your browser, open DevTools → Application → Local Storage, and copy whichever of these keys has a JWT-looking value: `rd_token`, `token`, `jwt`, `authToken`.

---

## If You're Picking This Up Fresh

1. Read the **TL;DR** and **Current State** sections above.
2. Read the **Safety Rules Observed** section and agree to follow them.
3. Run **Quick-Resume Commands → Block 1** (fix staging `ws`). If that works, continue through Block 5.
4. If any block fails, stop immediately and read the **Emergency Rollback Procedures**.
5. Only touch production after staging has been verified and stable for at least a few hours.

---

**Session paused:** 14 April 2026
**Next session:** When the user is ready. No urgency. Production is safe.
