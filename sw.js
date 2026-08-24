// =============================================================
// Service worker — only job right now is receiving Web Push
// notifications (habit reminders) and handling taps on them.
// Registered from habits.html with navigator.serviceWorker.register('/sw.js'),
// which gives it scope over the whole site (root-level file).
// =============================================================

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = data.title || 'Habit reminder';
  const options = {
    body: data.body || "Time for your habit — don't break the streak.",
    tag: data.tag || 'habit-reminder',
    data: { url: data.url || '/habits.html' },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/habits.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.indexOf(url) !== -1 && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
