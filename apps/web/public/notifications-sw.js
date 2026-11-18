self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  // Safari can display this same declarative payload even when the worker is
  // unavailable. Every received push must display; cancellation/expiry checks
  // therefore run on the server and provider, before delivery.
  event.waitUntil((async () => {
    const notification = event.data?.json()?.notification;
    if (!notification?.title || !notification.navigate) return;
    const url = new URL(notification.navigate, self.location.origin);
    if (url.origin !== self.location.origin) return;
    await self.registration.showNotification(notification.title, {
      body: notification.body, tag: notification.tag, renotify: false,
      data: { url: url.pathname + url.search },
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data.url, self.location.origin);
    if (url.origin !== self.location.origin) return;
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(url.href); await existing.focus(); }
    else await self.clients.openWindow(url.href);
  })());
});
