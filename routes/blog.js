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
