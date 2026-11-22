// Offline shell for stalls with weak signal: the app opens without a network, chain reads resume when it is back.
// Pages: network first (a deploy is never hidden behind a stale copy), cache as the fallback.
// Hashed build assets: cache first (their names change when their content does). Video and range requests: not cached.
const CACHE = 'jelajah-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || req.headers.has('range') || url.pathname.endsWith('.mp4')) return;
  if (url.pathname.includes('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => put(req, res))));
    return;
  }
  e.respondWith(fetch(req).then((res) => put(req, res)).catch(async () =>
    (await caches.match(req, { ignoreSearch: req.mode === 'navigate' })) ?? (req.mode === 'navigate' ? caches.match(new URL('./', self.registration.scope).href) : Response.error())));
});

function put(req, res) {
  if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
}
