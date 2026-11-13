// Service worker: menyimpan kerangka aplikasi di HP supaya aplikasi tetap terbuka
// saat sinyal hilang (foto yang dipotret offline tetap masuk antrean IndexedDB).
// Tidak menyimpan data Supabase maupun /api/*: foto, album, dan login selalu lewat jaringan
// (foto R2 memakai cache browser biasa; thumbnail album di cache "asiig-thumbs-v1" milik aplikasi).
//
// Strategi:
//   halaman (navigasi)   jaringan dulu, cadangan dari cache
//   /assets/* (berhash)  cache dulu (nama file berubah tiap build)
//   file lain di situs   cache, diperbarui di belakang layar
//   Google Fonts         cache dulu

const SHELL = "asiig-shell-v2"; // v2: buang foto /api/r2/o yang dulu ikut tersimpan
const ASSETS = "asiig-assets-v1";
const FONTS = "asiig-fonts-v1";
const THUMBS = "asiig-thumbs-v1"; // diisi aplikasi (src/storage.js), jangan dihapus di sini
const KEEP = [SHELL, ASSETS, FONTS, THUMBS];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(["/", "/manifest.webmanifest", "/icon.svg", "/privacy.html"]);
    await cacheAssetsOf(await cache.match("/"));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com") {
    event.respondWith(cacheFirst(FONTS, req));
    return;
  }
  if (url.origin !== location.origin) return; // Supabase dan lainnya: biarkan lewat jaringan
  if (url.pathname.startsWith("/api/")) return; // API Worker (foto R2, pembayaran): langsung ke jaringan

  if (req.mode === "navigate") {
    event.respondWith(networkFirstPage(req));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(ASSETS, req));
  } else {
    event.respondWith(staleWhileRevalidate(SHELL, req));
  }
});

// Notifikasi "album sudah terbuka" (dikirim Edge Function notify-album)
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data?.json() || {}; } catch { d = { title: "TitipPotret", body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || "TitipPotret", {
    body: d.body || "", icon: "/icon.svg", badge: "/icon.svg", tag: d.tag, data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) { await win.focus(); return win.navigate(url); }
    return self.clients.openWindow(url);
  })());
});

async function networkFirstPage(req) {
  const cache = await caches.open(SHELL);
  const url = new URL(req.url);
  // Semua rute aplikasi memakai hash, jadi halaman utama disimpan sebagai "/"
  const key = url.pathname === "/" || url.pathname === "/index.html" ? "/" : url.pathname;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") {
      await cache.put(key, res.clone());
      if (key === "/") cacheAssetsOf(res.clone()); // simpan aset build terbaru, buang yang lama
    }
    return res;
  } catch {
    return (await cache.match(key)) || (await cache.match("/")) ||
      new Response("Tidak ada koneksi internet.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fresh;
}

// Baca index.html, simpan semua /assets/* yang dirujuknya, hapus aset build lama
async function cacheAssetsOf(indexResponse) {
  if (!indexResponse) return;
  try {
    const html = await indexResponse.text();
    const wanted = [...new Set(html.match(/\/assets\/[^"'\s)]+/g) || [])];
    const cache = await caches.open(ASSETS);
    await Promise.all(wanted.map(async (p) => { if (!(await cache.match(p))) await cache.add(p); }));
    for (const req of await cache.keys()) {
      if (!wanted.includes(new URL(req.url).pathname)) await cache.delete(req);
    }
  } catch { /* dicoba lagi pada pemuatan berikutnya */ }
}
