// Buka kamera, ambil bingkai, kompres. Menggambar ulang lewat canvas membuang EXIF/GPS.

export class CameraError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

// Browser bawaan aplikasi (Instagram, Facebook, LINE, dll.) sering memblokir kamera
export function inAppBrowser() {
  return /FBAN|FBAV|Instagram|Line\/|MicroMessenger|GSA\/|Twitter|TikTok|musical_ly|Snapchat/i.test(navigator.userAgent);
}

export async function openCamera(video, facing = "environment") {
  if (!window.isSecureContext) throw new CameraError("NOT_HTTPS");
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(inAppBrowser() ? "IN_APP" : "UNSUPPORTED");
  }

  // iOS butuh atribut ini sebagai properti juga, bukan hanya di HTML
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.muted = true;
  video.playsInline = true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
  } catch (e) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError") throw new CameraError("DENIED", e.name);
    // Batasan resolusi/kamera tidak cocok: coba tanpa batasan
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (e2) {
      if (e2.name === "NotAllowedError") throw new CameraError("DENIED", e2.name);
      if (e2.name === "NotFoundError") throw new CameraError("NO_CAMERA", e2.name);
      if (e2.name === "NotReadableError") throw new CameraError("BUSY", e2.name);
      throw new CameraError("OTHER", `${e2.name}: ${e2.message}`);
    }
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

const pad = (n) => String(n).padStart(2, "0");

// Cap tanggal ala kamera film: '26 11 11 di pojok kanan bawah
function stampDate(ctx, w, h) {
  const d = new Date();
  const text = `'${String(d.getFullYear()).slice(2)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}`;
  const size = Math.round(Math.min(w, h) * 0.045);
  ctx.font = `bold ${size}px "Courier New", monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.shadowColor = "rgba(255,120,0,0.8)";
  ctx.shadowBlur = size * 0.4;
  ctx.fillStyle = "#ff9a2e";
  ctx.fillText(text, w - size * 1.2, h - size * 1.0);
  ctx.shadowBlur = 0;
}

function toBlob(canvas, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Gagal membuat JPEG"))), "image/jpeg", quality));
}

function drawScaled(source, sw, sh, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext("2d");
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

// Satu bingkai -> { photo (1600 px), thumb (400 px) }. Foto tidak dicerminkan.
export async function captureFromVideo(video) {
  if (!video.videoWidth || video.paused) throw new Error("Jendela bidik belum menyala");
  const full = drawScaled(video, video.videoWidth, video.videoHeight, 1600);
  return finish(full);
}

// Cadangan jika getUserMedia gagal: file dari <input capture>
export async function captureFromFile(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const full = drawScaled(bmp, bmp.width, bmp.height, 1600);
  bmp.close?.();
  return finish(full);
}

async function finish(full) {
  // Efek film sederhana: sedikit hangat + cap tanggal
  const ctx = full.getContext("2d");
  ctx.globalCompositeOperation = "soft-light";
  ctx.fillStyle = "rgba(255,170,90,0.18)";
  ctx.fillRect(0, 0, full.width, full.height);
  ctx.globalCompositeOperation = "source-over";
  stampDate(ctx, full.width, full.height);

  const photo = await toBlob(full, 0.8);
  const thumb = await toBlob(drawScaled(full, full.width, full.height, 400), 0.7);
  return { photo, thumb };
}
