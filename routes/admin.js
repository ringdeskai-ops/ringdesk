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

module.exports = function(db, sendBrevoEmail) {

  // ── Get single customer full details
  router.get('/customer/:clientId', adminRequired, (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    delete client.password_hash;
    res.json({ client });
  });

  // ── Update customer details
  router.post('/update-customer', adminRequired, (req, res) => {
    const { client_id, contact_name, contact_surname, work_phone, mobile_phone,
            address_line1, address_line2, city, county, postcode, business_name } = req.body;
    db.prepare('UPDATE clients SET contact_name=?,contact_surname=?,work_phone=?,mobile_phone=?,address_line1=?,address_line2=?,city=?,county=?,postcode=?,business_name=? WHERE id=?')
      .run(contact_name||'', contact_surname||'', work_phone||'', mobile_phone||'',
           address_line1||'', address_line2||'', city||'', county||'', postcode||'', business_name||'', client_id);
    console.log('Customer details updated:', client_id);
    res.json({ success: true });
  });

  router.get('/customers', adminRequired, (req, res) => {
    const customers = db.prepare('SELECT id, business_name, email, phone_number, plan, plan_status, ai_name, ai_prompt, ai_voice, ai_voice_language, departments, calls_this_month, call_limit, email_notifications, stripe_customer_id, stripe_subscription_id, subscription_ends_at, created_at, first_name, last_name, contact_phone, address_line1, address_line2, city, county, postcode, country, region, customer_number, referral_programme_enabled, voicemail_enabled, call_recording, show_demo_banner, feature_email, feature_appointments, feature_crm, feature_voice_selector, feature_ai_settings, sms_missed_call, sms_voicemail, sms_after_call, sms_appointment, sms_from_number, suspended, address_type FROM clients ORDER BY created_at ASC').all();
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
    const allowed = ['email_notifications', 'voicemail_enabled', 'call_recording', 'feature_email', 'feature_appointments', 'feature_crm', 'feature_voice_selector', 'feature_ai_settings'];
    if (!allowed.includes(feature)) return res.status(400).json({ error: 'Invalid feature' });
    db.prepare('UPDATE clients SET ' + feature + ' = ? WHERE id = ?').run(value, client_id);
    res.json({ success: true });
  });

  router.post('/set-status', adminRequired, async (req, res) => {
    const { client_id, plan_status } = req.body;
    if (!['active','cancelled','past_due','trial'].includes(plan_status)) return res.status(400).json({ error: 'Invalid status' });
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    db.prepare('UPDATE clients SET plan_status = ? WHERE id = ?').run(plan_status, client_id);
    console.log('Admin set client ' + client_id + ' status to ' + plan_status);

    function brandedEmail(icon, title, subtitle, bodyHtml, ctaText, ctaUrl, footerNote) {
      return '<div style="font-family:Helvetica Neue,sans-serif;max-width:580px;margin:0 auto;background:#060912;color:#f0f4f8;padding:0;border-radius:16px;overflow:hidden;border:1px solid #1a2332">'
        + '<div style="background:#080e18;padding:28px 32px;border-bottom:1px solid #1a2332">'
        + '<div style="font-size:24px;font-weight:800;margin-bottom:4px"><span style="background:linear-gradient(135deg,#00d4ff,#0099ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Ai</span><span style="color:#f0f4f8">Ring</span><span style="color:#3d5470">Desk</span></div>'
        + '<div style="font-size:11px;color:#5a7a9a;letter-spacing:.06em;margin-top:2px">Your 24/7 AI Call Desk</div>'
        + '</div>'
        + '<div style="background:' + (icon==='❌'?'rgba(255,68,102,.06)':'rgba(0,232,122,.06)') + ';border-bottom:1px solid ' + (icon==='❌'?'rgba(255,68,102,.15)':'rgba(0,232,122,.15)') + ';padding:16px 32px;display:flex;align-items:center;gap:12px">'
        + '<div style="width:40px;height:40px;border-radius:50%;background:' + (icon==='❌'?'rgba(255,68,102,.1)':'rgba(0,232,122,.1)') + ';border:2px solid ' + (icon==='❌'?'rgba(255,68,102,.3)':'rgba(0,232,122,.3)') + ';display:flex;align-items:center;justify-content:center;font-size:18px">' + icon + '</div>'
        + '<div><div style="font-size:17px;font-weight:700;color:#f0f4f8">' + title + '</div><div style="font-size:12px;color:#5a7a9a">' + subtitle + '</div></div>'
        + '</div>'
        + '<div style="padding:28px 32px">'
        + bodyHtml
        + (ctaText ? '<a href="' + ctaUrl + '" style="display:inline-block;background:#00d4ff;color:#020408;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:700;margin-top:8px">' + ctaText + '</a>' : '')
        + '</div>'
        + '<div style="background:#080e18;border-top:1px solid #1a2332;padding:16px 32px;display:flex;justify-content:space-between;align-items:center">'
        + '<div style="font-size:11px;color:#3d4f63">' + (footerNote || 'AiRingDesk · AI Receptionist Platform') + '</div>'
        + '<a href="https://airingdesk.com" style="font-size:11px;color:#5a7a9a;text-decoration:none">airingdesk.com</a>'
        + '</div></div>';
    }

    if (plan_status === 'cancelled' && client) {
      try {
        const cancelBody = '<p style="color:#8896a8;line-height:1.8;margin-bottom:20px">Hi <strong style="color:#f0f4f8">' + client.business_name + '</strong>, your AiRingDesk subscription has been cancelled by our team. If you believe this is an error, please contact us immediately.</p>'
          + '<div style="background:#0d1117;border:1px solid rgba(255,68,102,.2);border-radius:12px;padding:20px;margin-bottom:24px">'
          + '<div style="font-size:11px;color:#ff4466;text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:12px">What happens next</div>'
          + '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px"><div style="color:#ff4466;font-size:16px;margin-top:2px">&#9679;</div><div style="font-size:13px;color:#8896a8;line-height:1.6">Your AI receptionist has stopped answering calls</div></div>'
          + '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px"><div style="color:#ff4466;font-size:16px;margin-top:2px">&#9679;</div><div style="font-size:13px;color:#8896a8;line-height:1.6">Your data will be retained for 30 days then permanently deleted</div></div>'
          + '<div style="display:flex;align-items:flex-start;gap:10px"><div style="color:#00d4ff;font-size:16px;margin-top:2px">&#9679;</div><div style="font-size:13px;color:#8896a8;line-height:1.6">You can reactivate your account at any time</div></div>'
          + '</div>'
          + '<p style="color:#5a7a9a;font-size:12px;line-height:1.7;margin-bottom:24px">Questions? Reply to this email or contact us at <a href="mailto:hello@airingdesk.com" style="color:#00d4ff">hello@airingdesk.com</a></p>';

        const adminCancelBody = '<div style="background:#0d1117;border:1px solid rgba(255,68,102,.2);border-radius:12px;padding:20px;margin-bottom:20px">'
          + '<div style="font-size:11px;color:#ff4466;text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:12px">Cancellation Details</div>'
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
          + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Customer</div><div style="font-size:14px;font-weight:600;color:#f0f4f8">' + client.business_name + '</div></div>'
          + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Email</div><div style="font-size:14px;color:#f0f4f8">' + client.email + '</div></div>'
          + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Cancelled by</div><div style="font-size:14px;font-weight:600;color:#ff4466">' + req.client.email + '</div></div>'
          + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Time</div><div style="font-size:14px;color:#f0f4f8">' + new Date().toLocaleString('en-GB',{timeZone:'Europe/London'}) + '</div></div>'
          + '</div></div>';

        await sendBrevoEmail(client.email, 'Your AiRingDesk subscription has been cancelled',
          brandedEmail('❌', 'Subscription Cancelled', 'Your account has been deactivated', cancelBody, 'Visit airingdesk.com', 'https://airingdesk.com', 'AiRingDesk · hello@airingdesk.com'));
        await sendBrevoEmail(process.env.NOTIFY_EMAIL, '[AiRingDesk] Subscription cancelled: ' + client.business_name,
          brandedEmail('❌', 'Admin Cancellation Alert', 'Subscription cancelled by admin', adminCancelBody, 'View in dashboard', 'https://airingdesk.com/dashboard', 'AiRingDesk Admin Notification'));
        console.log('Cancellation emails sent for:', client.email);
      } catch(e) { console.error('Cancel email error:', e.message); }
    }

    if (plan_status === 'active' && client) {
      try {
        const activateBody = '<p style="color:#8896a8;line-height:1.8;margin-bottom:20px">Hi <strong style="color:#f0f4f8">' + client.business_name + '</strong>, great news! Your AiRingDesk subscription has been activated. Your AI receptionist is now live and ready to answer calls 24/7.</p>'
          + '<div style="background:#0d1117;border:1px solid rgba(0,232,122,.2);border-radius:12px;padding:20px;margin-bottom:24px">'
          + '<div style="font-size:11px;color:#00e87a;text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:12px">Your account is now active</div>'
          + '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px"><div style="color:#00e87a;font-size:16px;margin-top:2px">&#10003;</div><div style="font-size:13px;color:#8896a8;line-height:1.6">AI receptionist is answering all incoming calls</div></div>'
          + '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px"><div style="color:#00e87a;font-size:16px;margin-top:2px">&#10003;</div><div style="font-size:13px;color:#8896a8;line-height:1.6">Call summaries and transcripts sent to your email</div></div>'
          + '<div style="display:flex;align-items:flex-start;gap:10px"><div style="color:#00e87a;font-size:16px;margin-top:2px">&#10003;</div><div style="font-size:13px;color:#8896a8;line-height:1.6">Full dashboard access restored</div></div>'
          + '</div>'
          + '<p style="color:#5a7a9a;font-size:12px;line-height:1.7;margin-bottom:24px">Log in to your dashboard to customise your AI receptionist settings.</p>';

        const adminActivateBody = '<div style="background:#0d1117;border:1px solid rgba(0,232,122,.2);border-radius:12px;padding:20px;margin-bottom:20px">'
          + '<div style="font-size:11px;color:#00e87a;text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:12px">Activation Details</div>'
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
          + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Customer</div><div style="font-size:14px;font-weight:600;color:#f0f4f8">' + client.business_name + '</div></div>'
          + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Email</div><div style="font-size:14px;color:#f0f4f8">' + client.email + '</div></div>'
          + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Activated by</div><div style="font-size:14px;font-weight:600;color:#00e87a">' + req.client.email + '</div></div>'
          + '<div><div style="font-size:10px;color:#5a7a9a;text-transform:uppercase;margin-bottom:4px">Time</div><div style="font-size:14px;color:#f0f4f8">' + new Date().toLocaleString('en-GB',{timeZone:'Europe/London'}) + '</div></div>'
          + '</div></div>';

        await sendBrevoEmail(client.email, '🎉 Your AiRingDesk subscription is now active!',
          brandedEmail('✅', 'Subscription Activated!', 'Your AI receptionist is live', activateBody, 'Go to dashboard', 'https://airingdesk.com/dashboard', 'AiRingDesk · hello@airingdesk.com'));
        await sendBrevoEmail(process.env.NOTIFY_EMAIL, '[AiRingDesk] Subscription activated: ' + client.business_name,
          brandedEmail('✅', 'Admin Activation Alert', 'Subscription activated by admin', adminActivateBody, 'View in dashboard', 'https://airingdesk.com/dashboard', 'AiRingDesk Admin Notification'));
        console.log('Activation emails sent for:', client.email);
      } catch(e) { console.error('Activation email error:', e.message); }
    }
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
    const { business_name, email, password, plan, role } = req.body;
    if (!business_name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const existing = db.prepare('SELECT id FROM clients WHERE email = ?').get(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    const referralCode = 'ARD' + Math.random().toString(36).substr(2,6).toUpperCase();
    const finalRole = role || 'client';
    const planLimits = { trial: 50, starter: 300, professional: 1000, business: 999999 };
    const selectedPlan = plan || 'trial';

    // Auto-generate ARD or ADM number
    let assignedCustomerNumber = null;
    let assignedAdminNumber = null;
    if (finalRole === 'client') {
      const lastCust = db.prepare("SELECT customer_number FROM clients WHERE role='client' AND customer_number IS NOT NULL ORDER BY created_at DESC LIMIT 1").get();
      const nextNum = lastCust ? (parseInt(lastCust.customer_number.replace('ARD-',''))||0)+1 : 1;
      assignedCustomerNumber = 'ARD-' + String(nextNum).padStart(5,'0');
    } else {
      const lastAdmin = db.prepare("SELECT admin_number FROM clients WHERE role IN ('admin','superadmin') AND admin_number IS NOT NULL ORDER BY created_at DESC LIMIT 1").get();
      const nextNum = lastAdmin ? (parseInt(lastAdmin.admin_number.replace('ADM-',''))||0)+1 : 1;
      assignedAdminNumber = 'ADM-' + String(nextNum).padStart(3,'0');
    }

    db.prepare(`INSERT INTO clients (id, business_name, email, password_hash, plan, plan_status, call_limit, calls_this_month, email_notifications, referral_code, role, customer_number, admin_number, admin_active, created_at) VALUES (?, ?, ?, ?, ?, 'trial', ?, 0, 1, ?, ?, ?, ?, 1, strftime('%s','now'))`)
      .run(id, business_name, email, hash, selectedPlan, planLimits[selectedPlan]||50, referralCode, finalRole, assignedCustomerNumber, assignedAdminNumber);

    console.log('Admin created:', finalRole, email, assignedCustomerNumber || assignedAdminNumber);
    res.json({ success: true, id, customerNumber: assignedCustomerNumber, adminNumber: assignedAdminNumber, email });
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

  // ── Get all admin users
  router.get('/admin-users', superAdminRequired, (req, res) => {
    const admins = db.prepare("SELECT id, business_name, email, role, admin_permissions, admin_active FROM clients WHERE role IN ('superadmin','admin') ORDER BY role DESC, business_name ASC").all();
    res.json({ admins });
  });

  // ── Update admin permissions
  router.post('/update-admin-permissions', superAdminRequired, (req, res) => {
    const { admin_id, perm, value } = req.body;
    const admin = db.prepare('SELECT * FROM clients WHERE id = ?').get(admin_id);
    if (!admin) return res.status(404).json({ error: 'Not found' });
    if (admin.role === 'superadmin') return res.status(403).json({ error: 'Cannot restrict superadmin' });
    const perms = admin.admin_permissions ? JSON.parse(admin.admin_permissions) : {};
    perms[perm] = value;
    db.prepare('UPDATE clients SET admin_permissions = ? WHERE id = ?').run(JSON.stringify(perms), admin_id);
    res.json({ success: true });
  });

  // ── Set admin active/inactive
  router.post('/set-admin-active', superAdminRequired, (req, res) => {
    const { admin_id, active } = req.body;
    const admin = db.prepare('SELECT * FROM clients WHERE id = ?').get(admin_id);
    if (!admin) return res.status(404).json({ error: 'Not found' });
    if (admin.role === 'superadmin') return res.status(403).json({ error: 'Cannot deactivate superadmin' });
    db.prepare('UPDATE clients SET admin_active = ? WHERE id = ?').run(active ? 1 : 0, admin_id);
    res.json({ success: true });
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
