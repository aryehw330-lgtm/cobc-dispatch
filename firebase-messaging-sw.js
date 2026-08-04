// COBC Dispatch — Firebase Cloud Messaging Service Worker
// This file MUST sit at the root of your hosting (same level as index.html)
// URL when deployed: https://aryehw330-lgtm.github.io/cobc-dispatch/firebase-messaging-sw.js

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// ── Offline app-shell cache ──────────────────────────────────────────────────
// Lets the app open (showing last roster/calls from localStorage) even with no
// signal. Bump CACHE_VERSION to force every device to rebuild its cached shell.
const CACHE_VERSION = 'cobc-shell-v3';
const BASE = '/cobc-dispatch/';
const PRECACHE_URLS = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.json',
  BASE + 'icon-192.png',
  BASE + 'icon-512.png',
  BASE + 'icon-badge-mono.png',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@500&display=swap',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// ── Install ── precache the shell (best-effort per URL so one failed CDN fetch
// never aborts the whole install). Same-origin fetched normally; cross-origin
// CDN fetched no-cors (opaque but still usable).
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(PRECACHE_URLS.map((u) => {
        const cross = u.indexOf('http') === 0 && u.indexOf(self.location.origin) !== 0;
        return fetch(u, cross ? { mode: 'no-cors' } : {})
          .then((r) => cache.put(u, r))
          .catch(() => {});
      }))
    )
  );
});

// ── Activate ── drop old cache versions, then take control.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await clients.claim();
  })());
});

// ── Fetch strategy ───────────────────────────────────────────────────────────
// - Non-GET (Firestore/Apps Script writes): never intercept — straight to network.
// - Live-data hosts (Apps Script, Firestore, Maps, FCM): always network, never cache.
// - HTML page loads: network-first; fall back to the cached shell when offline.
// - Static assets (fonts, libs, icons): cache-first; refresh in the background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // writes always hit the network

  const href = req.url;
  if (/script\.google\.com|script\.googleusercontent\.com|firestore\.googleapis\.com|maps\.googleapis\.com|fcmregistrations|firebaseinstallations|firebaseremoteconfig/.test(href)) {
    return; // live data — don't cache or serve stale
  }

  const accept = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || accept.indexOf('text/html') !== -1;

  if (isHTML) {
    // Network-first so code updates always win; cached shell only when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(BASE + 'index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(BASE + 'index.html').then((c) => c || caches.match(BASE)))
    );
    return;
  }

  // Cache-first for static assets, refresh in background (stale-while-revalidate).
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

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
    badge: '/cobc-dispatch/icon-badge-mono.png',
    tag: payload.data?.tag || 'cobc-' + Date.now(),
    requireInteraction: payload.data?.urgent === 'true',
    vibrate: payload.data?.urgent === 'true' ? [200, 100, 200, 100, 200] : [100, 50, 100],
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
      badge: '/cobc-dispatch/icon-badge-mono.png',
      tag: 'cobc-fg-' + Date.now(),
      vibrate: data?.urgent === 'true' ? [200, 100, 200, 100, 200] : [100, 50, 100],
      data: { url: data?.url || '/cobc-dispatch/', callId: data?.callId || null }
    });
  }
});

// Open the app when a notification is tapped
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const callId  = event.notification.data?.callId;
  const url     = event.notification.data?.url || '/cobc-dispatch/';
  // Extract ?page=... param if present (e.g. completion request → dispatch tab)
  let page = null;
  try { page = new URL(url, self.location.origin).searchParams.get('page'); } catch(e) {}

  event.waitUntil((async () => {
    // Always write callId to IndexedDB first — works even if app is closed (iOS)
    if (callId) await idbStorePendingCall(callId);

    const winClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = winClients.find(c => c.url.includes('cobc-dispatch'));
    if (existing) {
      // App already open — postMessage tells it what to do
      if (callId) existing.postMessage({ type: 'OPEN_CALL', callId });
      else if (page) existing.postMessage({ type: 'OPEN_PAGE', page });
      return existing.focus();
    }
    // App closed — open it (honor the url so ?page=… is preserved). IDB entry read on startup.
    if (clients.openWindow) return clients.openWindow(url || '/cobc-dispatch/');
  })());
});
