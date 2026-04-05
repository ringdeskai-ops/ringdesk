#!/usr/bin/env python3
import os, re, json, sys, time, argparse

PUBLIC_DIR = '/var/www/vhosts/airingdesk.com/httpdocs/public'
SKIP_PATHS = ['dashboard','admin','index.html','index.html.bak','index.html.bak2','index.html.bak3','about.html','contact.html','privacy.html','support.html','terms.html','intellectual-property.html']

def load_plans(p):
    with open(p) as f: return json.load(f)

def starting_price(plans):
    active = [p for p in plans if p.get('is_active',1)]
    return min(p['price_monthly'] for p in active) if active else 29

def build_plans_block(plans):
    active = [p for p in plans if p.get('is_active',1)]
    cards = []
    for plan in active:
        price = plan['price_monthly']
        calls = f"{plan['call_limit']:,}" if plan['call_limit']>=1000 else str(plan['call_limit'])
        pop = ' pop' if plan.get('is_popular') else ''
        badge = '<div class="plan-badge">MOST POPULAR</div>' if plan.get('is_popular') else ''
        cards.append(f'<div class="plan{pop}">{badge}<div class="plan-name">{plan["name"]}</div><div class="plan-price"><sup style="font-size:18px">£</sup>{price}<sub style="font-size:14px;color:var(--muted)">/mo</sub><div style="font-size:10px;color:var(--muted);margin-bottom:4px">+ VAT</div></div><div class="plan-calls">{calls} calls/month</div><a href="/dashboard" class="plan-btn">Get started</a></div>')
    return '  <div class="plans">\n    ' + '\n    '.join(cards) + '\n  </div>'

def should_skip(fp):
    rel = os.path.relpath(fp, PUBLIC_DIR)
    for s in SKIP_PATHS:
        if rel.startswith(s) or os.path.basename(fp)==s: return True
    for ext in ['.bak','.bak2','.bak3','.html2','.html6','.html-v3']:
        if fp.endswith(ext): return True
    return False

def update_file(fp, plans, sp):
    with open(fp,'r',encoding='utf-8',errors='replace') as f: orig = f.read()
    c = orig
    # Update meta/schema prices
    c = re.sub(r'From £\d+/month \+ VAT', f'From £{sp}/month + VAT', c)
    c = re.sub(r'from £\d+/month \+ VAT', f'from £{sp}/month + VAT', c)
    c = re.sub(r'"@type":"Offer","price":"\d+"', f'"@type":"Offer","price":"{sp}"', c)
    c = re.sub(r'>From £\d+/month \+ VAT<', f'>From £{sp}/month + VAT<', c)

    # Replace entire pricing section if present
    if '<section id="pricing"' in c:
        active = [p for p in plans if p.get('is_active',1)]
        svg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#00e87a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        cards = []
        for p in active:
            monthly = p['price_monthly']
            annual = p.get('price_annual', round(monthly * 0.83))
            calls = p['call_limit']
            calls_str = f"{calls:,}" if calls >= 1000 else str(calls)
            pop = ' pop' if p.get('is_popular') else ''
            badge = '<div class=\"plan-badge\">MOST POPULAR</div>' if p.get('is_popular') else ''
            feats = ''.join([f'<div class=\"pf\">{svg}{f}</div>' for f in p.get('features',[])])
            btn_class = 'pcta-p' if p.get('is_popular') else 'pcta-g'
            btn_text = 'Start free trial &rarr;' if p.get('is_popular') else 'Get started &rarr;'
            cards.append(f'<div class=\"plan{pop}\">{badge}<div class=\"plan-name\">{p["name"]}</div><div class=\"plan-price\"><sup>£</sup><span class=\"price-val\" data-monthly=\"{monthly}\" data-annual=\"{annual}\">{monthly}</span><sub>/mo</sub></div><div style=\"font-size:11px;color:var(--dim);margin-bottom:12px;min-height:16px\">+ VAT</div><div class=\"plan-calls\">{calls_str} calls per month<div style=\"font-size:10px;color:var(--dim);margin-top:3px\">Inbound calls, any duration</div></div><div class=\"plan-feats\">{feats}</div><button onclick=\"location.href=\'/dashboard\'" class=\"pcta {btn_class}\">{btn_text}</button></div>')
        plans_html = '<div class=\"plans\">' + ''.join(cards) + '</div>'
        new_section = f'''<section id=\"pricing\" style=\"padding:60px 24px;background:var(--black)\">
<div style=\"text-align:center;margin-bottom:32px\">
<div style=\"font-size:11px;font-weight:700;color:var(--cyan);letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px;display:flex;align-items:center;justify-content:center;gap:8px\"><span style=\"display:inline-block;width:24px;height:2px;background:var(--cyan)\"></span>Pricing</div>
<h2 style=\"font-family:'Instrument Serif',Georgia,serif;font-size:42px;font-weight:400;letter-spacing:-1px;margin-bottom:8px\">Simple, <em style=\"font-style:italic;background:linear-gradient(135deg,#00d4ff,#0099ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent\">transparent</em> pricing</h2>
<p style=\"font-size:15px;color:var(--muted)\">No setup fees. No per-minute charges. One flat monthly fee.</p>
</div>
<div class=\"pricing-toggle\">
<span class=\"toggle-label active\" id=\"monthly-lbl\">Monthly</span>
<div class=\"toggle-switch\" id=\"billing-toggle\" onclick=\"toggleBilling()\"><div class=\"toggle-thumb\"></div></div>
<span class=\"toggle-label\" id=\"annual-lbl\">Annual</span>
<span class=\"annual-badge\">Save 2 months free</span>
</div>
{plans_html}
<p style=\"font-size:13px;color:var(--dim);margin-top:24px;text-align:center\">All plans include a 14-day free trial. No credit card required to start.</p>
<p style=\"font-size:12px;color:var(--dim);margin-top:6px;text-align:center\">All prices exclude VAT. VAT at 20% will be added at checkout.</p>
<p style=\"font-size:12px;color:var(--dim);margin-top:10px;text-align:center\">&#128222; <strong style=\"color:var(--muted)\">Keep your existing number.</strong> Simply divert your current business number to your AiRingDesk number &#8212; your customers call the same number as always.</p>
<script>if(typeof toggleBilling==='undefined'){{var _annual=false;function toggleBilling(){{_annual=!_annual;document.getElementById('billing-toggle').classList.toggle('annual',_annual);document.getElementById('monthly-lbl').classList.toggle('active',!_annual);document.getElementById('annual-lbl').classList.toggle('active',_annual);document.querySelectorAll('.price-val').forEach(function(e){{e.textContent=_annual?e.dataset.annual:e.dataset.monthly;}});}}}}</script>
</section>'''
        c = re.sub(r'<section id="pricing".*?</section>', new_section, c, count=1, flags=re.DOTALL)

    if c == orig: return False
    with open(fp,'w',encoding='utf-8') as f: f.write(c)
    return True

def update_homepage(fp, plans):
    sp = min(p['price_monthly'] for p in plans if p.get('is_active',1))
    return update_file(fp, plans, sp)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plans', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    plans = load_plans(args.plans)
    sp = starting_price(plans)
    print(f"Starting price: £{sp} | Plans: {[p['name'] for p in plans if p.get('is_active',1)]}")
    updated=skipped=unchanged=errors=0
    start=time.time()
    for root,dirs,files in os.walk(PUBLIC_DIR):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['dashboard','admin']]
        for fname in files:
            if not fname.endswith('.html'): continue
            fp = os.path.join(root,fname)
            if should_skip(fp): skipped+=1; continue
            try:
                if args.dry_run:
                    with open(fp,'r',encoding='utf-8',errors='replace') as f: content=f.read()
                    if 'class="plans"' in content or 'From £' in content: updated+=1
                    else: unchanged+=1
                else:
                    if update_file(fp,plans,sp): updated+=1
                    else: unchanged+=1
            except Exception as e:
                errors+=1; print(f"ERROR: {fp} — {e}",file=sys.stderr)
    print(f"Updated:{updated} Unchanged:{unchanged} Skipped:{skipped} Errors:{errors} Time:{time.time()-start:.1f}s")
    # Update homepage
    homepage = '/var/www/vhosts/airingdesk.com/httpdocs/public/index.html'
    if os.path.exists(homepage):
        if update_homepage(homepage, plans):
            print("Homepage pricing updated")
        else:
            print("Homepage unchanged")

    # Update about.html starting price stat card
    import re as re2
    about = '/var/www/vhosts/airingdesk.com/httpdocs/public/about.html'
    if os.path.exists(about):
        active = [p for p in plans if p.get('is_active', 1)]
        if active:
            sp = min(p['price_monthly'] for p in active)
            with open(about, 'r', encoding='utf-8') as f:
                ac = f.read()
            new_ac = re2.sub(
                r'(<div class="stat-val">£)\d+(</div><div class="stat-label">Starting price)',
                rf'\g<1>{sp}\g<2>',
                ac
            )
            if new_ac != ac:
                with open(about, 'w', encoding='utf-8') as f:
                    f.write(new_ac)
                print(f"about.html starting price updated to £{sp}")
            else:
                print("about.html unchanged")
    print(f"PAGES_UPDATED:{updated} ERRORS:{errors}")

if __name__=='__main__': main()
