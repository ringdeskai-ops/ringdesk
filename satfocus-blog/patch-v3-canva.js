#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════
 * SatFocus Blog v3 — Canva + Stock Photos + HA Postcode Patch
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * This script patches satfocus-blog-v3.js to add:
 *   1. Canva hero image generation (via Claude API → Canva MCP)
 *   2. Stock photo fetching (Unsplash free API)
 *   3. hero_image_url + stock_photos DB columns
 *   4. --force-ha command to generate all HA postcode posts
 *   5. Updated HTML template with hero + inline images
 * 
 * Run:
 *   cd /var/www/vhosts/airingdesk.com/httpdocs/satfocus-blog
 *   node patch-v3-canva.js
 * 
 * Then test:
 *   node satfocus-blog-v3.js --force      # next pending post
 *   node satfocus-blog-v3.js --force-ha   # ALL HA postcode posts
 * 
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const BLOG_DIR = __dirname;
const SCRIPT_PATH = path.join(BLOG_DIR, 'satfocus-blog-v3.js');
const DB_PATH = path.join(BLOG_DIR, 'satfocus-blog.db');

// ── Step 1: Add DB columns if missing ───────────────────────────────────────
console.log('\n═══ Patching SatFocus Blog v3 ═══\n');

const db = new Database(DB_PATH);

const addCol = (table, col, type) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    console.log(`  ✅ Added ${table}.${col}`);
  } catch(e) {
    if (e.message.includes('duplicate column')) {
      console.log(`  ℹ️  ${table}.${col} already exists`);
    } else throw e;
  }
};

addCol('sf_blog_posts', 'hero_image_url', 'TEXT');
addCol('sf_blog_posts', 'stock_photos', 'TEXT');
addCol('sf_blog_posts', 'canva_design_id', 'TEXT');
addCol('sf_blog_topics', 'postcode', 'TEXT');
addCol('sf_blog_topics', 'area_name', 'TEXT');

db.close();
console.log('  ✅ Database columns ready\n');

// ── Step 2: Read existing script ────────────────────────────────────────────
let script = fs.readFileSync(SCRIPT_PATH, 'utf8');

// ── Step 3: Backup ──────────────────────────────────────────────────────────
const backupPath = SCRIPT_PATH + '.bak-pre-canva';
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(SCRIPT_PATH, backupPath);
  console.log(`  ✅ Backed up to ${path.basename(backupPath)}`);
}

// ── Step 4: Inject Canva hero image function ────────────────────────────────
// We insert the functions BEFORE the generatePost function

const CANVA_FUNCTIONS = `
// ═══════════════════════════════════════════════════════════════════════
// CANVA HERO IMAGE GENERATION
// ═══════════════════════════════════════════════════════════════════════

async function generateHeroImage(title, keyword, category) {
  console.log('  🎨 Generating Canva hero image...');
  try {
    // Use Claude API with Canva MCP to generate a branded hero image
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { console.log('  ⚠️  No API key — skipping hero image'); return null; }

    const designQuery = \`Professional security company blog hero banner image.
Title text: "\${title}"
Style: Dark charcoal background (#333333) with red accent (#BC0000).
Include imagery related to: \${category === 'CCTV' ? 'CCTV cameras, surveillance' : category === 'Intruder Alarms' ? 'alarm panels, security sensors' : category === 'Intercoms' ? 'video intercom, door entry panel' : category === 'Access Control' ? 'access control keypad, card reader' : 'security systems, property protection'}.
Company branding: "SatFocus Security Solutions" small text in bottom-right corner.
Professional, trustworthy, modern look for a security installation company blog.
Facebook cover size (1200x630). Clean and bold.\`;

    // Step 1: Generate design candidates via Canva MCP
    const genResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: \`Generate a Canva design with this specification: \${designQuery}. Use the generate-design tool with design_type "facebook_cover".\` }],
        mcp_servers: [{ type: 'url', url: 'https://mcp.canva.com/mcp', name: 'canva' }]
      })
    });

    const genData = await genResponse.json();
    
    // Extract job_id and candidate_id from MCP tool results
    let jobId = null, candidateId = null, designId = null;
    
    for (const block of (genData.content || [])) {
      if (block.type === 'mcp_tool_result' && block.content) {
        for (const sub of block.content) {
          if (sub.text) {
            try {
              const parsed = JSON.parse(sub.text);
              if (parsed.job?.id) jobId = parsed.job.id;
              if (parsed.job?.result?.generated_designs?.[0]?.candidate_id) {
                candidateId = parsed.job.result.generated_designs[0].candidate_id;
              }
            } catch(e) { /* not JSON, skip */ }
          }
        }
      }
    }

    if (!jobId || !candidateId) {
      console.log('  ⚠️  Canva generation did not return expected data — skipping hero');
      return null;
    }

    // Step 2: Create design from candidate
    const createResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: \`Create an editable design from this Canva candidate. Use the create-design-from-candidate tool with job_id "\${jobId}" and candidate_id "\${candidateId}".\` }],
        mcp_servers: [{ type: 'url', url: 'https://mcp.canva.com/mcp', name: 'canva' }]
      })
    });

    const createData = await createResponse.json();
    
    for (const block of (createData.content || [])) {
      if (block.type === 'mcp_tool_result' && block.content) {
        for (const sub of block.content) {
          if (sub.text) {
            try {
              const parsed = JSON.parse(sub.text);
              if (parsed.design_summary?.id) designId = parsed.design_summary.id;
            } catch(e) {}
          }
        }
      }
    }

    if (!designId) {
      console.log('  ⚠️  Could not create Canva design — skipping hero');
      return null;
    }

    // Step 3: Export as JPG
    const exportResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: \`Export this Canva design as a JPG image. Use the export-design tool with design_id "\${designId}" and format type "jpg" with quality 90, width 1200, height 630.\` }],
        mcp_servers: [{ type: 'url', url: 'https://mcp.canva.com/mcp', name: 'canva' }]
      })
    });

    const exportData = await exportResponse.json();
    let exportUrl = null;

    for (const block of (exportData.content || [])) {
      if (block.type === 'mcp_tool_result' && block.content) {
        for (const sub of block.content) {
          if (sub.text) {
            try {
              const parsed = JSON.parse(sub.text);
              if (parsed.job?.urls?.[0]) exportUrl = parsed.job.urls[0];
            } catch(e) {}
          }
        }
      }
    }

    if (!exportUrl) {
      console.log('  ⚠️  Could not export Canva design — skipping hero');
      return null;
    }

    // Step 4: Download the JPG and save locally + upload to Krystal
    const imgResponse = await fetch(exportUrl);
    const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
    const imgFilename = \`hero-\${slugify(keyword)}.jpg\`;
    const imgPath = path.join(CONFIG.output, 'images', imgFilename);
    
    fs.mkdirSync(path.join(CONFIG.output, 'images'), { recursive: true });
    fs.writeFileSync(imgPath, imgBuffer);

    console.log(\`  ✅ Hero image saved: \${imgFilename} (\${Math.round(imgBuffer.length/1024)}KB)\`);
    
    return {
      localPath: imgPath,
      filename: imgFilename,
      remotePath: \`/news/images/\${imgFilename}\`,
      url: \`https://www.satfocussecurity.co.uk/news/images/\${imgFilename}\`,
      canvaDesignId: designId
    };

  } catch(e) {
    console.log(\`  ⚠️  Hero image error: \${e.message}\`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STOCK PHOTO FETCHING (Unsplash-compatible)
// ═══════════════════════════════════════════════════════════════════════

async function fetchStockPhotos(keyword, category, count = 2) {
  console.log(\`  📸 Fetching \${count} stock photos...\`);
  try {
    // Map category to effective search terms
    const searchMap = {
      'CCTV': 'security camera surveillance',
      'Intruder Alarms': 'home alarm system security',
      'Intercoms': 'video intercom door entry',
      'Access Control': 'access control keypad security',
      'General Security': 'home security system property',
      'Fire Alarms': 'fire alarm detector'
    };
    
    const searchTerm = searchMap[category] || 'security system installation';
    
    // Use Unsplash Source (no API key needed for basic use)
    // These are direct-link photos that are free to use
    const photos = [];
    const searchVariants = [
      searchTerm,
      searchTerm.split(' ').slice(0, 2).join(' ') + ' technology'
    ];

    for (let i = 0; i < count; i++) {
      const query = encodeURIComponent(searchVariants[i % searchVariants.length]);
      const seed = Date.now() + i; // unique per image
      
      // Unsplash Source API — returns a random photo matching the query
      const photoUrl = \`https://source.unsplash.com/800x500/?\${query}&sig=\${seed}\`;
      
      // Download the image
      try {
        const resp = await fetch(photoUrl, { redirect: 'follow' });
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          const filename = \`stock-\${slugify(keyword)}-\${i + 1}.jpg\`;
          const filePath = path.join(CONFIG.output, 'images', filename);
          
          fs.mkdirSync(path.join(CONFIG.output, 'images'), { recursive: true });
          fs.writeFileSync(filePath, buffer);
          
          photos.push({
            localPath: filePath,
            filename: filename,
            remotePath: \`/news/images/\${filename}\`,
            url: \`https://www.satfocussecurity.co.uk/news/images/\${filename}\`,
            alt: \`\${category} installation - \${keyword}\`,
            credit: 'Unsplash'
          });
          
          console.log(\`    ✅ Stock photo \${i + 1}: \${filename} (\${Math.round(buffer.length/1024)}KB)\`);
        }
      } catch(imgErr) {
        console.log(\`    ⚠️  Stock photo \${i + 1} failed: \${imgErr.message}\`);
      }
      
      // Small delay between requests
      await new Promise(r => setTimeout(r, 500));
    }
    
    return photos;
    
  } catch(e) {
    console.log(\`  ⚠️  Stock photos error: \${e.message}\`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════
`;

// Find the right injection point — before generatePost function
const generatePostMatch = script.match(/(?:async\s+)?function\s+generatePost\s*\(/);
if (!generatePostMatch) {
  console.error('❌ Could not find generatePost function in script!');
  process.exit(1);
}

const insertPos = script.indexOf(generatePostMatch[0]);
script = script.slice(0, insertPos) + CANVA_FUNCTIONS + script.slice(insertPos);
console.log('  ✅ Injected Canva + stock photo functions');

// ── Step 5: Patch publishNextPost to call hero + stock photo generators ──────
// After generatePost returns, add hero image + stock photo calls

const POST_SAVE_PATCH_OLD = "db.prepare(\"UPDATE sf_blog_topics SET status='used', used_at=? WHERE id=?";
const POST_SAVE_PATCH_NEW_BEFORE = `
    // Generate hero image + stock photos
    let heroResult = null;
    let stockPhotos = [];
    try {
      heroResult = await generateHeroImage(post.title, topic.keyword, topic.category);
      stockPhotos = await fetchStockPhotos(topic.keyword, topic.category, 2);
    } catch(imgErr) {
      console.log('  ⚠️  Image generation error (non-fatal):', imgErr.message);
    }

    // Update post with image data
    if (heroResult || stockPhotos.length > 0) {
      db.prepare("UPDATE sf_blog_posts SET hero_image_url=?, stock_photos=?, canva_design_id=? WHERE id=?").run(
        heroResult ? heroResult.url : null,
        stockPhotos.length > 0 ? JSON.stringify(stockPhotos.map(p => ({ url: p.url, alt: p.alt, credit: p.credit }))) : null,
        heroResult ? heroResult.canvaDesignId : null,
        id
      );
    }

    `;

// Find and insert image generation before the topic status update
if (script.includes(POST_SAVE_PATCH_OLD)) {
  script = script.replace(POST_SAVE_PATCH_OLD, POST_SAVE_PATCH_NEW_BEFORE + POST_SAVE_PATCH_OLD);
  console.log('  ✅ Patched publishNextPost with image generation');
} else {
  console.log('  ⚠️  Could not find topic status update — manual patch needed for publishNextPost');
}

// ── Step 6: Patch HTML template to include hero image + stock photos ────────
// Find the HTML generation section and update it

const HTML_HERO_INJECT = `
      // Hero image
      const heroUrl = post.hero_image_url || '';
      const heroHtml = heroUrl 
        ? \`<div class="sf-hero-image"><img src="\${heroUrl}" alt="\${post.title}" width="1200" height="630" loading="eager" style="width:100%;height:auto;border-radius:12px;margin-bottom:24px;"></div>\`
        : '';

      // Stock photos — inject into content after 2nd and 4th H2
      let contentWithPhotos = post.content || '';
      try {
        const photos = post.stock_photos ? JSON.parse(post.stock_photos) : [];
        if (photos.length > 0) {
          const h2Matches = [...contentWithPhotos.matchAll(/<\\/h2>/gi)];
          // Insert after 2nd H2
          if (h2Matches.length >= 2 && photos[0]) {
            const insertAt = h2Matches[1].index + h2Matches[1][0].length;
            const imgTag = \`\\n<figure class="sf-stock-photo"><img src="\${photos[0].url}" alt="\${photos[0].alt}" width="800" height="500" loading="lazy" style="width:100%;height:auto;border-radius:8px;margin:16px 0;"><figcaption style="font-size:0.85rem;color:#666;text-align:center;">Image: \${photos[0].credit}</figcaption></figure>\\n\`;
            contentWithPhotos = contentWithPhotos.slice(0, insertAt) + imgTag + contentWithPhotos.slice(insertAt);
          }
          // Insert after 4th H2
          const h2Matches2 = [...contentWithPhotos.matchAll(/<\\/h2>/gi)];
          if (h2Matches2.length >= 4 && photos[1]) {
            const insertAt = h2Matches2[3].index + h2Matches2[3][0].length;
            const imgTag = \`\\n<figure class="sf-stock-photo"><img src="\${photos[1].url}" alt="\${photos[1].alt}" width="800" height="500" loading="lazy" style="width:100%;height:auto;border-radius:8px;margin:16px 0;"><figcaption style="font-size:0.85rem;color:#666;text-align:center;">Image: \${photos[1].credit}</figcaption></figure>\\n\`;
            contentWithPhotos = contentWithPhotos.slice(0, insertAt) + imgTag + contentWithPhotos.slice(insertAt);
          }
        }
      } catch(e) { /* stock photos parse error — ignore */ }
`;

// Find where HTML is assembled — look for the post HTML template
const htmlTemplateMatch = script.match(/const\s+html\s*=\s*`<!DOCTYPE html>/);
if (htmlTemplateMatch) {
  const templatePos = script.indexOf(htmlTemplateMatch[0]);
  script = script.slice(0, templatePos) + HTML_HERO_INJECT + '\n      ' + script.slice(templatePos);
  
  // Now inject heroHtml into the template body
  // Replace the content insertion point
  if (script.includes('${post.content}')) {
    script = script.replace(
      '${post.content}',
      '${heroHtml}\\n${contentWithPhotos}'
    );
    console.log('  ✅ Patched HTML template with hero + stock photos');
  } else {
    console.log('  ⚠️  Could not find ${post.content} in HTML template');
  }
} else {
  console.log('  ⚠️  Could not find HTML template — manual patch needed');
}

// ── Step 7: Patch upload function to include /images/ directory ──────────────
const UPLOAD_IMAGES_PATCH = `
    // Upload images directory
    const imagesDir = path.join(CONFIG.output, 'images');
    if (fs.existsSync(imagesDir)) {
      execSync(\`\${sshBase} "mkdir -p \${remote}/images"\`, { stdio: 'pipe' });
      const imageFiles = fs.readdirSync(imagesDir).filter(f => /\\.(jpg|jpeg|png|webp)$/i.test(f));
      if (imageFiles.length > 0) {
        let imgBatch = '';
        for (const img of imageFiles) {
          imgBatch += \`put \${imagesDir}/\${img} \${remote}/images/\${img}\\n\`;
        }
        fs.writeFileSync(path.join(CONFIG.output, 'sftp-img-batch.txt'), imgBatch);
        execSync(\`sftp -P \${port} -i \${key} -o StrictHostKeyChecking=no -b \${CONFIG.output}/sftp-img-batch.txt \${user}@\${host}\`, { stdio: 'pipe' });
        console.log(\`  ✅ Uploaded \${imageFiles.length} images\`);
      }
    }
`;

// Insert before the "All files uploaded" console.log
if (script.includes("console.log('  ✅ All files uploaded')")) {
  script = script.replace(
    "console.log('  ✅ All files uploaded')",
    UPLOAD_IMAGES_PATCH + "\n    console.log('  ✅ All files uploaded')"
  );
  console.log('  ✅ Patched upload function for images');
} else if (script.includes("console.log('All files uploaded successfully')")) {
  script = script.replace(
    "console.log('All files uploaded successfully')",
    UPLOAD_IMAGES_PATCH + "\n    console.log('  ✅ All files uploaded')"
  );
  console.log('  ✅ Patched upload function for images (alt match)');
} else {
  console.log('  ⚠️  Could not find upload completion log — manual patch for image upload needed');
}

// ── Step 8: Add --force-ha CLI command ──────────────────────────────────────
const FORCE_HA_BLOCK = `

  // --force-ha: Generate ALL pending HA postcode posts
  if (args.includes('--force-ha')) {
    const haTopics = db.prepare("SELECT * FROM sf_blog_topics WHERE status='pending' AND postcode IS NOT NULL ORDER BY postcode ASC, priority DESC").all();
    if (haTopics.length === 0) {
      console.log('\\nℹ️  No pending HA postcode topics. All done!');
      return;
    }
    console.log(\`\\n📍 Generating \${haTopics.length} HA postcode posts...\\n\`);
    
    for (const topic of haTopics) {
      console.log(\`\\n━━━ [\${topic.postcode}] \${topic.area_name}: \${topic.keyword} ━━━\`);
      try {
        // Temporarily override publishNextPost to use this specific topic
        const post = await generatePost(topic);
        const id = uuidv4();
        const slug = slugify(post.title);
        const now = Math.floor(Date.now() / 1000);
        
        db.prepare("INSERT INTO sf_blog_posts (id,slug,title,meta_description,content,excerpt,keyword,category,word_count,schema_json,faq_json,status,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          id, slug, post.title, post.meta_description, post.content, post.excerpt,
          topic.keyword, topic.category, post.word_count || 1500, '{}',
          post.faq ? JSON.stringify(post.faq) : null,
          'published', now, now, now
        );
        
        // Generate hero image + stock photos
        let heroResult = null;
        let stockPhotos = [];
        try {
          heroResult = await generateHeroImage(post.title, topic.keyword, topic.category);
          stockPhotos = await fetchStockPhotos(topic.keyword, topic.category, 2);
        } catch(imgErr) {
          console.log('  ⚠️  Image error (non-fatal):', imgErr.message);
        }
        
        if (heroResult || stockPhotos.length > 0) {
          db.prepare("UPDATE sf_blog_posts SET hero_image_url=?, stock_photos=?, canva_design_id=? WHERE id=?").run(
            heroResult ? heroResult.url : null,
            stockPhotos.length > 0 ? JSON.stringify(stockPhotos.map(p => ({ url: p.url, alt: p.alt, credit: p.credit }))) : null,
            heroResult ? heroResult.canvaDesignId : null,
            id
          );
        }
        
        db.prepare("UPDATE sf_blog_topics SET status='used', used_at=? WHERE id=?").run(now, topic.id);
        console.log(\`  ✅ Published: \${post.title}\`);
        
        // Rate limit — 5 second gap between posts
        await new Promise(r => setTimeout(r, 5000));
        
      } catch(e) {
        console.log(\`  ❌ \${topic.keyword}: \${e.message}\`);
      }
    }
    
    // Regenerate HTML + upload
    generateHTML();
    if (!args.includes('--preview')) {
      upload();
    }
    console.log(\`\\n🎉 HA postcode batch complete! → https://www.satfocussecurity.co.uk/news/\`);
    return;
  }
`;

// Insert before the existing --force check in main()
if (script.includes("if (args.includes('--force'))")) {
  script = script.replace(
    "if (args.includes('--force'))",
    FORCE_HA_BLOCK + "\n  if (args.includes('--force'))"
  );
  console.log('  ✅ Added --force-ha CLI command');
} else {
  console.log('  ⚠️  Could not find --force handler — manual patch needed');
}

// ── Step 9: Add OpenGraph image meta tag to HTML template ───────────────────
// Look for the og:type meta and add og:image after it
if (script.includes('og:type')) {
  const ogTypePattern = /<meta\s+property="og:type"\s+content="article"\s*\/?>/;
  const ogMatch = script.match(ogTypePattern);
  if (ogMatch) {
    script = script.replace(
      ogMatch[0],
      ogMatch[0] + '\n      <meta property="og:image" content="${heroUrl || \'https://www.satfocussecurity.co.uk/news/images/satfocus-default-hero.jpg\'}" />'
    );
    console.log('  ✅ Added og:image meta tag');
  }
} else {
  console.log('  ℹ️  No og:type found — skipping og:image injection');
}

// ── Step 10: Write patched script ───────────────────────────────────────────
fs.writeFileSync(SCRIPT_PATH, script, 'utf8');
console.log(`\n  ✅ Patched script written to ${path.basename(SCRIPT_PATH)}`);

console.log(`
═══ Patch Complete ═══

New features:
  🎨 Canva hero images: Auto-generated branded 1200×630 banners
  📸 Stock photos: 2 per post, inserted after H2 sections
  📍 --force-ha: Generate ALL HA postcode posts in one batch
  🖼️  og:image: OpenGraph image meta for social sharing

Commands:
  node satfocus-blog-v3.js --force         # Next pending post (with images)
  node satfocus-blog-v3.js --force-ha      # ALL HA postcode posts
  node satfocus-blog-v3.js --list          # View queue
  node satfocus-blog-v3.js --regen         # Rebuild HTML only
  node satfocus-blog-v3.js --preview --force   # Preview without upload

Image storage:
  Local: ./output/images/
  Remote: /news/images/ on Krystal
`);
