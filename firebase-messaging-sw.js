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
    // Network-first so code updates always win. The saved copy is used when the phone is
    // offline, when the host (GitHub Pages) answers with an error page (outage), or when it
    // hangs for 10s — so a GitHub outage never takes the app down. Only good pages are saved.
    const savedShell = () => caches.match(BASE + 'index.html').then((c) => c || caches.match(BASE));
    event.respondWith((async () => {
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
        ]);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(BASE + 'index.html', copy)).catch(() => {});
          return res;
        }
        const saved = await savedShell();
        return saved || res;          // host error page → saved copy if we have one
      } catch (e) {
        const saved = await savedShell();
        if (saved) return saved;
        return fetch(req);            // nothing saved yet → keep waiting on the network
      }
    })());
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

// The same alert can reach this phone several times (a dispatcher who is also an admin gets
// the dispatch send, the admin send and the admin-topic backstop; or an older registration).
// IMPORTANT (iPhone): every push MUST show a notification. If a web app gets pushes and shows
// nothing, iOS silently turns its notifications off (that happened Nov 16-17, 2026). So a
// duplicate is still shown, but with the SAME tag as the first copy and silent: it quietly
// replaces that notification instead of adding a second banner or sound.
const _seenAlerts = new Map(); // title|body -> { t, tag }
function _dupTagFor(title, body, tag) {
  const k = String(title || '') + '|' + String(body || '');
  const now = Date.now();
  for (const [kk, v] of _seenAlerts) if (now - v.t > 60 * 1000) _seenAlerts.delete(kk);
  const seen = _seenAlerts.get(k);
  if (seen) return seen.tag;
  _seenAlerts.set(k, { t: now, tag: tag });
  return null;
}
// This phone's own unit (the app saves it at sign-in) — used to merge "BC-95 is responding"
// with BC-95's own "✅ Approved to respond" so that member gets ONE notification (Nov 2026).
function _idbGet(key) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('cobc_sw_store', 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('kv', { keyPath: 'k' }); };
      req.onsuccess = (e) => {
        try {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('kv')) { resolve(null); return; }
          const g = db.transaction('kv', 'readonly').objectStore('kv').get(key);
          g.onsuccess = () => resolve(g.result ? g.result.v : null);
          g.onerror = () => resolve(null);
        } catch (err) { resolve(null); }
      };
      req.onerror = () => resolve(null);
    } catch (err) { resolve(null); }
  });
}
// Missed-alert check (Nov 2026): remember which calls this phone actually got an alert for. Each one is
// its own key ("recv_<callId>") so a burst of alerts can't overwrite each other. The app compares this
// with the calls that went out and warns the member if their phone stayed silent.
function _recordPush(data) {
  return new Promise((resolve) => {
    try {
      const callId = data && data.callId;
      if (!callId) { resolve(); return; }
      const req = indexedDB.open('cobc_sw_store', 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('kv', { keyPath: 'k' }); };
      req.onsuccess = (e) => {
        try {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('kv')) { resolve(); return; }
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ k: 'recv_' + callId, v: Date.now() });
          tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
        } catch (err) { resolve(); }
      };
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch (err) { resolve(); }
  });
}
const _normUnitSW = (u) => String(u || '').trim().toUpperCase().replace(/^BC-?/, '').replace(/^0+(?=\d)/, '');
// "Assigned to Call" alerts name the members on the call. On a phone whose member is one of them,
// show it as their own alert: "✅ Approved to respond…" (one approved member) or "✅ You're assigned…"
// (dispatcher assign), plus who else is on the call (Nov 2026). Returns null if it's not about this phone.
// Body formats: "#412 · BC-95 is responding — Lockout, Teaneck · Also on call: BC-50"
//               "#412 · BC-50, BC-52 responding — Lockout, Teaneck · Also on call: BC-60"
//               "#412 · BC-50, BC-52 — Lockout, Teaneck"   (older app versions)
function _mineAlertText(title, body, myUnit) {
  if (!myUnit || !/Assigned to Call/i.test(String(title || ''))) return null;
  const b = String(body || '');
  const m = /^#(\S*)\s*·\s*(.+?)\s+(is\s+)?responding\s*—\s*(.*)$/i.exec(b) || /^#(\S*)\s*·\s*((?:BC-?\d+\s*,?\s*)+)()—\s*(.*)$/i.exec(b);
  if (!m) return null;
  const units = (m[2].match(/\d+/g) || []).map(_normUnitSW);
  if (units.indexOf(myUnit) < 0) return null;
  let place = m[4], also = [];
  const am = /^(.*?)\s*·\s*Also on call:\s*(.*)$/i.exec(place);
  if (am) { place = am[1]; also = (am[2].match(/\d+/g) || []).map(_normUnitSW); }
  const others = units.concat(also).filter((u, i, a) => u !== myUnit && a.indexOf(u) === i).map((u) => 'BC-' + u);
  const t = (m[3] && units.length === 1) ? ('✅ Approved to respond to call #' + m[1]) : ('✅ You\'re assigned to call #' + m[1]);
  return { t: t, b: (others.length ? 'With ' + others.join(', ') + ' — ' : '') + place };
}
async function _showAlert(title, body, data, fromForeground) {
  data = data || {};
  try {
    const callId = data.callId || null;
    const isApproval = /Approved to respond|you ARE approved/i.test(String(title || ''));
    const isAssigned = /Assigned to Call/i.test(String(title || ''));
    const myUnit = (isApproval || isAssigned) ? _normUnitSW(await _idbGet('myUnit')) : '';
    const mine = isAssigned ? _mineAlertText(title, body, myUnit) : null;
    const aboutMe = !!mine;
    if (callId && (isApproval || aboutMe)) {
      const tag = 'cobc-mine-' + callId;
      let existing = null;
      try { existing = (await self.registration.getNotifications({ tag })).find((n) => n && n.data && n.data.mine) || null; } catch (e) {}
      let t = title, b = body;
      if (aboutMe) {   // keep the personal approval wording on this phone
        if (existing) { t = existing.title; b = existing.body; }
        else { t = mine.t; b = mine.b; }
      }
      await self.registration.showNotification(t || 'COBC Dispatch', {
        body: b || '',
        icon: '/cobc-dispatch/icon-192.png',
        badge: '/cobc-dispatch/icon-badge-mono.png',
        tag: tag,
        renotify: false,
        silent: !!existing,                       // second one: quietly takes the first one's place
        requireInteraction: (data.urgent === 'true' || aboutMe) && !existing,
        vibrate: existing ? undefined : [100, 50, 100],
        data: { url: data.url || '/cobc-dispatch/', callId: callId, mine: true }
      });
      // iPhone doesn't replace a notification that has the same tag — it adds another. So once the
      // new one is showing, close the earlier copy: only one stays in the list (Nov 2026).
      if (existing) { try { existing.close(); } catch (e) {} }
      return;
    }
  } catch (e) { /* fall through to the normal path below */ }
  const urgent = data.urgent === 'true';
  const ownTag = data.tag || ((fromForeground ? 'cobc-fg-' : 'cobc-') + Date.now());
  const dupTag = _dupTagFor(title, body, ownTag);
  return self.registration.showNotification(title || 'COBC Dispatch', {
    body: body || '',
    icon: '/cobc-dispatch/icon-192.png',
    badge: '/cobc-dispatch/icon-badge-mono.png',
    tag: dupTag || ownTag,
    renotify: false,
    silent: !!dupTag,
    requireInteraction: urgent && !dupTag,
    vibrate: dupTag ? undefined : (urgent ? [200, 100, 200, 100, 200] : [100, 50, 100]),
    data: { url: data.url || '/cobc-dispatch/', callId: data.callId || null }
  });
}

// Background notifications — shown when app is closed or in background
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || payload.data?.title || 'COBC Dispatch';
  const body  = payload.notification?.body  || payload.data?.body  || '';
  return Promise.all([_showAlert(title, body, payload.data || {}, false), _recordPush(payload.data || {})]);
});

// Show notification when app is in foreground (posted from onMessage handler)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, data } = event.data;
    const p = Promise.all([_showAlert(title, body, data || {}, true), _recordPush(data || {})]);
    if (event.waitUntil) event.waitUntil(p);
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
