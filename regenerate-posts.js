process.chdir('/var/www/vhosts/airingdesk.com/httpdocs');
const db = require('better-sqlite3')('./ringdesk.db');
const { execSync } = require('child_process');
const env = execSync('pm2 env 1').toString();
process.env.ANTHROPIC_API_KEY = env.match(/ANTHROPIC_API_KEY:\s*(\S+)/)?.[1];
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const currentDate = new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
const posts = db.prepare("SELECT id, keyword, category, title, published_at, slug FROM blog_posts ORDER BY published_at ASC").all();
console.log('Found', posts.length, 'posts to regenerate\n');

// Safe JSON extractor — handles unterminated strings by truncating
function safeParseJSON(text) {
  const clean = text.replace(/```json|```/g,'').trim();
  try { return JSON.parse(clean); } catch(e) {}
  // Try to fix truncated JSON by finding last complete field
  try {
    // Find the content field and truncate it safely
    const titleMatch = clean.match(/"title"\s*:\s*"([^"]+)"/);
    const metaMatch = clean.match(/"meta_description"\s*:\s*"([^"]+)"/);
    const excerptMatch = clean.match(/"excerpt"\s*:\s*"([^"]+)"/);
    const wordMatch = clean.match(/"word_count"\s*:\s*(\d+)/);
    
    // Extract FAQ array
    const faqMatch = clean.match(/"faq_schema"\s*:\s*(\[[\s\S]*?\])/);
    
    // Extract content — everything between "content": " and the next top-level key
    const contentMatch = clean.match(/"content"\s*:\s*"([\s\S]+?)(?=",\s*"(?:word_count|faq_schema|title|meta)|"\s*})/);
    
    if (titleMatch && contentMatch) {
      return {
        title: titleMatch[1],
        meta_description: metaMatch ? metaMatch[1] : '',
        excerpt: excerptMatch ? excerptMatch[1] : '',
        faq_schema: faqMatch ? JSON.parse(faqMatch[1]) : [],
        content: contentMatch[1].replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\"/g,'"'),
        word_count: wordMatch ? parseInt(wordMatch[1]) : 1500
      };
    }
  } catch(e2) {}
  return null;
}

async function regeneratePost(post) {
  console.log('📝 Regenerating:', post.keyword);

  const prompt = `You are an SEO content writer for AiRingDesk, a UK AI phone receptionist service. Write a 2026 SEO/AEO/GEO optimised blog post.

KEYWORD: "${post.keyword}"
CATEGORY: ${post.category}
DATE: ${currentDate}

CRITICAL: Respond with ONLY a JSON object. No text before or after. Escape ALL quotes inside string values with backslash. No newlines inside JSON string values — use \\n instead.

CONTENT REQUIREMENTS:
- Start: <p style="font-size:12px;color:#999;margin-bottom:20px">Last updated: ${currentDate}</p>
- First 80 words: direct answer to keyword (for Google AI Overviews)
- Key takeaways box: <div style="background:rgba(0,153,204,.08);border-left:4px solid #0099cc;padding:18px;margin:20px 0;border-radius:0 8px 8px 0"><strong style="color:#f0f4f8">Key Takeaways</strong><ul style="margin-top:8px;color:#c8d8e8"><li>Point 1</li><li>Point 2</li><li>Point 3</li></ul></div>
- 5 H2 sections minimum, each 200+ words
- 3 UK statistics with context
- FAQ: <div class="faq-section"><h2>Frequently Asked Questions</h2><div class="faq-item"><h3>Q?</h3><p>Answer.</p></div></div>
- Author bio: <div style="background:rgba(255,255,255,.04);border:1px solid #1a2d45;border-radius:12px;padding:18px;margin:28px 0"><strong style="color:#f0f4f8">AiRingDesk Editorial Team</strong><p style="font-size:13px;color:#8896a8;margin-top:6px">Our team specialises in AI telephony for UK small businesses.</p></div>
- Mention AiRingDesk 4 times, link to https://airingdesk.com and https://airingdesk.com/#pricing
- British English, 1500+ words, HTML only

JSON FORMAT (respond with exactly this structure):
{"title":"title here","meta_description":"150 char description","excerpt":"2 sentence summary","faq_schema":[{"question":"Q1?","answer":"A1"},{"question":"Q2?","answer":"A2"},{"question":"Q3?","answer":"A3"},{"question":"Q4?","answer":"A4"},{"question":"Q5?","answer":"A5"}],"content":"ALL HTML HERE AS ONE LINE with \\n for line breaks","word_count":1500}`;

  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = r.content[0]?.text || '';
  const parsed = safeParseJSON(text);

  if (!parsed) {
    console.log('  ❌ Could not parse JSON — skipping');
    return false;
  }

  const faqSchema = parsed.faq_schema && parsed.faq_schema.length > 0 ? {
    "@context":"https://schema.org","@type":"FAQPage",
    "mainEntity": parsed.faq_schema.map(f=>({
      "@type":"Question","name":f.question,
      "acceptedAnswer":{"@type":"Answer","text":f.answer}
    }))
  } : null;

  const blogSchema = {
    "@context":"https://schema.org","@type":"BlogPosting",
    "headline":parsed.title,"description":parsed.meta_description,
    "author":{"@type":"Organization","name":"AiRingDesk","url":"https://airingdesk.com"},
    "publisher":{"@type":"Organization","name":"AiRingDesk","logo":{"@type":"ImageObject","url":"https://airingdesk.com/logo.svg"}},
    "datePublished":new Date(post.published_at*1000).toISOString(),
    "dateModified":new Date().toISOString(),
    "mainEntityOfPage":{"@type":"WebPage","@id":"https://airingdesk.com/blog/"+post.slug},
    "keywords":post.keyword,"inLanguage":"en-GB","articleSection":post.category
  };

  const schema = JSON.stringify(faqSchema ? [blogSchema,faqSchema] : blogSchema);
  const now = Math.floor(Date.now()/1000);

  db.prepare(`UPDATE blog_posts SET title=?,meta_description=?,content=?,excerpt=?,schema_json=?,word_count=?,updated_at=? WHERE id=?`)
    .run(parsed.title,parsed.meta_description,parsed.content,parsed.excerpt,schema,parsed.word_count||1500,now,post.id);

  console.log('  ✅ Done:', parsed.title);
  console.log('  📊 FAQ:', faqSchema ? faqSchema.mainEntity.length+' questions' : 'none');
  console.log('  📝 Words:', parsed.word_count);
  return true;
}

async function run() {
  let success=0, failed=0;
  for (const post of posts) {
    try {
      const ok = await regeneratePost(post);
      if (ok) success++; else failed++;
      await new Promise(r => setTimeout(r, 3000));
    } catch(e) {
      console.error('  ❌ Error:', e.message);
      failed++;
    }
  }

  // Update sitemap
  try {
    const fs = require('fs');
    let sitemap = fs.readFileSync('./public/sitemap.xml','utf8');
    sitemap = sitemap.replace(/<url>\s*<loc>https:\/\/airingdesk\.com\/blog[^<]*<\/loc>[\s\S]*?<\/url>\s*/g,'');
    const allPosts = db.prepare("SELECT slug FROM blog_posts WHERE status='published'").all();
    const today = new Date().toISOString().split('T')[0];
    let entries = `\n  <url><loc>https://airingdesk.com/blog</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`;
    allPosts.forEach(p=>{entries+=`\n  <url><loc>https://airingdesk.com/blog/${p.slug}</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`;});
    sitemap = sitemap.replace('</urlset>',entries+'\n</urlset>');
    fs.writeFileSync('./public/sitemap.xml',sitemap);
    console.log('\n✅ Sitemap updated');
  } catch(e){console.error('Sitemap failed:',e.message);}

  console.log('\n🎉 Complete! Success:',success,'Failed:',failed);
}

run().catch(console.error);
