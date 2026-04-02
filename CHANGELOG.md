# AiRingDesk Changelog

## [3.0.0] - 2026-04-02

### Changes
- Major change description

---


## [2.7.0] - 2026-04-02

### Changes
- Feature description

---


## [2.6.1] - 2026-04-02

### Changes
- Fix description

---


All notable changes to AiRingDesk are documented here.
Format: [Version] - Date - Description

---

## [2.6.0] - 2026-04-02

### New Features
- GoCardless Direct Debit billing integration (AiRingDesk account, Revolut payout)
- GoCardless webhook handler — auto invoice creation on payment
- Dashboard billing page — Direct Debit status card, mandate display
- SMS logs — View button with full message modal
- Email mailboxes — hello, billing, support, info, contact, admin @airingdesk.com
- SSL certificate for mail.airingdesk.com (Let's Encrypt)

### SEO & Content
- 1,960 location+industry pages — unique FAQ sections with AEO/GEO schema markup
- Homepage 2026 SEO — Speakable, HowTo, Service schema, 17 FAQ questions
- robots meta tags added to homepage
- Lighthouse scores: 98/95/96/100 (Performance/Accessibility/Best Practices/SEO)
- Cache headers added to static assets

### VAT Compliance
- + VAT added to all 2,557 location pages
- + VAT added to all 2,459 location+industry combo pages
- VAT breakdown (Net + VAT 20% + Total) added to invoice PDF
- VAT columns added to dashboard invoice history table
- VAT No: GB 321211372 in all page footers

### Bug Fixes
- Appointment save bug fixed — calendar.events.insert result now captured
- SMS modal JS syntax error fixed — was breaking dashboard login
- www → non-www 301 redirect fixed
- brand.css 404 fixed
- Support footer link fixed

### Infrastructure
- GoCardless SDK installed (gocardless-nodejs)
- Certbot installed, Let's Encrypt SSL for mail.airingdesk.com
- Mail ports opened (993, 587, 465, 143)
- Dovecot SSL configured with Let's Encrypt cert
- Sitemap lastmod dates updated

---

## [2.5.9] - 2026-03-28

### Features
- PWA manifest.json
- OG image 1200x630
- Apple/mobile meta tags
- Font preconnect and deferred loading
- Mobile responsive fixes
- Accessibility contrast fixes
- aria-labels added to ROI inputs
- DMARC DNS record added
- Schema markup upgraded (LocalBusiness, BreadcrumbList, WebSite, Speakable, FAQ)
- Lighthouse score improved 85 → 90+

---

## [2.5.0] - 2026-03-15

### Features
- SMS notifications (missed call, voicemail, after call, appointment)
- Call recording support
- Voicemail with transcription
- Referral programme
- Google Calendar integration
- Lead tracker
- Admin dashboard

---

## [2.0.0] - 2026-02-01

### Features
- AI receptionist with Claude AI
- Call transfers to departments
- Appointment booking
- Email notifications
- UK phone number provisioning
- Trial plan system
- Stripe billing integration

---

## [1.0.0] - 2024-12-01

### Initial Release
- Basic AI call answering
- Message taking
- Email notifications
- UK phone numbers via Twilio
