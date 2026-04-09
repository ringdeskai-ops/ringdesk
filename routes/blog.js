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
    const prompt = `You are an expert SEO content writer for AiRingDesk, a UK-based AI phone receptionist service for small businesses. Write a comprehensive, SEO-optimised blog post.

TARGET KEYWORD: "${keyword}"
TITLE HINT: "${titleHint}"
CATEGORY: ${category}

REQUIREMENTS:
- Write in British English
- Minimum 1,200 words
- Title: compelling, includes the keyword naturally
- Meta description: 150-160 characters, includes keyword
- Structure: Introduction, 4-6 H2 sections with H3 subsections, Conclusion with CTA
- Include statistics and specific examples
- Mention AiRingDesk naturally 3-4 times as the solution
- CTA at the end pointing to airingdesk.com
- Tone: professional but friendly, written for UK small business owners
- Include practical tips and actionable advice
- Do NOT use markdown bold (**text**) — use HTML <strong> tags instead

RESPOND IN THIS EXACT JSON FORMAT:
{
  "title": "Full blog post title",
  "meta_description": "150-160 char meta description with keyword",
  "excerpt": "2-3 sentence summary of the post",
  "content": "Full HTML content of the post body (just the body content, no <html> or <head> tags). Use <h2>, <h3>, <p>, <ul>, <li>, <strong> tags. Include proper paragraph spacing.",
  "word_count": 1200
}

Respond ONLY with the JSON object, no other text.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
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

      // Build schema JSON
      const schema = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": post.title,
        "description": post.meta_description,
        "author": { "@type": "Organization", "name": "AiRingDesk" },
        "publisher": {
          "@type": "Organization",
          "name": "AiRingDesk",
          "logo": { "@type": "ImageObject", "url": "https://airingdesk.com/logo.svg" }
        },
        "datePublished": new Date(now * 1000).toISOString(),
        "mainEntityOfPage": { "@type": "WebPage", "@id": "https://airingdesk.com/blog/" + slug },
        "keywords": topic.keyword
      });

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
    const posts = db.prepare("SELECT id, slug, title, excerpt, keyword, category, published_at, word_count FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 20").all();
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
