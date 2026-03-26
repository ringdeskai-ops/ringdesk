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
app.use(cors({ origin: process.env.DASHBOARD_URL || "*" }));
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
  starter:      { calls: 200,   price: 4900  },  // pence
  professional: { calls: 1000,  price: 14900 },
  business:     { calls: 99999, price: 34900 },
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
    db.prepare('INSERT INTO clients (id, business_name, email, password_hash, stripe_customer_id, ai_prompt, customer_number, role, first_name, last_name, contact_phone, address_line1, address_line2, city, county, postcode, country, region) VALUES (?, ?, ?, ?, ?, ?, ?, \'client\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
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
  const client = db.prepare("SELECT id, business_name, email, phone_number, plan, plan_status, ai_name, ai_prompt, departments, calls_this_month, call_limit, created_at, first_name, last_name, contact_phone, address_line1, address_line2, city, county, postcode, country, region, customer_number FROM clients WHERE id = ?").get(req.client.id);
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
  const { ai_name, ai_prompt, departments } = req.body;
  db.prepare("UPDATE clients SET ai_name = ?, ai_prompt = ?, departments = ? WHERE id = ?")
    .run(ai_name, ai_prompt, JSON.stringify(departments || {}), req.client.id);
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
    db.prepare("UPDATE clients SET plan = ?, plan_status = 'active', stripe_subscription_id = ?, call_limit = ? WHERE id = ?")
      .run(plan, session.subscription, limit, client_id);
    console.log(`Client ${client_id} upgraded to ${plan}`);
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = db.prepare("SELECT * FROM clients WHERE stripe_subscription_id = ?").get(session.id);
    if (sub) {
      db.prepare("UPDATE clients SET plan = 'trial', plan_status = 'cancelled', call_limit = 50 WHERE id = ?").run(sub.id);
      try {
        const cancelHtml = '<div style="font-family:Helvetica Neue,sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
          + '<div style="font-size:28px;font-weight:800;margin-bottom:24px"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div>'
          + '<h2 style="font-size:20px;margin-bottom:16px">Subscription Cancelled</h2>'
          + '<p style="color:#8896a8;line-height:1.7">Hi ' + sub.business_name + ', your AiRingDesk subscription has been cancelled. Your service remains active until the end of your current billing period.</p>'
          + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin:24px 0">'
          + '<p style="color:#8896a8;font-size:13px;margin-bottom:12px">What happens next:</p>'
          + '<p style="font-size:14px;margin-bottom:8px">&#8226; Your AI receptionist will stop answering calls at end of billing period</p>'
          + '<p style="font-size:14px;margin-bottom:8px">&#8226; Your data will be retained for 30 days then deleted</p>'
          + '<p style="font-size:14px">&#8226; You can reactivate anytime at <a href="https://airingdesk.com" style="color:#00d4ff">airingdesk.com</a></p>'
          + '</div>'
          + '<p style="color:#8896a8;font-size:13px">We are sorry to see you go. If there is anything we could have done better, please reply to this email.</p>'
          + '<p style="color:#8896a8;font-size:13px;margin-top:16px">AiRingDesk Team &middot; hello@airingdesk.com</p></div>';
        await sendBrevoEmail(sub.email, 'Your AiRingDesk subscription has been cancelled', cancelHtml);
        await sendBrevoEmail(process.env.NOTIFY_EMAIL,
          '[AiRingDesk] Subscription cancelled: ' + sub.business_name,
          '<p>Customer <strong>' + sub.business_name + '</strong> (' + sub.email + ') has cancelled their subscription.</p>');
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
        db.prepare("UPDATE clients SET plan_status = 'active' WHERE id = ?").run(sub.id);
        console.log("Payment succeeded - client " + sub.id + " plan activated");
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
      // Update plan status based on subscription status
      const statusMap = {
        'active': 'active',
        'past_due': 'past_due',
        'canceled': 'cancelled',
        'trialing': 'trial'
      };
      const newStatus = statusMap[subscription.status] || sub.plan_status;
      db.prepare("UPDATE clients SET plan_status = ? WHERE id = ?").run(newStatus, sub.id);
      console.log(`Subscription updated for client ${sub.id}: ${subscription.status}`);
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
    twiml.say(`Thank you for calling ${client.business_name}. We are unable to take your call right now. Please try again later.`);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // Create session + call record
  const callId = uuidv4();
  const existingSession = db.prepare("SELECT call_sid FROM call_sessions WHERE call_sid = ?").get(CallSid);
  if (!existingSession) {
    db.prepare("INSERT INTO call_sessions (call_sid, client_id) VALUES (?, ?)").run(CallSid, client.id);
    db.prepare("INSERT INTO calls (id, client_id, call_sid, caller_number) VALUES (?, ?, ?, ?)").run(callId, client.id, CallSid, From);
    db.prepare("UPDATE clients SET calls_this_month = calls_this_month + 1 WHERE id = ?").run(client.id);
  }

  // Use instant static greeting — no Claude call on incoming to avoid delays
  const aiName = client.ai_name || "Aria";
  const greeting = `Thank you for calling ${client.business_name}. My name is ${aiName}, how can I help you today?`;

  const gather = twiml.gather({ input: "speech", action: "/voice/speech", method: "POST", speechTimeout: "auto", actionOnEmptyResult: true, timeout: 5, language: "en-GB", speechModel: "phone_call", enhanced: true });
  gather.say({ voice: "Polly.Amy-Neural" }, greeting);
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
    gather.say({ voice: "Polly.Amy-Neural" }, "I am sorry, I did not catch that. Could you say that again?");
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
      twiml.say({ voice: "Polly.Amy-Neural" }, reply);
      twiml.redirect("/voice/voicemail");
    } else if (transferDept) {
      twiml.say({ voice: "Polly.Amy-Neural" }, reply);
      twiml.pause({ length: 1 });
      twiml.redirect("/voice/transfer?dept=" + transferDept + "&callSid=" + CallSid + "&clientId=" + client.id);
    } else {
      const gather = twiml.gather({ input: "speech", action: "/voice/speech", method: "POST", speechTimeout: "auto", actionOnEmptyResult: true, timeout: 5, language: "en-GB", speechModel: "phone_call", enhanced: true });
      gather.say({ voice: "Polly.Amy-Neural" }, reply);
      twiml.redirect("/voice/speech");
    }
  } catch (err) {
    console.error("Claude error:", err.message);
    const gather = twiml.gather({ input: "speech", action: "/voice/speech", method: "POST", speechTimeout: "auto", actionOnEmptyResult: true, timeout: 5, language: "en-GB", speechModel: "phone_call", enhanced: true });
    gather.say({ voice: "Polly.Amy-Neural" }, "One moment please, could you repeat that?");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── Voicemail recording route ─────────────────────────────────────────────────
app.post("/voice/voicemail", (req, res) => {
  const { CallSid, To } = req.body;
  const twiml = new VoiceResponse();
  twiml.say({ voice: "Polly.Amy-Neural" }, "Please leave your message after the tone. Press any key or hang up when done.");
  twiml.record({
    action: '/voice/voicemail-done',
    method: 'POST',
    maxLength: 120,
    finishOnKey: '*',
    playBeep: true,
    recordingStatusCallback: '/voice/voicemail-done',
    recordingStatusCallbackMethod: 'POST'
  });
  twiml.say({ voice: "Polly.Amy-Neural" }, "Thank you for your message. Goodbye.");
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

      db.prepare(`INSERT INTO clients (id, business_name, email, password_hash, stripe_customer_id, ai_prompt, customer_number, role, first_name, last_name, email_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'client', ?, ?, 1)`)
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
  if (!token) return res.redirect('/dashboard');
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    if (!['admin','superadmin'].includes(user.role)) return res.status(403).send('Access denied');
    res.sendFile(__dirname + '/public/admin/incident-log.html');
  } catch (e) { res.redirect('/dashboard'); }
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
        <div style="font-size:28px;font-weight:800;margin-bottom:24px"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div>
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
        <div style="font-size:28px;font-weight:800;margin-bottom:24px"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div>
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
          <div style="font-size:28px;font-weight:800;margin-bottom:24px"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div>
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
