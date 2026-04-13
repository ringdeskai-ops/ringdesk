/**
 * RingDesk — Multi-Tenant AI Receptionist Server
 * One server, unlimited clients. Each client has:
 *   - Their own Twilio number
 *   - Their own AI personality/prompt
 *   - Their own call logs & transcripts
 *   - Their own transfer numbers
 *   - Their own Stripe subscription
 */

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const app = express();
const VoiceResponse = twilio.twiml.VoiceResponse;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Database setup (SQLite — swap for Postgres in prod) ───────────────────────
const db = new Database("ringdesk.db");
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

  -- ── Marketing platform ──────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS marketing_leads (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT NOT NULL,
    phone TEXT,
    business TEXT,
    message TEXT,
    source TEXT,                 -- utm_source or 'direct'|'organic'|'referral'
    medium TEXT,                 -- utm_medium
    campaign TEXT,               -- utm_campaign
    landing_page TEXT,           -- first page hit
    referrer TEXT,
    status TEXT DEFAULT 'new',   -- new|contacted|qualified|demo|trial|won|lost
    assigned_to TEXT,            -- clients.id of team member
    notes TEXT,
    client_id TEXT,              -- set when lead converts to a client
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS marketing_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    confirmed INTEGER DEFAULT 1,
    unsubscribe_token TEXT UNIQUE,
    source TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS marketing_events (
    id TEXT PRIMARY KEY,
    visitor_id TEXT,             -- first-party cookie id
    type TEXT,                   -- pageview|lead|form_submit|click
    path TEXT,
    referrer TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    user_agent TEXT,
    ip TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_leads_status ON marketing_leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON marketing_leads(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_type ON marketing_events(type, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_visitor ON marketing_events(visitor_id);
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
  starter:      process.env.STRIPE_PRICE_STARTER,
  professional: process.env.STRIPE_PRICE_PROFESSIONAL,
  business:     process.env.STRIPE_PRICE_BUSINESS,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Register new client
app.post("/api/auth/register", async (req, res) => {
  const { business_name, email, password } = req.body;
  if (!business_name || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  const id = uuidv4();
  const password_hash = await bcrypt.hash(password, 12);

  // Create Stripe customer
  let stripeCustomerId = null;
  try {
    const customer = await stripe.customers.create({ email, name: business_name });
    stripeCustomerId = customer.id;
  } catch (err) {
    console.error("Stripe customer creation failed:", err.message);
  }

  const defaultPrompt = `You are ${business_name}'s AI receptionist. Be professional, warm, and helpful.
Answer general enquiries, take messages, and transfer to the right team when needed.
Keep responses under 40 words — this is a phone call.`;

  try {
    db.prepare(`INSERT INTO clients (id, business_name, email, password_hash, stripe_customer_id, ai_prompt)
                VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, business_name, email, password_hash, stripeCustomerId, defaultPrompt);

    const token = jwt.sign({ id, email, business_name }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, client: { id, business_name, email, plan: "trial" } });
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

  const token = jwt.sign(
    { id: client.id, email: client.email, business_name: client.business_name },
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
  const client = db.prepare("SELECT id, business_name, email, phone_number, plan, plan_status, ai_name, ai_prompt, departments, calls_this_month, call_limit, created_at FROM clients WHERE id = ?").get(req.client.id);
  if (!client) return res.status(404).json({ error: "Not found" });
  client.departments = JSON.parse(client.departments || "{}");
  res.json(client);
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
  const { plan } = req.body;
  const priceId = STRIPE_PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: "Invalid plan" });

  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);

  const session = await stripe.checkout.sessions.create({
    customer: client.stripe_customer_id,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.DASHBOARD_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.DASHBOARD_URL}/billing`,
    metadata: { client_id: client.id, plan },
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
    const sub = db.prepare("SELECT id FROM clients WHERE stripe_subscription_id = ?").get(session.id);
    if (sub) {
      db.prepare("UPDATE clients SET plan = 'trial', plan_status = 'cancelled', call_limit = 50 WHERE id = ?").run(sub.id);
    }
  }

  if (event.type === "invoice.payment_failed") {
    const sub = db.prepare("SELECT id FROM clients WHERE stripe_subscription_id = ?").get(session.subscription);
    if (sub) db.prepare("UPDATE clients SET plan_status = 'past_due' WHERE id = ?").run(sub.id);
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TWILIO VOICE ROUTES (multi-tenant — resolved by phone number)
// ═══════════════════════════════════════════════════════════════════════════════

function getClientByNumber(phoneNumber) {
  return db.prepare("SELECT * FROM clients WHERE phone_number = ?").get(phoneNumber);
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
  const history = JSON.parse(session.history || "[]");
  history.push({ role: "user", content: userMessage });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: buildSystemPrompt(client),
    messages: history,
  });

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
  db.prepare("INSERT INTO call_sessions (call_sid, client_id) VALUES (?, ?)").run(CallSid, client.id);
  db.prepare("INSERT INTO calls (id, client_id, call_sid, caller_number) VALUES (?, ?, ?, ?)").run(callId, client.id, CallSid, From);
  db.prepare("UPDATE clients SET calls_this_month = calls_this_month + 1 WHERE id = ?").run(client.id);

  // Get greeting from Claude
  let greeting;
  try {
    const session = db.prepare("SELECT * FROM call_sessions WHERE call_sid = ?").get(CallSid);
    const result = await askClaude(client, session, "[New call connected. Greet the caller warmly, introduce yourself, and ask how you can help. Max 20 words.]");
    greeting = result.reply;
  } catch {
    greeting = `Thank you for calling ${client.business_name}. How can I help you today?`;
  }

  const gather = twiml.gather({ input: "speech", action: "/voice/speech", speechTimeout: "auto", speechModel: "phone_call", enhanced: "true", actionOnEmptyResult: true });
  gather.say({ voice: "Polly.Joanna-Neural" }, greeting);
  twiml.redirect("/voice/incoming");

  res.type("text/xml").send(twiml.toString());
});

// Handle speech
app.post("/voice/speech", async (req, res) => {
  const { CallSid, To, SpeechResult, Confidence } = req.body;
  const client = getClientByNumber(To);
  const session = db.prepare("SELECT * FROM call_sessions WHERE call_sid = ?").get(CallSid);
  const twiml = new VoiceResponse();

  if (!client || !session) {
    twiml.say("I'm sorry, something went wrong. Please call again.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  if (!SpeechResult || parseFloat(Confidence || "0") < 0.3) {
    const gather = twiml.gather({ input: "speech", action: "/voice/speech", speechTimeout: "auto", actionOnEmptyResult: true });
    gather.say({ voice: "Polly.Joanna-Neural" }, "I'm sorry, I didn't catch that. Could you say that again?");
    return res.type("text/xml").send(twiml.toString());
  }

  try {
    const { reply, transferDept } = await askClaude(client, session, SpeechResult);

    if (transferDept) {
      twiml.say({ voice: "Polly.Joanna-Neural" }, reply);
      twiml.pause({ length: 1 });
      twiml.redirect(`/voice/transfer?dept=${transferDept}&callSid=${CallSid}&clientId=${client.id}`);
    } else {
      const gather = twiml.gather({ input: "speech", action: "/voice/speech", speechTimeout: "auto", actionOnEmptyResult: true });
      gather.say({ voice: "Polly.Joanna-Neural" }, reply);
      twiml.redirect("/voice/speech");
    }
  } catch (err) {
    console.error("Claude error:", err.message);
    const gather = twiml.gather({ input: "speech", action: "/voice/speech", speechTimeout: "auto", actionOnEmptyResult: true });
    gather.say({ voice: "Polly.Joanna-Neural" }, "I had a brief issue. Could you repeat that?");
  }

  res.type("text/xml").send(twiml.toString());
});

// Transfer
app.post("/voice/transfer", async (req, res) => {
  const { dept, callSid, clientId } = req.query;
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(clientId);
  const session = db.prepare("SELECT * FROM call_sessions WHERE call_sid = ?").get(callSid);
  const twiml = new VoiceResponse();

  const departments = JSON.parse(client?.departments || "{}");
  const targetNumber = departments[dept] || departments.general;

  // Generate summary async
  if (session) {
    const history = JSON.parse(session.history || "[]");
    if (history.length > 2) {
      anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        system: "Summarize this call in 2 sentences for a human agent. Include caller name, issue, key details.",
        messages: [{ role: "user", content: history.map(m => `${m.role === "user" ? "Caller" : "AI"}: ${m.content}`).join("\n") }],
      }).then(r => {
        const summary = r.content[0]?.text || "";
        db.prepare("UPDATE calls SET status = 'transferred', transferred_to = ?, summary = ? WHERE call_sid = ?")
          .run(dept, summary, callSid);
      }).catch(() => {});
    }
  }

  if (!targetNumber) {
    twiml.say({ voice: "Polly.Joanna-Neural" }, "Our team is unavailable right now. Please leave a message after the tone.");
    twiml.record({ action: "/voice/voicemail", maxLength: 120, playBeep: true, transcribe: true, transcribeCallback: "/voice/voicemail-transcript" });
  } else {
    twiml.say({ voice: "Polly.Joanna-Neural" }, `Connecting you now. Please hold.`);
    twiml.play({ loop: 2 }, "https://demo.twilio.com/docs/classic.mp3");
    const dial = twiml.dial({ timeout: 25, action: "/voice/transfer-failed" });
    dial.number(targetNumber);
  }

  res.type("text/xml").send(twiml.toString());
});

// Transfer failed → voicemail
app.post("/voice/transfer-failed", (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: "Polly.Joanna-Neural" }, "No agents are available. Please leave a message and we'll call you back.");
  twiml.record({ action: "/voice/voicemail", maxLength: 120, playBeep: true, transcribe: true, transcribeCallback: "/voice/voicemail-transcript" });
  res.type("text/xml").send(twiml.toString());
});

// Voicemail saved
app.post("/voice/voicemail", (req, res) => {
  const { CallSid, RecordingUrl } = req.body;
  db.prepare("UPDATE calls SET status = 'voicemail', recording_url = ? WHERE call_sid = ?").run(RecordingUrl, CallSid);
  const twiml = new VoiceResponse();
  twiml.say({ voice: "Polly.Joanna-Neural" }, "Your message has been saved. We'll call you back shortly. Goodbye!");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// Voicemail transcript
app.post("/voice/voicemail-transcript", (req, res) => {
  const { CallSid, TranscriptionText } = req.body;
  db.prepare("UPDATE calls SET summary = ? WHERE call_sid = ?").run(TranscriptionText, CallSid);
  res.sendStatus(200);
});

// Call status callback
app.post("/voice/status", (req, res) => {
  const { CallSid, CallDuration, CallStatus } = req.body;
  db.prepare("UPDATE calls SET duration = ?, status = CASE WHEN status = 'active' THEN 'completed' ELSE status END, ended_at = ? WHERE call_sid = ?")
    .run(parseInt(CallDuration || 0), Math.floor(Date.now() / 1000), CallSid);
  db.prepare("DELETE FROM call_sessions WHERE call_sid = ?").run(CallSid);
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MARKETING PLATFORM
//  Public endpoints are called from AiRingDesk.com (cross-origin allowed).
//  Admin endpoints require JWT auth and are consumed by Platform.jsx.
// ═══════════════════════════════════════════════════════════════════════════════

// Permissive CORS for public marketing endpoints (AiRingDesk.com + any campaign domain)
const marketingCors = cors({ origin: true, credentials: false });

// Simple in-memory rate limiter (per IP + path, sliding 1-min window)
const _rlStore = new Map();
function rateLimit(maxPerMin = 30) {
  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const entry = _rlStore.get(key) || { count: 0, reset: now + 60_000 };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
    entry.count++;
    _rlStore.set(key, entry);
    if (entry.count > maxPerMin) return res.status(429).json({ error: "Too many requests — slow down" });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rlStore) if (now > v.reset + 300_000) _rlStore.delete(k);
}, 600_000).unref?.();

const getIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || null;
const isEmail = (e) => typeof e === "string" && /^\S+@\S+\.\S+$/.test(e);

// ─── Public: capture a lead (from any form on AiRingDesk.com) ─────────────────
app.post("/api/leads", marketingCors, rateLimit(10), (req, res) => {
  const { name, email, phone, business, message, source, medium, campaign, landing_page, referrer } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: "Valid email required" });
  try {
    const id = uuidv4();
    db.prepare(`INSERT INTO marketing_leads
      (id, name, email, phone, business, message, source, medium, campaign, landing_page, referrer)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        (name || "").slice(0, 120) || null,
        email.toLowerCase().slice(0, 200),
        (phone || "").slice(0, 40) || null,
        (business || "").slice(0, 200) || null,
        (message || "").slice(0, 2000) || null,
        (source || "direct").slice(0, 80),
        (medium || "").slice(0, 80) || null,
        (campaign || "").slice(0, 120) || null,
        (landing_page || "").slice(0, 300) || null,
        (referrer || "").slice(0, 300) || null
      );
    res.json({ success: true, id });
  } catch (err) {
    console.error("lead capture error:", err.message);
    res.status(500).json({ error: "Failed to save lead" });
  }
});

// CORS preflight for public endpoints
app.options("/api/leads", marketingCors);
app.options("/api/subscribe", marketingCors);
app.options("/api/track", marketingCors);

// ─── Public: newsletter signup ────────────────────────────────────────────────
app.post("/api/subscribe", marketingCors, rateLimit(5), (req, res) => {
  const { email, source } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: "Valid email required" });
  try {
    const id = uuidv4();
    const token = uuidv4().replace(/-/g, "");
    db.prepare(`INSERT OR IGNORE INTO marketing_subscribers (id, email, unsubscribe_token, source)
                VALUES (?,?,?,?)`)
      .run(id, email.toLowerCase().slice(0, 200), token, (source || "website").slice(0, 80));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to subscribe" });
  }
});

// ─── Public: one-click unsubscribe (for email footers) ───────────────────────
app.get("/api/unsubscribe", marketingCors, (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Missing token");
  const row = db.prepare("SELECT id FROM marketing_subscribers WHERE unsubscribe_token = ?").get(token);
  if (!row) return res.status(404).send("Not found");
  db.prepare("UPDATE marketing_subscribers SET confirmed = 0 WHERE id = ?").run(row.id);
  res.type("text/html").send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#f9fafb"><h2>You've been unsubscribed</h2><p>You won't receive any more emails from us.</p></body></html>`);
});

// ─── Public: record an event (pageview, form submit, etc) ─────────────────────
app.post("/api/track", marketingCors, rateLimit(120), (req, res) => {
  const { visitor_id, type, path, referrer, utm_source, utm_medium, utm_campaign } = req.body || {};
  if (!type) return res.status(400).json({ error: "type required" });
  try {
    db.prepare(`INSERT INTO marketing_events
      (id, visitor_id, type, path, referrer, utm_source, utm_medium, utm_campaign, user_agent, ip)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        uuidv4(),
        (visitor_id || "").slice(0, 80) || null,
        String(type).slice(0, 40),
        (path || "").slice(0, 300) || null,
        (referrer || "").slice(0, 300) || null,
        (utm_source || "").slice(0, 80) || null,
        (utm_medium || "").slice(0, 80) || null,
        (utm_campaign || "").slice(0, 120) || null,
        (req.headers["user-agent"] || "").slice(0, 200),
        getIp(req)
      );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to track" });
  }
});

// ─── Public: tracking snippet — drop <script src="/api/marketing/track.js"> ──
app.get("/api/marketing/track.js", marketingCors, (req, res) => {
  const serverUrl = process.env.SERVER_URL || "";
  res.type("application/javascript").set("Cache-Control", "public, max-age=3600").send(`/* AiRingDesk tracking snippet */
(function(){
  var API=${JSON.stringify(serverUrl)};
  try{var s=document.currentScript;if(s&&s.src){API=new URL(s.src).origin;}}catch(e){}
  function cid(){var k="_rdv",m=document.cookie.match(new RegExp("(?:^|; )"+k+"=([^;]+)"));if(m)return m[1];var id="v_"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);document.cookie=k+"="+id+"; max-age=31536000; path=/; SameSite=Lax";return id;}
  function q(n){return new URLSearchParams(location.search).get(n);}
  function post(url,body){try{if(navigator.sendBeacon){navigator.sendBeacon(url,new Blob([JSON.stringify(body)],{type:"application/json"}));return;}}catch(e){}fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),keepalive:true}).catch(function(){});}
  var utmKey="_rdutm",saved={};try{saved=JSON.parse(sessionStorage.getItem(utmKey)||"{}");}catch(e){}
  var cur={utm_source:q("utm_source"),utm_medium:q("utm_medium"),utm_campaign:q("utm_campaign")};
  if(cur.utm_source||cur.utm_medium||cur.utm_campaign){saved=cur;try{sessionStorage.setItem(utmKey,JSON.stringify(saved));}catch(e){}}
  var ctx={visitor_id:cid(),path:location.pathname+location.search,referrer:document.referrer||null,utm_source:saved.utm_source,utm_medium:saved.utm_medium,utm_campaign:saved.utm_campaign};
  post(API+"/api/track",Object.assign({type:"pageview"},ctx));
  document.addEventListener("submit",function(e){
    var f=e.target;if(!f||!f.matches||!f.matches("form[data-rd-lead]"))return;
    e.preventDefault();
    var fd=new FormData(f),body={};fd.forEach(function(v,k){body[k]=v;});
    Object.assign(body,{source:ctx.utm_source||"direct",medium:ctx.utm_medium,campaign:ctx.utm_campaign,landing_page:ctx.path,referrer:ctx.referrer});
    var btn=f.querySelector("[type=submit]");if(btn){btn.disabled=true;btn.dataset.__orig=btn.textContent;btn.textContent="Sending...";}
    fetch(API+"/api/leads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
      .then(function(r){if(!r.ok)throw 0;return r.json();})
      .then(function(){
        post(API+"/api/track",Object.assign({type:"lead"},ctx));
        var t=f.getAttribute("data-rd-thanks")||"Thanks! We'll be in touch shortly.";
        f.innerHTML='<div style="padding:16px;color:#10b981;font-weight:600;text-align:center">'+t+'</div>';
      })
      .catch(function(){if(btn){btn.disabled=false;btn.textContent=btn.dataset.__orig||"Submit";}alert("Something went wrong. Please try again.");});
  },true);
  // newsletter forms: <form data-rd-subscribe>
  document.addEventListener("submit",function(e){
    var f=e.target;if(!f||!f.matches||!f.matches("form[data-rd-subscribe]"))return;
    e.preventDefault();
    var fd=new FormData(f),email=fd.get("email");
    if(!email)return;
    fetch(API+"/api/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email,source:"newsletter"})})
      .then(function(){f.innerHTML='<div style="padding:12px;color:#10b981;font-weight:600">Subscribed ✓</div>';})
      .catch(function(){alert("Please try again.");});
  },true);
})();`);
});

// ─── Admin: list leads with filters ───────────────────────────────────────────
app.get("/api/marketing/leads", authRequired, (req, res) => {
  const { status, q, limit = 200, offset = 0 } = req.query;
  let sql = "SELECT * FROM marketing_leads";
  const where = [], params = [];
  if (status && status !== "all") { where.push("status = ?"); params.push(status); }
  if (q) { where.push("(email LIKE ? OR name LIKE ? OR business LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));
  const leads = db.prepare(sql).all(...params);
  const total = db.prepare("SELECT COUNT(*) as c FROM marketing_leads").get().c;
  res.json({ leads, total });
});

// ─── Admin: update a lead (status, notes, assignment, conversion) ─────────────
app.patch("/api/marketing/leads/:id", authRequired, (req, res) => {
  const { status, notes, assigned_to, client_id } = req.body || {};
  const valid = ["new", "contacted", "qualified", "demo", "trial", "won", "lost"];
  const fields = [], values = [];
  if (status !== undefined) {
    if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });
    fields.push("status = ?"); values.push(status);
  }
  if (notes !== undefined) { fields.push("notes = ?"); values.push(notes); }
  if (assigned_to !== undefined) { fields.push("assigned_to = ?"); values.push(assigned_to || null); }
  if (client_id !== undefined) { fields.push("client_id = ?"); values.push(client_id || null); }
  if (!fields.length) return res.status(400).json({ error: "No fields to update" });
  fields.push("updated_at = unixepoch()");
  values.push(req.params.id);
  const info = db.prepare(`UPDATE marketing_leads SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  if (info.changes === 0) return res.status(404).json({ error: "Lead not found" });
  res.json({ success: true });
});

// ─── Admin: delete a lead ─────────────────────────────────────────────────────
app.delete("/api/marketing/leads/:id", authRequired, (req, res) => {
  db.prepare("DELETE FROM marketing_leads WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ─── Admin: list newsletter subscribers ───────────────────────────────────────
app.get("/api/marketing/subscribers", authRequired, (req, res) => {
  const subs = db.prepare(
    "SELECT id, email, confirmed, source, created_at FROM marketing_subscribers ORDER BY created_at DESC LIMIT 1000"
  ).all();
  const total = db.prepare("SELECT COUNT(*) as c FROM marketing_subscribers WHERE confirmed = 1").get().c;
  res.json({ subscribers: subs, total });
});

// ─── Admin: export subscribers as CSV ─────────────────────────────────────────
app.get("/api/marketing/subscribers.csv", authRequired, (req, res) => {
  const subs = db.prepare(
    "SELECT email, source, created_at FROM marketing_subscribers WHERE confirmed = 1 ORDER BY created_at DESC"
  ).all();
  const csv = "email,source,subscribed_at\n" +
    subs.map(s => `${s.email},${s.source || ""},${new Date(s.created_at * 1000).toISOString()}`).join("\n");
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="subscribers.csv"').send(csv);
});

// ─── Admin: marketing overview stats ──────────────────────────────────────────
app.get("/api/marketing/stats", authRequired, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const d30 = now - 30 * 86400;
  const d7 = now - 7 * 86400;

  const totalLeads = db.prepare("SELECT COUNT(*) as c FROM marketing_leads").get().c;
  const leadsMonth = db.prepare("SELECT COUNT(*) as c FROM marketing_leads WHERE created_at > ?").get(d30).c;
  const leadsWeek = db.prepare("SELECT COUNT(*) as c FROM marketing_leads WHERE created_at > ?").get(d7).c;

  const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM marketing_leads GROUP BY status").all();
  const statusMap = { new: 0, contacted: 0, qualified: 0, demo: 0, trial: 0, won: 0, lost: 0 };
  byStatus.forEach(r => { statusMap[r.status] = r.count; });

  const bySource = db.prepare(
    "SELECT COALESCE(source,'direct') as source, COUNT(*) as count FROM marketing_leads WHERE created_at > ? GROUP BY source ORDER BY count DESC LIMIT 10"
  ).all(d30);

  const subscribers = db.prepare("SELECT COUNT(*) as c FROM marketing_subscribers WHERE confirmed = 1").get().c;
  const newSubs30 = db.prepare(
    "SELECT COUNT(*) as c FROM marketing_subscribers WHERE confirmed = 1 AND created_at > ?"
  ).get(d30).c;

  const pageviews30 = db.prepare(
    "SELECT COUNT(*) as c FROM marketing_events WHERE type = 'pageview' AND created_at > ?"
  ).get(d30).c;
  const uniqueVisitors30 = db.prepare(
    "SELECT COUNT(DISTINCT visitor_id) as c FROM marketing_events WHERE type = 'pageview' AND created_at > ? AND visitor_id IS NOT NULL"
  ).get(d30).c;

  // conversion: lead → paying client (joined via client_id) OR marked won
  const converted30 = db.prepare(`
    SELECT COUNT(*) as c FROM marketing_leads l
    LEFT JOIN clients c ON c.id = l.client_id
    WHERE l.created_at > ? AND (l.status = 'won' OR (c.plan IS NOT NULL AND c.plan != 'trial'))
  `).get(d30).c;

  const conversionRate = leadsMonth > 0 ? Math.round((converted30 / leadsMonth) * 1000) / 10 : 0;

  // leads by day for the chart
  const leadsByDay = db.prepare(`
    SELECT date(created_at, 'unixepoch') as day, COUNT(*) as count
    FROM marketing_leads WHERE created_at > ?
    GROUP BY day ORDER BY day
  `).all(d30);

  // top landing pages (from events)
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
    by_status: statusMap,
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

// ── Health & Admin ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), clients: db.prepare("SELECT COUNT(*) as c FROM clients").get().c }));

app.get("/api/marketing/health", (req, res) => res.json({
  status: "ok",
  leads: db.prepare("SELECT COUNT(*) as c FROM marketing_leads").get().c,
  subscribers: db.prepare("SELECT COUNT(*) as c FROM marketing_subscribers WHERE confirmed=1").get().c,
  events_24h: db.prepare("SELECT COUNT(*) as c FROM marketing_events WHERE created_at > ?").get(Math.floor(Date.now()/1000) - 86400).c,
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 RingDesk server running on port ${PORT}\n`));
