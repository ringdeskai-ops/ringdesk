const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

function superAdminRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.email !== 'ringdeskai@gmail.com') return res.status(403).json({ error: 'Forbidden' });
    req.client = decoded;
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

module.exports = function(db) {

  router.get('/customers', superAdminRequired, (req, res) => {
    const customers = db.prepare('SELECT id, business_name, email, phone_number, plan, plan_status, ai_name, calls_this_month, call_limit, email_notifications, stripe_customer_id, stripe_subscription_id, created_at FROM clients ORDER BY created_at ASC').all();
    customers.forEach((c, i) => c.customer_number = 'RD-' + String(i+1).padStart(3,'0'));
    res.json({ customers });
  });

  router.get('/customer-calls/:clientId', superAdminRequired, (req, res) => {
    const calls = db.prepare('SELECT * FROM calls WHERE client_id = ? ORDER BY started_at DESC LIMIT 20').all(req.params.clientId);
    calls.forEach(c => { try { c.transcript = JSON.parse(c.transcript || '[]'); } catch { c.transcript = []; } });
    res.json({ calls });
  });

  router.post('/toggle', superAdminRequired, (req, res) => {
    const { client_id, feature, value } = req.body;
    if (!['email_notifications'].includes(feature)) return res.status(400).json({ error: 'Invalid feature' });
    db.prepare('UPDATE clients SET ' + feature + ' = ? WHERE id = ?').run(value, client_id);
    res.json({ success: true });
  });

  router.post('/set-status', superAdminRequired, (req, res) => {
    const { client_id, plan_status } = req.body;
    if (!['active','cancelled','past_due','trial'].includes(plan_status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare('UPDATE clients SET plan_status = ? WHERE id = ?').run(plan_status, client_id);
    console.log('Admin set client ' + client_id + ' status to ' + plan_status);
    res.json({ success: true });
  });

  router.post('/set-plan', superAdminRequired, (req, res) => {
    const { client_id, plan, call_limit } = req.body;
    if (!['trial','starter','professional','business'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    const limits = { trial:50, starter:300, professional:1000, business:99999 };
    const limit = call_limit || limits[plan];
    db.prepare('UPDATE clients SET plan = ?, call_limit = ? WHERE id = ?').run(plan, limit, client_id);
    console.log('Admin changed client ' + client_id + ' plan to ' + plan);
    res.json({ success: true });
  });

  router.get('/invoices/:clientId', superAdminRequired, async (req, res) => {
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

  router.get('/revenue', superAdminRequired, (req, res) => {
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

  return router;
};
