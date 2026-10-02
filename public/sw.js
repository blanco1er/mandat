// Mandat service worker: notifications only (no caching, so the app is always fresh).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Mandat', body: e.data?.text() || '' }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'Mandat', {
      body: d.body || '',
      icon: '/icon-180.png',
      badge: '/icon-180.png',
      tag: d.tag,
      renotify: !!d.tag,
      data: { url: d.url || '/' },
    }),
    'setAppBadge' in self.navigator && d.badge >= 0 ? (d.badge ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}) : null,
  ]));
});

// Tapping a notification opens the mission it is about (reusing an open window when there is one).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) { await win.focus(); return win.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
