// Penyimpanan foto: Supabase Storage atau Cloudflare R2 (lewat Worker situs, /api/r2/*).
// Dipilih saat aplikasi berjalan dari pengaturan superadmin (app_settings.storage_backend).
// Sampul dan rekaman suara tetap di Supabase Storage.
import { supabase } from "./supabase.js";

const bucket = () => supabase.storage.from("photos");

let backend = "supabase";
export const setStorageBackend = (b) => {
  const next = b === "r2" ? "r2" : "supabase";
  if (next !== backend) urlMemo.clear();
  backend = next;
};
export const storageBackend = () => backend;

async function token() {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("BELUM_LOGIN");
  return t;
}

async function r2(path, init = {}) {
  const res = await fetch(`/api/r2/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token()}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    let msg = `R2 ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* abaikan */ }
    throw new Error(msg);
  }
  return res.json();
}
const postJson = (path, body) => r2(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function uploadPhoto(path, blob) {
  if (backend === "r2") {
    await r2(`o/${path}`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
    return;
  }
  const { error } = await bucket().upload(path, blob, { contentType: "image/jpeg", upsert: false });
  // "sudah ada" berarti percobaan sebelumnya sebenarnya berhasil
  if (error && !/exists|duplicate/i.test(error.message)) throw error;
}

// URL sementara (berlaku >= 1 jam) untuk banyak file sekaligus -> { path: url }.
// URL disimpan di memori dan dipakai ulang selama masih berlaku lama: URL yang sama berarti
// browser memakai foto dari cache-nya, tanpa unduh ulang dan tanpa permintaan tanda tangan baru.
const urlMemo = new Map(); // path -> { url, until (ms) }
const MIN_LEFT = 55 * 60 * 1000; // pemanggil (mis. slideshow) menganggap URL berlaku 1 jam

export async function getUrls(paths) {
  if (!paths.length) return {};
  const now = Date.now();
  const out = {};
  const need = [];
  for (const p of new Set(paths)) {
    const m = urlMemo.get(p);
    if (m && m.until - now > MIN_LEFT) out[p] = m.url;
    else need.push(p);
  }
  if (!need.length) return out;
  if (backend === "r2") {
    for (let i = 0; i < need.length; i += 200) {
      const got = await postJson("sign", { paths: need.slice(i, i + 200) });
      for (const [p, u] of Object.entries(got)) {
        const url = new URL(u, location.origin);
        out[p] = url.href;
        urlMemo.set(p, { url: url.href, until: Number(url.searchParams.get("e")) * 1000 || now + 3600e3 });
      }
    }
    return out;
  }
  const { data, error } = await bucket().createSignedUrls(need, 3600);
  if (error) throw error;
  for (const d of data) {
    if (!d.signedUrl) continue;
    out[d.path] = d.signedUrl;
    urlMemo.set(d.path, { url: d.signedUrl, until: now + 3600e3 });
  }
  return out;
}

// ---------- Thumbnail album: bundel + cache di HP (khusus R2) ----------
// Ubin album diambil per 60 dalam satu request Worker (/api/r2/thumbs), lalu disimpan di
// Cache Storage HP. Nama file foto unik dan isinya tak pernah berubah, jadi membuka album lagi
// tidak memakai kuota Worker sama sekali. Cache dibatasi umur dan jumlahnya, dihapus saat keluar.
export const THUMB_CACHE = "asiig-thumbs-v1";
const THUMB_MAX_AGE = 14 * 864e5;
const THUMB_MAX_ITEMS = 4000;
const thumbKey = (p) => `/__thumb/${p}`;
const blobUrls = new Map(); // path -> blob: URL (selama halaman terbuka)
let pruned = false;

async function thumbCache() {
  try { return await caches.open(THUMB_CACHE); } catch { return null; } // mis. mode privat
}

function keepBlob(p, blob) {
  let u = blobUrls.get(p);
  if (!u) { u = URL.createObjectURL(blob); blobUrls.set(p, u); }
  return u;
}

async function fetchBundle(paths) {
  const res = await fetch("/api/r2/thumbs", {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) throw new Error(`R2 ${res.status}`);
  const buf = await res.arrayBuffer();
  const headLen = new DataView(buf).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLen)));
  const out = [];
  let at = 4 + headLen;
  for (const [p, n] of head) {
    out.push([p, new Blob([new Uint8Array(buf, at, n)], { type: "image/jpeg" })]);
    at += n;
  }
  return out;
}

// Buang thumbnail yang terlalu lama atau kelebihan jumlah (sekali per sesi)
async function pruneThumbs(cache) {
  if (pruned || !cache) return;
  pruned = true;
  try {
    const keys = await cache.keys();
    const now = Date.now();
    const over = keys.length - THUMB_MAX_ITEMS;
    await Promise.all(keys.map(async (req, i) => {
      if (i < over) return cache.delete(req);                    // urutan keys = urutan disimpan
      const res = await cache.match(req);
      if (!res || now - Number(res.headers.get("x-saved") || 0) > THUMB_MAX_AGE) return cache.delete(req);
    }));
  } catch { /* abaikan */ }
}

// -> { path: url } untuk ubin album. Cadangan: URL bertanda tangan biasa.
export async function thumbUrls(paths) {
  paths = [...new Set(paths)];
  if (!paths.length) return {};
  if (backend !== "r2") return getUrls(paths);
  const out = {};
  const need = [];
  const cache = await thumbCache();
  pruneThumbs(cache);
  await Promise.all(paths.map(async (p) => {
    if (blobUrls.has(p)) { out[p] = blobUrls.get(p); return; }
    const hit = cache && await cache.match(thumbKey(p)).catch(() => null);
    if (hit) out[p] = keepBlob(p, await hit.blob());
    else need.push(p);
  }));
  for (let i = 0; i < need.length; i += 60) {
    try {
      for (const [p, blob] of await fetchBundle(need.slice(i, i + 60))) {
        out[p] = keepBlob(p, blob);
        cache?.put(thumbKey(p), new Response(blob, { headers: { "Content-Type": "image/jpeg", "x-saved": String(Date.now()) } })).catch(() => {});
      }
    } catch { /* sisanya lewat URL biasa */ }
  }
  const miss = paths.filter((p) => !out[p]);
  if (miss.length) Object.assign(out, await getUrls(miss));
  return out;
}

// Saat keluar akun: thumbnail acara tidak tertinggal di HP
export async function clearThumbCache() {
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  urlMemo.clear();
  try { await caches.delete(THUMB_CACHE); } catch { /* abaikan */ }
}

// Dipakai panel pemilik saat menghapus acara atau potretan macet
export async function removeFiles(paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const part = paths.slice(i, i + 100);
    if (backend === "r2") { await postJson("delete", { paths: part }); continue; }
    const { error } = await bucket().remove(part);
    if (error) throw error;
  }
}

// ---------- R2: status dan pemindahan foto lama (superadmin) ----------
export async function r2Health() {
  try {
    const res = await fetch("/api/r2/health", { cache: "no-store" });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch { return { ok: false }; }
}
export const migrateToR2 = (limit = 20) => postJson("migrate", { limit });

// ---------- Sampul undangan (bucket publik "covers") ----------

const covers = () => supabase.storage.from("covers");

export async function uploadCover(path, blob) {
  const { error } = await covers().upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
}

export function coverUrl(path) {
  return path ? covers().getPublicUrl(path).data.publicUrl : "";
}

// Salin sampul ke acara lain (duplikat acara)
export async function copyCover(from, to) {
  const { error } = await covers().copy(from, to);
  if (error) throw error;
}

export async function removeCover(path) {
  if (!path) return;
  const { error } = await covers().remove([path]);
  if (error) throw error;
}

// ---------- Rekaman suara buku tamu (bucket privat "voices") ----------

const voices = () => supabase.storage.from("voices");

export async function uploadVoice(path, blob) {
  const { error } = await voices().upload(path, blob, { contentType: blob.type || "audio/webm", upsert: false });
  if (error && !/exists|duplicate/i.test(error.message)) throw error;
}

export async function voiceUrls(paths) {
  if (!paths.length) return {};
  const { data, error } = await voices().createSignedUrls(paths, 3600);
  if (error) throw error;
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

export async function removeVoices(paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await voices().remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}
