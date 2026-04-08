const db = require('better-sqlite3')('./ringdesk.db');
const fs = require('fs');
const path = require('path');

console.log('🔄 Starting pricing rebuild...');

// Get plans from DB
const plans = JSON.parse(db.prepare("SELECT value FROM system_settings WHERE key='pricing_plans'").get().value);

// Build the pricing HTML block
function buildPricingHTML(plans) {
  return '<div class="plans">' + plans.map(function(plan) {
    const isPopular = plan.is_popular;
    const limit = plan.call_limit >= 1000 ? plan.call_limit.toLocaleString() : plan.call_limit;
    const annualPrice = plan.price_annual || Math.round(plan.price_monthly * 0.83);
    const isEssential = plan.id === 'essential';
    const ctaClass = (isEssential || isPopular) ? 'pcta pcta-p' : 'pcta pcta-g';
    const ctaText = (isEssential || isPopular) ? 'Start free trial &rarr;' : 'Get started &rarr;';
    const ctaOnclick = isEssential ? "openModal('essential')" : isPopular ? "openModal('professional')" : "location.href='/dashboard'";

    return (isPopular ? '<div class="plan pop"><div class="plan-badge">MOST POPULAR</div>' : '<div class="plan">') +
      '<div class="plan-name">' + plan.name + '</div>' +
      '<div class="plan-price"><sup>£</sup><span class="price-val" data-monthly="' + plan.price_monthly + '" data-annual="' + annualPrice + '">' + plan.price_monthly + '</span><sub>/mo</sub></div>' +
      '<div style="font-size:11px;color:var(--dim);margin-bottom:12px;min-height:16px">+ VAT</div>' +
      '<div class="plan-calls">' + limit + ' calls per month<div style="font-size:10px;color:var(--dim);margin-top:3px">Inbound calls, any duration</div></div>' +
      '<div class="plan-feats">' + (plan.features || []).map(function(f) {
        return '<div class="pf"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#00e87a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' + f + '</div>';
      }).join('') + '</div>' +
      '<button onclick="' + ctaOnclick + '" class="' + ctaClass + '">' + ctaText + '</button>' +
      '</div>';
  }).join('') + '</div>';
}

const newPricingHTML = buildPricingHTML(plans);

// Find and replace in all HTML files
function updateFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    const start = content.indexOf('<div class="plans">');
    if (start === -1) return false;
    const end = content.indexOf('</div>', content.lastIndexOf('<button', start + newPricingHTML.length)) + 6;
    if (end <= start) return false;
    const newContent = content.substring(0, start) + newPricingHTML + content.substring(end);
    fs.writeFileSync(filePath, newContent);
    return true;
  } catch(e) {
    return false;
  }
}

// Walk directories
function walkDir(dir) {
  let count = 0;
  const files = fs.readdirSync(dir);
  files.forEach(function(file) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      count += walkDir(fullPath);
    } else if (file.endsWith('.html')) {
      if (updateFile(fullPath)) count++;
    }
  });
  return count;
}

const publicDir = path.join(__dirname, 'public');
const dirs = ['industries', 'locations'];
let total = 0;
dirs.forEach(function(d) {
  const count = walkDir(path.join(publicDir, d));
  console.log('✅ Updated ' + count + ' files in ' + d);
  total += count;
});

// Also update homepage
if (updateFile(path.join(publicDir, 'index.html'))) {
  console.log('✅ Updated homepage');
  total++;
}

console.log('🎉 Total files updated: ' + total);
