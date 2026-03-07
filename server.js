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

// ── Health & Admin ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), clients: db.prepare("SELECT COUNT(*) as c FROM clients").get().c }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 RingDesk server running on port ${PORT}\n`));
