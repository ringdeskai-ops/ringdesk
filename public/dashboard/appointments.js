// ── Smart Appointments ────────────────────────────────────────────────────────
var currentApptTab = 'pending';

function setApptTab(tab, btn) {
  currentApptTab = tab;
  document.querySelectorAll('.appt-tab').forEach(function(b) {
    b.classList.remove('active', 'active-green', 'active-red');
  });
  if (btn) {
    btn.classList.add('active');
    if (tab === 'pending') btn.classList.add('active-green');
    if (tab === 'cancelled') btn.classList.add('active-red');
  }
  renderAppointments();
}

function updateApptBadges() {
  var counts = { all: 0, pending: 0, confirmed: 0, cancelled: 0, completed: 0 };
  allAppointments.forEach(function(a) {
    counts.all++;
    if (counts[a.status] !== undefined) counts[a.status]++;
  });
  Object.keys(counts).forEach(function(k) {
    var el = document.getElementById('appt-badge-' + k);
    if (el) el.textContent = counts[k];
  });
  // Update existing stat elements too
  var p = document.getElementById('apptPending');
  var c = document.getElementById('apptConfirmed');
  var x = document.getElementById('apptCancelled');
  if (p) p.textContent = counts.pending;
  if (c) c.textContent = counts.confirmed;
  if (x) x.textContent = counts.cancelled;
  // Red/green badges
  var pb = document.getElementById('appt-badge-pending');
  if (pb) pb.className = counts.pending > 0 ? 'tab-badge tab-badge-green' : 'tab-badge';
  var cb = document.getElementById('appt-badge-cancelled');
  if (cb) cb.className = counts.cancelled > 0 ? 'tab-badge tab-badge-red' : 'tab-badge';
}

function isOverdue(a) {
  if (!a.date) return false;
  var apptDate = new Date(a.date + (a.time ? 'T' + a.time : 'T00:00'));
  return apptDate < new Date() && a.status === 'pending';
}

function isToday(a) {
  if (!a.date) return false;
  var today = new Date().toISOString().split('T')[0];
  return a.date === today;
}

function isTomorrow(a) {
  if (!a.date) return false;
  var tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  return a.date === tomorrow;
}

function fmtApptDate(dateStr, timeStr) {
  if (!dateStr) return '—';
  var d = new Date(dateStr + (timeStr ? 'T' + timeStr : 'T00:00'));
  var options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
  var dateDisplay = d.toLocaleDateString('en-GB', options);
  var timeDisplay = timeStr ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  return dateDisplay + (timeDisplay ? ' at ' + timeDisplay : '');
}

function buildApptCard(a) {
  var overdue = isOverdue(a);
  var today = isToday(a);
  var tomorrow = isTomorrow(a);
  var aid = a.id;
  var phone = a.caller_phone || '';

  // Status config
  var statusConfig = {
    pending:   { color: '#ffb800', bg: 'rgba(255,184,0,.1)',   label: 'Pending',   icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' },
    confirmed: { color: '#00e87a', bg: 'rgba(0,232,122,.1)',   label: 'Confirmed', icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' },
    cancelled: { color: '#ff4466', bg: 'rgba(255,68,102,.1)',  label: 'Cancelled', icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' },
    completed: { color: '#8896a8', bg: 'rgba(136,150,168,.1)', label: 'Completed', icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' }
  };
  var sc = statusConfig[a.status] || statusConfig.pending;

  // Border color
  var borderLeft = overdue ? '3px solid #ff4466' :
                   today ? '3px solid #00d4ff' :
                   a.status === 'confirmed' ? '3px solid #00e87a' :
                   a.status === 'cancelled' ? '3px solid rgba(255,68,102,.3)' :
                   '3px solid rgba(255,184,0,.4)';

  // Date badge
  var dateBadge = '';
  if (overdue) {
    dateBadge = '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(255,68,102,.1);color:#ff4466"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Overdue</span>';
  } else if (today) {
    dateBadge = '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(0,212,255,.1);color:#00d4ff"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Today</span>';
  } else if (tomorrow) {
    dateBadge = '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(255,184,0,.1);color:#ffb800">Tomorrow</span>';
  }

  // Avatar
  var initial = (a.caller_name || '?')[0].toUpperCase();
  var avatarBg = overdue ? 'rgba(255,68,102,.15)' : today ? 'rgba(0,212,255,.15)' : 'rgba(255,184,0,.1)';
  var avatarColor = overdue ? '#ff4466' : today ? '#00d4ff' : '#ffb800';

  // Google Calendar link
  var gcLink = a.google_event_id ?
    '<a href="https://calendar.google.com" target="_blank" rel="noopener" class="call-action-btn">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Calendar</a>' : '';

  // Action buttons based on status
  var confirmBtn = a.status === 'pending' ?
    '<button class="call-action-btn btn-done" onclick="updateApptStatus(\'' + aid + '\',\'confirmed\',this)">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Confirm</button>' : '';

  var cancelBtn = (a.status === 'pending' || a.status === 'confirmed') ?
    '<button class="call-action-btn btn-block" onclick="updateApptStatus(\'' + aid + '\',\'cancelled\',this)">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Cancel</button>' : '';

  var completeBtn = a.status === 'confirmed' ?
    '<button class="call-action-btn" onclick="updateApptStatus(\'' + aid + '\',\'completed\',this)">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>Complete</button>' : '';

  var callBtn = phone ?
    '<a href="tel:' + phone + '" class="call-action-btn btn-call">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg>Call Client</a>' : '';

  var deleteBtn =
    '<button class="call-action-btn btn-del" onclick="deleteAppt(\'' + aid + '\',this)">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>Delete</button>';

  return '<div class="appt-card-item" style="border-left:' + borderLeft + '" data-appt-id="' + aid + '">' +
    '<div class="appt-card-top">' +
      '<div class="appt-card-left">' +
        '<div class="call-avatar-lg" style="background:' + avatarBg + ';color:' + avatarColor + '">' + initial + '</div>' +
        '<div>' +
          '<div class="appt-card-name">' + (a.caller_name || 'Unknown') + '</div>' +
          '<div class="appt-card-phone">' +
            (phone ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg> ' + phone : '—') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="appt-card-right">' +
        dateBadge +
        '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;background:' + sc.bg + ';color:' + sc.color + '">' + sc.icon + sc.label + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="appt-date-box">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
      '<span>' + fmtApptDate(a.date, a.time) + '</span>' +
    '</div>' +
    '<div class="call-actions">' +
      confirmBtn + completeBtn + callBtn + gcLink + cancelBtn + deleteBtn +
    '</div>' +
  '</div>';
}

function renderAppointments() {
  var filtered = allAppointments;
  var tab = currentApptTab || 'all';
  var searchEl = document.getElementById('apptSearch');
  var search = searchEl ? searchEl.value.toLowerCase().trim() : '';

  if (tab !== 'all') {
    filtered = allAppointments.filter(function(a) { return a.status === tab; });
  }

  if (search) {
    filtered = filtered.filter(function(a) {
      return (a.caller_name || '').toLowerCase().includes(search) ||
             (a.caller_phone || '').includes(search);
    });
  }

  // Sort: overdue first, then by date ascending
  filtered.sort(function(a, b) {
    var aOver = isOverdue(a) ? 0 : 1;
    var bOver = isOverdue(b) ? 0 : 1;
    if (aOver !== bOver) return aOver - bOver;
    return (a.date || '').localeCompare(b.date || '');
  });

  var subtitle = document.getElementById('apptSubTitle');
  if (subtitle) subtitle.textContent = filtered.length + ' appointments';

  var container = document.getElementById('apptCardsContainer');
  var tbody = document.getElementById('apptsTableBody');

  var emptyMsg = {
    all: 'No appointments yet. Your AI books them automatically during calls.',
    pending: 'No pending appointments.',
    confirmed: 'No confirmed appointments.',
    cancelled: 'No cancelled appointments.',
    completed: 'No completed appointments.'
  };

  updateApptBadges();

  if (!container) {
    // Fallback to old table
    if (!tbody) return;
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--muted)">' + (emptyMsg[tab] || 'No appointments') + '</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map(function(a) {
      return '<tr><td>' + (a.caller_name||'—') + '</td><td>' + (a.date||'—') + '</td><td>' + (a.time||'—') + '</td>' +
        '<td>' + (a.caller_phone||'—') + '</td><td>' + (a.status||'—') + '</td>' +
        '<td><button onclick="updateApptStatus(\'' + a.id + '\',\'confirmed\',this)">Confirm</button>' +
        '<button onclick="deleteAppt(\'' + a.id + '\',this)">Delete</button></td></tr>';
    }).join('');
    return;
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--muted);font-size:14px">' +
      '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:0 auto 16px;opacity:.3"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
      (emptyMsg[tab] || 'No appointments found.') + '</div>';
    return;
  }

  container.innerHTML = filtered.map(function(a) { return buildApptCard(a); }).join('');
}

function updateApptStatus(id, newStatus, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  api('/api/appointments/' + id + '/status', { method: 'PUT', body: JSON.stringify({ status: newStatus }) })
    .then(function() {
      var a = allAppointments.find(function(x) { return x.id === id; });
      if (a) a.status = newStatus;
      renderAppointments();
    })
    .catch(function() {
      // Update locally even if API fails
      var a = allAppointments.find(function(x) { return x.id === id; });
      if (a) a.status = newStatus;
      renderAppointments();
    });
}

function deleteAppt(id, btn) {
  if (!confirm('Delete this appointment? This cannot be undone.')) return;
  if (btn) { btn.disabled = true; }
  api('/api/appointments/' + id, { method: 'DELETE' })
    .then(function() {
      allAppointments = allAppointments.filter(function(x) { return x.id !== id; });
      renderAppointments();
    })
    .catch(function() {
      allAppointments = allAppointments.filter(function(x) { return x.id !== id; });
      renderAppointments();
    });
}
