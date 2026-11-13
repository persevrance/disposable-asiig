// Kartu QR siap cetak untuk meja tamu: sampul, nama acara, jadwal, QR, kode, dan
// tiga langkah singkat. Ukuran A6 tegak pada 300 dpi (1240 × 1748 px).
import QRCode from "qrcode";
import { download, safeName, fmtRange, toast } from "./ui.js";

const W = 1240, H = 1748;
const C = {
  bg: "#fff7ec", ink: "#1f2a44", muted: "#5b6475", coral: "#c4471f", flash: "#e8603c",
  soft: "#fde4d8", line: "#e6dccd",
};
const DISPLAY = '"Plus Jakarta Sans", system-ui, sans-serif';
const BODY = '"Plus Jakarta Sans", system-ui, sans-serif';

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Pecah teks menjadi baris yang muat di lebar tertentu (maks. n baris, sisanya "…")
function wrap(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width <= maxW) line = t;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (ctx.measureText(last + "…").width > maxW && last.length) last = last.slice(0, -1);
    lines[maxLines - 1] = last + "…";
  }
  return lines;
}

// Logo TitipPotret (label titipan berbentuk kamera) pada kotak 100×100, digambar di (x, y) dengan ukuran size
function drawMark(ctx, x, y, size) {
  const k = size / 100;
  const dot = (cx, cy, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); };
  ctx.save();
  ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = C.ink; ctx.fill(new Path2D("M34 12 H82 Q90 12 90 20 V80 Q90 88 82 88 H34 L10 50 Z"));
  dot(24, 50, 4.5, C.bg);
  ctx.fillStyle = C.flash; roundRect(ctx, 72, 19, 10, 6, 2); ctx.fill();
  dot(60, 50, 18, C.bg);
  dot(60, 50, 10, C.flash);
  ctx.restore();
}

// Teks dengan jarak antarhuruf (canvas lama tidak punya letterSpacing)
function spaced(ctx, text, cx, y, spacing) {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let x = cx - total / 2;
  const align = ctx.textAlign;
  ctx.textAlign = "left";
  chars.forEach((ch, i) => { ctx.fillText(ch, x, y); x += widths[i] + spacing; });
  ctx.textAlign = align;
}

// Tata letak mengikuti desain "Kartu QR meja tamu" (420 × 595), diperbesar ke A6 300 dpi
async function draw(ev, withCover) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const s = W / 420;
  await Promise.all([
    document.fonts?.load(`600 80px ${DISPLAY}`), document.fonts?.load(`800 40px ${BODY}`),
  ].filter(Boolean)).catch(() => {});

  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

  // Pita sampul di atas (atau warna lembut bila tanpa sampul)
  const band = 120 * s;
  if (withCover && ev.coverUrl) {
    const img = await loadImage(ev.coverUrl);
    const sc = Math.max(W / img.width, band / img.height);
    const sw = W / sc, sh = band / sc;
    ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, W, band);
  } else {
    ctx.fillStyle = C.soft; ctx.fillRect(0, 0, W, band);
  }

  // Ikon aplikasi di tepi bawah pita
  const icon = 52 * s, ix = (W - icon) / 2, iy = band - 26 * s;
  ctx.fillStyle = C.bg; roundRect(ctx, ix, iy, icon, icon, 16 * s); ctx.fill();
  ctx.fillStyle = C.flash; roundRect(ctx, ix + 4 * s, iy + 4 * s, icon - 8 * s, icon - 8 * s, 12 * s); ctx.fill();
  drawMark(ctx, ix + 9 * s, iy + 9 * s, 34 * s);

  ctx.textAlign = "center";
  let y = band + 38 * s;

  // Ajakan + nama acara + jadwal
  ctx.font = `800 ${13 * s}px ${BODY}`; ctx.fillStyle = C.coral;
  y += 13 * s;
  spaced(ctx, "IKUT MEMOTRET YUK!", W / 2, y, 0.8 * s);
  ctx.font = `600 ${28 * s}px ${DISPLAY}`; ctx.fillStyle = C.ink;
  const nameLines = wrap(ctx, ev.name, W - 64 * s, 2);
  y += 6 * s;
  for (const l of nameLines) { y += 30 * s; ctx.fillText(l, W / 2, y); }
  const when = fmtRange(ev.starts, ev.ends);
  if (when) {
    y += 20 * s;
    ctx.font = `700 ${12 * s}px ${BODY}`; ctx.fillStyle = C.muted;
    ctx.fillText(when, W / 2, y);
  }

  // QR dalam kotak putih bergaris. Mengecil bila nama dua baris + jadwal memakan ruang,
  // supaya kode dan tiga langkah di bawahnya tidak bertumpuk.
  const foot = H - 40 * s;
  const sy = foot - 62 * s;
  y += 16 * s;
  const pad = 14 * s;
  const room = sy - 30 * s - y - 56 * s - pad * 2;
  const qrSize = Math.max(110 * s, Math.min(150 * s, room)), box = qrSize + pad * 2;
  ctx.fillStyle = "#fff"; roundRect(ctx, (W - box) / 2, y, box, box, 18 * s); ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5 * s; roundRect(ctx, (W - box) / 2, y, box, box, 18 * s); ctx.stroke();
  const qr = document.createElement("canvas");
  await QRCode.toCanvas(qr, ev.link, { width: qrSize, margin: 0, color: { dark: C.ink, light: "#ffffff" } });
  ctx.drawImage(qr, (W - qrSize) / 2, y + pad, qrSize, qrSize);
  y += box;

  // Kode
  y += 26 * s;
  ctx.font = `600 ${13 * s}px ${BODY}`; ctx.fillStyle = C.muted;
  ctx.fillText("atau masukkan kode", W / 2, y);
  y += 30 * s;
  ctx.font = `600 ${26 * s}px ${DISPLAY}`; ctx.fillStyle = C.ink;
  spaced(ctx, ev.code, W / 2, y, 0.2 * 26 * s);

  // Tiga langkah, rata bawah di atas kaki kartu
  const steps = [["1", "Scan QR"], ["2", "Login Google"], ["3", `${ev.maxShots} potretan untukmu`]];
  const colW = (W - 64 * s) / 3;
  steps.forEach(([n, t], i) => {
    const cx = 32 * s + colW * i + colW / 2;
    ctx.font = `600 ${16 * s}px ${DISPLAY}`; ctx.fillStyle = C.coral;
    ctx.fillText(n, cx, sy);
    ctx.font = `600 ${12 * s}px ${BODY}`; ctx.fillStyle = C.muted;
    wrap(ctx, t, colW - 8 * s, 2).forEach((l, j) => ctx.fillText(l, cx, sy + (20 + j * 16) * s));
  });

  // Kaki: garis putus-putus + wordmark
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5 * s; ctx.setLineDash([6 * s, 5 * s]);
  ctx.beginPath(); ctx.moveTo(0, foot); ctx.lineTo(W, foot); ctx.stroke(); ctx.setLineDash([]);
  // Wordmark "Titip" Medium + "Potret" ExtraBold, di tengah
  ctx.fillStyle = C.ink;
  const wmPx = 15 * s, wmAlign = ctx.textAlign;
  ctx.font = `500 ${wmPx}px ${DISPLAY}`; const wa = ctx.measureText("Titip").width;
  ctx.font = `800 ${wmPx}px ${DISPLAY}`; const wb = ctx.measureText("Potret").width;
  const wx = W / 2 - (wa + wb) / 2;
  ctx.textAlign = "left";
  ctx.font = `500 ${wmPx}px ${DISPLAY}`; ctx.fillText("Titip", wx, foot + 26 * s);
  ctx.font = `800 ${wmPx}px ${DISPLAY}`; ctx.fillText("Potret", wx + wa, foot + 26 * s);
  ctx.textAlign = wmAlign;
  return c;
}

// Mengembalikan canvas kartu. Jika sampul tidak bisa dipakai (mis. CORS), tanpa sampul.
export async function renderQrCard(ev) {
  try { const c = await draw(ev, true); c.toDataURL(); return c; }
  catch { return draw(ev, false); }
}

export async function downloadQrCard(ev) {
  toast("Membuat kartu QR…", 4000);
  const c = await renderQrCard(ev);
  download(c.toDataURL("image/png"), `kartu-qr-${safeName(ev.name, "acara")}.png`);
  toast("Kartu QR terunduh.");
}

// Cetak: kartu ditaruh di lembar khusus cetak, sisa halaman disembunyikan lewat CSS @media print
export async function printQrCard(ev) {
  toast("Menyiapkan cetak…", 4000);
  const c = await renderQrCard(ev);
  const sheet = document.createElement("div");
  sheet.className = "print-sheet";
  const img = new Image();
  img.alt = `Kartu QR ${ev.name}`;
  img.src = c.toDataURL("image/png");
  sheet.append(img);
  document.body.append(sheet);
  document.body.classList.add("printing");
  const done = () => { sheet.remove(); document.body.classList.remove("printing"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  await img.decode().catch(() => {});
  window.print();
  setTimeout(done, 60000); // cadangan bila afterprint tidak terpanggil
}
