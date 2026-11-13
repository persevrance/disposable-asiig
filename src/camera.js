// Buka kamera, ambil bingkai, efek film, kompres. Menggambar ulang lewat canvas membuang EXIF/GPS.
import { FILMS } from "./film.js";
import { develop, domEnv, fitSize } from "./develop.js";
import DevelopWorker from "./develop-worker.js?worker&inline";

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

// Cap tanggal ala kamera film ('26 11 11) sebagai gambar kecil, digambar di thread utama
// (teks di OffscreenCanvas belum didukung semua browser). Posisi: pojok kanan bawah foto w×h.
function makeStamp(w, h, color) {
  const d = new Date();
  const text = `'${String(d.getFullYear()).slice(2)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}`;
  const size = Math.round(Math.min(w, h) * 0.045);
  const font = `bold ${size}px "Courier New", monospace`;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  const tw = Math.ceil(probe.measureText(text).width);
  const padPx = Math.ceil(size * 0.8);                 // ruang untuk pendaran
  const c = document.createElement("canvas");
  c.width = tw + padPx * 2;
  c.height = Math.ceil(size * 1.3) + padPx * 2;
  const ctx = c.getContext("2d");
  ctx.font = font;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.4;
  ctx.fillStyle = color;
  ctx.fillText(text, c.width - padPx, c.height - padPx);
  // Sama dengan menulis rata kanan di (w - 1,2×size, h - size)
  return { image: c, x: Math.round(w - size * 1.2 - (c.width - padPx)), y: Math.round(h - size - (c.height - padPx)) };
}

// ---- Web Worker: efek film dan kompres di luar thread utama (cadangan: thread utama) ----
let worker = null;
let workerBroken = false;
let jobSeq = 0;
const waiting = new Map();

function getWorker() {
  if (workerBroken) return null;
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" ||
      !("convertToBlob" in OffscreenCanvas.prototype)) return null;
  if (!worker) {
    try {
      worker = new DevelopWorker();
      worker.onmessage = (e) => {
        const done = waiting.get(e.data.id);
        if (done) { waiting.delete(e.data.id); done(e.data); }
      };
      worker.onerror = () => {
        workerBroken = true;
        for (const done of waiting.values()) done({ ok: false, error: "worker" });
        waiting.clear();
      };
    } catch { workerBroken = true; return null; }
  }
  return worker;
}

async function developInWorker(source, sw, sh, opts, stamp) {
  const w = getWorker();
  if (!w) return null;
  const [bitmap, stampImage] = await Promise.all([createImageBitmap(source), stamp ? createImageBitmap(stamp.image) : null]);
  const id = ++jobSeq;
  const res = await new Promise((resolve) => {
    waiting.set(id, resolve);
    const st = stampImage ? { image: stampImage, x: stamp.x, y: stamp.y } : null;
    w.postMessage({ id, bitmap, opts, stamp: st }, stampImage ? [bitmap, stampImage] : [bitmap]);
    setTimeout(() => { if (waiting.delete(id)) resolve({ ok: false, error: "timeout" }); }, 20000);
  });
  if (!res.ok) { workerBroken = true; return null; } // potretan berikutnya langsung di thread utama
  return { photo: res.photo, medium: res.medium, thumb: res.thumb };
}

// opts: { maxSide, quality (0..1), mirror, film, stamp (false = tanpa cap tanggal) }
// Hasil: { photo (penuh), medium (1080 px, untuk album), thumb (400 px) }
async function process(source, sw, sh, opts) {
  const [w, h] = fitSize(sw, sh, opts.maxSide || 2560);
  const stamp = opts.stamp === false ? null : makeStamp(w, h, FILMS[opts.film]?.stamp || "#ff9a2e");
  const out = await developInWorker(source, sw, sh, opts, stamp).catch(() => null);
  return out || develop(domEnv, source, sw, sh, opts, stamp);
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
  const [w, h] = fitSize(video.videoWidth, video.videoHeight, maxSide);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(video, 0, 0, w, h);
  return c;
}

export async function captureFromCanvas(frame, opts) {
  try { return await process(frame, frame.width, frame.height, opts); }
  finally { frame.width = frame.height = 0; }
}

// Cadangan jika getUserMedia gagal: file dari <input capture>.
// File yang dibuat lebih dari 3 menit lalu ditolak (bukan potretan baru dari kamera).
export const FILE_MAX_AGE_MS = 3 * 60 * 1000;
export async function captureFromFile(file, opts) {
  if (!file.lastModified || Date.now() - file.lastModified > FILE_MAX_AGE_MS) {
    throw new CameraError("FILE_LAMA");
  }
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try { return await process(bmp, bmp.width, bmp.height, { ...opts, mirror: false }); }
  finally { bmp.close?.(); }
}
