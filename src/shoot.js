// Alur jepret: simpan di HP -> pesan jatah -> unggah -> konfirmasi
import { rpc, errorCode } from "./supabase.js";
import { uploadPhoto } from "./storage.js";
import { queue } from "./queue.js";

// Kode error yang berarti jepretan ini tidak akan pernah bisa dikirim
const FINAL = ["FILM_HABIS", "ACARA_TUTUP", "BUKAN_PESERTA"];

export async function shoot(eventId, { photo, thumb }) {
  const id = crypto.randomUUID(); // client_shot_id
  await queue.put({ id, eventId, photo, thumb, createdAt: Date.now() });
  return send(id);
}

// Dipakai juga untuk kirim ulang. Mengembalikan seq jika berhasil.
export async function send(id) {
  const job = await queue.get(id);
  if (!job) return null;
  let r;
  try {
    const data = await rpc("reserve_shot", { p_event: job.eventId, p_client_shot: id });
    r = data[0];
    if (!job.reserved) await queue.put({ ...job, reserved: true }); // jatah sudah terpotong
  } catch (e) {
    if (FINAL.includes(errorCode(e))) await queue.delete(id);
    throw e;
  }
  await uploadPhoto(r.o_thumb_path, job.thumb);
  await uploadPhoto(r.o_file_path, job.photo);
  await rpc("confirm_shot", { p_photo: r.o_photo_id });
  await queue.delete(id); // selesai, hapus dari HP
  return r.o_seq;
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
