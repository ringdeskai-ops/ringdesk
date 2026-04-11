// ── Smart Leads CRM ───────────────────────────────────────────────────────────
var currentLeadTab = 'new';
var allLeads = [];
var allCallLeads = [];

function loadAllLeads() {
  var token = localStorage.getItem('ard_token');
  if (!token) {
    // Try api() helper if available
    if (typeof api === 'function') {
      api('/api/leads').then(function(data) {
        if (!data) return;
        allLeads = data.leads || [];
        buildCallLeads();
        renderLeadsPage();
        updateLeadStats();
      });
      return;
    }
    return;
  }
  var container = document.getElementById('leadsCardsContainer');
  if (container) container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Loading leads...</div>';
  fetch('/api/leads', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      allLeads = data.leads || [];
      buildCallLeads();
      renderLeadsPage();
      updateLeadStats();
    })
    .catch(function(e) {
      console.error('Failed to load leads:', e);
      var c = document.getElementById('leadsCardsContainer');
      if (c) c.innerHTML = '<div style="text-align:center;padding:40px;color:var(--red)">Failed to load leads. Try refreshing.</div>';
    });
}

function buildCallLeads() {
  var calls = typeof allCalls !== 'undefined' ? allCalls : [];
  allCallLeads = calls
    .filter(function(c) {
      return c.status !== 'active' && (c.duration||0) > 10;
    })
    .map(function(c) {
      return {
        id: 'call_' + c.id,
        call_id: c.id,
        first_name: c.caller_name || 'Unknown caller',
        last_name: '',
        phone: c.caller_number || '',
        message: c.summary || '',
        status: 'new',
        source: 'call',
        priority: 'warm',
        notes: '',
        created_at: c.started_at
      };
    });
}

function getLeadPriorityConfig(priority) {
  var config = {
    hot:  { color: '#ff4466', bg: 'rgba(255,68,102,.1)',  label: '🔴 Hot',  border: '3px solid rgba(255,68,102,.5)' },
    warm: { color: '#ffb800', bg: 'rgba(255,184,0,.1)',   label: '🟡 Warm', border: '3px solid rgba(255,184,0,.4)' },
    cold: { color: '#6699ff', bg: 'rgba(102,153,255,.1)', label: '🔵 Cold', border: '3px solid rgba(102,153,255,.3)' }
  };
  return config[priority] || config.warm;
}

function getLeadStatusConfig(status) {
  var config = {
    new:        { color: '#00d4ff', bg: 'rgba(0,212,255,.1)',   label: 'New' },
    contacted:  { color: '#ffb800', bg: 'rgba(255,184,0,.1)',   label: 'Contacted' },
    followup:   { color: '#a78bfa', bg: 'rgba(167,139,250,.1)', label: 'Follow-up' },
    converted:  { color: '#00e87a', bg: 'rgba(0,232,122,.1)',   label: 'Converted' },
    lost:       { color: '#ff4466', bg: 'rgba(255,68,102,.1)',  label: 'Lost' }
  };
  return config[status] || config.new;
}

function updateLeadStats() {
  var combined = allLeads.concat(allCallLeads);
  var total = combined.length;
  var newCount = combined.filter(function(l) { return l.status === 'new'; }).length;
  var followup = combined.filter(function(l) { return l.status === 'followup' || l.status === 'contacted'; }).length;
  var converted = combined.filter(function(l) { return l.status === 'converted'; }).length;
  var hot = combined.filter(function(l) { return l.priority === 'hot'; }).length;

  var el = function(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
  el('leadsTotal', total);
  el('leadsNew', newCount);
  el('leadsFollowup', followup);
  el('leadsConverted', converted);

  // Update tab badges
  el('lead-badge-all', total);
  el('lead-badge-new', newCount);
  el('lead-badge-hot', hot);
  el('lead-badge-followup', followup);
  el('lead-badge-converted', converted);
  el('lead-badge-website', allLeads.filter(function(l){ return l.source === 'website'; }).length);
  el('lead-badge-call', allCallLeads.length);

  // Red badge for hot
  var hb = document.getElementById('lead-badge-hot');
  if (hb) hb.className = hot > 0 ? 'tab-badge tab-badge-red' : 'tab-badge';
  var nb = document.getElementById('lead-badge-new');
  if (nb) nb.className = newCount > 0 ? 'tab-badge tab-badge-cyan' : 'tab-badge';
}

function setLeadTab(tab, btn) {
  currentLeadTab = tab;
  document.querySelectorAll('.lead-tab').forEach(function(b) {
    b.classList.remove('active', 'active-red', 'active-cyan');
  });
  if (btn) {
    btn.classList.add('active');
    if (tab === 'hot') btn.classList.add('active-red');
    if (tab === 'new') btn.classList.add('active-cyan');
  }
  renderLeadsPage();
}

function buildLeadCard(l) {
  var pc = getLeadPriorityConfig(l.priority || 'warm');
  var sc = getLeadStatusConfig(l.status || 'new');
  var lid = l.id;
  var isCall = l.source === 'call';
  var phone = l.phone || l.caller_number || '';
  var name = ((l.first_name || '') + ' ' + (l.last_name || '')).trim() || 'Unknown';
  var date = l.created_at ? new Date(l.created_at * 1000).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) : '—';
  var initial = name[0].toUpperCase();
  var msgPreview = (l.message || '').replace(/\n/g,' ').substring(0, 120);

  // Source badge
  var sourceBadge = isCall
    ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(0,212,255,.08);color:#00d4ff"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg>Call</span>'
    : '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(0,232,122,.08);color:#00e87a"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg>Website</span>';

  // Priority selector
  var priorSelect = '<select class="lead-priority-select" onchange="updateLeadPriority(\'' + lid + '\',this.value,this)" style="background:' + pc.bg + ';border:1px solid ' + pc.color + '33;color:' + pc.color + ';padding:2px 6px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;outline:none">' +
    '<option value="hot"' + (l.priority==='hot'?' selected':'') + '>🔴 Hot</option>' +
    '<option value="warm"' + (l.priority==='warm'||!l.priority?' selected':'') + '>🟡 Warm</option>' +
    '<option value="cold"' + (l.priority==='cold'?' selected':'') + '>🔵 Cold</option>' +
    '</select>';

  // Status selector
  var statusSelect = '<select class="lead-status-select" onchange="updateLeadStatus(\'' + lid + '\',this.value,this)" style="background:' + sc.bg + ';border:1px solid ' + sc.color + '33;color:' + sc.color + ';padding:2px 6px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;outline:none">' +
    '<option value="new"' + (l.status==='new'?' selected':'') + '>New</option>' +
    '<option value="contacted"' + (l.status==='contacted'?' selected':'') + '>Contacted</option>' +
    '<option value="followup"' + (l.status==='followup'?' selected':'') + '>Follow-up</option>' +
    '<option value="converted"' + (l.status==='converted'?' selected':'') + '>Converted</option>' +
    '<option value="lost"' + (l.status==='lost'?' selected':'') + '>Lost</option>' +
    '</select>';

  // Notes
  var notesHtml = '<div class="lead-notes-row">' +
    '<input type="text" class="lead-notes-input" placeholder="Add a note..." value="' + (l.notes||'').replace(/"/g,'&quot;') + '" ' +
    'onblur="saveLeadNote(\'' + lid + '\',this.value)" ' +
    'onkeydown="if(event.key===\'Enter\')saveLeadNote(\'' + lid + '\',this.value)" ' +
    'style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:7px;font-size:12px;font-family:inherit;outline:none;flex:1"/>' +
    '</div>';

  // Action buttons
  var callBtn = phone ? '<a href="tel:' + phone + '" class="call-action-btn btn-call"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg>Call</a>' : '';

  var convertBtn = l.status !== 'converted' ? '<button class="call-action-btn btn-done" onclick="convertLead(\'' + lid + '\',this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Convert</button>' : '<span style="font-size:11px;color:var(--green);font-weight:700">✅ Converted</span>';

  var viewCallBtn = isCall && l.call_id ? '<button class="call-action-btn" onclick="openCallDetail(\'' + l.call_id + '\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View Call</button>' : '';

  var deleteBtn = !isCall ? '<button class="call-action-btn btn-del" onclick="deleteLead(\'' + lid + '\',this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>Delete</button>' : '';

  return '<div class="lead-card-item" style="border-left:' + pc.border + '" data-lead-id="' + lid + '">' +
    '<div class="lead-card-top">' +
      '<div class="lead-card-left">' +
        '<div class="call-avatar-lg" style="background:' + pc.bg + ';color:' + pc.color + '">' + initial + '</div>' +
        '<div>' +
          '<div class="lead-card-name">' + name + '</div>' +
          '<div class="lead-card-meta">' +
            (phone ? '<span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg> ' + phone + '</span>' : '') +
            (l.email ? '<span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> ' + l.email + '</span>' : '') +
            (l.business_name ? '<span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3H8a2 2 0 00-2 2v2h12V5a2 2 0 00-2-2z"/></svg> ' + l.business_name + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="lead-card-right">' +
        sourceBadge +
        priorSelect +
        statusSelect +
        '<span style="font-size:11px;color:var(--dim)">' + date + '</span>' +
      '</div>' +
    '</div>' +
    (msgPreview ? '<div class="lead-msg-preview">' + msgPreview + (l.message && l.message.length > 120 ? '...' : '') + '</div>' : '') +
    notesHtml +
    '<div class="call-actions">' +
      callBtn + convertBtn + viewCallBtn + deleteBtn +
    '</div>' +
  '</div>';
}

function renderLeadsPage() {
  var tab = currentLeadTab;
  var searchEl = document.getElementById('leadSearch');
  var search = searchEl ? searchEl.value.toLowerCase().trim() : '';

  // Get combined leads based on tab
  var filtered = [];
  if (tab === 'website') {
    filtered = allLeads.slice();
  } else if (tab === 'call') {
    filtered = allCallLeads.slice();
  } else {
    filtered = allLeads.concat(allCallLeads);
  }

  // Filter by tab status
  if (tab === 'hot') filtered = filtered.filter(function(l) { return l.priority === 'hot'; });
  else if (tab === 'new') filtered = filtered.filter(function(l) { return l.status === 'new'; });
  else if (tab === 'followup') filtered = filtered.filter(function(l) { return l.status === 'followup' || l.status === 'contacted'; });
  else if (tab === 'converted') filtered = filtered.filter(function(l) { return l.status === 'converted'; });

  // Search
  if (search) {
    filtered = filtered.filter(function(l) {
      return ((l.first_name||'') + ' ' + (l.last_name||'')).toLowerCase().includes(search) ||
             (l.phone||'').includes(search) ||
             (l.email||'').toLowerCase().includes(search) ||
             (l.business_name||'').toLowerCase().includes(search);
    });
  }

  // Sort: hot first, then by date desc
  filtered.sort(function(a, b) {
    var pOrder = { hot: 0, warm: 1, cold: 2 };
    var pa = pOrder[a.priority||'warm'];
    var pb = pOrder[b.priority||'warm'];
    if (pa !== pb) return pa - pb;
    return (b.created_at||0) - (a.created_at||0);
  });

  var container = document.getElementById('leadsCardsContainer');
  if (!container) return;

  var emptyMsg = {
    all: 'No leads yet. Leads are created from calls and website enquiries.',
    hot: 'No hot leads right now.',
    new: 'No new leads.',
    followup: 'No leads need following up.',
    converted: 'No converted leads yet — keep going!',
    website: 'No website enquiries yet.',
    call: 'No call-based leads yet.'
  };

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--muted);font-size:14px">' +
      '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:0 auto 16px;opacity:.3"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>' +
      (emptyMsg[tab] || 'No leads found.') + '</div>';
    return;
  }

  container.innerHTML = filtered.map(function(l) { return buildLeadCard(l); }).join('');
  updateLeadStats();
}

function updateLeadPriority(id, priority, selectEl) {
  var token = localStorage.getItem('ard_token');
  if (!token || id.startsWith('call_')) {
    // Update local call lead
    var lead = allCallLeads.find(function(l) { return l.id === id; });
    if (lead) lead.priority = priority;
    renderLeadsPage();
    return;
  }
  fetch('/api/leads/priority', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, priority: priority })
  }).then(function() {
    var lead = allLeads.find(function(l) { return l.id === id; });
    if (lead) lead.priority = priority;
    renderLeadsPage();
  });
}

function updateLeadStatus(id, status, selectEl) {
  var token = localStorage.getItem('ard_token');
  if (!token || id.startsWith('call_')) {
    var lead = allCallLeads.find(function(l) { return l.id === id; });
    if (lead) lead.status = status;
    renderLeadsPage();
    return;
  }
  fetch('/api/leads/status', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, status: status })
  }).then(function() {
    var lead = allLeads.find(function(l) { return l.id === id; });
    if (lead) lead.status = status;
    renderLeadsPage();
    updateLeadStats();
  });
}

function saveLeadNote(id, notes) {
  var token = localStorage.getItem('ard_token');
  if (!token || id.startsWith('call_')) return;
  fetch('/api/leads/notes', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, notes: notes })
  }).then(function() {
    var lead = allLeads.find(function(l) { return l.id === id; });
    if (lead) lead.notes = notes;
  });
}

function convertLead(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Converting...'; }
  updateLeadStatus(id, 'converted', null);
  setTimeout(function() { renderLeadsPage(); }, 400);
}

function deleteLead(id, btn) {
  if (!confirm('Delete this lead? This cannot be undone.')) return;
  var token = localStorage.getItem('ard_token');
  if (!token) return;
  if (btn) { btn.disabled = true; }
  fetch('/api/leads/' + id, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(function() {
    allLeads = allLeads.filter(function(l) { return l.id !== id; });
    renderLeadsPage();
    updateLeadStats();
  });
}

// Override old renderLeads to use new system
function renderLeads() {
  if (typeof loadAllLeads === 'function') loadAllLeads();
}
