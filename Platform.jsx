import { useState, useEffect } from "react";

// ── Config ────────────────────────────────────────────────────────────────────
const API = "http://185.249.74.165:3000";

// ── API Helper ────────────────────────────────────────────────────────────────
const apiFetch = async (path, opts = {}) => {
  const token = localStorage.getItem("rd_token");
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json()).error || "Request failed");
  return res.json();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (s) => s > 0 ? `${Math.floor(s/60)}m ${s%60}s` : "—";
const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleString("en-GB", { day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) : "—";
const PLAN_COLORS = { trial:"#6b7280", starter:"#10b981", professional:"#3b82f6", business:"#8b5cf6" };
const PLAN_LIMITS = { trial:50, starter:200, professional:1000, business:99999 };
const STATUS_COLORS = { completed:"#10b981", transferred:"#3b82f6", voicemail:"#f59e0b", active:"#a855f7" };

// ═════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [user, setUser] = useState(() => {
    const t = localStorage.getItem("rd_token");
    const u = localStorage.getItem("rd_user");
    return t && u ? JSON.parse(u) : null;
  });

  const login = (token, userData) => {
    localStorage.setItem("rd_token", token);
    localStorage.setItem("rd_user", JSON.stringify(userData));
    setUser(userData);
  };

  const logout = () => {
    localStorage.removeItem("rd_token");
    localStorage.removeItem("rd_user");
    setUser(null);
  };

  if (!user) return <AuthPage onLogin={login} />;
  if (user.role === "superadmin") return <SuperAdminDashboard user={user} onLogout={logout} />;
  if (user.role === "admin") return <AdminDashboard user={user} onLogout={logout} />;
  return <ClientDashboard user={user} onLogout={logout} />;
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTH PAGE — Login + Signup
// ═════════════════════════════════════════════════════════════════════════════
function AuthPage({ onLogin }) {
  const [tab, setTab] = useState("login");
  const [form, setForm] = useState({ business_name:"", email:"", password:"", plan:"starter" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(1); // signup steps

  const handleLogin = async () => {
    setError(""); setLoading(true);
    try {
      const data = await apiFetch("/api/auth/login", { method:"POST", body:{ email:form.email, password:form.password } });
      onLogin(data.token, { ...data.client, role: data.client.role || "client" });
    } catch(err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleSignup = async () => {
    setError(""); setLoading(true);
    try {
      const data = await apiFetch("/api/auth/register", { method:"POST", body:{ business_name:form.business_name, email:form.email, password:form.password } });
      onLogin(data.token, { ...data.client, role:"client" });
    } catch(err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const plans = [
    { id:"starter", name:"Starter", price:"£49", calls:"200 calls/mo", features:["AI answering 24/7","Call transcripts","Voicemail","Email support"] },
    { id:"professional", name:"Professional", price:"£149", calls:"1,000 calls/mo", features:["Everything in Starter","Human transfer","Daily reports","Priority support"], popular:true },
    { id:"business", name:"Business", price:"£349", calls:"Unlimited", features:["Everything in Pro","2 phone numbers","Custom AI","Dedicated manager"] },
  ];

  return (
    <div style={{ minHeight:"100vh", background:"#060912", fontFamily:"'Sora',sans-serif", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ fontSize:32, fontWeight:800, background:"linear-gradient(135deg,#fff,#60a5fa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", marginBottom:8 }}>RingDesk</div>
      <div style={{ fontSize:13, color:"#4a5568", marginBottom:32 }}>AI Receptionist Platform</div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:4, background:"#0d1117", padding:4, borderRadius:12, marginBottom:28, border:"1px solid #1f2937" }}>
        {["login","signup"].map(t => (
          <button key={t} onClick={() => { setTab(t); setStep(1); setError(""); }}
            style={{ padding:"8px 24px", borderRadius:8, border:"none", background:tab===t?"#1f2937":"transparent", color:tab===t?"#fff":"#6b7280", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", textTransform:"capitalize" }}>{t === "login" ? "Sign In" : "Get Started"}</button>
        ))}
      </div>

      {tab === "login" ? (
        <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:16, padding:32, width:"100%", maxWidth:400 }}>
          <div style={{ fontSize:18, fontWeight:700, color:"#f9fafb", marginBottom:20 }}>Welcome back</div>
          <Input placeholder="Email address" type="email" value={form.email} onChange={v => setForm(f=>({...f,email:v}))} />
          <Input placeholder="Password" type="password" value={form.password} onChange={v => setForm(f=>({...f,password:v}))} onEnter={handleLogin} />
          {error && <ErrorBox msg={error} />}
          <Btn label={loading?"Signing in...":"Sign In"} onClick={handleLogin} disabled={loading} />
          <div style={{ textAlign:"center", marginTop:16, fontSize:13, color:"#6b7280" }}>
            No account? <span onClick={() => setTab("signup")} style={{ color:"#60a5fa", cursor:"pointer" }}>Get started free</span>
          </div>
        </div>
      ) : (
        <div style={{ width:"100%", maxWidth: step === 2 ? 900 : 440 }}>
          {/* Step 1 — Account details */}
          {step === 1 && (
            <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:16, padding:32 }}>
              <div style={{ fontSize:18, fontWeight:700, color:"#f9fafb", marginBottom:4 }}>Create your account</div>
              <div style={{ fontSize:13, color:"#6b7280", marginBottom:20 }}>Start your 14-day free trial</div>
              <Input placeholder="Business name" value={form.business_name} onChange={v => setForm(f=>({...f,business_name:v}))} />
              <Input placeholder="Email address" type="email" value={form.email} onChange={v => setForm(f=>({...f,email:v}))} />
              <Input placeholder="Password (min 8 chars)" type="password" value={form.password} onChange={v => setForm(f=>({...f,password:v}))} />
              {error && <ErrorBox msg={error} />}
              <Btn label="Continue →" onClick={() => { if(!form.business_name||!form.email||!form.password){setError("All fields required");return;} setError(""); setStep(2); }} />
              <div style={{ textAlign:"center", marginTop:16, fontSize:13, color:"#6b7280" }}>
                Already have an account? <span onClick={() => setTab("login")} style={{ color:"#60a5fa", cursor:"pointer" }}>Sign in</span>
              </div>
            </div>
          )}

          {/* Step 2 — Pick plan */}
          {step === 2 && (
            <div>
              <div style={{ textAlign:"center", marginBottom:28 }}>
                <div style={{ fontSize:22, fontWeight:700, color:"#f9fafb" }}>Choose your plan</div>
                <div style={{ fontSize:13, color:"#6b7280", marginTop:4 }}>14-day free trial on all plans. No credit card required.</div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:20 }}>
                {plans.map(p => (
                  <div key={p.id} onClick={() => setForm(f=>({...f,plan:p.id}))}
                    style={{ background:form.plan===p.id?"rgba(59,130,246,0.08)":"#0d1117", border:`1px solid ${form.plan===p.id?"rgba(59,130,246,0.5)":"#1f2937"}`, borderRadius:14, padding:24, cursor:"pointer", position:"relative", transition:"all 0.2s" }}>
                    {p.popular && <div style={{ position:"absolute", top:-10, left:"50%", transform:"translateX(-50%)", background:"linear-gradient(135deg,#3b82f6,#2563eb)", color:"#fff", fontSize:10, fontWeight:700, padding:"3px 12px", borderRadius:20, whiteSpace:"nowrap" }}>MOST POPULAR</div>}
                    <div style={{ fontSize:14, fontWeight:700, color:"#9ca3af", marginBottom:8, textTransform:"uppercase", letterSpacing:1 }}>{p.name}</div>
                    <div style={{ fontSize:36, fontWeight:800, color:"#f9fafb", marginBottom:4 }}>{p.price}<span style={{ fontSize:14, fontWeight:400, color:"#6b7280" }}>/mo</span></div>
                    <div style={{ fontSize:12, color:"#10b981", fontWeight:600, marginBottom:16 }}>{p.calls}</div>
                    {p.features.map((f,i) => <div key={i} style={{ fontSize:12, color:"#9ca3af", marginBottom:5 }}>✓ {f}</div>)}
                    {form.plan===p.id && <div style={{ marginTop:12, fontSize:11, color:"#60a5fa", fontWeight:600 }}>✓ Selected</div>}
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", gap:10 }}>
                <button onClick={() => setStep(1)} style={{ padding:"12px 24px", borderRadius:10, border:"1px solid #374151", background:"transparent", color:"#9ca3af", cursor:"pointer", fontFamily:"inherit" }}>← Back</button>
                <button onClick={handleSignup} disabled={loading}
                  style={{ flex:1, padding:12, borderRadius:10, border:"none", background:"linear-gradient(135deg,#3b82f6,#2563eb)", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
                  {loading ? "Creating account..." : "Start Free Trial →"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap');`}</style>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SUPER ADMIN DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
function SuperAdminDashboard({ user, onLogout }) {
  const [page, setPage] = useState("overview");
  const [customers, setCustomers] = useState([]);
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [cData, sData] = await Promise.all([
        apiFetch("/api/admin/customers"),
        apiFetch("/api/stats")
      ]);
      setCustomers(cData.customers || []);
      setStats(sData);
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  const updateFeature = async (clientId, feature, value) => {
    await apiFetch("/api/admin/toggle", { method:"POST", body:{ client_id:clientId, feature, value } });
    loadData();
  };

  const nav = [
    { id:"overview", icon:"⬛", label:"Overview" },
    { id:"customers", icon:"👥", label:"Customers" },
    { id:"calls", icon:"📞", label:"All Calls" },
    { id:"revenue", icon:"💰", label:"Revenue" },
    { id:"system", icon:"⚙", label:"System" },
  ];

  const totalMRR = customers.reduce((sum,c) => {
    const prices = { trial:0, starter:49, professional:149, business:349 };
    return sum + (prices[c.plan] || 0);
  }, 0);

  return (
    <Shell nav={nav} page={page} setPage={setPage} onLogout={onLogout} role="superadmin" user={user}>
      {page === "overview" && (
        <div style={{ padding:32 }}>
          <PageHeader title={`Super Admin — ${user.business_name}`} sub="Full platform control" />
          
          {/* KPI Cards */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:16, marginBottom:28 }}>
            {[
              { label:"Total Customers", value:customers.length, icon:"👥", color:"#3b82f6" },
              { label:"Monthly Revenue", value:`£${totalMRR}`, icon:"💰", color:"#10b981" },
              { label:"Total Calls", value:stats?.total_calls||0, icon:"📞", color:"#8b5cf6" },
              { label:"Calls This Month", value:stats?.calls_this_month||0, icon:"📊", color:"#f59e0b" },
              { label:"Transferred", value:stats?.transferred||0, icon:"↗", color:"#06b6d4" },
              { label:"Voicemails", value:stats?.voicemails||0, icon:"📬", color:"#ec4899" },
            ].map((k,i) => (
              <div key={i} style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:12, padding:"20px 18px" }}>
                <div style={{ fontSize:22, marginBottom:8 }}>{k.icon}</div>
                <div style={{ fontSize:28, fontWeight:700, color:k.color }}>{k.value}</div>
                <div style={{ fontSize:12, color:"#6b7280", marginTop:2 }}>{k.label}</div>
              </div>
            ))}
          </div>

          {/* Recent customers */}
          <SectionCard title="Recent Customers">
            {customers.slice(0,5).map((c,i) => (
              <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #1f2937" }}>
                <div style={{ width:36, height:36, borderRadius:10, background:`${PLAN_COLORS[c.plan]}15`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, color:PLAN_COLORS[c.plan], fontWeight:700, flexShrink:0 }}>{c.customer_number?.slice(-3)||"—"}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:"#e5e7eb" }}>{c.business_name}</div>
                  <div style={{ fontSize:11, color:"#6b7280" }}>{c.email} · {c.phone_number||"No number"}</div>
                </div>
                <PlanBadge plan={c.plan} />
              </div>
            ))}
          </SectionCard>
        </div>
      )}

      {page === "customers" && (
        <div style={{ padding:32 }}>
          <PageHeader title="Customers" sub={`${customers.length} total`} action={{ label:"+ Add Customer", onClick:() => setSelected("new") }} />
          
          <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:12, overflow:"hidden" }}>
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ background:"rgba(255,255,255,0.02)" }}>
                  {["#","Business","Email","Phone","Plan","Calls","Email Alerts","Recording","Actions"].map(h => (
                    <th key={h} style={{ padding:"10px 14px", textAlign:"left", fontSize:10, color:"#6b7280", letterSpacing:1, textTransform:"uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customers.map((c,i) => (
                  <tr key={i} style={{ borderTop:"1px solid #1a2332" }}>
                    <td style={{ padding:"12px 14px" }}>
                      <span style={{ background:"rgba(59,130,246,0.1)", color:"#60a5fa", padding:"3px 8px", borderRadius:20, fontSize:11, fontWeight:700 }}>{c.customer_number||"—"}</span>
                    </td>
                    <td style={{ padding:"12px 14px", fontSize:13, fontWeight:600, color:"#e5e7eb" }}>{c.business_name}</td>
                    <td style={{ padding:"12px 14px", fontSize:12, color:"#9ca3af" }}>{c.email}</td>
                    <td style={{ padding:"12px 14px", fontSize:12, color:"#9ca3af" }}>{c.phone_number||"—"}</td>
                    <td style={{ padding:"12px 14px" }}><PlanBadge plan={c.plan} /></td>
                    <td style={{ padding:"12px 14px", fontSize:12, color:"#9ca3af" }}>{c.calls_this_month||0}/{c.call_limit||200}</td>
                    <td style={{ padding:"12px 14px" }}>
                      <Toggle value={c.email_notifications} onChange={v => updateFeature(c.id, "email_notifications", v)} />
                    </td>
                    <td style={{ padding:"12px 14px" }}>
                      <Toggle value={c.call_recording} onChange={v => updateFeature(c.id, "call_recording", v)} />
                    </td>
                    <td style={{ padding:"12px 14px" }}>
                      <button onClick={() => setSelected(c)} style={{ background:"rgba(255,255,255,0.06)", border:"1px solid #374151", color:"#9ca3af", padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>Manage</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected && selected !== "new" && (
            <CustomerDetailModal customer={selected} onClose={() => { setSelected(null); loadData(); }} onUpdate={updateFeature} />
          )}
          {selected === "new" && (
            <AddCustomerModal nextNumber={`RD-00${customers.length+1}`} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); loadData(); }} />
          )}
        </div>
      )}

      {page === "calls" && <AllCallsPage />}
      {page === "revenue" && <RevenuePage customers={customers} totalMRR={totalMRR} />}
      {page === "system" && <SystemPage />}
    </Shell>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
function AdminDashboard({ user, onLogout }) {
  const [page, setPage] = useState("overview");
  const [customers, setCustomers] = useState([]);

  useEffect(() => {
    apiFetch("/api/admin/customers").then(d => setCustomers(d.customers||[])).catch(console.error);
  }, []);

  const nav = [
    { id:"overview", icon:"⬛", label:"Overview" },
    { id:"customers", icon:"👥", label:"Customers" },
    { id:"calls", icon:"📞", label:"Calls" },
  ];

  return (
    <Shell nav={nav} page={page} setPage={setPage} onLogout={onLogout} role="admin" user={user}>
      {page === "overview" && (
        <div style={{ padding:32 }}>
          <PageHeader title="Admin Dashboard" sub="Staff access" />
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:16, marginBottom:28 }}>
            <StatCard label="Total Customers" value={customers.length} color="#3b82f6" icon="👥" />
            <StatCard label="Active Plans" value={customers.filter(c=>c.plan!=="trial").length} color="#10b981" icon="✅" />
          </div>
          <SectionCard title="All Customers">
            {customers.map((c,i) => (
              <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #1f2937" }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:"#e5e7eb" }}>{c.customer_number} — {c.business_name}</div>
                  <div style={{ fontSize:11, color:"#6b7280" }}>{c.email} · {c.phone_number||"No number"}</div>
                </div>
                <PlanBadge plan={c.plan} />
              </div>
            ))}
          </SectionCard>
        </div>
      )}
      {page === "customers" && (
        <div style={{ padding:32 }}>
          <PageHeader title="Customers" sub="Read only view" />
          <SectionCard title="All Customers">
            {customers.map((c,i) => (
              <CustomerRow key={i} customer={c} readonly />
            ))}
          </SectionCard>
        </div>
      )}
      {page === "calls" && <AllCallsPage />}
    </Shell>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
function ClientDashboard({ user, onLogout }) {
  const [page, setPage] = useState("overview");
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [calls, setCalls] = useState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    apiFetch("/api/client/profile").then(setProfile).catch(console.error);
    apiFetch("/api/stats").then(setStats).catch(console.error);
    apiFetch("/api/calls?limit=20").then(d => setCalls(d.calls||[])).catch(console.error);
  }, []);

  const nav = [
    { id:"overview", icon:"⬛", label:"Overview" },
    { id:"calls", icon:"📞", label:"Call Logs" },
    { id:"settings", icon:"⚙", label:"AI Settings" },
    { id:"billing", icon:"💳", label:"Billing" },
  ];

  return (
    <Shell nav={nav} page={page} setPage={setPage} onLogout={onLogout} role="client" user={user} profile={profile}>
      {page === "overview" && (
        <div style={{ padding:32 }}>
          <PageHeader title={`Welcome, ${profile?.business_name||user.business_name}`} sub="Your AI receptionist dashboard" />

          {/* Status banner */}
          {profile && (
            <div style={{ background:profile.phone_number?"rgba(16,185,129,0.08)":"rgba(245,158,11,0.08)", border:`1px solid ${profile.phone_number?"rgba(16,185,129,0.2)":"rgba(245,158,11,0.2)"}`, borderRadius:12, padding:"14px 18px", marginBottom:24, display:"flex", alignItems:"center", gap:12 }}>
              <span style={{ fontSize:20 }}>{profile.phone_number?"✅":"⚠️"}</span>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:profile.phone_number?"#10b981":"#f59e0b" }}>
                  {profile.phone_number ? `Active: ${profile.phone_number}` : "No phone number configured"}
                </div>
                <div style={{ fontSize:11, color:"#6b7280" }}>
                  {profile.phone_number ? "Customers can call this number now" : "Contact support to get your number set up"}
                </div>
              </div>
              {profile.customer_number && (
                <div style={{ marginLeft:"auto", background:"rgba(59,130,246,0.1)", color:"#60a5fa", padding:"4px 12px", borderRadius:20, fontSize:12, fontWeight:700 }}>
                  {profile.customer_number}
                </div>
              )}
            </div>
          )}

          {/* Stats */}
          {stats && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:16, marginBottom:28 }}>
              <StatCard label="Calls This Month" value={stats.calls_this_month} color="#3b82f6" icon="📞" />
              <StatCard label="Total Calls" value={stats.total_calls} color="#10b981" icon="📊" />
              <StatCard label="Transferred" value={stats.transferred} color="#8b5cf6" icon="↗" />
              <StatCard label="Voicemails" value={stats.voicemails} color="#f59e0b" icon="📬" />
            </div>
          )}

          {/* Call limit bar */}
          {profile && (
            <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:12, padding:"18px 20px", marginBottom:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <div style={{ fontSize:13, fontWeight:600, color:"#e5e7eb" }}>Call usage this month</div>
                <div style={{ fontSize:12, color:"#6b7280" }}>{stats?.calls_this_month||0} / {profile.call_limit} calls</div>
              </div>
              <div style={{ height:6, background:"#1f2937", borderRadius:3 }}>
                <div style={{ height:"100%", background:"linear-gradient(90deg,#3b82f6,#2563eb)", borderRadius:3, width:`${Math.min(((stats?.calls_this_month||0)/profile.call_limit)*100,100)}%`, transition:"width 0.5s" }} />
              </div>
              {(stats?.calls_this_month||0) > profile.call_limit * 0.8 && (
                <div style={{ fontSize:11, color:"#f59e0b", marginTop:6 }}>⚠️ You're using 80%+ of your monthly limit — consider upgrading</div>
              )}
            </div>
          )}

          {/* Recent calls */}
          {calls.length > 0 && (
            <SectionCard title="Recent Calls">
              {calls.slice(0,5).map((c,i) => (
                <div key={i} onClick={() => setSelected(c)} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #1f2937", cursor:"pointer" }}>
                  <div style={{ width:32, height:32, borderRadius:8, background:`${STATUS_COLORS[c.status]}15`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, color:STATUS_COLORS[c.status] }}>
                    {c.status==="completed"?"✓":c.status==="transferred"?"↗":c.status==="voicemail"?"📬":"●"}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:500, color:"#e5e7eb" }}>{c.caller_name||c.caller_number||"Unknown"}</div>
                    <div style={{ fontSize:11, color:"#6b7280" }}>{c.summary?.slice(0,60)||"No summary"}</div>
                  </div>
                  <div style={{ fontSize:11, color:"#6b7280" }}>{fmtDate(c.started_at)}</div>
                </div>
              ))}
            </SectionCard>
          )}

          {selected && <CallDetailModal call={selected} onClose={() => setSelected(null)} />}
        </div>
      )}

      {page === "calls" && <CallsPage calls={calls} onSelect={setSelected} selected={selected} onClose={() => setSelected(null)} />}
      {page === "settings" && <ClientSettingsPage profile={profile} onSaved={setProfile} />}
      {page === "billing" && <ClientBillingPage profile={profile} />}
    </Shell>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SUB PAGES
// ═════════════════════════════════════════════════════════════════════════════

function AllCallsPage() {
  const [calls, setCalls] = useState([]);
  const [selected, setSelected] = useState(null);
  useEffect(() => { apiFetch("/api/calls?limit=50").then(d => setCalls(d.calls||[])).catch(console.error); }, []);
  return (
    <div style={{ padding:32 }}>
      <PageHeader title="All Calls" sub={`${calls.length} recent calls`} />
      <CallsPage calls={calls} onSelect={setSelected} selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function CallsPage({ calls, onSelect, selected, onClose }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? calls : calls.filter(c => c.status === filter);
  return (
    <div style={{ padding:32 }}>
      <div style={{ display:"flex", gap:6, marginBottom:16 }}>
        {["all","completed","transferred","voicemail"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ padding:"6px 14px", borderRadius:8, border:"none", cursor:"pointer", background:filter===f?"rgba(59,130,246,0.2)":"rgba(255,255,255,0.04)", color:filter===f?"#60a5fa":"#6b7280", fontSize:12, fontFamily:"inherit", textTransform:"capitalize" }}>{f}</button>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:selected?"1fr 380px":"1fr", gap:16 }}>
        <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:12, overflow:"hidden" }}>
          {filtered.length === 0 ? <div style={{ padding:40, textAlign:"center", color:"#4a5568" }}>No calls yet</div> :
          filtered.map((c,i) => (
            <div key={i} onClick={() => onSelect(c)} style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 18px", borderBottom:"1px solid #1a2332", cursor:"pointer", background:selected?.id===c.id?"rgba(59,130,246,0.08)":"transparent" }}>
              <div style={{ width:36, height:36, borderRadius:10, background:`${STATUS_COLORS[c.status]}15`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, color:STATUS_COLORS[c.status], flexShrink:0 }}>
                {c.status==="completed"?"✓":c.status==="transferred"?"↗":c.status==="voicemail"?"📬":"●"}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600, color:"#e5e7eb" }}>{c.caller_name||c.caller_number||"Unknown"}</div>
                <div style={{ fontSize:11, color:"#6b7280", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.summary?.slice(0,70)||"No summary"}</div>
              </div>
              <div style={{ textAlign:"right", flexShrink:0 }}>
                <div style={{ fontSize:11, color:"#6b7280" }}>{fmtDate(c.started_at)}</div>
                <div style={{ fontSize:11, padding:"2px 8px", borderRadius:10, background:`${STATUS_COLORS[c.status]}15`, color:STATUS_COLORS[c.status], marginTop:3 }}>{c.status}</div>
              </div>
            </div>
          ))}
        </div>
        {selected && <CallDetailModal call={selected} onClose={onClose} inline />}
      </div>
    </div>
  );
}

function ClientSettingsPage({ profile, onSaved }) {
  const [form, setForm] = useState({ ai_name:"Aria", ai_prompt:"", departments:{} });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile) setForm({ ai_name:profile.ai_name||"Aria", ai_prompt:profile.ai_prompt||"", departments:profile.departments||{} });
  }, [profile]);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch("/api/client/settings", { method:"PUT", body:form });
      onSaved(p => ({ ...p, ...form }));
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch(err) { alert(err.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ padding:32, maxWidth:720 }}>
      <PageHeader title="AI Settings" sub="Customise your AI receptionist" />
      <SectionCard title="AI Identity">
        <Label>AI Name</Label>
        <Input placeholder="e.g. Aria, Sophie" value={form.ai_name} onChange={v => setForm(f=>({...f,ai_name:v}))} />
      </SectionCard>
      <SectionCard title="AI Personality & Script">
        <Label>System Prompt</Label>
        <textarea value={form.ai_prompt} onChange={e => setForm(f=>({...f,ai_prompt:e.target.value}))} rows={8}
          placeholder="Tell Aria about your business, services, hours and how to handle calls..."
          style={{ width:"100%", background:"#1a2332", border:"1px solid #283548", borderRadius:8, padding:"10px 12px", color:"#e5e7eb", fontSize:13, outline:"none", resize:"vertical", fontFamily:"inherit", boxSizing:"border-box", lineHeight:1.6 }} />
      </SectionCard>
      <SectionCard title="Transfer Numbers">
        {[["sales","💼","Sales"],["support","🛠","Support"],["billing","💳","Billing"],["manager","👔","Manager"],["general","👤","General"]].map(([k,icon,label]) => (
          <div key={k} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
            <span style={{ fontSize:18, width:28 }}>{icon}</span>
            <span style={{ width:80, fontSize:12, color:"#9ca3af" }}>{label}</span>
            <Input placeholder="+44..." value={form.departments[k]||""} onChange={v => setForm(f=>({...f,departments:{...f.departments,[k]:v}}))} style={{ flex:1, marginBottom:0 }} />
          </div>
        ))}
      </SectionCard>
      <button onClick={save} disabled={saving} style={{ padding:"12px 32px", borderRadius:10, border:"none", background:saved?"#10b981":"linear-gradient(135deg,#3b82f6,#2563eb)", color:"#fff", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
        {saving?"Saving...":saved?"✓ Saved!":"Save Settings"}
      </button>
    </div>
  );
}

function ClientBillingPage({ profile }) {
  const [loading, setLoading] = useState(null);
  const plans = [
    { id:"starter", name:"Starter", price:"£49", calls:"200 calls/mo", features:["AI answering","Voicemail","Transcripts"] },
    { id:"professional", name:"Professional", price:"£149", calls:"1,000 calls/mo", features:["Everything in Starter","Human transfer","Daily reports"], popular:true },
    { id:"business", name:"Business", price:"£349", calls:"Unlimited", features:["Everything in Pro","2 numbers","Custom AI"] },
  ];

  const upgrade = async (plan) => {
    setLoading(plan);
    try {
      const { url } = await apiFetch("/api/billing/checkout", { method:"POST", body:{ plan } });
      window.location.href = url;
    } catch(err) { alert(err.message); setLoading(null); }
  };

  return (
    <div style={{ padding:32 }}>
      <PageHeader title="Billing" sub={`Current plan: ${profile?.plan||"trial"}`} />
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))", gap:16 }}>
        {plans.map(p => (
          <div key={p.id} style={{ background:p.popular?"rgba(59,130,246,0.06)":"#0d1117", border:`1px solid ${p.popular?"rgba(59,130,246,0.4)":"#1f2937"}`, borderRadius:14, padding:"24px 20px", position:"relative" }}>
            {p.popular && <div style={{ position:"absolute", top:-10, left:"50%", transform:"translateX(-50%)", background:"#3b82f6", color:"#fff", fontSize:10, fontWeight:700, padding:"3px 12px", borderRadius:20 }}>POPULAR</div>}
            <div style={{ fontSize:14, fontWeight:700, color:"#9ca3af", marginBottom:8, textTransform:"uppercase" }}>{p.name}</div>
            <div style={{ fontSize:36, fontWeight:800, color:"#f9fafb", marginBottom:4 }}>{p.price}<span style={{ fontSize:14, color:"#6b7280", fontWeight:400 }}>/mo</span></div>
            <div style={{ fontSize:12, color:"#10b981", marginBottom:16, fontWeight:600 }}>{p.calls}</div>
            {p.features.map((f,i) => <div key={i} style={{ fontSize:12, color:"#9ca3af", marginBottom:5 }}>✓ {f}</div>)}
            <button onClick={() => upgrade(p.id)} disabled={loading===p.id||profile?.plan===p.id}
              style={{ width:"100%", marginTop:16, padding:10, borderRadius:8, border:"none", background:profile?.plan===p.id?"rgba(255,255,255,0.05)":p.popular?"linear-gradient(135deg,#3b82f6,#2563eb)":"rgba(255,255,255,0.08)", color:profile?.plan===p.id?"#4a5568":"#fff", fontSize:13, fontWeight:600, cursor:profile?.plan===p.id?"default":"pointer", fontFamily:"inherit" }}>
              {loading===p.id?"...":profile?.plan===p.id?"Current Plan":"Upgrade"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RevenuePage({ customers, totalMRR }) {
  const breakdown = customers.map(c => {
    const prices = { trial:0, starter:49, professional:149, business:349 };
    return { ...c, mrr: prices[c.plan]||0 };
  }).sort((a,b) => b.mrr-a.mrr);

  return (
    <div style={{ padding:32 }}>
      <PageHeader title="Revenue" sub="Monthly recurring revenue" />
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:28 }}>
        <StatCard label="Total MRR" value={`£${totalMRR}`} color="#10b981" icon="💰" />
        <StatCard label="Paying Customers" value={customers.filter(c=>c.plan!=="trial").length} color="#3b82f6" icon="👥" />
        <StatCard label="ARR (Projected)" value={`£${totalMRR*12}`} color="#8b5cf6" icon="📈" />
      </div>
      <SectionCard title="Revenue by Customer">
        {breakdown.map((c,i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #1f2937" }}>
            <span style={{ fontSize:12, color:"#60a5fa", fontWeight:700, width:60 }}>{c.customer_number}</span>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:600, color:"#e5e7eb" }}>{c.business_name}</div>
              <PlanBadge plan={c.plan} />
            </div>
            <div style={{ fontSize:16, fontWeight:700, color:c.mrr>0?"#10b981":"#6b7280" }}>£{c.mrr}<span style={{ fontSize:11, color:"#4a5568" }}>/mo</span></div>
          </div>
        ))}
        <div style={{ display:"flex", justifyContent:"space-between", paddingTop:14, marginTop:4, borderTop:"1px solid #1f2937" }}>
          <span style={{ fontSize:14, fontWeight:700, color:"#e5e7eb" }}>Total MRR</span>
          <span style={{ fontSize:18, fontWeight:800, color:"#10b981" }}>£{totalMRR}/mo</span>
        </div>
      </SectionCard>
    </div>
  );
}

function SystemPage() {
  const [health, setHealth] = useState(null);
  useEffect(() => { apiFetch("/health").then(setHealth).catch(console.error); }, []);
  return (
    <div style={{ padding:32 }}>
      <PageHeader title="System" sub="Server health & settings" />
      {health && (
        <SectionCard title="Server Status">
          {[["Status", health.status==="ok"?"🟢 Online":"🔴 Offline"], ["Uptime", `${Math.floor(health.uptime/3600)}h ${Math.floor((health.uptime%3600)/60)}m`], ["Total Clients", health.clients]].map(([k,v]) => (
            <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #1f2937" }}>
              <span style={{ fontSize:13, color:"#6b7280" }}>{k}</span>
              <span style={{ fontSize:13, color:"#e5e7eb", fontWeight:600 }}>{v}</span>
            </div>
          ))}
        </SectionCard>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MODALS
// ═════════════════════════════════════════════════════════════════════════════

function CustomerDetailModal({ customer, onClose, onUpdate }) {
  const [c, setC] = useState(customer);
  const toggle = async (feature, val) => {
    await onUpdate(c.id, feature, val);
    setC(prev => ({ ...prev, [feature]: val }));
  };

  const features = [
    { key:"email_notifications", label:"Email Notifications", desc:"Email alert on every call" },
    { key:"call_recording", label:"Call Recording", desc:"Record all calls" },
    { key:"daily_summary", label:"Daily Summary Email", desc:"End of day call report" },
    { key:"transfer_enabled", label:"Call Transfer", desc:"Transfer to human agents" },
    { key:"sms_notifications", label:"SMS Notifications", desc:"Text alert on missed calls" },
  ];

  return (
    <Modal onClose={onClose} title={c.business_name} subtitle={c.customer_number}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
        {[["Email",c.email],["Phone",c.phone_number||"—"],["Plan",c.plan],["Calls",`${c.calls_this_month||0}/${c.call_limit||200}`],["Role",c.role||"client"],["Joined",fmtDate(c.created_at)]].map(([k,v]) => (
          <div key={k} style={{ background:"#1a2332", borderRadius:8, padding:"8px 12px" }}>
            <div style={{ fontSize:10, color:"#4a5568", textTransform:"uppercase", letterSpacing:1, marginBottom:2 }}>{k}</div>
            <div style={{ fontSize:12, color:"#e5e7eb" }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ marginBottom:16 }}>
        <div style={{ fontSize:12, fontWeight:600, color:"#9ca3af", marginBottom:10, textTransform:"uppercase", letterSpacing:1 }}>Feature Toggles</div>
        {features.map(f => (
          <div key={f.key} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #1f2937" }}>
            <div>
              <div style={{ fontSize:13, color:"#e5e7eb" }}>{f.label}</div>
              <div style={{ fontSize:11, color:"#4a5568" }}>{f.desc}</div>
            </div>
            <Toggle value={c[f.key]} onChange={v => toggle(f.key, v)} />
          </div>
        ))}
      </div>
      {c.notes && (
        <div style={{ background:"#1a2332", borderRadius:8, padding:"10px 12px", marginBottom:12 }}>
          <div style={{ fontSize:10, color:"#4a5568", textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Notes</div>
          <div style={{ fontSize:12, color:"#9ca3af" }}>{c.notes}</div>
        </div>
      )}
    </Modal>
  );
}

function AddCustomerModal({ nextNumber, onClose, onSaved }) {
  const [form, setForm] = useState({ customer_number:nextNumber, business_name:"", email:"", phone_number:"", plan:"starter", ai_name:"Aria", notes:"" });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try { await apiFetch("/api/admin/customers", { method:"POST", body:form }); onSaved(); }
    catch(err) { alert(err.message); }
    finally { setSaving(false); }
  };
  return (
    <Modal onClose={onClose} title="Add New Customer">
      {[["customer_number","Customer Number","RD-004"],["business_name","Business Name","e.g. ABC Ltd"],["email","Email","info@business.com"],["phone_number","Phone Number","+44..."],["ai_name","AI Name","Aria"]].map(([k,label,ph]) => (
        <div key={k} style={{ marginBottom:12 }}>
          <Label>{label}</Label>
          <Input placeholder={ph} value={form[k]} onChange={v => setForm(f=>({...f,[k]:v}))} />
        </div>
      ))}
      <div style={{ marginBottom:12 }}>
        <Label>Plan</Label>
        <select value={form.plan} onChange={e => setForm(f=>({...f,plan:e.target.value}))}
          style={{ width:"100%", background:"#1a2332", border:"1px solid #283548", borderRadius:8, padding:"10px 12px", color:"#e5e7eb", fontSize:13, outline:"none", fontFamily:"inherit" }}>
          <option value="trial">Free Trial</option>
          <option value="starter">Starter — £49/mo</option>
          <option value="professional">Professional — £149/mo</option>
          <option value="business">Business — £349/mo</option>
        </select>
      </div>
      <div style={{ marginBottom:16 }}>
        <Label>Notes</Label>
        <textarea value={form.notes} onChange={e => setForm(f=>({...f,notes:e.target.value}))} rows={2}
          style={{ width:"100%", background:"#1a2332", border:"1px solid #283548", borderRadius:8, padding:"10px 12px", color:"#e5e7eb", fontSize:13, outline:"none", resize:"vertical", fontFamily:"inherit", boxSizing:"border-box" }} />
      </div>
      <div style={{ display:"flex", gap:10 }}>
        <Btn label={saving?"Saving...":"Add Customer"} onClick={save} disabled={saving} />
        <button onClick={onClose} style={{ padding:"11px 20px", borderRadius:8, border:"1px solid #374151", background:"transparent", color:"#9ca3af", cursor:"pointer", fontFamily:"inherit" }}>Cancel</button>
      </div>
    </Modal>
  );
}

function CallDetailModal({ call, onClose, inline }) {
  let transcript = [];
  try { transcript = typeof call.transcript === "string" ? JSON.parse(call.transcript) : call.transcript||[]; } catch {}
  
  const content = (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
        {[["Status",call.status],["Duration",fmt(call.duration)],["Date",fmtDate(call.started_at)],["From",call.caller_number||"—"]].map(([k,v]) => (
          <div key={k} style={{ background:"#1a2332", borderRadius:8, padding:"8px 12px" }}>
            <div style={{ fontSize:10, color:"#4a5568", textTransform:"uppercase", letterSpacing:1, marginBottom:2 }}>{k}</div>
            <div style={{ fontSize:12, color:"#e5e7eb" }}>{v}</div>
          </div>
        ))}
      </div>
      {call.summary && (
        <div style={{ background:"#1a2332", borderRadius:8, padding:"10px 12px", marginBottom:12 }}>
          <div style={{ fontSize:10, color:"#4a5568", textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>AI Summary</div>
          <div style={{ fontSize:12, color:"#9ca3af", lineHeight:1.6 }}>{call.summary}</div>
        </div>
      )}
      {transcript.length > 0 && (
        <div>
          <div style={{ fontSize:10, color:"#4a5568", textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Transcript</div>
          <div style={{ maxHeight:200, overflowY:"auto", display:"flex", flexDirection:"column", gap:6 }}>
            {transcript.map((m,i) => (
              <div key={i} style={{ padding:"6px 10px", borderRadius:8, background:m.role==="user"?"rgba(59,130,246,0.1)":"rgba(139,92,246,0.1)", fontSize:11, color:"#9ca3af" }}>
                <div style={{ fontSize:9, color:m.role==="user"?"#60a5fa":"#a78bfa", marginBottom:2, textTransform:"uppercase" }}>{m.role==="user"?"Caller":"AI"}</div>
                {m.content}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (inline) return (
    <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:12, padding:20, height:"fit-content", position:"sticky", top:32 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:14 }}>
        <div style={{ fontSize:14, fontWeight:600, color:"#f9fafb" }}>{call.caller_name||call.caller_number}</div>
        <button onClick={onClose} style={{ background:"none", border:"none", color:"#6b7280", cursor:"pointer", fontSize:16 }}>✕</button>
      </div>
      {content}
    </div>
  );

  return <Modal onClose={onClose} title={call.caller_name||call.caller_number||"Unknown caller"}>{content}</Modal>;
}

// ═════════════════════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═════════════════════════════════════════════════════════════════════════════

function Shell({ nav, page, setPage, onLogout, role, user, profile, children }) {
  const roleColors = { superadmin:"#8b5cf6", admin:"#3b82f6", client:"#10b981" };
  const roleLabels = { superadmin:"Super Admin", admin:"Admin", client:"Client" };
  return (
    <div style={{ minHeight:"100vh", background:"#080c14", fontFamily:"'Sora',sans-serif", display:"flex" }}>
      <div style={{ width:220, background:"#0d1117", borderRight:"1px solid #1f2937", display:"flex", flexDirection:"column", flexShrink:0 }}>
        <div style={{ padding:"20px 16px 14px", borderBottom:"1px solid #1f2937" }}>
          <div style={{ fontSize:20, fontWeight:800, background:"linear-gradient(135deg,#fff,#60a5fa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", letterSpacing:-1 }}>RingDesk</div>
          <div style={{ fontSize:10, color:roleColors[role], marginTop:4, fontWeight:600, textTransform:"uppercase", letterSpacing:1 }}>{roleLabels[role]}</div>
          {(profile||user) && <div style={{ fontSize:11, color:"#4a5568", marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{profile?.business_name||user.business_name}</div>}
        </div>
        <nav style={{ padding:"10px 8px", flex:1 }}>
          {nav.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{ width:"100%", display:"flex", alignItems:"center", gap:10, padding:"9px 12px", borderRadius:8, border:"none", cursor:"pointer", background:page===n.id?"rgba(59,130,246,0.15)":"transparent", color:page===n.id?"#60a5fa":"#6b7280", fontSize:13, fontFamily:"inherit", textAlign:"left", marginBottom:2 }}>
              <span style={{ fontSize:14 }}>{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>
        <div style={{ padding:12, borderTop:"1px solid #1f2937" }}>
          {profile?.customer_number && <div style={{ fontSize:11, color:"#60a5fa", fontWeight:700, marginBottom:8 }}>{profile.customer_number}</div>}
          <button onClick={onLogout} style={{ width:"100%", padding:"8px", borderRadius:8, border:"1px solid #1f2937", background:"transparent", color:"#4a5568", fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>Sign out</button>
        </div>
      </div>
      <div style={{ flex:1, overflow:"auto" }}>{children}</div>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap'); ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-thumb{background:#1f2937;border-radius:2px}`}</style>
    </div>
  );
}

function Modal({ onClose, title, subtitle, children }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:50 }}>
      <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:16, padding:24, width:500, maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:18 }}>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:"#f9fafb" }}>{title}</div>
            {subtitle && <div style={{ fontSize:11, color:"#60a5fa", marginTop:2 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#6b7280", cursor:"pointer", fontSize:18 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <div onClick={() => onChange(value?0:1)} style={{ width:40, height:22, borderRadius:11, background:value?"#3b82f6":"#374151", cursor:"pointer", position:"relative", transition:"background 0.2s", flexShrink:0 }}>
      <div style={{ position:"absolute", top:2, left:value?20:2, width:18, height:18, borderRadius:"50%", background:"#fff", transition:"left 0.2s" }} />
    </div>
  );
}

function Input({ placeholder, type="text", value, onChange, onEnter, style:s={} }) {
  return (
    <input placeholder={placeholder} type={type} value={value} onChange={e => onChange(e.target.value)}
      onKeyDown={e => e.key==="Enter" && onEnter && onEnter()}
      style={{ width:"100%", background:"#1f2937", border:"1px solid #374151", borderRadius:8, padding:"10px 12px", color:"#f9fafb", fontSize:13, outline:"none", marginBottom:10, fontFamily:"inherit", boxSizing:"border-box", ...s }} />
  );
}

function Btn({ label, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ width:"100%", padding:11, borderRadius:8, border:"none", background:disabled?"#374151":"linear-gradient(135deg,#3b82f6,#2563eb)", color:"#fff", fontSize:14, fontWeight:600, cursor:disabled?"default":"pointer", fontFamily:"inherit", marginBottom:8 }}>{label}</button>
  );
}

function Label({ children }) {
  return <div style={{ fontSize:10, color:"#6b7280", marginBottom:5, textTransform:"uppercase", letterSpacing:1 }}>{children}</div>;
}

function ErrorBox({ msg }) {
  return <div style={{ color:"#ef4444", fontSize:12, marginBottom:10, padding:"8px 12px", background:"rgba(239,68,68,0.1)", borderRadius:8 }}>{msg}</div>;
}

function PageHeader({ title, sub, action }) {
  return (
    <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:24 }}>
      <div>
        <h1 style={{ fontSize:24, fontWeight:700, color:"#f9fafb", marginBottom:4, letterSpacing:-1 }}>{title}</h1>
        {sub && <div style={{ color:"#6b7280", fontSize:13 }}>{sub}</div>}
      </div>
      {action && <button onClick={action.onClick} style={{ padding:"9px 18px", borderRadius:8, border:"none", background:"linear-gradient(135deg,#3b82f6,#2563eb)", color:"#fff", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>{action.label}</button>}
    </div>
  );
}

function SectionCard({ title, children }) {
  return (
    <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:12, padding:"18px 20px", marginBottom:20 }}>
      {title && <div style={{ fontSize:13, fontWeight:600, color:"#9ca3af", marginBottom:14, textTransform:"uppercase", letterSpacing:1 }}>{title}</div>}
      {children}
    </div>
  );
}

function StatCard({ label, value, color, icon }) {
  return (
    <div style={{ background:"#0d1117", border:"1px solid #1f2937", borderRadius:12, padding:"20px 18px" }}>
      <div style={{ fontSize:22, marginBottom:8 }}>{icon}</div>
      <div style={{ fontSize:28, fontWeight:700, color }}>{value}</div>
      <div style={{ fontSize:12, color:"#6b7280", marginTop:2 }}>{label}</div>
    </div>
  );
}

function PlanBadge({ plan }) {
  return <span style={{ background:`${PLAN_COLORS[plan]||"#6b7280"}20`, color:PLAN_COLORS[plan]||"#6b7280", padding:"3px 10px", borderRadius:20, fontSize:11, fontWeight:600, textTransform:"capitalize" }}>{plan}</span>;
}

function CustomerRow({ customer:c, readonly }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #1f2937" }}>
      <span style={{ fontSize:11, color:"#60a5fa", fontWeight:700, width:60 }}>{c.customer_number}</span>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:13, fontWeight:600, color:"#e5e7eb" }}>{c.business_name}</div>
        <div style={{ fontSize:11, color:"#6b7280" }}>{c.email}</div>
      </div>
      <PlanBadge plan={c.plan} />
    </div>
  );
}
