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
    const customer = stripe ? await stripe.customers.create({ email, name: business_name }) : { id: null };
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
  sendWelcomeEmail(business_name, email);
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
  const { plan, phone_number } = req.body;
  const priceId = STRIPE_PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: "Invalid plan" });

  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);

  const session = await stripe.checkout.sessions.create({
    customer: client.stripe_customer_id,
    mode: "subscription",
    subscription_data: { trial_period_days: 14 },
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
    const sub = db.prepare("SELECT id FROM clients WHERE stripe_subscription_id = ?").get(session.id);
    if (sub) {
      db.prepare("UPDATE clients SET plan = 'trial', plan_status = 'cancelled', call_limit = 50 WHERE id = ?").run(sub.id);
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
    // Trial ended and first payment succeeded - activate full plan
    const invoice = event.data.object;
    if (invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_update") {
      const sub = db.prepare("SELECT * FROM clients WHERE stripe_subscription_id = ?").get(invoice.subscription);
      if (sub && sub.plan_status !== "active") {
        db.prepare("UPDATE clients SET plan_status = 'active' WHERE id = ?").run(sub.id);
        console.log(`Payment succeeded - client ${sub.id} plan activated`);
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
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
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

  const gather = twiml.gather({ input: "speech", action: "/voice/speech", speechTimeout: "3", speechModel: "phone_call", enhanced: "true", actionOnEmptyResult: false, language: "en-GB" });
  gather.say({ voice: "Polly.Amy-Neural" }, greeting);
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

  if (!SpeechResult || SpeechResult.trim() === "") {
    const gather = twiml.gather({ input: "speech", action: "/voice/speech", speechTimeout: "3", speechModel: "phone_call", enhanced: "true", actionOnEmptyResult: false, language: "en-GB" });
    gather.say({ voice: "Polly.Amy-Neural" }, "I'm sorry, I didn't catch that. Could you say that again?");
    return res.type("text/xml").send(twiml.toString());
  }

  try {
    const { reply, transferDept } = await askClaude(client, session, SpeechResult);

    if (transferDept) {
      twiml.say({ voice: "Polly.Amy-Neural" }, reply);
      twiml.pause({ length: 1 });
      twiml.redirect(`/voice/transfer?dept=${transferDept}&callSid=${CallSid}&clientId=${client.id}`);
    } else {
      const gather = twiml.gather({ input: "speech", action: "/voice/speech", speechTimeout: "3", speechModel: "phone_call", enhanced: "true", actionOnEmptyResult: false, language: "en-GB" });
      gather.say({ voice: "Polly.Amy-Neural" }, reply);
      twiml.redirect("/voice/speech");
    }
  } catch (err) {
    console.error("Claude error:", err.message);
    const gather = twiml.gather({ input: "speech", action: "/voice/speech", speechTimeout: "3", speechModel: "phone_call", enhanced: "true", actionOnEmptyResult: false, language: "en-GB" });
    gather.say({ voice: "Polly.Amy-Neural" }, "I had a brief issue. Could you repeat that?");
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
        model: "claude-haiku-4-5-20251001",
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
    twiml.say({ voice: "Polly.Amy-Neural" }, "Our team is unavailable right now. Please leave a message after the tone.");
    twiml.record({ action: "/voice/voicemail", maxLength: 120, playBeep: true, transcribe: true, transcribeCallback: "/voice/voicemail-transcript" });
  } else {
    twiml.say({ voice: "Polly.Amy-Neural" }, `Connecting you now. Please hold.`);
    twiml.play({ loop: 2 }, "https://demo.twilio.com/docs/classic.mp3");
    const dial = twiml.dial({ timeout: 25, action: "/voice/transfer-failed" });
    dial.number(targetNumber);
  }

  res.type("text/xml").send(twiml.toString());
});

// Transfer failed → voicemail
app.post("/voice/transfer-failed", (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: "Polly.Amy-Neural" }, "No agents are available. Please leave a message and we'll call you back.");
  twiml.record({ action: "/voice/voicemail", maxLength: 120, playBeep: true, transcribe: true, transcribeCallback: "/voice/voicemail-transcript" });
  res.type("text/xml").send(twiml.toString());
});

// Voicemail saved
app.post("/voice/voicemail", (req, res) => {
  const { CallSid, RecordingUrl } = req.body;
  db.prepare("UPDATE calls SET status = 'voicemail', recording_url = ? WHERE call_sid = ?").run(RecordingUrl, CallSid);
  const twiml = new VoiceResponse();
  twiml.say({ voice: "Polly.Amy-Neural" }, "Your message has been saved. We'll call you back shortly. Goodbye!");
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
      });
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

// ── Health & Admin ─────────────────────────────────────────────────────────────
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
  <p>Your 14-day free trial has started.</p>
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

app.use("/api/admin", require("./routes/admin")(db));
app.use('/dashboard', require('express').static(__dirname + '/public/dashboard'));
app.get('/dashboard/*', (req, res) => res.sendFile(__dirname + '/public/dashboard/index.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 RingDesk server running on port ${PORT}\n`));

// ═══════════════════════════════════════════════════════════════════════════════
//  PHONE NUMBER PROVISIONING
// ═══════════════════════════════════════════════════════════════════════════════
const Retell = require('retell-sdk');
const retell = new Retell({ apiKey: process.env.RETELL_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Search available numbers by country
app.get('/api/numbers/search', authRequired, async (req, res) => {
  const { country = 'GB', areaCode } = req.query;
  try {
    const countryMap = { GB: 'GB', US: 'US', CH: 'CH', DE: 'DE', FR: 'FR', NL: 'NL' };
    const isoCountry = countryMap[country] || 'GB';
    const searchParams = { limit: 10, voiceEnabled: true };
    if (areaCode) searchParams.areaCode = areaCode;

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

  const client = { email: req.client.email || process.env.NOTIFY_EMAIL };
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (client.phone_number) return res.status(400).json({ error: 'Already have a number' });

  try {
    // Step 1: Purchase number from Twilio
    const purchased = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: `${process.env.DASHBOARD_URL}/voice/incoming`,
      voiceMethod: 'POST',
      statusCallback: `${process.env.DASHBOARD_URL}/voice/status`,
      statusCallbackMethod: 'POST',
    });

    // Step 2: Import number into Retell
    await retell.phoneNumber.import({
      twilio_phone_number: phoneNumber,
      twilio_account_sid: process.env.TWILIO_ACCOUNT_SID,
      twilio_auth_token: process.env.TWILIO_AUTH_TOKEN,
    });

    // Step 3: Create Retell AI agent for this client
    const agent = await retell.agent.create({
      agent_name: `${client.business_name} - AI Receptionist`,
      voice_id: 'elevenlabs-Paige',
      llm_websocket_url: `${process.env.DASHBOARD_URL}/retell-llm`,
      response_engine: {
        type: 'retell-llm',
        llm_id: 'gpt-4o-mini',
      },
      begin_message: `Thank you for calling ${client.business_name}. How can I help you today?`,
    });

    // Step 4: Link agent to number
    await retell.phoneNumber.update(phoneNumber, {
      agent_id: agent.agent_id,
    });

    // Step 5: Save to database
    db.prepare('UPDATE clients SET phone_number = ? WHERE id = ?').run(phoneNumber, client.id);

    res.json({ success: true, phoneNumber, agentId: agent.agent_id });
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

    // Purchase from Twilio
    await twilioClient.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: `${process.env.DASHBOARD_URL}/voice/incoming`,
      voiceMethod: 'POST',
      statusCallback: `${process.env.DASHBOARD_URL}/voice/status`,
      statusCallbackMethod: 'POST',
    });

    // Import into Retell
    await retell.phoneNumber.import({
      twilio_phone_number: phoneNumber,
      twilio_account_sid: process.env.TWILIO_ACCOUNT_SID,
      twilio_auth_token: process.env.TWILIO_AUTH_TOKEN,
    });

    // Create Retell agent
    const agent = await retell.agent.create({
      agent_name: `${client.business_name} - AI Receptionist`,
      voice_id: 'elevenlabs-Paige',
      response_engine: { type: 'retell-llm', llm_id: 'gpt-4o-mini' },
      begin_message: `Thank you for calling ${client.business_name}. How can I help you today?`,
    });

    // Link agent to number
    await retell.phoneNumber.update(phoneNumber, { agent_id: agent.agent_id });

    // Save to DB
    db.prepare('UPDATE clients SET phone_number = ? WHERE id = ?').run(phoneNumber, clientId);
    console.log(`✅ Provisioned ${phoneNumber} for client ${clientId}`);
  } catch (err) {
    console.error('❌ Provisioning failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EMAIL SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
// ── Brevo HTTP API email sender ───────────────────────────────────────────────
async function sendBrevoEmail(to, subject, html) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
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
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── Send welcome email to new customer ────────────────────────────────────────
async function sendWelcomeEmail(business_name, email) {
  try {
    await sendBrevoEmail(email, `Welcome to AiRingDesk, ${business_name}! 🎉`,
      `
        <div style="font-family:'Helvetica Neue',sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">
          <div style="font-size:28px;font-weight:800;margin-bottom:24px"><span style="color:#00d4ff">Ai</span><span style="color:#f0f6ff">Ring</span><span style="color:#5a7a9a">Desk</span></div>
          <h1 style="font-size:22px;font-weight:700;margin-bottom:12px">Welcome aboard, ${business_name}! 🎉</h1>
          <p style="color:#8896a8;font-size:15px;line-height:1.7;margin-bottom:20px">
            Your AI receptionist is ready to go. You have a <strong style="color:#10b981">14-day free trial</strong> — no charge until your trial ends.
          </p>
          <div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:20px;margin-bottom:24px">
            <div style="font-size:13px;color:#8896a8;margin-bottom:8px">NEXT STEPS</div>
            <div style="font-size:14px;color:#f0f4f8;margin-bottom:8px">✅ Account created</div>
            <div style="font-size:14px;color:#f0f4f8;margin-bottom:8px">📞 Pick your phone number</div>
            <div style="font-size:14px;color:#f0f4f8;margin-bottom:8px">🤖 Customise your AI receptionist</div>
            <div style="font-size:14px;color:#f0f4f8">🚀 Go live in 30 minutes</div>
          </div>
          <a href="https://airingdesk.com/dashboard" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:15px;font-weight:600;margin-bottom:24px">Go to your dashboard →</a>
          <p style="color:#3d4f63;font-size:12px;margin-top:24px;border-top:1px solid #1a2332;padding-top:16px">
            AiRingDesk · AI Receptionist Platform · <a href="https://airingdesk.com" style="color:#00d4ff">airingdesk.com</a>
          </p>
        </div>
      `);
    console.log(`✅ Welcome email sent to ${email}`);
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
          <div style="margin-bottom:8px;padding:8px 12px;border-radius:8px;background:${m.role==='user'?'rgba(59,130,246,0.1)':'rgba(139,92,246,0.1)'}">
            <div style="font-size:10px;color:${m.role==='user'?'#60a5fa':'#a78bfa'};text-transform:uppercase;margin-bottom:3px">${m.role==='user'?'Caller':'AI'}</div>
            <div style="font-size:13px;color:#e5e7eb">${m.content}</div>
          </div>`).join('')
      : '<p style="color:#8896a8;font-size:13px">No transcript available</p>';

    await sendBrevoEmail(client.email, `📞 New call from ${call.caller_name || call.caller_number || 'Unknown'} — ${call.status}`, `
        <div style="font-family:'Helvetica Neue',sans-serif;max-width:560px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">
          <div style="font-size:22px;font-weight:800;background:linear-gradient(135deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:20px">RingDesk</div>
          <h2 style="font-size:18px;margin-bottom:16px">New call received</h2>
          <div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:18px;margin-bottom:20px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div><div style="font-size:10px;color:#3d4f63;text-transform:uppercase;margin-bottom:3px">From</div><div style="font-size:14px;color:#f0f4f8">${call.caller_name || call.caller_number || 'Unknown'}</div></div>
              <div><div style="font-size:10px;color:#3d4f63;text-transform:uppercase;margin-bottom:3px">Status</div><div style="font-size:14px;color:#10b981;text-transform:capitalize">${call.status}</div></div>
              <div><div style="font-size:10px;color:#3d4f63;text-transform:uppercase;margin-bottom:3px">Duration</div><div style="font-size:14px;color:#f0f4f8">${duration}</div></div>
              <div><div style="font-size:10px;color:#3d4f63;text-transform:uppercase;margin-bottom:3px">Time</div><div style="font-size:14px;color:#f0f4f8">${new Date().toLocaleString('en-GB')}</div></div>
            </div>
            ${call.summary ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid #1a2332"><div style="font-size:10px;color:#3d4f63;text-transform:uppercase;margin-bottom:6px">AI Summary</div><div style="font-size:13px;color:#8896a8;line-height:1.6">${call.summary}</div></div>` : ''}
          </div>
          <div style="font-size:12px;color:#3d4f63;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px">Transcript</div>
          <div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:16px;margin-bottom:24px;max-height:300px;overflow:hidden">
            ${transcriptHtml}
          </div>
          <a href="https://airingdesk.com/dashboard" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:600">View in dashboard →</a>
          <p style="color:#3d4f63;font-size:12px;margin-top:24px;border-top:1px solid #1a2332;padding-top:16px">AiRingDesk · <a href="https://airingdesk.com" style="color:#00d4ff">airingdesk.com</a></p>
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
