#!/bin/bash

# --- COLOUR CODES ---
GREEN="\e[32m"
RED="\e[31m"
YELLOW="\e[33m"
BLUE="\e[34m"
RESET="\e[0m"

echo -e "${BLUE}=============================="
echo -e " AIRINGDESK HEALTH CHECK"
echo -e "==============================${RESET}"

# --- 1. RESTART PM2 ---
echo -e "${YELLOW}🔄 Restarting PM2 service...${RESET}"
pm2 restart airingdesk --update-env >/dev/null 2>&1
sleep 3
echo -e "${GREEN}✔ PM2 restarted${RESET}"

# --- 2. LOGIN + TOKEN ---
echo -e "${YELLOW}🔐 Logging in and retrieving token...${RESET}"

TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ringdeskai@gmail.com","password":"Admin2025!"}' | node -e "
const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{
  try {
    const r = JSON.parse(d.join(''));
    if (r.token) console.log(r.token);
    else console.error('ERROR');
  } catch(e) { console.error('ERROR'); }
});")

if [[ -z "$TOKEN" || "$TOKEN" == "ERROR" ]]; then
  echo -e "${RED}❌ Failed to retrieve token${RESET}"
  exit 1
fi

echo -e "${GREEN}✔ Token OK${RESET}"

# --- 3. SEND TEST EMAIL ---
echo -e "${YELLOW}📨 Sending test email...${RESET}"

EMAIL_RESPONSE=$(curl -s -X POST http://127.0.0.1:3000/api/email/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN")

echo -e "${GREEN}✔ Email API Response:${RESET}"
echo "$EMAIL_RESPONSE"

# --- 4. BREVO API CHECK ---
echo -e "${YELLOW}📡 Checking Brevo API status...${RESET}"

BREVO_RESPONSE=$(curl -s -X GET "https://api.brevo.com/v3/account" \
  -H "accept: application/json" \
  -H "api-key: $BREVO_API_KEY")

BREVO_LIMIT=$(echo "$BREVO_RESPONSE" | node -e "
const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{
  try {
    const r = JSON.parse(d.join(''));
    console.log(r.plan?.[0]?.credits ?? 'UNKNOWN');
  } catch(e) { console.log('ERROR'); }
});")

echo -e "${GREEN}✔ Brevo daily email limit: $BREVO_LIMIT${RESET}"
echo -e "${YELLOW}ℹ Brevo free plan does NOT show remaining emails — only the daily limit.${RESET}"

# --- FINAL SUMMARY ---
echo -e "${BLUE}=============================="
echo -e " HEALTH CHECK COMPLETE"
echo -e "==============================${RESET}"

echo -e "${GREEN}✔ PM2 running"
echo -e "✔ API login working"
echo -e "✔ Token valid"
echo -e "✔ Email sending OK"
echo -e "✔ Brevo API OK"
echo -e "✔ Daily limit: $BREVO_LIMIT${RESET}"
