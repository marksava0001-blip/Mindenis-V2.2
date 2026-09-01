// =============================================================
// Service worker — two jobs: receiving Web Push notifications (habit
// reminders), and caching pages/assets as they're visited so the app
// keeps working offline. Registered from topbar.js on every page (so
// it installs regardless of whether push notifications are ever
// turned on), which gives it scope over the whole site (root file).
// =============================================================

const CACHE_NAME = 'dash-cache-v1';

// Every page actually reachable from the hub, plus the shared assets they
// all load. Precached on install so the whole app is available offline
// right after the first open, instead of only building up coverage one
// visited page at a time. (avatar-lab.html and template.html are excluded
// deliberately — neither is linked from the hub; they're not part of the
// real app.)
const PRECACHE_URLS = [
  '/', '/index.html', '/main.html', '/gym.html', '/health.html', '/po-water.html',
  '/finance.html', '/caffeine.html', '/nova-lite.html', '/habits.html',
  '/sync.js', '/topbar.js', '/manifest.json',
];

async function precacheAll() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(PRECACHE_URLS.map(async (url) => {
    try {
      // cache: 'reload' skips the browser's own HTTP cache so this always
      // grabs the current deployment, not a stale disk-cached copy.
      const res = await fetch(url, { cache: 'reload' });
      if (res && res.ok) await cache.put(url, res);
    } catch (e) {
      // One page failing (offline mid-install, a page briefly down) must
      // not abort caching the rest — unlike cache.addAll(), which is
      // all-or-nothing.
    }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAll().then(() => self.skipWaiting()));
});
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
