// "Mencuci" satu bingkai: perkecil ke resolusi pengaturan, cermin (opsional), efek film,
// cap tanggal, lalu tiga JPEG (penuh, sedang, thumbnail).
// Tanpa DOM, sehingga bisa berjalan di thread utama maupun di Web Worker (OffscreenCanvas).
import { applyFilm } from "./film.js";

export const MEDIUM_SIDE = 1080;
export const THUMB_SIDE = 400;

// Lingkungan kanvas: DOM (thread utama) atau OffscreenCanvas (worker)
export const domEnv = {
  canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; },
  toBlob: (c, q) => new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("Gagal membuat JPEG"))), "image/jpeg", q)),
};
export const offscreenEnv = {
  canvas: (w, h) => new OffscreenCanvas(w, h),
  toBlob: (c, q) => c.convertToBlob({ type: "image/jpeg", quality: q }),
};

// Ukuran hasil akhir untuk sumber sw×sh dengan sisi terpanjang maxSide
export function fitSize(sw, sh, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  return [Math.round(sw * scale), Math.round(sh * scale)];
}

function drawScaled(env, source, sw, sh, maxSide, mirror = false) {
  const [w, h] = fitSize(sw, sh, maxSide);
  const c = env.canvas(w, h);
  const ctx = c.getContext("2d");
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, 0, 0, w, h);
  return c;
}

// stamp: { image, x, y } dibuat di thread utama (lihat makeStamp di camera.js)
export async function develop(env, source, sw, sh, opts, stamp) {
  const full = drawScaled(env, source, sw, sh, opts.maxSide || 2560, opts.mirror);
  applyFilm(full, opts.film);
  if (stamp?.image) full.getContext("2d").drawImage(stamp.image, stamp.x, stamp.y);
  const photo = await env.toBlob(full, opts.quality || 0.88);
  const medium = await env.toBlob(drawScaled(env, full, full.width, full.height, MEDIUM_SIDE), 0.78);
  const thumb = await env.toBlob(drawScaled(env, full, full.width, full.height, THUMB_SIDE), 0.7);
  full.width = full.height = 0; // lepaskan memori kanvas besar (penting di iOS)
  return { photo, medium, thumb };
}
