// Buka kamera, ambil bingkai, kompres. Menggambar ulang lewat canvas membuang EXIF/GPS.

export async function openCamera(video, facing = "environment") {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } },
    audio: false,
  });
  video.srcObject = stream; // <video playsinline muted autoplay>
  await video.play();
  return stream;
}

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
