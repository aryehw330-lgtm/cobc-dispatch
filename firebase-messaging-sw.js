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
    data: { url }
  });
});

// Open the app when a notification is tapped
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/cobc-dispatch/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((winClients) => {
      for (const c of winClients) {
        if (c.url.includes('cobc-dispatch') && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
