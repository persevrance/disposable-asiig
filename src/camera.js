// Buka kamera, ambil bingkai, efek film, kompres. Menggambar ulang lewat canvas membuang EXIF/GPS.
import { applyFilm, FILMS } from "./film.js";

export class CameraError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

// Browser bawaan aplikasi (Instagram, Facebook, LINE, WhatsApp, dll.) sering memblokir
// kamera, dan Google menolak login di sana.
export function inAppBrowser() {
  return /FBAN|FBAV|Instagram|Line\/|MicroMessenger|GSA\/|Twitter|TikTok|musical_ly|Snapchat|WhatsApp/i.test(navigator.userAgent);
}

export const isAndroid = () => /Android/i.test(navigator.userAgent);

// Link intent yang membuka halaman ini di Chrome dari browser bawaan aplikasi (Android)
export function chromeIntentUrl(url) {
  const u = new URL(url);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(":", "")};` +
    `package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

// maxSide: resolusi yang diminta dari pengaturan (sisi terpanjang, piksel)
export async function openCamera(video, facing = "environment", maxSide = 2560) {
  if (!window.isSecureContext) throw new CameraError("NOT_HTTPS");
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(inAppBrowser() ? "IN_APP" : "UNSUPPORTED");
  }

  // iOS butuh atribut ini sebagai properti juga, bukan hanya di HTML
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.muted = true;
  video.playsInline = true;

  const tries = [
    { facingMode: { ideal: facing }, width: { ideal: maxSide }, height: { ideal: Math.round(maxSide * 0.75) } },
    { facingMode: { ideal: facing }, width: { ideal: 1920 } },
    true,
  ];
  let stream, last;
  for (const constraints of tries) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      break;
    } catch (e) {
      last = e;
      if (e.name === "NotAllowedError" || e.name === "SecurityError") throw new CameraError("DENIED", e.name);
      // Batasan tidak cocok: coba yang lebih longgar
    }
  }
  if (!stream) {
    if (last?.name === "NotFoundError") throw new CameraError("NO_CAMERA", last.name);
    if (last?.name === "NotReadableError") throw new CameraError("BUSY", last.name);
    throw new CameraError("OTHER", `${last?.name}: ${last?.message}`);
  }

  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // iOS kadang menolak play() di luar ketukan; aliran tetap ada,
    // pemanggil menampilkan tombol "ketuk untuk mulai".
    stream.needsTap = true;
  }
  // Tunggu ukuran bingkai tersedia (iOS bisa 0 sesaat setelah play)
  if (!video.videoWidth) {
    await new Promise((res) => {
      const done = () => res();
      video.addEventListener("loadedmetadata", done, { once: true });
      setTimeout(done, 2000);
    });
  }
  return stream;
}

export const CAMERA_HELP = {
  NOT_HTTPS: "Kamera hanya bisa dibuka lewat alamat HTTPS. Buka https://disposable-asiig.my.id.",
  IN_APP: "Link ini terbuka di browser bawaan aplikasi, yang memblokir kamera. Ketuk menu (⋯ atau ⋮) lalu pilih \"Buka di Safari\" / \"Open in browser\".",
  UNSUPPORTED: "Browser ini tidak mendukung kamera web. Di iPhone, pakai Safari (iOS 14.3 ke atas).",
  DENIED: "Izin kamera ditolak. Di iPhone: ketuk \"aA\" di bilah alamat Safari -> Pengaturan Situs Web -> Kamera -> Izinkan, lalu muat ulang. Atau Pengaturan iPhone -> Safari -> Kamera -> Tanya/Izinkan.",
  NO_CAMERA: "Kamera tidak ditemukan di perangkat ini.",
  BUSY: "Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.",
  OTHER: "Kamera tidak bisa dibuka.",
};

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// Jumlah kamera (untuk menentukan tombol balik kamera)
export async function cameraCount() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === "videoinput").length;
  } catch { return 2; }
}

// ---------- Flash ----------

// Apakah kamera ini punya lampu yang bisa dinyalakan dari browser?
export function hasTorch(stream) {
  const t = stream?.getVideoTracks()[0];
  try { return Boolean(t?.getCapabilities?.().torch); } catch { return false; }
}

export async function setTorch(stream, on) {
  const t = stream?.getVideoTracks()[0];
  if (!t) return;
  try { await t.applyConstraints({ advanced: [{ torch: on }] }); } catch { /* tidak didukung */ }
}

// ---------- Mengolah foto ----------

const pad = (n) => String(n).padStart(2, "0");

// Cap tanggal ala kamera film: '26 11 11 di pojok kanan bawah
function stampDate(ctx, w, h, color) {
  const d = new Date();
  const text = `'${String(d.getFullYear()).slice(2)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}`;
  const size = Math.round(Math.min(w, h) * 0.045);
  ctx.font = `bold ${size}px "Courier New", monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.4;
  ctx.fillStyle = color;
  ctx.fillText(text, w - size * 1.2, h - size * 1.0);
  ctx.shadowBlur = 0;
}

function toBlob(canvas, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Gagal membuat JPEG"))), "image/jpeg", quality));
}

function drawScaled(source, sw, sh, maxSide, mirror = false) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext("2d");
  if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

export const MEDIUM_SIDE = 1080;
export const THUMB_SIDE = 400;

// opts: { maxSide, quality (0..1), mirror, film }
// Hasil: { photo (penuh), medium (1080 px, untuk album), thumb (400 px) }
async function develop(source, sw, sh, opts) {
  const full = drawScaled(source, sw, sh, opts.maxSide || 2560, opts.mirror);
  applyFilm(full, opts.film);
  stampDate(full.getContext("2d"), full.width, full.height, FILMS[opts.film]?.stamp || "#ff9a2e");
  const photo = await toBlob(full, opts.quality || 0.88);
  const medium = await toBlob(drawScaled(full, full.width, full.height, MEDIUM_SIDE), 0.78);
  const thumb = await toBlob(drawScaled(full, full.width, full.height, THUMB_SIDE), 0.7);
  full.width = full.height = 0; // lepaskan memori canvas besar (penting di iOS)
  return { photo, medium, thumb };
}

// Salin satu bingkai video secepatnya (saat flash menyala); diolah sesudahnya
export function grabFrame(video) {
  if (!video.videoWidth || video.paused) throw new Error("Jendela bidik belum menyala");
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  return c;
}

// Bingkai kecil untuk pratinjau efek film di pemilih
export function grabSmall(video, maxSide = 240) {
  if (!video.videoWidth || video.paused) return null;
  return drawScaled(video, video.videoWidth, video.videoHeight, maxSide);
}

export async function captureFromCanvas(frame, opts) {
  try { return await develop(frame, frame.width, frame.height, opts); }
  finally { frame.width = frame.height = 0; }
}

// Cadangan jika getUserMedia gagal: file dari <input capture>.
// File yang dibuat lebih dari 3 menit lalu ditolak (bukan jepretan baru dari kamera).
export const FILE_MAX_AGE_MS = 3 * 60 * 1000;
export async function captureFromFile(file, opts) {
  if (!file.lastModified || Date.now() - file.lastModified > FILE_MAX_AGE_MS) {
    throw new CameraError("FILE_LAMA");
  }
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try { return await develop(bmp, bmp.width, bmp.height, { ...opts, mirror: false }); }
  finally { bmp.close?.(); }
}
