#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════
 * SatFocus Blog v3 — Add HA Postcode Topics
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * Adds postcode-targeted topics for HA0–HA9 to sf_blog_topics.
 * Each postcode gets 2–3 topics targeting local search terms.
 * 
 * Run once:
 *   cd /var/www/vhosts/airingdesk.com/httpdocs/satfocus-blog
 *   node add-ha-postcode-topics.js
 * 
 * @version 1.0.0
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'satfocus-blog.db');
const db = new Database(DB_PATH);

// ── HA Postcode Topics ──────────────────────────────────────────────────────────
const HA_TOPICS = [
  // HA0 — Wembley
  { keyword: 'CCTV installation HA0 Wembley', title_hint: 'CCTV Installation in Wembley HA0 — Professional Security Cameras for Homes and Businesses', category: 'CCTV', priority: 9, postcode: 'HA0', area_name: 'Wembley' },
  { keyword: 'burglar alarm installer HA0 Wembley', title_hint: 'Burglar Alarm Installation in Wembley HA0 — Trusted Local Security Experts', category: 'Intruder Alarms', priority: 9, postcode: 'HA0', area_name: 'Wembley' },
  { keyword: 'security systems HA0 Wembley', title_hint: 'Security Systems in Wembley HA0 — Complete Home and Business Protection', category: 'General Security', priority: 8, postcode: 'HA0', area_name: 'Wembley' },

  // HA1 — Harrow
  { keyword: 'CCTV installation HA1 Harrow', title_hint: 'CCTV Installation in Harrow HA1 — Local Security Camera Experts', category: 'CCTV', priority: 10, postcode: 'HA1', area_name: 'Harrow' },
  { keyword: 'burglar alarm installer HA1 Harrow', title_hint: 'Burglar Alarm Installation in Harrow HA1 — Your Local Alarm Company', category: 'Intruder Alarms', priority: 10, postcode: 'HA1', area_name: 'Harrow' },
  { keyword: 'intercom systems HA1 Harrow', title_hint: 'Video Intercom Systems in Harrow HA1 — Door Entry for Flats and Houses', category: 'Intercoms', priority: 8, postcode: 'HA1', area_name: 'Harrow' },

  // HA2 — Harrow Weald
  { keyword: 'CCTV installation HA2 Harrow Weald', title_hint: 'CCTV Installation in Harrow Weald HA2 — Protecting Your Property', category: 'CCTV', priority: 8, postcode: 'HA2', area_name: 'Harrow Weald' },
  { keyword: 'burglar alarm installer HA2 Harrow Weald', title_hint: 'Burglar Alarm Installation in Harrow Weald HA2 — Expert Alarm Fitters', category: 'Intruder Alarms', priority: 8, postcode: 'HA2', area_name: 'Harrow Weald' },

  // HA3 — Kenton
  { keyword: 'CCTV installation HA3 Kenton', title_hint: 'CCTV Installation in Kenton HA3 — Professional Security Cameras Near You', category: 'CCTV', priority: 8, postcode: 'HA3', area_name: 'Kenton' },
  { keyword: 'burglar alarm installer HA3 Kenton', title_hint: 'Burglar Alarm Installation in Kenton HA3 — Local Security Experts', category: 'Intruder Alarms', priority: 8, postcode: 'HA3', area_name: 'Kenton' },
  { keyword: 'access control HA3 Kenton', title_hint: 'Access Control Systems in Kenton HA3 — Secure Your Business Premises', category: 'Access Control', priority: 7, postcode: 'HA3', area_name: 'Kenton' },

  // HA4 — Ruislip
  { keyword: 'CCTV installation HA4 Ruislip', title_hint: 'CCTV Installation in Ruislip HA4 — Home and Business Security Cameras', category: 'CCTV', priority: 8, postcode: 'HA4', area_name: 'Ruislip' },
  { keyword: 'burglar alarm installer HA4 Ruislip', title_hint: 'Burglar Alarm Installation in Ruislip HA4 — Wired and Wireless Systems', category: 'Intruder Alarms', priority: 8, postcode: 'HA4', area_name: 'Ruislip' },
  { keyword: 'security systems HA4 Ruislip', title_hint: 'Security Systems in Ruislip HA4 — CCTV, Alarms, and Access Control', category: 'General Security', priority: 7, postcode: 'HA4', area_name: 'Ruislip' },

  // HA5 — Pinner
  { keyword: 'CCTV installation HA5 Pinner', title_hint: 'CCTV Installation in Pinner HA5 — Trusted Local Security Installers', category: 'CCTV', priority: 8, postcode: 'HA5', area_name: 'Pinner' },
  { keyword: 'burglar alarm installer HA5 Pinner', title_hint: 'Burglar Alarm Installation in Pinner HA5 — Protecting Period and Modern Homes', category: 'Intruder Alarms', priority: 8, postcode: 'HA5', area_name: 'Pinner' },
  { keyword: 'security systems HA5 Pinner', title_hint: 'Security Systems in Pinner HA5 — Complete Property Protection', category: 'General Security', priority: 7, postcode: 'HA5', area_name: 'Pinner' },

  // HA6 — Northwood
  { keyword: 'CCTV installation HA6 Northwood', title_hint: 'CCTV Installation in Northwood HA6 — High-End Security for Premium Properties', category: 'CCTV', priority: 8, postcode: 'HA6', area_name: 'Northwood' },
  { keyword: 'burglar alarm installer HA6 Northwood', title_hint: 'Burglar Alarm Installation in Northwood HA6 — Grade 2 Alarm Systems', category: 'Intruder Alarms', priority: 8, postcode: 'HA6', area_name: 'Northwood' },

  // HA7 — Stanmore
  { keyword: 'CCTV installation HA7 Stanmore', title_hint: 'CCTV Installation in Stanmore HA7 — Professional Security Camera Systems', category: 'CCTV', priority: 8, postcode: 'HA7', area_name: 'Stanmore' },
  { keyword: 'burglar alarm installer HA7 Stanmore', title_hint: 'Burglar Alarm Installation in Stanmore HA7 — Expert Security for Your Home', category: 'Intruder Alarms', priority: 8, postcode: 'HA7', area_name: 'Stanmore' },
  { keyword: 'intercom systems HA7 Stanmore', title_hint: 'Video Intercom Systems in Stanmore HA7 — Door Entry Solutions', category: 'Intercoms', priority: 7, postcode: 'HA7', area_name: 'Stanmore' },

  // HA8 — Edgware
  { keyword: 'CCTV installation HA8 Edgware', title_hint: 'CCTV Installation in Edgware HA8 — Local Security Camera Installers', category: 'CCTV', priority: 8, postcode: 'HA8', area_name: 'Edgware' },
  { keyword: 'burglar alarm installer HA8 Edgware', title_hint: 'Burglar Alarm Installation in Edgware HA8 — Trusted Alarm Company Near You', category: 'Intruder Alarms', priority: 8, postcode: 'HA8', area_name: 'Edgware' },
  { keyword: 'access control HA8 Edgware', title_hint: 'Access Control Systems in Edgware HA8 — Business Security Solutions', category: 'Access Control', priority: 7, postcode: 'HA8', area_name: 'Edgware' },

  // HA9 — Wembley (Park Royal / North Wembley)
  { keyword: 'CCTV installation HA9 Wembley', title_hint: 'CCTV Installation in North Wembley HA9 — Security Cameras for Every Property', category: 'CCTV', priority: 8, postcode: 'HA9', area_name: 'Wembley' },
  { keyword: 'burglar alarm installer HA9 Wembley', title_hint: 'Burglar Alarm Installation in North Wembley HA9 — Same-Week Fitting Available', category: 'Intruder Alarms', priority: 8, postcode: 'HA9', area_name: 'Wembley' },
  { keyword: 'commercial security HA9 Wembley', title_hint: 'Commercial Security Systems in Wembley HA9 — CCTV, Alarms, and Access Control for Businesses', category: 'General Security', priority: 7, postcode: 'HA9', area_name: 'Wembley' },
];

// ── Check for existing postcode/area columns, add if missing ────────────────
try {
  db.exec("ALTER TABLE sf_blog_topics ADD COLUMN postcode TEXT");
  console.log('✅ Added postcode column');
} catch(e) {
  if (!e.message.includes('duplicate column')) throw e;
  console.log('ℹ️  postcode column already exists');
}

try {
  db.exec("ALTER TABLE sf_blog_topics ADD COLUMN area_name TEXT");
  console.log('✅ Added area_name column');
} catch(e) {
  if (!e.message.includes('duplicate column')) throw e;
  console.log('ℹ️  area_name column already exists');
}

// ── Insert topics (skip duplicates by keyword) ──────────────────────────────
const insert = db.prepare(`
  INSERT OR IGNORE INTO sf_blog_topics (keyword, title_hint, category, priority, status, postcode, area_name)
  VALUES (@keyword, @title_hint, @category, @priority, 'pending', @postcode, @area_name)
`);

const insertMany = db.transaction((topics) => {
  let added = 0;
  for (const t of topics) {
    const result = insert.run(t);
    if (result.changes > 0) added++;
  }
  return added;
});

const added = insertMany(HA_TOPICS);
const total = db.prepare('SELECT COUNT(*) as c FROM sf_blog_topics').get().c;
const pending = db.prepare("SELECT COUNT(*) as c FROM sf_blog_topics WHERE status='pending'").get().c;
const ha = db.prepare("SELECT COUNT(*) as c FROM sf_blog_topics WHERE postcode IS NOT NULL").get().c;

console.log(`\n═══ HA Postcode Topics Added ═══`);
console.log(`  ✅ Added: ${added} new topics`);
console.log(`  📊 Total topics: ${total}`);
console.log(`  ⏳ Pending: ${pending}`);
console.log(`  📍 HA postcode topics: ${ha}`);
console.log(`\nPostcodes covered: HA0 (Wembley), HA1 (Harrow), HA2 (Harrow Weald),`);
console.log(`  HA3 (Kenton), HA4 (Ruislip), HA5 (Pinner), HA6 (Northwood),`);
console.log(`  HA7 (Stanmore), HA8 (Edgware), HA9 (Wembley/Park Royal)`);

db.close();
