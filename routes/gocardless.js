const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { GoCardlessClient, Environments } = require('gocardless-nodejs');

const gc = new GoCardlessClient(
  process.env.GOCARDLESS_ACCESS_TOKEN,
  Environments.Live
);

const CREDITOR_ID = process.env.GOCARDLESS_CREDITOR_ID;

// Plan amounts in pence (ex VAT)
const PLAN_AMOUNTS = {
  essential:    2900,
  starter:      4900,
  professional: 14900,
  business:     34900
};

const PLAN_NAMES = {
  essential:    'AiRingDesk Essential — 150 calls/month',
  starter:      'AiRingDesk Starter — 300 calls/month',
  professional: 'AiRingDesk Professional — 1,000 calls/month',
  business:     'AiRingDesk Business — 5,000 calls/month'
};

function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    req.client = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

module.exports = function(db) {

  // ── Step 1: Create GoCardless customer + redirect flow ──────────────────────
  router.post('/setup', authRequired, async (req, res) => {
    try {
      const { plan } = req.body;
      if (!PLAN_AMOUNTS[plan]) return res.status(400).json({ error: 'Invalid plan' });

      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);

      // Create or get GoCardless customer
      let gcCustomerId = client.gc_customer_id;

      if (!gcCustomerId) {
        const customer = await gc.customers.create({
          email: client.email,
          given_name: client.first_name || client.business_name,
          family_name: client.last_name || 'Ltd',
          company_name: client.business_name,
          phone_number: client.contact_phone || '',
          address_line1: client.address_line1 || '',
          city: client.city || '',
          postal_code: client.postcode || '',
          country_code: 'GB',
          metadata: { client_id: String(client.id), plan }
        });
        gcCustomerId = customer.id;
        db.prepare('UPDATE clients SET gc_customer_id = ? WHERE id = ?').run(gcCustomerId, client.id);
      }

      // Create billing request
      const billingRequest = await gc.billingRequests.create({
        mandate_request: {
          scheme: 'bacs',
          metadata: { client_id: String(client.id), plan }
        },
        links: { customer: gcCustomerId }
      });

      // Create billing request flow
      const flow = await gc.billingRequestFlows.create({
        redirect_uri: `${process.env.DASHBOARD_URL}/billing/gc-success?plan=${plan}`,
        exit_uri: `${process.env.DASHBOARD_URL}/billing`,
        links: { billing_request: billingRequest.id },
        prefilled_customer: {
          email: client.email,
          given_name: client.first_name || client.business_name,
          family_name: client.last_name || '',
          company_name: client.business_name
        }
      });

      // Save billing request ID
      db.prepare('UPDATE clients SET gc_billing_request_id = ?, gc_pending_plan = ? WHERE id = ?')
        .run(billingRequest.id, plan, client.id);

      res.json({ url: flow.authorisation_url });

    } catch(err) {
      console.error('GC setup error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Step 2: After mandate authorised — create subscription ──────────────────
  router.post('/confirm', authRequired, async (req, res) => {
    try {
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
      const plan = client.gc_pending_plan;

      if (!plan || !client.gc_billing_request_id) {
        return res.status(400).json({ error: 'No pending billing request' });
      }

      // Fulfil the billing request to get mandate
      const fulfilled = await gc.billingRequests.fulfil(client.gc_billing_request_id, {});
      const mandateId = fulfilled.links.mandate;

      // Create subscription
      const subscription = await gc.subscriptions.create({
        amount: PLAN_AMOUNTS[plan],
        currency: 'GBP',
        name: PLAN_NAMES[plan],
        interval_unit: 'monthly',
        interval: 1,
        day_of_month: new Date().getDate(),
        metadata: { client_id: String(client.id), plan },
        links: { mandate: mandateId }
      });

      // Save to DB
      db.prepare(`UPDATE clients SET 
        gc_mandate_id = ?,
        gc_subscription_id = ?,
        gc_pending_plan = NULL,
        plan = ?,
        plan_status = 'active',
        call_limit = ?
      WHERE id = ?`).run(
        mandateId,
        subscription.id,
        plan,
        plan === 'essential' ? 150 : plan === 'starter' ? 300 : plan === 'professional' ? 1000 : 5000,
        client.id
      );

      res.json({ success: true, subscription_id: subscription.id });

    } catch(err) {
      console.error('GC confirm error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Cancel subscription ──────────────────────────────────────────────────────
  router.post('/cancel', authRequired, async (req, res) => {
    try {
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
      if (!client.gc_subscription_id) return res.status(400).json({ error: 'No active subscription' });

      await gc.subscriptions.cancel(client.gc_subscription_id, {});

      db.prepare('UPDATE clients SET plan_status = ?, cancel_at_period_end = 1 WHERE id = ?')
        .run('cancelling', client.id);

      res.json({ success: true });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Webhook handler ──────────────────────────────────────────────────────────
  router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['webhook-signature'];
    const secret = process.env.GOCARDLESS_WEBHOOK_SECRET;

    // Verify webhook signature
    const hash = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (hash !== signature) {
      console.error('GC webhook signature mismatch');
      return res.status(401).send('Invalid signature');
    }

    const events = JSON.parse(req.body).events;

    for (const event of events) {
      console.log(`GC webhook: ${event.resource_type} ${event.action}`);

      // Payment paid
      if (event.resource_type === 'payments' && event.action === 'paid_out') {
        const paymentId = event.links.payment;
        const payment = await gc.payments.find(paymentId);
        const subId = payment.links.subscription;
        if (subId) {
          const client = db.prepare('SELECT * FROM clients WHERE gc_subscription_id = ?').get(subId);
          if (client) {
            const amount = payment.amount;
            const now = Math.floor(Date.now() / 1000);
            db.prepare('UPDATE clients SET plan_status = ?, billing_period_start = ?, calls_this_month = 0 WHERE id = ?')
              .run('active', now, client.id);
            console.log(`✅ GC payment confirmed for ${client.email} — £${(amount/100).toFixed(2)}`);
          }
        }
      }

      // Payment failed
      if (event.resource_type === 'payments' && event.action === 'failed') {
        const paymentId = event.links.payment;
        const payment = await gc.payments.find(paymentId);
        const subId = payment.links.subscription;
        if (subId) {
          const client = db.prepare('SELECT * FROM clients WHERE gc_subscription_id = ?').get(subId);
          if (client) {
            db.prepare('UPDATE clients SET plan_status = ? WHERE id = ?').run('past_due', client.id);
            console.error(`❌ GC payment failed for ${client.email}`);
          }
        }
      }

      // Subscription cancelled
      if (event.resource_type === 'subscriptions' && event.action === 'cancelled') {
        const subId = event.links.subscription;
        const client = db.prepare('SELECT * FROM clients WHERE gc_subscription_id = ?').get(subId);
        if (client) {
          db.prepare('UPDATE clients SET plan_status = ?, gc_subscription_id = NULL WHERE id = ?')
            .run('cancelled', client.id);
          console.log(`GC subscription cancelled for ${client.email}`);
        }
      }

      // Mandate cancelled
      if (event.resource_type === 'mandates' && event.action === 'cancelled') {
        const mandateId = event.links.mandate;
        const client = db.prepare('SELECT * FROM clients WHERE gc_mandate_id = ?').get(mandateId);
        if (client) {
          db.prepare('UPDATE clients SET plan_status = ?, gc_mandate_id = NULL WHERE id = ?')
            .run('cancelled', client.id);
          console.log(`GC mandate cancelled for ${client.email}`);
        }
      }
    }

    res.status(200).send('OK');
  });

  return router;
};
