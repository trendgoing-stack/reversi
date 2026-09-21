/**
 * シンプルな Service Worker。
 * - HTML / CSS / JS はネットワーク優先。オフラインのときだけキャッシュを使う
 * - アイコンなどはキャッシュ優先＋裏で更新（stale-while-revalidate）
 *
 * パスはすべて「この sw.js が置かれている場所」からの相対で解決するので、
 * GitHub Pages のサブパス配信（/reversi/）でもそのまま動く。
 */
const CACHE_NAME = 'reversi-v4';

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

  const path = new URL(request.url).pathname;
  const isShell = request.mode === 'navigate' || /\.(html|css|js|webmanifest)$/.test(path);

  // アプリ本体(HTML/CSS/JS)は常に最新を取りに行き、通信できないときだけキャッシュを使う。
  // こうしないと、更新した直後の1回だけ古い版が表示されてしまう。
  if (isShell) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request, { ignoreSearch: true }).then(
            (cached) => cached || caches.match(new URL('index.html', ROOT).href)
          )
        )
    );
    return;
  }

  // アイコンなど更新の少ないものはキャッシュ優先＋裏で更新
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
