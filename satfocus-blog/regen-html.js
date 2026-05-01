#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'satfocus-blog.db'));
const outputDir = path.join(__dirname, 'output');
fs.mkdirSync(outputDir, { recursive: true });

const S = {
  url: 'https://www.satfocussecurity.co.uk',
  phone: '0208 422 7918',
  email: 'info@satfocussecurity.co.uk',
  address: '116-118 Windermere Road, London, W5 4TH',
  logo: 'https://www.satfocussecurity.co.uk/wp-content/uploads/2021/05/Satfocus-Logo-1024x350-1.png',
  checkatrade: 'https://www.satfocussecurity.co.uk/wp-content/uploads/2019/12/check-a-trade-uk2.png',
  which: 'https://www.satfocussecurity.co.uk/wp-content/uploads/elementor/thumbs/which-trusted-trader-uk-satfocus-qkv93dl84lig6nmro81hyla1avy3dmazay3nvhcuzs.png',
};

function esc(t){return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

const SHARED_CSS_HEADER = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,sans-serif;color:#333;line-height:1.75;font-size:17px;background:#fff}
a{color:#BC0000;text-decoration:none;transition:color .2s}
a:hover{color:#8a0000}
.sf-topbar{background:#1a1a1a;padding:8px 0;font-size:13px;color:#aaa}
.sf-topbar-inner{max-width:1200px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sf-topbar a{color:#ccc}
.sf-topbar a:hover{color:#BC0000}
.sf-header{background:#fff;padding:12px 0;border-bottom:1px solid #eee;position:sticky;top:0;z-index:100;box-shadow:0 1px 8px rgba(0,0,0,.06)}
.sf-header-inner{max-width:1200px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px}
.sf-logo img{height:52px;width:auto}
.sf-nav{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.sf-nav a{color:#333;font-size:14px;font-weight:500;padding:8px 14px;border-radius:4px;transition:all .2s;text-transform:uppercase;letter-spacing:.3px}
.sf-nav a:hover,.sf-nav a.active{color:#BC0000;background:rgba(188,0,0,.04)}
.sf-header-cta{background:#BC0000;color:#fff!important;padding:10px 22px!important;border-radius:4px!important;font-weight:600!important}
.sf-header-cta:hover{background:#a00000!important;color:#fff!important}
.sf-trust{display:flex;gap:8px;align-items:center}
.sf-trust img{height:40px;width:auto;opacity:.85}
.sf-footer{background:#1a1a1a;color:#999;padding:40px 0 24px;font-size:14px}
.sf-footer-inner{max-width:1200px;margin:0 auto;padding:0 24px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:40px}
.sf-footer h4{color:#fff;font-size:15px;margin-bottom:16px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.sf-footer a{color:#ccc}
.sf-footer a:hover{color:#BC0000}
.sf-footer ul{list-style:none;padding:0;margin:0}
.sf-footer li{margin-bottom:8px}
.sf-footer-bottom{max-width:1200px;margin:24px auto 0;padding:20px 24px 0;border-top:1px solid #333;text-align:center;color:#666;font-size:13px}
@media(max-width:900px){.sf-nav,.sf-trust{display:none}.sf-footer-inner{grid-template-columns:1fr}.sf-topbar-inner{flex-direction:column;text-align:center}}
`;

const SHARED_HEADER_HTML = `<div class="sf-topbar"><div class="sf-topbar-inner">
<span>${S.address}</span>
<span><a href="mailto:${S.email}">${S.email}</a> &nbsp;|&nbsp; <a href="tel:02084227918">${S.phone}</a></span>
</div></div>
<header class="sf-header"><div class="sf-header-inner">
<a href="${S.url}" class="sf-logo"><img src="${S.logo}" alt="SatFocus Security Solutions" loading="lazy"></a>
<nav class="sf-nav">
<a href="${S.url}">Home</a>
<a href="${S.url}/services-home-security-systems-av-and-security-solutions/">Services</a>
<a href="${S.url}/service/cctv-installation-in-london/">CCTV</a>
<a href="${S.url}/service/burglar-alarm-installation-intruder-alarm-installation-in-london/">Alarms</a>
<a href="${S.url}/news/" class="active">News</a>
<a href="${S.url}/contact/" class="sf-header-cta">Contact Us</a>
</nav>
<div class="sf-trust">
<img src="${S.checkatrade}" alt="Checkatrade" loading="lazy">
<img src="${S.which}" alt="Which Trusted Trader" loading="lazy">
</div>
</div></header>`;

const SHARED_FOOTER_HTML = `<footer class="sf-footer">
<div class="sf-footer-inner">
<div><h4>SatFocus Security</h4><p style="line-height:1.7">Professional security systems installation across London. CCTV, intruder alarms, video intercoms, and access control for homes and businesses.</p></div>
<div><h4>Quick Links</h4><ul>
<li><a href="${S.url}">Home</a></li>
<li><a href="${S.url}/services-home-security-systems-av-and-security-solutions/">Our Services</a></li>
<li><a href="${S.url}/news/">News &amp; Guides</a></li>
<li><a href="${S.url}/our-service-locations/">Service Areas</a></li>
<li><a href="${S.url}/contact/">Contact Us</a></li>
</ul></div>
<div><h4>Get In Touch</h4><ul>
<li><a href="tel:02084227918">${S.phone}</a></li>
<li><a href="mailto:${S.email}">${S.email}</a></li>
<li>${S.address}</li>
</ul></div>
</div>
<div class="sf-footer-bottom"><p>&copy; ${new Date().getFullYear()} <a href="${S.url}">SatFocus Security Solutions</a>. All rights reserved.</p></div>
</footer>`;

// ── Build single post HTML ──
function buildPostHTML(post) {
  const pubDate = new Date(post.published_at * 1000).toISOString().split('T')[0];
  const pubFmt = new Date(post.published_at * 1000).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const mins = Math.ceil((post.word_count||1500)/250);
  let faqSchema = '';
  let faqData = [];
  try { faqData = JSON.parse(post.schema_json||'{}').faq ? [] : []; } catch(e){}
  // Extract FAQ from content if present
  const faqMatch = post.content.match(/<div class="sf-faq">([\s\S]*?)<\/div>\s*$/);

  return `<!DOCTYPE html><html lang="en-GB"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(post.title)} | SatFocus Security Solutions</title>
<meta name="description" content="${esc(post.meta_description)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${S.url}/news/${post.slug}/">
<meta property="og:title" content="${esc(post.title)}">
<meta property="og:description" content="${esc(post.meta_description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${S.url}/news/${post.slug}/">
<meta property="og:site_name" content="SatFocus Security Solutions">
<script type="application/ld+json">[{"@context":"https://schema.org","@type":"Article","headline":${JSON.stringify(post.title)},"description":${JSON.stringify(post.meta_description)},"datePublished":"${pubDate}","dateModified":"${pubDate}","author":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${S.url}"},"publisher":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${S.url}","telephone":"${S.phone}"},"mainEntityOfPage":"${S.url}/news/${post.slug}/"}]</script>
<style>${SHARED_CSS_HEADER}
.sf-hero{background:linear-gradient(135deg,#1a1a1a 0%,#2d2d2d 100%);padding:56px 0 48px;border-bottom:4px solid #BC0000}
.sf-hero-inner{max-width:1200px;margin:0 auto;padding:0 24px}
.sf-breadcrumb{font-size:13px;color:#999;margin-bottom:16px}
.sf-breadcrumb a{color:#ccc}
.sf-breadcrumb a:hover{color:#BC0000}
.sf-breadcrumb span{margin:0 8px;color:#666}
.sf-hero h1{color:#fff;font-size:36px;font-weight:700;line-height:1.25;max-width:800px}
.sf-hero-meta{margin-top:16px;display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.sf-hero-cat{background:#BC0000;color:#fff;font-size:11px;font-weight:700;padding:4px 12px;border-radius:3px;text-transform:uppercase;letter-spacing:.8px}
.sf-hero-date{color:#aaa;font-size:14px}
.sf-hero-read{color:#888;font-size:13px}
.sf-wrap{max-width:1200px;margin:0 auto;padding:0 24px;display:grid;grid-template-columns:1fr 300px;gap:48px}
.sf-article{padding:40px 0 60px}
.sf-article h2{font-size:26px;color:#1a1a1a;margin:40px 0 16px;font-weight:700;padding-bottom:8px;border-bottom:2px solid #f0f0f0}
.sf-article h3{font-size:20px;color:#333;margin:32px 0 12px;font-weight:600}
.sf-article p{margin-bottom:18px;color:#444}
.sf-article ul,.sf-article ol{margin:0 0 20px 24px;color:#444}
.sf-article li{margin-bottom:10px}
.sf-article strong{color:#1a1a1a}
.sf-sidebar{padding:40px 0 60px}
.sf-sbox{background:#f8f8f8;border:1px solid #eee;border-radius:10px;padding:28px;margin-bottom:24px}
.sf-sbox h3{font-size:17px;margin-bottom:16px;color:#1a1a1a;font-weight:700}
.sf-sbox p{font-size:14px;color:#555;line-height:1.6;margin-bottom:12px}
.sf-sbtn{display:block;background:#BC0000;color:#fff;text-align:center;padding:12px 20px;border-radius:6px;font-weight:600;font-size:15px;transition:background .2s}
.sf-sbtn:hover{background:#a00000;color:#fff}
.sf-svc{list-style:none;padding:0;margin:0}
.sf-svc li{padding:10px 0;border-bottom:1px solid #eee;font-size:14px}
.sf-svc li:last-child{border-bottom:none}
.sf-svc a{color:#333;display:flex;align-items:center;gap:8px}
.sf-svc a:hover{color:#BC0000}
.sf-svc a::before{content:'\\25B8';color:#BC0000;font-size:12px}
.sf-faq{background:#f9f9f9;border:1px solid #eee;border-radius:10px;padding:32px;margin:40px 0}
.sf-faq h2{margin-top:0;border:none;padding-bottom:0;font-size:22px}
.sf-faq-item{border-bottom:1px solid #e8e8e8;padding:16px 0}
.sf-faq-item:last-child{border-bottom:none;padding-bottom:0}
.sf-faq-item h3{font-size:16px;margin:0 0 8px;color:#1a1a1a;font-weight:600;border:none;padding:0}
.sf-faq-item p{margin:0;font-size:15px;color:#555}
.sf-cta{background:linear-gradient(135deg,#1a1a1a 0%,#2d2d2d 100%);color:#fff;padding:40px;border-radius:10px;margin:48px 0 0;text-align:center;border:1px solid #333}
.sf-cta h3{color:#fff;font-size:24px;margin:0 0 8px;font-weight:700;border:none;padding:0}
.sf-cta p{margin:0 0 24px;opacity:.85;font-size:16px;color:#ccc}
.sf-cta-btn{display:inline-block;background:#BC0000;color:#fff;padding:14px 36px;border-radius:6px;font-weight:700;font-size:16px;box-shadow:0 4px 12px rgba(188,0,0,.3);transition:all .2s}
.sf-cta-btn:hover{background:#d40000;color:#fff;box-shadow:0 6px 20px rgba(188,0,0,.4);transform:translateY(-1px)}
.sf-cta-sub{margin-top:16px;font-size:14px;color:#888}
.sf-cta-sub a{color:#fff;font-weight:600}
@media(max-width:900px){.sf-wrap{grid-template-columns:1fr;gap:0}.sf-sidebar{padding:0 0 40px}.sf-hero h1{font-size:28px}}
</style></head><body>
${SHARED_HEADER_HTML}
<div class="sf-hero"><div class="sf-hero-inner">
<div class="sf-breadcrumb"><a href="${S.url}">Home</a><span>&#8250;</span><a href="${S.url}/news/">News &amp; Guides</a><span>&#8250;</span>${esc(post.title)}</div>
<h1>${esc(post.title)}</h1>
<div class="sf-hero-meta">
<span class="sf-hero-cat">${esc(post.category||'Security')}</span>
<span class="sf-hero-date">${pubFmt}</span>
<span class="sf-hero-read">${mins} min read</span>
</div>
</div></div>
<div class="sf-wrap">
<article class="sf-article">
${post.content}
<div class="sf-cta">
<h3>Protect Your Property Today</h3>
<p>Book a free, no-obligation security survey with our expert engineers.</p>
<a href="tel:02084227918" class="sf-cta-btn">Call ${S.phone}</a>
<p class="sf-cta-sub">or email <a href="mailto:${S.email}">${S.email}</a></p>
</div>
</article>
<aside class="sf-sidebar">
<div class="sf-sbox"><h3>Free Security Survey</h3><p>Our expert engineers will visit your property, assess vulnerabilities, and recommend the best solution — completely free.</p><a href="${S.url}/contact/" class="sf-sbtn">Book Your Free Survey</a></div>
<div class="sf-sbox"><h3>Our Services</h3><ul class="sf-svc">
<li><a href="${S.url}/service/cctv-installation-in-london/">CCTV Installation</a></li>
<li><a href="${S.url}/service/burglar-alarm-installation-intruder-alarm-installation-in-london/">Intruder Alarms</a></li>
<li><a href="${S.url}/gate-intercom-system/">Video Intercoms</a></li>
<li><a href="${S.url}/services-home-security-systems-av-and-security-solutions/">Access Control</a></li>
<li><a href="${S.url}/burglar-alarm-service/">Alarm Servicing</a></li>
</ul></div>
<div class="sf-sbox"><h3>Contact Us</h3><p style="font-size:14px;color:#555"><strong>Phone:</strong> <a href="tel:02084227918">${S.phone}</a><br><strong>Email:</strong> <a href="mailto:${S.email}">${S.email}</a><br><strong>Address:</strong> ${S.address}</p></div>
</aside>
</div>
${SHARED_FOOTER_HTML}
</body></html>`;
}

// ── Build index page ──
function buildIndexHTML() {
  const posts = db.prepare("SELECT slug,title,excerpt,category,published_at,word_count FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
  const categories = [...new Set(posts.map(p=>p.category).filter(Boolean))];
  const catCol = {'CCTV':'#1565C0','Intruder Alarms':'#BC0000','Video Intercoms':'#2E7D32','Access Control':'#6A1B9A','General Security':'#E65100','Local':'#00838F','Seasonal':'#F9A825'};
  const catIcon = {'CCTV':'&#128249;','Intruder Alarms':'&#128276;','Video Intercoms':'&#128266;','Access Control':'&#128273;','General Security':'&#128737;','Local':'&#128205;','Seasonal':'&#128197;'};

  const cards = posts.map(p => {
    const d = new Date(p.published_at*1000).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
    const mins = Math.ceil((p.word_count||1500)/250);
    const cc = catCol[p.category]||'#BC0000';
    const ci = catIcon[p.category]||'&#128737;';
    return `<a href="${S.url}/news/${p.slug}/" class="sf-card">
<div class="sf-card-img" style="background:linear-gradient(135deg,${cc} 0%,${cc}cc 100%)"><span class="sf-card-icon">${ci}</span></div>
<div class="sf-card-body">
<span class="sf-card-cat" style="background:${cc}">${esc(p.category||'Security')}</span>
<h2>${esc(p.title)}</h2>
<p>${esc(p.excerpt||'').substring(0,160)}</p>
<div class="sf-card-footer"><span class="sf-card-date">${d}</span><span class="sf-card-read">${mins} min read</span></div>
</div></a>`;
  }).join('\n');

  return `<!DOCTYPE html><html lang="en-GB"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Security News & Guides | SatFocus Security Solutions</title>
<meta name="description" content="Expert security guides, CCTV tips, alarm system advice, and industry news from SatFocus Security Solutions in London.">
<link rel="canonical" href="${S.url}/news/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Blog","name":"SatFocus Security News","url":"${S.url}/news/","publisher":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${S.url}"}}</script>
<style>${SHARED_CSS_HEADER}
body{background:#f5f5f5}
.sf-hero{background:linear-gradient(135deg,#1a1a1a 0%,#2d2d2d 100%);padding:56px 0 48px;border-bottom:4px solid #BC0000;text-align:center}
.sf-hero h1{color:#fff;font-size:38px;font-weight:700;margin-bottom:12px}
.sf-hero p{color:#bbb;font-size:17px;max-width:600px;margin:0 auto}
.sf-hero-stats{display:flex;justify-content:center;gap:40px;margin-top:24px}
.sf-hero-stat{color:#fff;font-size:13px;text-transform:uppercase;letter-spacing:.5px}
.sf-hero-stat strong{display:block;font-size:28px;color:#BC0000;font-weight:700}
.sf-page{max-width:1200px;margin:0 auto;padding:40px 24px 60px}
.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:28px}
.sf-card{display:flex;flex-direction:column;background:#fff;border-radius:10px;overflow:hidden;color:#333;box-shadow:0 1px 4px rgba(0,0,0,.06);transition:all .3s}
.sf-card:hover{box-shadow:0 8px 30px rgba(0,0,0,.12);transform:translateY(-3px)}
.sf-card-img{height:120px;display:flex;align-items:center;justify-content:center}
.sf-card-icon{font-size:48px;color:rgba(255,255,255,.25)}
.sf-card-body{padding:24px;flex:1;display:flex;flex-direction:column}
.sf-card-cat{display:inline-block;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:3px;text-transform:uppercase;letter-spacing:.8px;align-self:flex-start;margin-bottom:10px}
.sf-card h2{font-size:18px;line-height:1.4;margin-bottom:10px;font-weight:600;color:#1a1a1a}
.sf-card p{font-size:14px;color:#666;flex:1;line-height:1.6;margin-bottom:16px}
.sf-card-footer{display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid #f0f0f0;font-size:12px;color:#999}
.sf-card-read{background:#f5f5f5;padding:2px 8px;border-radius:3px}
@media(max-width:900px){.sf-grid{grid-template-columns:1fr}.sf-hero h1{font-size:28px}.sf-hero-stats{flex-direction:column;gap:16px}}
</style></head><body>
${SHARED_HEADER_HTML}
<div class="sf-hero">
<h1>Security News &amp; Guides</h1>
<p>Expert advice on CCTV, intruder alarms, video intercoms, and access control from London's trusted security installer.</p>
<div class="sf-hero-stats">
<div class="sf-hero-stat"><strong>${posts.length}</strong>Articles</div>
<div class="sf-hero-stat"><strong>${categories.length}</strong>Categories</div>
<div class="sf-hero-stat"><strong>Free</strong>Security Surveys</div>
</div>
</div>
<div class="sf-page">
<div class="sf-grid">${cards}</div>
</div>
${SHARED_FOOTER_HTML}
</body></html>`;
}

// ── Build sitemap ──
function buildSitemap() {
  const posts = db.prepare("SELECT slug,published_at FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
  const today = new Date().toISOString().split('T')[0];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += '  <url><loc>'+S.url+'/news/</loc><lastmod>'+today+'</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>\n';
  posts.forEach(p => {
    const d = new Date(p.published_at*1000).toISOString().split('T')[0];
    xml += '  <url><loc>'+S.url+'/news/'+p.slug+'/</loc><lastmod>'+d+'</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n';
  });
  xml += '</urlset>';
  return xml;
}

// ── Main ──
const posts = db.prepare("SELECT * FROM sf_blog_posts WHERE status='published'").all();
console.log('Regenerating', posts.length, 'posts with new design...\n');

posts.forEach(p => {
  const html = buildPostHTML(p);
  fs.writeFileSync(path.join(outputDir, p.slug + '.html'), html, 'utf8');
  console.log('  ✅', p.title);
});

fs.writeFileSync(path.join(outputDir, 'index.html'), buildIndexHTML(), 'utf8');
console.log('\n  ✅ Index page');

fs.writeFileSync(path.join(outputDir, 'news-sitemap.xml'), buildSitemap(), 'utf8');
console.log('  ✅ Sitemap');

fs.writeFileSync(path.join(outputDir, '.htaccess'), 'RewriteEngine On\nRewriteBase /news/\nRewriteCond %{REQUEST_FILENAME} -d\nRewriteRule ^(.+[^/])$ /news/$1/ [R=301,L]\nRewriteCond %{REQUEST_FILENAME} -f\nRewriteRule ^ - [L]\nRewriteCond %{REQUEST_FILENAME} -d\nRewriteRule ^ - [L]\n', 'utf8');

// Upload
const keyPath = '/root/.ssh/satfocus_krystal_rsa';
const remote = '/home/aismarts/satfocussecurity.co.uk/news';
const host = 'aismarts@tajfun-lon.krystal.uk';
console.log('\nUploading to Krystal...');
try {
  execSync(`ssh -p 722 -i ${keyPath} -o StrictHostKeyChecking=no ${host} "mkdir -p ${remote}"`, {stdio:'pipe'});
  posts.forEach(p => {
    execSync(`ssh -p 722 -i ${keyPath} -o StrictHostKeyChecking=no ${host} "mkdir -p ${remote}/${p.slug}"`, {stdio:'pipe'});
  });
  let batch = `put ${outputDir}/index.html ${remote}/index.html\nput ${outputDir}/news-sitemap.xml ${remote}/news-sitemap.xml\nput ${outputDir}/.htaccess ${remote}/.htaccess\n`;
  posts.forEach(p => { batch += `put ${outputDir}/${p.slug}.html ${remote}/${p.slug}/index.html\n`; });
  fs.writeFileSync(path.join(outputDir, 'sftp-batch.txt'), batch);
  execSync(`sftp -P 722 -i ${keyPath} -o StrictHostKeyChecking=no -b ${outputDir}/sftp-batch.txt ${host}`, {stdio:'pipe'});
  console.log('  ✅ All files uploaded!\n');
  console.log('View: ' + S.url + '/news/');
} catch(e) {
  console.error('Upload failed:', e.message);
}
