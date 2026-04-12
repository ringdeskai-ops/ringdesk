// ── URL param detection — resume modal after email verify or payment ──────────
window.addEventListener('DOMContentLoaded', function() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  const plan = params.get('plan') || 'starter';
  if (ref) sessionStorage.setItem('referral_code', ref);

  // After email verification — resume at payment step
  if (params.get('verified') === 'true') {
    const clientId = params.get('client_id');
    const token = params.get('token');
    const verifiedPlan = params.get('plan') || 'starter';
    if (clientId && token) {
      tok = token;
      registeredClientId = clientId;
      selPlan = verifiedPlan;
      setTimeout(() => {
        openModal(verifiedPlan);
        goStep(3);
      }, 300);
    }
    // Clean URL
    window.history.replaceState({}, '', '/');
    return;
  }

  // After Stripe payment — resume at number selection step
  if (params.get('payment') === 'success') {
    const sessionId = params.get('session_id');
    const clientId = params.get('client_id');
    if (sessionId && clientId) {
      setTimeout(() => resumeAfterStripe(sessionId, clientId), 300);
    }
    window.history.replaceState({}, '', '/');
    return;
  }

  // After GoCardless payment — resume at number selection step
  if (params.get('payment') === 'gc') {
    const clientId = params.get('client_id');
    const gcPlan = params.get('plan') || 'starter';
    if (clientId) {
      setTimeout(() => resumeAfterGC(clientId, gcPlan), 300);
    }
    window.history.replaceState({}, '', '/');
    return;
  }

  // Auto-open modal from URL
  if (params.get('signup') === 'true') {
    setTimeout(() => openModal(plan), 500);
  }
});

// ── Mobile menu ────────────────────────────────────────────────────────────────
function toggleMenu(){
  const h=document.getElementById('hamburger');
  const m=document.getElementById('mobileMenu');
  h.classList.toggle('open');
  m.classList.toggle('open');
  document.body.style.overflow=m.classList.contains('open')?'hidden':'';
}
function closeMenu(){
  document.getElementById('hamburger').classList.remove('open');
  document.getElementById('mobileMenu').classList.remove('open');
  document.body.style.overflow='';
}
document.addEventListener('click',function(e){
  const menu=document.getElementById('mobileMenu');
  const hamburger=document.getElementById('hamburger');
  if(menu&&menu.classList.contains('open')&&!menu.contains(e.target)&&!hamburger.contains(e.target)){closeMenu();}
});

// ── FAQ / ROI / Billing ────────────────────────────────────────────────────────
function toggleFaq(el){const i=el.parentElement;document.querySelectorAll('.faq-item.open').forEach(x=>{if(x!==i)x.classList.remove('open')});i.classList.toggle('open')}
function syncROI(v){document.getElementById('rCalls').value=v;calcROI()}
function calcROI(){
  const c=parseInt(document.getElementById('rCalls').value)||50;
  const v=parseInt(document.getElementById('rVal').value)||300;
  document.getElementById('rSlider').value=Math.min(c,500);
  const m=Math.round(c*.62),l=m*v,s=Math.round(l*.7);
  const plan=c<=200?49:c<=1000?149:349;
  document.getElementById('rMissed').textContent='£'+l.toLocaleString();
  document.getElementById('rSaved').textContent='£'+s.toLocaleString();
  document.getElementById('rVs').textContent=`AiRingDesk costs £${plan}/mo — that's a ${Math.round(s/plan)}x return`;
}
calcROI();
let isAnnual=false;
function toggleBilling(){
  isAnnual=!isAnnual;
  const tog=document.getElementById('billing-toggle');
  const ml=document.getElementById('monthly-lbl');
  const al=document.getElementById('annual-lbl');
  if(tog)tog.classList.toggle('annual',isAnnual);
  if(ml)ml.classList.toggle('active',!isAnnual);
  if(al)al.classList.toggle('active',isAnnual);
  document.querySelectorAll('.price-val').forEach(el=>{el.textContent=isAnnual?el.dataset.annual:el.dataset.monthly;});
  document.querySelectorAll('.price-note').forEach(el=>{el.textContent=isAnnual?'Billed annually — 2 months free':'Billed monthly';el.style.color=isAnnual?'var(--green)':'var(--dim)';});
}
function dismissCookie(accepted){
  document.getElementById('cookie').classList.add('hidden');
  localStorage.setItem('cookieConsent',accepted?'accepted':'declined');
}
if(localStorage.getItem('cookieConsent')){
  const c=document.getElementById('cookie');
  if(c)c.classList.add('hidden');
}

// ── Lead form ──────────────────────────────────────────────────────────────────
async function submitLead(){
  var biz=document.getElementById('leadBiz').value.trim();
  var first=document.getElementById('leadFirst').value.trim();
  var email=document.getElementById('leadEmail').value.trim();
  var phone=document.getElementById('leadPhone').value.trim();
  var last=document.getElementById('leadLast').value.trim();
  var industry=document.getElementById('leadIndustry').value;
  var message=document.getElementById('leadMessage').value.trim();
  var errEl=document.getElementById('leadError');
  var btn=document.getElementById('leadBtn');
  errEl.style.display='none';
  if(!biz||!first||!email||!phone){errEl.textContent='Please fill in all required fields.';errEl.style.display='block';return;}
  if(!email.includes('@')){errEl.textContent='Please enter a valid email address.';errEl.style.display='block';return;}
  btn.disabled=true;btn.textContent='Sending...';
  try{
    var resp=await fetch('/api/leads/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({business_name:biz,first_name:first,last_name:last,email,phone,industry,message})});
    var data=await resp.json();
    if(!resp.ok)throw new Error(data.error||'Failed');
    document.getElementById('leadFormWrap').style.display='none';
    document.getElementById('leadSuccess').style.display='block';
  }catch(e){errEl.textContent=e.message||'Something went wrong.';errEl.style.display='block';btn.disabled=false;btn.textContent='Get my free consultation →';}
}

// ── Scroll reveal ──────────────────────────────────────────────────────────────
const obs=new IntersectionObserver(e=>{e.forEach(x=>{if(x.isIntersecting)x.target.classList.add('visible')})},{threshold:.1});
document.querySelectorAll('.reveal').forEach(el=>obs.observe(el));

// ── Modal state ────────────────────────────────────────────────────────────────
const PLANS={essential:'Essential — £29/month + VAT',starter:'Starter — £49/month + VAT',professional:'Professional — £149/month + VAT',business:'Business — £349/month + VAT'};
const PSUM={essential:'Essential — £29/mo + VAT',starter:'Starter — £49/mo + VAT',professional:'Professional — £149/mo + VAT',business:'Business — £349/mo + VAT'};
let selPlan='starter', selNum=null, tok=null, curStep=1, registeredClientId=null, verifyPollTimer=null;

// ── Modal open/close ───────────────────────────────────────────────────────────
function openModal(p){
  selPlan=p||'starter';
  document.getElementById('mplanBadge').textContent=PLANS[selPlan]||PLANS.starter;
  document.getElementById('sPlan').textContent=PSUM[selPlan]||PSUM.starter;
  document.getElementById('signupModal').classList.add('active');
  document.body.style.overflow='hidden';
  if(!tok) {
    selNum=null; curStep=1; goStep(1);
    setTimeout(()=>{const el=document.getElementById('sBiz');if(el)el.focus();},100);
  }
}
function closeModal(){
  document.getElementById('signupModal').classList.remove('active');
  document.body.style.overflow='';
  if(verifyPollTimer){clearInterval(verifyPollTimer);verifyPollTimer=null;}
}
document.getElementById('signupModal').addEventListener('click',function(e){if(e.target===this)closeModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});

// ── Step navigation ────────────────────────────────────────────────────────────
function goStep(n){
  curStep=n;
  document.querySelectorAll('.spanel').forEach(p=>p.classList.remove('active'));
  const panel=document.getElementById('step'+n);
  if(panel)panel.classList.add('active');
  // Fire Google Ads conversion when user reaches Step 5 (signup complete)
  if(n===5 && typeof gtag !== 'undefined'){
    gtag('event', 'conversion_event_begin_checkout');
  }
  for(let i=1;i<=5;i++){
    const d=document.getElementById('sd'+i);
    if(!d)continue;
    if(i<n){d.className='sdot done';d.textContent='✓';}
    else if(i===n){d.className='sdot active';d.textContent=i;}
    else{d.className='sdot inactive';d.textContent=i;}
  }
  for(let i=1;i<=4;i++){
    const sl=document.getElementById('sl'+i);
    if(sl)sl.className='sline'+(i<n?' done':'');
  }
}

// ── Step 1: Register ───────────────────────────────────────────────────────────
async function goStep2(){
  const biz=document.getElementById('sBiz').value.trim();
  const email=document.getElementById('sEmail').value.trim();
  const pass=document.getElementById('sPass').value;
  const passConfirm=document.getElementById('sPassConfirm').value;
  const btn=document.getElementById('s1btn'),bt=document.getElementById('s1txt');
  document.getElementById('e1').classList.remove('show');
  if(!document.getElementById('sFirst').value.trim())return showE(1,'Please enter your first name.');
  if(!document.getElementById('sLast').value.trim())return showE(1,'Please enter your last name.');
  if(!biz)return showE(1,'Please enter your business name.');
  if(!document.getElementById('sPhone').value.trim())return showE(1,'Please enter your contact phone.');
  if(!email||!email.includes('@'))return showE(1,'Please enter a valid email.');
  if(pass!==passConfirm)return showE(1,'Passwords do not match.');
  if(pass.length<8)return showE(1,'Password must be at least 8 characters.');
  btn.disabled=true;bt.innerHTML='<div class="spinner"></div> Creating account...';
  try{
    const refCode=sessionStorage.getItem('referral_code')||new URLSearchParams(window.location.search).get('ref')||'';
    var _utm={};try{_utm=JSON.parse(sessionStorage.getItem('ard_utm')||'{}');}catch(e){}
    const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({utm_source:_utm.source||'direct',utm_medium:_utm.medium||'none',utm_campaign:_utm.campaign||'none',utm_keyword:_utm.keyword||'none',gclid:_utm.gclid||'none',
      business_name:biz,email,password:pass,referral_code:refCode,
      first_name:document.getElementById('sFirst').value.trim(),
      last_name:document.getElementById('sLast').value.trim(),
      contact_phone:document.getElementById('sPhone').value.trim(),
      address_line1:document.getElementById('sAddr1').value.trim(),
      address_line2:document.getElementById('sAddr2').value.trim(),
      city:document.getElementById('sCity').value.trim(),
      postcode:document.getElementById('sPostcode').value.trim(),
      country:document.getElementById('sCountry').value,
      region:document.getElementById('sRegion').value.trim()
    })});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Registration failed.');
    // Show email verification step
    const emailDisplay=document.getElementById('verifyEmailDisplay');
    if(emailDisplay)emailDisplay.textContent=email;
    document.getElementById('sBizSum').textContent=biz;
    // Store client id for polling
    if(d.client_id)registeredClientId=d.client_id;
    goStep(2);
    startVerifyPoll(email);
  }catch(e){showE(1,e.message);}
  finally{btn.disabled=false;bt.textContent='Continue →';}
}

// ── Step 2: Email verification polling ────────────────────────────────────────
function startVerifyPoll(email){
  if(verifyPollTimer)clearInterval(verifyPollTimer);
  const statusEl=document.getElementById('verifyPollStatus');
  let dots=0;
  verifyPollTimer=setInterval(async()=>{
    dots=(dots+1)%4;
    if(statusEl)statusEl.textContent='⏳ Waiting for verification'+'.'.repeat(dots);
    try{
      const r=await fetch('/api/auth/check-verified',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
      const d=await r.json();
      if(d.verified&&d.token){
        clearInterval(verifyPollTimer);verifyPollTimer=null;
        tok=d.token;
        if(statusEl){statusEl.textContent='✅ Email verified!';statusEl.style.color='#00e87a';}
        setTimeout(()=>goStep(3),800);
      }
    }catch(e){}
  },3000);
}

async function resendVerification(){
  const email=document.getElementById('sEmail').value.trim();
  const btn=document.getElementById('resendBtn');
  if(!email)return;
  btn.disabled=true;btn.textContent='Sending...';
  try{
    await fetch('/api/auth/resend-verification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
    btn.textContent='Sent! ✓';
    setTimeout(()=>{btn.disabled=false;btn.textContent='Resend email';},5000);
  }catch(e){btn.disabled=false;btn.textContent='Resend email';}
}

// ── Step 3: Payment ────────────────────────────────────────────────────────────
async function handleSignup(){
  const btn=document.getElementById('s3btn'),bt=document.getElementById('s3txt');
  btn.disabled=true;bt.innerHTML='<div class="spinner"></div> Redirecting...';
  try{
    const r=await fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify({plan:selPlan})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Checkout failed.');
    window.location.href=d.url;
  }catch(e){showE(3,e.message);btn.disabled=false;bt.textContent='💳 Pay with Stripe';}
}
async function handleGCSignup(){
  const btn=document.getElementById('s3gcBtn'),bt=document.getElementById('s3gcTxt');
  const s3btn=document.getElementById('s3btn');
  btn.disabled=true;s3btn.disabled=true;bt.innerHTML='<div class="spinner"></div> Setting up...';
  try{
    const r=await fetch('/api/gc/setup',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify({plan:selPlan})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Direct Debit setup failed.');
    if(d.url){window.location.href=d.url;}
    else throw new Error('No redirect URL received.');
  }catch(e){showE(3,e.message);btn.disabled=false;s3btn.disabled=false;bt.textContent='🏦 Direct Debit';}
}

// ── Resume after Stripe payment ────────────────────────────────────────────────
async function resumeAfterStripe(sessionId, clientId){
  try{
    const r=await fetch('/api/billing/verify-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sessionId,client_id:clientId})});
    const d=await r.json();
    if(d.token){
      tok=d.token;
      localStorage.setItem('rd_token',d.token);
      localStorage.setItem('rd_user',JSON.stringify(d.user));
      localStorage.setItem('rd_login_time',Date.now().toString());
      selPlan=d.user?.plan||'starter';
      openModal(selPlan);
      goStep(4);
      loadNums();
    }
  }catch(e){console.log('Resume after Stripe failed:',e.message);}
}

// ── Resume after GoCardless payment ───────────────────────────────────────────
async function resumeAfterGC(clientId, plan){
  try{
    // For GC we need to complete the subscription first
    const r=await fetch('/api/gc/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:clientId,plan})});
    const d=await r.json();
    if(d.token){
      tok=d.token;
      localStorage.setItem('rd_token',d.token);
      localStorage.setItem('rd_user',JSON.stringify(d.user||{}));
      localStorage.setItem('rd_login_time',Date.now().toString());
      selPlan=plan;
      openModal(plan);
      goStep(4);
      loadNums();
    }
  }catch(e){console.log('Resume after GC failed:',e.message);}
}

// ── Step 4: Number selection ───────────────────────────────────────────────────
async function loadNums(){
  const c=document.getElementById('nCountry').value;
  const g=document.getElementById('numGrid');
  selNum=null;
  g.innerHTML='<div class="nload"><div class="spinner" style="margin:0 auto 8px;border-top-color:var(--cyan)"></div>Loading...</div>';
  try{
    const r=await fetch('/api/numbers/search?country='+c,{headers:{'Authorization':'Bearer '+tok}});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    if(!d.numbers||d.numbers.length===0){g.innerHTML='<div class="nload">No numbers available. Try another country.</div>';return;}
    g.innerHTML=d.numbers.map(n=>`<div class="ncard" onclick="selNumber('${n.phoneNumber}','${n.friendlyName}',this)"><div class="nnum">${n.friendlyName}</div><div class="nloc">${n.locality||n.region||'Local'}</div></div>`).join('');
  }catch(e){g.innerHTML=`<div class="nload" style="color:var(--red)">${e.message}</div>`;}
}
function selNumber(num,fn,el){
  document.querySelectorAll('.ncard').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel');selNum=num;
  document.getElementById('e4').classList.remove('show');
  const btn=document.getElementById('s4btn');
  if(btn)btn.style.background='linear-gradient(135deg,#00d4ff,#0099cc)';
}
async function handleProvision(){
  if(!selNum)return showE(4,'Please select a phone number first.');
  const btn=document.getElementById('s4btn'),bt=document.getElementById('s4txt');
  btn.disabled=true;bt.innerHTML='<div class="spinner"></div> Setting up your number...';
  try{
    const r=await fetch('/api/numbers/provision',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify({phoneNumber:selNum})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Provisioning failed.');
    goStep(5);
  }catch(e){showE(4,e.message);btn.disabled=false;bt.textContent='Activate this number →';}
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function showE(s,m){const el=document.getElementById('e'+s);if(el){el.textContent=m;el.classList.add('show');}}
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&document.getElementById('signupModal').classList.contains('active')){
    if(curStep===1)goStep2();
  }
});
