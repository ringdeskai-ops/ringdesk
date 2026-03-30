const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    req.client = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

module.exports = function(db, sendBrevoEmail) {
  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM system_settings').all();
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    return {
      enabled: s.referral_enabled !== 'false',
      discountPerReferral: parseInt(s.referral_discount_per_referral || '10'),
      maxDiscount: parseInt(s.referral_max_discount || '30'),
      qualifyingDays: parseInt(s.referral_qualifying_days || '30'),
      maxReferrals: parseInt(s.referral_max_referrals || '0'),
      dailyLimit: parseInt(s.referral_daily_limit || '10')
    };
  }

  function updateReferralDiscount(clientId) {
    const { discountPerReferral, maxDiscount, maxReferrals } = getSettings();
    const qualified = db.prepare("SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND qualified = 1").get(clientId);
    const cappedReferrals = maxReferrals > 0 ? Math.min(qualified.c, maxReferrals) : qualified.c;
    const discount = cappedReferrals * discountPerReferral;
    db.prepare('UPDATE clients SET referral_discount = ? WHERE id = ?').run(discount, clientId);
    return discount;
  }

  // Get referral stats
  router.get('/stats', authRequired, (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const settings = getSettings();
    const referrals = db.prepare('SELECT * FROM referrals WHERE referrer_id = ?').all(req.client.id);
    const active = referrals.filter(r => r.status === 'active').length;
    const qualified = referrals.filter(r => r.qualified === 1).length;
    const pending = referrals.filter(r => r.status === 'pending').length;
    const discount = Math.min(qualified * settings.discountPerReferral, settings.maxDiscount);
    const totalSaved = db.prepare('SELECT SUM(discount_amount) as total FROM referral_discounts WHERE client_id = ? AND applied = 1').get(req.client.id);
    res.json({
      referral_code: client.referral_code,
      referral_link: process.env.DASHBOARD_URL + '/signup?ref=' + client.referral_code,
      referral_programme_enabled: client.referral_programme_enabled !== 0 && settings.enabled,
      total_referrals: referrals.length,
      active_referrals: active,
      qualified_referrals: qualified,
      pending_referrals: pending,
      monthly_discount: discount,
      discount_per_referral: settings.discountPerReferral,
      max_referrals: settings.maxReferrals,
      daily_limit: settings.dailyLimit,
      max_discount: settings.maxDiscount,
      qualifying_days: settings.qualifyingDays,
      total_saved: totalSaved ? totalSaved.total || 0 : 0,
      referrals: referrals.map(r => ({
        email: r.referee_email.replace(/(.{2}).*@/, '$1***@'),
        status: r.status,
        qualified: r.qualified === 1,
        sent_at: r.sent_at,
        activated_at: r.activated_at
      }))
    });
  });

  // Send referral email
  router.post('/send', authRequired, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
      const settings = getSettings();
      if (!settings.enabled) return res.status(403).json({ error: 'Referral programme is currently disabled' });
      if (client.referral_programme_enabled === 0) return res.status(403).json({ error: 'Referral programme is disabled for your account' });
      const existing = db.prepare('SELECT id FROM referrals WHERE referrer_id = ? AND referee_email = ?').get(req.client.id, email);
      if (existing) return res.status(400).json({ error: 'Already sent to this email' });
      const today = Math.floor(Date.now()/1000) - 86400;
      const todayCount = db.prepare('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND sent_at > ?').get(req.client.id, today);
      if (todayCount.c >= settings.dailyLimit) return res.status(400).json({ error: 'Daily limit reached (' + settings.dailyLimit + '/day)' });
      const { v4: uuidv4 } = require('uuid');
      db.prepare('INSERT INTO referrals (id, referrer_id, referee_email) VALUES (?, ?, ?)').run(uuidv4(), req.client.id, email);
      const refLink = process.env.DASHBOARD_URL + '/signup?ref=' + client.referral_code;
      const html = '<div style="font-family:Helvetica Neue,sans-serif;max-width:600px;margin:0 auto;background:#060912;color:#f0f4f8;padding:40px;border-radius:16px">'
        + '<div style="font-size:28px;font-weight:800;margin-bottom:4px"><span style="color:#00d4ff">Ai</span><span style="color:#f0f4f8">Ring</span><span style="color:#3d5470">Desk</span></div>'
        + '<div style="font-size:11px;color:#5a7a9a;margin-bottom:32px;border-bottom:1px solid #1a2332;padding-bottom:16px">Your 24/7 AI Call Desk</div>'
        + '<h1 style="font-size:22px;font-weight:700;margin-bottom:12px">' + client.business_name + ' recommends AiRingDesk for your business</h1>'
        + '<p style="color:#8896a8;font-size:15px;line-height:1.7;margin-bottom:24px">' + client.business_name + ' uses AiRingDesk to answer every business call 24/7 with AI and recommended it for your business.</p>'
        + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:24px;margin-bottom:24px">'
        + '<div style="font-size:12px;color:#5a7a9a;margin-bottom:12px;text-transform:uppercase">What AiRingDesk does</div>'
        + '<div style="font-size:14px;line-height:2">✅ Answers every call 24/7 — never miss a customer<br>✅ Takes messages, books appointments, transfers calls<br>✅ AI summaries sent to your email after every call<br>✅ UK phone numbers included<br>✅ Powered by Claude AI (Anthropic)</div></div>'
        + '<div style="background:#0d1117;border:1px solid #1a2332;border-radius:12px;padding:24px;margin-bottom:24px">'
        + '<div style="font-size:12px;color:#5a7a9a;margin-bottom:12px;text-transform:uppercase">Subscription Plans</div>'
        + '<div style="font-size:14px;line-height:2.2"><strong style="color:#00d4ff">Starter</strong> — 300 calls/month — <strong style="color:#00e87a">£49/month</strong><br>'
        + '<strong style="color:#00d4ff">Professional</strong> — 1,000 calls/month — <strong style="color:#00e87a">£149/month</strong><br>'
        + '<strong style="color:#00d4ff">Business</strong> — Unlimited calls — <strong style="color:#00e87a">£349/month</strong></div></div>'
        + '<div style="background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.2);border-radius:12px;padding:16px;margin-bottom:24px;font-size:13px;color:#8896a8">'
        + '🎁 <strong style="color:#00d4ff">14-day free trial</strong> — no payment needed to start. Cancel anytime.</div>'
        + '<a href="' + refLink + '" style="display:block;background:#00d4ff;color:#020408;text-decoration:none;padding:16px;border-radius:10px;font-size:16px;font-weight:700;text-align:center;margin-bottom:24px">Start your free 14-day trial →</a>'
        + '<p style="color:#3d4f63;font-size:11px;line-height:1.6;border-top:1px solid #1a2332;padding-top:16px">'
        + 'You received this one-time email because ' + client.business_name + ' personally recommended AiRingDesk to you. '
        + client.business_name + ' may receive a discount on their monthly subscription if you sign up — this is disclosed in accordance with UK ASA guidelines. '
        + 'This email is sent under legitimate interest provisions of UK GDPR and PECR. '
        + '<a href="' + process.env.DASHBOARD_URL + '/unsubscribe?email=' + email + '" style="color:#5a7a9a">Unsubscribe</a> | '
        + '<a href="https://airingdesk.com/privacy" style="color:#5a7a9a">Privacy Policy</a> | '
        + 'AiRingDesk, registered in England & Wales</p></div>';
      await sendBrevoEmail(email, client.business_name + ' recommends AiRingDesk — AI Receptionist for your business', html);
      res.json({ success: true });
    } catch(e) {
      console.error('Referral send error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Activate referral when new client signs up with referral code
  router.post('/activate', (req, res) => {
    try {
      const { referral_code, new_client_id, new_client_email } = req.body;
      if (!referral_code) return res.json({ success: false });
      const referrer = db.prepare('SELECT * FROM clients WHERE referral_code = ?').get(referral_code);
      if (!referrer) return res.json({ success: false });
      const { v4: uuidv4 } = require('uuid');
      const existing = db.prepare('SELECT * FROM referrals WHERE referrer_id = ? AND referee_email = ?').get(referrer.id, new_client_email);
      if (existing) {
        db.prepare('UPDATE referrals SET status = ?, referee_id = ?, activated_at = ? WHERE id = ?')
          .run('active', new_client_id, Math.floor(Date.now()/1000), existing.id);
      } else {
        db.prepare('INSERT INTO referrals (id, referrer_id, referee_email, referee_id, status, activated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuidv4(), referrer.id, new_client_email, new_client_id, 'active', Math.floor(Date.now()/1000));
      }
      db.prepare('UPDATE clients SET referred_by = ? WHERE id = ?').run(referrer.id, new_client_id);
      updateReferralDiscount(referrer.id);
      res.json({ success: true });
    } catch(e) {
      console.error('Activate referral error:', e.message);
      res.json({ success: false });
    }
  });

  // Admin: get all referrals
  router.get('/admin/all', (req, res) => {
    try {
      const auth = req.headers.authorization;
      if (!auth) return res.status(401).json({ error: 'Unauthorized' });
      const token = auth.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.email !== 'ringdeskai@gmail.com') return res.status(403).json({ error: 'Forbidden' });
      const referrals = db.prepare('SELECT r.*, c.business_name as referrer_name, c.email as referrer_email, c.referral_discount FROM referrals r JOIN clients c ON r.referrer_id = c.id ORDER BY r.sent_at DESC').all();
      const stats = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status="active" THEN 1 ELSE 0 END) as active FROM referrals').get();
      res.json({ referrals, stats });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
