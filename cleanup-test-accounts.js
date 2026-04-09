require('dotenv').config();
const db = require('better-sqlite3')('/var/www/vhosts/airingdesk.com/httpdocs/ringdesk.db');

// Get Twilio creds from PM2 env
const { execSync } = require('child_process');
let twilioSid, twilioAuth;
try {
  const env = execSync('pm2 env 1').toString();
  twilioSid = env.match(/TWILIO_ACCOUNT_SID:\s*'?([^'\n]+)/)?.[1]?.trim();
  twilioAuth = env.match(/TWILIO_AUTH_TOKEN:\s*'?([^'\n]+)/)?.[1]?.trim();
} catch(e) {}

const twilio = require('twilio')(twilioSid, twilioAuth);

const testEmails = [
  'info@webonmaster.com',
  'raksha23@hotmail.co.uk',
  'devthines@gmail.com',
  'satfocusuk@gmail.com',
  'satfocusuk+test2@gmail.com',
  'vtvibish197@gmail.com'
];

(async () => {
  for (const email of testEmails) {
    const client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
    if (!client) { console.log('Not found:', email); continue; }

    // Release Twilio number if assigned
    if (client.phone_number) {
      try {
        const numbers = await twilio.incomingPhoneNumbers.list({ phoneNumber: client.phone_number });
        if (numbers.length > 0) {
          await twilio.incomingPhoneNumbers(numbers[0].sid).remove();
          console.log('Released number:', client.phone_number, 'for', client.business_name);
        } else {
          console.log('No Twilio number found for:', client.phone_number);
        }
      } catch(e) {
        console.log('Could not release number for', client.business_name, ':', e.message);
      }
    }

    // Delete all related records
    db.prepare('DELETE FROM call_sessions WHERE client_id = ?').run(client.id);
    db.prepare('DELETE FROM calls WHERE client_id = ?').run(client.id);
    db.prepare('DELETE FROM appointments WHERE client_id = ?').run(client.id);
    db.prepare('DELETE FROM number_assignments WHERE client_id = ?').run(client.id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
    console.log('Deleted account:', client.business_name, '(' + client.email + ')');
  }
  console.log('Done — all test accounts cleaned up');
})();
