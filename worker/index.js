// Worker situs disposable-asiig.my.id: menyajikan aplikasi (static assets) dan API foto
// di Cloudflare R2 pada /api/r2/*. Hak akses tidak diputuskan di sini: setiap permintaan
// dicek ke fungsi database Supabase memakai JWT pengguna (can_upload, r2_viewable, ...).
//
// Binding & rahasia (lihat README, bagian R2):
//   PHOTOS                 bucket R2 (wrangler.jsonc)
//   SUPABASE_URL           https://<ref>.supabase.co
//   SUPABASE_ANON_KEY      anon / publishable key (sama dengan VITE_SUPABASE_ANON_KEY)
//   SUPABASE_SERVICE_KEY   service_role / secret key: mencatat file R2, membaca foto lama
//   SIGN_SECRET            teks acak panjang untuk menandatangani URL foto
//
// Rute:
//   GET    /api/r2/health         status konfigurasi
//   PUT    /api/r2/o/<path>       unggah foto (pemotret, jepretan masih pending)
//   POST   /api/r2/sign           { paths } -> { path: url } URL bertanda tangan 1 jam
//   GET    /api/r2/o/<path>?e&s   baca foto (URL bertanda tangan); foto lama diambil dari Supabase
//   POST   /api/r2/delete         { paths } hapus (pengelola acara / superadmin)
//   POST   /api/r2/migrate        { limit } pindahkan foto lama dari Supabase ke R2 (superadmin)
//   /api/pay/*                     pembayaran Midtrans, lihat worker/pay.js

import { payApi } from "./pay.js";

const MAX_PHOTO = 15 * 1024 * 1024;
const URL_TTL = 3600;
// <acara>/<foto>.jpg, <acara>/<foto>_m.jpg, <acara>/<foto>_t.jpg; foto v1: <acara>/<pengguna>/<foto>.jpg
const PATH_RE = /^[0-9a-f-]{36}(\/[0-9a-f-]{36}){1,2}(_m|_t)?\.jpg$/;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/r2/")) {
      try {
        return await api(req, env, ctx, url);
      } catch (e) {
        return json({ error: String(e?.message || e) }, e?.status || 500);
      }
    }
    // Pembayaran Midtrans (worker/pay.js)
    if (url.pathname.startsWith("/api/pay/")) {
      try {
        return await payApi(req, env, url, { json, fail, bearer, rpc, serviceHeaders, timingSafeEqual });
      } catch (e) {
        return json({ error: String(e?.message || e) }, e?.status || 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};

async function api(req, env, ctx, url) {
  const route = url.pathname.slice("/api/r2/".length);
  if (route === "health") {
    return json({
      ok: Boolean(env.PHOTOS && env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_KEY && env.SIGN_SECRET),
      r2: Boolean(env.PHOTOS), supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
      service: Boolean(env.SUPABASE_SERVICE_KEY), sign: Boolean(env.SIGN_SECRET),
    });
  }
  if (!env.PHOTOS || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SIGN_SECRET) fail(503, "R2_BELUM_SIAP");

  if (route.startsWith("o/")) {
    const path = decodeURIComponent(route.slice(2));
    if (!PATH_RE.test(path)) fail(400, "PATH_TIDAK_VALID");
    if (req.method === "PUT") return putPhoto(req, env, path);
    if (req.method === "GET" || req.method === "HEAD") return getPhoto(req, env, ctx, url, path);
    fail(405, "METODE");
  }
  if (req.method !== "POST") fail(405, "METODE");
  const body = await req.json().catch(() => ({}));
  const jwt = bearer(req);
  if (route === "sign") return sign(env, jwt, body);
  if (route === "delete") return remove(env, jwt, body);
  if (route === "migrate") return migrate(env, jwt, body);
  fail(404, "RUTE_TIDAK_ADA");
}

// ---------- unggah ----------
async function putPhoto(req, env, path) {
  const jwt = bearer(req);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_PHOTO) fail(413, "FILE_TERLALU_BESAR");
  if (!(await rpc(env, jwt, "can_upload", { p_name: path }))) fail(403, "TIDAK_BOLEH_UNGGAH");
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_PHOTO) fail(413, "FILE_TERLALU_BESAR");
  await env.PHOTOS.put(path, buf, { httpMetadata: { contentType: "image/jpeg" } });
  await record(env, [{ name: path, size: buf.byteLength }]);
  return json({ ok: true });
}

// ---------- URL bertanda tangan ----------
async function sign(env, jwt, body) {
  const paths = (Array.isArray(body.paths) ? body.paths : []).filter((p) => PATH_RE.test(p)).slice(0, 200);
  if (!paths.length) return json({});
  const allowed = scalars(await rpc(env, jwt, "r2_viewable", { p_paths: paths }), "r2_viewable");
  const exp = Math.floor(Date.now() / 1000) + URL_TTL;
  const out = {};
  for (const p of allowed) out[p] = `/api/r2/o/${p}?e=${exp}&s=${await hmac(env, `${p}:${exp}`)}`;
  return json(out);
}

async function getPhoto(req, env, ctx, url, path) {
  const exp = Number(url.searchParams.get("e"));
  const sig = url.searchParams.get("s") || "";
  if (!exp || exp < Date.now() / 1000) fail(403, "URL_KEDALUWARSA");
  if (!timingSafeEqual(sig, await hmac(env, `${path}:${exp}`))) fail(403, "TANDA_TANGAN_SALAH");
  const headers = { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" };
  const obj = await env.PHOTOS.get(path);
  if (obj) {
    headers.ETag = obj.httpEtag;
    return new Response(req.method === "HEAD" ? null : obj.body, { headers });
  }
  // Belum dipindah: ambil dari Supabase Storage, simpan salinannya ke R2 di belakang layar
  if (!env.SUPABASE_SERVICE_KEY) fail(404, "FOTO_TIDAK_ADA");
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/photos/${path}`, { headers: serviceHeaders(env) });
  if (!res.ok) fail(404, "FOTO_TIDAK_ADA");
  const buf = await res.arrayBuffer();
  ctx.waitUntil((async () => {
    await env.PHOTOS.put(path, buf, { httpMetadata: { contentType: "image/jpeg" } });
    await record(env, [{ name: path, size: buf.byteLength }]);
  })().catch(() => {}));
  return new Response(req.method === "HEAD" ? null : buf, { headers });
}

// ---------- hapus ----------
async function remove(env, jwt, body) {
  const paths = (Array.isArray(body.paths) ? body.paths : []).filter((p) => PATH_RE.test(p)).slice(0, 500);
  if (!paths.length) return json({ deleted: 0 });
  const allowed = scalars(await rpc(env, jwt, "r2_deletable", { p_paths: paths }), "r2_deletable");
  for (let i = 0; i < allowed.length; i += 100) {
    const part = allowed.slice(i, i + 100);
    await env.PHOTOS.delete(part);
    await unrecord(env, part);
    // Salinan lama di Supabase Storage (jika belum dipindah) ikut dihapus
    await fetch(`${env.SUPABASE_URL}/storage/v1/object/photos`, {
      method: "DELETE", headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: part }),
    }).catch(() => {});
  }
  return json({ deleted: allowed.length });
}

// ---------- pindahkan foto lama (superadmin) ----------
// Maks. 20 file per panggilan: batas subrequest Worker paket gratis 50.
async function migrate(env, jwt, body) {
  if (!env.SUPABASE_SERVICE_KEY) fail(503, "SERVICE_KEY_BELUM_ADA");
  if (!(await rpc(env, jwt, "is_superadmin", {}))) fail(403, "BUKAN_SUPERADMIN");
  const limit = Math.min(20, Math.max(1, Number(body.limit) || 20));
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/r2_migration_batch`, {
    method: "POST", headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ p_limit: limit }),
  });
  if (!res.ok) fail(502, "GAGAL_MEMBACA_DAFTAR");
  const rows = await res.json();
  const remaining = rows.length ? Number(rows[0].remaining) : 0;
  const moved = [];
  for (const r of rows) {
    if (!PATH_RE.test(r.name)) continue;
    const f = await fetch(`${env.SUPABASE_URL}/storage/v1/object/photos/${r.name}`, { headers: serviceHeaders(env) });
    if (!f.ok) continue;
    const buf = await f.arrayBuffer();
    await env.PHOTOS.put(r.name, buf, { httpMetadata: { contentType: "image/jpeg" } });
    moved.push({ name: r.name, size: buf.byteLength });
  }
  if (moved.length) {
    await record(env, moved);
    // Hapus salinan Supabase setelah tersimpan di R2 dan tercatat
    await fetch(`${env.SUPABASE_URL}/storage/v1/object/photos`, {
      method: "DELETE", headers: { ...serviceHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: moved.map((m) => m.name) }),
    });
  }
  return json({ moved: moved.length, remaining: Math.max(0, remaining - moved.length) });
}

// ---------- pembantu ----------
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) fail(401, "BELUM_LOGIN");
  return m[1];
}

// Panggil fungsi database sebagai pengguna (RLS dan aturan fungsi tetap berlaku)
async function rpc(env, jwt, fn, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (res.status === 401) fail(401, "BELUM_LOGIN");
  if (!res.ok) fail(403, (await res.text()).slice(0, 200));
  return res.json();
}

// Fungsi "returns setof text" bisa dikembalikan PostgREST sebagai ["a"] atau [{fn: "a"}]
const scalars = (rows, fn) => (Array.isArray(rows) ? rows : []).map((x) => (typeof x === "string" ? x : x?.[fn])).filter(Boolean);

// Kunci format baru (sb_secret_...) bukan JWT: cukup di header apikey
function serviceHeaders(env) {
  const k = env.SUPABASE_SERVICE_KEY;
  return k.startsWith("eyJ") ? { apikey: k, Authorization: `Bearer ${k}` } : { apikey: k };
}

async function record(env, rows) {
  if (!env.SUPABASE_SERVICE_KEY || !rows.length) return;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/r2_objects`, {
    method: "POST",
    headers: { ...serviceHeaders(env), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) fail(502, "GAGAL_MENCATAT_FILE");
}

async function unrecord(env, names) {
  if (!env.SUPABASE_SERVICE_KEY || !names.length) return;
  const list = names.map((n) => `"${n}"`).join(",");
  await fetch(`${env.SUPABASE_URL}/rest/v1/r2_objects?name=in.(${encodeURIComponent(list)})`, {
    method: "DELETE", headers: serviceHeaders(env),
  }).catch(() => {});
}

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SIGN_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
