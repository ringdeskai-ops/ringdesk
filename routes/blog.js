
// ── Static HTML generator for SEO ────────────────────────────────────────────
function generateStaticHTML(db, post) {
  const publishDate = new Date(post.published_at * 1000).toISOString();
  const publishDateDisplay = new Date(post.published_at * 1000).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'});
  const readTime = Math.ceil((post.word_count || 1500) / 200);
  const postUrl = 'https://airingdesk.com/blog/' + post.slug;
  let schemaScripts = '';
  try {
    const schema = JSON.parse(post.schema_json || '{}');
    if (Array.isArray(schema)) schema.forEach(s => { schemaScripts += '<script type="application/ld+json">'+JSON.stringify(s)+'<\/script>\n'; });
    else schemaScripts = '<script type="application/ld+json">'+JSON.stringify(schema)+'<\/script>';
  } catch(e) {}
  const related = db.prepare("SELECT slug, title, published_at FROM blog_posts WHERE status='published' AND id != ? AND category = ? LIMIT 3").all(post.id, post.category);
  const relatedHtml = related.length > 0 ? '<section class="related-section"><h2>Related Articles</h2><div class="related-grid">'+related.map(r=>'<a href="/blog/'+r.slug+'" class="related-card"><div class="related-card-title">'+r.title+'</div><div class="related-card-date">'+new Date(r.published_at*1000).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+'</div></a>').join('')+'</div></section>' : '';
  const featuredImgHtml = post.featured_image ? '<div class="post-hero-img"><img src="'+post.featured_image+'" alt="'+post.title.replace(/"/g,'&quot;')+'" width="1200" height="630" loading="eager" fetchpriority="high"></div>' : '';
  const tocHtml = (post.content.match(/<h2[^>]*>(.*?)<\/h2>/gi)||[]).map((h,i)=>'<a href="#section-'+i+'" class="toc-item">'+h.replace(/<[^>]*>/g,'')+'</a>').join('');
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${post.title} | AiRingDesk Blog</title>
<meta name="description" content="${(post.meta_description||'').replace(/"/g,'&quot;')}">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1">
<link rel="canonical" href="${postUrl}">
<meta property="og:type" content="article"><meta property="og:title" content="${post.title}">
<meta property="og:description" content="${(post.meta_description||'').replace(/"/g,'&quot;')}">
<meta property="og:url" content="${postUrl}"><meta property="og:site_name" content="AiRingDesk">
<meta property="og:locale" content="en_GB">
${post.featured_image?'<meta property="og:image" content="https://airingdesk.com'+post.featured_image+'">':''}
<meta property="article:published_time" content="${publishDate}">
${schemaScripts}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preload" href="https://fonts.googleapis.com/css2?family=Sora:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link href="https://fonts.googleapis.com/css2?family=Sora:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"></noscript>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}(function(w,d,s){var j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtag/js?id=G-1ZJ2W7DSKP';d.head.appendChild(j);})(window,document,'script');gtag('js',new Date());gtag('config','G-1ZJ2W7DSKP');</script>
<style>*{box-sizing:border-box;margin:0;padding:0}:root{--bg:#060912;--surface:#0d1520;--border:#1a2d45;--cyan:#00d4ff;--text:#f0f4f8;--muted:#8896a8}body{background:var(--bg);color:var(--text);font-family:'DM Sans',system-ui,sans-serif;min-height:100vh;line-height:1.7}.progress-bar{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#00d4ff,#0066cc);z-index:200;width:0%}.blog-nav{background:rgba(6,9,18,.97);backdrop-filter:blur(12px);border-bottom:1px solid rgba(0,212,255,.08);padding:14px 32px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}.blog-nav-brand{font-size:20px;font-weight:800;text-decoration:none}.blog-nav-brand .ai{color:#00d4ff}.blog-nav-brand .ring{color:#f0f4f8}.blog-nav-brand .desk{color:#5a7a9a}.nav-links{display:flex;gap:16px;align-items:center}.nav-link{color:#8896a8;font-size:13px;text-decoration:none}.nav-cta{background:#00d4ff;color:#020408;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none}.post-layout{max-width:1200px;margin:0 auto;padding:48px 24px;display:grid;grid-template-columns:1fr 300px;gap:60px;align-items:start}@media(max-width:900px){.post-layout{grid-template-columns:1fr}.post-sidebar{display:none}}.post-hero-img{width:100%;border-radius:16px;overflow:hidden;margin-bottom:28px;aspect-ratio:1200/630}.post-hero-img img{width:100%;height:100%;object-fit:cover;display:block}.post-breadcrumb{font-size:12px;color:#5a7a9a;margin-bottom:20px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.post-breadcrumb a{color:#00d4ff;text-decoration:none}.post-cat-badge{display:inline-flex;padding:4px 12px;border-radius:20px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);color:#00d4ff;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:16px}.post-title{font-family:'Sora',system-ui,sans-serif;font-size:clamp(28px,4vw,44px);font-weight:800;line-height:1.15;margin-bottom:20px}.post-meta{display:flex;align-items:center;gap:12px;font-size:13px;color:#5a7a9a;margin-bottom:36px;padding-bottom:24px;border-bottom:1px solid #1a2d45;flex-wrap:wrap}.post-body{font-size:17px;line-height:1.85;color:#c8d8e8}.post-body h2{font-family:'Sora',system-ui,sans-serif;font-size:26px;font-weight:700;color:#f0f4f8;margin:44px 0 16px;padding-bottom:12px;border-bottom:1px solid #1a2d45}.post-body h3{font-family:'Sora',system-ui,sans-serif;font-size:20px;font-weight:700;color:#f0f4f8;margin:28px 0 10px}.post-body p{margin-bottom:20px}.post-body ul,.post-body ol{margin:16px 0 20px;padding-left:0;list-style:none}.post-body li{margin-bottom:10px;padding-left:24px;position:relative}.post-body ul li::before{content:'→';position:absolute;left:0;color:#00d4ff;font-size:13px;top:3px}.post-body strong{color:#f0f4f8;font-weight:700}.post-body a{color:#00d4ff;text-decoration:none;border-bottom:1px solid rgba(0,212,255,.3)}.faq-section{margin:40px 0}.faq-section>h2{font-family:'Sora',system-ui,sans-serif;font-size:26px;font-weight:700;color:#f0f4f8;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #1a2d45}.faq-item{background:#0d1520;border:1px solid #1a2d45;border-radius:12px;padding:20px;margin-bottom:12px}.faq-item h3{font-size:16px;font-weight:700;color:#f0f4f8;margin-bottom:8px}.faq-item p{font-size:14px;color:#8896a8;line-height:1.7;margin:0}.post-cta-box{background:linear-gradient(135deg,#0d1a2e,#071828);border:1px solid rgba(0,212,255,.25);border-radius:16px;padding:32px;margin:44px 0;text-align:center}.post-cta-box h3{font-family:'Sora',system-ui,sans-serif;font-size:22px;font-weight:700;margin-bottom:10px}.post-cta-box p{color:#8896a8;margin-bottom:20px;font-size:15px}.post-cta-box a{display:inline-block;background:#00d4ff;color:#020408;padding:13px 28px;border-radius:10px;font-weight:700;text-decoration:none;font-size:15px}.share-bar{display:flex;align-items:center;gap:12px;margin:32px 0;padding:20px;background:#0d1520;border:1px solid #1a2d45;border-radius:12px;flex-wrap:wrap}.share-bar span{font-size:13px;color:#8896a8;font-weight:600}.share-btn{padding:7px 16px;border-radius:8px;border:1px solid #1a2d45;background:transparent;color:#8896a8;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}.share-btn:hover{border-color:#00d4ff;color:#00d4ff}.post-sidebar{position:sticky;top:80px}.sidebar-card{background:#0d1520;border:1px solid #1a2d45;border-radius:14px;padding:20px;margin-bottom:20px}.sidebar-card h4{font-family:'Sora',system-ui,sans-serif;font-size:14px;font-weight:700;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #1a2d45}.toc-item{font-size:13px;color:#8896a8;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.03);line-height:1.4;display:block;text-decoration:none}.toc-item:hover{color:#00d4ff}.sidebar-trial{background:linear-gradient(135deg,rgba(0,212,255,.08),rgba(0,102,204,.08));border:1px solid rgba(0,212,255,.2);border-radius:14px;padding:20px;text-align:center}.sidebar-trial h4{font-size:15px;font-weight:700;margin-bottom:8px}.sidebar-trial p{font-size:12px;color:#8896a8;margin-bottom:14px;line-height:1.6}.sidebar-trial a{display:block;background:#00d4ff;color:#020408;padding:10px;border-radius:8px;font-weight:700;text-decoration:none;font-size:13px}.related-section{margin-top:60px;padding-top:40px;border-top:1px solid #1a2d45}.related-section h2{font-family:'Sora',system-ui,sans-serif;font-size:22px;font-weight:700;margin-bottom:24px}.related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}.related-card{background:#0d1520;border:1px solid #1a2d45;border-radius:12px;padding:16px;text-decoration:none;display:block}.related-card:hover{border-color:rgba(0,212,255,.3)}.related-card-title{font-size:14px;font-weight:700;color:#f0f4f8;line-height:1.4;margin-bottom:8px}.related-card-date{font-size:12px;color:#5a7a9a}.blog-footer{border-top:1px solid #1a2d45;padding:32px 24px;text-align:center;color:#3d5470;font-size:13px;margin-top:60px;max-width:1200px;margin-left:auto;margin-right:auto}.blog-footer a{color:#5a7a9a;text-decoration:none}</style>
</head>
<body>
<div class="progress-bar" id="progressBar"></div>
<nav class="blog-nav"><a href="/" class="blog-nav-brand"><span class="ai">Ai</span><span class="ring">Ring</span><span class="desk">Desk</span><sup style="font-size:9px;vertical-align:super;color:#5a7a9a;margin-left:1px">®</sup></a><div class="nav-links"><a href="/blog" class="nav-link">← Blog</a><a href="/" class="nav-link">Home</a><a href="/#pricing" class="nav-cta">Start free trial</a></div></nav>
<main><div class="post-layout">
<article itemscope itemtype="https://schema.org/BlogPosting">
<meta itemprop="datePublished" content="${publishDate}">
<nav class="post-breadcrumb"><a href="/">Home</a><span>→</span><a href="/blog">Blog</a><span>→</span><span>${post.category}</span></nav>
${featuredImgHtml}
<div class="post-cat-badge">${post.category}</div>
<h1 class="post-title" itemprop="headline">${post.title}</h1>
<div class="post-meta"><span>✍️ AiRingDesk Editorial Team</span><span>·</span><time datetime="${publishDate}">📅 ${publishDateDisplay}</time><span>·</span><span>📖 ${post.word_count||1500} words</span><span>·</span><span>⏱️ ${readTime} min read</span></div>
<div class="post-body" itemprop="articleBody">${post.content}</div>
<div class="share-bar"><span>Share:</span><a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(postUrl)}&text=${encodeURIComponent(post.title)}" target="_blank" rel="noopener" class="share-btn">🐦 Twitter</a><a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(postUrl)}" target="_blank" rel="noopener" class="share-btn">💼 LinkedIn</a><a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(postUrl)}" target="_blank" rel="noopener" class="share-btn">📘 Facebook</a></div>
<div class="post-cta-box"><h3>Never miss a customer call again 📞</h3><p>AiRingDesk answers every call 24/7 with AI. Start your 14-day free trial — no charge until your trial ends. From £29/month.</p><a href="/#pricing">Start your free trial →</a></div>
${relatedHtml}
</article>
<aside class="post-sidebar"><div class="sidebar-card"><h4>📋 Table of Contents</h4>${tocHtml}</div><div class="sidebar-trial"><h4>🤖 Try AiRingDesk Free</h4><p>AI receptionist for UK businesses. Answer every call 24/7. From £29/month.</p><a href="/#pricing">Start 14-day free trial →</a></div></aside>
</div></main>
<footer class="blog-footer"><p>© 2026 <a href="/">AiRingDesk</a> · SatFocus Ltd · VAT: GB 321211372 · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p></footer>
<script>window.addEventListener('scroll',function(){var e=document.getElementById('progressBar');if(!e)return;var t=document.body.scrollHeight-window.innerHeight;if(t>0)e.style.width=(window.scrollY/t*100)+'%';},{passive:true});document.querySelectorAll('.post-body h2').forEach(function(h,i){h.id='section-'+i;});</script>
</body></html>`;
}

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

module.exports = function(db) {

  // Load API key from PM2 env if not set
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const { execSync } = require('child_process');
    const env = execSync('pm2 env 1').toString();
    process.env.ANTHROPIC_API_KEY = env.match(/ANTHROPIC_API_KEY:\s*(\S+)/)?.[1];
  } catch(e) {}
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // ── Helper: generate slug ────────────────────────────────────────────────────
  function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // ── Helper: generate blog post with Claude ───────────────────────────────────
  async function generateBlogPost(keyword, titleHint, category) {
    const currentDate = new Date().toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'});
    const prompt = `You are an expert SEO content writer for AiRingDesk, a UK-based AI phone receptionist service. Write a comprehensive blog post fully optimised for Google 2026, AEO (Answer Engine Optimisation), and GEO (Generative Engine Optimisation).

TARGET KEYWORD: "${keyword}"
TITLE HINT: "${titleHint}"
CATEGORY: ${category}
DATE: ${currentDate}

CRITICAL SEO REQUIREMENTS FOR 2026:

1. DIRECT ANSWER PARAGRAPH (first 100 words):
Start with a concise, direct answer to what the keyword implies. Google AI Overviews and ChatGPT pull from this. Example: "An answering service for dentists is a..."

2. KEY TAKEAWAYS BOX:
After the intro, include a styled HTML box with 4-5 bullet points summarising the article. Use this HTML:
<div style="background:#f0f9ff;border-left:4px solid #0099cc;padding:20px;margin:24px 0;border-radius:0 8px 8px 0">
<strong>Key Takeaways</strong><ul style="margin-top:10px">
<li>Takeaway 1</li><li>Takeaway 2</li><li>Takeaway 3</li><li>Takeaway 4</li>
</ul></div>

3. STRUCTURE (minimum 1,500 words):
- H2: What is [topic]? (direct definition — targets featured snippets)
- H2: Why UK Businesses Need [topic]
- H2: Key Benefits (with H3 subsections)
- H2: How [topic] Works
- H2: How to Choose the Right [topic]
- H2: Real-World Examples
- H2: Frequently Asked Questions (MUST include this section)

4. FAQ SECTION (critical for AEO/GEO):
Include exactly 5 FAQ questions and answers in this HTML format:
<div class="faq-section">
<h2>Frequently Asked Questions</h2>
<div class="faq-item"><h3>Question here?</h3><p>Direct answer here in 2-3 sentences.</p></div>
<div class="faq-item"><h3>Question here?</h3><p>Direct answer here in 2-3 sentences.</p></div>
</div>
Questions should be real "People Also Ask" style questions for the keyword.

5. UK STATISTICS:
Include at least 3 specific UK statistics with context. Examples:
- "According to Ofcom, UK adults make an average of X calls per week"
- "Research shows 62% of callers hang up without leaving voicemail"
- "UK small businesses lose an estimated £X billion annually to missed calls"

6. INTERNAL LINKS:
Naturally mention and link to airingdesk.com with anchor text like:
<a href="https://airingdesk.com">AiRingDesk</a> or 
<a href="https://airingdesk.com/#pricing">start a free trial</a>

7. AUTHOR & TRUST SIGNALS:
End the content (before FAQ) with:
<div style="background:#f8f9fa;border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin:24px 0;display:flex;gap:16px;align-items:flex-start">
<div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#00d4ff,#0066cc);display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:18px;flex-shrink:0">A</div>
<div><strong>Written by the AiRingDesk Team</strong><br><span style="font-size:13px;color:#666">The AiRingDesk team specialises in AI telephony solutions for UK small businesses. With expertise in call handling, AI technology, and business communications, we help UK businesses never miss a customer call.</span></div>
</div>

8. E-E-A-T SIGNALS:
- Write as an expert — use specific numbers, real scenarios, industry terminology
- Include a "Last updated: ${currentDate}" note at the top of content
- Reference real UK regulations, industry bodies where relevant (CQC for dental, RICS for real estate etc.)

9. CONTENT RULES:
- British English throughout
- Mention AiRingDesk naturally 4-5 times as the solution
- Do NOT use markdown — use HTML tags only
- Do NOT start content with the title as H1 or H2
- Every H2 section minimum 150 words
- Use <strong> not **bold**

RESPOND ONLY WITH THIS JSON (no other text, no markdown):
{
  "title": "SEO-optimised title including keyword naturally",
  "meta_description": "150-160 chars including keyword and a benefit",
  "excerpt": "2-3 sentence compelling summary for blog cards",
  "faq_schema": [{"question": "Q1?", "answer": "A1"}, {"question": "Q2?", "answer": "A2"}, {"question": "Q3?", "answer": "A3"}, {"question": "Q4?", "answer": "A4"}, {"question": "Q5?", "answer": "A5"}],
  "content": "Full HTML body content starting with last updated note then direct answer paragraph",
  "word_count": 1500
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  }

  // ── Generate and publish a blog post ─────────────────────────────────────────
  async function publishNextPost() {
    // Get highest priority queued topic
    const topic = db.prepare("SELECT * FROM blog_topics WHERE status = 'queued' ORDER BY priority DESC, id ASC LIMIT 1").get();
    if (!topic) {
      console.log('[Blog] No queued topics available');
      return null;
    }

    console.log('[Blog] Generating post for keyword:', topic.keyword);

    try {
      const post = await generateBlogPost(topic.keyword, topic.title_hint, topic.category);
      const id = uuidv4();
      const slug = slugify(post.title);
      const now = Math.floor(Date.now() / 1000);

      // Build schema JSON with FAQ schema
      const faqSchema = post.faq_schema && post.faq_schema.length > 0 ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": post.faq_schema.map(f => ({
          "@type": "Question",
          "name": f.question,
          "acceptedAnswer": { "@type": "Answer", "text": f.answer }
        }))
      } : null;

      const blogSchema = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": post.title,
        "description": post.meta_description,
        "author": {
          "@type": "Organization",
          "name": "AiRingDesk",
          "url": "https://airingdesk.com"
        },
        "publisher": {
          "@type": "Organization",
          "name": "AiRingDesk",
          "logo": { "@type": "ImageObject", "url": "https://airingdesk.com/logo.svg" }
        },
        "datePublished": new Date(now * 1000).toISOString(),
        "dateModified": new Date(now * 1000).toISOString(),
        "mainEntityOfPage": { "@type": "WebPage", "@id": "https://airingdesk.com/blog/" + slug },
        "keywords": topic.keyword,
        "articleSection": topic.category,
        "inLanguage": "en-GB",
        "about": { "@type": "Thing", "name": topic.keyword }
      };

      const schema = JSON.stringify(faqSchema ? [blogSchema, faqSchema] : blogSchema);

      // Save to DB
      db.prepare(`INSERT INTO blog_posts (id, slug, title, meta_description, content, excerpt, keyword, category, status, word_count, schema_json, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)`).run(
        id, slug, post.title, post.meta_description, post.content, post.excerpt,
        topic.keyword, topic.category, post.word_count || 1200, schema, now, now, now
      );

      // Mark topic as used
      db.prepare("UPDATE blog_topics SET status = 'used', used_at = ? WHERE id = ?").run(now, topic.id);

      // Update schedule last_run
      db.prepare("UPDATE blog_schedule SET last_run = ? WHERE enabled = 1").run(now);

      // Auto-update sitemap
      try {
        const sitemapPath = require('path').join(__dirname, '../public/sitemap.xml');
        let sitemap = require('fs').readFileSync(sitemapPath, 'utf8');
        sitemap = sitemap.replace(/<url>\s*<loc>https:\/\/airingdesk\.com\/blog[^<]*<\/loc>[\s\S]*?<\/url>\s*/g, '');
        const allPosts = db.prepare("SELECT slug, published_at, updated_at FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC").all();
        const today = new Date().toISOString().split('T')[0];
        let blogEntries = `\n  <url><loc>https://airingdesk.com/blog</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`;
        allPosts.forEach(p => {
          const lm = new Date((p.updated_at||p.published_at)*1000).toISOString().split('T')[0];
          blogEntries += `\n  <url><loc>https://airingdesk.com/blog/${p.slug}</loc><lastmod>${lm}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`;
        });
        sitemap = sitemap.replace('</urlset>', blogEntries + '\n</urlset>');
        require('fs').writeFileSync(sitemapPath, sitemap);
        // Ping Google
        require('https').get('https://www.google.com/ping?sitemap=https://airingdesk.com/sitemap.xml');
        console.log('[Blog] ✅ Sitemap updated and Google pinged');
      } catch(sErr) { console.error('[Blog] Sitemap update failed:', sErr.message); }

      // Auto-generate static HTML file for SEO
      try {
        const staticHtml = generateStaticHTML(db, {
          id, slug, title: post.title,
          meta_description: post.meta_description,
          content: post.content,
          excerpt: post.excerpt,
          keyword: topic.keyword,
          category: topic.category,
          word_count: post.word_count || 1500,
          schema_json: schema,
          featured_image: '/blog/assets/' + topic.category.toLowerCase().replace(/ /g,'-') + '.jpg',
          published_at: now,
          updated_at: now
        });
        const staticPath = require('path').join(__dirname, '../public/blog/posts/' + slug + '.html');
        require('fs').writeFileSync(staticPath, staticHtml, 'utf8');
        console.log('[Blog] ✅ Static HTML generated:', slug + '.html');
      } catch(sErr) { console.error('[Blog] Static generation failed:', sErr.message); }

      console.log('[Blog] ✅ Published:', post.title);
      return { id, slug, title: post.title };
    } catch(e) {
      console.error('[Blog] ❌ Generation failed:', e.message);
      return null;
    }
  }

  // ── Cron scheduler — check every 30 minutes ──────────────────────────────────
  function startBlogScheduler() {
    setInterval(async () => {
      const now = new Date();
      const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const today = dayNames[now.getDay()];
      const currentHour = now.getUTCHours();
      const currentMin = now.getUTCMinutes();

      // Check if today is a scheduled day and it's 08:00 UTC
      const schedule = db.prepare("SELECT * FROM blog_schedule WHERE day_of_week = ? AND enabled = 1").get(today);
      if (!schedule) return;

      const [schedHour, schedMin] = schedule.time_utc.split(':').map(Number);
      if (currentHour !== schedHour || currentMin > schedMin + 29) return;

      // Check if already ran today
      if (schedule.last_run) {
        const lastRun = new Date(schedule.last_run * 1000);
        if (lastRun.toDateString() === now.toDateString()) return;
      }

      console.log('[Blog] Scheduler triggered for', today);
      await publishNextPost();
    }, 30 * 60 * 1000); // Check every 30 minutes

    console.log('[Blog] Scheduler started — Mon/Wed/Fri at 08:00 UTC');
  }

  // Start scheduler when module loads
  startBlogScheduler();

  // ── Public routes ─────────────────────────────────────────────────────────────

  // Blog index
  router.get('/', (req, res) => {
    const posts = db.prepare("SELECT id, slug, title, excerpt, keyword, category, published_at, word_count, featured_image FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 20").all();
    const totalPosts = db.prepare("SELECT COUNT(*) as c FROM blog_posts WHERE status = 'published'").get().c;
    res.json({ posts, total: totalPosts });
  });

  // Single post
  router.get('/post/:slug', (req, res) => {
    const post = db.prepare("SELECT * FROM blog_posts WHERE slug = ? AND status = 'published'").get(req.params.slug);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    // Get related posts
    const related = db.prepare("SELECT id, slug, title, excerpt, published_at FROM blog_posts WHERE status = 'published' AND id != ? AND category = ? LIMIT 3").all(post.id, post.category);
    res.json({ post, related });
  });

  // ── Admin routes ──────────────────────────────────────────────────────────────

  function adminAuth(req, res, next) {
    const auth = req.headers.authorization?.split(' ')[1];
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(auth, process.env.JWT_SECRET);
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(decoded.id);
      if (!client || !['admin','superadmin'].includes(client.role)) return res.status(403).json({ error: 'Forbidden' });
      req.client = decoded;
      next();
    } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
  }

  // Get all posts (admin)
  router.get('/admin/posts', adminAuth, (req, res) => {
    const posts = db.prepare("SELECT id, slug, title, keyword, category, status, word_count, published_at, created_at FROM blog_posts ORDER BY created_at DESC").all();
    res.json({ posts });
  });

  // Get topics queue (admin)
  router.get('/admin/topics', adminAuth, (req, res) => {
    const topics = db.prepare("SELECT * FROM blog_topics ORDER BY priority DESC, status ASC, id ASC").all();
    const schedule = db.prepare("SELECT * FROM blog_schedule").all();
    res.json({ topics, schedule });
  });

  // Add topic (admin)
  router.post('/admin/topics', adminAuth, (req, res) => {
    const { keyword, title_hint, category, priority } = req.body;
    if (!keyword) return res.status(400).json({ error: 'Keyword required' });
    db.prepare("INSERT INTO blog_topics (keyword, title_hint, category, priority) VALUES (?, ?, ?, ?)").run(keyword, title_hint||'', category||'AI Receptionist', priority||5);
    res.json({ success: true });
  });

  // Delete topic (admin)
  router.delete('/admin/topics/:id', adminAuth, (req, res) => {
    db.prepare("DELETE FROM blog_topics WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // Manually trigger post generation (admin)
  router.post('/admin/generate', adminAuth, async (req, res) => {
    const result = await publishNextPost();
    if (result) res.json({ success: true, ...result });
    else res.status(500).json({ error: 'Generation failed or no topics available' });
  });

  // Update post status (admin)
  router.put('/admin/posts/:id', adminAuth, (req, res) => {
    const { status, title, content, meta_description } = req.body;
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE blog_posts SET status = ?, title = ?, content = ?, meta_description = ?, updated_at = ? WHERE id = ?")
      .run(status, title, content, meta_description, now, req.params.id);
    res.json({ success: true });
  });

  // Delete post (admin)
  router.delete('/admin/posts/:id', adminAuth, (req, res) => {
    db.prepare("DELETE FROM blog_posts WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // Toggle schedule day (admin)
  router.put('/admin/schedule/:id', adminAuth, (req, res) => {
    const { enabled, time_utc } = req.body;
    db.prepare("UPDATE blog_schedule SET enabled = ?, time_utc = ? WHERE id = ?").run(enabled ? 1 : 0, time_utc || '08:00', req.params.id);
    res.json({ success: true });
  });

  return router;
};
