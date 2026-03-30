const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    req.client = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

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

  // Ensure invoices directory exists
  const invoiceDir = path.join(__dirname, '../data/invoices');
  if (!fs.existsSync(invoiceDir)) fs.mkdirSync(invoiceDir, { recursive: true });

  // Create invoices table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      amount INTEGER NOT NULL,
      discount INTEGER DEFAULT 0,
      final_amount INTEGER NOT NULL,
      plan TEXT NOT NULL,
      status TEXT DEFAULT 'paid',
      period_start INTEGER,
      period_end INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      pdf_path TEXT,
      stripe_invoice_id TEXT,
      FOREIGN KEY(client_id) REFERENCES clients(id)
    );
  `);

  // Generate invoice number
  function nextInvoiceNumber() {
    const last = db.prepare("SELECT invoice_number FROM invoices ORDER BY created_at DESC LIMIT 1").get();
    if (!last) return 'ARD-0001';
    const num = parseInt(last.invoice_number.replace('ARD-', '')) + 1;
    return 'ARD-' + String(num).padStart(4, '0');
  }

  // Generate PDF invoice
  function generatePDF(invoice, client) {
    return new Promise((resolve, reject) => {
      const filePath = path.join(invoiceDir, invoice.id + '.pdf');
      const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true, bufferPages: true });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const cyan = '#0099bb';
      const dark = '#ffffff';
      const grey = '#5a7a9a';
      const white = '#111111';
      const green = '#007a3d';

      // Background - white paper
      doc.rect(0, 0, 595, 842).fill('#ffffff');

      // Header bar
      doc.rect(0, 0, 595, 120).fill('#f8f9fa');

      // Logo text
      doc.fontSize(28).font('Helvetica-Bold');
      doc.fillColor('#0099bb').text('Ai', 50, 40, { continued: true });
      doc.fillColor('#111111').text('Ring', { continued: true });
      doc.fillColor('#888888').text('Desk');

      // Tagline
      doc.fontSize(10).font('Helvetica').fillColor('#888888').text('Your 24/7 AI Call Desk', 50, 78);

      // INVOICE label
      doc.fontSize(32).font('Helvetica-Bold').fillColor('#111111').text('INVOICE', 380, 35);

      // Invoice number
      doc.fontSize(12).font('Helvetica').fillColor('#0099bb').text(invoice.invoice_number, 380, 78);

      // Paid badge
      doc.rect(490, 75, 55, 22).fill('#e6f9f0').stroke('#007a3d');
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007a3d').text('PAID', 503, 80);

      // Divider line
      doc.moveTo(50, 128).lineTo(545, 128).strokeColor('#dddddd').lineWidth(1).stroke();

      // Bill To section
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#888888').text('BILL TO', 50, 148);
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#111111').text(client.business_name, 50, 165);
      doc.fontSize(10).font('Helvetica').fillColor('#666666').text(client.email, 50, 183);
      if (client.phone_number) doc.fillColor('#666666').text(client.phone_number, 50, 198);

      // Invoice details section
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#888888').text('INVOICE DETAILS', 350, 148);
      const detailY = 165;
      const details = [
        ['Invoice Number:', invoice.invoice_number],
        ['Date:', new Date(invoice.created_at * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })],
        ['Period:', new Date(invoice.period_start * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' — ' + new Date(invoice.period_end * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })],
        ['Customer ID:', client.id.substring(0, 8).toUpperCase()],
      ];
      details.forEach(([label, value], i) => {
        doc.fontSize(9).font('Helvetica').fillColor('#888888').text(label, 350, detailY + (i * 16));
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#111111').text(value, 445, detailY + (i * 16));
      });

      // Service table header
      const tableY = 260;
      doc.rect(50, tableY, 495, 32).fill('#f0f0f0');
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#666666');
      doc.text('DESCRIPTION', 65, tableY + 11);
      doc.text('PERIOD', 280, tableY + 11);
      doc.text('AMOUNT', 460, tableY + 11);

      // Service row
      const planNames = { trial: 'Trial', starter: 'Starter', professional: 'Professional', business: 'Business' };
      const rowY = tableY + 32;
      doc.rect(50, rowY, 495, 48).fill('#ffffff');
      doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#dddddd').lineWidth(1).stroke();
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#111111').text('AiRingDesk ' + planNames[invoice.plan] + ' Plan', 65, rowY + 10);
      doc.fontSize(10).font('Helvetica').fillColor('#888888').text('AI Receptionist Service', 65, rowY + 27);
      doc.fontSize(10).font('Helvetica').fillColor(grey).text(
        new Date(invoice.period_start * 1000).toLocaleDateString('en-GB') + ' - ' + new Date(invoice.period_end * 1000).toLocaleDateString('en-GB'),
        280, rowY + 18
      );
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#111111').text('£' + (invoice.amount / 100).toFixed(2), 455, rowY + 15);

      // Totals section
      let totY = rowY + 70;
      if (invoice.discount > 0) {
        doc.moveTo(350, totY).lineTo(545, totY).strokeColor('#dddddd').lineWidth(1).stroke();
        doc.fontSize(10).font('Helvetica').fillColor('#888888').text('Subtotal', 350, totY + 8);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111111').text('£' + (invoice.amount / 100).toFixed(2), 480, totY + 8, { align: 'right', width: 65 });
        totY += 28;
        doc.moveTo(350, totY).lineTo(545, totY).strokeColor('#dddddd').lineWidth(1).stroke();
        doc.fontSize(10).font('Helvetica').fillColor('#007a3d').text('Referral Discount', 350, totY + 8);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#007a3d').text('-£' + (invoice.discount / 100).toFixed(2), 480, totY + 8, { align: 'right', width: 65 });
        totY += 28;
      }
      doc.moveTo(350, totY).lineTo(545, totY).strokeColor('#dddddd').lineWidth(1).stroke();
      doc.rect(350, totY, 195, 40).fill('#f0f0f0');
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#666666').text('TOTAL DUE', 365, totY + 12);
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#0099bb').text('£' + (invoice.final_amount / 100).toFixed(2), 430, totY + 8, { align: 'right', width: 105 });

      // Paid watermark - absolute position
      doc.save();
      doc.translate(297, 450);
      doc.rotate(-30);
      doc.fontSize(80).font('Helvetica-Bold').fillColor('#007a3d').opacity(0.06).text('PAID', -120, -40, { lineBreak: false });
      doc.restore();

      // Footer - fixed position, no auto-pagination
      doc.rect(0, 760, 595, 82).fill('#f8f9fa');
      doc.moveTo(0, 760).lineTo(595, 760).strokeColor('#dddddd').lineWidth(1).stroke();
      doc.fontSize(9).font('Helvetica').fillColor('#888888');
      doc.text('AiRingDesk® · Your 24/7 AI Call Desk · airingdesk.com', 50, 772, { lineBreak: false });
      doc.text('hello@airingdesk.com · +44 20 4634 8499', 50, 787, { lineBreak: false });
      doc.text('Registered in England & Wales · UK GDPR Compliant', 50, 802, { lineBreak: false });
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#0099bb').text('Thank you for your business!', 350, 787, { lineBreak: false });

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    });
  }

  // Create invoice record and generate PDF
  async function createInvoice(clientId, amount, discount, plan, periodStart, periodEnd, stripeInvoiceId) {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const invoiceNumber = nextInvoiceNumber();
    const finalAmount = Math.max(0, amount - discount);
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`INSERT INTO invoices (id, client_id, invoice_number, amount, discount, final_amount, plan, status, period_start, period_end, created_at, stripe_invoice_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`)
      .run(id, clientId, invoiceNumber, amount, discount, finalAmount, plan, periodStart || now, periodEnd || (now + 2592000), now, stripeInvoiceId || null);

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    const pdfPath = await generatePDF(invoice, client);

    db.prepare('UPDATE invoices SET pdf_path = ? WHERE id = ?').run(pdfPath, id);
    return { id, invoiceNumber, pdfPath };
  }

  // Download invoice PDF
  router.get('/download/:invoiceId', authRequired, (req, res) => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Check access - client can only download their own
    if (req.client.email !== 'ringdeskai@gmail.com' && invoice.client_id !== req.client.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!invoice.pdf_path || !fs.existsSync(invoice.pdf_path)) {
      return res.status(404).json({ error: 'PDF not generated yet' });
    }
    const client = db.prepare('SELECT business_name FROM clients WHERE id = ?').get(invoice.client_id);
    const filename = 'AiRingDesk-Invoice-' + invoice.invoice_number + '-' + (client?.business_name || '').replace(/[^a-zA-Z0-9]/g, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    fs.createReadStream(invoice.pdf_path).pipe(res);
  });

  // List invoices for current client
  router.get('/my', authRequired, (req, res) => {
    const invoices = db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC').all(req.client.id);
    res.json({ invoices });
  });

  // List invoices for any client (admin)
  router.get('/client/:clientId', superAdminRequired, (req, res) => {
    const invoices = db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC').all(req.params.clientId);
    res.json({ invoices });
  });

  // List all invoices (admin)
  router.get('/all', superAdminRequired, (req, res) => {
    const invoices = db.prepare(`
      SELECT i.*, c.business_name, c.email
      FROM invoices i JOIN clients c ON i.client_id = c.id
      ORDER BY i.created_at DESC LIMIT 100
    `).all();
    res.json({ invoices });
  });

  // Generate invoice manually (admin)
  router.post('/generate', superAdminRequired, async (req, res) => {
    try {
      const { client_id, amount, discount, plan, period_start, period_end } = req.body;
      const result = await createInvoice(client_id, amount * 100, (discount || 0) * 100, plan, period_start, period_end, null);
      res.json({ success: true, ...result });
    } catch(e) {
      console.error('Invoice generation error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Expose createInvoice for use in app.js
  router.createInvoice = createInvoice;

  return router;
};
