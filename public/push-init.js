// AiRingDesk Push Notification Init v1.0.0
const VAPID_PUBLIC_KEY = 'BDeqWcUR571-waY2DkAIgqhax7h9UoatQi_Eei9auVBhzz2bcT7JDsV16PauEYhtn0L7yrKMLorxqHihwZbl20w';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('Push not supported in this browser');
    return;
  }

  try {
    // Register service worker
    const reg = await navigator.serviceWorker.register('/sw.js');
    console.log('AiRingDesk SW registered');

    // Check existing permission
    if (Notification.permission === 'denied') {
      console.log('Push notifications blocked by user');
      return;
    }

    // Check if already subscribed
    const existingSub = await reg.pushManager.getSubscription();
    if (existingSub) {
      console.log('Already subscribed to push');
      updatePushButton(true);
      return;
    }

    // Show enable button in dashboard
    updatePushButton(false);

  } catch(err) {
    console.error('SW registration failed:', err);
  }
}

async function subscribeToPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showPushStatus('Notifications blocked. Please enable in browser settings.', 'error');
      return;
    }

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });

    // Send subscription to server
    const token = window.authToken || localStorage.getItem('rd_token') || sessionStorage.getItem('rd_token');
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ subscription })
    });

    if (res.ok) {
      updatePushButton(true);
      showPushStatus('Push notifications enabled!', 'success');
    } else {
      showPushStatus('Failed to enable notifications. Try again.', 'error');
    }
  } catch(err) {
    console.error('Subscribe failed:', err);
    showPushStatus('Could not enable notifications.', 'error');
  }
}

async function unsubscribeFromPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe();
      const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
      });
    }
    updatePushButton(false);
    showPushStatus('Push notifications disabled.', 'info');
  } catch(err) {
    console.error('Unsubscribe failed:', err);
  }
}

function updatePushButton(subscribed) {
  const btn = document.getElementById('pushToggleBtn');
  const status = document.getElementById('pushStatus');
  if (!btn) return;
  if (subscribed) {
    btn.textContent = 'Disable Notifications';
    btn.style.background = 'rgba(255,68,102,.1)';
    btn.style.border = '1px solid rgba(255,68,102,.3)';
    btn.style.color = '#ff4466';
    btn.onclick = unsubscribeFromPush;
    if (status) status.textContent = 'Push notifications active on this device';
  } else {
    btn.textContent = 'Enable Push Notifications';
    btn.style.background = 'rgba(0,212,255,.1)';
    btn.style.border = '1px solid rgba(0,212,255,.3)';
    btn.style.color = '#00d4ff';
    btn.onclick = subscribeToPush;
    if (status) status.textContent = 'Get instant alerts for calls, voicemails and appointments';
  }
}

function showPushStatus(msg, type) {
  const el = document.getElementById('pushStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'success' ? '#00e87a' : type === 'error' ? '#ff4466' : '#5a7a9a';
  setTimeout(() => { if (el) el.textContent = 'Push notifications active on this device'; }, 4000);
}

// Auto-init when dashboard loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPushNotifications);
} else {
  initPushNotifications();
}

// Expose functions globally so dashboard buttons can call them
window.subscribeToPush = subscribeToPush;
window.unsubscribeFromPush = unsubscribeFromPush;
window.updatePushButton = updatePushButton;
window.showPushStatus = showPushStatus;
