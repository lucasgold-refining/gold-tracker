// Lucas Gold Tracker service worker. Bump CACHE on every release.
const CACHE = 'gold-tracker-v27';
const ASSETS = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];
const NAV_TIMEOUT_MS = 6000;   // weak signal: after this, open the saved copy instead of waiting

// Install: fetch fresh copies (bypassing the browser's HTTP cache, so a new release never stores the old page).
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
// Activate: drop older releases' caches and take over open pages.
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const keep = (key, r) => { if (r && r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}); } return r; };

// Network-first for the page (so updates arrive), cache-first for our own assets.
// Requests to other sites (the Google Apps Script API) are never touched or cached.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Only a good (200) page replaces the saved copy; a 404/500 or a captive-portal page never overwrites it.
    const net = fetch(req).then(r => keep('./index.html', r));
    const saved = () => caches.match('./index.html');
    e.respondWith(new Promise(resolve => {
      let done = false; const finish = r => { if (!done && r) { done = true; resolve(r); } };
      const t = setTimeout(() => saved().then(finish), NAV_TIMEOUT_MS);
      net.then(r => { clearTimeout(t); if (r.ok) finish(r); else saved().then(c => finish(c || r)); })
        .catch(() => { clearTimeout(t); saved().then(c => finish(c || Response.error())); });
    }));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => keep(req, r))));
});
