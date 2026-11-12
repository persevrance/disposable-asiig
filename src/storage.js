// Penyimpanan foto: Supabase Storage atau Cloudflare R2 (lewat Worker situs, /api/r2/*).
// Dipilih saat aplikasi berjalan dari pengaturan superadmin (app_settings.storage_backend).
// Sampul dan rekaman suara tetap di Supabase Storage.
import { supabase } from "./supabase.js";

const bucket = () => supabase.storage.from("photos");

let backend = "supabase";
export const setStorageBackend = (b) => { backend = b === "r2" ? "r2" : "supabase"; };
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

// URL sementara (1 jam) untuk banyak file sekaligus -> { path: url }
export async function getUrls(paths) {
  if (!paths.length) return {};
  if (backend === "r2") {
    const out = {};
    for (let i = 0; i < paths.length; i += 200) {
      const got = await postJson("sign", { paths: paths.slice(i, i + 200) });
      for (const [p, u] of Object.entries(got)) out[p] = new URL(u, location.origin).href;
    }
    return out;
  }
  const { data, error } = await bucket().createSignedUrls(paths, 3600);
  if (error) throw error;
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

// Dipakai panel pemilik saat menghapus acara atau jepretan macet
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
