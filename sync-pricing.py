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

    # Update data-monthly and data-annual attributes in price-val spans
    active = [p for p in plans if p.get('is_active',1)]
    for p in active:
        monthly = p['price_monthly']
        annual = p.get('price_annual', round(monthly * 0.83))
        calls = p['call_limit']
        calls_str = f"{calls:,}" if calls >= 1000 else str(calls)
        name = p['name']

        # Update data-monthly, data-annual AND visible price in span
        plan_pattern = rf'(<div class="plan[^"]*">\s*(?:<div class="plan-badge">[^<]*</div>\s*)?<div class="plan-name">{name}</div><div class="plan-price"><sup>£</sup><span class="price-val" data-monthly=")\d+(" data-annual=")\d+(">)\d+(</span>)'
        replacement = rf'\g<1>{monthly}\g<2>{annual}\g<3>{monthly}\g<4>'
        c = re.sub(plan_pattern, replacement, c, flags=re.DOTALL)

        # Update calls per month for this plan
        # Find plan name then update calls within next 500 chars
        idx = c.find(f'<div class="plan-name">{name}</div>')
        if idx != -1:
            section = c[idx:idx+600]
            new_section = re.sub(r'(\d[\d,]*) calls per month', f'{calls_str} calls per month', section, count=1)
            c = c[:idx] + new_section + c[idx+600:]

    if c == orig: return False
    with open(fp,'w',encoding='utf-8') as f: f.write(c)
    return True

def update_homepage(fp, plans):
    with open(fp, 'r', encoding='utf-8', errors='replace') as f:
        orig = f.read()
    c = orig
    active = [p for p in plans if p.get('is_active', 1)]
    for p in active:
        pid = p['id']
        monthly = p['price_monthly']
        annual = p.get('price_annual', round(monthly * 0.83))
        calls = p['call_limit']
        calls_str = f"{calls:,}" if calls >= 1000 else str(calls)

        # Update data-monthly and data-annual attributes + visible price
        import re
        # Find the plan block by name and update price-val span
        pattern = rf'(<div class="plan-name">{p["name"]}</div><div class="plan-price"><sup>£</sup><span class="price-val" data-monthly=")(\d+)(" data-annual=")(\d+)(">)(\d+)(</span>)'
        replacement = rf'\g<1>{monthly}\g<3>{annual}\g<5>{monthly}\g<7>'
        new_c = re.sub(pattern, replacement, c)

        # Update calls per month
        old_calls_pattern = rf'(\d[\d,]*) calls per month'
        # Find the right plan section and update calls
        plan_start = new_c.find(f'<div class="plan-name">{p["name"]}</div>')
        if plan_start != -1:
            plan_end = new_c.find('<div class="plan-name">', plan_start + 1)
            if plan_end == -1:
                plan_end = new_c.find('</section>', plan_start)
            plan_section = new_c[plan_start:plan_end]
            new_plan_section = re.sub(r'(\d[\d,]*) calls per month', f'{calls_str} calls per month', plan_section, count=1)
            new_c = new_c[:plan_start] + new_plan_section + new_c[plan_end:]

        c = new_c

    if c == orig:
        return False
    with open(fp, 'w', encoding='utf-8') as f:
        f.write(c)
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
