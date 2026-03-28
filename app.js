// © 2026 AiRingDesk, a trading name of SatFocus Ltd. All rights reserved.
// Registered in England & Wales. Unauthorised copying or distribution is strictly prohibited.

/**
 * RingDesk — Multi-Tenant AI Receptionist Server
 * One server, unlimited clients. Each client has:
 *   - Their own Twilio number
 *   - Their own AI personality/prompt
 *   - Their own call logs & transcripts
 *   - Their own transfer numbers
 *   - Their own Stripe subscription
 */

require("dotenv").config({ path: __dirname + "/.env" });

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason?.stack || reason);
});
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const stripe = process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null;
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;
const https = require('https');
const anthropic = new Anthropic({ 
  apiKey: process.env.ANTHROPIC_API_KEY,
  httpAgent: new https.Agent({ keepAlive: false })
});

// ── Database setup (SQLite — swap for Postgres in prod) ───────────────────────
const db = new Database(process.env.DB_PATH || require("path").join(__dirname, "ringdesk.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    phone_number TEXT,           -- their Twilio number
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    plan TEXT DEFAULT 'trial',   -- trial | starter | professional | business
    plan_status TEXT DEFAULT 'active',
    ai_prompt TEXT,              -- custom system prompt
    ai_name TEXT DEFAULT 'Aria',
    departments TEXT DEFAULT '{}', -- JSON: {sales: "+44...", support: "+44..."}
    created_at INTEGER DEFAULT (unixepoch()),
    calls_this_month INTEGER DEFAULT 0,
    call_limit INTEGER DEFAULT 50
  );

  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    call_sid TEXT UNIQUE,
    caller_number TEXT,
    caller_name TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active', -- active | completed | transferred | voicemail
    transferred_to TEXT,
    summary TEXT,
    recording_url TEXT,
    transcript TEXT,              -- JSON array of {role, content}
    started_at INTEGER DEFAULT (unixepoch()),
    ended_at INTEGER,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS call_sessions (
    call_sid TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    history TEXT DEFAULT '[]',    -- JSON conversation history
    caller_name TEXT,
    started_at INTEGER DEFAULT (unixepoch())
  );
`);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (crawlers, curl, etc) and all origins for public routes
    callback(null, true);
  },
  credentials: true
}));
app.use("/stripe-webhook", bodyParser.raw({ type: "application/json" }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Auth middleware ────────────────────────────────────────────────────────────
function authRequired(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.client = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ── Plan limits ────────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  trial:        { calls: 50,    price: 0 },
  essential:    { calls: 150,   price: 2900  },  // pence
  starter:      { calls: 300,   price: 4900  },
  professional: { calls: 1000,  price: 14900 },
  business:     { calls: 5000,  price: 34900 },
};

const STRIPE_PRICE_IDS = {
  essential:    process.env.STRIPE_PRICE_ESSENTIAL,
  starter:      process.env.STRIPE_PRICE_STARTER,
  professional: process.env.STRIPE_PRICE_PROFESSIONAL,
  business:     process.env.STRIPE_PRICE_BUSINESS,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Register new client
app.post("/api/auth/register", async (req, res) => {
  const { business_name, email, password, referral_code, first_name, last_name, contact_phone, address_line1, address_line2, city, county, postcode, country, region } = req.body;
  if (!business_name || !email || !password || !first_name || !last_name || !contact_phone || !country)
    return res.status(400).json({ error: "All required fields must be completed" });

  const id = uuidv4();
  const password_hash = await bcrypt.hash(password, 12);

  // Create Stripe customer
  // Generate ARD customer number
  const lastCust = db.prepare("SELECT customer_number FROM clients WHERE role = 'client' AND customer_number IS NOT NULL ORDER BY created_at DESC LIMIT 1").get();
  const custNextNum = lastCust && lastCust.customer_number ? (parseInt(lastCust.customer_number.replace('ARD-','')) || 0) + 1 : 1;
  const customerNumber = 'ARD-' + String(custNextNum).padStart(5, '0');

  let stripeCustomerId = null;
  try {
    const customer = stripe ? await stripe.customers.create({ email, name: business_name }) : { id: null };
    stripeCustomerId = customer.id;
  } catch (err) {
    console.error("Stripe customer creation failed:", err.message);
  }

  const defaultPrompt = `You are ${business_name}'s AI receptionist. Be professional, warm, and helpful.
Answer general enquiries, take messages, and transfer to the right team when needed.
Keep responses under 40 words — this is a phone call.
If the caller wants to leave a voicemail or message, or if no one is available, reply with exactly [VOICEMAIL] to transfer them to voicemail.
If the caller wants to book an appointment, collect their name, preferred date and time only. Then reply with [BOOK:name|YYYY-MM-DD|HH:MM|none] e.g. [BOOK:John Smith|2026-03-26|14:00|none]. Ask one question at a time. Confirm each answer before moving to next.`;

  try {
    db.prepare('INSERT INTO clients (id, business_name, email, password_hash, stripe_customer_id, ai_prompt, customer_number, role, first_name, last_name, contact_phone, address_line1, address_line2, city, county, postcode, country, region, voicemail_enabled, feature_email, feature_appointments, feature_ai_settings, feature_voice_selector, feature_crm, call_recording, show_demo_banner) VALUES (?, ?, ?, ?, ?, ?, ?, \'client\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 0, 0, 0, 0, 1)')
      .run(id, business_name, email, password_hash, stripeCustomerId, defaultPrompt, customerNumber, first_name||'', last_name||'', contact_phone||'', address_line1||'', address_line2||'', city||'', county||'', postcode||'', country||'United Kingdom', region||'');

    // Generate email verification token
    const verifyToken = require('crypto').randomBytes(32).toString('hex');
    const verifyExpiry = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24 hours
    db.prepare("UPDATE clients SET email_verified = 0, verification_token = ?, verification_expires = ? WHERE id = ?").run(verifyToken, verifyExpiry, id);

    // Send verification email
    const verifyUrl = process.env.DASHBOARD_URL + '/verify-email?token=' + verifyToken;
    sendVerificationEmail(business_name, email, verifyUrl);
    sendWelcomeEmail(business_name, email, referral_code, id);

    res.json({ success: true, message: "Registration successful. Please check your email to verify your account." });
  } catch (err) {
    if (err.message.includes("UNIQUE")) return res.status(409).json({ error: "Email already registered" });
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const client = db.prepare("SELECT * FROM clients WHERE email = ?").get(email);
  if (!client) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, client.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  if (client.email_verified === 0)
    return res.status(403).json({ error: "Please verify your email before logging in. Check your inbox for the verification link." });

  const token = jwt.sign(
    { id: client.id, email: client.email, business_name: client.business_name, role: client.role || "client" },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
  res.json({ token, client: { id: client.id, business_name: client.business_name, email: client.email, plan: client.plan, phone_number: client.phone_number } });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CLIENT DASHBOARD API
// ═══════════════════════════════════════════════════════════════════════════════

// Get client profile + stats
app.get("/api/client/profile", authRequired, (req, res) => {
  const client = db.prepare("SELECT id, business_name, email, phone_number, plan, plan_status, ai_name, ai_prompt, ai_voice, ai_voice_language, departments, calls_this_month, call_limit, created_at, first_name, last_name, contact_phone, address_line1, address_line2, city, county, postcode, country, region, customer_number, show_demo_banner, feature_email, feature_appointments, feature_ai_settings, feature_voice_selector, feature_crm, voicemail_enabled, call_recording, billing_cycle_day, billing_period_start, signup_completed, cancel_at_period_end FROM clients WHERE id = ?").get(req.client.id);
  if (!client) return res.status(404).json({ error: "Not found" });
  client.departments = JSON.parse(client.departments || "{}");
  res.json(client);
});

// Update account details
app.put("/api/client/account", authRequired, (req, res) => {
  const { first_name, last_name, business_name, contact_phone, address_line1, address_line2, city, postcode, country, region } = req.body;
  db.prepare("UPDATE clients SET first_name=?, last_name=?, business_name=?, contact_phone=?, address_line1=?, address_line2=?, city=?, postcode=?, country=?, region=? WHERE id=?")
    .run(first_name||'', last_name||'', business_name||'', contact_phone||'', address_line1||'', address_line2||'', city||'', postcode||'', country||'', region||'', req.client.id);
  res.json({ success: true });
});

// Change password
app.post("/api/client/change-password", authRequired, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || new_password.length < 8)
    return res.status(400).json({ error: "Invalid request" });
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);
  const valid = await bcrypt.compare(current_password, client.password_hash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
  const hash = await bcrypt.hash(new_password, 12);
  db.prepare("UPDATE clients SET password_hash = ? WHERE id = ?").run(hash, req.client.id);
  res.json({ success: true });
});

// Update AI settings
app.put("/api/client/settings", authRequired, (req, res) => {
  const { ai_name, ai_prompt, departments, ai_voice, ai_voice_language } = req.body;
  db.prepare("UPDATE clients SET ai_name = ?, ai_prompt = ?, departments = ?, ai_voice = ?, ai_voice_language = ? WHERE id = ?")
    .run(ai_name, ai_prompt, JSON.stringify(departments || {}), ai_voice || 'Google.en-GB-Neural2-C', ai_voice_language || 'en-GB', req.client.id);
  res.json({ success: true });
});

// Get call logs
app.get("/api/calls", authRequired, (req, res) => {
  const { limit = 50, offset = 0, status } = req.query;
  let query = "SELECT * FROM calls WHERE client_id = ?";
  const params = [req.client.id];
  if (status) { query += " AND status = ?"; params.push(status); }
  query += " ORDER BY started_at DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));
  const calls = db.prepare(query).all(...params);
  calls.forEach(c => { try { c.transcript = JSON.parse(c.transcript || "[]"); } catch { c.transcript = []; } });
  const total = db.prepare("SELECT COUNT(*) as count FROM calls WHERE client_id = ?").get(req.client.id).count;
  res.json({ calls, total });
});

// ── Voicemail recording proxy ─────────────────────────────────────────────────
app.get("/api/calls/:id/recording", async (req, res) => {
  // Support token via query param for audio element requests
  let clientId = null;
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    clientId = decoded.id;
  } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
  const call = db.prepare("SELECT * FROM calls WHERE id = ? AND client_id = ?").get(req.params.id, clientId);
  if (!call) return res.status(404).json({ error: "Not found" });
  if (!call.recording_url) return res.status(404).json({ error: "No recording" });
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const response = await fetch(call.recording_url + '.mp3', {
      headers: { 'Authorization': 'Basic ' + Buffer.from(accountSid + ':' + authToken).toString('base64') },
      redirect: 'follow'
    });
    console.log('Recording fetch status:', response.status, call.recording_url);
    if (!response.ok) return res.status(502).json({ error: 'Recording unavailable - status: ' + response.status });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch(err) {
    console.error('Recording proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single call with full transcript
app.get("/api/calls/:id", authRequired, (req, res) => {
  const call = db.prepare("SELECT * FROM calls WHERE id = ? AND client_id = ?").get(req.params.id, req.client.id);
  if (!call) return res.status(404).json({ error: "Not found" });
  try { call.transcript = JSON.parse(call.transcript || "[]"); } catch { call.transcript = []; }
  res.json(call);
});

// Dashboard stats
app.get("/api/stats", authRequired, (req, res) => {
  const clientId = req.client.id;
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

  const stats = {
    total_calls: db.prepare("SELECT COUNT(*) as c FROM calls WHERE client_id = ?").get(clientId).c,
    calls_this_month: db.prepare("SELECT COUNT(*) as c FROM calls WHERE client_id = ? AND started_at > ?").get(clientId, thirtyDaysAgo).c,
    transferred: db.prepare("SELECT COUNT(*) as c FROM calls WHERE client_id = ? AND status = 'transferred'").get(clientId).c,
    voicemails: db.prepare("SELECT COUNT(*) as c FROM calls WHERE client_id = ? AND status = 'voicemail'").get(clientId).c,
    avg_duration: db.prepare("SELECT AVG(duration) as a FROM calls WHERE client_id = ? AND duration > 0").get(clientId).a || 0,
    calls_by_day: db.prepare(`
      SELECT date(started_at, 'unixepoch') as day, COUNT(*) as count
      FROM calls WHERE client_id = ? AND started_at > ?
      GROUP BY day ORDER BY day
    `).all(clientId, thirtyDaysAgo),
  };
  res.json(stats);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STRIPE BILLING
// ═══════════════════════════════════════════════════════════════════════════════

// Create checkout session for plan upgrade
app.post("/api/billing/checkout", authRequired, async (req, res) => {
  const { plan, phone_number } = req.body;
  const priceId = STRIPE_PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: "Invalid plan" });

  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);

  const session = await stripe.checkout.sessions.create({
    customer: client.stripe_customer_id,
    mode: "subscription",
    subscription_data: { trial_period_days: 7 },
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.DASHBOARD_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.DASHBOARD_URL}/billing`,
    metadata: { client_id: client.id, plan, phone_number: phone_number || '' },
  });

  res.json({ url: session.url });
});

// Customer portal (manage/cancel subscription)
app.post("/api/billing/portal", authRequired, async (req, res) => {
  const client = db.prepare("SELECT stripe_customer_id FROM clients WHERE id = ?").get(req.client.id);
  const session = await stripe.billingPortal.sessions.create({
    customer: client.stripe_customer_id,
    return_url: `${process.env.DASHBOARD_URL}/billing`,
  });
  res.json({ url: session.url });
});


// Cancel subscription at period end (customer-initiated)
app.post("/api/billing/cancel", authRequired, async (req, res) => {
  try {
    const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);
    if (!client.stripe_subscription_id) return res.status(400).json({ error: "No active subscription" });
    await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: true });
    db.prepare("UPDATE clients SET plan_status = 'cancelling', cancel_at_period_end = 1 WHERE id = ?").run(client.id);
    await sendBrevoEmail(process.env.NOTIFY_EMAIL,
      '[AiRingDesk] Cancellation requested: ' + client.business_name,
      '<div style="font-family:sans-serif;padding:24px"><h2 style="color:#ff4466">Cancellation requested</h2><p><strong>' + client.business_name + '</strong> (' + client.email + ') has requested cancellation.</p><p>Access remains active until end of billing period.</p><p><a href="https://airingdesk.com/dashboard">View in admin</a></p></div>'
    ).catch(e => console.error('Cancel admin email error:', e.message));
    res.json({ ok: true });
  } catch(err) {
    console.error('Cancel subscription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reactivate subscription (undo cancel_at_period_end)
app.post("/api/billing/reactivate", authRequired, async (req, res) => {
  try {
    const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);
    if (!client.stripe_subscription_id) return res.status(400).json({ error: "No subscription found" });
    await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: false });
    db.prepare("UPDATE clients SET plan_status = 'active', cancel_at_period_end = 0 WHERE id = ?").run(client.id);
    res.json({ ok: true });
  } catch(err) {
    console.error('Reactivate subscription error:', err.message);
    res.status(500).json({ error: err.message });
  }

// Apply retention discount — 50% off next invoice
app.post("/api/billing/discount", authRequired, async (req, res) => {
  try {
    const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);
    if (!client.stripe_customer_id) return res.status(400).json({ error: "No Stripe customer" });
    // Create a 50% off one-time coupon
    const coupon = await stripe.coupons.create({
      percent_off: 50,
      duration: 'once',
      name: 'AiRingDesk Retention Discount'
    });
    // Apply to customer
    await stripe.customers.update(client.stripe_customer_id, {
      coupon: coupon.id
    });
    // Send confirmation email
    await sendBrevoEmail(client.email,
      'Your 50% discount has been applied — AiRingDesk',
      '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
      + '<div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>'
      + '<div style="display:inline-block;background:rgba(0,232,122,.1);border:1px solid rgba(0,232,122,.3);border-radius:100px;padding:6px 16px;font-size:13px;font-weight:700;color:#00e87a;margin-bottom:16px">🎁 Discount applied</div>'
      + '<h2 style="font-size:20px;margin-bottom:12px">50% off your next invoice</h2>'
      + '<p style="color:#8896a8;line-height:1.7">Hi ' + client.business_name + ', we have applied a 50% discount to your next invoice. Thank you for staying with AiRingDesk — we really appreciate it.</p>'
      + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin:24px 0">'
      + '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1a2332"><span style="color:#8896a8">Discount</span><strong style="color:#00e87a">50% off</strong></div>'
      + '<div style="display:flex;justify-content:space-between;padding:8px 0"><span style="color:#8896a8">Applies to</span><strong>Next invoice only</strong></div>'
      + '</div>'
      + '<a href="' + (process.env.DASHBOARD_URL||'https://airingdesk.com') + '/dashboard" style="display:block;text-align:center;background:#00d4ff;color:#020408;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">Go to dashboard &rarr;</a>'
      + '<p style="color:#3d4f63;font-size:12px;margin-top:24px;border-top:1px solid #1a2332;padding-top:16px">AiRingDesk &middot; hello@airingdesk.com</p></div>'
    ).catch(e => console.error('Discount email error:', e.message));
    // Notify admin
    await sendBrevoEmail(process.env.NOTIFY_EMAIL,
      '[AiRingDesk] Retention discount applied: ' + client.business_name,
      '<p><strong>' + client.business_name + '</strong> (' + client.email + ') accepted the 50% retention discount.</p>'
    ).catch(e => console.error('Discount admin email error:', e.message));
    console.log('Retention discount applied for:', client.email);
    res.json({ ok: true });
  } catch(err) {
    console.error('Discount error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
});
// Static assets
app.use('/assets', require('express').static(__dirname + '/public/assets'));
app.get('/og-image.svg', (req, res) => res.sendFile(__dirname + '/public/og-image.svg'));
app.get('/og-image.jpg', (req, res) => res.sendFile(__dirname + '/public/og-image.jpg'));
app.get('/favicon.svg', (req, res) => res.sendFile(__dirname + '/public/favicon.svg'));

// SEO: Sitemap and robots.txt
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(__dirname + '/public/sitemap.xml');
});
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(__dirname + '/public/robots.txt');
});

// Stripe webhook — subscription events
app.post("/stripe-webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data.object;

  if (event.type === "checkout.session.completed") {
    const { client_id, plan } = session.metadata;
    const limit = PLAN_LIMITS[plan]?.calls || 200;
    const periodStart = Math.floor(Date.now() / 1000);
    const cycleDay = new Date().getDate();
    db.prepare("UPDATE clients SET plan = ?, plan_status = 'active', stripe_subscription_id = ?, call_limit = ?, billing_period_start = ?, billing_cycle_day = ? WHERE id = ?")
      .run(plan, session.subscription, limit, periodStart, cycleDay, client_id);

    // Auto-set feature flags based on plan
    const planFeatures = {
      essential:     { voicemail_enabled:0, feature_email:1, feature_appointments:0, feature_ai_settings:0, feature_voice_selector:0, feature_crm:0, call_recording:0, show_demo_banner:1 },
      starter:       { voicemail_enabled:1, feature_email:1, feature_appointments:0, feature_ai_settings:0, feature_voice_selector:0, feature_crm:0, call_recording:0, show_demo_banner:1 },
      professional:  { voicemail_enabled:1, feature_email:1, feature_appointments:1, feature_ai_settings:1, feature_voice_selector:0, feature_crm:0, call_recording:0, show_demo_banner:1 },
      business:      { voicemail_enabled:1, feature_email:1, feature_appointments:1, feature_ai_settings:1, feature_voice_selector:1, feature_crm:1, call_recording:1, show_demo_banner:1 },
    };
    const features = planFeatures[plan] || planFeatures.essential;
    db.prepare(`UPDATE clients SET
      voicemail_enabled = ?,
      feature_email = ?,
      feature_appointments = ?,
      feature_ai_settings = ?,
      feature_voice_selector = ?,
      feature_crm = ?,
      call_recording = ?,
      show_demo_banner = ?
      WHERE id = ?`).run(
        features.voicemail_enabled,
        features.feature_email,
        features.feature_appointments,
        features.feature_ai_settings,
        features.feature_voice_selector,
        features.feature_crm,
        features.call_recording,
        features.show_demo_banner,
        client_id
      );
    console.log(`Client ${client_id} upgraded to ${plan} — features auto-set`);
  }

if (event.type === "customer.subscription.deleted") {
    const sub = db.prepare("SELECT * FROM clients WHERE stripe_subscription_id = ?").get(session.id);
    if (sub) {
      db.prepare("UPDATE clients SET plan = 'trial', plan_status = 'cancelled', cancel_at_period_end = 0, call_limit = 50, voicemail_enabled = 0, feature_appointments = 0, feature_ai_settings = 0, feature_voice_selector = 0, feature_crm = 0, call_recording = 0 WHERE id = ?").run(sub.id);
      try {
        const planNames = { trial:'Trial', essential:'Essential', starter:'Starter', professional:'Professional', business:'Business' };
        const joinedDate = sub.created_at ? new Date(sub.created_at * 1000).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' }) : 'recently';
        const memberDays = sub.created_at ? Math.floor((Date.now() - sub.created_at * 1000) / (1000*60*60*24)) : '?';
        const reactivateUrl = (process.env.DASHBOARD_URL || 'https://airingdesk.com') + '/dashboard';
        const cancelHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
          + '<div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>'
          + '<h2 style="font-size:20px;margin-bottom:16px">Your subscription has ended</h2>'
          + '<p style="color:#8896a8;line-height:1.7">Hi ' + sub.business_name + ', your AiRingDesk ' + (planNames[sub.plan]||'') + ' subscription has now ended. Thank you for being with us since ' + joinedDate + '.</p>'
          + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin:24px 0">'
          + '<p style="color:#8896a8;font-size:13px;margin-bottom:12px">What happens now:</p>'
          + '<p style="font-size:14px;margin-bottom:8px">&#8226; Your AI receptionist has stopped answering calls</p>'
          + '<p style="font-size:14px;margin-bottom:8px">&#8226; Your call data is retained for 30 days</p>'
          + '<p style="font-size:14px">&#8226; You can reactivate anytime — your settings are saved</p>'
          + '</div>'
          + '<a href="' + reactivateUrl + '" style="display:block;text-align:center;background:#00d4ff;color:#020408;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;margin-bottom:12px">Reactivate my account &rarr;</a>'
          + '<p style="color:#5a7a9a;font-size:13px;text-align:center">We are sorry to see you go. Reply to this email if we can help.</p>'
          + '<p style="color:#3d4f63;font-size:12px;margin-top:24px;border-top:1px solid #1a2332;padding-top:16px">AiRingDesk &middot; hello@airingdesk.com</p></div>';
        await sendBrevoEmail(sub.email, 'Your AiRingDesk subscription has ended', cancelHtml);
        const winbackHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
          + '<div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>'
          + '<h2 style="font-size:20px;margin-bottom:8px">We would love to have you back</h2>'
          + '<p style="color:#8896a8;line-height:1.7;margin-bottom:24px">Hi ' + sub.business_name + ', your AI receptionist is ready to start answering calls again the moment you reactivate. No setup needed — everything is exactly as you left it.</p>'
          + '<div style="background:#0d1117;border:1px solid rgba(0,212,255,.15);border-radius:12px;padding:20px;margin-bottom:24px">'
          + '<p style="color:#00d4ff;font-size:13px;font-weight:700;margin-bottom:12px">What you had with AiRingDesk:</p>'
          + '<p style="font-size:14px;margin-bottom:8px;color:#f0f4f8">&#8226; 24/7 AI receptionist answering every call</p>'
          + '<p style="font-size:14px;margin-bottom:8px;color:#f0f4f8">&#8226; Full call transcripts and summaries</p>'
          + '<p style="font-size:14px;color:#f0f4f8">&#8226; Instant email notifications for every call</p>'
          + '</div>'
          + '<a href="' + reactivateUrl + '" style="display:block;text-align:center;background:#00d4ff;color:#020408;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;margin-bottom:12px">Reactivate my account &rarr;</a>'
          + '<p style="color:#5a7a9a;font-size:13px;text-align:center">Takes less than 2 minutes. Your settings are saved.</p>'
          + '<p style="color:#3d4f63;font-size:12px;margin-top:24px;border-top:1px solid #1a2332;padding-top:16px">AiRingDesk &middot; hello@airingdesk.com</p></div>';
        setTimeout(async () => {
          try {
            await sendBrevoEmail(sub.email, 'Your AI receptionist is waiting — come back to AiRingDesk', winbackHtml);
            console.log('Win-back email sent to:', sub.email);
          } catch(e) { console.error('Win-back email error:', e.message); }
        }, 24 * 60 * 60 * 1000);
        await sendBrevoEmail(process.env.NOTIFY_EMAIL,
          '[AiRingDesk] Subscription ended: ' + sub.business_name,
          '<div style="font-family:sans-serif;max-width:560px;padding:24px"><h2 style="color:#ff4466">Customer churned</h2><table style="width:100%;border-collapse:collapse"><tr><td style="padding:8px 0;color:#888;font-size:13px">Business</td><td style="font-weight:600">' + sub.business_name + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:13px">Email</td><td>' + sub.email + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:13px">Plan</td><td>' + (planNames[sub.plan]||sub.plan) + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:13px">Member for</td><td>' + memberDays + ' days</td></tr></table><p style="margin-top:16px"><a href="https://airingdesk.com/dashboard">View in admin</a></p></div>'
        );
        console.log('Cancellation emails sent for:', sub.email);
      } catch(emailErr) { console.error('Cancellation email error:', emailErr.message); }
    }
  }

  if (event.type === "invoice.payment_failed") {
    const sub = db.prepare("SELECT id FROM clients WHERE stripe_subscription_id = ?").get(session.subscription);
    if (sub) {
      db.prepare("UPDATE clients SET plan_status = 'past_due' WHERE id = ?").run(sub.id);
      console.log(`Payment failed for client ${sub.id}`);
      // Send payment failed email
      const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(sub.id);
      if (client) sendBrevoEmail(client.email, 'Payment failed - Action required', `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px">
          <h2>Payment failed for your AiRingDesk subscription</h2>
          <p>We were unable to process your payment. Please update your payment details to continue using AiRingDesk.</p>
          <a href="https://airingdesk.com/dashboard" style="display:inline-block;background:#00d4ff;color:#020408;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Update payment details →</a>
        </div>
      `).catch(e => console.error('Payment failed email error:', e.message));
    }
  }

  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    if (invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_update" || invoice.billing_reason === "subscription_create") {
      const sub = db.prepare("SELECT * FROM clients WHERE stripe_subscription_id = ?").get(invoice.subscription);
      if (sub) {
        const cycleDay = invoice.period_start ? new Date(invoice.period_start * 1000).getDate() : 1;
        const periodStart = invoice.period_start || Math.floor(Date.now() / 1000);
        db.prepare("UPDATE clients SET plan_status = 'active', calls_this_month = 0, billing_cycle_day = ?, billing_period_start = ? WHERE id = ?").run(cycleDay, periodStart, sub.id);
        console.log("Payment succeeded - client " + sub.id + " plan activated, calls reset, cycle day: " + cycleDay);
        // Send payment confirmation email with invoice
        const planNames = { trial:"Trial", starter:"Starter", professional:"Professional", business:"Business" };
        const amountPaid = (invoice.amount_paid / 100).toFixed(2);
        const nextDate = invoice.period_end ? new Date(invoice.period_end * 1000).toLocaleDateString("en-GB") : "N/A";
        const invoiceUrl = invoice.hosted_invoice_url || null;
        const invoicePdf = invoice.invoice_pdf || null;
        sendBrevoEmail(sub.email, "Payment confirmed — AiRingDesk " + planNames[sub.plan] + " plan", 
          "<div style=\"font-family:Helvetica Neue,sans-serif;max-width:600px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px\">"
          + "<div style=\"font-size:28px;font-weight:800;margin-bottom:8px\"><span style=\"color:#00d4ff\">Ai</span><span style=\"color:#f0f6ff\">Ring</span><span style=\"color:#5a7a9a\">Desk</span></div>"
          + "<div style=\"padding:20px 0;border-bottom:1px solid #1a2332;margin-bottom:24px\">"
          + "<div style=\"display:inline-block;background:rgba(0,232,122,.1);border:1px solid rgba(0,232,122,.3);border-radius:100px;padding:6px 16px;font-size:13px;font-weight:700;color:#00e87a;margin-bottom:16px\">✅ Payment confirmed</div>"
          + "<h1 style=\"font-size:22px;font-weight:700;margin-bottom:8px\">Thank you, " + sub.business_name + "!</h1>"
          + "<p style=\"color:#8896a8;font-size:15px\">Your payment has been received and your subscription is active.</p></div>"
          + "<div style=\"background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:24px;margin-bottom:24px\">"
          + "<div style=\"font-size:12px;color:#5a7a9a;margin-bottom:16px;text-transform:uppercase\">Invoice details</div>"
          + "<div style=\"display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1a2332\"><span style=\"color:#8896a8\">Plan</span><strong style=\"color:#00d4ff\">" + planNames[sub.plan] + "</strong></div>"
          + "<div style=\"display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1a2332\"><span style=\"color:#8896a8\">Amount paid</span><strong style=\"color:#00e87a\">£" + amountPaid + "</strong></div>"
          + "<div style=\"display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1a2332\"><span style=\"color:#8896a8\">Status</span><strong style=\"color:#00e87a\">PAID ✅</strong></div>"
          + "<div style=\"display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1a2332\"><span style=\"color:#8896a8\">Next renewal</span><strong>" + nextDate + "</strong></div>"
          + (sub.referral_discount > 0 ? "<div style=\"display:flex;justify-content:space-between;padding:10px 0\"><span style=\"color:#8896a8\">Referral discount</span><strong style=\"color:#00e87a\">-£" + sub.referral_discount + "</strong></div>" : "")
          + "</div>"
          + (invoiceUrl ? "<a href=\"" + invoiceUrl + "\" style=\"display:block;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.3);color:#00d4ff;text-decoration:none;padding:14px;border-radius:10px;font-size:14px;font-weight:700;text-align:center;margin-bottom:12px\">View invoice online →</a>" : "")
          + (invoicePdf ? "<a href=\"" + invoicePdf + "\" style=\"display:block;background:rgba(255,255,255,.04);border:1px solid #1a2332;color:#8896a8;text-decoration:none;padding:14px;border-radius:10px;font-size:14px;font-weight:600;text-align:center;margin-bottom:24px\">Download PDF invoice ↓</a>" : "")
          + "<a href=\"https://airingdesk.com/dashboard\" style=\"display:block;background:#00d4ff;color:#020408;text-decoration:none;padding:14px;border-radius:10px;font-size:15px;font-weight:700;text-align:center;margin-bottom:24px\">Go to dashboard →</a>"
          + "<p style=\"color:#3d4f63;font-size:12px;border-top:1px solid #1a2332;padding-top:16px\">AiRingDesk · AI Receptionist Platform · <a href=\"https://airingdesk.com\" style=\"color:#5a7a9a\">airingdesk.com</a></p></div>"
        ).catch(e => console.error("Payment email error:", e.message));
      }
    }
  }

if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object;
    const sub = db.prepare("SELECT * FROM clients WHERE stripe_subscription_id = ?").get(subscription.id);
    if (sub) {
      const statusMap = { 'active':'active', 'past_due':'past_due', 'canceled':'cancelled', 'trialing':'trial' };
      let newStatus;
      if (subscription.cancel_at_period_end) {
        newStatus = 'cancelling';
      } else {
        newStatus = statusMap[subscription.status] || sub.plan_status;
      }
      db.prepare("UPDATE clients SET plan_status = ?, cancel_at_period_end = ? WHERE id = ?")
        .run(newStatus, subscription.cancel_at_period_end ? 1 : 0, sub.id);
      console.log(`Subscription updated for client ${sub.id}: ${subscription.status} | cancel_at_period_end: ${subscription.cancel_at_period_end}`);
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TWILIO VOICE ROUTES (multi-tenant — resolved by phone number)
// ═══════════════════════════════════════════════════════════════════════════════

function getClientByNumber(phoneNumber) {
  if (!phoneNumber) return null;
  const clean = phoneNumber.trim().replace(/\s+/g, "");
  const normalised = clean.startsWith("+") ? clean : "+" + clean;
  return db.prepare("SELECT * FROM clients WHERE phone_number = ? OR phone_number = ?").get(normalised, clean);
}

function buildSystemPrompt(client) {
  const base = client.ai_prompt || `You are ${client.ai_name || "Aria"}, the AI receptionist for ${client.business_name}.`;
  return `${base}

RULES:
- Keep ALL responses under 40 words. This is a phone call.
- No markdown, no bullet points, no special characters.
- Be warm, professional, and concise.

TRANSFER RULES — append [TRANSFER:dept] at end of reply when:
- Caller asks for a human, real person, or agent
- Caller requests sales, support, billing, or manager
- Caller is upset or issue is too complex
Departments: sales, support, billing, manager, general
Example: "Let me connect you with our team. [TRANSFER:billing]"`;
}

async function askClaude(client, session, userMessage) {
  let history = JSON.parse(session.history || "[]");
  // Keep only last 6 messages to prevent history bloat and timeouts
  if (history.length > 6) history = history.slice(-6);
  history.push({ role: "user", content: userMessage });

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 80,
    system: buildSystemPrompt(client),
    messages: history,
  }, { timeout: 8000 });

  let reply = response.content[0]?.text || "Could you please repeat that?";
  const transferMatch = reply.match(/\[TRANSFER:(\w+)\]/);
  const transferDept = transferMatch?.[1] || null;
  reply = reply.replace(/\[TRANSFER:\w+\]/g, "").trim();

  history.push({ role: "assistant", content: reply });
  db.prepare("UPDATE call_sessions SET history = ? WHERE call_sid = ?")
    .run(JSON.stringify(history), session.call_sid);

  const nameMatch = userMessage.match(/(?:my name is|i'm|i am|this is)\s+([A-Za-z]+)/i);
  if (nameMatch && !session.caller_name) {
    db.prepare("UPDATE call_sessions SET caller_name = ? WHERE call_sid = ?").run(nameMatch[1], session.call_sid);
  }

  return { reply, transferDept };
}

// Incoming call
app.post("/voice/incoming", async (req, res) => {
  const { CallSid, From, To } = req.body;
  const client = getClientByNumber(To);
  const twiml = new VoiceResponse();

  if (!client) {
    twiml.say("Sorry, this number is not configured. Goodbye.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // Check call limit
  if (client.calls_this_month >= client.call_limit && client.plan !== "business") {
    const voice = client.ai_voice || 'Google.en-GB-Neural2-C';
    const lang = client.ai_voice_language || 'en-GB';
    twiml.say({ voice, language: lang }, `Thank you for calling ${client.business_name}. We have reached our maximum calls for this month. Please call back next month or try our other contact methods. Goodbye.`);
    twiml.hangup();
    console.log(`📵 Call blocked - ${client.email} has used ${client.calls_this_month}/${client.call_limit} calls`);
    return res.type("text/xml").send(twiml.toString());
  }

  // Create session + call record
  const callId = uuidv4();
  const existingSession = db.prepare("SELECT call_sid FROM call_sessions WHERE call_sid = ?").get(CallSid);
  if (!existingSession) {
    db.prepare("INSERT INTO call_sessions (call_sid, client_id) VALUES (?, ?)").run(CallSid, client.id);
    db.prepare("INSERT INTO calls (id, client_id, call_sid, caller_number) VALUES (?, ?, ?, ?)").run(callId, client.id, CallSid, From);
    db.prepare("UPDATE clients SET calls_this_month = calls_this_month + 1 WHERE id = ?").run(client.id);

    // Send 80% usage warning email
    const updatedClient = db.prepare("SELECT calls_this_month, call_limit, email, business_name, plan FROM clients WHERE id = ?").get(client.id);
    if (updatedClient && updatedClient.call_limit > 0) {
      const usagePct = (updatedClient.calls_this_month / updatedClient.call_limit) * 100;
      if (usagePct >= 80 && usagePct < 81) {
        const planNames = { essential:'Essential', starter:'Starter', professional:'Professional', business:'Business' };
        const nextPlan = { essential:'Starter', starter:'Professional', professional:'Business', business:null };
        const next = nextPlan[updatedClient.plan];
        const warningHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
          + '<div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>'
          + '<h2 style="font-size:20px;margin-bottom:16px">⚠️ You have used 80% of your monthly calls</h2>'
          + '<p style="color:#8896a8;line-height:1.7">Hi ' + updatedClient.business_name + ', you have used <strong style="color:#ffb800">' + updatedClient.calls_this_month + ' of ' + updatedClient.call_limit + ' calls</strong> this month on your ' + planNames[updatedClient.plan] + ' plan.</p>'
          + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin:24px 0">'
          + '<p style="color:#f0f4f8;font-size:15px;font-weight:700;margin-bottom:8px">What happens when you reach your limit?</p>'
          + '<p style="color:#8896a8;font-size:13px">Your AI receptionist will stop answering calls until your next billing period.</p>'
          + '</div>'
          + (next ? '<p style="color:#8896a8;line-height:1.7">Upgrade to <strong style="color:#00d4ff">' + planNames[next] + '</strong> to get more calls and avoid any interruption to your service.</p>'
            + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px">'
            + '<a href="https://airingdesk.com/dashboard#billing" style="display:inline-block;background:#00d4ff;color:#020408;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Upgrade to ' + planNames[next] + ' →</a>'
            + '<a href="https://airingdesk.com/dashboard?page=billing" style="display:inline-block;background:transparent;border:1px solid #1a2332;color:#8896a8;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View my usage</a>'
            + '</div>' : '')
          + '<p style="color:#8896a8;font-size:13px;margin-top:24px">AiRingDesk Team · hello@airingdesk.com</p></div>';
        sendBrevoEmail(updatedClient.email, '⚠️ You have used 80% of your AiRingDesk call limit', warningHtml)
          .catch(e => console.error('Usage warning email error:', e.message));
        console.log('📧 80% usage warning sent to:', updatedClient.email);
      }
      // Send 100% limit reached email
      if (usagePct >= 100 && usagePct < 101) {
        const planNames = { essential:'Essential', starter:'Starter', professional:'Professional', business:'Business' };
        const nextPlan = { essential:'Starter', starter:'Professional', professional:'Business', business:null };
        const next = nextPlan[updatedClient.plan];
        const limitHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
          + '<div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>'
          + '<h2 style="font-size:20px;margin-bottom:16px;color:#ff4466">🚫 You have reached your monthly call limit</h2>'
          + '<p style="color:#8896a8;line-height:1.7">Hi ' + updatedClient.business_name + ', you have used all <strong style="color:#ff4466">' + updatedClient.call_limit + ' calls</strong> on your ' + planNames[updatedClient.plan] + ' plan this month.</p>'
          + '<div style="background:#0d1117;border:1px solid rgba(255,68,102,.3);border-radius:12px;padding:20px;margin:24px 0">'
          + '<p style="color:#f0f4f8;font-size:15px;font-weight:700;margin-bottom:8px">Your AI receptionist is now offline</p>'
          + '<p style="color:#8896a8;font-size:13px">Callers will hear a message that you have reached your call limit. Upgrade now to restore service immediately.</p>'
          + '</div>'
          + (next ? '<p style="color:#8896a8;line-height:1.7;margin-bottom:16px">Upgrade to <strong style="color:#00d4ff">' + planNames[next] + '</strong> to restore your AI receptionist immediately.</p>'
            + '<div style="display:flex;gap:12px;flex-wrap:wrap">'
            + '<a href="https://airingdesk.com/dashboard#billing" style="display:inline-block;background:#ff4466;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Restore service now →</a>'
            + '<a href="https://airingdesk.com/dashboard" style="display:inline-block;background:transparent;border:1px solid #1a2332;color:#8896a8;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View my account</a>'
            + '</div>' : '<p style="color:#8896a8">Your service will resume automatically on your next billing date.</p>')
          + '<p style="color:#8896a8;font-size:13px;margin-top:24px">Need help? Reply to this email or contact hello@airingdesk.com</p>'
          + '<p style="color:#8896a8;font-size:13px">AiRingDesk Team</p></div>';
        sendBrevoEmail(updatedClient.email, '🚫 Your AiRingDesk call limit has been reached', limitHtml)
          .catch(e => console.error('Limit email error:', e.message));
        // Also notify superadmin
        sendBrevoEmail(process.env.NOTIFY_EMAIL,
          '[AiRingDesk] Call limit reached: ' + updatedClient.business_name,
          '<p><strong>' + updatedClient.business_name + '</strong> (' + updatedClient.email + ') has reached their ' + updatedClient.call_limit + ' call limit on the ' + planNames[updatedClient.plan] + ' plan.</p><p><a href="https://airingdesk.com/dashboard">View in admin →</a></p>'
        ).catch(e => {});
        console.log('📧 100% limit email sent to:', updatedClient.email);
      }
    }
  }

  // Use instant static greeting — no Claude call on incoming to avoid delays
  const aiName = client.ai_name || "Aria";
  const greeting = `Thank you for calling ${client.business_name}. My name is ${aiName}, how can I help you today?`;

  const gather = twiml.gather({ input: "speech", action: "/voice/speech", method: "POST", speechTimeout: "auto", actionOnEmptyResult: true, timeout: 5, language: "en-GB", speechModel: "phone_call", enhanced: true });
  gather.say({ voice: client.ai_voice || 'Google.en-GB-Neural2-C', language: client.ai_voice_language || 'en-GB' }, greeting);
  twiml.redirect("/voice/incoming");

  res.type("text/xml").send(twiml.toString());
});

// Handle speech
app.post("/voice/speech", async (req, res) => {
  const { CallSid, To, SpeechResult } = req.body;
  const client = getClientByNumber(To);
  const session = db.prepare("SELECT * FROM call_sessions WHERE call_sid = ?").get(CallSid);
  const twiml = new VoiceResponse();

  if (!client || !session) {
    twiml.say("I am sorry, something went wrong. Please call again.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  if (!SpeechResult || SpeechResult.trim() === "") {
    const gather = twiml.gather({ input: "speech", action: "/voice/speech", method: "POST", speechTimeout: "auto", actionOnEmptyResult: true, timeout: 5, language: "en-GB", speechModel: "phone_call", enhanced: true });
    gather.say({ voice: client.ai_voice || 'Google.en-GB-Neural2-C', language: client.ai_voice_language || 'en-GB' }, "I am sorry, I did not catch that. Could you say that again?");
    return res.type("text/xml").send(twiml.toString());
  }

  try {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('timeout')), 4000)
    );
    let { reply, transferDept } = await Promise.race([
      askClaude(client, session, SpeechResult),
      timeoutPromise
    ]);
    // Handle booking trigger
        const bookMatch = reply.match(/\[BOOK:([^|\]]+)\|([^|\]]+)\|([^|\]]+)\|([^\]]+)\]/);
    if (bookMatch) {
      const [, name, date, time, email] = bookMatch;
      reply = reply.replace(/\[BOOK:[^\]]+\]/, '').trim();
      // Book appointment asynchronously
      const clientData = db.prepare("SELECT * FROM clients WHERE id = ?").get(client.id);
      if (clientData.google_calendar_connected && clientData.google_access_token) {
        // Fire and forget — don't await to avoid Twilio timeout
        (async () => { try {
          const { google } = require('googleapis');
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
          );
          oauth2Client.setCredentials({
            access_token: clientData.google_access_token,
            refresh_token: clientData.google_refresh_token
          });
          const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
          const startDateTime = new Date(`${date}T${time}:00`);
          const endDateTime = new Date(startDateTime.getTime() + 60 * 60000);
          await calendar.events.insert({
            calendarId: 'primary',
            resource: {
              summary: `Appointment - ${name}`,
              description: `Booked via AiRingDesk AI receptionist`,
              start: { dateTime: startDateTime.toISOString(), timeZone: 'Europe/London' },
              end: { dateTime: endDateTime.toISOString(), timeZone: 'Europe/London' },
              attendees: (email && email !== 'none' && email.includes('@')) ? [{ email }] : []
            },
            sendUpdates: 'all'
          });
          console.log(`✅ Appointment booked for ${name} on ${date} at ${time}`);
          try {
            const apptId = uuidv4();
            const callRecord = db.prepare("SELECT id FROM calls WHERE call_sid = ?").get(CallSid);
            const callerPhone = db.prepare("SELECT caller_number FROM calls WHERE call_sid = ?").get(CallSid)?.caller_number || null;
            db.prepare(`INSERT INTO appointments (id, client_id, call_id, caller_name, caller_phone, date, time, google_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(apptId, client.id, callRecord?.id || null, name, callerPhone, date, time, result?.data?.id || null);
            console.log(`📅 Appointment saved to DB: ${name} on ${date} at ${time}`);
          } catch(dbErr) {
            console.error("Appointment DB save error:", dbErr.message);
          }
        } catch(e) {
          console.error('Booking error:', e.message);
        }
        })();
        if (!reply) reply = `Perfect, I've booked your appointment for ${date} at ${time}. You'll receive a confirmation email shortly.`;
      } else {
        if (!reply) reply = `I've noted your appointment request for ${date} at ${time}. Our team will confirm shortly.`;
      }
    }

    const voicemailMatch = reply.includes('[VOICEMAIL]');
    if (voicemailMatch) {
      let vmReply = reply.replace('[VOICEMAIL]', '').trim() || 'Please hold while I transfer you to voicemail.';
      reply = vmReply;
      twiml.say({ voice: client.ai_voice || 'Google.en-GB-Neural2-C', language: client.ai_voice_language || 'en-GB' }, reply);
      twiml.redirect("/voice/voicemail");
    } else if (transferDept) {
      twiml.say({ voice: client.ai_voice || 'Google.en-GB-Neural2-C', language: client.ai_voice_language || 'en-GB' }, reply);
      twiml.pause({ length: 1 });
      twiml.redirect("/voice/transfer?dept=" + transferDept + "&callSid=" + CallSid + "&clientId=" + client.id);
    } else {
      const gather = twiml.gather({ input: "speech", action: "/voice/speech", method: "POST", speechTimeout: "auto", actionOnEmptyResult: true, timeout: 5, language: "en-GB", speechModel: "phone_call", enhanced: true });
      gather.say({ voice: client.ai_voice || 'Google.en-GB-Neural2-C', language: client.ai_voice_language || 'en-GB' }, reply);
      twiml.redirect("/voice/speech");
    }
  } catch (err) {
    console.error("Claude error:", err.message);
    const gather = twiml.gather({ input: "speech", action: "/voice/speech", method: "POST", speechTimeout: "auto", actionOnEmptyResult: true, timeout: 5, language: "en-GB", speechModel: "phone_call", enhanced: true });
    gather.say({ voice: client.ai_voice || 'Google.en-GB-Neural2-C', language: client.ai_voice_language || 'en-GB' }, "One moment please, could you repeat that?");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── Voicemail recording route ─────────────────────────────────────────────────
app.post("/voice/voicemail", (req, res) => {
  const { CallSid, To } = req.body;
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Google.en-GB-Neural2-C' }, "Please leave your message after the tone. Press any key or hang up when done.");
  twiml.record({
    action: '/voice/voicemail-done',
    method: 'POST',
    maxLength: 120,
    finishOnKey: '*',
    playBeep: true,
    recordingStatusCallback: '/voice/voicemail-done',
    recordingStatusCallbackMethod: 'POST'
  });
  twiml.say({ voice: 'Google.en-GB-Neural2-C' }, "Thank you for your message. Goodbye.");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

app.post("/voice/voicemail-done", (req, res) => {
  const { CallSid, RecordingUrl, RecordingDuration } = req.body;
  if (RecordingUrl && CallSid) {
    db.prepare("UPDATE calls SET recording_url = ?, status = 'voicemail' WHERE call_sid = ?")
      .run(RecordingUrl, CallSid);
    console.log(`✅ Voicemail saved for ${CallSid}: ${RecordingUrl}`);
  }
  res.sendStatus(200);
});

// Call status callback
app.post("/voice/status", async (req, res) => {
  const { CallSid, CallDuration, CallStatus } = req.body;

  // Get session BEFORE deleting it
  const session = db.prepare("SELECT * FROM call_sessions WHERE call_sid = ?").get(CallSid);
  const history = session ? JSON.parse(session.history || '[]') : [];
  const callerName = session ? session.caller_name : null;

  // Generate AI summary of the conversation
  let summary = null;
  if (history.length > 0) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const summaryResp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Summarise this call clearly in plain text (no markdown, no asterisks). Include: caller name, reason for call, contact details given (phone, email, address, postcode), and what action is needed next. Keep it concise and professional.\n\nTranscript:\n${history.map(m => m.role + ': ' + m.content).join('\n')}`
        }]
      }, { timeout: 10000 });
      summary = summaryResp.content[0]?.text || null;
    } catch(e) { console.error('Summary error:', e.message); }
  }

  // Save transcript, summary and caller name to calls table
  db.prepare("UPDATE calls SET duration = ?, status = CASE WHEN status = 'active' THEN 'completed' ELSE status END, ended_at = ?, transcript = ?, summary = ?, caller_name = ? WHERE call_sid = ?")
    .run(parseInt(CallDuration || 0), Math.floor(Date.now() / 1000), JSON.stringify(history), summary, callerName, CallSid);

  // Now delete the session
  db.prepare("DELETE FROM call_sessions WHERE call_sid = ?").run(CallSid);

  try {
    const call = db.prepare("SELECT * FROM calls WHERE call_sid = ?").get(CallSid);
    if (call) {
      const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(call.client_id);
      if (client && client.email_notifications) {
        let transcript = [];
        try { transcript = JSON.parse(call.transcript || '[]'); } catch {}
        sendCallNotificationEmail(client, call, transcript);
      }
    }
  } catch(err) { console.error('Email notification error:', err.message); }

  // Deliver webhook if configured
  try {
    const webhookCall = db.prepare("SELECT * FROM calls WHERE call_sid = ?").get(CallSid);
    if (webhookCall) {
      const webhookClient = db.prepare("SELECT * FROM clients WHERE id = ?").get(webhookCall.client_id);
      if (webhookClient && webhookClient.webhook_url) {
        let webhookTranscript = [];
        try { webhookTranscript = JSON.parse(webhookCall.transcript || '[]'); } catch {}
        deliverWebhook(webhookClient, webhookCall, webhookTranscript);
      }
    }
  } catch(err) { console.error('Webhook error:', err.message); }
  res.sendStatus(200);
});


// ── System settings DB migration
db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);
// Default referral settings
const defaultSettings = [
  ['referral_enabled', 'true'],
  ['referral_discount_per_referral', '10'],
  ['referral_max_discount', '30'],
  ['referral_qualifying_days', '30'],
  ['referral_max_referrals', '0'],
  ['referral_daily_limit', '10'],
];
const insertSetting = db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)');
defaultSettings.forEach(([k, v]) => insertSetting.run(k, v));

// ── Referral system DB migration ─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL,
    referee_email TEXT NOT NULL,
    referee_id TEXT,
    status TEXT DEFAULT 'pending',
    sent_at INTEGER DEFAULT (strftime('%s','now')),
    activated_at INTEGER,
    FOREIGN KEY(referrer_id) REFERENCES clients(id)
  );
  CREATE TABLE IF NOT EXISTS referral_discounts (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    month TEXT NOT NULL,
    active_referrals INTEGER DEFAULT 0,
    discount_amount INTEGER DEFAULT 0,
    applied INTEGER DEFAULT 0,
    FOREIGN KEY(client_id) REFERENCES clients(id)
  );
`);
try {
  db.exec('ALTER TABLE clients ADD COLUMN referral_code TEXT');
  db.exec('ALTER TABLE clients ADD COLUMN referred_by TEXT');
  db.exec('ALTER TABLE clients ADD COLUMN referral_discount INTEGER DEFAULT 0');
  db.exec('ALTER TABLE clients ADD COLUMN subscription_ends_at INTEGER');
  db.exec('ALTER TABLE clients ADD COLUMN referral_programme_enabled INTEGER DEFAULT 1');
} catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN role TEXT DEFAULT 'client'"); } catch(e) {}
// Leads table
db.exec(`CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  business_name TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  industry TEXT,
  message TEXT,
  status TEXT DEFAULT 'new',
  source TEXT DEFAULT 'website',
  created_at INTEGER DEFAULT (strftime('%s','now'))
)`);
try { db.exec("ALTER TABLE clients ADD COLUMN admin_permissions TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN admin_active INTEGER DEFAULT 1"); } catch(e) {}
// Set superadmin role
db.prepare("UPDATE clients SET role = 'superadmin' WHERE email = 'ringdeskai@gmail.com'").run();
try {
  db.exec('ALTER TABLE referrals ADD COLUMN qualifying_since INTEGER');
  db.exec('ALTER TABLE referrals ADD COLUMN qualified INTEGER DEFAULT 0');
} catch(e) {}
// Generate referral codes for existing clients
const clientsWithoutCode = db.prepare("SELECT id, business_name FROM clients WHERE referral_code IS NULL").all();
clientsWithoutCode.forEach(c => {
  const code = c.business_name.replace(/[^a-zA-Z0-9]/g,'').toUpperCase().substring(0,6) + Math.random().toString(36).substring(2,5).toUpperCase();
  db.prepare("UPDATE clients SET referral_code = ? WHERE id = ?").run(code, c.id);
});

// ── Health & Admin ─────────────────────────────────────────────────────────────
// ── Google Calendar Integration ───────────────────────────────────────────────
const { google } = require('googleapis');

function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// ── Google OAuth LOGIN (separate from Calendar OAuth) ─────────────────
app.get('/auth/google/login', (req, res) => {
  const loginRedirectUri = process.env.DASHBOARD_URL + '/auth/google/login/callback';
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    loginRedirectUri
  );
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]
  });
  res.redirect(url);
});

app.get('/auth/google/login/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?error=google_login_failed');
  try {
    const loginRedirectUri = process.env.DASHBOARD_URL + '/auth/google/login/callback';
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      loginRedirectUri
    );
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const { google } = require('googleapis');
    const people = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await people.userinfo.get();
    const { email, name, given_name, family_name, picture } = userInfo.data;

    if (!email) return res.redirect('/dashboard?error=google_login_failed');

    // Check if user exists
    let client = db.prepare("SELECT * FROM clients WHERE email = ?").get(email);

    if (!client) {
      // Auto-register new client
      const { v4: uuidv4 } = require('uuid');
      const id = uuidv4();
      const randomPass = require('crypto').randomBytes(32).toString('hex');
      const password_hash = await require('bcryptjs').hash(randomPass, 12);
      const lastCust = db.prepare("SELECT customer_number FROM clients WHERE role = 'client' AND customer_number IS NOT NULL ORDER BY created_at DESC LIMIT 1").get();
      const custNextNum = lastCust && lastCust.customer_number ? (parseInt(lastCust.customer_number.replace('ARD-','')) || 0) + 1 : 1;
      const customerNumber = 'ARD-' + String(custNextNum).padStart(5, '0');
      const business_name = name || email.split('@')[0];

      let stripeCustomerId = null;
      try {
        const customer = stripe ? await stripe.customers.create({ email, name: business_name }) : { id: null };
        stripeCustomerId = customer.id;
      } catch(e) { console.error('Stripe error:', e.message); }

      const defaultPrompt = `You are ${business_name}'s AI receptionist. Be professional, warm, and helpful. Keep responses under 40 words. If the caller wants to leave a voicemail, reply with exactly [VOICEMAIL].`;

      db.prepare(`INSERT INTO clients (id, business_name, email, password_hash, stripe_customer_id, ai_prompt, customer_number, role, first_name, last_name, email_verified, voicemail_enabled, feature_email, feature_appointments, feature_ai_settings, feature_voice_selector, feature_crm, call_recording, show_demo_banner)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'client', ?, ?, 1, 0, 1, 0, 0, 0, 0, 0, 1)`)
        .run(id, business_name, email, password_hash, stripeCustomerId, defaultPrompt, customerNumber, given_name||'', family_name||'');

      client = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
      console.log('✅ New client auto-registered via Google:', email);

      // Send welcome email
      try { sendWelcomeEmail(business_name, email, null, id); } catch(e) {}
    }

    // Check account is active
    if (client.email_verified === 0)
      db.prepare("UPDATE clients SET email_verified = 1 WHERE id = ?").run(client.id);

    // Generate JWT
    const token = jwt.sign(
      { id: client.id, email: client.email, business_name: client.business_name, role: client.role || 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Redirect to dashboard with token
    res.send(`<!DOCTYPE html>
<html><head><title>Signing in...</title></head>
<body style="background:#020408;color:#f0f6ff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:24px;font-weight:800;margin-bottom:16px"><span style="color:#00d4ff">Ai</span><span>Ring</span><span style="color:#5a7a9a">Desk</span></div>
  <div style="color:#5a7a9a;margin-bottom:8px">Signing you in...</div>
</div>
<script>
  localStorage.setItem('rd_token', ${JSON.stringify(token)});
  localStorage.setItem('rd_user', JSON.stringify(${JSON.stringify(JSON.stringify({ id: client.id, business_name: client.business_name, email: client.email, plan: client.plan, phone_number: client.phone_number, role: client.role || 'client' }))}));
  window.location.href = '/dashboard';
</script>
</body></html>`);

  } catch(err) {
    console.error('Google login error:', err.message, err.stack);
    res.redirect('/dashboard?error=google_login_failed');
  }
});

// Step 1: Redirect customer to Google OAuth
app.get('/auth/google', async (req, res) => {
  // Support token via query param for browser redirects
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const jwt = require('jsonwebtoken');
    req.client = jwt.verify(token, process.env.JWT_SECRET);
  } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
  const oauth2Client = getGoogleOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: req.client.id
  });
  res.redirect(url);
});

// Step 2: Google callback — save tokens
app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.redirect('/dashboard?error=google_auth_failed');
  try {
    const oauth2Client = getGoogleOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    db.prepare("UPDATE clients SET google_access_token = ?, google_refresh_token = ?, google_calendar_connected = 1 WHERE id = ?")
      .run(tokens.access_token, tokens.refresh_token || null, state);
    console.log(`✅ Google Calendar connected for client ${state}`);
    res.redirect('/dashboard?google=connected');
  } catch(err) {
    console.error('Google auth error:', err.message);
    res.redirect('/dashboard?error=google_auth_failed');
  }
});

// Step 3: Book appointment to Google Calendar
app.post('/api/calendar/book', authRequired, async (req, res) => {
  const { title, date, time, duration, description, attendee_email } = req.body;
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);
  if (!client.google_calendar_connected) return res.status(400).json({ error: 'Google Calendar not connected' });
  try {
    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials({
      access_token: client.google_access_token,
      refresh_token: client.google_refresh_token
    });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const startDateTime = new Date(`${date}T${time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + (duration || 60) * 60000);
    const event = {
      summary: title || 'Appointment',
      description: description || '',
      start: { dateTime: startDateTime.toISOString(), timeZone: 'Europe/London' },
      end: { dateTime: endDateTime.toISOString(), timeZone: 'Europe/London' },
      attendees: attendee_email ? [{ email: attendee_email }] : []
    };
    const result = await calendar.events.insert({ calendarId: 'primary', resource: event, sendUpdates: 'all' });
    res.json({ success: true, eventId: result.data.id, eventLink: result.data.htmlLink });
  } catch(err) {
    console.error('Calendar booking error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get calendar connection status
app.get('/api/calendar/status', authRequired, (req, res) => {
  const client = db.prepare("SELECT google_calendar_connected FROM clients WHERE id = ?").get(req.client.id);
  res.json({ connected: !!client?.google_calendar_connected });
});

// Disconnect Google Calendar
app.post('/api/calendar/disconnect', authRequired, (req, res) => {
  db.prepare("UPDATE clients SET google_access_token = NULL, google_refresh_token = NULL, google_calendar_connected = 0 WHERE id = ?").run(req.client.id);
  res.json({ success: true });
});

// ── Delete customer (superadmin only) ─────────────────────────────────────────
app.delete("/api/admin/customer/:id", authRequired, (req, res) => {
  if (req.client.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
  const { id } = req.params;
  const customer = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (customer.role === 'superadmin') return res.status(403).json({ error: 'Cannot delete superadmin' });
  db.prepare("DELETE FROM call_sessions WHERE client_id = ?").run(id);
  db.prepare("DELETE FROM clients WHERE id = ?").run(id);
  console.log(`🗑️ Customer deleted: ${customer.business_name} (${customer.email}) by ${req.client.email}`);
  res.json({ success: true, message: `${customer.business_name} deleted` });
});

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), clients: db.prepare("SELECT COUNT(*) as c FROM clients").get().c }));


app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/get-number', (req, res) => res.sendFile(__dirname + '/public/get-number.html'));
app.get('/about', (req, res) => res.sendFile(__dirname + '/public/about.html'));
app.get('/contact', (req, res) => res.sendFile(__dirname + '/public/contact.html'));
app.get('/support', (req, res) => res.sendFile(__dirname + '/public/support.html'));
app.get('/privacy', (req, res) => res.sendFile(__dirname + '/public/privacy.html'));
app.get('/terms', (req, res) => res.sendFile(__dirname + '/public/terms.html'));
app.get('/industries/dental', (req, res) => res.sendFile(__dirname + '/public/industries/dental.html'));
app.get('/industries/plumbers', (req, res) => res.sendFile(__dirname + '/public/industries/plumbers.html'));
app.get('/industries/estate-agents', (req, res) => res.sendFile(__dirname + '/public/industries/estate-agents.html'));
app.get('/industries/solicitors', (req, res) => res.sendFile(__dirname + '/public/industries/solicitors.html'));
app.get('/industries/medical', (req, res) => res.sendFile(__dirname + '/public/industries/medical.html'));
app.get('/industries/builders', (req, res) => res.sendFile(__dirname + '/public/industries/builders.html'));
app.get('/industries/electricians', (req, res) => res.sendFile(__dirname + '/public/industries/electricians.html'));
app.get('/industries/salons', (req, res) => res.sendFile(__dirname + '/public/industries/salons.html'));
app.get('/industries/restaurants', (req, res) => res.sendFile(__dirname + '/public/industries/restaurants.html'));
app.get('/industries/accountants', (req, res) => res.sendFile(__dirname + '/public/industries/accountants.html'));
app.get('/industries/letting-agents', (req, res) => res.sendFile(__dirname + '/public/industries/letting-agents.html'));
app.get('/industries/handymen', (req, res) => res.sendFile(__dirname + '/public/industries/handymen.html'));
app.get('/industries/veterinary', (req, res) => res.sendFile(__dirname + '/public/industries/veterinary.html'));
app.get('/locations/westminster', (req, res) => res.sendFile(__dirname + '/public/locations/westminster.html'));
app.get('/locations/camden', (req, res) => res.sendFile(__dirname + '/public/locations/camden.html'));
app.get('/locations/islington', (req, res) => res.sendFile(__dirname + '/public/locations/islington.html'));
app.get('/locations/hackney', (req, res) => res.sendFile(__dirname + '/public/locations/hackney.html'));
app.get('/locations/tower-hamlets', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets.html'));
app.get('/locations/southwark', (req, res) => res.sendFile(__dirname + '/public/locations/southwark.html'));
app.get('/locations/lambeth', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth.html'));
app.get('/locations/wandsworth', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth.html'));
app.get('/locations/hammersmith', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith.html'));
app.get('/locations/kensington', (req, res) => res.sendFile(__dirname + '/public/locations/kensington.html'));
app.get('/locations/croydon', (req, res) => res.sendFile(__dirname + '/public/locations/croydon.html'));
app.get('/locations/bromley', (req, res) => res.sendFile(__dirname + '/public/locations/bromley.html'));
app.get('/locations/lewisham', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham.html'));
app.get('/locations/greenwich', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich.html'));
app.get('/locations/bexley', (req, res) => res.sendFile(__dirname + '/public/locations/bexley.html'));
app.get('/locations/havering', (req, res) => res.sendFile(__dirname + '/public/locations/havering.html'));
app.get('/locations/barking', (req, res) => res.sendFile(__dirname + '/public/locations/barking.html'));
app.get('/locations/redbridge', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge.html'));
app.get('/locations/newham', (req, res) => res.sendFile(__dirname + '/public/locations/newham.html'));
app.get('/locations/waltham-forest', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest.html'));
app.get('/locations/haringey', (req, res) => res.sendFile(__dirname + '/public/locations/haringey.html'));
app.get('/locations/enfield', (req, res) => res.sendFile(__dirname + '/public/locations/enfield.html'));
app.get('/locations/barnet', (req, res) => res.sendFile(__dirname + '/public/locations/barnet.html'));
app.get('/locations/harrow', (req, res) => res.sendFile(__dirname + '/public/locations/harrow.html'));
app.get('/locations/hillingdon', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon.html'));
app.get('/locations/ealing', (req, res) => res.sendFile(__dirname + '/public/locations/ealing.html'));
app.get('/locations/hounslow', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow.html'));
app.get('/locations/richmond', (req, res) => res.sendFile(__dirname + '/public/locations/richmond.html'));
app.get('/locations/kingston', (req, res) => res.sendFile(__dirname + '/public/locations/kingston.html'));
app.get('/locations/merton', (req, res) => res.sendFile(__dirname + '/public/locations/merton.html'));
app.get('/locations/sutton', (req, res) => res.sendFile(__dirname + '/public/locations/sutton.html'));
app.get('/locations/city-of-london', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london.html'));
app.get('/locations/manchester', (req, res) => res.sendFile(__dirname + '/public/locations/manchester.html'));
app.get('/locations/birmingham', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham.html'));
app.get('/locations/leeds', (req, res) => res.sendFile(__dirname + '/public/locations/leeds.html'));
app.get('/locations/sheffield', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield.html'));
app.get('/locations/liverpool', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool.html'));
app.get('/locations/bristol', (req, res) => res.sendFile(__dirname + '/public/locations/bristol.html'));
app.get('/locations/nottingham', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham.html'));
app.get('/locations/leicester', (req, res) => res.sendFile(__dirname + '/public/locations/leicester.html'));
app.get('/locations/coventry', (req, res) => res.sendFile(__dirname + '/public/locations/coventry.html'));
app.get('/locations/bradford', (req, res) => res.sendFile(__dirname + '/public/locations/bradford.html'));
app.get('/locations/stoke', (req, res) => res.sendFile(__dirname + '/public/locations/stoke.html'));
app.get('/locations/wolverhampton', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton.html'));
app.get('/locations/plymouth', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth.html'));
app.get('/locations/derby', (req, res) => res.sendFile(__dirname + '/public/locations/derby.html'));
app.get('/locations/southampton', (req, res) => res.sendFile(__dirname + '/public/locations/southampton.html'));
app.get('/locations/portsmouth', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth.html'));
app.get('/locations/reading', (req, res) => res.sendFile(__dirname + '/public/locations/reading.html'));
app.get('/locations/milton-keynes', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes.html'));
app.get('/locations/norwich', (req, res) => res.sendFile(__dirname + '/public/locations/norwich.html'));
app.get('/locations/luton', (req, res) => res.sendFile(__dirname + '/public/locations/luton.html'));
app.get('/locations/newcastle', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle.html'));
app.get('/locations/sunderland', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland.html'));
app.get('/locations/exeter', (req, res) => res.sendFile(__dirname + '/public/locations/exeter.html'));
app.get('/locations/oxford', (req, res) => res.sendFile(__dirname + '/public/locations/oxford.html'));
app.get('/locations/cambridge', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge.html'));
app.get('/locations/brighton', (req, res) => res.sendFile(__dirname + '/public/locations/brighton.html'));
app.get('/locations/york', (req, res) => res.sendFile(__dirname + '/public/locations/york.html'));
app.get('/locations/bath', (req, res) => res.sendFile(__dirname + '/public/locations/bath.html'));
app.get('/locations/gloucester', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester.html'));
app.get('/locations/ipswich', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich.html'));
app.get('/locations/peterborough', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough.html'));
app.get('/locations/swansea', (req, res) => res.sendFile(__dirname + '/public/locations/swansea.html'));
app.get('/locations/edinburgh', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh.html'));
app.get('/locations/glasgow', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow.html'));
app.get('/locations/aberdeen', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen.html'));
app.get('/locations/dundee', (req, res) => res.sendFile(__dirname + '/public/locations/dundee.html'));
app.get('/locations/cardiff', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff.html'));
app.get('/locations/belfast', (req, res) => res.sendFile(__dirname + '/public/locations/belfast.html'));
app.get('/locations/westminster/mayfair', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/mayfair.html'));
app.get('/locations/westminster/soho', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/soho.html'));
app.get('/locations/westminster/pimlico', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/pimlico.html'));
app.get('/locations/westminster/marylebone', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/marylebone.html'));
app.get('/locations/westminster/bayswater', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/bayswater.html'));
app.get('/locations/westminster/paddington', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/paddington.html'));
app.get('/locations/westminster/victoria', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/victoria.html'));
app.get('/locations/westminster/belgravia', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/belgravia.html'));
app.get('/locations/westminster/st-james', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/st-james.html'));
app.get('/locations/westminster/covent-garden', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/covent-garden.html'));
app.get('/locations/camden/hampstead', (req, res) => res.sendFile(__dirname + '/public/locations/camden/hampstead.html'));
app.get('/locations/camden/kentish-town', (req, res) => res.sendFile(__dirname + '/public/locations/camden/kentish-town.html'));
app.get('/locations/camden/kilburn', (req, res) => res.sendFile(__dirname + '/public/locations/camden/kilburn.html'));
app.get('/locations/camden/primrose-hill', (req, res) => res.sendFile(__dirname + '/public/locations/camden/primrose-hill.html'));
app.get('/locations/camden/belsize-park', (req, res) => res.sendFile(__dirname + '/public/locations/camden/belsize-park.html'));
app.get('/locations/camden/gospel-oak', (req, res) => res.sendFile(__dirname + '/public/locations/camden/gospel-oak.html'));
app.get('/locations/camden/holborn', (req, res) => res.sendFile(__dirname + '/public/locations/camden/holborn.html'));
app.get('/locations/camden/bloomsbury', (req, res) => res.sendFile(__dirname + '/public/locations/camden/bloomsbury.html'));
app.get('/locations/camden/kings-cross', (req, res) => res.sendFile(__dirname + '/public/locations/camden/kings-cross.html'));
app.get('/locations/camden/chalk-farm', (req, res) => res.sendFile(__dirname + '/public/locations/camden/chalk-farm.html'));
app.get('/locations/islington/highbury', (req, res) => res.sendFile(__dirname + '/public/locations/islington/highbury.html'));
app.get('/locations/islington/canonbury', (req, res) => res.sendFile(__dirname + '/public/locations/islington/canonbury.html'));
app.get('/locations/islington/finsbury-park', (req, res) => res.sendFile(__dirname + '/public/locations/islington/finsbury-park.html'));
app.get('/locations/islington/holloway', (req, res) => res.sendFile(__dirname + '/public/locations/islington/holloway.html'));
app.get('/locations/islington/angel', (req, res) => res.sendFile(__dirname + '/public/locations/islington/angel.html'));
app.get('/locations/islington/barnsbury', (req, res) => res.sendFile(__dirname + '/public/locations/islington/barnsbury.html'));
app.get('/locations/islington/clerkenwell', (req, res) => res.sendFile(__dirname + '/public/locations/islington/clerkenwell.html'));
app.get('/locations/islington/archway', (req, res) => res.sendFile(__dirname + '/public/locations/islington/archway.html'));
app.get('/locations/islington/tufnell-park', (req, res) => res.sendFile(__dirname + '/public/locations/islington/tufnell-park.html'));
app.get('/locations/islington/caledonian-road', (req, res) => res.sendFile(__dirname + '/public/locations/islington/caledonian-road.html'));
app.get('/locations/hackney/stoke-newington', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/stoke-newington.html'));
app.get('/locations/hackney/dalston', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/dalston.html'));
app.get('/locations/hackney/shoreditch', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/shoreditch.html'));
app.get('/locations/hackney/homerton', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/homerton.html'));
app.get('/locations/hackney/clapton', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/clapton.html'));
app.get('/locations/hackney/london-fields', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/london-fields.html'));
app.get('/locations/hackney/bethnal-green', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/bethnal-green.html'));
app.get('/locations/hackney/haggerston', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/haggerston.html'));
app.get('/locations/hackney/de-beauvoir', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/de-beauvoir.html'));
app.get('/locations/hackney/victoria-park', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/victoria-park.html'));
app.get('/locations/tower-hamlets/whitechapel', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/whitechapel.html'));
app.get('/locations/tower-hamlets/stepney', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/stepney.html'));
app.get('/locations/tower-hamlets/bow', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/bow.html'));
app.get('/locations/tower-hamlets/poplar', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/poplar.html'));
app.get('/locations/tower-hamlets/canary-wharf', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/canary-wharf.html'));
app.get('/locations/tower-hamlets/mile-end', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/mile-end.html'));
app.get('/locations/tower-hamlets/limehouse', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/limehouse.html'));
app.get('/locations/tower-hamlets/wapping', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/wapping.html'));
app.get('/locations/tower-hamlets/spitalfields', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/spitalfields.html'));
app.get('/locations/tower-hamlets/shadwell', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/shadwell.html'));
app.get('/locations/southwark/bermondsey', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/bermondsey.html'));
app.get('/locations/southwark/peckham', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/peckham.html'));
app.get('/locations/southwark/dulwich', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/dulwich.html'));
app.get('/locations/southwark/camberwell', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/camberwell.html'));
app.get('/locations/southwark/borough', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/borough.html'));
app.get('/locations/southwark/elephant-castle', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/elephant-castle.html'));
app.get('/locations/southwark/new-cross', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/new-cross.html'));
app.get('/locations/southwark/nunhead', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/nunhead.html'));
app.get('/locations/southwark/east-dulwich', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/east-dulwich.html'));
app.get('/locations/southwark/herne-hill', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/herne-hill.html'));
app.get('/locations/lambeth/brixton', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/brixton.html'));
app.get('/locations/lambeth/streatham', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/streatham.html'));
app.get('/locations/lambeth/clapham', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/clapham.html'));
app.get('/locations/lambeth/stockwell', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/stockwell.html'));
app.get('/locations/lambeth/norwood', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/norwood.html'));
app.get('/locations/lambeth/vauxhall', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/vauxhall.html'));
app.get('/locations/lambeth/kennington', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/kennington.html'));
app.get('/locations/lambeth/tulse-hill', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/tulse-hill.html'));
app.get('/locations/lambeth/west-norwood', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/west-norwood.html'));
app.get('/locations/lambeth/balham', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/balham.html'));
app.get('/locations/wandsworth/tooting', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/tooting.html'));
app.get('/locations/wandsworth/battersea', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/battersea.html'));
app.get('/locations/wandsworth/putney', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/putney.html'));
app.get('/locations/wandsworth/balham', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/balham.html'));
app.get('/locations/wandsworth/earlsfield', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/earlsfield.html'));
app.get('/locations/wandsworth/southfields', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/southfields.html'));
app.get('/locations/wandsworth/clapham-junction', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/clapham-junction.html'));
app.get('/locations/wandsworth/furzedown', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/furzedown.html'));
app.get('/locations/wandsworth/west-hill', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/west-hill.html'));
app.get('/locations/wandsworth/roehampton', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/roehampton.html'));
app.get('/locations/hammersmith/shepherds-bush', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/shepherds-bush.html'));
app.get('/locations/hammersmith/fulham', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/fulham.html'));
app.get('/locations/hammersmith/chiswick', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/chiswick.html'));
app.get('/locations/hammersmith/brook-green', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/brook-green.html'));
app.get('/locations/hammersmith/ravenscourt-park', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/ravenscourt-park.html'));
app.get('/locations/hammersmith/stamford-brook', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/stamford-brook.html'));
app.get('/locations/hammersmith/parsons-green', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/parsons-green.html'));
app.get('/locations/hammersmith/munster-village', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/munster-village.html'));
app.get('/locations/hammersmith/white-city', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/white-city.html'));
app.get('/locations/hammersmith/barons-court', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/barons-court.html'));
app.get('/locations/kensington/chelsea', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/chelsea.html'));
app.get('/locations/kensington/notting-hill', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/notting-hill.html'));
app.get('/locations/kensington/kensington', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/kensington.html'));
app.get('/locations/kensington/south-kensington', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/south-kensington.html'));
app.get('/locations/kensington/earls-court', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/earls-court.html'));
app.get('/locations/kensington/holland-park', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/holland-park.html'));
app.get('/locations/kensington/knightsbridge', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/knightsbridge.html'));
app.get('/locations/kensington/west-brompton', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/west-brompton.html'));
app.get('/locations/kensington/brompton', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/brompton.html'));
app.get('/locations/kensington/ladbroke-grove', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/ladbroke-grove.html'));
app.get('/locations/croydon/thornton-heath', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/thornton-heath.html'));
app.get('/locations/croydon/norbury', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/norbury.html'));
app.get('/locations/croydon/purley', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/purley.html'));
app.get('/locations/croydon/coulsdon', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/coulsdon.html'));
app.get('/locations/croydon/sanderstead', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/sanderstead.html'));
app.get('/locations/croydon/selsdon', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/selsdon.html'));
app.get('/locations/croydon/addiscombe', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/addiscombe.html'));
app.get('/locations/croydon/shirley', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/shirley.html'));
app.get('/locations/croydon/south-norwood', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/south-norwood.html'));
app.get('/locations/croydon/new-addington', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/new-addington.html'));
app.get('/locations/bromley/beckenham', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/beckenham.html'));
app.get('/locations/bromley/orpington', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/orpington.html'));
app.get('/locations/bromley/chislehurst', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/chislehurst.html'));
app.get('/locations/bromley/penge', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/penge.html'));
app.get('/locations/bromley/shortlands', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/shortlands.html'));
app.get('/locations/bromley/west-wickham', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/west-wickham.html'));
app.get('/locations/bromley/hayes', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/hayes.html'));
app.get('/locations/bromley/biggin-hill', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/biggin-hill.html'));
app.get('/locations/bromley/farnborough', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/farnborough.html'));
app.get('/locations/bromley/keston', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/keston.html'));
app.get('/locations/lewisham/catford', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/catford.html'));
app.get('/locations/lewisham/deptford', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/deptford.html'));
app.get('/locations/lewisham/forest-hill', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/forest-hill.html'));
app.get('/locations/lewisham/sydenham', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/sydenham.html'));
app.get('/locations/lewisham/lee', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/lee.html'));
app.get('/locations/lewisham/brockley', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/brockley.html'));
app.get('/locations/lewisham/honor-oak', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/honor-oak.html'));
app.get('/locations/lewisham/ladywell', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/ladywell.html'));
app.get('/locations/lewisham/hither-green', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/hither-green.html'));
app.get('/locations/lewisham/bellingham', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/bellingham.html'));
app.get('/locations/greenwich/woolwich', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/woolwich.html'));
app.get('/locations/greenwich/eltham', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/eltham.html'));
app.get('/locations/greenwich/charlton', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/charlton.html'));
app.get('/locations/greenwich/plumstead', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/plumstead.html'));
app.get('/locations/greenwich/kidbrooke', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/kidbrooke.html'));
app.get('/locations/greenwich/blackheath', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/blackheath.html'));
app.get('/locations/greenwich/abbey-wood', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/abbey-wood.html'));
app.get('/locations/greenwich/thamesmead', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/thamesmead.html'));
app.get('/locations/greenwich/new-eltham', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/new-eltham.html'));
app.get('/locations/greenwich/shooters-hill', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/shooters-hill.html'));
app.get('/locations/bexley/bexleyheath', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/bexleyheath.html'));
app.get('/locations/bexley/sidcup', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/sidcup.html'));
app.get('/locations/bexley/erith', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/erith.html'));
app.get('/locations/bexley/welling', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/welling.html'));
app.get('/locations/bexley/crayford', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/crayford.html'));
app.get('/locations/bexley/belvedere', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/belvedere.html'));
app.get('/locations/bexley/barnehurst', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/barnehurst.html'));
app.get('/locations/bexley/northumberland-heath', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/northumberland-heath.html'));
app.get('/locations/bexley/falconwood', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/falconwood.html'));
app.get('/locations/bexley/slade-green', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/slade-green.html'));
app.get('/locations/havering/romford', (req, res) => res.sendFile(__dirname + '/public/locations/havering/romford.html'));
app.get('/locations/havering/hornchurch', (req, res) => res.sendFile(__dirname + '/public/locations/havering/hornchurch.html'));
app.get('/locations/havering/upminster', (req, res) => res.sendFile(__dirname + '/public/locations/havering/upminster.html'));
app.get('/locations/havering/rainham', (req, res) => res.sendFile(__dirname + '/public/locations/havering/rainham.html'));
app.get('/locations/havering/harold-wood', (req, res) => res.sendFile(__dirname + '/public/locations/havering/harold-wood.html'));
app.get('/locations/havering/collier-row', (req, res) => res.sendFile(__dirname + '/public/locations/havering/collier-row.html'));
app.get('/locations/havering/gidea-park', (req, res) => res.sendFile(__dirname + '/public/locations/havering/gidea-park.html'));
app.get('/locations/havering/emerson-park', (req, res) => res.sendFile(__dirname + '/public/locations/havering/emerson-park.html'));
app.get('/locations/havering/south-hornchurch', (req, res) => res.sendFile(__dirname + '/public/locations/havering/south-hornchurch.html'));
app.get('/locations/havering/harold-hill', (req, res) => res.sendFile(__dirname + '/public/locations/havering/harold-hill.html'));
app.get('/locations/barking/dagenham', (req, res) => res.sendFile(__dirname + '/public/locations/barking/dagenham.html'));
app.get('/locations/barking/ilford', (req, res) => res.sendFile(__dirname + '/public/locations/barking/ilford.html'));
app.get('/locations/barking/becontree', (req, res) => res.sendFile(__dirname + '/public/locations/barking/becontree.html'));
app.get('/locations/barking/chadwell-heath', (req, res) => res.sendFile(__dirname + '/public/locations/barking/chadwell-heath.html'));
app.get('/locations/barking/marks-gate', (req, res) => res.sendFile(__dirname + '/public/locations/barking/marks-gate.html'));
app.get('/locations/barking/rush-green', (req, res) => res.sendFile(__dirname + '/public/locations/barking/rush-green.html'));
app.get('/locations/barking/whalebone', (req, res) => res.sendFile(__dirname + '/public/locations/barking/whalebone.html'));
app.get('/locations/barking/eastbury', (req, res) => res.sendFile(__dirname + '/public/locations/barking/eastbury.html'));
app.get('/locations/barking/longbridge', (req, res) => res.sendFile(__dirname + '/public/locations/barking/longbridge.html'));
app.get('/locations/barking/thames-view', (req, res) => res.sendFile(__dirname + '/public/locations/barking/thames-view.html'));
app.get('/locations/redbridge/ilford', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/ilford.html'));
app.get('/locations/redbridge/wanstead', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/wanstead.html'));
app.get('/locations/redbridge/woodford', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/woodford.html'));
app.get('/locations/redbridge/gants-hill', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/gants-hill.html'));
app.get('/locations/redbridge/barkingside', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/barkingside.html'));
app.get('/locations/redbridge/newbury-park', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/newbury-park.html'));
app.get('/locations/redbridge/seven-kings', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/seven-kings.html'));
app.get('/locations/redbridge/clayhall', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/clayhall.html'));
app.get('/locations/redbridge/hainault', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/hainault.html'));
app.get('/locations/redbridge/fairlop', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/fairlop.html'));
app.get('/locations/newham/stratford', (req, res) => res.sendFile(__dirname + '/public/locations/newham/stratford.html'));
app.get('/locations/newham/forest-gate', (req, res) => res.sendFile(__dirname + '/public/locations/newham/forest-gate.html'));
app.get('/locations/newham/east-ham', (req, res) => res.sendFile(__dirname + '/public/locations/newham/east-ham.html'));
app.get('/locations/newham/west-ham', (req, res) => res.sendFile(__dirname + '/public/locations/newham/west-ham.html'));
app.get('/locations/newham/plaistow', (req, res) => res.sendFile(__dirname + '/public/locations/newham/plaistow.html'));
app.get('/locations/newham/canning-town', (req, res) => res.sendFile(__dirname + '/public/locations/newham/canning-town.html'));
app.get('/locations/newham/custom-house', (req, res) => res.sendFile(__dirname + '/public/locations/newham/custom-house.html'));
app.get('/locations/newham/manor-park', (req, res) => res.sendFile(__dirname + '/public/locations/newham/manor-park.html'));
app.get('/locations/newham/upton-park', (req, res) => res.sendFile(__dirname + '/public/locations/newham/upton-park.html'));
app.get('/locations/newham/beckton', (req, res) => res.sendFile(__dirname + '/public/locations/newham/beckton.html'));
app.get('/locations/waltham-forest/walthamstow', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/walthamstow.html'));
app.get('/locations/waltham-forest/leyton', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/leyton.html'));
app.get('/locations/waltham-forest/leytonstone', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/leytonstone.html'));
app.get('/locations/waltham-forest/chingford', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/chingford.html'));
app.get('/locations/waltham-forest/highams-park', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/highams-park.html'));
app.get('/locations/waltham-forest/woodford-green', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/woodford-green.html'));
app.get('/locations/waltham-forest/snaresbrook', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/snaresbrook.html'));
app.get('/locations/waltham-forest/wanstead-flats', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/wanstead-flats.html'));
app.get('/locations/waltham-forest/forest-road', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/forest-road.html'));
app.get('/locations/waltham-forest/chapel-end', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/chapel-end.html'));
app.get('/locations/haringey/wood-green', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/wood-green.html'));
app.get('/locations/haringey/tottenham', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/tottenham.html'));
app.get('/locations/haringey/hornsey', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/hornsey.html'));
app.get('/locations/haringey/crouch-end', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/crouch-end.html'));
app.get('/locations/haringey/muswell-hill', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/muswell-hill.html'));
app.get('/locations/haringey/alexandra-palace', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/alexandra-palace.html'));
app.get('/locations/haringey/turnpike-lane', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/turnpike-lane.html'));
app.get('/locations/haringey/seven-sisters', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/seven-sisters.html'));
app.get('/locations/haringey/bruce-grove', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/bruce-grove.html'));
app.get('/locations/haringey/green-lanes', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/green-lanes.html'));
app.get('/locations/enfield/edmonton', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/edmonton.html'));
app.get('/locations/enfield/southgate', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/southgate.html'));
app.get('/locations/enfield/palmers-green', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/palmers-green.html'));
app.get('/locations/enfield/winchmore-hill', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/winchmore-hill.html'));
app.get('/locations/enfield/ponders-end', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/ponders-end.html'));
app.get('/locations/enfield/enfield-town', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/enfield-town.html'));
app.get('/locations/enfield/chase-side', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/chase-side.html'));
app.get('/locations/enfield/cockfosters', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/cockfosters.html'));
app.get('/locations/enfield/oakwood', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/oakwood.html'));
app.get('/locations/enfield/brimsdown', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/brimsdown.html'));
app.get('/locations/barnet/finchley', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/finchley.html'));
app.get('/locations/barnet/hendon', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/hendon.html'));
app.get('/locations/barnet/edgware', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/edgware.html'));
app.get('/locations/barnet/barnet', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/barnet.html'));
app.get('/locations/barnet/east-barnet', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/east-barnet.html'));
app.get('/locations/barnet/new-barnet', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/new-barnet.html'));
app.get('/locations/barnet/whetstone', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/whetstone.html'));
app.get('/locations/barnet/totteridge', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/totteridge.html'));
app.get('/locations/barnet/mill-hill', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/mill-hill.html'));
app.get('/locations/barnet/golders-green', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/golders-green.html'));
app.get('/locations/harrow/pinner', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/pinner.html'));
app.get('/locations/harrow/stanmore', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/stanmore.html'));
app.get('/locations/harrow/wealdstone', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/wealdstone.html'));
app.get('/locations/harrow/harrow-on-the-hill', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/harrow-on-the-hill.html'));
app.get('/locations/harrow/north-harrow', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/north-harrow.html'));
app.get('/locations/harrow/south-harrow', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/south-harrow.html'));
app.get('/locations/harrow/rayners-lane', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/rayners-lane.html'));
app.get('/locations/harrow/hatch-end', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/hatch-end.html'));
app.get('/locations/harrow/kenton', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/kenton.html'));
app.get('/locations/harrow/queensbury', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/queensbury.html'));
app.get('/locations/hillingdon/uxbridge', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/uxbridge.html'));
app.get('/locations/hillingdon/hayes', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/hayes.html'));
app.get('/locations/hillingdon/ruislip', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/ruislip.html'));
app.get('/locations/hillingdon/northolt', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/northolt.html'));
app.get('/locations/hillingdon/yiewsley', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/yiewsley.html'));
app.get('/locations/hillingdon/west-drayton', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/west-drayton.html'));
app.get('/locations/hillingdon/harlington', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/harlington.html'));
app.get('/locations/hillingdon/heathrow', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/heathrow.html'));
app.get('/locations/hillingdon/ickenham', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/ickenham.html'));
app.get('/locations/hillingdon/eastcote', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/eastcote.html'));
app.get('/locations/ealing/acton', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/acton.html'));
app.get('/locations/ealing/southall', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/southall.html'));
app.get('/locations/ealing/hanwell', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/hanwell.html'));
app.get('/locations/ealing/greenford', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/greenford.html'));
app.get('/locations/ealing/perivale', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/perivale.html'));
app.get('/locations/ealing/northolt', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/northolt.html'));
app.get('/locations/ealing/west-ealing', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/west-ealing.html'));
app.get('/locations/ealing/pitshanger', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/pitshanger.html'));
app.get('/locations/ealing/norwood-green', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/norwood-green.html'));
app.get('/locations/ealing/dormers-wells', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/dormers-wells.html'));
app.get('/locations/hounslow/brentford', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/brentford.html'));
app.get('/locations/hounslow/feltham', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/feltham.html'));
app.get('/locations/hounslow/isleworth', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/isleworth.html'));
app.get('/locations/hounslow/heston', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/heston.html'));
app.get('/locations/hounslow/cranford', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/cranford.html'));
app.get('/locations/hounslow/bedfont', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/bedfont.html'));
app.get('/locations/hounslow/hanworth', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/hanworth.html'));
app.get('/locations/hounslow/whitton', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/whitton.html'));
app.get('/locations/hounslow/lampton', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/lampton.html'));
app.get('/locations/hounslow/osterley', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/osterley.html'));
app.get('/locations/richmond/twickenham', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/twickenham.html'));
app.get('/locations/richmond/teddington', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/teddington.html'));
app.get('/locations/richmond/hampton', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/hampton.html'));
app.get('/locations/richmond/kew', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/kew.html'));
app.get('/locations/richmond/east-sheen', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/east-sheen.html'));
app.get('/locations/richmond/mortlake', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/mortlake.html'));
app.get('/locations/richmond/barnes', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/barnes.html'));
app.get('/locations/richmond/ham', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/ham.html'));
app.get('/locations/richmond/petersham', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/petersham.html'));
app.get('/locations/richmond/richmond-hill', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/richmond-hill.html'));
app.get('/locations/kingston/surbiton', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/surbiton.html'));
app.get('/locations/kingston/new-malden', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/new-malden.html'));
app.get('/locations/kingston/tolworth', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/tolworth.html'));
app.get('/locations/kingston/chessington', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/chessington.html'));
app.get('/locations/kingston/hook', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/hook.html'));
app.get('/locations/kingston/berrylands', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/berrylands.html'));
app.get('/locations/kingston/norbiton', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/norbiton.html'));
app.get('/locations/kingston/kingston-hill', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/kingston-hill.html'));
app.get('/locations/kingston/old-malden', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/old-malden.html'));
app.get('/locations/kingston/motspur-park', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/motspur-park.html'));
app.get('/locations/merton/wimbledon', (req, res) => res.sendFile(__dirname + '/public/locations/merton/wimbledon.html'));
app.get('/locations/merton/mitcham', (req, res) => res.sendFile(__dirname + '/public/locations/merton/mitcham.html'));
app.get('/locations/merton/morden', (req, res) => res.sendFile(__dirname + '/public/locations/merton/morden.html'));
app.get('/locations/merton/colliers-wood', (req, res) => res.sendFile(__dirname + '/public/locations/merton/colliers-wood.html'));
app.get('/locations/merton/raynes-park', (req, res) => res.sendFile(__dirname + '/public/locations/merton/raynes-park.html'));
app.get('/locations/merton/south-wimbledon', (req, res) => res.sendFile(__dirname + '/public/locations/merton/south-wimbledon.html'));
app.get('/locations/merton/raynes-park', (req, res) => res.sendFile(__dirname + '/public/locations/merton/raynes-park.html'));
app.get('/locations/merton/merton-park', (req, res) => res.sendFile(__dirname + '/public/locations/merton/merton-park.html'));
app.get('/locations/merton/cannon-hill', (req, res) => res.sendFile(__dirname + '/public/locations/merton/cannon-hill.html'));
app.get('/locations/merton/pollards-hill', (req, res) => res.sendFile(__dirname + '/public/locations/merton/pollards-hill.html'));
app.get('/locations/sutton/carshalton', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/carshalton.html'));
app.get('/locations/sutton/cheam', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/cheam.html'));
app.get('/locations/sutton/wallington', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/wallington.html'));
app.get('/locations/sutton/banstead', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/banstead.html'));
app.get('/locations/sutton/belmont', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/belmont.html'));
app.get('/locations/sutton/worcester-park', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/worcester-park.html'));
app.get('/locations/sutton/north-cheam', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/north-cheam.html'));
app.get('/locations/sutton/hackbridge', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/hackbridge.html'));
app.get('/locations/sutton/beddington', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/beddington.html'));
app.get('/locations/sutton/the-wrythe', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/the-wrythe.html'));
app.get('/locations/city-of-london/bank', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/bank.html'));
app.get('/locations/city-of-london/aldgate', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/aldgate.html'));
app.get('/locations/city-of-london/bishopsgate', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/bishopsgate.html'));
app.get('/locations/city-of-london/moorgate', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/moorgate.html'));
app.get('/locations/city-of-london/barbican', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/barbican.html'));
app.get('/locations/city-of-london/blackfriars', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/blackfriars.html'));
app.get('/locations/city-of-london/monument', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/monument.html'));
app.get('/locations/city-of-london/cannon-street', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/cannon-street.html'));
app.get('/locations/city-of-london/liverpool-street', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/liverpool-street.html'));
app.get('/locations/city-of-london/fenchurch-street', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/fenchurch-street.html'));
app.get('/locations/manchester/salford', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/salford.html'));
app.get('/locations/manchester/stockport', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/stockport.html'));
app.get('/locations/manchester/oldham', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/oldham.html'));
app.get('/locations/manchester/rochdale', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/rochdale.html'));
app.get('/locations/manchester/bolton', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/bolton.html'));
app.get('/locations/manchester/bury', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/bury.html'));
app.get('/locations/manchester/wigan', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/wigan.html'));
app.get('/locations/manchester/trafford', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/trafford.html'));
app.get('/locations/manchester/tameside', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/tameside.html'));
app.get('/locations/manchester/ashton-under-lyne', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/ashton-under-lyne.html'));
app.get('/locations/birmingham/solihull', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/solihull.html'));
app.get('/locations/birmingham/wolverhampton', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/wolverhampton.html'));
app.get('/locations/birmingham/walsall', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/walsall.html'));
app.get('/locations/birmingham/west-bromwich', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/west-bromwich.html'));
app.get('/locations/birmingham/sutton-coldfield', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/sutton-coldfield.html'));
app.get('/locations/birmingham/erdington', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/erdington.html'));
app.get('/locations/birmingham/edgbaston', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/edgbaston.html'));
app.get('/locations/birmingham/handsworth', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/handsworth.html'));
app.get('/locations/birmingham/moseley', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/moseley.html'));
app.get('/locations/birmingham/digbeth', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/digbeth.html'));
app.get('/locations/leeds/bradford', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/bradford.html'));
app.get('/locations/leeds/wakefield', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/wakefield.html'));
app.get('/locations/leeds/halifax', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/halifax.html'));
app.get('/locations/leeds/huddersfield', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/huddersfield.html'));
app.get('/locations/leeds/dewsbury', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/dewsbury.html'));
app.get('/locations/leeds/morley', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/morley.html'));
app.get('/locations/leeds/pudsey', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/pudsey.html'));
app.get('/locations/leeds/rothwell', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/rothwell.html'));
app.get('/locations/leeds/garforth', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/garforth.html'));
app.get('/locations/leeds/otley', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/otley.html'));
app.get('/locations/sheffield/rotherham', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/rotherham.html'));
app.get('/locations/sheffield/barnsley', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/barnsley.html'));
app.get('/locations/sheffield/doncaster', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/doncaster.html'));
app.get('/locations/sheffield/chesterfield', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/chesterfield.html'));
app.get('/locations/sheffield/worksop', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/worksop.html'));
app.get('/locations/sheffield/chapeltown', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/chapeltown.html'));
app.get('/locations/sheffield/hillsborough', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/hillsborough.html'));
app.get('/locations/sheffield/ecclesall', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/ecclesall.html'));
app.get('/locations/sheffield/woodseats', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/woodseats.html'));
app.get('/locations/sheffield/crookes', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/crookes.html'));
app.get('/locations/liverpool/birkenhead', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/birkenhead.html'));
app.get('/locations/liverpool/wirral', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/wirral.html'));
app.get('/locations/liverpool/st-helens', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/st-helens.html'));
app.get('/locations/liverpool/knowsley', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/knowsley.html'));
app.get('/locations/liverpool/sefton', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/sefton.html'));
app.get('/locations/liverpool/bootle', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/bootle.html'));
app.get('/locations/liverpool/huyton', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/huyton.html'));
app.get('/locations/liverpool/prescot', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/prescot.html'));
app.get('/locations/liverpool/maghull', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/maghull.html'));
app.get('/locations/liverpool/crosby', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/crosby.html'));
app.get('/locations/bristol/clifton', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/clifton.html'));
app.get('/locations/bristol/redland', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/redland.html'));
app.get('/locations/bristol/bedminster', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/bedminster.html'));
app.get('/locations/bristol/southville', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/southville.html'));
app.get('/locations/bristol/westbury-on-trym', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/westbury-on-trym.html'));
app.get('/locations/bristol/henleaze', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/henleaze.html'));
app.get('/locations/bristol/horfield', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/horfield.html'));
app.get('/locations/bristol/knowle', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/knowle.html'));
app.get('/locations/bristol/brislington', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/brislington.html'));
app.get('/locations/bristol/fishponds', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/fishponds.html'));
app.get('/locations/nottingham/derby', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/derby.html'));
app.get('/locations/nottingham/leicester', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/leicester.html'));
app.get('/locations/nottingham/mansfield', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/mansfield.html'));
app.get('/locations/nottingham/newark', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/newark.html'));
app.get('/locations/nottingham/loughborough', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/loughborough.html'));
app.get('/locations/nottingham/long-eaton', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/long-eaton.html'));
app.get('/locations/nottingham/arnold', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/arnold.html'));
app.get('/locations/nottingham/beeston', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/beeston.html'));
app.get('/locations/nottingham/hucknall', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/hucknall.html'));
app.get('/locations/nottingham/ilkeston', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/ilkeston.html'));
app.get('/locations/leicester/loughborough', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/loughborough.html'));
app.get('/locations/leicester/hinckley', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/hinckley.html'));
app.get('/locations/leicester/melton-mowbray', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/melton-mowbray.html'));
app.get('/locations/leicester/market-harborough', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/market-harborough.html'));
app.get('/locations/leicester/coalville', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/coalville.html'));
app.get('/locations/leicester/wigston', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/wigston.html'));
app.get('/locations/leicester/oadby', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/oadby.html'));
app.get('/locations/leicester/syston', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/syston.html'));
app.get('/locations/leicester/blaby', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/blaby.html'));
app.get('/locations/leicester/birstall', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/birstall.html'));
app.get('/locations/newcastle/gateshead', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/gateshead.html'));
app.get('/locations/newcastle/sunderland', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/sunderland.html'));
app.get('/locations/newcastle/durham', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/durham.html'));
app.get('/locations/newcastle/middlesbrough', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/middlesbrough.html'));
app.get('/locations/newcastle/south-shields', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/south-shields.html'));
app.get('/locations/newcastle/tynemouth', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/tynemouth.html'));
app.get('/locations/newcastle/whitley-bay', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/whitley-bay.html'));
app.get('/locations/newcastle/cramlington', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/cramlington.html'));
app.get('/locations/newcastle/blaydon', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/blaydon.html'));
app.get('/locations/newcastle/consett', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/consett.html'));
app.get('/locations/edinburgh/leith', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/leith.html'));
app.get('/locations/edinburgh/musselburgh', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/musselburgh.html'));
app.get('/locations/edinburgh/dalkeith', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/dalkeith.html'));
app.get('/locations/edinburgh/livingston', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/livingston.html'));
app.get('/locations/edinburgh/dunfermline', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/dunfermline.html'));
app.get('/locations/edinburgh/kirkcaldy', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/kirkcaldy.html'));
app.get('/locations/edinburgh/bathgate', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/bathgate.html'));
app.get('/locations/edinburgh/penicuik', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/penicuik.html'));
app.get('/locations/edinburgh/bonnyrigg', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/bonnyrigg.html'));
app.get('/locations/edinburgh/haddington', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/haddington.html'));
app.get('/locations/glasgow/paisley', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/paisley.html'));
app.get('/locations/glasgow/motherwell', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/motherwell.html'));
app.get('/locations/glasgow/hamilton', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/hamilton.html'));
app.get('/locations/glasgow/east-kilbride', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/east-kilbride.html'));
app.get('/locations/glasgow/clydebank', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/clydebank.html'));
app.get('/locations/glasgow/dumbarton', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/dumbarton.html'));
app.get('/locations/glasgow/airdrie', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/airdrie.html'));
app.get('/locations/glasgow/coatbridge', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/coatbridge.html'));
app.get('/locations/glasgow/rutherglen', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/rutherglen.html'));
app.get('/locations/glasgow/bishopbriggs', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/bishopbriggs.html'));
app.get('/locations/cardiff/newport', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/newport.html'));
app.get('/locations/cardiff/swansea', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/swansea.html'));
app.get('/locations/cardiff/barry', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/barry.html'));
app.get('/locations/cardiff/penarth', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/penarth.html'));
app.get('/locations/cardiff/bridgend', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/bridgend.html'));
app.get('/locations/cardiff/pontypridd', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/pontypridd.html'));
app.get('/locations/cardiff/caerphilly', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/caerphilly.html'));
app.get('/locations/cardiff/rhondda', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/rhondda.html'));
app.get('/locations/cardiff/merthyr-tydfil', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/merthyr-tydfil.html'));
app.get('/locations/cardiff/cwmbran', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/cwmbran.html'));
app.get('/locations/belfast/lisburn', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/lisburn.html'));
app.get('/locations/belfast/newtownabbey', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/newtownabbey.html'));
app.get('/locations/belfast/bangor', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/bangor.html'));
app.get('/locations/belfast/castlereagh', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/castlereagh.html'));
app.get('/locations/belfast/north-down', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/north-down.html'));
app.get('/locations/belfast/antrim', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/antrim.html'));
app.get('/locations/belfast/carrickfergus', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/carrickfergus.html'));
app.get('/locations/belfast/newtonards', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/newtonards.html'));
app.get('/locations/belfast/holywood', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/holywood.html'));
app.get('/locations/belfast/dundonald', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/dundonald.html'));
app.get('/locations/brighton/hove', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/hove.html'));
app.get('/locations/brighton/worthing', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/worthing.html'));
app.get('/locations/brighton/eastbourne', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/eastbourne.html'));
app.get('/locations/brighton/lewes', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/lewes.html'));
app.get('/locations/brighton/newhaven', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/newhaven.html'));
app.get('/locations/brighton/shoreham', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/shoreham.html'));
app.get('/locations/brighton/portslade', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/portslade.html'));
app.get('/locations/brighton/saltdean', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/saltdean.html'));
app.get('/locations/brighton/peacehaven', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/peacehaven.html'));
app.get('/locations/brighton/burgess-hill', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/burgess-hill.html'));
app.get('/locations/oxford/abingdon', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/abingdon.html'));
app.get('/locations/oxford/witney', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/witney.html'));
app.get('/locations/oxford/banbury', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/banbury.html'));
app.get('/locations/oxford/bicester', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/bicester.html'));
app.get('/locations/oxford/didcot', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/didcot.html'));
app.get('/locations/oxford/carterton', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/carterton.html'));
app.get('/locations/oxford/chipping-norton', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/chipping-norton.html'));
app.get('/locations/oxford/henley-on-thames', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/henley-on-thames.html'));
app.get('/locations/oxford/wallingford', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/wallingford.html'));
app.get('/locations/oxford/thame', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/thame.html'));
app.get('/locations/cambridge/ely', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/ely.html'));
app.get('/locations/cambridge/huntingdon', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/huntingdon.html'));
app.get('/locations/cambridge/st-ives', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/st-ives.html'));
app.get('/locations/cambridge/march', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/march.html'));
app.get('/locations/cambridge/wisbech', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/wisbech.html'));
app.get('/locations/cambridge/newmarket', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/newmarket.html'));
app.get('/locations/cambridge/haverhill', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/haverhill.html'));
app.get('/locations/cambridge/saffron-walden', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/saffron-walden.html'));
app.get('/locations/cambridge/royston', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/royston.html'));
app.get('/locations/cambridge/soham', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/soham.html'));
app.get('/locations/exeter/torbay', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/torbay.html'));
app.get('/locations/exeter/plymouth', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/plymouth.html'));
app.get('/locations/exeter/taunton', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/taunton.html'));
app.get('/locations/exeter/barnstaple', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/barnstaple.html'));
app.get('/locations/exeter/newton-abbot', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/newton-abbot.html'));
app.get('/locations/exeter/exmouth', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/exmouth.html'));
app.get('/locations/exeter/sidmouth', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/sidmouth.html'));
app.get('/locations/exeter/honiton', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/honiton.html'));
app.get('/locations/exeter/crediton', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/crediton.html'));
app.get('/locations/exeter/okehampton', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/okehampton.html'));
app.get('/locations/southampton/portsmouth', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/portsmouth.html'));
app.get('/locations/southampton/fareham', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/fareham.html'));
app.get('/locations/southampton/eastleigh', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/eastleigh.html'));
app.get('/locations/southampton/hedge-end', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/hedge-end.html'));
app.get('/locations/southampton/totton', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/totton.html'));
app.get('/locations/southampton/chandlers-ford', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/chandlers-ford.html'));
app.get('/locations/southampton/romsey', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/romsey.html'));
app.get('/locations/southampton/hythe', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/hythe.html'));
app.get('/locations/southampton/netley', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/netley.html'));
app.get('/locations/southampton/bitterne', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/bitterne.html'));
app.get('/locations/westminster/dental', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/dental.html'));
app.get('/locations/westminster/medical', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/medical.html'));
app.get('/locations/westminster/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/solicitors.html'));
app.get('/locations/westminster/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/estate-agents.html'));
app.get('/locations/westminster/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/letting-agents.html'));
app.get('/locations/westminster/builders', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/builders.html'));
app.get('/locations/westminster/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/electricians.html'));
app.get('/locations/westminster/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/plumbers.html'));
app.get('/locations/westminster/salons', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/salons.html'));
app.get('/locations/westminster/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/restaurants.html'));
app.get('/locations/westminster/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/accountants.html'));
app.get('/locations/westminster/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/handymen.html'));
app.get('/locations/westminster/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/westminster/veterinary.html'));
app.get('/locations/camden/dental', (req, res) => res.sendFile(__dirname + '/public/locations/camden/dental.html'));
app.get('/locations/camden/medical', (req, res) => res.sendFile(__dirname + '/public/locations/camden/medical.html'));
app.get('/locations/camden/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/camden/solicitors.html'));
app.get('/locations/camden/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/camden/estate-agents.html'));
app.get('/locations/camden/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/camden/letting-agents.html'));
app.get('/locations/camden/builders', (req, res) => res.sendFile(__dirname + '/public/locations/camden/builders.html'));
app.get('/locations/camden/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/camden/electricians.html'));
app.get('/locations/camden/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/camden/plumbers.html'));
app.get('/locations/camden/salons', (req, res) => res.sendFile(__dirname + '/public/locations/camden/salons.html'));
app.get('/locations/camden/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/camden/restaurants.html'));
app.get('/locations/camden/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/camden/accountants.html'));
app.get('/locations/camden/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/camden/handymen.html'));
app.get('/locations/camden/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/camden/veterinary.html'));
app.get('/locations/islington/dental', (req, res) => res.sendFile(__dirname + '/public/locations/islington/dental.html'));
app.get('/locations/islington/medical', (req, res) => res.sendFile(__dirname + '/public/locations/islington/medical.html'));
app.get('/locations/islington/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/islington/solicitors.html'));
app.get('/locations/islington/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/islington/estate-agents.html'));
app.get('/locations/islington/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/islington/letting-agents.html'));
app.get('/locations/islington/builders', (req, res) => res.sendFile(__dirname + '/public/locations/islington/builders.html'));
app.get('/locations/islington/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/islington/electricians.html'));
app.get('/locations/islington/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/islington/plumbers.html'));
app.get('/locations/islington/salons', (req, res) => res.sendFile(__dirname + '/public/locations/islington/salons.html'));
app.get('/locations/islington/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/islington/restaurants.html'));
app.get('/locations/islington/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/islington/accountants.html'));
app.get('/locations/islington/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/islington/handymen.html'));
app.get('/locations/islington/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/islington/veterinary.html'));
app.get('/locations/hackney/dental', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/dental.html'));
app.get('/locations/hackney/medical', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/medical.html'));
app.get('/locations/hackney/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/solicitors.html'));
app.get('/locations/hackney/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/estate-agents.html'));
app.get('/locations/hackney/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/letting-agents.html'));
app.get('/locations/hackney/builders', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/builders.html'));
app.get('/locations/hackney/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/electricians.html'));
app.get('/locations/hackney/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/plumbers.html'));
app.get('/locations/hackney/salons', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/salons.html'));
app.get('/locations/hackney/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/restaurants.html'));
app.get('/locations/hackney/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/accountants.html'));
app.get('/locations/hackney/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/handymen.html'));
app.get('/locations/hackney/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/hackney/veterinary.html'));
app.get('/locations/tower-hamlets/dental', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/dental.html'));
app.get('/locations/tower-hamlets/medical', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/medical.html'));
app.get('/locations/tower-hamlets/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/solicitors.html'));
app.get('/locations/tower-hamlets/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/estate-agents.html'));
app.get('/locations/tower-hamlets/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/letting-agents.html'));
app.get('/locations/tower-hamlets/builders', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/builders.html'));
app.get('/locations/tower-hamlets/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/electricians.html'));
app.get('/locations/tower-hamlets/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/plumbers.html'));
app.get('/locations/tower-hamlets/salons', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/salons.html'));
app.get('/locations/tower-hamlets/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/restaurants.html'));
app.get('/locations/tower-hamlets/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/accountants.html'));
app.get('/locations/tower-hamlets/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/handymen.html'));
app.get('/locations/tower-hamlets/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/tower-hamlets/veterinary.html'));
app.get('/locations/southwark/dental', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/dental.html'));
app.get('/locations/southwark/medical', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/medical.html'));
app.get('/locations/southwark/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/solicitors.html'));
app.get('/locations/southwark/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/estate-agents.html'));
app.get('/locations/southwark/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/letting-agents.html'));
app.get('/locations/southwark/builders', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/builders.html'));
app.get('/locations/southwark/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/electricians.html'));
app.get('/locations/southwark/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/plumbers.html'));
app.get('/locations/southwark/salons', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/salons.html'));
app.get('/locations/southwark/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/restaurants.html'));
app.get('/locations/southwark/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/accountants.html'));
app.get('/locations/southwark/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/handymen.html'));
app.get('/locations/southwark/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/southwark/veterinary.html'));
app.get('/locations/lambeth/dental', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/dental.html'));
app.get('/locations/lambeth/medical', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/medical.html'));
app.get('/locations/lambeth/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/solicitors.html'));
app.get('/locations/lambeth/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/estate-agents.html'));
app.get('/locations/lambeth/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/letting-agents.html'));
app.get('/locations/lambeth/builders', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/builders.html'));
app.get('/locations/lambeth/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/electricians.html'));
app.get('/locations/lambeth/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/plumbers.html'));
app.get('/locations/lambeth/salons', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/salons.html'));
app.get('/locations/lambeth/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/restaurants.html'));
app.get('/locations/lambeth/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/accountants.html'));
app.get('/locations/lambeth/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/handymen.html'));
app.get('/locations/lambeth/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/lambeth/veterinary.html'));
app.get('/locations/wandsworth/dental', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/dental.html'));
app.get('/locations/wandsworth/medical', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/medical.html'));
app.get('/locations/wandsworth/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/solicitors.html'));
app.get('/locations/wandsworth/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/estate-agents.html'));
app.get('/locations/wandsworth/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/letting-agents.html'));
app.get('/locations/wandsworth/builders', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/builders.html'));
app.get('/locations/wandsworth/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/electricians.html'));
app.get('/locations/wandsworth/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/plumbers.html'));
app.get('/locations/wandsworth/salons', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/salons.html'));
app.get('/locations/wandsworth/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/restaurants.html'));
app.get('/locations/wandsworth/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/accountants.html'));
app.get('/locations/wandsworth/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/handymen.html'));
app.get('/locations/wandsworth/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/wandsworth/veterinary.html'));
app.get('/locations/hammersmith/dental', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/dental.html'));
app.get('/locations/hammersmith/medical', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/medical.html'));
app.get('/locations/hammersmith/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/solicitors.html'));
app.get('/locations/hammersmith/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/estate-agents.html'));
app.get('/locations/hammersmith/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/letting-agents.html'));
app.get('/locations/hammersmith/builders', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/builders.html'));
app.get('/locations/hammersmith/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/electricians.html'));
app.get('/locations/hammersmith/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/plumbers.html'));
app.get('/locations/hammersmith/salons', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/salons.html'));
app.get('/locations/hammersmith/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/restaurants.html'));
app.get('/locations/hammersmith/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/accountants.html'));
app.get('/locations/hammersmith/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/handymen.html'));
app.get('/locations/hammersmith/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/hammersmith/veterinary.html'));
app.get('/locations/kensington/dental', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/dental.html'));
app.get('/locations/kensington/medical', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/medical.html'));
app.get('/locations/kensington/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/solicitors.html'));
app.get('/locations/kensington/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/estate-agents.html'));
app.get('/locations/kensington/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/letting-agents.html'));
app.get('/locations/kensington/builders', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/builders.html'));
app.get('/locations/kensington/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/electricians.html'));
app.get('/locations/kensington/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/plumbers.html'));
app.get('/locations/kensington/salons', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/salons.html'));
app.get('/locations/kensington/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/restaurants.html'));
app.get('/locations/kensington/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/accountants.html'));
app.get('/locations/kensington/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/handymen.html'));
app.get('/locations/kensington/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/kensington/veterinary.html'));
app.get('/locations/croydon/dental', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/dental.html'));
app.get('/locations/croydon/medical', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/medical.html'));
app.get('/locations/croydon/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/solicitors.html'));
app.get('/locations/croydon/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/estate-agents.html'));
app.get('/locations/croydon/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/letting-agents.html'));
app.get('/locations/croydon/builders', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/builders.html'));
app.get('/locations/croydon/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/electricians.html'));
app.get('/locations/croydon/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/plumbers.html'));
app.get('/locations/croydon/salons', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/salons.html'));
app.get('/locations/croydon/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/restaurants.html'));
app.get('/locations/croydon/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/accountants.html'));
app.get('/locations/croydon/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/handymen.html'));
app.get('/locations/croydon/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/croydon/veterinary.html'));
app.get('/locations/bromley/dental', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/dental.html'));
app.get('/locations/bromley/medical', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/medical.html'));
app.get('/locations/bromley/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/solicitors.html'));
app.get('/locations/bromley/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/estate-agents.html'));
app.get('/locations/bromley/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/letting-agents.html'));
app.get('/locations/bromley/builders', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/builders.html'));
app.get('/locations/bromley/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/electricians.html'));
app.get('/locations/bromley/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/plumbers.html'));
app.get('/locations/bromley/salons', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/salons.html'));
app.get('/locations/bromley/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/restaurants.html'));
app.get('/locations/bromley/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/accountants.html'));
app.get('/locations/bromley/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/handymen.html'));
app.get('/locations/bromley/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/bromley/veterinary.html'));
app.get('/locations/lewisham/dental', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/dental.html'));
app.get('/locations/lewisham/medical', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/medical.html'));
app.get('/locations/lewisham/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/solicitors.html'));
app.get('/locations/lewisham/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/estate-agents.html'));
app.get('/locations/lewisham/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/letting-agents.html'));
app.get('/locations/lewisham/builders', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/builders.html'));
app.get('/locations/lewisham/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/electricians.html'));
app.get('/locations/lewisham/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/plumbers.html'));
app.get('/locations/lewisham/salons', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/salons.html'));
app.get('/locations/lewisham/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/restaurants.html'));
app.get('/locations/lewisham/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/accountants.html'));
app.get('/locations/lewisham/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/handymen.html'));
app.get('/locations/lewisham/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/lewisham/veterinary.html'));
app.get('/locations/greenwich/dental', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/dental.html'));
app.get('/locations/greenwich/medical', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/medical.html'));
app.get('/locations/greenwich/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/solicitors.html'));
app.get('/locations/greenwich/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/estate-agents.html'));
app.get('/locations/greenwich/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/letting-agents.html'));
app.get('/locations/greenwich/builders', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/builders.html'));
app.get('/locations/greenwich/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/electricians.html'));
app.get('/locations/greenwich/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/plumbers.html'));
app.get('/locations/greenwich/salons', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/salons.html'));
app.get('/locations/greenwich/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/restaurants.html'));
app.get('/locations/greenwich/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/accountants.html'));
app.get('/locations/greenwich/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/handymen.html'));
app.get('/locations/greenwich/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/greenwich/veterinary.html'));
app.get('/locations/bexley/dental', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/dental.html'));
app.get('/locations/bexley/medical', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/medical.html'));
app.get('/locations/bexley/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/solicitors.html'));
app.get('/locations/bexley/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/estate-agents.html'));
app.get('/locations/bexley/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/letting-agents.html'));
app.get('/locations/bexley/builders', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/builders.html'));
app.get('/locations/bexley/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/electricians.html'));
app.get('/locations/bexley/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/plumbers.html'));
app.get('/locations/bexley/salons', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/salons.html'));
app.get('/locations/bexley/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/restaurants.html'));
app.get('/locations/bexley/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/accountants.html'));
app.get('/locations/bexley/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/handymen.html'));
app.get('/locations/bexley/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/bexley/veterinary.html'));
app.get('/locations/havering/dental', (req, res) => res.sendFile(__dirname + '/public/locations/havering/dental.html'));
app.get('/locations/havering/medical', (req, res) => res.sendFile(__dirname + '/public/locations/havering/medical.html'));
app.get('/locations/havering/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/havering/solicitors.html'));
app.get('/locations/havering/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/havering/estate-agents.html'));
app.get('/locations/havering/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/havering/letting-agents.html'));
app.get('/locations/havering/builders', (req, res) => res.sendFile(__dirname + '/public/locations/havering/builders.html'));
app.get('/locations/havering/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/havering/electricians.html'));
app.get('/locations/havering/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/havering/plumbers.html'));
app.get('/locations/havering/salons', (req, res) => res.sendFile(__dirname + '/public/locations/havering/salons.html'));
app.get('/locations/havering/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/havering/restaurants.html'));
app.get('/locations/havering/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/havering/accountants.html'));
app.get('/locations/havering/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/havering/handymen.html'));
app.get('/locations/havering/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/havering/veterinary.html'));
app.get('/locations/barking/dental', (req, res) => res.sendFile(__dirname + '/public/locations/barking/dental.html'));
app.get('/locations/barking/medical', (req, res) => res.sendFile(__dirname + '/public/locations/barking/medical.html'));
app.get('/locations/barking/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/barking/solicitors.html'));
app.get('/locations/barking/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/barking/estate-agents.html'));
app.get('/locations/barking/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/barking/letting-agents.html'));
app.get('/locations/barking/builders', (req, res) => res.sendFile(__dirname + '/public/locations/barking/builders.html'));
app.get('/locations/barking/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/barking/electricians.html'));
app.get('/locations/barking/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/barking/plumbers.html'));
app.get('/locations/barking/salons', (req, res) => res.sendFile(__dirname + '/public/locations/barking/salons.html'));
app.get('/locations/barking/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/barking/restaurants.html'));
app.get('/locations/barking/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/barking/accountants.html'));
app.get('/locations/barking/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/barking/handymen.html'));
app.get('/locations/barking/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/barking/veterinary.html'));
app.get('/locations/redbridge/dental', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/dental.html'));
app.get('/locations/redbridge/medical', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/medical.html'));
app.get('/locations/redbridge/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/solicitors.html'));
app.get('/locations/redbridge/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/estate-agents.html'));
app.get('/locations/redbridge/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/letting-agents.html'));
app.get('/locations/redbridge/builders', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/builders.html'));
app.get('/locations/redbridge/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/electricians.html'));
app.get('/locations/redbridge/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/plumbers.html'));
app.get('/locations/redbridge/salons', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/salons.html'));
app.get('/locations/redbridge/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/restaurants.html'));
app.get('/locations/redbridge/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/accountants.html'));
app.get('/locations/redbridge/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/handymen.html'));
app.get('/locations/redbridge/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/redbridge/veterinary.html'));
app.get('/locations/newham/dental', (req, res) => res.sendFile(__dirname + '/public/locations/newham/dental.html'));
app.get('/locations/newham/medical', (req, res) => res.sendFile(__dirname + '/public/locations/newham/medical.html'));
app.get('/locations/newham/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/newham/solicitors.html'));
app.get('/locations/newham/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/newham/estate-agents.html'));
app.get('/locations/newham/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/newham/letting-agents.html'));
app.get('/locations/newham/builders', (req, res) => res.sendFile(__dirname + '/public/locations/newham/builders.html'));
app.get('/locations/newham/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/newham/electricians.html'));
app.get('/locations/newham/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/newham/plumbers.html'));
app.get('/locations/newham/salons', (req, res) => res.sendFile(__dirname + '/public/locations/newham/salons.html'));
app.get('/locations/newham/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/newham/restaurants.html'));
app.get('/locations/newham/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/newham/accountants.html'));
app.get('/locations/newham/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/newham/handymen.html'));
app.get('/locations/newham/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/newham/veterinary.html'));
app.get('/locations/waltham-forest/dental', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/dental.html'));
app.get('/locations/waltham-forest/medical', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/medical.html'));
app.get('/locations/waltham-forest/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/solicitors.html'));
app.get('/locations/waltham-forest/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/estate-agents.html'));
app.get('/locations/waltham-forest/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/letting-agents.html'));
app.get('/locations/waltham-forest/builders', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/builders.html'));
app.get('/locations/waltham-forest/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/electricians.html'));
app.get('/locations/waltham-forest/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/plumbers.html'));
app.get('/locations/waltham-forest/salons', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/salons.html'));
app.get('/locations/waltham-forest/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/restaurants.html'));
app.get('/locations/waltham-forest/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/accountants.html'));
app.get('/locations/waltham-forest/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/handymen.html'));
app.get('/locations/waltham-forest/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/waltham-forest/veterinary.html'));
app.get('/locations/haringey/dental', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/dental.html'));
app.get('/locations/haringey/medical', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/medical.html'));
app.get('/locations/haringey/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/solicitors.html'));
app.get('/locations/haringey/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/estate-agents.html'));
app.get('/locations/haringey/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/letting-agents.html'));
app.get('/locations/haringey/builders', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/builders.html'));
app.get('/locations/haringey/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/electricians.html'));
app.get('/locations/haringey/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/plumbers.html'));
app.get('/locations/haringey/salons', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/salons.html'));
app.get('/locations/haringey/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/restaurants.html'));
app.get('/locations/haringey/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/accountants.html'));
app.get('/locations/haringey/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/handymen.html'));
app.get('/locations/haringey/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/haringey/veterinary.html'));
app.get('/locations/enfield/dental', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/dental.html'));
app.get('/locations/enfield/medical', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/medical.html'));
app.get('/locations/enfield/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/solicitors.html'));
app.get('/locations/enfield/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/estate-agents.html'));
app.get('/locations/enfield/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/letting-agents.html'));
app.get('/locations/enfield/builders', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/builders.html'));
app.get('/locations/enfield/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/electricians.html'));
app.get('/locations/enfield/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/plumbers.html'));
app.get('/locations/enfield/salons', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/salons.html'));
app.get('/locations/enfield/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/restaurants.html'));
app.get('/locations/enfield/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/accountants.html'));
app.get('/locations/enfield/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/handymen.html'));
app.get('/locations/enfield/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/enfield/veterinary.html'));
app.get('/locations/barnet/dental', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/dental.html'));
app.get('/locations/barnet/medical', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/medical.html'));
app.get('/locations/barnet/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/solicitors.html'));
app.get('/locations/barnet/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/estate-agents.html'));
app.get('/locations/barnet/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/letting-agents.html'));
app.get('/locations/barnet/builders', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/builders.html'));
app.get('/locations/barnet/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/electricians.html'));
app.get('/locations/barnet/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/plumbers.html'));
app.get('/locations/barnet/salons', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/salons.html'));
app.get('/locations/barnet/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/restaurants.html'));
app.get('/locations/barnet/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/accountants.html'));
app.get('/locations/barnet/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/handymen.html'));
app.get('/locations/barnet/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/barnet/veterinary.html'));
app.get('/locations/harrow/dental', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/dental.html'));
app.get('/locations/harrow/medical', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/medical.html'));
app.get('/locations/harrow/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/solicitors.html'));
app.get('/locations/harrow/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/estate-agents.html'));
app.get('/locations/harrow/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/letting-agents.html'));
app.get('/locations/harrow/builders', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/builders.html'));
app.get('/locations/harrow/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/electricians.html'));
app.get('/locations/harrow/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/plumbers.html'));
app.get('/locations/harrow/salons', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/salons.html'));
app.get('/locations/harrow/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/restaurants.html'));
app.get('/locations/harrow/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/accountants.html'));
app.get('/locations/harrow/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/handymen.html'));
app.get('/locations/harrow/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/harrow/veterinary.html'));
app.get('/locations/hillingdon/dental', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/dental.html'));
app.get('/locations/hillingdon/medical', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/medical.html'));
app.get('/locations/hillingdon/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/solicitors.html'));
app.get('/locations/hillingdon/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/estate-agents.html'));
app.get('/locations/hillingdon/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/letting-agents.html'));
app.get('/locations/hillingdon/builders', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/builders.html'));
app.get('/locations/hillingdon/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/electricians.html'));
app.get('/locations/hillingdon/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/plumbers.html'));
app.get('/locations/hillingdon/salons', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/salons.html'));
app.get('/locations/hillingdon/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/restaurants.html'));
app.get('/locations/hillingdon/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/accountants.html'));
app.get('/locations/hillingdon/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/handymen.html'));
app.get('/locations/hillingdon/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/hillingdon/veterinary.html'));
app.get('/locations/ealing/dental', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/dental.html'));
app.get('/locations/ealing/medical', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/medical.html'));
app.get('/locations/ealing/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/solicitors.html'));
app.get('/locations/ealing/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/estate-agents.html'));
app.get('/locations/ealing/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/letting-agents.html'));
app.get('/locations/ealing/builders', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/builders.html'));
app.get('/locations/ealing/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/electricians.html'));
app.get('/locations/ealing/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/plumbers.html'));
app.get('/locations/ealing/salons', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/salons.html'));
app.get('/locations/ealing/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/restaurants.html'));
app.get('/locations/ealing/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/accountants.html'));
app.get('/locations/ealing/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/handymen.html'));
app.get('/locations/ealing/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/ealing/veterinary.html'));
app.get('/locations/hounslow/dental', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/dental.html'));
app.get('/locations/hounslow/medical', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/medical.html'));
app.get('/locations/hounslow/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/solicitors.html'));
app.get('/locations/hounslow/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/estate-agents.html'));
app.get('/locations/hounslow/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/letting-agents.html'));
app.get('/locations/hounslow/builders', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/builders.html'));
app.get('/locations/hounslow/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/electricians.html'));
app.get('/locations/hounslow/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/plumbers.html'));
app.get('/locations/hounslow/salons', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/salons.html'));
app.get('/locations/hounslow/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/restaurants.html'));
app.get('/locations/hounslow/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/accountants.html'));
app.get('/locations/hounslow/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/handymen.html'));
app.get('/locations/hounslow/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/hounslow/veterinary.html'));
app.get('/locations/richmond/dental', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/dental.html'));
app.get('/locations/richmond/medical', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/medical.html'));
app.get('/locations/richmond/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/solicitors.html'));
app.get('/locations/richmond/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/estate-agents.html'));
app.get('/locations/richmond/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/letting-agents.html'));
app.get('/locations/richmond/builders', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/builders.html'));
app.get('/locations/richmond/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/electricians.html'));
app.get('/locations/richmond/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/plumbers.html'));
app.get('/locations/richmond/salons', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/salons.html'));
app.get('/locations/richmond/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/restaurants.html'));
app.get('/locations/richmond/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/accountants.html'));
app.get('/locations/richmond/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/handymen.html'));
app.get('/locations/richmond/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/richmond/veterinary.html'));
app.get('/locations/kingston/dental', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/dental.html'));
app.get('/locations/kingston/medical', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/medical.html'));
app.get('/locations/kingston/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/solicitors.html'));
app.get('/locations/kingston/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/estate-agents.html'));
app.get('/locations/kingston/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/letting-agents.html'));
app.get('/locations/kingston/builders', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/builders.html'));
app.get('/locations/kingston/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/electricians.html'));
app.get('/locations/kingston/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/plumbers.html'));
app.get('/locations/kingston/salons', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/salons.html'));
app.get('/locations/kingston/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/restaurants.html'));
app.get('/locations/kingston/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/accountants.html'));
app.get('/locations/kingston/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/handymen.html'));
app.get('/locations/kingston/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/kingston/veterinary.html'));
app.get('/locations/merton/dental', (req, res) => res.sendFile(__dirname + '/public/locations/merton/dental.html'));
app.get('/locations/merton/medical', (req, res) => res.sendFile(__dirname + '/public/locations/merton/medical.html'));
app.get('/locations/merton/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/merton/solicitors.html'));
app.get('/locations/merton/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/merton/estate-agents.html'));
app.get('/locations/merton/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/merton/letting-agents.html'));
app.get('/locations/merton/builders', (req, res) => res.sendFile(__dirname + '/public/locations/merton/builders.html'));
app.get('/locations/merton/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/merton/electricians.html'));
app.get('/locations/merton/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/merton/plumbers.html'));
app.get('/locations/merton/salons', (req, res) => res.sendFile(__dirname + '/public/locations/merton/salons.html'));
app.get('/locations/merton/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/merton/restaurants.html'));
app.get('/locations/merton/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/merton/accountants.html'));
app.get('/locations/merton/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/merton/handymen.html'));
app.get('/locations/merton/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/merton/veterinary.html'));
app.get('/locations/sutton/dental', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/dental.html'));
app.get('/locations/sutton/medical', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/medical.html'));
app.get('/locations/sutton/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/solicitors.html'));
app.get('/locations/sutton/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/estate-agents.html'));
app.get('/locations/sutton/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/letting-agents.html'));
app.get('/locations/sutton/builders', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/builders.html'));
app.get('/locations/sutton/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/electricians.html'));
app.get('/locations/sutton/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/plumbers.html'));
app.get('/locations/sutton/salons', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/salons.html'));
app.get('/locations/sutton/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/restaurants.html'));
app.get('/locations/sutton/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/accountants.html'));
app.get('/locations/sutton/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/handymen.html'));
app.get('/locations/sutton/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/sutton/veterinary.html'));
app.get('/locations/city-of-london/dental', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/dental.html'));
app.get('/locations/city-of-london/medical', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/medical.html'));
app.get('/locations/city-of-london/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/solicitors.html'));
app.get('/locations/city-of-london/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/estate-agents.html'));
app.get('/locations/city-of-london/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/letting-agents.html'));
app.get('/locations/city-of-london/builders', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/builders.html'));
app.get('/locations/city-of-london/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/electricians.html'));
app.get('/locations/city-of-london/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/plumbers.html'));
app.get('/locations/city-of-london/salons', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/salons.html'));
app.get('/locations/city-of-london/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/restaurants.html'));
app.get('/locations/city-of-london/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/accountants.html'));
app.get('/locations/city-of-london/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/handymen.html'));
app.get('/locations/city-of-london/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/city-of-london/veterinary.html'));
app.get('/locations/manchester/dental', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/dental.html'));
app.get('/locations/manchester/medical', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/medical.html'));
app.get('/locations/manchester/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/solicitors.html'));
app.get('/locations/manchester/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/estate-agents.html'));
app.get('/locations/manchester/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/letting-agents.html'));
app.get('/locations/manchester/builders', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/builders.html'));
app.get('/locations/manchester/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/electricians.html'));
app.get('/locations/manchester/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/plumbers.html'));
app.get('/locations/manchester/salons', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/salons.html'));
app.get('/locations/manchester/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/restaurants.html'));
app.get('/locations/manchester/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/accountants.html'));
app.get('/locations/manchester/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/handymen.html'));
app.get('/locations/manchester/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/manchester/veterinary.html'));
app.get('/locations/birmingham/dental', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/dental.html'));
app.get('/locations/birmingham/medical', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/medical.html'));
app.get('/locations/birmingham/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/solicitors.html'));
app.get('/locations/birmingham/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/estate-agents.html'));
app.get('/locations/birmingham/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/letting-agents.html'));
app.get('/locations/birmingham/builders', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/builders.html'));
app.get('/locations/birmingham/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/electricians.html'));
app.get('/locations/birmingham/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/plumbers.html'));
app.get('/locations/birmingham/salons', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/salons.html'));
app.get('/locations/birmingham/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/restaurants.html'));
app.get('/locations/birmingham/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/accountants.html'));
app.get('/locations/birmingham/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/handymen.html'));
app.get('/locations/birmingham/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/birmingham/veterinary.html'));
app.get('/locations/leeds/dental', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/dental.html'));
app.get('/locations/leeds/medical', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/medical.html'));
app.get('/locations/leeds/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/solicitors.html'));
app.get('/locations/leeds/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/estate-agents.html'));
app.get('/locations/leeds/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/letting-agents.html'));
app.get('/locations/leeds/builders', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/builders.html'));
app.get('/locations/leeds/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/electricians.html'));
app.get('/locations/leeds/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/plumbers.html'));
app.get('/locations/leeds/salons', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/salons.html'));
app.get('/locations/leeds/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/restaurants.html'));
app.get('/locations/leeds/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/accountants.html'));
app.get('/locations/leeds/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/handymen.html'));
app.get('/locations/leeds/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/leeds/veterinary.html'));
app.get('/locations/sheffield/dental', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/dental.html'));
app.get('/locations/sheffield/medical', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/medical.html'));
app.get('/locations/sheffield/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/solicitors.html'));
app.get('/locations/sheffield/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/estate-agents.html'));
app.get('/locations/sheffield/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/letting-agents.html'));
app.get('/locations/sheffield/builders', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/builders.html'));
app.get('/locations/sheffield/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/electricians.html'));
app.get('/locations/sheffield/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/plumbers.html'));
app.get('/locations/sheffield/salons', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/salons.html'));
app.get('/locations/sheffield/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/restaurants.html'));
app.get('/locations/sheffield/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/accountants.html'));
app.get('/locations/sheffield/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/handymen.html'));
app.get('/locations/sheffield/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/sheffield/veterinary.html'));
app.get('/locations/liverpool/dental', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/dental.html'));
app.get('/locations/liverpool/medical', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/medical.html'));
app.get('/locations/liverpool/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/solicitors.html'));
app.get('/locations/liverpool/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/estate-agents.html'));
app.get('/locations/liverpool/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/letting-agents.html'));
app.get('/locations/liverpool/builders', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/builders.html'));
app.get('/locations/liverpool/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/electricians.html'));
app.get('/locations/liverpool/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/plumbers.html'));
app.get('/locations/liverpool/salons', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/salons.html'));
app.get('/locations/liverpool/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/restaurants.html'));
app.get('/locations/liverpool/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/accountants.html'));
app.get('/locations/liverpool/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/handymen.html'));
app.get('/locations/liverpool/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/liverpool/veterinary.html'));
app.get('/locations/bristol/dental', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/dental.html'));
app.get('/locations/bristol/medical', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/medical.html'));
app.get('/locations/bristol/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/solicitors.html'));
app.get('/locations/bristol/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/estate-agents.html'));
app.get('/locations/bristol/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/letting-agents.html'));
app.get('/locations/bristol/builders', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/builders.html'));
app.get('/locations/bristol/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/electricians.html'));
app.get('/locations/bristol/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/plumbers.html'));
app.get('/locations/bristol/salons', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/salons.html'));
app.get('/locations/bristol/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/restaurants.html'));
app.get('/locations/bristol/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/accountants.html'));
app.get('/locations/bristol/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/handymen.html'));
app.get('/locations/bristol/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/bristol/veterinary.html'));
app.get('/locations/nottingham/dental', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/dental.html'));
app.get('/locations/nottingham/medical', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/medical.html'));
app.get('/locations/nottingham/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/solicitors.html'));
app.get('/locations/nottingham/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/estate-agents.html'));
app.get('/locations/nottingham/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/letting-agents.html'));
app.get('/locations/nottingham/builders', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/builders.html'));
app.get('/locations/nottingham/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/electricians.html'));
app.get('/locations/nottingham/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/plumbers.html'));
app.get('/locations/nottingham/salons', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/salons.html'));
app.get('/locations/nottingham/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/restaurants.html'));
app.get('/locations/nottingham/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/accountants.html'));
app.get('/locations/nottingham/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/handymen.html'));
app.get('/locations/nottingham/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/nottingham/veterinary.html'));
app.get('/locations/leicester/dental', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/dental.html'));
app.get('/locations/leicester/medical', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/medical.html'));
app.get('/locations/leicester/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/solicitors.html'));
app.get('/locations/leicester/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/estate-agents.html'));
app.get('/locations/leicester/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/letting-agents.html'));
app.get('/locations/leicester/builders', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/builders.html'));
app.get('/locations/leicester/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/electricians.html'));
app.get('/locations/leicester/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/plumbers.html'));
app.get('/locations/leicester/salons', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/salons.html'));
app.get('/locations/leicester/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/restaurants.html'));
app.get('/locations/leicester/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/accountants.html'));
app.get('/locations/leicester/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/handymen.html'));
app.get('/locations/leicester/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/leicester/veterinary.html'));
app.get('/locations/coventry/dental', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/dental.html'));
app.get('/locations/coventry/medical', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/medical.html'));
app.get('/locations/coventry/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/solicitors.html'));
app.get('/locations/coventry/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/estate-agents.html'));
app.get('/locations/coventry/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/letting-agents.html'));
app.get('/locations/coventry/builders', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/builders.html'));
app.get('/locations/coventry/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/electricians.html'));
app.get('/locations/coventry/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/plumbers.html'));
app.get('/locations/coventry/salons', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/salons.html'));
app.get('/locations/coventry/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/restaurants.html'));
app.get('/locations/coventry/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/accountants.html'));
app.get('/locations/coventry/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/handymen.html'));
app.get('/locations/coventry/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/coventry/veterinary.html'));
app.get('/locations/bradford/dental', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/dental.html'));
app.get('/locations/bradford/medical', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/medical.html'));
app.get('/locations/bradford/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/solicitors.html'));
app.get('/locations/bradford/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/estate-agents.html'));
app.get('/locations/bradford/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/letting-agents.html'));
app.get('/locations/bradford/builders', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/builders.html'));
app.get('/locations/bradford/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/electricians.html'));
app.get('/locations/bradford/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/plumbers.html'));
app.get('/locations/bradford/salons', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/salons.html'));
app.get('/locations/bradford/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/restaurants.html'));
app.get('/locations/bradford/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/accountants.html'));
app.get('/locations/bradford/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/handymen.html'));
app.get('/locations/bradford/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/bradford/veterinary.html'));
app.get('/locations/stoke/dental', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/dental.html'));
app.get('/locations/stoke/medical', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/medical.html'));
app.get('/locations/stoke/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/solicitors.html'));
app.get('/locations/stoke/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/estate-agents.html'));
app.get('/locations/stoke/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/letting-agents.html'));
app.get('/locations/stoke/builders', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/builders.html'));
app.get('/locations/stoke/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/electricians.html'));
app.get('/locations/stoke/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/plumbers.html'));
app.get('/locations/stoke/salons', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/salons.html'));
app.get('/locations/stoke/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/restaurants.html'));
app.get('/locations/stoke/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/accountants.html'));
app.get('/locations/stoke/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/handymen.html'));
app.get('/locations/stoke/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/stoke/veterinary.html'));
app.get('/locations/wolverhampton/dental', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/dental.html'));
app.get('/locations/wolverhampton/medical', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/medical.html'));
app.get('/locations/wolverhampton/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/solicitors.html'));
app.get('/locations/wolverhampton/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/estate-agents.html'));
app.get('/locations/wolverhampton/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/letting-agents.html'));
app.get('/locations/wolverhampton/builders', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/builders.html'));
app.get('/locations/wolverhampton/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/electricians.html'));
app.get('/locations/wolverhampton/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/plumbers.html'));
app.get('/locations/wolverhampton/salons', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/salons.html'));
app.get('/locations/wolverhampton/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/restaurants.html'));
app.get('/locations/wolverhampton/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/accountants.html'));
app.get('/locations/wolverhampton/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/handymen.html'));
app.get('/locations/wolverhampton/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/wolverhampton/veterinary.html'));
app.get('/locations/plymouth/dental', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/dental.html'));
app.get('/locations/plymouth/medical', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/medical.html'));
app.get('/locations/plymouth/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/solicitors.html'));
app.get('/locations/plymouth/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/estate-agents.html'));
app.get('/locations/plymouth/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/letting-agents.html'));
app.get('/locations/plymouth/builders', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/builders.html'));
app.get('/locations/plymouth/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/electricians.html'));
app.get('/locations/plymouth/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/plumbers.html'));
app.get('/locations/plymouth/salons', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/salons.html'));
app.get('/locations/plymouth/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/restaurants.html'));
app.get('/locations/plymouth/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/accountants.html'));
app.get('/locations/plymouth/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/handymen.html'));
app.get('/locations/plymouth/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/plymouth/veterinary.html'));
app.get('/locations/derby/dental', (req, res) => res.sendFile(__dirname + '/public/locations/derby/dental.html'));
app.get('/locations/derby/medical', (req, res) => res.sendFile(__dirname + '/public/locations/derby/medical.html'));
app.get('/locations/derby/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/derby/solicitors.html'));
app.get('/locations/derby/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/derby/estate-agents.html'));
app.get('/locations/derby/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/derby/letting-agents.html'));
app.get('/locations/derby/builders', (req, res) => res.sendFile(__dirname + '/public/locations/derby/builders.html'));
app.get('/locations/derby/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/derby/electricians.html'));
app.get('/locations/derby/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/derby/plumbers.html'));
app.get('/locations/derby/salons', (req, res) => res.sendFile(__dirname + '/public/locations/derby/salons.html'));
app.get('/locations/derby/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/derby/restaurants.html'));
app.get('/locations/derby/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/derby/accountants.html'));
app.get('/locations/derby/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/derby/handymen.html'));
app.get('/locations/derby/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/derby/veterinary.html'));
app.get('/locations/southampton/dental', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/dental.html'));
app.get('/locations/southampton/medical', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/medical.html'));
app.get('/locations/southampton/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/solicitors.html'));
app.get('/locations/southampton/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/estate-agents.html'));
app.get('/locations/southampton/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/letting-agents.html'));
app.get('/locations/southampton/builders', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/builders.html'));
app.get('/locations/southampton/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/electricians.html'));
app.get('/locations/southampton/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/plumbers.html'));
app.get('/locations/southampton/salons', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/salons.html'));
app.get('/locations/southampton/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/restaurants.html'));
app.get('/locations/southampton/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/accountants.html'));
app.get('/locations/southampton/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/handymen.html'));
app.get('/locations/southampton/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/southampton/veterinary.html'));
app.get('/locations/portsmouth/dental', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/dental.html'));
app.get('/locations/portsmouth/medical', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/medical.html'));
app.get('/locations/portsmouth/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/solicitors.html'));
app.get('/locations/portsmouth/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/estate-agents.html'));
app.get('/locations/portsmouth/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/letting-agents.html'));
app.get('/locations/portsmouth/builders', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/builders.html'));
app.get('/locations/portsmouth/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/electricians.html'));
app.get('/locations/portsmouth/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/plumbers.html'));
app.get('/locations/portsmouth/salons', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/salons.html'));
app.get('/locations/portsmouth/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/restaurants.html'));
app.get('/locations/portsmouth/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/accountants.html'));
app.get('/locations/portsmouth/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/handymen.html'));
app.get('/locations/portsmouth/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/portsmouth/veterinary.html'));
app.get('/locations/reading/dental', (req, res) => res.sendFile(__dirname + '/public/locations/reading/dental.html'));
app.get('/locations/reading/medical', (req, res) => res.sendFile(__dirname + '/public/locations/reading/medical.html'));
app.get('/locations/reading/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/reading/solicitors.html'));
app.get('/locations/reading/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/reading/estate-agents.html'));
app.get('/locations/reading/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/reading/letting-agents.html'));
app.get('/locations/reading/builders', (req, res) => res.sendFile(__dirname + '/public/locations/reading/builders.html'));
app.get('/locations/reading/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/reading/electricians.html'));
app.get('/locations/reading/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/reading/plumbers.html'));
app.get('/locations/reading/salons', (req, res) => res.sendFile(__dirname + '/public/locations/reading/salons.html'));
app.get('/locations/reading/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/reading/restaurants.html'));
app.get('/locations/reading/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/reading/accountants.html'));
app.get('/locations/reading/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/reading/handymen.html'));
app.get('/locations/reading/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/reading/veterinary.html'));
app.get('/locations/milton-keynes/dental', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/dental.html'));
app.get('/locations/milton-keynes/medical', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/medical.html'));
app.get('/locations/milton-keynes/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/solicitors.html'));
app.get('/locations/milton-keynes/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/estate-agents.html'));
app.get('/locations/milton-keynes/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/letting-agents.html'));
app.get('/locations/milton-keynes/builders', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/builders.html'));
app.get('/locations/milton-keynes/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/electricians.html'));
app.get('/locations/milton-keynes/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/plumbers.html'));
app.get('/locations/milton-keynes/salons', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/salons.html'));
app.get('/locations/milton-keynes/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/restaurants.html'));
app.get('/locations/milton-keynes/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/accountants.html'));
app.get('/locations/milton-keynes/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/handymen.html'));
app.get('/locations/milton-keynes/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/milton-keynes/veterinary.html'));
app.get('/locations/norwich/dental', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/dental.html'));
app.get('/locations/norwich/medical', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/medical.html'));
app.get('/locations/norwich/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/solicitors.html'));
app.get('/locations/norwich/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/estate-agents.html'));
app.get('/locations/norwich/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/letting-agents.html'));
app.get('/locations/norwich/builders', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/builders.html'));
app.get('/locations/norwich/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/electricians.html'));
app.get('/locations/norwich/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/plumbers.html'));
app.get('/locations/norwich/salons', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/salons.html'));
app.get('/locations/norwich/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/restaurants.html'));
app.get('/locations/norwich/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/accountants.html'));
app.get('/locations/norwich/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/handymen.html'));
app.get('/locations/norwich/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/norwich/veterinary.html'));
app.get('/locations/luton/dental', (req, res) => res.sendFile(__dirname + '/public/locations/luton/dental.html'));
app.get('/locations/luton/medical', (req, res) => res.sendFile(__dirname + '/public/locations/luton/medical.html'));
app.get('/locations/luton/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/luton/solicitors.html'));
app.get('/locations/luton/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/luton/estate-agents.html'));
app.get('/locations/luton/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/luton/letting-agents.html'));
app.get('/locations/luton/builders', (req, res) => res.sendFile(__dirname + '/public/locations/luton/builders.html'));
app.get('/locations/luton/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/luton/electricians.html'));
app.get('/locations/luton/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/luton/plumbers.html'));
app.get('/locations/luton/salons', (req, res) => res.sendFile(__dirname + '/public/locations/luton/salons.html'));
app.get('/locations/luton/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/luton/restaurants.html'));
app.get('/locations/luton/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/luton/accountants.html'));
app.get('/locations/luton/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/luton/handymen.html'));
app.get('/locations/luton/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/luton/veterinary.html'));
app.get('/locations/newcastle/dental', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/dental.html'));
app.get('/locations/newcastle/medical', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/medical.html'));
app.get('/locations/newcastle/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/solicitors.html'));
app.get('/locations/newcastle/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/estate-agents.html'));
app.get('/locations/newcastle/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/letting-agents.html'));
app.get('/locations/newcastle/builders', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/builders.html'));
app.get('/locations/newcastle/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/electricians.html'));
app.get('/locations/newcastle/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/plumbers.html'));
app.get('/locations/newcastle/salons', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/salons.html'));
app.get('/locations/newcastle/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/restaurants.html'));
app.get('/locations/newcastle/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/accountants.html'));
app.get('/locations/newcastle/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/handymen.html'));
app.get('/locations/newcastle/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/newcastle/veterinary.html'));
app.get('/locations/sunderland/dental', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/dental.html'));
app.get('/locations/sunderland/medical', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/medical.html'));
app.get('/locations/sunderland/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/solicitors.html'));
app.get('/locations/sunderland/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/estate-agents.html'));
app.get('/locations/sunderland/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/letting-agents.html'));
app.get('/locations/sunderland/builders', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/builders.html'));
app.get('/locations/sunderland/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/electricians.html'));
app.get('/locations/sunderland/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/plumbers.html'));
app.get('/locations/sunderland/salons', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/salons.html'));
app.get('/locations/sunderland/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/restaurants.html'));
app.get('/locations/sunderland/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/accountants.html'));
app.get('/locations/sunderland/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/handymen.html'));
app.get('/locations/sunderland/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/sunderland/veterinary.html'));
app.get('/locations/exeter/dental', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/dental.html'));
app.get('/locations/exeter/medical', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/medical.html'));
app.get('/locations/exeter/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/solicitors.html'));
app.get('/locations/exeter/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/estate-agents.html'));
app.get('/locations/exeter/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/letting-agents.html'));
app.get('/locations/exeter/builders', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/builders.html'));
app.get('/locations/exeter/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/electricians.html'));
app.get('/locations/exeter/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/plumbers.html'));
app.get('/locations/exeter/salons', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/salons.html'));
app.get('/locations/exeter/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/restaurants.html'));
app.get('/locations/exeter/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/accountants.html'));
app.get('/locations/exeter/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/handymen.html'));
app.get('/locations/exeter/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/exeter/veterinary.html'));
app.get('/locations/oxford/dental', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/dental.html'));
app.get('/locations/oxford/medical', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/medical.html'));
app.get('/locations/oxford/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/solicitors.html'));
app.get('/locations/oxford/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/estate-agents.html'));
app.get('/locations/oxford/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/letting-agents.html'));
app.get('/locations/oxford/builders', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/builders.html'));
app.get('/locations/oxford/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/electricians.html'));
app.get('/locations/oxford/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/plumbers.html'));
app.get('/locations/oxford/salons', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/salons.html'));
app.get('/locations/oxford/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/restaurants.html'));
app.get('/locations/oxford/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/accountants.html'));
app.get('/locations/oxford/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/handymen.html'));
app.get('/locations/oxford/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/oxford/veterinary.html'));
app.get('/locations/cambridge/dental', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/dental.html'));
app.get('/locations/cambridge/medical', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/medical.html'));
app.get('/locations/cambridge/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/solicitors.html'));
app.get('/locations/cambridge/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/estate-agents.html'));
app.get('/locations/cambridge/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/letting-agents.html'));
app.get('/locations/cambridge/builders', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/builders.html'));
app.get('/locations/cambridge/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/electricians.html'));
app.get('/locations/cambridge/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/plumbers.html'));
app.get('/locations/cambridge/salons', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/salons.html'));
app.get('/locations/cambridge/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/restaurants.html'));
app.get('/locations/cambridge/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/accountants.html'));
app.get('/locations/cambridge/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/handymen.html'));
app.get('/locations/cambridge/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/cambridge/veterinary.html'));
app.get('/locations/brighton/dental', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/dental.html'));
app.get('/locations/brighton/medical', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/medical.html'));
app.get('/locations/brighton/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/solicitors.html'));
app.get('/locations/brighton/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/estate-agents.html'));
app.get('/locations/brighton/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/letting-agents.html'));
app.get('/locations/brighton/builders', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/builders.html'));
app.get('/locations/brighton/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/electricians.html'));
app.get('/locations/brighton/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/plumbers.html'));
app.get('/locations/brighton/salons', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/salons.html'));
app.get('/locations/brighton/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/restaurants.html'));
app.get('/locations/brighton/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/accountants.html'));
app.get('/locations/brighton/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/handymen.html'));
app.get('/locations/brighton/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/brighton/veterinary.html'));
app.get('/locations/york/dental', (req, res) => res.sendFile(__dirname + '/public/locations/york/dental.html'));
app.get('/locations/york/medical', (req, res) => res.sendFile(__dirname + '/public/locations/york/medical.html'));
app.get('/locations/york/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/york/solicitors.html'));
app.get('/locations/york/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/york/estate-agents.html'));
app.get('/locations/york/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/york/letting-agents.html'));
app.get('/locations/york/builders', (req, res) => res.sendFile(__dirname + '/public/locations/york/builders.html'));
app.get('/locations/york/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/york/electricians.html'));
app.get('/locations/york/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/york/plumbers.html'));
app.get('/locations/york/salons', (req, res) => res.sendFile(__dirname + '/public/locations/york/salons.html'));
app.get('/locations/york/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/york/restaurants.html'));
app.get('/locations/york/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/york/accountants.html'));
app.get('/locations/york/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/york/handymen.html'));
app.get('/locations/york/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/york/veterinary.html'));
app.get('/locations/bath/dental', (req, res) => res.sendFile(__dirname + '/public/locations/bath/dental.html'));
app.get('/locations/bath/medical', (req, res) => res.sendFile(__dirname + '/public/locations/bath/medical.html'));
app.get('/locations/bath/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/bath/solicitors.html'));
app.get('/locations/bath/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bath/estate-agents.html'));
app.get('/locations/bath/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/bath/letting-agents.html'));
app.get('/locations/bath/builders', (req, res) => res.sendFile(__dirname + '/public/locations/bath/builders.html'));
app.get('/locations/bath/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/bath/electricians.html'));
app.get('/locations/bath/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/bath/plumbers.html'));
app.get('/locations/bath/salons', (req, res) => res.sendFile(__dirname + '/public/locations/bath/salons.html'));
app.get('/locations/bath/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/bath/restaurants.html'));
app.get('/locations/bath/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/bath/accountants.html'));
app.get('/locations/bath/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/bath/handymen.html'));
app.get('/locations/bath/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/bath/veterinary.html'));
app.get('/locations/gloucester/dental', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/dental.html'));
app.get('/locations/gloucester/medical', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/medical.html'));
app.get('/locations/gloucester/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/solicitors.html'));
app.get('/locations/gloucester/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/estate-agents.html'));
app.get('/locations/gloucester/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/letting-agents.html'));
app.get('/locations/gloucester/builders', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/builders.html'));
app.get('/locations/gloucester/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/electricians.html'));
app.get('/locations/gloucester/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/plumbers.html'));
app.get('/locations/gloucester/salons', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/salons.html'));
app.get('/locations/gloucester/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/restaurants.html'));
app.get('/locations/gloucester/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/accountants.html'));
app.get('/locations/gloucester/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/handymen.html'));
app.get('/locations/gloucester/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/gloucester/veterinary.html'));
app.get('/locations/ipswich/dental', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/dental.html'));
app.get('/locations/ipswich/medical', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/medical.html'));
app.get('/locations/ipswich/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/solicitors.html'));
app.get('/locations/ipswich/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/estate-agents.html'));
app.get('/locations/ipswich/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/letting-agents.html'));
app.get('/locations/ipswich/builders', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/builders.html'));
app.get('/locations/ipswich/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/electricians.html'));
app.get('/locations/ipswich/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/plumbers.html'));
app.get('/locations/ipswich/salons', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/salons.html'));
app.get('/locations/ipswich/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/restaurants.html'));
app.get('/locations/ipswich/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/accountants.html'));
app.get('/locations/ipswich/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/handymen.html'));
app.get('/locations/ipswich/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/ipswich/veterinary.html'));
app.get('/locations/peterborough/dental', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/dental.html'));
app.get('/locations/peterborough/medical', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/medical.html'));
app.get('/locations/peterborough/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/solicitors.html'));
app.get('/locations/peterborough/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/estate-agents.html'));
app.get('/locations/peterborough/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/letting-agents.html'));
app.get('/locations/peterborough/builders', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/builders.html'));
app.get('/locations/peterborough/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/electricians.html'));
app.get('/locations/peterborough/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/plumbers.html'));
app.get('/locations/peterborough/salons', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/salons.html'));
app.get('/locations/peterborough/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/restaurants.html'));
app.get('/locations/peterborough/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/accountants.html'));
app.get('/locations/peterborough/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/handymen.html'));
app.get('/locations/peterborough/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/peterborough/veterinary.html'));
app.get('/locations/swansea/dental', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/dental.html'));
app.get('/locations/swansea/medical', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/medical.html'));
app.get('/locations/swansea/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/solicitors.html'));
app.get('/locations/swansea/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/estate-agents.html'));
app.get('/locations/swansea/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/letting-agents.html'));
app.get('/locations/swansea/builders', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/builders.html'));
app.get('/locations/swansea/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/electricians.html'));
app.get('/locations/swansea/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/plumbers.html'));
app.get('/locations/swansea/salons', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/salons.html'));
app.get('/locations/swansea/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/restaurants.html'));
app.get('/locations/swansea/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/accountants.html'));
app.get('/locations/swansea/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/handymen.html'));
app.get('/locations/swansea/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/swansea/veterinary.html'));
app.get('/locations/edinburgh/dental', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/dental.html'));
app.get('/locations/edinburgh/medical', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/medical.html'));
app.get('/locations/edinburgh/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/solicitors.html'));
app.get('/locations/edinburgh/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/estate-agents.html'));
app.get('/locations/edinburgh/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/letting-agents.html'));
app.get('/locations/edinburgh/builders', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/builders.html'));
app.get('/locations/edinburgh/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/electricians.html'));
app.get('/locations/edinburgh/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/plumbers.html'));
app.get('/locations/edinburgh/salons', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/salons.html'));
app.get('/locations/edinburgh/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/restaurants.html'));
app.get('/locations/edinburgh/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/accountants.html'));
app.get('/locations/edinburgh/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/handymen.html'));
app.get('/locations/edinburgh/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/edinburgh/veterinary.html'));
app.get('/locations/glasgow/dental', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/dental.html'));
app.get('/locations/glasgow/medical', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/medical.html'));
app.get('/locations/glasgow/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/solicitors.html'));
app.get('/locations/glasgow/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/estate-agents.html'));
app.get('/locations/glasgow/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/letting-agents.html'));
app.get('/locations/glasgow/builders', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/builders.html'));
app.get('/locations/glasgow/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/electricians.html'));
app.get('/locations/glasgow/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/plumbers.html'));
app.get('/locations/glasgow/salons', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/salons.html'));
app.get('/locations/glasgow/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/restaurants.html'));
app.get('/locations/glasgow/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/accountants.html'));
app.get('/locations/glasgow/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/handymen.html'));
app.get('/locations/glasgow/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/glasgow/veterinary.html'));
app.get('/locations/aberdeen/dental', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/dental.html'));
app.get('/locations/aberdeen/medical', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/medical.html'));
app.get('/locations/aberdeen/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/solicitors.html'));
app.get('/locations/aberdeen/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/estate-agents.html'));
app.get('/locations/aberdeen/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/letting-agents.html'));
app.get('/locations/aberdeen/builders', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/builders.html'));
app.get('/locations/aberdeen/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/electricians.html'));
app.get('/locations/aberdeen/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/plumbers.html'));
app.get('/locations/aberdeen/salons', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/salons.html'));
app.get('/locations/aberdeen/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/restaurants.html'));
app.get('/locations/aberdeen/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/accountants.html'));
app.get('/locations/aberdeen/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/handymen.html'));
app.get('/locations/aberdeen/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/aberdeen/veterinary.html'));
app.get('/locations/dundee/dental', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/dental.html'));
app.get('/locations/dundee/medical', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/medical.html'));
app.get('/locations/dundee/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/solicitors.html'));
app.get('/locations/dundee/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/estate-agents.html'));
app.get('/locations/dundee/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/letting-agents.html'));
app.get('/locations/dundee/builders', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/builders.html'));
app.get('/locations/dundee/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/electricians.html'));
app.get('/locations/dundee/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/plumbers.html'));
app.get('/locations/dundee/salons', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/salons.html'));
app.get('/locations/dundee/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/restaurants.html'));
app.get('/locations/dundee/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/accountants.html'));
app.get('/locations/dundee/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/handymen.html'));
app.get('/locations/dundee/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/dundee/veterinary.html'));
app.get('/locations/cardiff/dental', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/dental.html'));
app.get('/locations/cardiff/medical', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/medical.html'));
app.get('/locations/cardiff/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/solicitors.html'));
app.get('/locations/cardiff/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/estate-agents.html'));
app.get('/locations/cardiff/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/letting-agents.html'));
app.get('/locations/cardiff/builders', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/builders.html'));
app.get('/locations/cardiff/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/electricians.html'));
app.get('/locations/cardiff/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/plumbers.html'));
app.get('/locations/cardiff/salons', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/salons.html'));
app.get('/locations/cardiff/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/restaurants.html'));
app.get('/locations/cardiff/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/accountants.html'));
app.get('/locations/cardiff/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/handymen.html'));
app.get('/locations/cardiff/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/cardiff/veterinary.html'));
app.get('/locations/belfast/dental', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/dental.html'));
app.get('/locations/belfast/medical', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/medical.html'));
app.get('/locations/belfast/solicitors', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/solicitors.html'));
app.get('/locations/belfast/estate-agents', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/estate-agents.html'));
app.get('/locations/belfast/letting-agents', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/letting-agents.html'));
app.get('/locations/belfast/builders', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/builders.html'));
app.get('/locations/belfast/electricians', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/electricians.html'));
app.get('/locations/belfast/plumbers', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/plumbers.html'));
app.get('/locations/belfast/salons', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/salons.html'));
app.get('/locations/belfast/restaurants', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/restaurants.html'));
app.get('/locations/belfast/accountants', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/accountants.html'));
app.get('/locations/belfast/handymen', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/handymen.html'));
app.get('/locations/belfast/veterinary', (req, res) => res.sendFile(__dirname + '/public/locations/belfast/veterinary.html'));



// ── Lead management routes ───────────────────────────────────────────
app.get('/api/leads', authRequired, (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json({ leads });
});

app.post('/api/leads/status', authRequired, (req, res) => {
  const { lead_id, status } = req.body;
  if (!['new','contacted','converted','lost'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, lead_id);
  res.json({ success: true });
});

// ── Lead capture ─────────────────────────────────────────────────────
app.post('/api/leads/submit', async (req, res) => {
  const { business_name, first_name, last_name, email, phone, industry, message } = req.body;
  if (!business_name || !first_name || !email || !phone) {
    return res.status(400).json({ error: 'Required fields missing' });
  }
  try {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    db.prepare(`INSERT INTO leads (id, business_name, first_name, last_name, email, phone, industry, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, business_name, first_name, last_name||'', email, phone, industry||'', message||'');

    // Send notification to admin
    const adminHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:580px;margin:0 auto;background:#060912;color:#f0f4f8;padding:0;border-radius:16px;overflow:hidden;border:1px solid #1a2332">'
      + '<div style="background:#080e18;padding:24px 32px;border-bottom:1px solid #1a2332">'
      + '<div style="font-size:24px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div>'
      + '</div>'
      + '<div style="background:rgba(0,212,255,.06);border-bottom:1px solid rgba(0,212,255,.15);padding:16px 32px;display:flex;align-items:center;gap:12px">'
      + '<div style="width:36px;height:36px;border-radius:50%;background:rgba(0,212,255,.1);border:2px solid rgba(0,212,255,.3);display:flex;align-items:center;justify-content:center;font-size:16px">🎯</div>'
      + '<div><div style="font-size:16px;font-weight:700">New Lead!</div><div style="font-size:12px;color:#5a7a9a">Website enquiry · ' + new Date().toLocaleString('en-GB',{timeZone:'Europe/London'}) + '</div></div>'
      + '</div>'
      + '<div style="padding:24px 32px">'
      + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin-bottom:20px">'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">'
      + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Business</div><div style="font-size:14px;font-weight:600;color:#f0f4f8">' + business_name + '</div></div>'
      + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Contact</div><div style="font-size:14px;font-weight:600;color:#f0f4f8">' + first_name + ' ' + (last_name||'') + '</div></div>'
      + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Email</div><div style="font-size:14px;color:#00d4ff">' + email + '</div></div>'
      + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Phone</div><div style="font-size:14px;color:#f0f4f8">' + phone + '</div></div>'
      + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Industry</div><div style="font-size:14px;color:#f0f4f8">' + (industry||'Not specified') + '</div></div>'
      + '</div>'
      + (message ? '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #1a2332"><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:8px">Message</div><div style="font-size:13px;color:#8896a8;line-height:1.6">' + message + '</div></div>' : '')
      + '</div>'
      + '<a href="https://airingdesk.com/dashboard" style="display:inline-block;background:#00d4ff;color:#020408;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:700">View in dashboard →</a>'
      + '</div>'
      + '<div style="background:#080e18;border-top:1px solid #1a2332;padding:16px 32px"><div style="font-size:11px;color:#3d4f63">AiRingDesk · Lead Notification</div></div>'
      + '</div>';

    await sendBrevoEmail(process.env.NOTIFY_EMAIL, '🎯 New Lead: ' + business_name + ' — ' + first_name, adminHtml);

    // Send confirmation to lead
    const confirmHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:580px;margin:0 auto;background:#060912;color:#f0f4f8;padding:0;border-radius:16px;overflow:hidden;border:1px solid #1a2332">'
      + '<div style="background:#080e18;padding:24px 32px;border-bottom:1px solid #1a2332">'
      + '<div style="font-size:24px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div>'
      + '</div>'
      + '<div style="padding:28px 32px">'
      + '<h2 style="font-size:22px;font-weight:700;margin-bottom:12px">Thanks for getting in touch, ' + first_name + '! 👋</h2>'
      + '<p style="color:#8896a8;line-height:1.8;margin-bottom:20px">We have received your enquiry for <strong style="color:#f0f4f8">' + business_name + '</strong> and our team will call you back within 1 business hour.</p>'
      + '<div style="background:#0d1117;border:1px solid rgba(0,212,255,.2);border-radius:12px;padding:20px;margin-bottom:24px">'
      + '<div style="font-size:11px;color:#00d4ff;text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:12px">What happens next</div>'
      + '<div style="font-size:13px;color:#8896a8;line-height:1.8">'
      + '&#10003; Our team will call you back within 1 business hour<br>'
      + '&#10003; We will set up your AI receptionist in under 30 minutes<br>'
      + '&#10003; You will start your 7-day free trial immediately<br>'
      + '&#10003; No contracts, cancel anytime'
      + '</div></div>'
      + '<p style="color:#5a7a9a;font-size:13px;margin-bottom:24px">In the meantime, you can <a href="https://airingdesk.com/dashboard" style="color:#00d4ff">create your account</a> and explore the dashboard.</p>'
      + '<a href="https://airingdesk.com" style="display:inline-block;background:#00d4ff;color:#020408;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:700">Visit airingdesk.com →</a>'
      + '</div>'
      + '<div style="background:#080e18;border-top:1px solid #1a2332;padding:16px 32px;display:flex;justify-content:space-between">'
      + '<div style="font-size:11px;color:#3d4f63">AiRingDesk · hello@airingdesk.com</div>'
      + '<a href="https://airingdesk.com" style="font-size:11px;color:#5a7a9a;text-decoration:none">airingdesk.com</a>'
      + '</div></div>';

    await sendBrevoEmail(email, 'Thanks for your enquiry — AiRingDesk will call you shortly!', confirmHtml);

    console.log('New lead saved:', business_name, email);
    res.json({ success: true });
  } catch(e) {
    console.error('Lead submit error:', e.message);
    res.status(500).json({ error: 'Failed to submit enquiry' });
  }
});

app.get('/signup', (req, res) => {
  const ref = req.query.ref || '';
  const plan = req.query.plan || 'starter';
  res.redirect('/?signup=true&plan=' + plan + '&ref=' + ref);
});

app.get('/billing/success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Welcome to AiRingDesk!</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#020408;color:#f0f6ff;font-family:'Geist',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#080e18;border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:48px 40px;max-width:480px;width:100%;text-align:center}
.icon{width:72px;height:72px;border-radius:50%;background:rgba(0,232,122,.1);border:2px solid rgba(0,232,122,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
.logo{font-size:24px;font-weight:800;margin-bottom:32px}
h1{font-size:26px;font-weight:700;margin-bottom:12px}
p{color:#5a7a9a;font-size:15px;line-height:1.7;margin-bottom:8px}
.steps{background:#0c1520;border-radius:12px;padding:20px;margin:24px 0;text-align:left}
.step{display:flex;align-items:center;gap:12px;padding:8px 0;font-size:14px;color:#f0f6ff}
.step-num{width:24px;height:24px;border-radius:50%;background:rgba(0,212,255,.15);color:#00d4ff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.btn{display:inline-block;background:#00d4ff;color:#020408;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none;margin-top:8px}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div>
  <div class="icon">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00e87a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
  </div>
  <h1>You're all set! 🎉</h1>
  <p>Your 7-day free trial has started.</p>
  <p>No charge until your trial ends.</p>
  <div class="steps">
    <div class="step"><div class="step-num">1</div> Log into your dashboard</div>
    <div class="step"><div class="step-num">2</div> Pick your UK phone number</div>
    <div class="step"><div class="step-num">3</div> Customise your AI receptionist</div>
    <div class="step"><div class="step-num">4</div> Go live in under 30 minutes</div>
  </div>
  <a href="/dashboard" class="btn">Go to dashboard →</a>
</div>
</body>
</html>`);
});

app.get('/billing/cancel', (req, res) => res.redirect('/'));

// Temp invoice preview (remove after testing)
app.get('/invoice-preview/:id', (req, res) => {
  const fs = require('fs');
  const path = '/var/www/vhosts/airingdesk.com/httpdocs/data/invoices/' + req.params.id + '.pdf';
  if (fs.existsSync(path)) {
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(path).pipe(res);
  } else {
    res.status(404).send('Not found');
  }
});

// Incident log — admin/superadmin only
app.get("/admin/incident-log", (req, res) => {
  const token = req.query.token;
  const deny = '<div style="font-family:sans-serif;background:#060912;color:#5a7a9a;height:100vh;display:flex;align-items:center;justify-content:center;font-size:14px">Access denied — superadmin only</div>';
  if (!token) return res.status(403).send(deny);
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    if (!['admin','superadmin'].includes(user.role)) return res.status(403).send(deny);
    res.sendFile(__dirname + '/public/admin/incident-log.html');
  } catch (e) { res.status(403).send(deny); }
});

// Forgot password
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const client = db.prepare("SELECT * FROM clients WHERE email = ?").get(email);
  // Always return success to prevent email enumeration
  res.json({ success: true });
  if (!client) return;
  const resetToken = require('crypto').randomBytes(32).toString('hex');
  const resetExpiry = Math.floor(Date.now() / 1000) + (60 * 60); // 1 hour
  db.prepare("UPDATE clients SET verification_token = ?, verification_expires = ? WHERE id = ?").run(resetToken, resetExpiry, client.id);
  const resetUrl = process.env.DASHBOARD_URL + '/reset-password?token=' + resetToken;
  try {
    await sendBrevoEmail(email, 'Reset your AiRingDesk password', `
      <div style="font-family:'Helvetica Neue',sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">
        <div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>
        <h2 style="font-size:22px;font-weight:700;margin-bottom:12px">Reset your password</h2>
        <p style="color:#8896a8;font-size:15px;line-height:1.6;margin-bottom:24px">Hi ${client.business_name}, click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#00d4ff;color:#020408;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:700;margin-bottom:24px">Reset my password →</a>
        <p style="color:#5a7a9a;font-size:13px">If you did not request this, you can safely ignore this email.</p>
        <p style="color:#5a7a9a;font-size:12px;margin-top:16px">Or copy: <a href="${resetUrl}" style="color:#00d4ff">${resetUrl}</a></p>
      </div>
    `);
  } catch(e) { console.error('Reset email failed:', e.message); }
});

// Reset password page
app.get("/reset-password", (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/dashboard');
  const client = db.prepare("SELECT * FROM clients WHERE verification_token = ?").get(token);
  if (!client) return res.redirect('/dashboard?error=invalid-token');
  const now = Math.floor(Date.now() / 1000);
  if (client.verification_expires && client.verification_expires < now)
    return res.redirect('/dashboard?error=token-expired');
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset Password — AiRingDesk</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#060912;color:#f0f4f8;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#0c1520;border:1px solid #1a2d42;border-radius:16px;padding:40px;width:100%;max-width:420px}.logo{font-size:22px;font-weight:800;margin-bottom:24px}.logo .ai{color:#00d4ff}.logo .ring{color:#f0f6ff}.logo .desk{color:#5a7a9a}h2{font-size:20px;font-weight:700;margin-bottom:8px}p{color:#5a7a9a;font-size:14px;margin-bottom:24px}label{font-size:11px;color:#5a7a9a;text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:6px}input{width:100%;background:#060912;border:1px solid #1a2d42;color:#f0f4f8;padding:12px 14px;border-radius:8px;font-size:14px;outline:none;margin-bottom:16px}button{width:100%;background:#00d4ff;color:#020408;border:none;padding:14px;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}.msg{display:none;padding:12px;border-radius:8px;font-size:13px;margin-top:12px;text-align:center}</style>
</head>
<body>
<div class="card">
  <div class="logo"><span class="ai">Ai</span><span class="ring">Ring</span><span class="desk">Desk</span></div>
  <h2>Set new password</h2>
  <p>Enter your new password below.</p>
  <label>New password</label>
  <input type="password" id="p1" placeholder="Min. 8 characters"/>
  <label>Confirm password</label>
  <input type="password" id="p2" placeholder="Repeat new password"/>
  <button onclick="doReset()">Update password →</button>
  <div class="msg" id="msg"></div>
</div>
<script>
async function doReset() {
  var p1=document.getElementById('p1').value;
  var p2=document.getElementById('p2').value;
  var msg=document.getElementById('msg');
  msg.style.display='block';
  if(p1.length<8){msg.style.background='rgba(255,68,68,.1)';msg.style.color='#ff4466';msg.textContent='Password must be at least 8 characters.';return;}
  if(p1!==p2){msg.style.background='rgba(255,68,68,.1)';msg.style.color='#ff4466';msg.textContent='Passwords do not match.';return;}
  var r=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:''+new URLSearchParams(window.location.search).get('token')+'',password:p1})});
  var d=await r.json();
  if(r.ok){msg.style.background='rgba(0,230,118,.1)';msg.style.color='#00e676';msg.textContent='Password updated! Redirecting...';setTimeout(()=>window.location='/dashboard',2000);}
  else{msg.style.background='rgba(255,68,68,.1)';msg.style.color='#ff4466';msg.textContent=d.error||'Something went wrong.';}
}
</script>
</body>
</html>`);
});

// Reset password API
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) return res.status(400).json({ error: "Invalid request" });
  const client = db.prepare("SELECT * FROM clients WHERE verification_token = ?").get(token);
  if (!client) return res.status(400).json({ error: "Invalid or expired token" });
  const now = Math.floor(Date.now() / 1000);
  if (client.verification_expires && client.verification_expires < now)
    return res.status(400).json({ error: "Reset link has expired. Please request a new one." });
  const hash = await bcrypt.hash(password, 12);
  db.prepare("UPDATE clients SET password_hash = ?, verification_token = NULL, verification_expires = NULL WHERE id = ?").run(hash, client.id);
  res.json({ success: true });
});

// Email verification route
app.get("/verify-email", (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/dashboard?error=invalid-token');
  const client = db.prepare("SELECT * FROM clients WHERE verification_token = ?").get(token);
  if (!client) return res.redirect('/?error=invalid-token');
  const now = Math.floor(Date.now() / 1000);
  if (client.verification_expires && client.verification_expires < now)
    return res.redirect('/?error=token-expired');
  db.prepare("UPDATE clients SET email_verified = 1, verification_token = NULL, verification_expires = NULL WHERE id = ?").run(client.id);
  res.redirect('/dashboard?verified=true');
});

app.use("/api/admin", require("./routes/admin")(db, sendBrevoEmail));
app.use("/api/referral", require("./routes/referral")(db, sendBrevoEmail));
const invoiceRouter = require("./routes/invoice")(db);
app.use("/api/invoice", invoiceRouter);
app.use('/dashboard', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
}, require('express').static(__dirname + '/public/dashboard'));
app.get('/dashboard/*', (req, res) => res.sendFile(__dirname + '/public/dashboard/index.html'));

const PORT = process.env.PORT || 3000;
// ── Webhook API ──────────────────────────────────────────────────────────
app.get('/api/webhook/settings', authRequired, (req, res) => {
  const client = db.prepare("SELECT webhook_url, webhook_secret FROM clients WHERE id = ?").get(req.client.id);
  res.json({ webhook_url: client.webhook_url || '', webhook_secret: client.webhook_secret || '' });
});

app.post('/api/webhook/settings', authRequired, (req, res) => {
  const { webhook_url, webhook_secret } = req.body;
  db.prepare("UPDATE clients SET webhook_url = ?, webhook_secret = ? WHERE id = ?")
    .run(webhook_url || null, webhook_secret || null, req.client.id);
  res.json({ success: true });
});

app.post('/api/webhook/test', authRequired, async (req, res) => {
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);
  if (!client.webhook_url) return res.status(400).json({ error: 'No webhook URL set' });
  try {
    const testPayload = {
      event: 'call.completed',
      call_id: 'test-' + Date.now(),
      caller_name: 'Test Caller',
      caller_number: '+447700900000',
      status: 'completed',
      duration: 65,
      summary: 'Test call from AiRingDesk. Caller enquired about services.',
      transcript: [
        { role: 'user', content: 'Hello I would like some information' },
        { role: 'assistant', content: 'Of course, how can I help you today?' }
      ],
      started_at: Math.floor(Date.now() / 1000) - 65,
      ended_at: Math.floor(Date.now() / 1000),
      business_name: client.business_name,
      ai_number: client.phone_number
    };
    const body = JSON.stringify(testPayload);
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'AiRingDesk-Webhook/1.0', 'X-AiRingDesk-Event': 'test' };
    if (client.webhook_secret) {
      const crypto = require('crypto');
      headers['X-AiRingDesk-Signature'] = 'sha256=' + crypto.createHmac('sha256', client.webhook_secret).update(body).digest('hex');
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);
    const response = await fetch(client.webhook_url, { method: 'POST', headers, body, signal: controller.signal });
    res.json({ success: true, status: response.status, message: 'Test webhook delivered — HTTP ' + response.status });
  } catch(err) {
    res.status(500).json({ error: 'Webhook delivery failed: ' + err.message });
  }
});

// ── Send invoice email ───────────────────────────────────────────────
app.post('/api/invoice/send/:invoiceId', authRequired, async (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.client_id !== req.client.id && req.client.role !== 'superadmin' && req.client.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(invoice.client_id);
    const planNames = { trial:'Trial', essential:'Essential', starter:'Starter', professional:'Professional', business:'Business' };
    const ps = new Date(invoice.period_start*1000).toLocaleDateString('en-GB');
    const pe = new Date(invoice.period_end*1000).toLocaleDateString('en-GB');
    const invoiceUrl = process.env.DASHBOARD_URL + '/invoice-preview/' + invoice.id;
    const downloadUrl = process.env.DASHBOARD_URL + '/api/invoice/download/' + invoice.id;
    const emailHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
      + '<div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>'
      + '<h2 style="font-size:20px;margin-bottom:8px">Your Invoice ' + invoice.invoice_number + '</h2>'
      + '<p style="color:#8896a8;line-height:1.7">Hi ' + client.business_name + ', please find your invoice details below.</p>'
      + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin:24px 0">'
      + '<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#8896a8">Invoice</span><span style="color:#f0f4f8;font-weight:700">' + invoice.invoice_number + '</span></div>'
      + '<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#8896a8">Plan</span><span style="color:#f0f4f8">' + (planNames[invoice.plan]||invoice.plan) + '</span></div>'
      + '<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#8896a8">Period</span><span style="color:#f0f4f8">' + ps + ' — ' + pe + '</span></div>'
      + '<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#8896a8">Amount</span><span style="color:#f0f4f8">£' + (invoice.amount/100).toFixed(2) + '</span></div>'
      + (invoice.discount > 0 ? '<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#8896a8">Discount</span><span style="color:#00e87a">-£' + (invoice.discount/100).toFixed(2) + '</span></div>' : '')
      + '<div style="display:flex;justify-content:space-between;border-top:1px solid #1a2332;padding-top:12px;margin-top:4px"><span style="color:#f0f4f8;font-weight:700">Total Paid</span><span style="color:#00d4ff;font-size:18px;font-weight:800">£' + (invoice.final_amount/100).toFixed(2) + '</span></div>'
      + '</div>'
      + '<div style="display:flex;gap:12px;flex-wrap:wrap">'
      + '<a href="' + invoiceUrl + '" style="background:#00d4ff;color:#020408;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">View Invoice</a>'
      + '<a href="' + downloadUrl + '" style="background:transparent;border:1px solid #1a2332;color:#8896a8;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Download PDF</a>'
      + '</div>'
      + '<p style="color:#8896a8;font-size:13px;margin-top:24px">Thank you for your business!</p>'
      + '<p style="color:#8896a8;font-size:13px">AiRingDesk Team · hello@airingdesk.com</p></div>';
    await sendBrevoEmail(client.email, 'Your AiRingDesk Invoice ' + invoice.invoice_number, emailHtml);
    res.json({ success: true });
  } catch(e) {
    console.error('Send invoice error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Test usage emails ────────────────────────────────────────────────
app.post('/api/admin/test-usage-email', authRequired, async (req, res) => {
  const { type, client_id } = req.body; // '80' or '100'
  const targetId = client_id || req.client.id;
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(targetId);
  if (!client) return res.status(404).json({ error: 'Not found' });

  const planNames = { trial:'Trial', essential:'Essential', starter:'Starter', professional:'Professional', business:'Business' };
  const nextPlan = { trial:'Essential', essential:'Starter', starter:'Professional', professional:'Business', business:null };
  const next = nextPlan[client.plan];

  if (type === '80') {
    const warningHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
      + '<div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>'
      + '<h2 style="font-size:20px;margin-bottom:16px">⚠️ You have used 80% of your monthly calls</h2>'
      + '<p style="color:#8896a8;line-height:1.7">Hi ' + client.business_name + ', you have used <strong style="color:#ffb800">120 of 150 calls</strong> this month on your ' + planNames[client.plan] + ' plan.</p>'
      + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin:24px 0">'
      + '<p style="color:#f0f4f8;font-size:15px;font-weight:700;margin-bottom:8px">What happens when you reach your limit?</p>'
      + '<p style="color:#8896a8;font-size:13px">Your AI receptionist will stop answering calls until your next billing period.</p>'
      + '</div>'
      + (next ? '<p style="color:#8896a8;line-height:1.7">Upgrade to <strong style="color:#00d4ff">' + planNames[next] + '</strong> to get more calls and avoid any interruption.</p>'
        + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px">'
        + '<a href="https://airingdesk.com/dashboard#billing" style="display:inline-block;background:#00d4ff;color:#020408;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Upgrade to ' + planNames[next] + ' →</a>'
        + '<a href="https://airingdesk.com/dashboard?page=billing" style="display:inline-block;background:transparent;border:1px solid #1a2332;color:#8896a8;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View my usage</a>'
        + '</div>' : '')
      + '<p style="color:#8896a8;font-size:13px;margin-top:24px">AiRingDesk Team · hello@airingdesk.com</p></div>';
    await sendBrevoEmail(client.email, '[TEST] ⚠️ You have used 80% of your AiRingDesk call limit', warningHtml);
    res.json({ success: true, message: '80% warning email sent to ' + client.email });

  } else if (type === '100') {
    const limitHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
      + '<div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>'
      + '<h2 style="font-size:20px;margin-bottom:16px;color:#ff4466">🚫 You have reached your monthly call limit</h2>'
      + '<p style="color:#8896a8;line-height:1.7">Hi ' + client.business_name + ', you have used all <strong style="color:#ff4466">' + client.call_limit + ' calls</strong> on your ' + planNames[client.plan] + ' plan this month.</p>'
      + '<div style="background:#0d1117;border:1px solid rgba(255,68,102,.3);border-radius:12px;padding:20px;margin:24px 0">'
      + '<p style="color:#f0f4f8;font-size:15px;font-weight:700;margin-bottom:8px">Your AI receptionist is now offline</p>'
      + '<p style="color:#8896a8;font-size:13px">Callers will hear a message that you have reached your call limit. Upgrade now to restore service immediately.</p>'
      + '</div>'
      + (next ? '<p style="color:#8896a8;line-height:1.7;margin-bottom:16px">Upgrade to <strong style="color:#00d4ff">' + planNames[next] + '</strong> to restore your AI receptionist immediately.</p>'
        + '<div style="display:flex;gap:12px;flex-wrap:wrap">'
        + '<a href="https://airingdesk.com/dashboard#billing" style="display:inline-block;background:#ff4466;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Restore service now →</a>'
        + '<a href="https://airingdesk.com/dashboard" style="display:inline-block;background:transparent;border:1px solid #1a2332;color:#8896a8;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View my account</a>'
        + '</div>' : '')
      + '<p style="color:#8896a8;font-size:13px;margin-top:24px">AiRingDesk Team · hello@airingdesk.com</p></div>';
    await sendBrevoEmail(client.email, '[TEST] 🚫 Your AiRingDesk call limit has been reached', limitHtml);
    res.json({ success: true, message: '100% limit email sent to ' + client.email });
  } else {
    res.status(400).json({ error: 'Invalid type. Use 80 or 100' });
  }
});

// ── Demo Banner API ──────────────────────────────────────────────────
app.post('/api/admin/set-demo-banner', authRequired, (req, res) => {
  const { client_id, show_demo_banner } = req.body;
  db.prepare("UPDATE clients SET show_demo_banner = ? WHERE id = ?").run(show_demo_banner ? 1 : 0, client_id);
  res.json({ success: true });
});



// ── Appointments API ──────────────────────────────────────────────────
app.get('/api/appointments', authRequired, (req, res) => {
  const isAdmin = ['admin','superadmin'].includes(req.client.role);
  const query = isAdmin
    ? `SELECT a.*, c.caller_number, c.summary FROM appointments a LEFT JOIN calls c ON a.call_id = c.id WHERE a.client_id = ? ORDER BY a.date DESC, a.time DESC`
    : `SELECT a.*, c.caller_number, c.summary FROM appointments a LEFT JOIN calls c ON a.call_id = c.id WHERE a.client_id = ? AND a.client_deleted = 0 ORDER BY a.date DESC, a.time DESC`;
  const appointments = db.prepare(query).all(req.client.id);
  res.json({ appointments });
});

app.post('/api/appointments/status', authRequired, (req, res) => {
  const isAdmin = ['admin','superadmin'].includes(req.client.role);
  if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
  const { appointment_id, status } = req.body;
  if (!['pending','confirmed','cancelled','completed'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE appointments SET status = ? WHERE id = ? AND client_id = ?')
    .run(status, appointment_id, req.client.id);
  res.json({ success: true });
});

app.post('/api/appointments/archive', authRequired, (req, res) => {
  const { appointment_id } = req.body;
  db.prepare('UPDATE appointments SET client_archived = 1 WHERE id = ? AND client_id = ?')
    .run(appointment_id, req.client.id);
  res.json({ success: true });
});

app.post('/api/appointments/delete', authRequired, (req, res) => {
  const { appointment_id } = req.body;
  db.prepare('UPDATE appointments SET client_deleted = 1 WHERE id = ? AND client_id = ?')
    .run(appointment_id, req.client.id);
  res.json({ success: true });
});

app.post('/api/appointments/restore', authRequired, (req, res) => {
  if (!['admin','superadmin'].includes(req.client.role))
    return res.status(403).json({ error: 'Admin only' });
  const { appointment_id } = req.body;
  db.prepare('UPDATE appointments SET client_deleted = 0, client_archived = 0 WHERE id = ?')
    .run(appointment_id);
  res.json({ success: true });
});

app.get('/api/admin/appointments/:clientId', authRequired, (req, res) => {
  if (!['admin','superadmin'].includes(req.client.role))
    return res.status(403).json({ error: 'Admin only' });
  const appointments = db.prepare(`
    SELECT a.*, c.caller_number, c.summary
    FROM appointments a
    LEFT JOIN calls c ON a.call_id = c.id
    WHERE a.client_id = ?
    ORDER BY a.date DESC, a.time DESC
  `).all(req.params.clientId);
  res.json({ appointments });
});

app.listen(PORT, () => console.log(`\n🚀 RingDesk server running on port ${PORT}\n`));

// ═══════════════════════════════════════════════════════════════════════════════
//  PHONE NUMBER PROVISIONING
// ═══════════════════════════════════════════════════════════════════════════════
// Retell SDK removed

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Search available numbers by country
app.get('/api/numbers/search', authRequired, async (req, res) => {
  const { country = 'GB', areaCode } = req.query;
  try {
    const countryMap = { GB: 'GB', US: 'US', CH: 'CH', DE: 'DE', FR: 'FR', NL: 'NL' };
    const isoCountry = countryMap[country] || 'GB';
    const searchParams = { limit: 10, voiceEnabled: true };
    if (areaCode) {
      if (/^d+$/.test(areaCode)) {
        searchParams.areaCode = areaCode;
      } else {
        searchParams.inLocality = areaCode;
      }
    }

    let numbers;
    if (isoCountry === 'GB') {
      numbers = await twilioClient.availablePhoneNumbers('GB').local.list(searchParams);
    } else if (isoCountry === 'US') {
      numbers = await twilioClient.availablePhoneNumbers('US').local.list(searchParams);
    } else if (isoCountry === 'CH') {
      numbers = await twilioClient.availablePhoneNumbers('CH').local.list(searchParams);
    } else {
      numbers = await twilioClient.availablePhoneNumbers(isoCountry).local.list(searchParams);
    }

    res.json({ numbers: numbers.map(n => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      region: n.region,
      locality: n.locality,
    }))});
  } catch (err) {
    console.error('Number search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Provision number for client after payment
app.post('/api/numbers/provision', authRequired, async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (client.phone_number) return res.status(400).json({ error: 'Already have a number' });

  try {
    // Purchase from Twilio - webhook points to our Express app (Claude AI answers)
    await twilioClient.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: process.env.DASHBOARD_URL + '/voice/incoming',
      voiceMethod: 'POST',
      statusCallback: process.env.DASHBOARD_URL + '/voice/status',
      statusCallbackMethod: 'POST',
    });

    // Save number to DB - AI answering starts immediately!
    db.prepare('UPDATE clients SET phone_number = ? WHERE id = ?').run(phoneNumber, client.id);

    // Set default AI prompt if none exists
    if (!client.ai_prompt) {
      const defaultPrompt = 'You are ' + (client.ai_name || 'Aria') + ', the professional AI receptionist for ' + client.business_name + '. Answer all calls warmly and professionally. Take messages with caller name and contact number. Help with general enquiries about the business.';
      db.prepare('UPDATE clients SET ai_prompt = ? WHERE id = ?').run(defaultPrompt, client.id);
    }

    console.log('Provisioned ' + phoneNumber + ' for ' + client.business_name);
    res.json({ success: true, phoneNumber, message: 'Your AI receptionist is now live!' });
  } catch (err) {
    console.error('Provisioning error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get client's current number status
app.get('/api/numbers/status', authRequired, (req, res) => {
  const client = db.prepare('SELECT phone_number, plan, plan_status FROM clients WHERE id = ?').get(req.client.id);
  res.json({
    hasNumber: !!client.phone_number,
    phoneNumber: client.phone_number,
    plan: client.plan,
    planStatus: client.plan_status,
  });
});

// ── AUTO-PROVISION NUMBER AFTER PAYMENT ──────────────────────────────────────
async function provisionNumberAfterPayment(clientId, phoneNumber) {
  if (!phoneNumber) return;
  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!client || client.phone_number) return;

    // Purchase from Twilio - webhook points to our Express app
    await twilioClient.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: process.env.DASHBOARD_URL + '/voice/incoming',
      voiceMethod: 'POST',
      statusCallback: process.env.DASHBOARD_URL + '/voice/status',
      statusCallbackMethod: 'POST',
    });

    // Save to DB - AI answering starts immediately!
    db.prepare('UPDATE clients SET phone_number = ? WHERE id = ?').run(phoneNumber, clientId);

    // Set default AI prompt if none exists
    if (!client.ai_prompt) {
      const defaultPrompt = 'You are ' + (client.ai_name || 'Aria') + ', the professional AI receptionist for ' + client.business_name + '. Answer all calls warmly, take messages with caller name and number, and help with enquiries.';
      db.prepare('UPDATE clients SET ai_prompt = ? WHERE id = ?').run(defaultPrompt, clientId);
    }

    console.log('Provisioned ' + phoneNumber + ' for ' + client.business_name + ' - AI live!');
  } catch (err) {
    console.error('Provisioning failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EMAIL SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
// ── Brevo HTTP API email sender ───────────────────────────────────────────────
async function sendBrevoEmail(to, subject, html) {
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 10000);
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'AiRingDesk', email: process.env.EMAIL_FROM || 'hello@airingdesk.com' },
      to: [{ email: to }],
      subject: subject,
      htmlContent: html,
    }),
  });
  clearTimeout(fetchTimeout);
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── Send welcome email to new customer ────────────────────────────────────────
async function sendVerificationEmail(business_name, email, verifyUrl) {
  try {
    await sendBrevoEmail(email, 'Verify your AiRingDesk account', `
      <div style="font-family:'Helvetica Neue',sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">
        <div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>
        <h2 style="font-size:22px;font-weight:700;margin-bottom:12px">Verify your email address</h2>
        <p style="color:#8896a8;font-size:15px;line-height:1.6;margin-bottom:24px">Hi ${business_name}, thanks for registering! Please click the button below to verify your email address and activate your account.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#00d4ff;color:#020408;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:700;margin-bottom:24px">Verify my email →</a>
        <p style="color:#5a7a9a;font-size:13px;line-height:1.6">If you did not create this account, you can safely ignore this email.</p>
        <p style="color:#5a7a9a;font-size:12px;margin-top:16px">Or copy this link: <a href="${verifyUrl}" style="color:#00d4ff">${verifyUrl}</a></p>
      </div>
    `);
    console.log('✅ Verification email sent to ' + email);
  } catch (err) {
    console.error('❌ Verification email failed:', err.message);
  }
}

async function sendWelcomeEmail(business_name, email, referral_code, id) {
  try {
    await sendBrevoEmail(email, `Welcome to AiRingDesk, ${business_name}! 🎉`,
      `
        <div style="font-family:'Helvetica Neue',sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">
          <div style="margin-bottom:24px"><div style="font-size:28px;font-weight:800"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div><div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div></div>
          <h1 style="font-size:22px;font-weight:700;margin-bottom:12px">Welcome aboard, ${business_name}! 🎉</h1>
          <p style="color:#8896a8;font-size:15px;line-height:1.7;margin-bottom:20px">
            Your AI receptionist is ready to go. You have a <strong style="color:#10b981">7-day free trial</strong> — no charge until your trial ends.
          </p>
          <div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin-bottom:24px">
            <div style="font-size:13px;color:#8896a8;margin-bottom:8px">NEXT STEPS</div>
            <div style="font-size:14px;color:#f0f4f8;margin-bottom:8px">✅ Account created</div>
            <div style="font-size:14px;color:#f0f4f8;margin-bottom:8px">📞 Pick your phone number</div>
            <div style="font-size:14px;color:#f0f4f8;margin-bottom:8px">🤖 Customise your AI receptionist</div>
            <div style="font-size:14px;color:#f0f4f8">🚀 Go live in 30 minutes</div>
          </div>
          <a href="https://airingdesk.com/dashboard" style="display:inline-block;background:#00d4ff;color:#020408;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:700;margin-bottom:24px">Go to your dashboard →</a>
          <p style="color:#3d4f63;font-size:12px;margin-top:24px;border-top:1px solid #1a2332;padding-top:16px">
            AiRingDesk · AI Receptionist Platform · <a href="https://airingdesk.com" style="color:#00d4ff">airingdesk.com</a>
          </p>
        </div>
      `);
    console.log(`✅ Welcome email sent to ${email}`);
    // Activate referral if code provided
    if (referral_code) {
      try {
        await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/referral/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ referral_code, new_client_id: id, new_client_email: email })
        });
        console.log('Referral activated for code:', referral_code);
      } catch(e) { console.error('Referral activation error:', e.message); }
    }
  } catch (err) {
    console.error(`❌ Welcome email failed:`, err.message);
  }
}

// ── Webhook delivery ─────────────────────────────────────────────────────────────
async function deliverWebhook(client, call, transcript) {
  if (!client.webhook_url) return;
  try {
    const payload = {
      event: 'call.completed',
      call_id: call.id,
      caller_name: call.caller_name || null,
      caller_number: call.caller_number || null,
      status: call.status,
      duration: call.duration || 0,
      summary: call.summary || null,
      transcript: transcript || [],
      started_at: call.started_at,
      ended_at: call.ended_at,
      business_name: client.business_name,
      ai_number: client.phone_number
    };

    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'AiRingDesk-Webhook/1.0',
      'X-AiRingDesk-Event': 'call.completed',
    };

    // Add HMAC signature if webhook secret is set
    if (client.webhook_secret) {
      const crypto = require('crypto');
      const sig = crypto.createHmac('sha256', client.webhook_secret).update(body).digest('hex');
      headers['X-AiRingDesk-Signature'] = 'sha256=' + sig;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(client.webhook_url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });
    clearTimeout(timeout);
    console.log('✅ Webhook delivered to ' + client.webhook_url + ' — status: ' + response.status);
  } catch(err) {
    console.error('❌ Webhook delivery failed:', err.message);
  }
}

// ── Send call notification email ───────────────────────────────────────────────
async function sendCallNotificationEmail(client, call, transcript) {
  if (!client.email_notifications) return;
  try {
    const duration = call.duration > 0 ? `${Math.floor(call.duration/60)}m ${call.duration%60}s` : 'Unknown';
    const transcriptHtml = transcript && transcript.length > 0
      ? transcript.map(m => `
          <div style="margin-bottom:8px;padding:10px 14px;border-radius:8px;background:${m.role==='user'?'rgba(0,212,255,0.06)':'rgba(0,232,122,0.06)'};border-left:3px solid ${m.role==='user'?'#00d4ff':'#00e87a'}">
            <div style="font-size:10px;color:${m.role==='user'?'#00d4ff':'#00e87a'};text-transform:uppercase;font-weight:700;margin-bottom:4px;letter-spacing:.06em">${m.role==='user'?'Caller':'AI Receptionist'}</div>
            <div style="font-size:13px;color:#e5e7eb;line-height:1.5">${m.content}</div>
          </div>`).join('')
      : '<p style="color:#5a7a9a;font-size:13px;font-style:italic">No transcript available</p>';

    await sendBrevoEmail(client.email, `📞 New call from ${call.caller_name || call.caller_number || 'Unknown'} — ${call.status}`, `
        <div style="font-family:'Helvetica Neue',sans-serif;max-width:580px;margin:0 auto;background:#060912;color:#f0f4f8;padding:0;border-radius:16px;overflow:hidden;border:1px solid #1a2332">

          <!-- Header -->
          <div style="background:#080e18;padding:28px 32px;border-bottom:1px solid #1a2332">
            <div style="font-size:24px;font-weight:800;margin-bottom:4px">
              <span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span>
            </div>
            <div style="font-size:11px;color:#5a7a9a;letter-spacing:.08em;text-transform:uppercase">AI Receptionist Platform</div>
          </div>

          <!-- Title bar -->
          <div style="background:rgba(0,212,255,.06);border-bottom:1px solid rgba(0,212,255,.15);padding:16px 32px;display:flex;align-items:center;gap:12px">
            <div style="width:36px;height:36px;border-radius:50%;background:rgba(0,212,255,.1);border:2px solid rgba(0,212,255,.3);display:flex;align-items:center;justify-content:center;font-size:16px">📞</div>
            <div>
              <div style="font-size:16px;font-weight:700;color:#f0f4f8">New call received</div>
              <div style="font-size:12px;color:#5a7a9a">${client.business_name} · ${new Date().toLocaleString('en-GB', {timeZone:'Europe/London'})}</div>
            </div>
          </div>

          <div style="padding:28px 32px">
            <!-- Call details -->
            <div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin-bottom:20px">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                <div>
                  <div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">FROM</div>
                  <div style="font-size:15px;font-weight:600;color:#f0f4f8">${call.caller_name || call.caller_number || 'Unknown'}</div>
                </div>
                <div>
                  <div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">STATUS</div>
                  <div style="font-size:15px;font-weight:600;color:${call.status==='completed'?'#00e87a':'#ffb800'};text-transform:capitalize">${call.status}</div>
                </div>
                <div>
                  <div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">DURATION</div>
                  <div style="font-size:15px;font-weight:600;color:#f0f4f8">${duration}</div>
                </div>
                <div>
                  <div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">TIME</div>
                  <div style="font-size:13px;color:#f0f4f8">${new Date().toLocaleString('en-GB', {timeZone:'Europe/London'})}</div>
                </div>
              </div>
              ${call.summary ? `
              <div style="margin-top:16px;padding-top:16px;border-top:1px solid #1a2332">
                <div style="font-size:10px;color:#00d4ff;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:8px">AI SUMMARY</div>
                <div style="font-size:13px;color:#8896a8;line-height:1.7;background:rgba(0,212,255,.04);padding:12px;border-radius:8px;border-left:3px solid rgba(0,212,255,.3)">${call.summary}</div>
              </div>` : ''}
            </div>

            <!-- Transcript -->
            <div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:10px">TRANSCRIPT</div>
            <div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:16px;margin-bottom:24px">
              ${transcriptHtml}
            </div>

            <!-- CTA Button -->
            <a href="https://airingdesk.com/dashboard" style="display:inline-block;background:#00d4ff;color:#020408;text-decoration:none;padding:13px 28px;border-radius:50px;font-size:14px;font-weight:700;letter-spacing:.02em">View in dashboard →</a>
          </div>

          <!-- Footer -->
          <div style="background:#080e18;border-top:1px solid #1a2332;padding:16px 32px;display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:11px;color:#3d4f63">AiRingDesk · AI Receptionist Platform</div>
            <a href="https://airingdesk.com" style="font-size:11px;color:#5a7a9a;text-decoration:none">airingdesk.com</a>
          </div>
        </div>
      `);
    console.log(`✅ Call notification sent to ${client.email}`);
  } catch (err) {
    console.error(`❌ Call notification failed:`, err.message);
  }
}

// ── Test email endpoint ────────────────────────────────────────────────────────
app.post('/api/email/test', authRequired, async (req, res) => {
  const client = { email: req.client.email || process.env.NOTIFY_EMAIL };
  try {
    await sendBrevoEmail(client.email, '✅ AiRingDesk email test successful!', '<div style="font-family:sans-serif;padding:20px"><h2>Email is working!</h2><p>AiRingDesk notifications are working correctly.</p></div>');
    res.json({ success: true, message: `Test email sent to ${client.email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
