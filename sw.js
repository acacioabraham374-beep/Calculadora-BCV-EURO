var C = 'bcv-v1';
var FILES = ['./', 'index.html', 'script.js', 'style.css', 'manifest.json', 'icon-192.png', 'icon-512.png', 'fonts/Outfit.ttf', 'Outfit.ttf'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(C).then(function (c) {
    return Promise.all(FILES.map(function (f) { return c.add(f).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== C; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin || /\.apk$/.test(r.url)) return;
  e.respondWith(fetch(r).then(function (res) {
    var cp = res.clone();
    caches.open(C).then(function (c) { c.put(r, cp); });
    return res;
  }).catch(function () {
    return caches.match(r).then(function (m) { return m || caches.match('index.html'); });
  }));
});
