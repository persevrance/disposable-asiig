// Alur jepret: simpan di HP -> pesan jatah -> unggah -> konfirmasi
import { rpc, errorCode } from "./supabase.js";
import { uploadPhoto } from "./storage.js";
import { queue } from "./queue.js";

// Kode error yang berarti jepretan ini tidak akan pernah bisa dikirim
const FINAL = ["FILM_HABIS", "ACARA_TUTUP", "BUKAN_PESERTA", "AKUN_DIBLOKIR"];

// film: efek film yang dipakai (dicatat di server untuk penampil foto)
export async function shoot(eventId, { photo, medium, thumb }, film = null) {
  const id = crypto.randomUUID(); // client_shot_id
  await queue.put({ id, eventId, photo, medium, thumb, film, createdAt: Date.now() });
  return send(id);
}

// Dipakai juga untuk kirim ulang. Mengembalikan seq jika berhasil.
export async function send(id) {
  const job = await queue.get(id);
  if (!job) return null;
  let r;
  try {
    const data = await reserve(job.eventId, id, job.film);
    r = data[0];
    if (!job.reserved) await queue.put({ ...job, reserved: true }); // jatah sudah terpotong
  } catch (e) {
    if (FINAL.includes(errorCode(e))) await queue.delete(id);
    throw e;
  }
  await uploadPhoto(r.o_thumb_path, job.thumb);
  // Jepretan yang diantre sebelum v2 belum punya versi sedang: pakai thumbnail
  if (r.o_medium_path) await uploadPhoto(r.o_medium_path, job.medium || job.thumb);
  await uploadPhoto(r.o_file_path, job.photo);
  await rpc("confirm_shot", { p_photo: r.o_photo_id });
  await queue.delete(id); // selesai, hapus dari HP
  return r.o_seq;
}

// Database yang belum diperbarui ke Fase 3 belum mengenal p_film: ulangi tanpa itu
async function reserve(eventId, clientShot, film) {
  try {
    return await rpc("reserve_shot", { p_event: eventId, p_client_shot: clientShot, p_film: film || null });
  } catch (e) {
    if (e?.code !== "PGRST202") throw e;
    return rpc("reserve_shot", { p_event: eventId, p_client_shot: clientShot });
  }
}

let flushing = null;
// Kirim semua isi antrean (saat aplikasi dibuka dan saat koneksi kembali)
export function flushQueue() {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    for (const id of await queue.ids()) {
      try { if (await send(id)) sent++; } catch { /* dicoba lagi nanti */ }
    }
    return sent;
  })().finally(() => { flushing = null; });
  return flushing;
}
