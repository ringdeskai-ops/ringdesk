#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════
 * SatFocus Security Solutions — Blog Automation Engine v3
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * Production-grade automated blog system optimised for:
 * - Google AI Overviews, AI Mode, Featured Snippets
 * - ChatGPT Search, Perplexity, Claude citations (GEO)
 * - Answer Engine Optimisation (AEO)
 * - Voice search / conversational queries
 * - Local SEO across Greater London
 * 
 * Architecture:
 *   AiRingDesk VPS (CentOS/Plesk)
 *     → Claude API generates content
 *     → SQLite stores posts/topics/schedule
 *     → HTML generator builds branded pages
 *     → SFTP pushes to Krystal hosting
 *   Krystal (cPanel)
 *     → /news/ subdirectory serves static HTML
 *     → .htaccess enables clean URLs
 * 
 * Commands:
 *   node satfocus-blog-v3.js                 # Scheduled run (cron)
 *   node satfocus-blog-v3.js --force         # Generate + upload now
 *   node satfocus-blog-v3.js --preview       # Generate locally, no upload
 *   node satfocus-blog-v3.js --list          # Show topic queue
 *   node satfocus-blog-v3.js --rewrite       # Rewrite ALL posts with new prompt
 *   node satfocus-blog-v3.js --rewrite-one   # Rewrite most recent post only
 *   node satfocus-blog-v3.js --regen         # Regenerate HTML only (no API)
 *   node satfocus-blog-v3.js --init          # Re-initialise DB
 * 
 * @version 3.0.0
 * @author SatFocus / AiRingDesk
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  db: path.join(__dirname, 'satfocus-blog.db'),
  output: path.join(__dirname, 'output'),
  model: 'claude-sonnet-4-20250514',
  
  sftp: {
    host: 'tajfun-lon.krystal.uk',
    port: 722,
    user: 'aismarts',
    key: '/root/.ssh/satfocus_krystal_rsa',
    remote: '/home/aismarts/satfocussecurity.co.uk/news',
  },

  site: {
    name: 'SatFocus Security Solutions',
    url: 'https://www.satfocussecurity.co.uk',
    phone: '0208 422 7918',
    email: 'info@satfocussecurity.co.uk',
    logo: 'https://www.satfocussecurity.co.uk/wp-content/uploads/2021/05/Satfocus-Logo-1024x350-1.png',
    checkatrade: 'https://www.satfocussecurity.co.uk/wp-content/uploads/2019/12/check-a-trade-uk2.png',
    which: 'https://www.satfocussecurity.co.uk/wp-content/uploads/elementor/thumbs/which-trusted-trader-uk-satfocus-qkv93dl84lig6nmro81hyla1avy3dmazay3nvhcuzs.png',
    founder: 'Thilaganathan (Thiru)',
    established: 2015,
    installs: '3,000+',
  },

  // Internal link map — every service page on the site
  links: {
    home: 'https://www.satfocussecurity.co.uk',
    services: 'https://www.satfocussecurity.co.uk/services-home-security-systems-av-and-security-solutions/',
    cctv: 'https://www.satfocussecurity.co.uk/service/cctv-installation-in-london/',
    cctv_landing: 'https://www.satfocussecurity.co.uk/cctv-installation-london-satfocus-security-solutions/',
    hikvision_ahd: 'https://www.satfocussecurity.co.uk/hikvision-hd-analog-cctv-packages/',
    hikvision_ip: 'https://www.satfocussecurity.co.uk/hikvision-ip-cctv-packages/',
    alarms: 'https://www.satfocussecurity.co.uk/service/burglar-alarm-installation-intruder-alarm-installation-in-london/',
    pyronix: 'https://www.satfocussecurity.co.uk/pyronix-alarm-packages/',
    texecom: 'https://www.satfocussecurity.co.uk/texecom-alarm-packages/',
    visonic: 'https://www.satfocussecurity.co.uk/visonic-powermaster-alarms/',
    risco: 'https://www.satfocussecurity.co.uk/risco-agility-alarm-packages/',
    alarm_upgrade: 'https://www.satfocussecurity.co.uk/burglar-alarm-upgrade/',
    alarm_service: 'https://www.satfocussecurity.co.uk/burglar-alarm-service/',
    intercom: 'https://www.satfocussecurity.co.uk/gate-intercom-system/',
    ajax: 'https://www.satfocussecurity.co.uk/ajax-alarm-system/',
    locations: 'https://www.satfocussecurity.co.uk/our-service-locations/',
    contact: 'https://www.satfocussecurity.co.uk/contact/',
    news: 'https://www.satfocussecurity.co.uk/news/',
    blog: 'https://www.satfocussecurity.co.uk/blog/',
  },

  areas: [
    'Harrow','Wembley','Ealing','Acton','Hanwell','Greenford','Northolt',
    'Ruislip','Pinner','Stanmore','Edgware','Finchley','Hendon','Brent',
    'Hounslow','Uxbridge','Hayes','Southall','Twickenham','Richmond',
    'Chiswick','Hammersmith','Kensington','Paddington','Kilburn','Willesden',
    'Neasden','Kingsbury','Colindale','Barnet','Enfield','Camden',
    'Islington','Hackney','Croydon','Wandsworth','Greenwich','Lewisham',
    'Lambeth','Southwark','Tower Hamlets','Redbridge','Ilford'
  ],
};

// ═══════════════════════════════════════════════════════════════════════
// API KEY
// ═══════════════════════════════════════════════════════════════════════

let apiKey = process.env.ANTHROPIC_API_KEY || '';
if (!apiKey) {
  try {
    const env = execSync('pm2 env 1 2>/dev/null').toString();
    const m = env.match(/ANTHROPIC_API_KEY:\s*(\S+)/);
    if (m) apiKey = m[1];
  } catch(e) {}
}
if (!apiKey) { console.error('❌ No ANTHROPIC_API_KEY'); process.exit(1); }

const anthropic = new Anthropic({ apiKey });
const db = new Database(CONFIG.db);
db.pragma('journal_mode = WAL');
fs.mkdirSync(CONFIG.output, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════════════

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sf_blog_posts (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      meta_description TEXT,
      content TEXT NOT NULL,
      excerpt TEXT,
      keyword TEXT,
      category TEXT,
      word_count INTEGER DEFAULT 0,
      faq_json TEXT,
      status TEXT DEFAULT 'published',
      created_at INTEGER,
      updated_at INTEGER,
      published_at INTEGER,
      uploaded_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sf_blog_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      title_hint TEXT,
      category TEXT DEFAULT 'General',
      priority INTEGER DEFAULT 5,
      status TEXT DEFAULT 'pending',
      used_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS sf_blog_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT, details TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
}

function seedTopics() {
  if (db.prepare('SELECT COUNT(*) as c FROM sf_blog_topics').get().c > 0) return;
  const topics = [
    ['CCTV installation London','Professional CCTV Installation in London','CCTV',10],
    ['best CCTV systems for homes UK','Best CCTV Systems for Homes in the UK','CCTV',9],
    ['commercial CCTV systems London','Commercial CCTV Systems in London','CCTV',8],
    ['CCTV maintenance contract London','CCTV Maintenance Contracts in London','CCTV',7],
    ['IP CCTV vs analogue cameras','IP CCTV vs Analogue Cameras — Which Is Right?','CCTV',6],
    ['Hikvision CCTV installer London','Certified Hikvision CCTV Installer in London','CCTV',8],
    ['CCTV for construction sites','CCTV for Construction Sites in London','CCTV',6],
    ['4K CCTV camera systems','4K CCTV Camera Systems — Is Ultra HD Worth It?','CCTV',5],
    ['intruder alarm installation London','Intruder Alarm Installation in London','Intruder Alarms',10],
    ['burglar alarm systems UK','Burglar Alarm Systems UK Buyers Guide','Intruder Alarms',9],
    ['Texecom alarm systems','Texecom Alarm Systems — Why Professionals Choose Texecom','Intruder Alarms',8],
    ['wireless intruder alarm systems','Wireless Intruder Alarms — Are They Reliable?','Intruder Alarms',7],
    ['alarm monitoring service London','Alarm Monitoring Service London','Intruder Alarms',8],
    ['Ajax alarm system UK','Ajax Alarm System UK — Smart Wireless Security','Intruder Alarms',9],
    ['alarm maintenance and servicing','Alarm Maintenance — How Often to Service','Intruder Alarms',6],
    ['insurance approved alarm systems','Insurance Approved Alarms — Reducing Premiums','Intruder Alarms',7],
    ['video intercom installation London','Video Intercom Installation London','Video Intercoms',9],
    ['video door entry system for flats','Video Door Entry for Flats','Video Intercoms',8],
    ['IP video intercom systems','IP Video Intercom Systems','Video Intercoms',7],
    ['Hikvision video intercom','Hikvision Video Intercom','Video Intercoms',7],
    ['intercom replacement service London','Intercom Replacement London','Video Intercoms',6],
    ['access control systems London','Access Control Systems London','Access Control',9],
    ['keyless entry systems for offices','Keyless Entry for Offices','Access Control',7],
    ['door access control installation','Door Access Control Installation','Access Control',7],
    ['biometric access control','Biometric Access Control — Fingerprint and Facial','Access Control',6],
    ['home security systems London','Home Security Systems London','General Security',10],
    ['commercial security solutions London','Commercial Security Solutions London','General Security',9],
    ['security system cost UK','Security System Cost UK','General Security',8],
    ['smart home security integration','Smart Home Security Integration','General Security',7],
    ['fire alarm installation London','Fire Alarm Installation London','General Security',7],
    ['security for landlords','Security for Landlords','General Security',6],
    ['retail security systems','Retail Security Systems','General Security',6],
    ['security survey London','Free Security Survey London','General Security',8],
    ['burglary statistics London 2026','Burglary Statistics London 2026','General Security',7],
    ['Dahua CCTV installer London','Dahua CCTV Installer London','CCTV',8],
    ['Comelit intercom system UK','Comelit Intercom Systems UK','Video Intercoms',7],
    ['Videx intercom installation','Videx Intercom Installation','Video Intercoms',7],
    ['Paxton access control installer','Paxton Access Control Installer','Access Control',8],
    ['Texecom Premier Elite installer','Texecom Premier Elite Installer','Intruder Alarms',8],
    ['Ajax Hub 2 Plus alarm review','Ajax Hub 2 Plus Review','Intruder Alarms',7],
    ['Hikvision vs Dahua CCTV comparison','Hikvision vs Dahua CCTV Comparison','CCTV',7],
    ['Texecom vs Ajax alarm systems','Texecom vs Ajax Alarm Comparison','Intruder Alarms',7],
    ['CCTV installation Harrow','CCTV Installation Harrow','Local',9],
    ['burglar alarm installation Ealing','Burglar Alarm Installation Ealing','Local',9],
    ['security systems Wembley','Security Systems Wembley','Local',9],
    ['CCTV installer Brent','CCTV Installer Brent','Local',8],
    ['alarm installation Hounslow','Alarm Installation Hounslow','Local',8],
    ['CCTV installation Barnet','CCTV Installation Barnet','Local',7],
    ['security installer Hammersmith','Security Installer Hammersmith','Local',7],
    ['CCTV Kensington Chelsea','CCTV Installation Kensington and Chelsea','Local',6],
    ['CCTV installation cost London','CCTV Installation Cost London','CCTV',9],
    ['how much does a burglar alarm cost UK','How Much Does a Burglar Alarm Cost UK?','Intruder Alarms',9],
    ['best security company London','Best Security Company London','General Security',8],
    ['CCTV camera types explained','CCTV Camera Types Explained','CCTV',7],
    ['wired vs wireless alarm systems UK','Wired vs Wireless Alarm Systems UK','Intruder Alarms',7],
    ['CCTV laws UK residential','CCTV Laws UK Residential','CCTV',7],
    ['GDPR CCTV compliance business','GDPR and CCTV Compliance for Business','General Security',6],
    ['door entry system for block of flats','Door Entry for Blocks of Flats','Video Intercoms',8],
    ['CCTV for restaurants London','CCTV for Restaurants London','CCTV',6],
    ['security systems for care homes','Security for Care Homes','General Security',6],
    ['hotel security systems London','Hotel Security Systems London','General Security',6],
    ['CCTV for housing associations','CCTV for Housing Associations','CCTV',7],
    ['CCTV installation Hertfordshire','CCTV Installation Hertfordshire','Local',6],
    ['CCTV installation Watford','CCTV Installation Watford','Local',6],
    ['new build home security checklist','New Build Home Security Checklist','General Security',6],
    ['moving house security checklist UK','Moving House Security Checklist','General Security',6],
    ['number plate recognition CCTV ANPR','ANPR CCTV Systems','CCTV',6],
    ['remote CCTV monitoring service UK','Remote CCTV Monitoring Service','CCTV',6],
    ['Pyronix alarm system installer','Pyronix Alarm Systems','Intruder Alarms',6],
    ['Risco alarm system UK','Risco Alarm Systems UK','Intruder Alarms',5],
    ['BPT intercom system','BPT Intercom Systems','Video Intercoms',6],
    ['Paxton Net2 door entry system','Paxton Net2 Door Entry','Access Control',7],
    ['Comelit vs Hikvision intercom','Comelit vs Hikvision Intercom','Video Intercoms',6],
    ['CCTV for car dealerships','CCTV for Car Dealerships','CCTV',5],
    ['electric gate installation London','Electric Gate Installation London','Access Control',6],
    ['warehouse security solutions','Warehouse Security Solutions','General Security',5],
    ['school security systems UK','School Security Systems UK','General Security',5],
    ['winter home security tips','Winter Home Security Tips','Seasonal',5],
    ['holiday home security checklist','Holiday Security Checklist','Seasonal',5],
    ['summer security tips home','Summer Security Tips','Seasonal',5],
    ['how to prevent porch piracy UK','How to Prevent Porch Piracy','Seasonal',5],
    ['alarm systems for pubs and bars','Alarm Systems for Pubs and Bars','Intruder Alarms',5],
    ['nursery CCTV systems UK','Nursery CCTV Systems','CCTV',6],
    ['dental practice security systems','Dental Practice Security','General Security',5],
    ['security for estate agents offices','Security for Estate Agents','General Security',5],
    ['gym security CCTV access control','Gym Security CCTV and Access Control','General Security',5],
    ['church security systems UK','Church Security Systems','General Security',5],
    ['security company Hillingdon','Security Company Hillingdon','Local',7],
    ['alarm systems Enfield','Alarm Systems Enfield','Local',7],
    ['security systems Richmond','Security Systems Richmond','Local',6],
    ['alarm installer Croydon','Alarm Installer Croydon','Local',6],
    ['CCTV installation Hackney','CCTV Installation Hackney','Local',6],
    ['security company Islington','Security Company Islington','Local',6],
    ['CCTV installer Camden','CCTV Installer Camden','Local',5],
    ['alarm installation Wandsworth','Alarm Installation Wandsworth','Local',5],
    ['security systems Greenwich','Security Systems Greenwich','Local',5],
    ['security installer Redbridge','Security Installer Redbridge','Local',5],
    ['CCTV installation Lambeth','CCTV Installation Lambeth','Local',5],
    ['alarm systems Slough','Alarm Systems Slough','Local',5],
    ['security installer St Albans','Security Installer St Albans','Local',5],
    ['perimeter security systems UK','Perimeter Security Systems','General Security',5],
    ['security lighting installation London','Security Lighting Installation','General Security',5],
  ];
  const stmt = db.prepare('INSERT INTO sf_blog_topics (keyword, title_hint, category, priority) VALUES (?,?,?,?)');
  db.transaction(() => topics.forEach(t => stmt.run(...t)))();
  console.log(`✅ Seeded ${topics.length} topics`);
}

// ═══════════════════════════════════════════════════════════════════════
// AEO/GEO CONTENT GENERATION PROMPT
// ═══════════════════════════════════════════════════════════════════════

function buildPrompt(topic) {
  const L = CONFIG.links;
  const S = CONFIG.site;
  const randomAreas = CONFIG.areas.sort(() => Math.random() - .5).slice(0, 6).join(', ');
  
  // Get existing published posts for cross-linking
  const existingPosts = db.prepare("SELECT slug, title, keyword, category FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 10").all();
  const crossLinks = existingPosts.map(p => `  - "${p.title}": ${S.url}/news/${p.slug}/`).join('\n');

  return `You are a world-class SEO content strategist writing for the AI search era (2026). Your content must rank in Google, appear in Google AI Overviews, get cited by ChatGPT Search, Perplexity, and Claude, and win featured snippets.

You are writing for SatFocus Security Solutions — a London-based security installer with ${S.installs} installations since ${S.established}. Checkatrade verified. Which Trusted Trader approved. Founded by ${S.founder}.

═══ TARGET ═══
Primary keyword: "${topic.keyword}"
Category: ${topic.category}

═══ AI-ERA CONTENT ARCHITECTURE ═══

Your content must follow this exact structure for maximum AI extractability:

1. DIRECT ANSWER OPENING (first paragraph):
   Write 2-3 sentences that directly answer the question implied by the keyword. This MUST be written as a standalone answer that an AI system can extract verbatim. No filler, no "in this article we will discuss", no preamble.
   Example: "Professional CCTV installation in London costs between £600 and £2,500 for a typical 4-camera home system. The price depends on camera resolution (HD vs 4K), wiring complexity, and whether you need night-vision capabilities like Hikvision ColorVu."

2. KEY TAKEAWAYS BOX (immediately after opening):
   <div class="sf-takeaways">
   <h3>Key Takeaways</h3>
   <ul>
   <li>5-6 concise, factual bullet points</li>
   <li>Each must be independently useful if extracted by AI</li>
   <li>Include at least one specific number, price, or statistic</li>
   </ul>
   </div>

3. BODY SECTIONS — Every H2 MUST be phrased as a question:
   - Use questions real people type into Google ("How much does..." / "What is the best..." / "Do I need...")
   - Start each section with a 1-2 sentence DIRECT ANSWER before elaborating
   - This structure feeds Google's People Also Ask and AI Overviews
   - Include comparison tables where relevant using <table> tags
   - Include specific product models, prices, and specifications

4. EXPERT AUTHORITY SECTION:
   Include a section establishing why SatFocus is the authority:
   <div class="sf-authority">
   <h3>Why Trust SatFocus Security Solutions?</h3>
   <ul>
   <li>${S.installs} installations completed across Greater London since ${S.established}</li>
   <li>Checkatrade verified with 5-star reviews</li>
   <li>Which Trusted Trader approved</li>
   <li>Speak directly to our founder, ${S.founder} — not a call centre</li>
   <li>All work compliant with BS EN 50131, BS 8418, and BS 5839</li>
   <li>Free, no-obligation security surveys across all London boroughs</li>
   </ul>
   </div>

5. FAQ SECTION — 5 questions targeting People Also Ask:
   Phrase as exact Google queries. Answers must be 2-3 sentences each — concise enough for AI extraction but detailed enough to be useful.

═══ INTERNAL LINKS — USE 6-8 OF THESE ═══
Weave naturally into content as <a href="URL">descriptive anchor text</a>:
  CCTV: ${L.cctv}
  CCTV packages: ${L.cctv_landing}
  Hikvision AHD: ${L.hikvision_ahd}
  Hikvision IP: ${L.hikvision_ip}
  Burglar alarms: ${L.alarms}
  Texecom: ${L.texecom}
  Pyronix: ${L.pyronix}
  Visonic: ${L.visonic}
  Risco: ${L.risco}
  Ajax: ${L.ajax}
  Alarm upgrade: ${L.alarm_upgrade}
  Alarm service: ${L.alarm_service}
  Intercom: ${L.intercom}
  All services: ${L.services}
  Service areas: ${L.locations}
  Contact/survey: ${L.contact}
  News hub: ${L.news}

${crossLinks ? `═══ CROSS-LINKS TO OTHER BLOG POSTS ═══\nLink to 1-2 of these where relevant:\n${crossLinks}\n` : ''}
═══ CONTENT RULES ═══
- British English throughout
- 1,500-2,200 words
- DO NOT mention "NSI", "NSI approved", or any physical address
- DO NOT use generic filler like "In today's world" or "In this article"
- DO include: specific product models (Texecom Premier Elite 24, Hikvision DS-2CD2386G2-IU, Ajax Hub 2 Plus, Dahua IPC-HFW2849S-S-IL, Paxton Net2), British Standards, UK law references, specific price ranges
- Mention these London areas naturally: ${randomAreas}
- End with CTA: free security survey, phone ${S.phone}, link to ${L.contact}

═══ OUTPUT ═══
Respond ONLY with valid JSON (no markdown fences, no commentary):
{
  "title": "string (under 58 characters, includes primary keyword)",
  "meta_description": "string (150-155 characters, keyword + benefit + CTA)",
  "content": "string (complete HTML body content with all divs, tables, links)",
  "excerpt": "string (2-3 sentence preview for blog cards)",
  "word_count": number,
  "faq": [{"question":"string","answer":"string"}]
}`;
}

// ═══════════════════════════════════════════════════════════════════════
// CONTENT GENERATION
// ═══════════════════════════════════════════════════════════════════════

function slugify(t) { return t.toLowerCase().replace(/['']/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function esc(t) { return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }


// ═══════════════════════════════════════════════════════════════════════
// CANVA HERO IMAGE GENERATION
// ═══════════════════════════════════════════════════════════════════════

async function generateHeroImage(title, keyword, category) {
  console.log('  🎨 Generating Canva hero image...');
  try {
    // Use Claude API with Canva MCP to generate a branded hero image
    // Use module-level apiKey (loaded at startup from PM2 env)
    if (!apiKey) { console.log('  ⚠️  No API key — skipping hero image'); return null; }

    const designQuery = `Professional security company blog hero banner image.
Title text: "${title}"
Style: Dark charcoal background (#333333) with red accent (#BC0000).
Include imagery related to: ${category === 'CCTV' ? 'CCTV cameras, surveillance' : category === 'Intruder Alarms' ? 'alarm panels, security sensors' : category === 'Intercoms' ? 'video intercom, door entry panel' : category === 'Access Control' ? 'access control keypad, card reader' : 'security systems, property protection'}.
Company branding: "SatFocus Security Solutions" small text in bottom-right corner.
Professional, trustworthy, modern look for a security installation company blog.
Facebook cover size (1200x630). Clean and bold.`;

    // Step 1: Generate design candidates via Canva MCP
    const genResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: `Generate a Canva design with this specification: ${designQuery}. Use the generate-design tool with design_type "facebook_cover".` }],
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
        messages: [{ role: 'user', content: `Create an editable design from this Canva candidate. Use the create-design-from-candidate tool with job_id "${jobId}" and candidate_id "${candidateId}".` }],
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
        messages: [{ role: 'user', content: `Export this Canva design as a JPG image. Use the export-design tool with design_id "${designId}" and format type "jpg" with quality 90, width 1200, height 630.` }],
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
    const imgFilename = `hero-${slugify(keyword)}.jpg`;
    const imgPath = path.join(CONFIG.output, 'images', imgFilename);
    
    fs.mkdirSync(path.join(CONFIG.output, 'images'), { recursive: true });
    fs.writeFileSync(imgPath, imgBuffer);

    console.log(`  ✅ Hero image saved: ${imgFilename} (${Math.round(imgBuffer.length/1024)}KB)`);
    
    return {
      localPath: imgPath,
      filename: imgFilename,
      remotePath: `/news/images/${imgFilename}`,
      url: `https://www.satfocussecurity.co.uk/news/images/${imgFilename}`,
      canvaDesignId: designId
    };

  } catch(e) {
    console.log(`  ⚠️  Hero image error: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STOCK PHOTO FETCHING (Unsplash-compatible)
// ═══════════════════════════════════════════════════════════════════════

async function fetchStockPhotos(keyword, category, count = 2) {
  console.log(`  📸 Fetching ${count} stock photos...`);
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
      const photoUrl = `https://source.unsplash.com/800x500/?${query}&sig=${seed}`;
      
      // Download the image
      try {
        const resp = await fetch(photoUrl, { redirect: 'follow' });
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          const filename = `stock-${slugify(keyword)}-${i + 1}.jpg`;
          const filePath = path.join(CONFIG.output, 'images', filename);
          
          fs.mkdirSync(path.join(CONFIG.output, 'images'), { recursive: true });
          fs.writeFileSync(filePath, buffer);
          
          photos.push({
            localPath: filePath,
            filename: filename,
            remotePath: `/news/images/${filename}`,
            url: `https://www.satfocussecurity.co.uk/news/images/${filename}`,
            alt: `${category} installation - ${keyword}`,
            credit: 'Unsplash'
          });
          
          console.log(`    ✅ Stock photo ${i + 1}: ${filename} (${Math.round(buffer.length/1024)}KB)`);
        }
      } catch(imgErr) {
        console.log(`    ⚠️  Stock photo ${i + 1} failed: ${imgErr.message}`);
      }
      
      // Small delay between requests
      await new Promise(r => setTimeout(r, 500));
    }
    
    return photos;
    
  } catch(e) {
    console.log(`  ⚠️  Stock photos error: ${e.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════
async function generatePost(topic) {
  const prompt = buildPrompt(topic);
  const response = await anthropic.messages.create({
    model: CONFIG.model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content[0].text;
  return JSON.parse(text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim());
}

async function publishNext(force = false) {
  if (!force) {
    const today = new Date().toISOString().split('T')[0];
    const last = db.prepare("SELECT published_at FROM sf_blog_posts ORDER BY published_at DESC LIMIT 1").get();
    if (last && new Date(last.published_at * 1000).toISOString().split('T')[0] === today) {
      console.log('Already published today. Use --force.');
      return null;
    }
  }
  const topic = db.prepare("SELECT * FROM sf_blog_topics WHERE status='pending' ORDER BY priority DESC, id ASC LIMIT 1").get();
  if (!topic) { console.log('⚠️  No pending topics.'); return null; }

  console.log(`\n📝 Generating: "${topic.keyword}" [${topic.category}]`);
  try {
    const post = await generatePost(topic);
    const id = uuidv4();
    const slug = slugify(post.title);
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`INSERT INTO sf_blog_posts (id,slug,title,meta_description,content,excerpt,keyword,category,word_count,faq_json,status,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, slug, post.title, post.meta_description, post.content, post.excerpt,
      topic.keyword, topic.category, post.word_count || 1600,
      JSON.stringify(post.faq || []), 'published', now, now, now
    );
    
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

    db.prepare("UPDATE sf_blog_topics SET status='used', used_at=? WHERE id=?").run(now, topic.id);

    console.log(`✅ Published: ${post.title}`);
    console.log(`   /news/${slug}/  |  ${post.word_count} words  |  ${(post.faq||[]).length} FAQ`);
    return { id, slug, title: post.title };
  } catch(e) {
    console.error('❌ Failed:', e.message);
    return null;
  }
}

async function rewritePost(post) {
  console.log(`  ✍️  ${post.keyword}`);
  const topic = { keyword: post.keyword, category: post.category };
  const newPost = await generatePost(topic);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE sf_blog_posts SET title=?,meta_description=?,content=?,excerpt=?,word_count=?,faq_json=?,updated_at=? WHERE id=?`).run(
    newPost.title, newPost.meta_description, newPost.content, newPost.excerpt,
    newPost.word_count || 1600, JSON.stringify(newPost.faq || []), now, post.id
  );
  // Update slug if title changed
  const newSlug = slugify(newPost.title);
  if (newSlug !== post.slug) {
    try { db.prepare("UPDATE sf_blog_posts SET slug=? WHERE id=?").run(newSlug, post.id); } catch(e) {}
  }
  return { ...post, ...newPost, slug: newSlug || post.slug };
}

// ═══════════════════════════════════════════════════════════════════════
// HTML TEMPLATES
// ═══════════════════════════════════════════════════════════════════════

// Shared CSS — loaded from separate function for maintainability
function sharedCSS() {
  const S = CONFIG.site;
  return `*{margin:0;padding:0;box-sizing:border-box}
:root{--red:#BC0000;--red-dark:#9a0000;--dark:#111;--charcoal:#1a1a1a;--text:#2d2d2d;--text-mid:#555;--text-light:#888;--bg:#fff;--bg-alt:#f6f6f6;--bg-warm:#fafaf8;--border:#e5e5e5;--border-light:#f0f0f0;--radius:8px;--max:1140px;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif}
body{font-family:var(--font);color:var(--text);line-height:1.8;font-size:17px;background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--red);text-decoration:none;transition:color .15s}
a:hover{color:var(--red-dark)}
img{max-width:100%;height:auto}

/* Top bar */
.tb{background:var(--dark);padding:6px 0;font-size:12px;color:#777;letter-spacing:.3px}
.tb-inner{max-width:var(--max);margin:0 auto;padding:0 24px;display:flex;justify-content:flex-end;gap:20px}
.tb a{color:#999;transition:color .15s}
.tb a:hover{color:var(--red)}

/* Header */
.hd{background:var(--bg);padding:10px 0;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.hd-inner{max-width:var(--max);margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.hd-logo img{height:44px}
.hd-nav{display:flex;gap:1px;align-items:center}
.hd-nav a{color:var(--text);font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:4px;text-transform:uppercase;letter-spacing:.6px;transition:all .15s}
.hd-nav a:hover,.hd-nav a.on{color:var(--red);background:rgba(188,0,0,.03)}
.hd-cta{background:var(--red)!important;color:#fff!important;border-radius:5px!important;font-weight:700!important;letter-spacing:.3px!important}
.hd-cta:hover{background:var(--red-dark)!important}
.hd-badges{display:flex;gap:6px;align-items:center}
.hd-badges img{height:32px;opacity:.75;transition:opacity .15s}
.hd-badges img:hover{opacity:1}

/* Footer */
.ft{background:var(--charcoal);color:#777;padding:40px 0 20px;font-size:13px;line-height:1.7}
.ft-inner{max-width:var(--max);margin:0 auto;padding:0 24px;display:grid;grid-template-columns:2fr 1fr 1fr;gap:40px}
.ft h4{color:#ddd;font-size:11px;margin-bottom:14px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px}
.ft a{color:#999;transition:color .15s}
.ft a:hover{color:var(--red)}
.ft ul{list-style:none;padding:0}
.ft li{margin-bottom:5px}
.ft-bottom{max-width:var(--max);margin:20px auto 0;padding:16px 24px 0;border-top:1px solid #2a2a2a;text-align:center;color:#555;font-size:11px;letter-spacing:.3px}

@media(max-width:960px){.hd-nav,.hd-badges{display:none}.ft-inner{grid-template-columns:1fr}.tb-inner{justify-content:center}}`;
}

function headerHTML() {
  const S = CONFIG.site;
  const L = CONFIG.links;
  return `<div class="tb"><div class="tb-inner"><a href="mailto:${S.email}">${S.email}</a><a href="tel:02084227918">${S.phone}</a></div></div>
<header class="hd"><div class="hd-inner">
<a href="${L.home}" class="hd-logo"><img src="${S.logo}" alt="SatFocus Security Solutions"></a>
<nav class="hd-nav">
<a href="${L.home}">Home</a>
<a href="${L.services}">Services</a>
<a href="${L.cctv}">CCTV</a>
<a href="${L.alarms}">Alarms</a>
<a href="${L.intercom}">Intercoms</a>
<a href="${L.news}" class="on">News</a>
<a href="${L.contact}" class="hd-cta">Free Survey</a>
</nav>
<div class="hd-badges">
<img src="${S.checkatrade}" alt="Checkatrade verified">
<img src="${S.which}" alt="Which Trusted Trader">
</div>
</div></header>`;
}

function footerHTML() {
  const S = CONFIG.site;
  const L = CONFIG.links;
  return `<footer class="ft"><div class="ft-inner">
<div><h4>SatFocus Security Solutions</h4><p>Professional CCTV, alarm, intercom, and access control installation across London since ${S.established}. ${S.installs} installations completed. Checkatrade verified. Which Trusted Trader approved.</p></div>
<div><h4>Services</h4><ul>
<li><a href="${L.cctv}">CCTV Installation</a></li>
<li><a href="${L.alarms}">Intruder Alarms</a></li>
<li><a href="${L.intercom}">Video Intercoms</a></li>
<li><a href="${L.alarm_service}">Alarm Servicing</a></li>
<li><a href="${L.locations}">Service Areas</a></li>
</ul></div>
<div><h4>Contact</h4><ul>
<li><a href="tel:02084227918">${S.phone}</a></li>
<li><a href="mailto:${S.email}">${S.email}</a></li>
<li><a href="${L.contact}">Book Free Survey</a></li>
<li>All London boroughs</li>
</ul></div>
</div>
<div class="ft-bottom">© ${new Date().getFullYear()} SatFocus Security Solutions. All rights reserved.</div>
</footer>`;
}

function postHTML(post) {
  const S = CONFIG.site;
  const L = CONFIG.links;
  const pubDate = new Date(post.published_at * 1000).toISOString().split('T')[0];
  const updDate = new Date((post.updated_at || post.published_at) * 1000).toISOString().split('T')[0];
  const pubFmt = new Date(post.published_at * 1000).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const updFmt = new Date((post.updated_at || post.published_at) * 1000).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const mins = Math.ceil((post.word_count || 1500) / 250);
  
  // Hero image
  const heroUrl = post.hero_image_url || '';
  const heroHtml = heroUrl
    ? `<div class="sf-hero-image"><img src="${heroUrl}" alt="${post.title}" width="1200" height="630" loading="eager" style="width:100%;height:auto;border-radius:12px;margin-bottom:24px;"></div>`
    : '';

  // Clean any residual NSI references
  let content = (post.content || '').replace(/NSI[- ]?approved\s*/gi,'').replace(/NSI[- ]?accredited\s*/gi,'').replace(/\bNSI\b/g,'');

  // Stock photos — inject into content after 2nd and 4th H2
  try {
    const photos = post.stock_photos ? JSON.parse(post.stock_photos) : [];
    if (photos.length > 0) {
      const h2s = [...content.matchAll(/<\/h2>/gi)];
      if (h2s.length >= 4 && photos[1]) {
        const at4 = h2s[3].index + h2s[3][0].length;
        content = content.slice(0, at4) + `\n<figure class="sf-stock-photo"><img src="${photos[1].url}" alt="${photos[1].alt}" width="800" height="500" loading="lazy" style="width:100%;height:auto;border-radius:8px;margin:16px 0;"><figcaption style="font-size:0.85rem;color:#666;text-align:center;">Image: ${photos[1].credit}</figcaption></figure>\n` + content.slice(at4);
      }
      if (h2s.length >= 2 && photos[0]) {
        const at2 = h2s[1].index + h2s[1][0].length;
        content = content.slice(0, at2) + `\n<figure class="sf-stock-photo"><img src="${photos[0].url}" alt="${photos[0].alt}" width="800" height="500" loading="lazy" style="width:100%;height:auto;border-radius:8px;margin:16px 0;"><figcaption style="font-size:0.85rem;color:#666;text-align:center;">Image: ${photos[0].credit}</figcaption></figure>\n` + content.slice(at2);
      }
    }
  } catch(e) { /* stock photo parse error */ }

  // Build FAQ schema
  let faqSchema = '';
  let faqItems = [];
  try { faqItems = JSON.parse(post.faq_json || '[]'); } catch(e) {}
  if (faqItems.length > 0) {
    faqSchema = `,{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[${faqItems.map(f=>`{"@type":"Question","name":${JSON.stringify(f.question)},"acceptedAnswer":{"@type":"Answer","text":${JSON.stringify(f.answer)}}}`).join(',')}]}`;
  }

  // Related posts
  const related = db.prepare("SELECT slug,title,category FROM sf_blog_posts WHERE status='published' AND id!=? AND category=? ORDER BY published_at DESC LIMIT 3").all(post.id, post.category);
  const relatedHTML = related.length > 0 ? `<div class="related"><h3>Related articles</h3><ul>${related.map(r=>`<li><a href="${S.url}/news/${r.slug}/">${esc(r.title)}</a></li>`).join('')}</ul></div>` : '';

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(post.title)} | SatFocus Security Solutions</title>
<meta name="description" content="${esc(post.meta_description)}">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1">
<link rel="canonical" href="${S.url}/news/${post.slug}/">
<meta property="og:title" content="${esc(post.title)}">
<meta property="og:description" content="${esc(post.meta_description)}">
<meta property="og:type" content="article">
      <meta property="og:image" content="${heroUrl || 'https://www.satfocussecurity.co.uk/news/images/satfocus-default-hero.jpg'}" />
<meta property="og:url" content="${S.url}/news/${post.slug}/">
<meta property="og:site_name" content="SatFocus Security Solutions">
<meta property="og:locale" content="en_GB">
<meta property="article:published_time" content="${pubDate}">
<meta property="article:modified_time" content="${updDate}">
<meta property="article:section" content="${esc(post.category)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(post.title)}">
<meta name="twitter:description" content="${esc(post.meta_description)}">

<script type="application/ld+json">[
{"@context":"https://schema.org","@type":"Article","headline":${JSON.stringify(post.title)},"description":${JSON.stringify(post.meta_description)},"datePublished":"${pubDate}","dateModified":"${updDate}","wordCount":${post.word_count||1500},"inLanguage":"en-GB","author":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${S.url}","foundingDate":"${S.established}","founder":{"@type":"Person","name":"${S.founder}"},"sameAs":["https://www.checkatrade.com/trades/satfocussecuritysolutions"]},"publisher":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${S.url}","logo":{"@type":"ImageObject","url":"${S.logo}","width":1024,"height":350},"telephone":"${S.phone}","areaServed":[{"@type":"City","name":"London"},{"@type":"AdministrativeArea","name":"Greater London"}],"knowsAbout":["CCTV Installation","Intruder Alarms","Video Intercoms","Access Control","Security Systems"]},"mainEntityOfPage":{"@type":"WebPage","@id":"${S.url}/news/${post.slug}/"},"about":{"@type":"Service","serviceType":"${post.category || 'Security Systems Installation'}","provider":{"@type":"Organization","name":"SatFocus Security Solutions"},"areaServed":{"@type":"City","name":"London"}}},
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"${S.url}"},{"@type":"ListItem","position":2,"name":"News & Guides","item":"${S.url}/news/"},{"@type":"ListItem","position":3,"name":${JSON.stringify(post.title)}}]}${faqSchema}
]</script>

<style>
${sharedCSS()}

/* Hero */
.hero{background:var(--charcoal);padding:48px 0 40px;border-bottom:3px solid var(--red);position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;top:0;right:0;width:35%;height:100%;background:linear-gradient(135deg,transparent 60%,rgba(188,0,0,.04))}
.hero-inner{max-width:var(--max);margin:0 auto;padding:0 24px;position:relative}
.bc{font-size:12px;color:#666;margin-bottom:14px;letter-spacing:.2px}
.bc a{color:#888}.bc a:hover{color:var(--red)}.bc span{margin:0 5px;color:#444}
.hero h1{color:#f5f5f5;font-size:32px;font-weight:800;line-height:1.22;max-width:760px;letter-spacing:-.3px}
.hero-meta{margin-top:14px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.h-cat{background:var(--red);color:#fff;font-size:9px;font-weight:800;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:1.2px}
.h-date{color:#777;font-size:12px}
.h-read{color:#666;font-size:11px;background:rgba(255,255,255,.06);padding:2px 9px;border-radius:20px}
.h-updated{color:#666;font-size:11px;font-style:italic}

/* Layout */
.wrap{max-width:var(--max);margin:0 auto;padding:0 24px;display:grid;grid-template-columns:1fr 280px;gap:44px}

/* Article */
.art{padding:36px 0 44px}
.art h2{font-size:22px;color:var(--dark);margin:36px 0 14px;font-weight:800;line-height:1.3;letter-spacing:-.2px}
.art h3{font-size:18px;color:var(--text);margin:24px 0 10px;font-weight:700}
.art p{margin-bottom:16px;color:var(--text-mid)}
.art ul,.art ol{margin:0 0 18px 18px;color:var(--text-mid)}
.art li{margin-bottom:6px;padding-left:2px}
.art strong{color:var(--text)}
.art a{font-weight:600;text-decoration-line:underline;text-decoration-color:rgba(188,0,0,.25);text-underline-offset:2px;transition:text-decoration-color .15s}
.art a:hover{text-decoration-color:var(--red)}
.art table{width:100%;border-collapse:collapse;margin:20px 0;font-size:14px}
.art th{background:var(--charcoal);color:#fff;padding:10px 14px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.art td{padding:10px 14px;border-bottom:1px solid var(--border-light);color:var(--text-mid)}
.art tr:nth-child(even) td{background:var(--bg-alt)}

/* Takeaways */
.sf-takeaways{background:linear-gradient(135deg,#f4faf4,#f8fcf8);border-left:3px solid #2E7D32;border-radius:0 var(--radius) var(--radius) 0;padding:20px 24px;margin:24px 0 28px}
.sf-takeaways h3{font-size:12px;color:#2E7D32;margin-bottom:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px}
.sf-takeaways ul{margin:0;padding:0;list-style:none}
.sf-takeaways li{padding:5px 0 5px 22px;position:relative;font-size:14px;color:var(--text);line-height:1.6}
.sf-takeaways li::before{content:'✓';position:absolute;left:0;color:#2E7D32;font-weight:800;font-size:13px}

/* Authority */
.sf-authority{background:var(--bg-alt);border:1px solid var(--border);border-radius:var(--radius);padding:20px 24px;margin:28px 0}
.sf-authority h3{font-size:14px;color:var(--dark);margin-bottom:10px;font-weight:800}
.sf-authority ul{margin:0;padding:0;list-style:none}
.sf-authority li{padding:4px 0 4px 20px;position:relative;font-size:13px;color:var(--text-mid);line-height:1.6}
.sf-authority li::before{content:'★';position:absolute;left:0;color:var(--red);font-size:11px}

/* FAQ */
.faq{background:var(--bg-alt);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin:32px 0}
.faq h2{margin:0 0 4px;font-size:18px}
.faq-i{border-bottom:1px solid var(--border);padding:12px 0}
.faq-i:last-child{border-bottom:none;padding-bottom:0}
.faq-i h3{font-size:14px;margin:0 0 4px;color:var(--dark);font-weight:700}
.faq-i p{margin:0;font-size:13px;color:var(--text-mid);line-height:1.6}

/* CTA */
.cta{background:var(--charcoal);color:#fff;padding:32px;border-radius:var(--radius);margin:36px 0 0;text-align:center;position:relative;overflow:hidden}
.cta::after{content:'';position:absolute;top:0;right:0;width:25%;height:100%;background:linear-gradient(135deg,transparent 50%,rgba(188,0,0,.06))}
.cta h3{color:#f5f5f5;font-size:20px;margin:0 0 6px;font-weight:800;position:relative}
.cta>p{margin:0 0 18px;color:#aaa;font-size:14px;position:relative}
.cta-btn{display:inline-block;background:var(--red);color:#fff;padding:12px 28px;border-radius:6px;font-weight:800;font-size:14px;letter-spacing:.3px;box-shadow:0 3px 12px rgba(188,0,0,.25);transition:all .2s;position:relative}
.cta-btn:hover{background:#d40000;color:#fff;transform:translateY(-1px);box-shadow:0 5px 18px rgba(188,0,0,.35)}
.cta-sub{margin-top:10px;font-size:12px;color:#666;position:relative}
.cta-sub a{color:#ccc;font-weight:700}

/* Related */
.related{margin:28px 0 0;padding:20px 0 0;border-top:1px solid var(--border)}
.related h3{font-size:14px;margin-bottom:10px;font-weight:700;color:var(--text)}
.related ul{list-style:none;padding:0;margin:0}
.related li{padding:6px 0}
.related a{font-size:14px;font-weight:600}

/* Sidebar */
.side{padding:36px 0 44px}
.sb{background:var(--bg-alt);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.sb h3{font-size:13px;margin-bottom:12px;color:var(--dark);font-weight:800;text-transform:uppercase;letter-spacing:.5px}
.sb p{font-size:13px;color:var(--text-mid);line-height:1.6;margin-bottom:8px}
.sb-btn{display:block;background:var(--red);color:#fff;text-align:center;padding:10px;border-radius:6px;font-weight:800;font-size:13px;letter-spacing:.3px;box-shadow:0 2px 6px rgba(188,0,0,.2);transition:all .15s}
.sb-btn:hover{background:var(--red-dark);color:#fff;transform:translateY(-1px)}
.sb-dark{background:var(--charcoal);border-color:#333}
.sb-dark h3{color:#eee}
.sb-dark p{color:#aaa}
.svc{list-style:none;padding:0;margin:0}
.svc li{padding:7px 0;border-bottom:1px solid var(--border);font-size:12px}
.svc li:last-child{border-bottom:none}
.svc a{color:var(--text-mid);display:flex;align-items:center;gap:6px;font-weight:600;letter-spacing:.2px}
.svc a:hover{color:var(--red)}
.svc a::before{content:'›';color:var(--red);font-size:14px;font-weight:800;line-height:1}
.brands{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.brand{background:var(--bg);border:1px solid var(--border);padding:2px 8px;border-radius:3px;font-size:10px;color:var(--text-mid);font-weight:700;letter-spacing:.3px}

@media(max-width:960px){.wrap{grid-template-columns:1fr;gap:0}.side{padding:0 0 36px}.hero h1{font-size:26px}}
</style>
</head>
<body>
${headerHTML()}

<div class="hero"><div class="hero-inner">
<div class="bc"><a href="${L.home}">Home</a><span>›</span><a href="${L.news}">News</a><span>›</span>${esc(post.title)}</div>
<h1>${esc(post.title)}</h1>
<div class="hero-meta">
<span class="h-cat">${esc(post.category || 'Security')}</span>
<span class="h-date">${pubFmt}</span>
<span class="h-read">${mins} min read</span>
${updDate !== pubDate ? `<span class="h-updated">Updated ${updFmt}</span>` : ''}
</div>
</div></div>

<div class="wrap">
<article class="art">
${heroHtml}
${content}

<div class="cta">
<h3>Protect your property today</h3>
<p>Book a free, no-obligation security survey with our engineers across London.</p>
<a href="tel:02084227918" class="cta-btn">Call ${S.phone}</a>
<p class="cta-sub">or <a href="${L.contact}">request a callback online</a></p>
</div>
${relatedHTML}
</article>

<aside class="side">
<div class="sb sb-dark">
<h3>Free security survey</h3>
<p style="color:#bbb">Our engineers assess your property and recommend the best solution — no obligation.</p>
<a href="${L.contact}" class="sb-btn">Book free survey</a>
</div>
<div class="sb">
<h3>Our services</h3>
<ul class="svc">
<li><a href="${L.cctv}">CCTV Installation</a></li>
<li><a href="${L.alarms}">Intruder Alarms</a></li>
<li><a href="${L.intercom}">Video Intercoms</a></li>
<li><a href="${L.alarm_service}">Alarm Servicing</a></li>
<li><a href="${L.alarm_upgrade}">Alarm Upgrades</a></li>
<li><a href="${L.locations}">Service Areas</a></li>
</ul>
</div>
<div class="sb">
<h3>Brands we install</h3>
<div class="brands">
${['Texecom','Ajax','Hikvision','Dahua','Pyronix','Paxton','BPT','Videx','Comelit','Risco','Visonic'].map(b=>`<span class="brand">${b}</span>`).join('')}
</div>
</div>
<div class="sb">
<h3>Contact</h3>
<p style="margin:0;font-size:12px"><strong>Phone:</strong> <a href="tel:02084227918">${S.phone}</a><br><strong>Email:</strong> <a href="mailto:${S.email}">${S.email}</a></p>
</div>
</aside>
</div>

${footerHTML()}
</body>
</html>`;
}

function indexHTML() {
  const S = CONFIG.site;
  const L = CONFIG.links;
  const posts = db.prepare("SELECT * FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
  const cats = [...new Set(posts.map(p=>p.category).filter(Boolean))];
  const cc = {'CCTV':'#1565C0','Intruder Alarms':'#BC0000','Video Intercoms':'#2E7D32','Access Control':'#6A1B9A','General Security':'#D84315','Local':'#00838F','Seasonal':'#EF6C00'};

  const cards = posts.map(p => {
    const d = new Date(p.published_at*1000).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
    const m = Math.ceil((p.word_count||1500)/250);
    const c = cc[p.category]||'#BC0000';
    return `<a href="${S.url}/news/${p.slug}/" class="card"><div class="card-bar" style="background:${c}"></div><div class="card-body"><span class="card-cat" style="color:${c}">${esc(p.category)}</span><h2>${esc(p.title)}</h2><p>${esc(p.excerpt||'').substring(0,140)}</p><div class="card-ft"><span>${d}</span><span class="card-t">${m} min</span></div></div></a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Security News & Guides | SatFocus Security Solutions London</title>
<meta name="description" content="Expert security guides, CCTV tips, alarm system advice from SatFocus Security Solutions — London's trusted security installer since ${S.established}.">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">
<link rel="canonical" href="${S.url}/news/">
<script type="application/ld+json">[
{"@context":"https://schema.org","@type":"Blog","name":"SatFocus Security News & Guides","url":"${S.url}/news/","description":"Expert security guides from London's trusted installer","publisher":{"@type":"Organization","name":"SatFocus Security Solutions","url":"${S.url}","logo":{"@type":"ImageObject","url":"${S.logo}"},"telephone":"${S.phone}","foundingDate":"${S.established}","founder":{"@type":"Person","name":"${S.founder}"},"areaServed":{"@type":"City","name":"London"},"knowsAbout":["CCTV","Intruder Alarms","Video Intercoms","Access Control"]}},
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"${S.url}"},{"@type":"ListItem","position":2,"name":"News & Guides"}]}
]</script>
<style>
${sharedCSS()}
body{background:#f3f3f3}
.hero{background:var(--charcoal);padding:44px 0 36px;border-bottom:3px solid var(--red);text-align:center;position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:60%;height:100%;background:radial-gradient(ellipse,rgba(188,0,0,.03),transparent 70%)}
.hero h1{color:#f0f0f0;font-size:34px;font-weight:800;margin-bottom:8px;letter-spacing:-.3px;position:relative}
.hero p{color:#888;font-size:15px;max-width:520px;margin:0 auto;position:relative}
.hero-stats{display:flex;justify-content:center;gap:44px;margin-top:24px;position:relative}
.hero-stat{text-align:center}
.hero-stat strong{display:block;font-size:30px;color:var(--red);font-weight:900;line-height:1.1}
.hero-stat span{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1.2px;font-weight:600}
.pg{max-width:var(--max);margin:0 auto;padding:32px 24px 56px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:20px}
.card{display:flex;background:var(--bg);border-radius:var(--radius);overflow:hidden;color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.04);transition:all .25s;border:1px solid var(--border-light)}
.card:hover{box-shadow:0 8px 28px rgba(0,0,0,.08);transform:translateY(-3px);border-color:var(--border)}
.card-bar{width:4px;flex-shrink:0}
.card-body{padding:20px 22px;flex:1;display:flex;flex-direction:column}
.card-cat{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:6px}
.card h2{font-size:16px;line-height:1.35;margin-bottom:8px;font-weight:700;color:var(--dark)}
.card p{font-size:13px;color:var(--text-mid);flex:1;line-height:1.55;margin-bottom:12px}
.card-ft{display:flex;justify-content:space-between;font-size:11px;color:var(--text-light);padding-top:10px;border-top:1px solid var(--border-light)}
.card-t{background:var(--bg-alt);padding:1px 7px;border-radius:10px;font-weight:600}
@media(max-width:960px){.grid{grid-template-columns:1fr}.hero h1{font-size:26px}.hero-stats{gap:24px}}
</style>
</head>
<body>
${headerHTML()}
<div class="hero">
<h1>Security news & guides</h1>
<p>Expert advice from London's Checkatrade & Which Trusted Trader approved security installer.</p>
<div class="hero-stats">
<div class="hero-stat"><strong>${posts.length}</strong><span>Articles</span></div>
<div class="hero-stat"><strong>${cats.length}</strong><span>Topics</span></div>
<div class="hero-stat"><strong>${S.installs}</strong><span>Installs</span></div>
</div>
</div>
<div class="pg"><div class="grid">${cards}</div></div>
${footerHTML()}
</body>
</html>`;
}

function sitemapXML() {
  const posts = db.prepare("SELECT slug,published_at,updated_at FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
  const today = new Date().toISOString().split('T')[0];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += `  <url><loc>${CONFIG.site.url}/news/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  posts.forEach(p => {
    const d = new Date((p.updated_at||p.published_at)*1000).toISOString().split('T')[0];
    xml += `  <url><loc>${CONFIG.site.url}/news/${p.slug}/</loc><lastmod>${d}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n`;
  });
  return xml + '</urlset>';
}

// ═══════════════════════════════════════════════════════════════════════
// FILE GENERATION & UPLOAD
// ═══════════════════════════════════════════════════════════════════════

function generateAllHTML() {
  const posts = db.prepare("SELECT * FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
  
  posts.forEach(p => {
    fs.writeFileSync(path.join(CONFIG.output, p.slug + '.html'), postHTML(p), 'utf8');
    console.log(`  ✅ ${p.title}`);
  });

  fs.writeFileSync(path.join(CONFIG.output, 'index.html'), indexHTML(), 'utf8');
  console.log('\n  ✅ Index page');

  fs.writeFileSync(path.join(CONFIG.output, 'news-sitemap.xml'), sitemapXML(), 'utf8');
  console.log('  ✅ Sitemap');

  fs.writeFileSync(path.join(CONFIG.output, '.htaccess'), 
    'RewriteEngine On\nRewriteBase /news/\nRewriteCond %{REQUEST_FILENAME} -d\nRewriteRule ^(.+[^/])$ /news/$1/ [R=301,L]\nRewriteCond %{REQUEST_FILENAME} -f\nRewriteRule ^ - [L]\nRewriteCond %{REQUEST_FILENAME} -d\nRewriteRule ^ - [L]\n', 'utf8');

  return posts;
}

function upload() {
  const { host, port, user, key, remote } = CONFIG.sftp;
  const sshBase = `ssh -p ${port} -i ${key} -o StrictHostKeyChecking=no ${user}@${host}`;
  
  console.log('\n📤 Uploading to Krystal...');
  try {
    execSync(`${sshBase} "mkdir -p ${remote}"`, { stdio: 'pipe' });
    
    const posts = db.prepare("SELECT slug FROM sf_blog_posts WHERE status='published'").all();
    for (const p of posts) {
      execSync(`${sshBase} "mkdir -p ${remote}/${p.slug}"`, { stdio: 'pipe' });
    }

    let batch = `put ${CONFIG.output}/index.html ${remote}/index.html\n`;
    batch += `put ${CONFIG.output}/news-sitemap.xml ${remote}/news-sitemap.xml\n`;
    batch += `put ${CONFIG.output}/.htaccess ${remote}/.htaccess\n`;
    
    const htmlFiles = fs.readdirSync(CONFIG.output).filter(f => f.endsWith('.html') && f !== 'index.html');
    for (const f of htmlFiles) {
      const slug = f.replace('.html', '');
      batch += `put ${CONFIG.output}/${f} ${remote}/${slug}/index.html\n`;
    }

    fs.writeFileSync(path.join(CONFIG.output, 'sftp-batch.txt'), batch);
    execSync(`sftp -P ${port} -i ${key} -o StrictHostKeyChecking=no -b ${CONFIG.output}/sftp-batch.txt ${user}@${host}`, { stdio: 'pipe' });

    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE sf_blog_posts SET uploaded_at=? WHERE status='published'").run(now);
    
    
    // Upload images directory
    const imagesDir = path.join(CONFIG.output, 'images');
    if (fs.existsSync(imagesDir)) {
      execSync(`${sshBase} "mkdir -p ${remote}/images"`, { stdio: 'pipe' });
      const imageFiles = fs.readdirSync(imagesDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      if (imageFiles.length > 0) {
        let imgBatch = '';
        for (const img of imageFiles) {
          imgBatch += `put ${imagesDir}/${img} ${remote}/images/${img}\n`;
        }
        fs.writeFileSync(path.join(CONFIG.output, 'sftp-img-batch.txt'), imgBatch);
        execSync(`sftp -P ${port} -i ${key} -o StrictHostKeyChecking=no -b ${CONFIG.output}/sftp-img-batch.txt ${user}@${host}`, { stdio: 'pipe' });
        console.log(`  ✅ Uploaded ${imageFiles.length} images`);
      }
    }

    console.log('  ✅ All files uploaded');
  } catch(e) {
    console.error('  ❌ Upload failed:', e.message);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  initDB();
  seedTopics();

  if (args.includes('--list')) {
    const pending = db.prepare("SELECT * FROM sf_blog_topics WHERE status='pending' ORDER BY priority DESC").all();
    const used = db.prepare("SELECT * FROM sf_blog_topics WHERE status='used' ORDER BY used_at DESC").all();
    const posts = db.prepare("SELECT title,slug,published_at,word_count FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC").all();
    console.log(`\n📋 Pending: ${pending.length}`);
    pending.forEach((t,i) => console.log(`  ${String(i+1).padStart(3)}. [P${t.priority}] ${t.category}: ${t.keyword}`));
    console.log(`\n✅ Published: ${posts.length}`);
    posts.forEach((p,i) => console.log(`  ${i+1}. ${p.title} (${p.word_count}w) → /news/${p.slug}/`));
    console.log(`\n🔄 Used topics: ${used.length}`);
    return;
  }

  if (args.includes('--rewrite')) {
    const posts = db.prepare("SELECT * FROM sf_blog_posts WHERE status='published' ORDER BY published_at ASC").all();
    console.log(`\n✍️  Rewriting ${posts.length} posts with AEO/GEO prompt...\n`);
    for (const p of posts) {
      try {
        await rewritePost(p);
        await new Promise(r => setTimeout(r, 2000));
      } catch(e) { console.error(`  ❌ ${p.keyword}: ${e.message}`); }
    }
    console.log('\n📄 Generating HTML...\n');
    generateAllHTML();
    if (!args.includes('--preview')) { upload(); }
    console.log(`\n🎉 Done! → ${CONFIG.site.url}/news/`);
    return;
  }

  if (args.includes('--rewrite-one')) {
    const post = db.prepare("SELECT * FROM sf_blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 1").get();
    if (post) {
      console.log('\n✍️  Rewriting most recent post...\n');
      await rewritePost(post);
      console.log('\n📄 Generating HTML...\n');
      generateAllHTML();
      if (!args.includes('--preview')) { upload(); }
      console.log(`\n🎉 Done! → ${CONFIG.site.url}/news/${post.slug}/`);
    }
    return;
  }

  if (args.includes('--regen')) {
    console.log('\n📄 Regenerating HTML (no API calls)...\n');
    generateAllHTML();
    if (!args.includes('--preview')) { upload(); }
    console.log(`\n✅ Done! → ${CONFIG.site.url}/news/`);
    return;
  }

  if (args.includes('--init')) {
    console.log('✅ Database initialised');
    return;
  }

  // --force-ha: Generate ALL pending HA postcode posts
  if (args.includes('--force-ha')) {
    const haTopics = db.prepare("SELECT * FROM sf_blog_topics WHERE status='pending' AND postcode IS NOT NULL ORDER BY postcode ASC, priority DESC").all();
    if (haTopics.length === 0) {
      console.log('\nNo pending HA postcode topics. All done!');
      return;
    }
    console.log(`\n📍 Generating ${haTopics.length} HA postcode posts...\n`);
    
    for (const topic of haTopics) {
      console.log(`\n━━━ [${topic.postcode}] ${topic.area_name}: ${topic.keyword} ━━━`);
      try {
        const post = await generatePost(topic);
        const id = uuidv4();
        const slug = slugify(post.title);
        const now = Math.floor(Date.now() / 1000);
        
        db.prepare("INSERT INTO sf_blog_posts (id,slug,title,meta_description,content,excerpt,keyword,category,word_count,faq_json,status,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          id, slug, post.title, post.meta_description, post.content, post.excerpt,
          topic.keyword, topic.category, post.word_count || 1600,
          JSON.stringify(post.faq || []), 'published', now, now, now
        );
        
        let heroResult = null;
        let stockPhotos = [];
        try {
          heroResult = await generateHeroImage(post.title, topic.keyword, topic.category);
          stockPhotos = await fetchStockPhotos(topic.keyword, topic.category, 2);
        } catch(imgErr) {
          console.log('  ⚠️  Image error:', imgErr.message);
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
        console.log(`  ✅ Published: ${post.title}`);
        await new Promise(r => setTimeout(r, 5000));
        
      } catch(e) {
        console.log(`  ❌ ${topic.keyword}: ${e.message}`);
      }
    }
    
    generateAllHTML();
    if (!args.includes('--preview')) {
      upload();
    }
    console.log(`\n🎉 HA postcode batch complete! → https://www.satfocussecurity.co.uk/news/`);
    return;
  }

  // Default: generate next post
  const preview = args.includes('--preview');
  const force = args.includes('--force');
  const result = await publishNext(force);
  
  if (result) {
    console.log('\n📄 Generating HTML...\n');
    generateAllHTML();
    if (!preview) {
      upload();
      console.log(`\n🎉 Live: ${CONFIG.site.url}/news/${result.slug}/`);
    } else {
      console.log(`\n👀 Preview: ${CONFIG.output}/${result.slug}.html`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
