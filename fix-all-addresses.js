process.chdir('/var/www/vhosts/airingdesk.com/httpdocs');
const fs = require('fs');
const path = require('path');

let updated = 0;
let skipped = 0;
let errors = 0;

const newAddress = '124 City Road, London, EC1V 2NX';

// Patterns to find and replace across all page types
const replacements = [
  // Pattern 1: SatFocus Ltd without address (most common in location/industry combo pages)
  ['© 2026 AiRingDesk, a trading name of SatFocus Ltd.', '© 2026 AiRingDesk · SatFocus Ltd · 124 City Road, London, EC1V 2NX'],
  ['© 2026 AiRingDesk, a trading name of SatFocus Ltd', '© 2026 AiRingDesk · SatFocus Ltd · 124 City Road, London, EC1V 2NX'],
  ['© 2025 AiRingDesk, a trading name of SatFocus Ltd.', '© 2026 AiRingDesk · SatFocus Ltd · 124 City Road, London, EC1V 2NX'],
  ['© 2025 AiRingDesk, a trading name of SatFocus Ltd', '© 2026 AiRingDesk · SatFocus Ltd · 124 City Road, London, EC1V 2NX'],
];

function processDir(dirPath) {
  const items = fs.readdirSync(dirPath);
  items.forEach(item => {
    const fullPath = path.join(dirPath, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      processDir(fullPath);
    } else if (item.endsWith('.html') && !item.includes('.bak')) {
      try {
        let content = fs.readFileSync(fullPath, 'utf8');
        // Skip if already has address
        if (content.includes('City Road')) { skipped++; return; }
        let changed = false;
        replacements.forEach(([oldStr, newStr]) => {
          if (content.includes(oldStr)) {
            content = content.split(oldStr).join(newStr);
            changed = true;
          }
        });
        if (changed) {
          fs.writeFileSync(fullPath, content);
          updated++;
          if (updated % 100 === 0) console.log('Progress:', updated, 'updated...');
        }
      } catch(e) {
        errors++;
      }
    }
  });
}

console.log('Starting address update across all pages...');
processDir('./public');

console.log('\n✅ Complete!');
console.log('Updated:', updated, 'pages');
console.log('Already had address:', skipped, 'pages');
console.log('Errors:', errors);
