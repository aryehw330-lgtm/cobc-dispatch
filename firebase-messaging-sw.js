// COBC Dispatch — Firebase Cloud Messaging Service Worker
// This file MUST sit at the root of your hosting (same level as index.html)
// URL when deployed: https://aryehw330-lgtm.github.io/cobc-dispatch/firebase-messaging-sw.js

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// ⚠️ REPLACE THE VALUES BELOW with your Firebase config (Step 3 of setup)
firebase.initializeApp({
  apiKey: "AIzaSyBYAz3ohsJGX_zo-Yq3faZ2m0uv4tfuSl8",
  authDomain: "cobc-dispatch.firebaseapp.com",
  projectId: "cobc-dispatch",
  storageBucket: "cobc-dispatch.firebasestorage.app",
  messagingSenderId: "292943991082",
  appId: "1:292943991082:web:3d4b83f0ea2feb1a230e53"
});

const messaging = firebase.messaging();

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
  const baseUrl = event.notification.data?.url || '/cobc-dispatch/';
  const target  = callId ? `/cobc-dispatch/?call=${encodeURIComponent(callId)}` : baseUrl;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((winClients) => {
      const existing = winClients.find(c => c.url.includes('cobc-dispatch'));
      if (existing) {
        // App is already open — store callId AND tell it to open the call
        if (callId) {
          existing.postMessage({ type: 'OPEN_CALL', callId });
        }
        return existing.focus();
      }
      // App is closed — open it with ?call= param (works on Android; iOS fallback via sessionStorage)
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
