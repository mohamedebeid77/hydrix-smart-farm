/* Hydrix — service worker: تخزين مؤقت للعمل بدون إنترنت
   ملاحظة: عند أي تعديل على ملفات التطبيق ارفع رقم الإصدار (v2 → v3 ...) */
// ارفع رقم النسخة مع كل إصدار حتى لا تختلط ملفات HTML وJavaScript القديمة.
const CACHE = "hydrix-v5";
const ASSETS = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/app.js",
  "./js/bluetooth.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // خطوط جوجل وواجهة الطقس تُجلب من الشبكة أولاً
  if (url.host !== self.location.hostname) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }))
  );
});
