// オフライン用：アプリ本体をスマホに保存しておく
// 開くとき：ネットがあれば最新を取りに行き、つながらなければ保存しておいた分で起動する
const CACHE = 'app-v1';
const FILES = ['./', './index.html', './manifest.json', './icon-180.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const timeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  const rel = url.pathname.slice(scope.pathname.length);
  // 他のアプリ（サブフォルダ）の分は触らない
  if (rel.includes('/')) return;
  // 更新チェックはそのままネットへ
  if (url.searchParams.has('check')) return;
  const isPage = req.mode === 'navigate' || rel === '' || rel === 'index.html';
  if (isPage) {
    e.respondWith((async () => {
      try {
        const res = await timeout(fetch(req.url, { cache:'no-store', credentials:'same-origin' }), 4000);
        if (res && res.ok) { const c = await caches.open(CACHE); c.put('./index.html', res.clone()); }
        return res;
      } catch (err) {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch:true });
    const net = fetch(req).then(res => { if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
