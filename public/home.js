// Auto-open signup modal if ?signup=true in URL and store referral code
window.addEventListener('DOMContentLoaded', function() {
const params = new URLSearchParams(window.location.search);
const ref = params.get('ref');
const plan = params.get('plan') || 'starter';
if (ref) sessionStorage.setItem('referral_code', ref);
if (params.get('signup') === 'true') {
setTimeout(() => openModal(plan), 500);
}
});
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
// Close menu when clicking outside
document.addEventListener('click',function(e){
const menu=document.getElementById('mobileMenu');
const hamburger=document.getElementById('hamburger');
if(menu.classList.contains('open') && !menu.contains(e.target) && !hamburger.contains(e.target)){
closeMenu();
}
});
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
// Billing toggle
let isAnnual=false;
function toggleBilling(){
isAnnual=!isAnnual;
const tog=document.getElementById('billing-toggle');
const ml=document.getElementById('monthly-lbl');
const al=document.getElementById('annual-lbl');
tog.classList.toggle('annual',isAnnual);
ml.classList.toggle('active',!isAnnual);
al.classList.toggle('active',isAnnual);
document.querySelectorAll('.price-val').forEach(el=>{
const monthly=parseInt(el.dataset.monthly);
const annual=parseInt(el.dataset.annual);
el.textContent=isAnnual?annual:monthly;
});
document.querySelectorAll('.price-note').forEach(el=>{
el.textContent=isAnnual?'Billed annually — 2 months free':'Billed monthly';
el.style.color=isAnnual?'var(--green)':'var(--dim)';
});
}
// Cookie consent
function dismissCookie(accepted){
document.getElementById('cookie').classList.add('hidden');
localStorage.setItem('cookieConsent',accepted?'accepted':'declined');
}
if(localStorage.getItem('cookieConsent')){
document.getElementById('cookie').classList.add('hidden');
}
// Scroll reveal
async function submitLead() {
var biz = document.getElementById('leadBiz').value.trim();
var first = document.getElementById('leadFirst').value.trim();
var email = document.getElementById('leadEmail').value.trim();
var phone = document.getElementById('leadPhone').value.trim();
var last = document.getElementById('leadLast').value.trim();
var industry = document.getElementById('leadIndustry').value;
var message = document.getElementById('leadMessage').value.trim();
var errEl = document.getElementById('leadError');
var btn = document.getElementById('leadBtn');
errEl.style.display = 'none';
if (!biz || !first || !email || !phone) {
errEl.textContent = 'Please fill in all required fields.';
errEl.style.display = 'block';
return;
}
if (!email.includes('@')) {
errEl.textContent = 'Please enter a valid email address.';
errEl.style.display = 'block';
return;
}
btn.disabled = true;
btn.textContent = 'Sending...';
try {
var resp = await fetch('/api/leads/submit', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ business_name: biz, first_name: first, last_name: last, email, phone, industry, message })
});
var data = await resp.json();
if (!resp.ok) throw new Error(data.error || 'Failed');
document.getElementById('leadFormWrap').style.display = 'none';
document.getElementById('leadSuccess').style.display = 'block';
} catch(e) {
errEl.textContent = e.message || 'Something went wrong. Please try again.';
errEl.style.display = 'block';
btn.disabled = false;
btn.textContent = 'Get my free consultation →';
}
}
const obs=new IntersectionObserver(e=>{e.forEach(x=>{if(x.isIntersecting)x.target.classList.add('visible')})},{threshold:.1});
document.querySelectorAll('.reveal').forEach(el=>obs.observe(el));
const PLANS={essential:'Essential — £29/month + VAT',starter:'Starter — £49/month + VAT',professional:'Professional — £149/month + VAT',business:'Business — £349/month + VAT'};
const PSUM={essential:'Essential — £29/mo + VAT',starter:'Starter — £49/mo + VAT',professional:'Professional — £149/mo + VAT',business:'Business — £349/mo + VAT'};
let selPlan='starter',selNum=null,tok=null,curStep=1;
function openModal(p){selPlan=p;selNum=null;tok=null;curStep=1;document.getElementById('mplanBadge').textContent=PLANS[p]||PLANS.starter;document.getElementById('sPlan').textContent=PSUM[p]||PSUM.starter;goStep(1);document.getElementById('signupModal').classList.add('active');document.body.style.overflow='hidden';setTimeout(()=>document.getElementById('sBiz').focus(),100)}
function closeModal(){document.getElementById('signupModal').classList.remove('active');document.body.style.overflow=''}
document.getElementById('signupModal').addEventListener('click',function(e){if(e.target===this)closeModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
function goStep(n){curStep=n;document.querySelectorAll('.spanel').forEach(p=>p.classList.remove('active'));document.getElementById('step'+n).classList.add('active');for(let i=1;i<=3;i++){const d=document.getElementById('sd'+i);if(i<n){d.className='sdot done';d.textContent='✓'}else if(i===n){d.className='sdot active';d.textContent=i}else{d.className='sdot inactive';d.textContent=i}}for(let i=1;i<=2;i++){document.getElementById('sl'+i).className='sline'+(i<n?' done':'')}}
async function goStep2(){
const biz=document.getElementById('sBiz').value.trim();
const email=document.getElementById('sEmail').value.trim();
const pass=document.getElementById('sPass').value;
const btn=document.getElementById('s1btn'),bt=document.getElementById('s1txt');
document.getElementById('e1').classList.remove('show');
const sFirst=document.getElementById('sFirst').value.trim();
const sLast=document.getElementById('sLast').value.trim();
const sPhone=document.getElementById('sPhone').value.trim();
if(!sFirst)return showE(1,'Please enter your first name.');
if(!sLast)return showE(1,'Please enter your last name.');
if(!biz)return showE(1,'Please enter your business name.');
if(!sPhone)return showE(1,'Please enter your contact phone.');
if(!email||!email.includes('@'))return showE(1,'Please enter a valid email.');
const passConfirm=document.getElementById('sPassConfirm').value;
if(pass!==passConfirm)return showE(1,'Passwords do not match.');
if(pass.length<8)return showE(1,'Password must be at least 8 characters.');
btn.disabled=true;bt.innerHTML='<div class="spinner"></div> Creating account...';
try{
const refCode = sessionStorage.getItem('referral_code') || new URLSearchParams(window.location.search).get('ref') || '';
const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({business_name:biz,email,password:pass,referral_code:refCode,first_name:sFirst,last_name:sLast,contact_phone:sPhone,address_line1:document.getElementById('sAddr1').value.trim(),address_line2:document.getElementById('sAddr2').value.trim(),city:document.getElementById('sCity').value.trim(),postcode:document.getElementById('sPostcode').value.trim(),country:document.getElementById('sCountry').value,region:document.getElementById('sRegion').value.trim()})});
const d=await r.json();
if(!r.ok)throw new Error(d.error||'Registration failed.');
if(d.message){
document.querySelector('.modal').innerHTML='<div style="padding:40px;text-align:center"><div style="font-size:48px;margin-bottom:16px">✉️</div><h3 style="font-size:22px;font-weight:700;margin-bottom:12px;color:#f0f4f8">Check your email</h3><p style="color:#8896a8;font-size:14px;line-height:1.6;margin-bottom:24px">We sent a verification link to <strong style="color:#00d4ff">'+email+'</strong>.<br>Click the link to activate your account.</p><p style="color:#5a7a9a;font-size:12px">Once verified, you can log in and continue setup.</p><button onclick="closeModal()" style="margin-top:24px;background:#00d4ff;color:#020408;border:none;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:700;cursor:pointer">Got it →</button></div>';
return;
}
tok=d.token;document.getElementById('sBizSum').textContent=biz;goStep(2);loadNums();
}catch(e){showE(1,e.message)}
finally{btn.disabled=false;bt.textContent='Continue — pick your number →'}
}
async function loadNums(){
const c=document.getElementById('nCountry').value,g=document.getElementById('numGrid');
selNum=null;g.innerHTML='<div class="nload"><div class="spinner" style="margin:0 auto 8px;border-top-color:var(--cyan)"></div>Loading...</div>';
try{
const r=await fetch('/api/numbers/search?country='+c,{headers:{'Authorization':'Bearer '+tok}});
const d=await r.json();
if(!r.ok)throw new Error(d.error);
if(!d.numbers||d.numbers.length===0){g.innerHTML='<div class="nload">No numbers available.</div>';return}
g.innerHTML=d.numbers.map(n=>`<div class="ncard" onclick="selNumber('${n.phoneNumber}','${n.friendlyName}',this)"><div class="nnum">${n.friendlyName}</div><div class="nloc">${n.locality||n.region||'Local'}</div></div>`).join('');
}catch(e){g.innerHTML=`<div class="nload" style="color:var(--red)">${e.message}</div>`}
}
function selNumber(num,fn,el){document.querySelectorAll('.ncard').forEach(c=>c.classList.remove('sel'));el.classList.add('sel');selNum=num;document.getElementById('sNum').textContent=num;document.getElementById('e2').classList.remove('show')}
function goStep3(){if(!selNum)return showE(2,'Please select a phone number.');goStep(3)}
async function handleSignup(){
const btn=document.getElementById('s3btn'),bt=document.getElementById('s3txt');
btn.disabled=true;bt.innerHTML='<div class="spinner"></div> Redirecting...';
try{
const r=await fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify({plan:selPlan,phone_number:selNum})});
const d=await r.json();
if(!r.ok)throw new Error(d.error||'Checkout failed.');
window.location.href=d.url;
}catch(e){showE(3,e.message);btn.disabled=false;bt.textContent='Pay with Stripe →'}
}
function showE(s,m){const el=document.getElementById('e'+s);el.textContent=m;el.classList.add('show')}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&document.getElementById('signupModal').classList.contains('active')){if(curStep===1)goStep2();else if(curStep===2)goStep3();else if(curStep===3)handleSignup()}});