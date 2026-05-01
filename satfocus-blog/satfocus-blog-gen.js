#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

const CONFIG = {
  dbPath: path.join(__dirname, 'satfocus-blog.db'),
  outputDir: path.join(__dirname, 'output'),
  sftp: {
    host: 'tajfun-lon.krystal.uk',
    user: 'aismarts',
    keyPath: '/root/.ssh/satfocus_krystal_rsa',
    remotePath: '/home/aismarts/satfocussecurity.co.uk/news',
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: 'claude-sonnet-4-20250514',
  site: {
    name: 'SatFocus Security Solutions',
    url: 'https://www.satfocussecurity.co.uk',
    phone: '0208 422 7918',
    email: 'info@satfocussecurity.co.uk',
    address: '116-118 Windermere Road, London, W5 4TH',
    colors: { red: '#BC0000', charcoal: '#333333' },
    serviceAreas: [
      'Harrow','Wembley','Ealing','Acton','Hanwell','Greenford',
      'Northolt','Ruislip','Pinner','Stanmore','Edgware','Finchley',
      'Hendon','Brent','Hounslow','Uxbridge','Hayes','Southall',
      'Twickenham','Richmond','Chiswick','Hammersmith','Kensington',
      'Paddington','Kilburn','Willesden','Neasden','Kingsbury','Colindale'
    ],
  },
};

if (!CONFIG.anthropicApiKey) {
  try {
    const env = execSync('pm2 env 1 2>/dev/null').toString();
    const match = env.match(/ANTHROPIC_API_KEY:\s*(\S+)/);
    if (match) CONFIG.anthropicApiKey = match[1];
  } catch(e) {}
}
if (!CONFIG.anthropicApiKey) { console.error('No ANTHROPIC_API_KEY found'); process.exit(1); }

const anthropic = new Anthropic({ apiKey: CONFIG.anthropicApiKey });
const db = new Database(CONFIG.dbPath);
db.pragma('journal_mode = WAL');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sf_blog_posts (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      meta_description TEXT, content TEXT NOT NULL, excerpt TEXT,
      keyword TEXT, category TEXT, word_count INTEGER DEFAULT 0,
      schema_json TEXT, status TEXT DEFAULT 'published',
      created_at INTEGER, updated_at INTEGER, published_at INTEGER, uploaded_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sf_blog_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL,
      title_hint TEXT, category TEXT DEFAULT 'General', priority INTEGER DEFAULT 5,
      status TEXT DEFAULT 'pending', used_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS sf_blog_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, details TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
}

function seedTopics() {
  const existing = db.prepare('SELECT COUNT(*) as c FROM sf_blog_topics').get().c;
  if (existing > 0) { console.log('Topics already seeded:', existing); return; }
  const topics = [
    { keyword: 'CCTV installation London', title_hint: 'Professional CCTV Installation in London — Complete Guide', category: 'CCTV', priority: 10 },
    { keyword: 'best CCTV systems for homes UK', title_hint: 'Best CCTV Systems for Homes in the UK — Expert Picks 2026', category: 'CCTV', priority: 9 },
    { keyword: 'commercial CCTV systems London', title_hint: 'Commercial CCTV Systems in London — What Businesses Need to Know', category: 'CCTV', priority: 8 },
    { keyword: 'CCTV maintenance contract London', title_hint: 'CCTV Maintenance Contracts — Why Annual Servicing Saves Money', category: 'CCTV', priority: 7 },
    { keyword: 'IP CCTV vs analogue cameras', title_hint: 'IP CCTV vs Analogue Cameras — Which Is Right for You?', category: 'CCTV', priority: 6 },
    { keyword: 'Hikvision CCTV installer London', title_hint: 'Certified Hikvision CCTV Installer in London', category: 'CCTV', priority: 8 },
    { keyword: 'CCTV for construction sites', title_hint: 'CCTV for Construction Sites — Temporary Security Solutions', category: 'CCTV', priority: 6 },
    { keyword: '4K CCTV camera systems', title_hint: '4K CCTV Camera Systems — Is Ultra HD Worth It?', category: 'CCTV', priority: 5 },
    { keyword: 'intruder alarm installation London', title_hint: 'Intruder Alarm Installation in London — Home and Business', category: 'Intruder Alarms', priority: 10 },
    { keyword: 'burglar alarm systems UK', title_hint: 'Burglar Alarm Systems UK — Complete Buyers Guide 2026', category: 'Intruder Alarms', priority: 9 },
    { keyword: 'Texecom alarm systems', title_hint: 'Texecom Alarm Systems — Why Professionals Choose Texecom', category: 'Intruder Alarms', priority: 8 },
    { keyword: 'wireless intruder alarm systems', title_hint: 'Wireless Intruder Alarms — Are They as Reliable as Wired?', category: 'Intruder Alarms', priority: 7 },
    { keyword: 'alarm monitoring service London', title_hint: 'Alarm Monitoring Service London — 24/7 Property Protection', category: 'Intruder Alarms', priority: 8 },
    { keyword: 'Ajax alarm system UK', title_hint: 'Ajax Alarm System UK — Smart Wireless Security', category: 'Intruder Alarms', priority: 9 },
    { keyword: 'alarm maintenance and servicing', title_hint: 'Alarm Maintenance — How Often Should You Service Your Alarm?', category: 'Intruder Alarms', priority: 6 },
    { keyword: 'NSI approved alarm installer', title_hint: 'NSI Approved Alarm Installer — What It Means and Why It Matters', category: 'Intruder Alarms', priority: 7 },
    { keyword: 'insurance approved alarm systems', title_hint: 'Insurance Approved Alarms — Reducing Your Premium', category: 'Intruder Alarms', priority: 7 },
    { keyword: 'video intercom installation London', title_hint: 'Video Intercom Installation London — Door Entry for Flats', category: 'Video Intercoms', priority: 9 },
    { keyword: 'video door entry system for flats', title_hint: 'Video Door Entry for Flats — Choosing the Right System', category: 'Video Intercoms', priority: 8 },
    { keyword: 'IP video intercom systems', title_hint: 'IP Video Intercom Systems — Smart Door Entry', category: 'Video Intercoms', priority: 7 },
    { keyword: 'Hikvision video intercom', title_hint: 'Hikvision Video Intercom — Feature-Rich and Affordable', category: 'Video Intercoms', priority: 7 },
    { keyword: 'intercom replacement service London', title_hint: 'Intercom Replacement London — Upgrading Old Door Entry', category: 'Video Intercoms', priority: 6 },
    { keyword: 'access control systems London', title_hint: 'Access Control Systems London — Secure Your Building', category: 'Access Control', priority: 9 },
    { keyword: 'keyless entry systems for offices', title_hint: 'Keyless Entry for Offices — Smart Access Solutions', category: 'Access Control', priority: 7 },
    { keyword: 'door access control installation', title_hint: 'Door Access Control Installation — Guide for Property Managers', category: 'Access Control', priority: 7 },
    { keyword: 'biometric access control', title_hint: 'Biometric Access Control — Fingerprint and Facial Recognition', category: 'Access Control', priority: 6 },
    { keyword: 'home security systems London', title_hint: 'Home Security Systems London — Complete Homeowner Guide', category: 'General Security', priority: 10 },
    { keyword: 'commercial security solutions London', title_hint: 'Commercial Security Solutions London — Protecting Your Business', category: 'General Security', priority: 9 },
    { keyword: 'security system cost UK', title_hint: 'Security System Cost UK — What to Expect in 2026', category: 'General Security', priority: 8 },
    { keyword: 'smart home security integration', title_hint: 'Smart Home Security — Connecting Alarm, CCTV, and Access Control', category: 'General Security', priority: 7 },
    { keyword: 'fire alarm installation London', title_hint: 'Fire Alarm Installation London — Compliance and Expert Advice', category: 'General Security', priority: 7 },
    { keyword: 'security for landlords', title_hint: 'Security for Landlords — Protecting Rental Properties', category: 'General Security', priority: 6 },
    { keyword: 'retail security systems', title_hint: 'Retail Security Systems — CCTV, Alarms, and Access for Shops', category: 'General Security', priority: 6 },
    { keyword: 'warehouse security solutions', title_hint: 'Warehouse Security — Industrial CCTV and Intruder Detection', category: 'General Security', priority: 5 },
    { keyword: 'school security systems UK', title_hint: 'School Security Systems UK — Keeping Students Safe', category: 'General Security', priority: 5 },
    { keyword: 'security survey London', title_hint: 'Free Security Survey London — What to Expect', category: 'General Security', priority: 8 },
    { keyword: 'burglary statistics London 2026', title_hint: 'Burglary Statistics London 2026 — What the Numbers Mean', category: 'General Security', priority: 7 },
    { keyword: 'winter home security tips', title_hint: 'Winter Home Security Tips — Protect Your Property', category: 'Seasonal', priority: 5 },
    { keyword: 'holiday home security checklist', title_hint: 'Holiday Security Checklist — Keep Your House Safe', category: 'Seasonal', priority: 5 },
    { keyword: 'BPT intercom system', title_hint: 'BPT Intercom Systems — Italian Door Entry for UK Properties', category: 'Video Intercoms', priority: 6 },
  ];
  const stmt = db.prepare('INSERT INTO sf_blog_topics (keyword, title_hint, category, priority) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => { topics.forEach(t => stmt.run(t.keyword, t.title_hint, t.category, t.priority)); });
  tx();
  console.log('Seeded', topics.length, 'topics');
}

function slugify(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function escapeHtml(t) { return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function log(action, details) { db.prepare('INSERT INTO sf_blog_log (action, details) VALUES (?, ?)').run(action, details); }

async function generatePost(topic) {
  const areas = CONFIG.site.serviceAreas.sort(() => Math.random() - 0.5).slice(0, 5).join(', ');
  const prompt = `You are an expert SEO content writer for SatFocus Security Solutions, a London-based security company specialising in CCTV, intruder alarms, video intercoms, and access control.

Write a comprehensive SEO-optimised blog post:
- Primary keyword: "${topic.keyword}"
- Suggested title: "${topic.title_hint}"
- Category: ${topic.category}

REQUIREMENTS:
1. Title: compelling, includes keyword, under 65 characters
2. Meta description: 150-160 chars, includes keyword, has CTA
3. Word count: 1,200-1,800 words
4. Use H2 and H3 headings naturally
5. Mention these London areas naturally: ${areas}
6. FAQ section at end with 4-5 questions
7. Tone: professional, knowledgeable, UK audience
8. Use British English spelling
9. Reference British Standards, NSI, SSAIB, UK law where relevant
10. End with CTA mentioning free survey and phone ${CONFIG.site.phone}

COMPANY: SatFocus Security Solutions
Phone: ${CONFIG.site.phone} | Email: ${CONFIG.site.email}
Address: ${CONFIG.site.address}
Brands: Texecom, Ajax Systems, Hikvision, Dahua, BPT, Videx, Comelit, Paxton

Respond ONLY in JSON:
{"title":"...","meta_description":"...","content":"... (HTML with h2,h3,p,ul,li tags)","excerpt":"... (2-3 sentences)","word_count":1500,"faq":[{"question":"...","answer":"..."}]}`;

  const response = await anthropic.messages.create({
    model: CONFIG.model, max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content[0].text;
  return JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
}

function buildHTML(post, slug) {
  const pubDate = new Date().toISOString().split('T')[0];
  const pubDateFmt = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  let faqSchema = '';
  if (post.faq && post.faq.length > 0) {
    const items = post.faq.map(f => `{"@type":"Question","name":${JSON.stringify(f.question)},"acceptedAnswer":{"@type":"Answer","text":${JSON.stringify(f.answer)}}}`).join(',');
    faqSchema = `,{"@type":"FAQPage","mainEntity":[${items}]}`;
  }
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(post.title)} | SatFocus Security Solutions</title>
<meta name="description" content="${escapeHtml(post.meta_description)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${CONFIG.site.url}/news/${slug}/">
<meta property="og:title" content="${escapeHtml(post.title)}">
<meta property="og:description" content="${escapeHtml(post.meta_description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${CONFIG.site.url}/news/${slug}/">
<script type="application/ld+json">[{"@context":"https://schema.org","@type":"Article","headline":${JSON.stringify(post.title)},"description":${JSON.stringify(post.meta_description)},"datePublished":"${pubDate}","dateModified":"${pubDate}","author":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${CONFIG.site.url}"},"publisher":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${CONFIG.site.url}","telephone":"${CONFIG.site.phone}","address":{"@type":"PostalAddress","streetAddress":"116-118 Windermere Road","addressLocality":"London","postalCode":"W5 4TH","addressCountry":"GB"}},"mainEntityOfPage":"${CONFIG.site.url}/news/${slug}/"}${faqSchema}]</script>
<style>
:root{--sf-red:#BC0000;--sf-charcoal:#333;--sf-light:#f8f8f8;--sf-border:#e0e0e0}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--sf-charcoal);line-height:1.7;font-size:17px;background:#fff}
.sf-header{background:var(--sf-charcoal);padding:16px 0;border-bottom:3px solid var(--sf-red)}
.sf-header-inner{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.sf-logo{color:#fff;font-size:22px;font-weight:700;text-decoration:none;letter-spacing:.5px}
.sf-logo span{color:var(--sf-red)}
.sf-header-phone{color:#fff;font-size:16px;text-decoration:none}
.sf-header-phone:hover{color:var(--sf-red)}
.sf-nav{background:var(--sf-light);border-bottom:1px solid var(--sf-border);padding:12px 0;font-size:14px}
.sf-nav-inner{max-width:1100px;margin:0 auto;padding:0 24px}
.sf-nav a{color:var(--sf-charcoal);text-decoration:none}
.sf-nav a:hover{color:var(--sf-red)}
.sf-nav span{color:#999;margin:0 8px}
.sf-article{max-width:780px;margin:0 auto;padding:40px 24px 60px}
.sf-article h1{font-size:32px;line-height:1.3;margin-bottom:16px;font-weight:700}
.sf-article-meta{color:#777;font-size:14px;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid var(--sf-border)}
.sf-article h2{font-size:24px;margin:36px 0 16px;font-weight:600}
.sf-article h3{font-size:20px;margin:28px 0 12px;font-weight:600}
.sf-article p{margin-bottom:18px}
.sf-article ul,.sf-article ol{margin:0 0 18px 24px}
.sf-article li{margin-bottom:8px}
.sf-article a{color:var(--sf-red);text-decoration:underline}
.sf-article a:hover{color:#8a0000}
.sf-faq{background:var(--sf-light);border:1px solid var(--sf-border);border-radius:8px;padding:28px;margin:36px 0}
.sf-faq h2{margin-top:0;font-size:22px}
.sf-faq-item{margin-bottom:20px}
.sf-faq-item:last-child{margin-bottom:0}
.sf-faq-item h3{font-size:17px;margin:0 0 8px;color:var(--sf-red)}
.sf-faq-item p{margin:0;font-size:15px}
.sf-cta{background:var(--sf-charcoal);color:#fff;padding:32px;border-radius:8px;margin:40px 0;text-align:center}
.sf-cta h3{color:#fff;font-size:22px;margin:0 0 12px}
.sf-cta p{margin:0 0 20px;opacity:.9}
.sf-cta-btn{display:inline-block;background:var(--sf-red);color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px}
.sf-cta-btn:hover{background:#a00000;color:#fff}
.sf-footer{background:var(--sf-charcoal);color:#ccc;padding:32px 0;font-size:14px;text-align:center;border-top:3px solid var(--sf-red)}
.sf-footer a{color:#fff;text-decoration:none}
.sf-footer a:hover{color:var(--sf-red)}
@media(max-width:600px){.sf-article h1{font-size:26px}.sf-article{padding:24px 16px 40px}}
</style>
</head>
<body>
<header class="sf-header"><div class="sf-header-inner">
<a href="${CONFIG.site.url}" class="sf-logo"><span>SAT</span>FOCUS</a>
<a href="tel:02084227918" class="sf-header-phone">&#128222; ${CONFIG.site.phone}</a>
</div></header>
<nav class="sf-nav"><div class="sf-nav-inner">
<a href="${CONFIG.site.url}">Home</a><span>&#8250;</span>
<a href="${CONFIG.site.url}/news/">News &amp; Guides</a><span>&#8250;</span>
${escapeHtml(post.title)}
</div></nav>
<article class="sf-article">
<h1>${escapeHtml(post.title)}</h1>
<div class="sf-article-meta">Published ${pubDateFmt} by SatFocus Security Solutions</div>
${post.content}
${post.faq && post.faq.length ? '<div class="sf-faq"><h2>Frequently Asked Questions</h2>' + post.faq.map(f => '<div class="sf-faq-item"><h3>' + escapeHtml(f.question) + '</h3><p>' + escapeHtml(f.answer) + '</p></div>').join('') + '</div>' : ''}
<div class="sf-cta"><h3>Protect Your Property Today</h3><p>Get a free, no-obligation security survey from our expert engineers across Harrow, Wembley, Ealing, and West London.</p><a href="tel:02084227918" class="sf-cta-btn">Call ${CONFIG.site.phone}</a></div>
</article>
<footer class="sf-footer">
<p>&copy; ${new Date().getFullYear()} <a href="${CONFIG.site.url}">SatFocus Security Solutions</a> | ${CONFIG.site.address}</p>
<p style="margin-top:8px"><a href="tel:02084227918">${CONFIG.site.phone}</a> | <a href="mailto:${CONFIG.site.email}">${CONFIG.site.email}</a></p>
</footer>
</body></html>`;
}

function buildIndexPage() {
  const posts = db.prepare("SELECT slug,title,excerpt,category,published_at FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
  const cards = posts.map(p => {
    const d = new Date(p.published_at * 1000).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
    return '<a href="'+CONFIG.site.url+'/news/'+p.slug+'/" class="sf-card"><span class="sf-card-cat">'+escapeHtml(p.category||'General')+'</span><h2>'+escapeHtml(p.title)+'</h2><p>'+escapeHtml(p.excerpt||'')+'</p><span class="sf-card-date">'+d+'</span></a>';
  }).join('\n');
  return `<!DOCTYPE html><html lang="en-GB"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Security News & Guides | SatFocus Security Solutions</title>
<meta name="description" content="Expert security guides, CCTV tips, alarm advice from SatFocus Security Solutions London.">
<link rel="canonical" href="${CONFIG.site.url}/news/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Blog","name":"SatFocus Security News","url":"${CONFIG.site.url}/news/","publisher":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${CONFIG.site.url}"}}</script>
<style>
:root{--sf-red:#BC0000;--sf-charcoal:#333;--sf-light:#f8f8f8;--sf-border:#e0e0e0}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--sf-charcoal);line-height:1.6;background:#fff}
.sf-header{background:var(--sf-charcoal);padding:16px 0;border-bottom:3px solid var(--sf-red)}
.sf-header-inner{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.sf-logo{color:#fff;font-size:22px;font-weight:700;text-decoration:none;letter-spacing:.5px}
.sf-logo span{color:var(--sf-red)}
.sf-header-phone{color:#fff;font-size:16px;text-decoration:none}
.sf-header-phone:hover{color:var(--sf-red)}
.sf-page{max-width:1100px;margin:0 auto;padding:40px 24px 60px}
.sf-page h1{font-size:32px;margin-bottom:8px}
.sf-page-sub{color:#777;font-size:16px;margin-bottom:32px}
.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:24px}
.sf-card{display:block;background:var(--sf-light);border:1px solid var(--sf-border);border-radius:8px;padding:24px;text-decoration:none;color:var(--sf-charcoal);transition:border-color .2s,box-shadow .2s}
.sf-card:hover{border-color:var(--sf-red);box-shadow:0 2px 12px rgba(0,0,0,.08)}
.sf-card h2{font-size:18px;margin:8px 0 12px;line-height:1.4}
.sf-card p{font-size:14px;color:#555;margin-bottom:12px}
.sf-card-cat{display:inline-block;background:var(--sf-red);color:#fff;font-size:11px;font-weight:600;padding:3px 10px;border-radius:3px;text-transform:uppercase;letter-spacing:.5px}
.sf-card-date{font-size:13px;color:#999}
.sf-footer{background:var(--sf-charcoal);color:#ccc;padding:32px 0;font-size:14px;text-align:center;border-top:3px solid var(--sf-red)}
.sf-footer a{color:#fff;text-decoration:none}
@media(max-width:600px){.sf-page h1{font-size:26px}.sf-grid{grid-template-columns:1fr}}
</style></head><body>
<header class="sf-header"><div class="sf-header-inner">
<a href="${CONFIG.site.url}" class="sf-logo"><span>SAT</span>FOCUS</a>
<a href="tel:02084227918" class="sf-header-phone">&#128222; ${CONFIG.site.phone}</a>
</div></header>
<div class="sf-page">
<h1>Security News &amp; Guides</h1>
<p class="sf-page-sub">Expert advice on CCTV, intruder alarms, video intercoms, and access control from London's trusted security installer.</p>
<div class="sf-grid">${cards}</div>
${posts.length===0?'<p style="text-align:center;color:#999;padding:60px 0">New articles coming soon!</p>':''}
</div>
<footer class="sf-footer">
<p>&copy; ${new Date().getFullYear()} <a href="${CONFIG.site.url}">SatFocus Security Solutions</a> | ${CONFIG.site.address}</p>
<p style="margin-top:8px"><a href="tel:02084227918">${CONFIG.site.phone}</a> | <a href="mailto:${CONFIG.site.email}">${CONFIG.site.email}</a></p>
</footer></body></html>`;
}

function buildSitemap() {
  const posts = db.prepare("SELECT slug,published_at FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
  const today = new Date().toISOString().split('T')[0];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += '  <url><loc>'+CONFIG.site.url+'/news/</loc><lastmod>'+today+'</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>\n';
  posts.forEach(p => {
    const d = new Date(p.published_at*1000).toISOString().split('T')[0];
    xml += '  <url><loc>'+CONFIG.site.url+'/news/'+p.slug+'/</loc><lastmod>'+d+'</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n';
  });
  xml += '</urlset>';
  return xml;
}

function uploadViaSFTP() {
  const { host, user, keyPath, remotePath } = CONFIG.sftp;
  console.log('\nUploading to Krystal via SFTP...');
  try {
    execSync(`ssh -p 722 -i ${keyPath} -o StrictHostKeyChecking=no ${user}@${host} "mkdir -p ${remotePath}"`, { stdio:'pipe' });
    const posts = db.prepare("SELECT slug FROM sf_blog_posts WHERE status='published'").all();
    for (const p of posts) {
      execSync(`ssh -p 722 -i ${keyPath} -o StrictHostKeyChecking=no ${user}@${host} "mkdir -p ${remotePath}/${p.slug}"`, { stdio:'pipe' });
    }
    const batchFile = path.join(CONFIG.outputDir, 'sftp-batch.txt');
    let batch = `put ${CONFIG.outputDir}/index.html ${remotePath}/index.html\nput ${CONFIG.outputDir}/news-sitemap.xml ${remotePath}/news-sitemap.xml\nput ${CONFIG.outputDir}/.htaccess ${remotePath}/.htaccess\n`;
    const htmlFiles = fs.readdirSync(CONFIG.outputDir).filter(f => f.endsWith('.html') && f !== 'index.html');
    for (const file of htmlFiles) {
      const s = file.replace('.html','');
      batch += `put ${CONFIG.outputDir}/${file} ${remotePath}/${s}/index.html\n`;
    }
    fs.writeFileSync(batchFile, batch);
    execSync(`sftp -P 722 -i ${keyPath} -o StrictHostKeyChecking=no -b ${batchFile} ${user}@${host}`, { stdio:'pipe' });
    const now = Math.floor(Date.now()/1000);
    db.prepare("UPDATE sf_blog_posts SET uploaded_at=? WHERE status='published' AND (uploaded_at IS NULL OR uploaded_at<updated_at)").run(now);
    console.log('All files uploaded successfully');
    log('upload', 'Uploaded ' + htmlFiles.length + ' posts + index + sitemap');
  } catch(e) {
    console.error('SFTP upload failed:', e.message);
    log('upload_error', e.message);
    throw e;
  }
}

async function publishNextPost(force) {
  if (!force) {
    const today = new Date().toISOString().split('T')[0];
    const last = db.prepare("SELECT published_at FROM sf_blog_posts ORDER BY published_at DESC LIMIT 1").get();
    if (last) {
      const lastDate = new Date(last.published_at*1000).toISOString().split('T')[0];
      if (lastDate === today) { console.log('Already published today. Use --force.'); return null; }
    }
  }
  const topic = db.prepare("SELECT * FROM sf_blog_topics WHERE status='pending' ORDER BY priority DESC, id ASC LIMIT 1").get();
  if (!topic) { console.log('No pending topics! Add more.'); return null; }
  console.log('\nGenerating:', topic.keyword, '(' + topic.category + ')');
  try {
    const post = await generatePost(topic);
    const id = uuidv4(), slug = slugify(post.title), now = Math.floor(Date.now()/1000);
    db.prepare("INSERT INTO sf_blog_posts (id,slug,title,meta_description,content,excerpt,keyword,category,word_count,schema_json,status,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id, slug, post.title, post.meta_description, post.content, post.excerpt, topic.keyword, topic.category, post.word_count||1500, '{}', 'published', now, now, now
    );
    db.prepare("UPDATE sf_blog_topics SET status='used', used_at=? WHERE id=?").run(now, topic.id);
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    fs.writeFileSync(path.join(CONFIG.outputDir, slug + '.html'), buildHTML(post, slug), 'utf8');
    fs.writeFileSync(path.join(CONFIG.outputDir, 'index.html'), buildIndexPage(), 'utf8');
    fs.writeFileSync(path.join(CONFIG.outputDir, 'news-sitemap.xml'), buildSitemap(), 'utf8');
    fs.writeFileSync(path.join(CONFIG.outputDir, '.htaccess'), 'RewriteEngine On\nRewriteBase /news/\nRewriteCond %{REQUEST_FILENAME} -d\nRewriteRule ^(.+[^/])$ /news/$1/ [R=301,L]\nRewriteCond %{REQUEST_FILENAME} -f\nRewriteRule ^ - [L]\nRewriteCond %{REQUEST_FILENAME} -d\nRewriteRule ^ - [L]\n', 'utf8');
    console.log('Published:', post.title);
    console.log('Slug: /news/' + slug + '/');
    console.log('Words:', post.word_count, '| FAQ:', (post.faq||[]).length);
    log('publish', post.title);
    return { id, slug, title: post.title };
  } catch(e) {
    console.error('Generation failed:', e.message);
    log('error', topic.keyword + ': ' + e.message);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  initDatabase();
  seedTopics();
  if (args.includes('--list')) {
    const pending = db.prepare("SELECT * FROM sf_blog_topics WHERE status='pending' ORDER BY priority DESC").all();
    const used = db.prepare("SELECT * FROM sf_blog_topics WHERE status='used' ORDER BY used_at DESC").all();
    console.log('\nPending:', pending.length);
    pending.forEach((t,i) => console.log('  '+(i+1)+'. [P'+t.priority+'] '+t.category+': '+t.keyword));
    console.log('\nUsed:', used.length);
    used.forEach((t,i) => console.log('  '+(i+1)+'. '+t.keyword));
    const posts = db.prepare("SELECT title,slug,published_at FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
    console.log('\nPublished:', posts.length);
    posts.forEach((p,i) => console.log('  '+(i+1)+'. '+p.title+' -> /news/'+p.slug+'/'));
    return;
  }
  if (args.includes('--init')) { console.log('Database initialised'); return; }
  const result = await publishNextPost(args.includes('--force'));
  if (result && !args.includes('--preview')) {
    uploadViaSFTP();
    console.log('\nDone! View at:', CONFIG.site.url + '/news/' + result.slug + '/');
  } else if (result) {
    console.log('\nPreview mode - files in', CONFIG.outputDir);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
