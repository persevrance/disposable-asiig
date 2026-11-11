// SATU-SATUNYA file yang berbeda antara P1 (Supabase Storage) dan P2 (Cloudflare R2).
// Versi ini: P1.
import { supabase } from "./supabase.js";

const bucket = () => supabase.storage.from("photos");

export async function uploadPhoto(path, blob) {
  const { error } = await bucket().upload(path, blob, { contentType: "image/jpeg", upsert: false });
  // "sudah ada" berarti percobaan sebelumnya sebenarnya berhasil
  if (error && !/exists|duplicate/i.test(error.message)) throw error;
}

// URL sementara (1 jam) untuk banyak file sekaligus -> { path: url }
export async function getUrls(paths) {
  if (!paths.length) return {};
  const { data, error } = await bucket().createSignedUrls(paths, 3600);
  if (error) throw error;
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

// Dipakai panel pemilik saat menghapus acara atau jepretan macet
export async function removeFiles(paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await bucket().remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}
