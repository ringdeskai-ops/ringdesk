#!/usr/bin/env python3
import os, re, json, sys, time, argparse

PUBLIC_DIR = '/var/www/vhosts/airingdesk.com/httpdocs/public'
SKIP_PATHS = ['dashboard','admin','index.html','index.html.bak','index.html.bak2','index.html.bak3']

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
    c = re.sub(r'From £\d+/month \+ VAT', f'From £{sp}/month + VAT', c)
    c = re.sub(r'from £\d+/month \+ VAT', f'from £{sp}/month + VAT', c)
    c = re.sub(r'"@type":"Offer","price":"\d+"', f'"@type":"Offer","price":"{sp}"', c)
    c = re.sub(r'>From £\d+/month \+ VAT<', f'>From £{sp}/month + VAT<', c)
    nb = build_plans_block(plans)
    c = re.sub(r'<div class="plans">.*?</div>(?=\s*\n\s*(?!</div>))', nb, c, count=1, flags=re.DOTALL)
    if c == orig: return False
    with open(fp,'w',encoding='utf-8') as f: f.write(c)
    return True

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
    print(f"PAGES_UPDATED:{updated} ERRORS:{errors}")

if __name__=='__main__': main()
