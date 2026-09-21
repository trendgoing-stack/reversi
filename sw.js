/**
 * シンプルな Service Worker。
 * - ページ遷移(navigate)はネットワーク優先、オフラインならキャッシュした index.html
 * - JS / CSS / 画像はキャッシュ優先＋裏で更新（stale-while-revalidate）
 *
 * パスはすべて「この sw.js が置かれている場所」からの相対で解決するので、
 * GitHub Pages のサブパス配信（/reversi/）でもそのまま動く。
 */
const CACHE_NAME = 'reversi-v1';

const ROOT = new URL('./', self.location.href);
const APP_SHELL = [
  ROOT.href,
  new URL('index.html', ROOT).href,
  new URL('css/style.css', ROOT).href,
  new URL('js/engine.js', ROOT).href,
  new URL('js/app.js', ROOT).href,
  new URL('js/worker.js', ROOT).href,
  new URL('manifest.webmanifest', ROOT).href,
  new URL('icons/icon-192.png', ROOT).href,
  new URL('icons/apple-touch-icon.png', ROOT).href
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(ROOT.href)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(new URL('index.html', ROOT).href))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
