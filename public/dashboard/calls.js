// ── Smart Call Logs ───────────────────────────────────────────────────────────
var currentCallTab = 'action';

function callNeedsAction(c) {
  if (!c.summary) return false;
  var s = c.summary.toLowerCase();
  return s.includes('action needed') || s.includes('call back') ||
         s.includes('team to call') || s.includes('not established') ||
         s.includes('not stated') || s.includes('callback') ||
         s.includes('follow up') || s.includes('follow-up') ||
         s.includes('speak to') || s.includes('wanted to speak');
}

function callIsJunk(c) {
  return (c.duration !== null && c.duration <= 10) ||
         (c.summary && c.summary.toLowerCase().includes("don't see a transcript")) ||
         (c.summary && c.summary.toLowerCase().includes("no transcript"));
}

function callIsTransferred(c) { return !!c.transferred_to; }
function callIsVoicemail(c) { return c.status === 'voicemail'; }

function getCallPriority(c) {
  if (callIsJunk(c)) return 'junk';
  if (callNeedsAction(c)) return 'high';
  if (callIsTransferred(c)) return 'med';
  return 'low';
}

function parseSummary(summary) {
  if (!summary) return {};
  var result = {};
  var lines = summary.split('\n');
  var currentKey = null;
  var currentVal = [];
  lines.forEach(function(line) {
    line = line.trim();
    if (!line) return;
    var match = line.match(/^([^:]{1,40}):\s*(.*)$/);
    if (match) {
      if (currentKey) result[currentKey.trim()] = currentVal.join(' ').trim();
      currentKey = match[1];
      currentVal = [match[2]];
    } else if (currentKey) {
      currentVal.push(line);
    }
  });
  if (currentKey) result[currentKey.trim()] = currentVal.join(' ').trim();
  return result;
}

function setCallTab(tab, btn) {
  currentCallTab = tab;
  document.querySelectorAll('.call-tab').forEach(function(b) {
    b.classList.remove('active', 'active-red');
  });
  if (btn) {
    btn.classList.add('active');
    if (tab === 'action') btn.classList.add('active-red');
  }
  renderCalls();
}

function updateCallBadges() {
  var action = 0, completed = 0, transferred = 0, voicemail = 0, junk = 0;
  allCalls.forEach(function(c) {
    if (callIsJunk(c)) { junk++; return; }
    if (callIsVoicemail(c)) { voicemail++; return; }
    if (callIsTransferred(c)) { transferred++; return; }
    if (callNeedsAction(c)) { action++; return; }
    completed++;
  });
  var ba = document.getElementById('badge-action');
  var bc = document.getElementById('badge-completed');
  var bt = document.getElementById('badge-transferred');
  var bv = document.getElementById('badge-voicemail');
  var bj = document.getElementById('badge-junk');
  var ball = document.getElementById('badge-all');
  if (ba) { ba.textContent = action; ba.className = action > 0 ? 'tab-badge tab-badge-red' : 'tab-badge'; }
  if (bc) bc.textContent = completed;
  if (bt) bt.textContent = transferred;
  if (bv) bv.textContent = voicemail;
  if (bj) bj.textContent = junk;
  if (ball) ball.textContent = allCalls.length;
}

function buildCallCard(c) {
  var priority = getCallPriority(c);
  var parsed = parseSummary(c.summary);
  var dur = c.duration || 0;
  var durClass = dur > 60 ? 'call-dur-long' : dur > 15 ? 'call-dur-med' : 'call-dur-short';
  var avatarBg = priority === 'high' ? 'rgba(255,68,102,.15)' : priority === 'med' ? 'rgba(0,212,255,.15)' : 'rgba(255,255,255,.06)';
  var avatarColor = priority === 'high' ? '#ff6b6b' : priority === 'med' ? '#00d4ff' : '#8896a8';
  var initial = (c.caller_name || c.caller_number || '?')[0].toUpperCase();
  var cid = c.id;
  var phoneNum = c.caller_number || '';

  // Build summary
  var summaryRows = '';
  var wantKey = Object.keys(parsed).find(function(k) { return k.toLowerCase().includes('wants') || k.toLowerCase().includes('requirement'); });
  var actionKey = Object.keys(parsed).find(function(k) { return k.toLowerCase().includes('action'); });

  if (wantKey && parsed[wantKey] && parsed[wantKey] !== 'Not established in this call.' && parsed[wantKey] !== 'Not stated in the call.') {
    summaryRows += '<div class="call-summary-row"><span class="call-summary-label">Wants:</span><span class="call-summary-val">' + parsed[wantKey] + '</span></div>';
  }
  if (actionKey && parsed[actionKey]) {
    summaryRows += '<div class="call-summary-row"><span class="call-summary-label">Action:</span><span class="call-summary-val urgent">' + parsed[actionKey] + '</span></div>';
  }
  if (!summaryRows && c.summary) {
    var short = c.summary.replace(/\n/g, ' ').substring(0, 120);
    summaryRows = '<div class="call-summary-row"><span class="call-summary-val" style="color:var(--muted)">' + short + (c.summary.length > 120 ? '...' : '') + '</span></div>';
  }

  // Build priority badge
  var priorityBadge = '';
  if (priority === 'high') {
    priorityBadge = '<div style="display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;background:rgba(255,68,102,.1);color:#ff6b6b;font-size:11px;font-weight:700">' +
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
      'Needs Action</div>';
  } else if (c.transferred_to) {
    priorityBadge = '<div style="display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;background:rgba(0,212,255,.1);color:#00d4ff;font-size:11px;font-weight:700">' +
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><path d="M10 14L21 3"/><path d="M21 16v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5"/></svg>' +
      'Transferred</div>';
  }

  // Build action buttons
  var markDoneBtn = priority === 'high' ?
    '<button class="call-action-btn btn-done" onclick="markCallDone(\'' + cid + '\',this)">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Mark Done</button>' : '';

  var callBackBtn = phoneNum ?
    '<a href="tel:' + phoneNum + '" class="call-action-btn btn-call">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg>Call Back</a>' : '';

  var blockBtn = priority !== 'junk' && phoneNum ?
    '<button class="call-action-btn btn-block" onclick="blockCallNumber(\'' + phoneNum + '\',this)">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>Block</button>' : '';

  var html = '<div class="call-card-item priority-' + priority + '" data-call-id="' + cid + '">' +
    '<div class="call-card-top">' +
      '<div class="call-card-left">' +
        '<div class="call-avatar-lg" style="background:' + avatarBg + ';color:' + avatarColor + '">' + initial + '</div>' +
        '<div>' +
          '<div class="call-card-name">' + (c.caller_name || 'Unknown caller') + '</div>' +
          '<div class="call-card-num">' + (c.caller_number || '—') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="call-card-right">' +
        priorityBadge +
        '<div class="call-dur-badge ' + durClass + '">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
          (window.fmtDur ? fmtDur(c.duration) : (dur + 's')) +
        '</div>' +
        '<span class="call-time-tag">' + (window.fmtDate ? fmtDate(c.started_at) : '') + '</span>' +
      '</div>' +
    '</div>' +
    (summaryRows ? '<div class="call-summary-box">' + summaryRows + '</div>' : '') +
    '<div class="call-actions">' +
      '<button class="call-action-btn" onclick="openCallDetail(\'' + cid + '\')">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View' +
      '</button>' +
      markDoneBtn +
      callBackBtn +
      '<button class="call-action-btn" onclick="addCallAsLead(\'' + cid + '\')">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>Add Lead' +
      '</button>' +
      blockBtn +
      '<button class="call-action-btn btn-del" data-call-del="' + cid + '">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>Delete' +
      '</button>' +
    '</div>' +
  '</div>';

  return html;
}

function renderCalls() {
  var filtered = allCalls;
  var tab = currentCallTab || 'action';
  var searchEl = document.getElementById('callSearch');
  var search = searchEl ? searchEl.value.toLowerCase().trim() : '';

  if (tab === 'action') {
    filtered = allCalls.filter(function(c) { return !callIsJunk(c) && !callIsVoicemail(c) && !callIsTransferred(c) && callNeedsAction(c); });
  } else if (tab === 'completed') {
    filtered = allCalls.filter(function(c) { return !callIsJunk(c) && !callIsVoicemail(c) && !callIsTransferred(c) && !callNeedsAction(c); });
  } else if (tab === 'transferred') {
    filtered = allCalls.filter(function(c) { return callIsTransferred(c); });
  } else if (tab === 'voicemail') {
    filtered = allCalls.filter(function(c) { return callIsVoicemail(c); });
  } else if (tab === 'junk') {
    filtered = allCalls.filter(function(c) { return callIsJunk(c); });
  }

  if (currentCallDateFrom) filtered = filtered.filter(function(c) { return c.started_at >= currentCallDateFrom; });
  if (currentCallDateTo) filtered = filtered.filter(function(c) { return c.started_at <= currentCallDateTo; });

  if (search) {
    filtered = filtered.filter(function(c) {
      return (c.caller_name || '').toLowerCase().includes(search) ||
             (c.caller_number || '').includes(search);
    });
  }

  var subtitle = document.getElementById('callsSubTitle');
  if (subtitle) subtitle.textContent = filtered.length + ' calls';

  var container = document.getElementById('callCardsContainer');
  var tbody = document.getElementById('callsTableBody');

  var emptyMsg = {
    action: 'No calls need action right now — great work! ✅',
    completed: 'No completed calls yet.',
    transferred: 'No transferred calls.',
    voicemail: 'No voicemail messages.',
    junk: 'No junk calls detected.',
    all: 'No calls found.'
  };

  if (!container) {
    // Fallback to old table rendering
    if (!tbody) return;
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted)">' + (emptyMsg[tab] || 'No calls found') + '</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map(function(c) {
      return '<tr onclick="openCallDetail(\'' + c.id + '\')" style="cursor:pointer">' +
        '<td><div class="caller-name">' + (c.caller_name || 'Unknown caller') + '</div><div class="caller-num">' + (c.caller_number || '—') + '</div></td>' +
        '<td><span class="status-badge s-' + c.status + '">' + c.status + '</span></td>' +
        '<td><span class="duration-val">' + fmtDur(c.duration) + '</span></td>' +
        '<td><div class="summary-text">' + (c.summary || 'No summary') + '</div></td>' +
        '<td><span class="lead-status l-new">New</span></td>' +
        '<td style="color:var(--muted);font-size:12px">' + fmtDate(c.started_at) + '</td>' +
        '<td><button class="btn-sm btn-ghost-sm" onclick="event.stopPropagation();openCallDetail(\'' + c.id + '\')">View</button>' +
        '<button class="btn-sm" data-call-del="' + c.id + '" style="background:rgba(255,68,102,.1);border:1px solid rgba(255,68,102,.3);color:var(--red);padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Delete</button></td>' +
        '</tr>';
    }).join('');
    return;
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--muted);font-size:14px">' +
      '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:0 auto 16px;opacity:.3"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/></svg>' +
      (emptyMsg[tab] || 'No calls found.') + '</div>';
    return;
  }

  container.innerHTML = filtered.map(function(c) { return buildCallCard(c); }).join('');
  updateCallBadges();
}

function markCallDone(id, btn) {
  var c = allCalls.find(function(x) { return x.id === id; });
  if (c) c.summary = (c.summary || '') + ' [DONE]';
  if (btn) { btn.textContent = 'Done ✓'; btn.disabled = true; }
  setTimeout(function() { renderCalls(); updateCallBadges(); }, 400);
}

function addCallAsLead(id) {
  var c = allCalls.find(function(x) { return x.id === id; });
  if (!c) return;
  showPage('leads');
  setTimeout(function() {
    alert('Creating lead for ' + (c.caller_name || c.caller_number || 'caller') + '.\nCheck the Leads tab.');
  }, 300);
}

function blockCallNumber(num, btn) {
  if (!num) return;
  if (!confirm('Block ' + num + '?\nFuture calls from this number will be rejected.')) return;
  if (btn) { btn.textContent = 'Blocked ✓'; btn.disabled = true; btn.style.opacity = '0.5'; }
}

// ── Populate call stats row ───────────────────────────────────────────────────
function updateCallStats() {
  if (!allCalls || !allCalls.length) return;
  var total = allCalls.length;
  var answered = allCalls.filter(function(c) { return !callIsJunk(c) && !callIsVoicemail(c); }).length;
  var transferred = allCalls.filter(function(c) { return callIsTransferred(c); }).length;
  var voicemail = allCalls.filter(function(c) { return callIsVoicemail(c); }).length;
  var action = allCalls.filter(function(c) { return !callIsJunk(c) && callNeedsAction(c); }).length;
  var junk = allCalls.filter(function(c) { return callIsJunk(c); }).length;

  var el = function(id) { return document.getElementById(id); };
  if (el('callStatTotal'))      el('callStatTotal').textContent = total;
  if (el('callStatAnswered'))   el('callStatAnswered').textContent = answered;
  if (el('callStatTransferred'))el('callStatTransferred').textContent = transferred;
  if (el('callStatVoicemail'))  el('callStatVoicemail').textContent = voicemail;
  if (el('callStatAction'))     el('callStatAction').textContent = action;
  if (el('callStatJunk'))       el('callStatJunk').textContent = junk;
}
