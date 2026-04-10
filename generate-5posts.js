process.chdir('/var/www/vhosts/airingdesk.com/httpdocs');
const db = require('better-sqlite3')('./ringdesk.db');
const { execSync } = require('child_process');
const env = execSync('pm2 env 1').toString();
process.env.ANTHROPIC_API_KEY = env.match(/ANTHROPIC_API_KEY:\s*(\S+)/)?.[1];

const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const topics = [
  { keyword: 'answering service for dentists', title_hint: 'AI Answering Service for Dentists — Never Miss a Patient Call Again', category: 'Dental' },
  { keyword: 'dentist answering service', title_hint: 'The Best Dentist Answering Service for UK Dental Practices', category: 'Dental' },
  { keyword: 'dental office answering service', title_hint: 'Dental Office Answering Service — How AI Is Transforming Patient Communication', category: 'Dental' },
  { keyword: 'ai receptionist real estate', title_hint: 'AI Receptionist for Real Estate — Handle Every Property Enquiry 24/7', category: 'Real Estate' },
  { keyword: 'virtual receptionist for small business', title_hint: 'Virtual Receptionist for Small Business — The Complete UK Guide', category: 'Small Business' },
];

async function generatePost(topic) {
  console.log('\n📝 Generating:', topic.keyword);

  const prompt = `You are an expert SEO content writer for AiRingDesk, a UK-based AI phone receptionist service. Write a comprehensive SEO-optimised blog post.

TARGET KEYWORD: "${topic.keyword}"
TITLE: "${topic.title_hint}"
CATEGORY: ${topic.category}

REQUIREMENTS:
- Write in British English, minimum 1,200 words
- Use the keyword naturally in title, intro paragraph, 2-3 subheadings
- Structure: Intro, 5-6 H2 sections with H3 subsections where needed, Conclusion with CTA
- Include UK-specific context, statistics, and examples
- Mention AiRingDesk naturally 3-4 times as the solution
- Use <h2>, <h3>, <p>, <ul>, <li>, <strong> HTML tags only
- Professional but friendly tone for UK business owners
- Do NOT start the content with the title as an H1 or H2

RESPOND ONLY WITH THIS JSON (no other text):
{
  "title": "Full SEO blog post title",
  "meta_description": "150-160 char meta description including keyword",
  "excerpt": "2-3 sentence compelling summary",
  "content": "Full HTML body content starting with a <p> tag",
  "word_count": 1300
}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();
  const post = JSON.parse(clean);

  const id = uuidv4();
  const slug = slugify(post.title);
  const now = Math.floor(Date.now() / 1000);

  // Stagger publish dates — one per day going back
  const publishAt = now - (topics.indexOf(topic) * 86400);

  const schema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": post.title,
    "description": post.meta_description,
    "author": { "@type": "Organization", "name": "AiRingDesk" },
    "publisher": { "@type": "Organization", "name": "AiRingDesk" },
    "datePublished": new Date(publishAt * 1000).toISOString(),
    "mainEntityOfPage": { "@type": "WebPage", "@id": "https://airingdesk.com/blog/" + slug },
    "keywords": topic.keyword
  });

  // Check if slug already exists
  const existing = db.prepare('SELECT id FROM blog_posts WHERE slug = ?').get(slug);
  if (existing) {
    console.log('⚠️  Already exists, skipping:', slug);
    return;
  }

  db.prepare(`INSERT INTO blog_posts (id, slug, title, meta_description, content, excerpt, keyword, category, status, word_count, schema_json, published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)`)
    .run(id, slug, post.title, post.meta_description, post.content, post.excerpt,
      topic.keyword, topic.category, post.word_count || 1300, schema, publishAt, now, now);

  // Mark topic as used in queue if exists
  db.prepare("UPDATE blog_topics SET status = 'used', used_at = ? WHERE keyword = ?").run(now, topic.keyword);

  console.log('✅ Published:', post.title);
  console.log('🔗 https://airingdesk.com/blog/' + slug);
}

async function run() {
  for (const topic of topics) {
    try {
      await generatePost(topic);
      // Small delay between requests
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      console.error('❌ Failed:', topic.keyword, e.message);
    }
  }
  console.log('\n🎉 All 5 posts done!');
}

run();
