// ── Smart SMS Logs ────────────────────────────────────────────────────────────
var currentSmsTab = 'all';

function setSmsTab(tab, btn) {
  currentSmsTab = tab;
  document.querySelectorAll('.sms-tab').forEach(function(b) {
    b.classList.remove('active', 'active-red');
  });
  if (btn) {
    btn.classList.add('active');
    if (tab === 'failed') btn.classList.add('active-red');
  }
  renderSmsLogs();
}

function updateSmsBadges() {
  var counts = { all: 0, outbound: 0, inbound: 0, after_call: 0, missed_call: 0, voicemail: 0, failed: 0 };
  allSmsLogs.forEach(function(s) {
    counts.all++;
    if (s.direction === 'outbound') counts.outbound++;
    if (s.direction === 'inbound') counts.inbound++;
    if (s.trigger === 'after_call') counts.after_call++;
    if (s.trigger === 'missed_call') counts.missed_call++;
    if (s.trigger === 'voicemail') counts.voicemail++;
    if (s.status === 'failed') counts.failed++;
  });
  Object.keys(counts).forEach(function(k) {
    var el = document.getElementById('sms-badge-' + k);
    if (el) el.textContent = counts[k];
  });
  var fb = document.getElementById('sms-badge-failed');
  if (fb) fb.className = counts.failed > 0 ? 'tab-badge tab-badge-red' : 'tab-badge';
}

function buildSmsCard(s) {
  var isInbound = s.direction === 'inbound';
  var isFailed = s.status === 'failed';
  var date = s.created_at ? new Date(s.created_at * 1000).toLocaleString('en-GB', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '-';

  var triggerLabels = {
    after_call: 'After Call',
    missed_call: 'Missed Call',
    voicemail: 'Voicemail',
    appointment: 'Appointment',
    auto_reply: 'Auto Reply',
    inbound: 'Inbound',
    test: 'Test'
  };

  var triggerColors = {
    after_call: 'rgba(0,212,255,.1)',
    missed_call: 'rgba(255,184,0,.1)',
    voicemail: 'rgba(167,139,250,.1)',
    appointment: 'rgba(0,232,122,.1)',
    auto_reply: 'rgba(0,212,255,.08)',
    inbound: 'rgba(0,212,255,.1)',
    test: 'rgba(255,255,255,.06)'
  };

  var triggerTextColors = {
    after_call: '#00d4ff',
    missed_call: '#ffb800',
    voicemail: '#a78bfa',
    appointment: '#00e87a',
    auto_reply: '#00d4ff',
    inbound: '#00d4ff',
    test: '#8896a8'
  };

  var triggerLabel = triggerLabels[s.trigger] || s.trigger || 'Unknown';
  var triggerBg = triggerColors[s.trigger] || 'rgba(255,255,255,.06)';
  var triggerColor = triggerTextColors[s.trigger] || '#8896a8';

  var dirIcon = isInbound
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>';

  var fromNum = s.from_number || '—';
  var toNum = s.to_number || '—';
  var msgPreview = (s.body || '').replace(/\n/g, ' ').trim();
  var msgFull = s.body || '';
  var sid = s.id;

  var cardBorderColor = isFailed ? 'var(--red)' : isInbound ? '#00d4ff' : 'var(--border)';
  var cardBorderLeft = isFailed ? '3px solid var(--red)' : isInbound ? '3px solid rgba(0,212,255,.4)' : '3px solid var(--border)';

  var html = '<div class="sms-card-item" style="border-left:' + cardBorderLeft + '">' +
    '<div class="sms-card-top">' +
      '<div class="sms-card-left">' +
        '<div class="sms-avatar" style="background:' + (isInbound ? 'rgba(0,212,255,.1)' : 'rgba(0,232,122,.08)') + ';color:' + (isInbound ? '#00d4ff' : '#00e87a') + '">' +
          (isInbound
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>') +
        '</div>' +
        '<div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span class="sms-card-dir" style="color:' + (isInbound ? '#00d4ff' : '#00e87a') + '">' + (isInbound ? 'Inbound' : 'Outbound') + '</span>' +
            '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:' + triggerBg + ';color:' + triggerColor + '">' + triggerLabel + '</span>' +
            (isFailed ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(255,68,102,.1);color:var(--red)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Failed</span>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:12px;color:var(--muted)">' +
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg>' +
            '<span>' + fromNum + '</span>' +
            '<span style="color:var(--dim)">→</span>' +
            '<span>' + toNum + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sms-card-right">' +
        '<span style="font-size:11px;color:var(--dim)">' + date + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="sms-msg-preview">' + msgPreview.substring(0, 180) + (msgPreview.length > 180 ? '...' : '') + '</div>' +
    '<div class="sms-card-actions">' +
      '<button class="call-action-btn" onclick="viewSmsById(' + sid + ')">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View' +
      '</button>' +
      (toNum && toNum !== '—' ?
        '<a href="tel:' + (isInbound ? fromNum : toNum) + '" class="call-action-btn btn-call">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg>Call Back</a>' : '') +
      '<button class="call-action-btn btn-del" data-sms-del="' + sid + '">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>Delete' +
      '</button>' +
    '</div>' +
  '</div>';

  return html;
}

function viewSmsById(id) {
  var s = allSmsLogs.find(function(x) { return x.id === id; });
  if (!s) return;
  var dirColors = { outbound: 'var(--green)', inbound: 'var(--cyan)' };
  var date = s.created_at ? new Date(s.created_at * 1000).toLocaleString('en-GB') : '-';
  viewSmsMessage(s.body || '', dirColors[s.direction] || 'var(--muted)', date);
}

function renderSmsLogs() {
  var filtered = allSmsLogs;
  var tab = currentSmsTab || 'all';
  var searchEl = document.getElementById('smsSearch');
  var search = searchEl ? searchEl.value.toLowerCase().trim() : '';

  if (tab === 'outbound') filtered = allSmsLogs.filter(function(s) { return s.direction === 'outbound'; });
  else if (tab === 'inbound') filtered = allSmsLogs.filter(function(s) { return s.direction === 'inbound'; });
  else if (tab === 'after_call') filtered = allSmsLogs.filter(function(s) { return s.trigger === 'after_call'; });
  else if (tab === 'missed_call') filtered = allSmsLogs.filter(function(s) { return s.trigger === 'missed_call'; });
  else if (tab === 'voicemail') filtered = allSmsLogs.filter(function(s) { return s.trigger === 'voicemail'; });
  else if (tab === 'failed') filtered = allSmsLogs.filter(function(s) { return s.status === 'failed'; });

  if (typeof smsDateFrom !== 'undefined' && smsDateFrom) filtered = filtered.filter(function(s) { return s.created_at >= smsDateFrom; });
  if (typeof smsDateTo !== 'undefined' && smsDateTo) filtered = filtered.filter(function(s) { return s.created_at <= smsDateTo; });

  if (search) {
    filtered = filtered.filter(function(s) {
      return (s.from_number || '').includes(search) ||
             (s.to_number || '').includes(search) ||
             (s.body || '').toLowerCase().includes(search);
    });
  }

  var subtitle = document.getElementById('smsLogsSubTitle');
  if (subtitle) subtitle.textContent = filtered.length + ' messages';

  var container = document.getElementById('smsCardsContainer');
  var tbody = document.getElementById('smsLogsTableBody');

  var emptyMsg = {
    all: 'No SMS messages yet.',
    outbound: 'No outbound messages.',
    inbound: 'No inbound messages.',
    after_call: 'No after-call SMS sent.',
    missed_call: 'No missed call alerts.',
    voicemail: 'No voicemail alerts.',
    failed: 'No failed messages — all good! ✅'
  };

  if (!container) {
    // Fallback to old table
    if (!tbody) return;
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--muted)">' + (emptyMsg[tab] || 'No messages') + '</td></tr>';
      return;
    }
    var triggerLabels = {missed_call:'📵 Missed Call',voicemail:'📬 Voicemail',after_call:'📋 After Call',appointment:'📅 Appointment',auto_reply:'🤖 Auto Reply',inbound:'📨 Inbound',test:'🧪 Test'};
    tbody.innerHTML = filtered.map(function(s) {
      var date = s.created_at ? new Date(s.created_at*1000).toLocaleString('en-GB') : '-';
      return '<tr><td>' + (s.direction||'-') + '</td><td>' + (s.from_number||'-') + '</td><td>' + (s.to_number||'-') + '</td>' +
        '<td>' + ((s.body||'').substring(0,60)) + '</td><td>' + (triggerLabels[s.trigger]||s.trigger||'-') + '</td>' +
        '<td>' + (s.status||'-') + '</td><td>' + date + '</td>' +
        '<td><button data-sms-view="'+s.id+'">View</button><button data-sms-del="'+s.id+'">Delete</button></td></tr>';
    }).join('');
    return;
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--muted);font-size:14px">' +
      '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:0 auto 16px;opacity:.3"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' +
      (emptyMsg[tab] || 'No messages found.') + '</div>';
    return;
  }

  container.innerHTML = filtered.map(function(s) { return buildSmsCard(s); }).join('');
  updateSmsBadges();
}
