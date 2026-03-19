const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

function superAdminRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
    req.client = decoded;
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

function adminRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!['superadmin','admin'].includes(decoded.role)) return res.status(403).json({ error: 'Forbidden' });
    req.client = decoded;
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

module.exports = function(db) {

  router.get('/customers', adminRequired, (req, res) => {
    const customers = db.prepare('SELECT id, business_name, email, phone_number, plan, plan_status, ai_name, calls_this_month, call_limit, email_notifications, stripe_customer_id, stripe_subscription_id, created_at FROM clients ORDER BY created_at ASC').all();
    customers.forEach((c, i) => c.customer_number = 'RD-' + String(i+1).padStart(3,'0'));
    res.json({ customers });
  });

  router.get('/customer-calls/:clientId', adminRequired, (req, res) => {
    const calls = db.prepare('SELECT * FROM calls WHERE client_id = ? ORDER BY started_at DESC LIMIT 20').all(req.params.clientId);
    calls.forEach(c => { try { c.transcript = JSON.parse(c.transcript || '[]'); } catch { c.transcript = []; } });
    res.json({ calls });
  });

  router.post('/toggle', adminRequired, (req, res) => {
    const { client_id, feature, value } = req.body;
    if (!['email_notifications'].includes(feature)) return res.status(400).json({ error: 'Invalid feature' });
    db.prepare('UPDATE clients SET ' + feature + ' = ? WHERE id = ?').run(value, client_id);
    res.json({ success: true });
  });

  router.post('/set-status', adminRequired, (req, res) => {
    const { client_id, plan_status } = req.body;
    if (!['active','cancelled','past_due','trial'].includes(plan_status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare('UPDATE clients SET plan_status = ? WHERE id = ?').run(plan_status, client_id);
    console.log('Admin set client ' + client_id + ' status to ' + plan_status);
    res.json({ success: true });
  });

  router.post('/set-plan', adminRequired, (req, res) => {
    const { client_id, plan, call_limit } = req.body;
    if (!['trial','starter','professional','business'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    const limits = { trial:50, starter:300, professional:1000, business:99999 };
    const limit = call_limit || limits[plan];
    db.prepare('UPDATE clients SET plan = ?, call_limit = ? WHERE id = ?').run(plan, limit, client_id);
    console.log('Admin changed client ' + client_id + ' plan to ' + plan);
    res.json({ success: true });
  });

  router.get('/invoices/:clientId', adminRequired, async (req, res) => {
    try {
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
      if (!client || !client.stripe_customer_id) return res.json({ invoices: [] });
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const invoices = await stripe.invoices.list({ customer: client.stripe_customer_id, limit: 24 });
      const formatted = invoices.data.map(inv => ({
        id: inv.id,
        date: new Date(inv.created * 1000).toLocaleDateString('en-GB'),
        description: inv.lines && inv.lines.data[0] ? inv.lines.data[0].description : 'Subscription',
        amount: (inv.amount_paid / 100).toFixed(2),
        status: inv.status,
        url: inv.hosted_invoice_url || null
      }));
      res.json({ invoices: formatted });
    } catch(e) {
      console.error('Invoice fetch error:', e.message);
      res.json({ invoices: [] });
    }
  });

  router.get('/revenue', adminRequired, (req, res) => {
    const clients = db.prepare('SELECT plan, plan_status FROM clients').all();
    const planRevenue = { trial:0, starter:49, professional:149, business:349 };
    const mrr = clients.reduce((s,c) => s + (c.plan_status === 'active' ? (planRevenue[c.plan]||0) : 0), 0);
    res.json({
      mrr, arr: mrr * 12,
      total: clients.length,
      paying: clients.filter(c => c.plan !== 'trial' && c.plan_status === 'active').length,
      trial: clients.filter(c => c.plan === 'trial').length,
      cancelled: clients.filter(c => c.plan_status === 'cancelled').length,
      past_due: clients.filter(c => c.plan_status === 'past_due').length
    });
  });


  // ── Create new customer (admin)
  router.post('/create-customer', adminRequired, async (req, res) => {
    const { business_name, email, password, plan } = req.body;
    if (!business_name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const existing = db.prepare('SELECT id FROM clients WHERE email = ?').get(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    const referralCode = 'ARD' + Math.random().toString(36).substr(2,6).toUpperCase();
    const customerNumber = 'RD-' + String(db.prepare('SELECT COUNT(*) as c FROM clients').get().c + 1).padStart(3,'0');
    const planLimits = { trial: 50, starter: 300, professional: 1000, business: 999999 };
    const selectedPlan = plan || 'trial';
    db.prepare(`INSERT INTO clients (id, business_name, email, password, plan, plan_status, call_limit, calls_this_month, email_notifications, referral_code, created_at)
      VALUES (?, ?, ?, ?, ?, 'trial', ?, 0, 1, ?, strftime('%s','now'))`)
      .run(id, business_name, email, hash, selectedPlan, planLimits[selectedPlan] || 50, referralCode);
    console.log('Admin created customer:', email);
    res.json({ success: true, id, customerNumber, email });
  });

  // ── Admin provision number for a customer
  router.post('/provision-number', adminRequired, async (req, res) => {
    const { client_id, phone_number } = req.body;
    if (!client_id || !phone_number) return res.status(400).json({ error: 'client_id and phone_number required' });
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      // Check if number is already in our account - if not, purchase it
      try {
        await twilio.incomingPhoneNumbers.create({
          phoneNumber: phone_number,
          voiceUrl: process.env.DASHBOARD_URL + '/voice/incoming',
          voiceMethod: 'POST',
          statusCallback: process.env.DASHBOARD_URL + '/voice/status',
          statusCallbackMethod: 'POST',
        });
        console.log('Purchased number:', phone_number);
      } catch(e) {
        // Number may already be in account - just update webhook
        const existing = await twilio.incomingPhoneNumbers.list({ phoneNumber: phone_number });
        if (existing.length > 0) {
          await twilio.incomingPhoneNumbers(existing[0].sid).update({
            voiceUrl: process.env.DASHBOARD_URL + '/voice/incoming',
            voiceMethod: 'POST',
            statusCallback: process.env.DASHBOARD_URL + '/voice/status',
            statusCallbackMethod: 'POST',
          });
          console.log('Updated webhook for existing number:', phone_number);
        } else {
          throw e;
        }
      }
      // Set default prompt if none
      if (!client.ai_prompt) {
        const defaultPrompt = 'You are the AI receptionist for ' + client.business_name + '. Answer calls professionally, take messages with caller name and number, and help with general enquiries.';
        db.prepare('UPDATE clients SET ai_prompt = ? WHERE id = ?').run(defaultPrompt, client_id);
      }
      db.prepare('UPDATE clients SET phone_number = ? WHERE id = ?').run(phone_number, client_id);
      res.json({ success: true, phone_number });
    } catch(e) {
      console.error('Admin provision error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Admin update client AI settings
  router.post('/update-ai-settings', adminRequired, (req, res) => {
    const { client_id, ai_name, ai_prompt, departments } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    if (ai_name) db.prepare('UPDATE clients SET ai_name = ? WHERE id = ?').run(ai_name, client_id);
    if (ai_prompt) db.prepare('UPDATE clients SET ai_prompt = ? WHERE id = ?').run(ai_prompt, client_id);
    if (departments) db.prepare('UPDATE clients SET departments = ? WHERE id = ?').run(JSON.stringify(departments), client_id);
    res.json({ success: true });
  });

  // ── Get referrals for a specific customer
  router.get('/customer-referrals/:clientId', adminRequired, (req, res) => {
    const referrals = db.prepare('SELECT * FROM referrals WHERE referrer_id = ?').all(req.params.clientId);
    const total = referrals.length;
    const active = referrals.filter(r => r.status === 'active').length;
    const qualified = referrals.filter(r => r.qualified === 1).length;
    const pending = referrals.filter(r => r.status === 'pending').length;
    res.json({ total, active, qualified, pending, referrals });
  });

  // ── Update client role (superadmin only)
  router.post('/set-role', superAdminRequired, (req, res) => {
    const { client_id, role } = req.body;
    if (!['client','admin','superadmin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    db.prepare('UPDATE clients SET role = ? WHERE id = ?').run(role, client_id);
    console.log('Role updated:', client_id, '->', role);
    res.json({ success: true });
  });

  // ── System settings ──────────────────────────────────────────────
  router.get('/settings', superAdminRequired, (req, res) => {
    const settings = db.prepare('SELECT key, value FROM system_settings').all();
    const obj = {};
    settings.forEach(s => obj[s.key] = s.value);
    res.json({ settings: obj });
  });

  router.post('/settings', superAdminRequired, (req, res) => {
    const { key, value } = req.body;
    const allowed = ['referral_enabled','referral_discount_per_referral','referral_max_discount','referral_qualifying_days','referral_max_referrals','referral_daily_limit'];
    if (!allowed.includes(key)) return res.status(400).json({ error: 'Invalid setting' });
    db.prepare('INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, String(value), Math.floor(Date.now()/1000));
    console.log('Admin updated setting:', key, '=', value);
    res.json({ success: true });
  });

  // ── Toggle referral programme per customer ────────────────────────
  router.post('/toggle-referral', adminRequired, (req, res) => {
    const { client_id, enabled } = req.body;
    db.prepare('UPDATE clients SET referral_programme_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, client_id);
    console.log('Admin toggled referral for client', client_id, ':', enabled);
    res.json({ success: true });
  });

  // ── Extend subscription ───────────────────────────────────────────
  router.post('/extend-subscription', adminRequired, (req, res) => {
    const { client_id, months } = req.body;
    if (![1,2,3,6,8,12].includes(Number(months))) return res.status(400).json({ error: 'Invalid months' });
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    const now = Math.floor(Date.now()/1000);
    const currentEnd = client.subscription_ends_at && client.subscription_ends_at > now
      ? client.subscription_ends_at
      : now;
    const newEnd = currentEnd + (Number(months) * 30 * 24 * 60 * 60);
    db.prepare('UPDATE clients SET subscription_ends_at = ?, plan_status = ? WHERE id = ?').run(newEnd, 'active', client_id);
    console.log('Admin extended subscription for client', client_id, 'by', months, 'months until', new Date(newEnd*1000).toLocaleDateString('en-GB'));
    res.json({ success: true, ends_at: newEnd, ends_date: new Date(newEnd*1000).toLocaleDateString('en-GB') });
  });

  // ── Check and qualify referrals (run daily) ───────────────────────
  router.post('/qualify-referrals', adminRequired, (req, res) => {
    const qualifyingDays = parseInt(db.prepare("SELECT value FROM system_settings WHERE key = 'referral_qualifying_days'").get()?.value || '30');
    const cutoff = Math.floor(Date.now()/1000) - (qualifyingDays * 24 * 60 * 60);
    // Find referrals that have been qualifying for long enough
    const toQualify = db.prepare("SELECT * FROM referrals WHERE status = 'active' AND qualified = 0 AND activated_at < ?").all(cutoff);
    let qualified = 0;
    toQualify.forEach(r => {
      // Check referred client is still paying
      const referee = db.prepare("SELECT * FROM clients WHERE id = ?").get(r.referee_id);
      if (referee && referee.plan_status === 'active' && referee.plan !== 'trial') {
        db.prepare("UPDATE referrals SET qualified = 1 WHERE id = ?").run(r.id);
        qualified++;
        // Recalculate referrer discount
        const discountPerRef = parseInt(db.prepare("SELECT value FROM system_settings WHERE key = 'referral_discount_per_referral'").get()?.value || '10');
        const maxDiscount = parseInt(db.prepare("SELECT value FROM system_settings WHERE key = 'referral_max_discount'").get()?.value || '30');
        const activeQualified = db.prepare("SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND qualified = 1").get(r.referrer_id);
        const discount = Math.min(activeQualified.c * discountPerRef, maxDiscount);
        db.prepare('UPDATE clients SET referral_discount = ? WHERE id = ?').run(discount, r.referrer_id);
        console.log('Referral qualified:', r.id, 'discount for referrer:', discount);
      }
    });
    res.json({ success: true, qualified });
  });

  return router;
};
