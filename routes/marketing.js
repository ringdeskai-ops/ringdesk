// routes/marketing.js
// ─────────────────────────────────────────────────────────────────────────────
// AiRingDesk — Marketing Platform (self-contained, additive-only)
//
// This file adds a lightweight HubSpot-style lead capture + CRM + tracking
// system to the existing AiRingDesk backend WITHOUT touching any existing
// table, route, middleware, or third-party integration (Stripe, GoCardless,
// Twilio, Anthropic, Deepgram, Retell, Brevo).
//
// Safe to drop in. To install, add these TWO lines to app.js next to the
// existing invoiceRouter / gcRouter setup:
//
//     const marketingRouter = require("./routes/marketing")(db);
//     app.use("/api/marketing", marketingRouter);
//
// Rollback: delete those two lines + delete this file. New tables sit empty.
//
// © 2026 AiRingDesk — SatFocus Ltd.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ═════════════════════════════════════════════════════════════════════════════
// LOCAL AUTH MIDDLEWARE — matches routes/invoice.js pattern exactly
// ═════════════════════════════════════════════════════════════════════════════

function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    req.client = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}

function superAdminRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.email !== 'ringdeskai@gmail.com') return res.status(403).json({ error: 'Forbidden' });
    req.client = decoded;
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}

// ═════════════════════════════════════════════════════════════════════════════
// IN-MEMORY RATE LIMITER (per IP + path, sliding 1-min window)
// ═════════════════════════════════════════════════════════════════════════════

const _rl = new Map();
function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
    const key = ip + ':' + req.path;
    const now = Date.now();
    const entry = _rl.get(key) || { count: 0, reset: now + 60000 };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
    entry.count++;
    _rl.set(key, entry);
    if (entry.count > maxPerMin) {
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    next();
  };
}
const _rlCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rl) if (now > v.reset + 300000) _rl.delete(k);
}, 600000);
if (_rlCleanup.unref) _rlCleanup.unref();

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const getIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket.remoteAddress || null;

const isEmail = (e) => typeof e === 'string' && /^\S+@\S+\.\S+$/.test(e);

const safeStr = (v, max) => {
  if (v == null) return null;
  const s = String(v).slice(0, max);
  return s.length ? s : null;
};

const uuid = () => crypto.randomUUID();

const VALID_STATUSES = ['new', 'contacted', 'qualified', 'demo', 'trial', 'won', 'lost'];

// ═════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT — called as require('./routes/marketing')(db)
// ═════════════════════════════════════════════════════════════════════════════

module.exports = function (db) {
  const router = express.Router();

  // ── Create our own tables (IF NOT EXISTS — additive, cannot overwrite) ────
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_leads (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL,
      phone TEXT,
      business TEXT,
      message TEXT,
      source TEXT,
      medium TEXT,
      campaign TEXT,
      landing_page TEXT,
      referrer TEXT,
      status TEXT DEFAULT 'new',
      assigned_to TEXT,
      notes TEXT,
      client_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS marketing_subscribers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      confirmed INTEGER DEFAULT 1,
      unsubscribe_token TEXT UNIQUE,
      source TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS marketing_events (
      id TEXT PRIMARY KEY,
      visitor_id TEXT,
      type TEXT,
      path TEXT,
      referrer TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      user_agent TEXT,
      ip TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mleads_status ON marketing_leads(status);
    CREATE INDEX IF NOT EXISTS idx_mleads_created ON marketing_leads(created_at);
    CREATE INDEX IF NOT EXISTS idx_mevents_type ON marketing_events(type, created_at);
    CREATE INDEX IF NOT EXISTS idx_mevents_visitor ON marketing_events(visitor_id);
  `);

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENDPOINTS — called from airingdesk.com and campaign landing pages
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/marketing/leads — capture a lead from any website form
  router.post('/leads', rateLimit(10), (req, res) => {
    const b = req.body || {};
    if (!isEmail(b.email)) return res.status(400).json({ error: 'Valid email required' });
    try {
      const id = uuid();
      db.prepare(`INSERT INTO marketing_leads
        (id, name, email, phone, business, message, source, medium, campaign, landing_page, referrer)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          id,
          safeStr(b.name, 120),
          b.email.toLowerCase().slice(0, 200),
          safeStr(b.phone, 40),
          safeStr(b.business, 200),
          safeStr(b.message, 2000),
          safeStr(b.source, 80) || 'direct',
          safeStr(b.medium, 80),
          safeStr(b.campaign, 120),
          safeStr(b.landing_page, 300),
          safeStr(b.referrer, 300)
        );
      res.json({ success: true, id });
    } catch (err) {
      console.error('[marketing] lead capture error:', err.message);
      res.status(500).json({ error: 'Failed to save lead' });
    }
  });

  // POST /api/marketing/subscribe — newsletter signup
  router.post('/subscribe', rateLimit(5), (req, res) => {
    const b = req.body || {};
    if (!isEmail(b.email)) return res.status(400).json({ error: 'Valid email required' });
    try {
      db.prepare(`INSERT OR IGNORE INTO marketing_subscribers
        (id, email, unsubscribe_token, source) VALUES (?,?,?,?)`).run(
          uuid(),
          b.email.toLowerCase().slice(0, 200),
          crypto.randomBytes(16).toString('hex'),
          safeStr(b.source, 80) || 'website'
        );
      res.json({ success: true });
    } catch (err) {
      console.error('[marketing] subscribe error:', err.message);
      res.status(500).json({ error: 'Failed to subscribe' });
    }
  });

  // GET /api/marketing/unsubscribe?token=xxx — one-click unsubscribe
  router.get('/unsubscribe', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing token');
    const row = db.prepare('SELECT id FROM marketing_subscribers WHERE unsubscribe_token = ?').get(token);
    if (!row) return res.status(404).send('Not found');
    db.prepare('UPDATE marketing_subscribers SET confirmed = 0 WHERE id = ?').run(row.id);
    res.type('text/html').send(
      '<!DOCTYPE html><html><head><title>Unsubscribed</title><meta charset="utf-8">' +
      '</head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center">' +
      '<h2 style="color:#111">You\'ve been unsubscribed</h2>' +
      '<p style="color:#666">You won\'t receive any more marketing emails from AiRingDesk.</p>' +
      '</body></html>'
    );
  });

  // POST /api/marketing/track — record page view / event
  router.post('/track', rateLimit(120), (req, res) => {
    const b = req.body || {};
    if (!b.type) return res.status(400).json({ error: 'type required' });
    try {
      db.prepare(`INSERT INTO marketing_events
        (id, visitor_id, type, path, referrer, utm_source, utm_medium, utm_campaign, user_agent, ip)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          uuid(),
          safeStr(b.visitor_id, 80),
          String(b.type).slice(0, 40),
          safeStr(b.path, 300),
          safeStr(b.referrer, 300),
          safeStr(b.utm_source, 80),
          safeStr(b.utm_medium, 80),
          safeStr(b.utm_campaign, 120),
          (req.headers['user-agent'] || '').slice(0, 200),
          getIp(req)
        );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to track' });
    }
  });

  // GET /api/marketing/track.js — tracking snippet (drop-in script for website)
  router.get('/track.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'public, max-age=3600').send(TRACKING_JS);
  });

  // GET /api/marketing/health — public health check (safe for monitoring)
  router.get('/health', (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    try {
      res.json({
        status: 'ok',
        leads: db.prepare('SELECT COUNT(*) as c FROM marketing_leads').get().c,
        subscribers: db.prepare('SELECT COUNT(*) as c FROM marketing_subscribers WHERE confirmed=1').get().c,
        events_24h: db.prepare('SELECT COUNT(*) as c FROM marketing_events WHERE created_at > ?').get(now - 86400).c,
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS — protected by superAdminRequired
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/marketing/stats — overview KPIs
  router.get('/stats', superAdminRequired, (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const d30 = now - 30 * 86400;
    const d7 = now - 7 * 86400;

    const totalLeads = db.prepare('SELECT COUNT(*) as c FROM marketing_leads').get().c;
    const leadsMonth = db.prepare('SELECT COUNT(*) as c FROM marketing_leads WHERE created_at > ?').get(d30).c;
    const leadsWeek = db.prepare('SELECT COUNT(*) as c FROM marketing_leads WHERE created_at > ?').get(d7).c;

    const byStatusRows = db.prepare('SELECT status, COUNT(*) as count FROM marketing_leads GROUP BY status').all();
    const byStatus = { new: 0, contacted: 0, qualified: 0, demo: 0, trial: 0, won: 0, lost: 0 };
    byStatusRows.forEach(r => { byStatus[r.status] = r.count; });

    const bySource = db.prepare(
      "SELECT COALESCE(source,'direct') as source, COUNT(*) as count FROM marketing_leads WHERE created_at > ? GROUP BY source ORDER BY count DESC LIMIT 10"
    ).all(d30);

    const subscribers = db.prepare('SELECT COUNT(*) as c FROM marketing_subscribers WHERE confirmed = 1').get().c;
    const newSubs30 = db.prepare('SELECT COUNT(*) as c FROM marketing_subscribers WHERE confirmed = 1 AND created_at > ?').get(d30).c;

    const pageviews30 = db.prepare("SELECT COUNT(*) as c FROM marketing_events WHERE type = 'pageview' AND created_at > ?").get(d30).c;
    const uniqueVisitors30 = db.prepare(
      "SELECT COUNT(DISTINCT visitor_id) as c FROM marketing_events WHERE type = 'pageview' AND created_at > ? AND visitor_id IS NOT NULL"
    ).get(d30).c;

    // Attribution — tries to join to existing clients table for real conversion count.
    // If clients table doesn't exist or schema differs, falls back to 'won' status count.
    let converted30 = 0;
    try {
      converted30 = db.prepare(`
        SELECT COUNT(*) as c FROM marketing_leads l
        LEFT JOIN clients c ON c.id = l.client_id
        WHERE l.created_at > ? AND (l.status = 'won' OR (c.plan IS NOT NULL AND c.plan != 'trial'))
      `).get(d30).c;
    } catch (e) {
      converted30 = db.prepare("SELECT COUNT(*) as c FROM marketing_leads WHERE created_at > ? AND status = 'won'").get(d30).c;
    }
    const conversionRate = leadsMonth > 0 ? Math.round((converted30 / leadsMonth) * 1000) / 10 : 0;

    const leadsByDay = db.prepare(`
      SELECT date(created_at, 'unixepoch') as day, COUNT(*) as count
      FROM marketing_leads WHERE created_at > ?
      GROUP BY day ORDER BY day
    `).all(d30);

    const topPages = db.prepare(`
      SELECT path, COUNT(*) as count
      FROM marketing_events
      WHERE type = 'pageview' AND created_at > ? AND path IS NOT NULL
      GROUP BY path ORDER BY count DESC LIMIT 8
    `).all(d30);

    res.json({
      total_leads: totalLeads,
      leads_this_month: leadsMonth,
      leads_this_week: leadsWeek,
      by_status: byStatus,
      by_source: bySource,
      subscribers,
      new_subscribers_30d: newSubs30,
      pageviews_30d: pageviews30,
      unique_visitors_30d: uniqueVisitors30,
      converted_30d: converted30,
      conversion_rate: conversionRate,
      leads_by_day: leadsByDay,
      top_pages: topPages,
    });
  });

  // GET /api/marketing/leads — list leads with filters
  router.get('/leads', superAdminRequired, (req, res) => {
    const { status, q, limit = 200, offset = 0 } = req.query;
    let sql = 'SELECT * FROM marketing_leads';
    const where = [], params = [];
    if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
    if (q) {
      where.push('(email LIKE ? OR name LIKE ? OR business LIKE ?)');
      params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    const leads = db.prepare(sql).all(...params);
    const total = db.prepare('SELECT COUNT(*) as c FROM marketing_leads').get().c;
    res.json({ leads, total });
  });

  // PATCH /api/marketing/leads/:id — update lead status/notes
  router.patch('/leads/:id', superAdminRequired, (req, res) => {
    const { status, notes, assigned_to, client_id } = req.body || {};
    const fields = [], values = [];
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      fields.push('status = ?'); values.push(status);
    }
    if (notes !== undefined) { fields.push('notes = ?'); values.push(notes); }
    if (assigned_to !== undefined) { fields.push('assigned_to = ?'); values.push(assigned_to || null); }
    if (client_id !== undefined) { fields.push('client_id = ?'); values.push(client_id || null); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    const info = db.prepare('UPDATE marketing_leads SET ' + fields.join(', ') + ' WHERE id = ?').run(...values);
    if (info.changes === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true });
  });

  // DELETE /api/marketing/leads/:id — delete a lead
  router.delete('/leads/:id', superAdminRequired, (req, res) => {
    db.prepare('DELETE FROM marketing_leads WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // GET /api/marketing/subscribers — list newsletter subscribers
  router.get('/subscribers', superAdminRequired, (req, res) => {
    const subs = db.prepare(
      'SELECT id, email, confirmed, source, created_at FROM marketing_subscribers ORDER BY created_at DESC LIMIT 1000'
    ).all();
    const total = db.prepare('SELECT COUNT(*) as c FROM marketing_subscribers WHERE confirmed = 1').get().c;
    res.json({ subscribers: subs, total });
  });

  // GET /api/marketing/subscribers.csv — export subscribers as CSV
  router.get('/subscribers.csv', superAdminRequired, (req, res) => {
    const subs = db.prepare(
      "SELECT email, source, created_at FROM marketing_subscribers WHERE confirmed = 1 ORDER BY created_at DESC"
    ).all();
    const csv = 'email,source,subscribed_at\n' +
      subs.map(s => s.email + ',' + (s.source || '') + ',' + new Date(s.created_at * 1000).toISOString()).join('\n');
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="airingdesk-subscribers.csv"').send(csv);
  });

  // GET /api/marketing/admin — self-contained admin HTML page
  router.get('/admin', (req, res) => {
    res.type('text/html').send(ADMIN_HTML);
  });

  return router;
};

// ═════════════════════════════════════════════════════════════════════════════
// TRACKING JS SNIPPET — served at /api/marketing/track.js
// Drop one line into airingdesk.com <head>:
//   <script src="https://airingdesk.com/api/marketing/track.js" async></script>
// ═════════════════════════════════════════════════════════════════════════════

const TRACKING_JS = `/* AiRingDesk tracking snippet v1 */
(function(){
  var API='';
  try{var s=document.currentScript;if(s&&s.src){API=new URL(s.src).origin;}}catch(e){}
  function cid(){var k="_rdv",m=document.cookie.match(new RegExp("(?:^|; )"+k+"=([^;]+)"));if(m)return m[1];var id="v_"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);document.cookie=k+"="+id+"; max-age=31536000; path=/; SameSite=Lax";return id;}
  function q(n){return new URLSearchParams(location.search).get(n);}
  function post(url,body){try{if(navigator.sendBeacon){navigator.sendBeacon(url,new Blob([JSON.stringify(body)],{type:"application/json"}));return;}}catch(e){}try{fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),keepalive:true}).catch(function(){});}catch(e){}}
  var utmKey="_rdutm",saved={};try{saved=JSON.parse(sessionStorage.getItem(utmKey)||"{}");}catch(e){}
  var cur={utm_source:q("utm_source"),utm_medium:q("utm_medium"),utm_campaign:q("utm_campaign")};
  if(cur.utm_source||cur.utm_medium||cur.utm_campaign){saved=cur;try{sessionStorage.setItem(utmKey,JSON.stringify(saved));}catch(e){}}
  var ctx={visitor_id:cid(),path:location.pathname+location.search,referrer:document.referrer||null,utm_source:saved.utm_source||null,utm_medium:saved.utm_medium||null,utm_campaign:saved.utm_campaign||null};
  post(API+"/api/marketing/track",Object.assign({type:"pageview"},ctx));
  document.addEventListener("submit",function(e){
    var f=e.target;if(!f||!f.matches||!f.matches("form[data-rd-lead]"))return;
    e.preventDefault();
    var fd=new FormData(f),body={};fd.forEach(function(v,k){body[k]=v;});
    Object.assign(body,{source:ctx.utm_source||"direct",medium:ctx.utm_medium,campaign:ctx.utm_campaign,landing_page:ctx.path,referrer:ctx.referrer});
    var btn=f.querySelector("[type=submit]");if(btn){btn.disabled=true;btn.dataset.__orig=btn.textContent;btn.textContent="Sending...";}
    fetch(API+"/api/marketing/leads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
      .then(function(r){if(!r.ok)throw 0;return r.json();})
      .then(function(){
        post(API+"/api/marketing/track",Object.assign({type:"lead"},ctx));
        var t=f.getAttribute("data-rd-thanks")||"Thanks! We'll be in touch shortly.";
        f.innerHTML='<div style="padding:16px;color:#10b981;font-weight:600;text-align:center">'+t+'</div>';
      })
      .catch(function(){if(btn){btn.disabled=false;btn.textContent=btn.dataset.__orig||"Submit";}alert("Something went wrong. Please try again.");});
  },true);
  document.addEventListener("submit",function(e){
    var f=e.target;if(!f||!f.matches||!f.matches("form[data-rd-subscribe]"))return;
    e.preventDefault();
    var fd=new FormData(f),email=fd.get("email");
    if(!email)return;
    fetch(API+"/api/marketing/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email,source:"newsletter"})})
      .then(function(){f.innerHTML='<div style="padding:12px;color:#10b981;font-weight:600">Subscribed \u2713</div>';})
      .catch(function(){alert("Please try again.");});
  },true);
})();`;

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN HTML PAGE — served at GET /api/marketing/admin
// Self-contained: inline CSS + inline JS. No external dependencies.
// Auth: reads JWT from localStorage (rd_token / token / jwt — tries multiple
// common keys). If none found, prompts for it once and caches.
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AiRingDesk — Marketing</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#080c14;color:#f9fafb;min-height:100vh;padding:24px}
.wrap{max-width:1280px;margin:0 auto}
h1{font-size:24px;font-weight:700;margin-bottom:4px}
.sub{color:#6b7280;font-size:13px;margin-bottom:24px}
.tabs{display:flex;gap:4px;background:#0d1117;padding:4px;border-radius:10px;border:1px solid #1f2937;width:fit-content;margin-bottom:20px}
.tab{padding:8px 18px;border-radius:7px;border:none;background:transparent;color:#6b7280;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.tab.active{background:#1f2937;color:#fff}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:#0d1117;border:1px solid #1f2937;border-radius:10px;padding:18px 16px}
.kpi .v{font-size:26px;font-weight:700;color:#60a5fa;margin-bottom:2px}
.kpi .l{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px}
.card{background:#0d1117;border:1px solid #1f2937;border-radius:10px;padding:18px;margin-bottom:18px}
.card h2{font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.filter{padding:6px 12px;border-radius:7px;border:none;background:rgba(255,255,255,0.04);color:#6b7280;font-size:11px;font-family:inherit;cursor:pointer}
.filter.active{background:rgba(59,130,246,0.2);color:#60a5fa}
.search{flex:1;min-width:200px;background:#1f2937;border:1px solid #374151;border-radius:7px;padding:7px 12px;color:#f9fafb;font-size:12px;font-family:inherit;outline:none}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;padding:10px 12px;background:rgba(255,255,255,0.02)}
td{padding:11px 12px;font-size:12px;border-top:1px solid #1a2332;color:#9ca3af}
tr.row{cursor:pointer}
tr.row:hover{background:rgba(59,130,246,0.05)}
.name{color:#e5e7eb;font-weight:600;font-size:13px}
.pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.s-new{background:rgba(96,165,250,0.15);color:#60a5fa}
.s-contacted{background:rgba(167,139,250,0.15);color:#a78bfa}
.s-qualified{background:rgba(6,182,212,0.15);color:#06b6d4}
.s-demo{background:rgba(245,158,11,0.15);color:#f59e0b}
.s-trial{background:rgba(236,72,153,0.15);color:#ec4899}
.s-won{background:rgba(16,185,129,0.15);color:#10b981}
.s-lost{background:rgba(107,114,128,0.15);color:#6b7280}
.empty{padding:40px;text-align:center;color:#4a5568;font-size:12px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,0.7);display:none;align-items:center;justify-content:center;z-index:50;padding:20px}
.modal.open{display:flex}
.modal-box{background:#0d1117;border:1px solid #1f2937;border-radius:12px;padding:24px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto}
.modal-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
.modal-title{font-size:16px;font-weight:700;color:#f9fafb}
.modal-sub{font-size:11px;color:#60a5fa;margin-top:2px}
.close{background:none;border:none;color:#6b7280;cursor:pointer;font-size:18px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
.field{background:#1a2332;border-radius:7px;padding:7px 11px}
.field .k{font-size:9px;color:#4a5568;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px}
.field .v{font-size:12px;color:#e5e7eb;word-break:break-all}
.label{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.statuses{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:14px}
.st{padding:5px 11px;border-radius:20px;border:none;background:rgba(255,255,255,0.04);color:#6b7280;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;text-transform:uppercase}
.st.active{background:rgba(96,165,250,0.2);color:#60a5fa}
textarea{width:100%;background:#1a2332;border:1px solid #283548;border-radius:7px;padding:9px 11px;color:#e5e7eb;font-size:12px;resize:vertical;font-family:inherit;min-height:80px;outline:none;margin-bottom:12px}
.btn{padding:10px 18px;border-radius:7px;border:none;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.btn.danger{background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.3)}
.btn-row{display:flex;gap:8px}
pre{background:#0a0f18;border:1px solid #1a2332;border-radius:7px;padding:12px 14px;color:#9ca3af;font-size:11px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,monospace;line-height:1.5}
.note{color:#9ca3af;font-size:12px;line-height:1.6;margin-bottom:10px}
.pipe{display:flex;flex-direction:column;gap:8px}
.pipe-row{display:flex;align-items:center;gap:10px;font-size:11px}
.pipe-row .n{width:90px;color:#9ca3af;text-transform:uppercase;font-size:10px;letter-spacing:0.5px}
.pipe-bar{flex:1;height:6px;background:#1f2937;border-radius:3px;overflow:hidden}
.pipe-bar>div{height:100%;transition:width .4s}
.pipe-row .c{width:40px;text-align:right;color:#e5e7eb;font-weight:600}
.loading{padding:40px;text-align:center;color:#6b7280}
.grid2-cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
@media(max-width:720px){.grid2-cards{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <h1>Marketing</h1>
  <div class="sub">Leads, subscribers &amp; tracking — AiRingDesk</div>
  <div class="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="leads">Leads</button>
    <button class="tab" data-tab="subs">Subscribers</button>
    <button class="tab" data-tab="install">Install</button>
  </div>
  <div id="view"></div>
</div>
<div class="modal" id="modal"><div class="modal-box" id="modal-body"></div></div>
<script>
(function(){
  var API=location.origin;
  var STATUSES=['new','contacted','qualified','demo','trial','won','lost'];
  function token(){
    var t=localStorage.getItem('rd_token')||localStorage.getItem('token')||localStorage.getItem('jwt')||localStorage.getItem('authToken');
    if(!t){
      t=prompt('Paste your admin JWT token (from browser devtools → Application → Local Storage on the main dashboard):');
      if(t){localStorage.setItem('rd_token',t);}
    }
    return t;
  }
  function api(path,opts){
    opts=opts||{};
    opts.headers=Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+token()},opts.headers||{});
    if(opts.body&&typeof opts.body!=='string')opts.body=JSON.stringify(opts.body);
    return fetch(API+path,opts).then(function(r){
      if(r.status===401||r.status===403){localStorage.removeItem('rd_token');throw new Error('Unauthorized. Refresh and paste your admin token.');}
      if(!r.ok)return r.json().then(function(e){throw new Error(e.error||'Error');});
      return r.json();
    });
  }
  function fmt(ts){return ts?new Date(ts*1000).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—';}
  function esc(s){return String(s||'').replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  var state={tab:'overview',filter:'all',search:'',stats:null,leads:[],subs:[]};
  var tabs=document.querySelectorAll('.tab');
  tabs.forEach(function(b){b.onclick=function(){state.tab=b.dataset.tab;tabs.forEach(function(x){x.classList.toggle('active',x===b);});render();};});
  var view=document.getElementById('view');
  var modal=document.getElementById('modal');
  var modalBody=document.getElementById('modal-body');
  modal.onclick=function(e){if(e.target===modal)closeModal();};
  function closeModal(){modal.classList.remove('open');}
  function loadStats(){return api('/api/marketing/stats').then(function(d){state.stats=d;});}
  function loadLeads(){
    var qp=new URLSearchParams();
    if(state.filter!=='all')qp.set('status',state.filter);
    if(state.search)qp.set('q',state.search);
    return api('/api/marketing/leads?'+qp).then(function(d){state.leads=d.leads||[];});
  }
  function loadSubs(){return api('/api/marketing/subscribers').then(function(d){state.subs=d.subscribers||[];});}
  function render(){
    view.innerHTML='<div class="loading">Loading…</div>';
    if(state.tab==='overview'){
      loadStats().then(renderOverview).catch(renderErr);
    }else if(state.tab==='leads'){
      Promise.all([loadStats(),loadLeads()]).then(renderLeads).catch(renderErr);
    }else if(state.tab==='subs'){
      loadSubs().then(renderSubs).catch(renderErr);
    }else if(state.tab==='install'){
      renderInstall();
    }
  }
  function renderErr(e){view.innerHTML='<div class="card" style="color:#ef4444">'+esc(e.message)+'</div>';}
  function renderOverview(){
    var s=state.stats;
    var kpis=[
      ['Leads (30d)',s.leads_this_month],
      ['Leads (7d)',s.leads_this_week],
      ['Converted (30d)',s.converted_30d],
      ['Conv. Rate',s.conversion_rate+'%'],
      ['Visitors (30d)',s.unique_visitors_30d],
      ['Subscribers',s.subscribers]
    ];
    var statusColors={new:'#60a5fa',contacted:'#a78bfa',qualified:'#06b6d4',demo:'#f59e0b',trial:'#ec4899',won:'#10b981',lost:'#6b7280'};
    var total=Object.values(s.by_status||{}).reduce(function(a,b){return a+b;},0)||1;
    var pipe=STATUSES.map(function(st){
      var c=s.by_status[st]||0;
      return '<div class="pipe-row"><div class="n">'+st+'</div><div class="pipe-bar"><div style="width:'+(c/total*100)+'%;background:'+statusColors[st]+'"></div></div><div class="c">'+c+'</div></div>';
    }).join('');
    var srcs=(s.by_source||[]).map(function(r){return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1f2937;font-size:12px"><span style="color:#e5e7eb">'+esc(r.source||'direct')+'</span><span style="color:#60a5fa;font-weight:700">'+r.count+'</span></div>';}).join('')||'<div class="empty" style="padding:20px">No source data yet.</div>';
    var pages=(s.top_pages||[]).map(function(r){return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1f2937;font-size:12px"><span style="color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">'+esc(r.path)+'</span><span style="color:#60a5fa;font-weight:700">'+r.count+'</span></div>';}).join('');
    view.innerHTML='<div class="kpis">'+kpis.map(function(k){return '<div class="kpi"><div class="v">'+k[1]+'</div><div class="l">'+k[0]+'</div></div>';}).join('')+'</div>'+
      '<div class="grid2-cards"><div class="card"><h2>Pipeline</h2><div class="pipe">'+pipe+'</div></div>'+
      '<div class="card"><h2>Top Sources (30d)</h2>'+srcs+'</div></div>'+
      (pages?'<div class="card"><h2>Top Landing Pages (30d)</h2>'+pages+'</div>':'');
  }
  function renderLeads(){
    var filters='<button class="filter '+(state.filter==='all'?'active':'')+'" data-f="all">All ('+(state.stats?state.stats.total_leads:0)+')</button>'+
      STATUSES.map(function(st){var c=state.stats?(state.stats.by_status[st]||0):0;return '<button class="filter '+(state.filter===st?'active':'')+'" data-f="'+st+'">'+st+' ('+c+')</button>';}).join('')+
      '<input class="search" placeholder="Search name, email, business…" value="'+esc(state.search)+'" id="q">';
    var rows=state.leads.length?'<table><thead><tr><th>Name / Business</th><th>Email</th><th>Source</th><th>Status</th><th>Received</th></tr></thead><tbody>'+
      state.leads.map(function(l){
        return '<tr class="row" data-id="'+l.id+'"><td><div class="name">'+esc(l.name||'—')+'</div><div>'+esc(l.business||'')+'</div></td>'+
          '<td>'+esc(l.email)+'</td>'+
          '<td>'+esc(l.source||'direct')+(l.campaign?'<div style="font-size:9px;color:#4a5568">'+esc(l.campaign)+'</div>':'')+'</td>'+
          '<td><span class="pill s-'+l.status+'">'+l.status+'</span></td>'+
          '<td>'+fmt(l.created_at)+'</td></tr>';
      }).join('')+'</tbody></table>':'<div class="empty">No leads yet.<br><span style="font-size:10px">Install the tracking snippet from the Install tab to start capturing leads.</span></div>';
    view.innerHTML='<div class="filters">'+filters+'</div><div class="card" style="padding:0">'+rows+'</div>';
    view.querySelectorAll('.filter').forEach(function(b){b.onclick=function(){state.filter=b.dataset.f;render();};});
    var q=document.getElementById('q');var t;q.oninput=function(){clearTimeout(t);t=setTimeout(function(){state.search=q.value;render();},300);};
    view.querySelectorAll('tr.row').forEach(function(r){r.onclick=function(){openLead(r.dataset.id);};});
  }
  function openLead(id){
    var l=state.leads.find(function(x){return x.id===id;});if(!l)return;
    var fields=[['Email',l.email],['Phone',l.phone||'—'],['Source',l.source||'direct'],['Campaign',l.campaign||'—'],['Landing',l.landing_page||'—'],['Received',fmt(l.created_at)]];
    var sts=STATUSES.map(function(st){return '<button class="st '+(l.status===st?'active':'')+'" data-s="'+st+'">'+st+'</button>';}).join('');
    modalBody.innerHTML='<div class="modal-head"><div><div class="modal-title">'+esc(l.name||l.email)+'</div>'+(l.business?'<div class="modal-sub">'+esc(l.business)+'</div>':'')+'</div><button class="close">✕</button></div>'+
      '<div class="grid2">'+fields.map(function(f){return '<div class="field"><div class="k">'+f[0]+'</div><div class="v">'+esc(f[1])+'</div></div>';}).join('')+'</div>'+
      (l.message?'<div class="field" style="margin-bottom:14px"><div class="k">Message</div><div class="v" style="line-height:1.5">'+esc(l.message)+'</div></div>':'')+
      '<div class="label">Status</div><div class="statuses">'+sts+'</div>'+
      '<div class="label">Notes</div><textarea id="notes" placeholder="Follow-up notes…">'+esc(l.notes||'')+'</textarea>'+
      '<div class="btn-row"><button class="btn" id="save">Save</button><button class="btn danger" id="del">Delete</button></div>';
    modal.classList.add('open');
    modalBody.querySelector('.close').onclick=closeModal;
    var curStatus=l.status;
    modalBody.querySelectorAll('.st').forEach(function(b){b.onclick=function(){curStatus=b.dataset.s;modalBody.querySelectorAll('.st').forEach(function(x){x.classList.toggle('active',x===b);});};});
    modalBody.querySelector('#save').onclick=function(){
      api('/api/marketing/leads/'+id,{method:'PATCH',body:{status:curStatus,notes:document.getElementById('notes').value}})
        .then(function(){closeModal();render();}).catch(function(e){alert(e.message);});
    };
    modalBody.querySelector('#del').onclick=function(){
      if(!confirm('Delete this lead?'))return;
      api('/api/marketing/leads/'+id,{method:'DELETE'}).then(function(){closeModal();render();}).catch(function(e){alert(e.message);});
    };
  }
  function renderSubs(){
    var rows=state.subs.length?'<table><thead><tr><th>Email</th><th>Source</th><th>Status</th><th>Subscribed</th></tr></thead><tbody>'+
      state.subs.map(function(s){return '<tr><td class="name">'+esc(s.email)+'</td><td>'+esc(s.source||'—')+'</td><td><span class="pill s-'+(s.confirmed?'won':'lost')+'">'+(s.confirmed?'Active':'Unsubscribed')+'</span></td><td>'+fmt(s.created_at)+'</td></tr>';}).join('')+'</tbody></table>':'<div class="empty">No subscribers yet.</div>';
    view.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><div style="font-size:12px;color:#9ca3af">'+state.subs.filter(function(s){return s.confirmed;}).length+' active subscribers</div><a href="'+API+'/api/marketing/subscribers.csv" class="btn" style="text-decoration:none;display:inline-block">Export CSV</a></div><div class="card" style="padding:0">'+rows+'</div>';
  }
  function renderInstall(){
    var snippet='<script src="'+API+'/api/marketing/track.js" async><\\/script>';
    var lead='<form data-rd-lead data-rd-thanks="Thanks! We\\'ll be in touch shortly.">\\n  <input name="name" placeholder="Your name" required>\\n  <input name="email" type="email" placeholder="Email" required>\\n  <input name="phone" placeholder="Phone">\\n  <input name="business" placeholder="Business name">\\n  <textarea name="message" placeholder="How can we help?"></textarea>\\n  <button type="submit">Get a demo</button>\\n</form>';
    var sub='<form data-rd-subscribe>\\n  <input name="email" type="email" placeholder="Your email" required>\\n  <button type="submit">Subscribe</button>\\n</form>';
    view.innerHTML='<div class="card"><h2>1 — Tracking Snippet</h2><div class="note">Paste this one line in the &lt;head&gt; of every page on airingdesk.com. It tracks page views, stores UTM parameters, and auto-binds to any form marked with <code>data-rd-lead</code> or <code>data-rd-subscribe</code>.</div><pre>'+esc(snippet)+'</pre></div>'+
      '<div class="card"><h2>2 — Lead Capture Form</h2><div class="note">Add <code>data-rd-lead</code> to any existing contact/demo form. Field names name, email, phone, business, message are captured automatically.</div><pre>'+esc(lead)+'</pre></div>'+
      '<div class="card"><h2>3 — Newsletter Form</h2><div class="note">Add <code>data-rd-subscribe</code> to a newsletter form. Only the email field is required.</div><pre>'+esc(sub)+'</pre></div>'+
      '<div class="card"><h2>API Endpoints</h2><div class="note" style="line-height:2"><strong style="color:#e5e7eb">Public:</strong> POST /api/marketing/leads · POST /api/marketing/subscribe · POST /api/marketing/track · GET /api/marketing/unsubscribe · GET /api/marketing/track.js<br><strong style="color:#e5e7eb">Admin (JWT required):</strong> GET /stats · GET /leads · PATCH /leads/:id · DELETE /leads/:id · GET /subscribers · GET /subscribers.csv</div></div>';
  }
  render();
})();
<\/script>
</body>
</html>`;
