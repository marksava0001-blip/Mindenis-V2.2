// =============================================================
// Service worker — two jobs: receiving Web Push notifications (habit
// reminders), and caching pages/assets as they're visited so the app
// keeps working offline. Registered from topbar.js on every page (so
// it installs regardless of whether push notifications are ever
// turned on), which gives it scope over the whole site (root file).
// =============================================================

const CACHE_NAME = 'dash-cache-v1';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Drop any cache from a previous CACHE_NAME (bump the version
      // above on a future change that needs a clean slate).
      caches.keys().then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )),
    ])
  );
});

// Network-first, falling back to cache when offline — deliberately NOT
// cache-first. This app has already caused enough "why isn't my fix
// showing up" confusion from stale Vercel deployments; an aggressive
// cache-first strategy would add a second, worse source of the same
// problem (a page silently loading from a week-old cache while online).
// Every successful online visit refreshes the cache, so staleness can
// only happen when actually offline, which is the whole point.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Supabase, CDN, Google, etc.
  if (url.pathname.indexOf('/api/') === 0) return; // dynamic endpoints must always be live, never cached

  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});

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
