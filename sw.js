// freeChat Service Worker — Web Push handler

self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const title = data.title || 'freeChat';
  const body  = data.body  || '새 메시지가 있습니다';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:     '/freeChat/icon.png',
      badge:    '/freeChat/icon.png',
      tag:      'freechat-msg',
      renotify: true,
      data:     { url: data.url || '/freeChat/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/freeChat/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const match = list.find(c => c.url.includes('/freeChat/'));
      if (match) return match.focus();
      return clients.openWindow(url);
    })
  );
});
