// COBC Dispatch — Firebase Cloud Messaging Service Worker
// This file MUST sit at the root of your hosting (same level as index.html)
// URL when deployed: https://aryehw330-lgtm.github.io/cobc-dispatch/firebase-messaging-sw.js

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBYAz3ohsJGX_zo-Yq3faZ2m0uv4tfuSl8",
  authDomain: "cobc-dispatch.firebaseapp.com",
  projectId: "cobc-dispatch",
  storageBucket: "cobc-dispatch.firebasestorage.app",
  messagingSenderId: "292943991082",
  appId: "1:292943991082:web:3d4b83f0ea2feb1a230e53"
});

const messaging = firebase.messaging();

// ── IndexedDB helper ─────────────────────────────────────────────────────────
// localStorage/sessionStorage are NOT available in service workers.
// IndexedDB IS available and persists across page loads — perfect for iOS PWA.
function idbStorePendingCall(callId) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('cobc_sw_store', 1);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = (e) => {
        try {
          const db = e.target.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ k: 'pendingCall', v: callId });
          tx.oncomplete = resolve;
          tx.onerror = resolve;
        } catch(err) { resolve(); }
      };
      req.onerror = resolve;
    } catch(err) { resolve(); }
  });
}

// Background notifications — shown when app is closed or in background
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || payload.data?.title || 'COBC Dispatch';
  const body  = payload.notification?.body  || payload.data?.body  || '';
  const url   = payload.data?.url || '/';

  self.registration.showNotification(title, {
    body,
    icon: '/cobc-dispatch/icon-192.png',
    badge: '/cobc-dispatch/icon-192.png',
    tag: payload.data?.tag || 'cobc-' + Date.now(),
    requireInteraction: payload.data?.urgent === 'true',
    data: { url, callId: payload.data?.callId || null }
  });
});

// Show notification when app is in foreground (posted from onMessage handler)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, data } = event.data;
    self.registration.showNotification(title || 'COBC Dispatch', {
      body: body || '',
      icon: '/cobc-dispatch/icon-192.png',
      badge: '/cobc-dispatch/icon-192.png',
      tag: 'cobc-fg-' + Date.now(),
      data: { url: data?.url || '/cobc-dispatch/', callId: data?.callId || null }
    });
  }
});

// Open the app when a notification is tapped
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const callId  = event.notification.data?.callId;
  const baseUrl = '/cobc-dispatch/';

  event.waitUntil((async () => {
    // Always write callId to IndexedDB first — works even if app is closed (iOS)
    if (callId) await idbStorePendingCall(callId);

    const winClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = winClients.find(c => c.url.includes('cobc-dispatch'));

    if (existing) {
      // App already open — postMessage tells it to open the call immediately
      if (callId) existing.postMessage({ type: 'OPEN_CALL', callId });
      return existing.focus();
    }

    // App closed — open it. IDB entry will be read on startup.
    if (clients.openWindow) return clients.openWindow(baseUrl);
  })());
});
