const https = require('https');

// IMPORTANT: Replace this with your actual key
const API_KEY = process.env.ANTHROPIC_API_KEY || 'your-key-here';

const data = JSON.stringify({
  model: 'claude-3-5-sonnet-20240620',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'Hello' }]
});

const options = {
  hostname: 'api.anthropic.com',
  port: 443,
  path: '/v1/messages',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Length': data.length
  }
};

console.log(`Testing key: ${API_KEY.substring(0, 12)}...`);

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (d) => body += d);
  res.on('end', () => {
    console.log(`Status Code: ${res.statusCode}`);
    console.log('Response Headers:', JSON.stringify(res.headers, null, 2));
    console.log('Response Body:', body);
    
    if (res.statusCode === 401) {
      console.error('\n--- AUTHENTICATION FAILED ---');
      if (API_KEY.startsWith('sk-ant-oat')) {
        console.error('ERROR: You are using an OAuth/Subscription token.');
        console.error('FIX: Go to console.anthropic.com and create a real API Key (sk-ant-api03).');
      }
    }
  });
});

req.on('error', (e) => console.error(e));
req.write(data);
req.end();
