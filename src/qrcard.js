// Kartu QR siap cetak untuk meja tamu: sampul, nama acara, jadwal, QR, kode, dan
// tiga langkah singkat. Ukuran A6 tegak pada 300 dpi (1240 × 1748 px).
import QRCode from "qrcode";
import { download, safeName, fmtRange, toast } from "./ui.js";

const W = 1240, H = 1748;
const C = {
  bg: "#fff7ec", ink: "#2d1b33", muted: "#6e5d72", coral: "#d6336c",
  soft: "#ffe1ea", sun: "#ffc23c", sunSoft: "#fff1c9", mint: "#2ec4a0", line: "#f1dfcf",
};
const DISPLAY = '"Fredoka", "Nunito", system-ui, sans-serif';
const BODY = '"Nunito", system-ui, sans-serif';

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

async function draw(ev, withCover) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  await Promise.all([
    document.fonts?.load(`600 80px ${DISPLAY}`), document.fonts?.load(`700 40px ${BODY}`),
  ].filter(Boolean)).catch(() => {});

  // Latar krem dengan dua lingkaran lembut
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.soft; ctx.beginPath(); ctx.arc(80, 60, 360, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C.sunSoft; ctx.beginPath(); ctx.arc(W - 40, 300, 300, 0, Math.PI * 2); ctx.fill();

  let y = 90;
  if (withCover && ev.coverUrl) {
    const img = await loadImage(ev.coverUrl);
    const bw = W - 180, bh = 560, bx = 90;
    const s = Math.max(bw / img.width, bh / img.height);
    const sw = bw / s, sh = bh / s;
    ctx.save();
    ctx.translate(W / 2, y + bh / 2); ctx.rotate(-0.02); ctx.translate(-W / 2, -(y + bh / 2));
    ctx.fillStyle = "#fff";
    roundRect(ctx, bx - 14, y - 14, bw + 28, bh + 28, 46); ctx.fill();
    roundRect(ctx, bx, y, bw, bh, 34); ctx.clip();
    ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, bx, y, bw, bh);
    ctx.restore();
    y += bh + 70;
  } else {
    y += 40;
  }

  // Nama acara dan jadwal
  ctx.textAlign = "center";
  ctx.fillStyle = C.ink;
  ctx.font = `600 ${withCover && ev.coverUrl ? 84 : 104}px ${DISPLAY}`;
  const nameLines = wrap(ctx, ev.name, W - 200, 2);
  const lh = withCover && ev.coverUrl ? 96 : 118;
  for (const l of nameLines) { y += lh * 0.8; ctx.fillText(l, W / 2, y); y += lh * 0.2; }
  const when = fmtRange(ev.starts, ev.ends);
  if (when) {
    y += 56;
    ctx.font = `700 38px ${BODY}`; ctx.fillStyle = C.muted;
    ctx.fillText(when, W / 2, y);
  }

  // QR dalam kartu putih
  const qrSize = withCover && ev.coverUrl ? 520 : 640;
  y += 60;
  const cardW = qrSize + 120, cardX = (W - cardW) / 2, cardH = qrSize + 230;
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(120, 60, 40, .14)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12;
  roundRect(ctx, cardX, y, cardW, cardH, 48); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.font = `800 40px ${BODY}`; ctx.fillStyle = C.coral;
  ctx.fillText("Scan untuk ikut memotret", W / 2, y + 78);
  const qr = document.createElement("canvas");
  await QRCode.toCanvas(qr, ev.link, { width: qrSize, margin: 0, color: { dark: C.ink, light: "#ffffff" } });
  ctx.drawImage(qr, (W - qrSize) / 2, y + 112, qrSize, qrSize);
  // "atau masukkan kode ABC123", ditengahkan sebagai satu baris
  const lead = "atau masukkan kode ";
  const leadFont = `700 34px ${BODY}`, codeFont = `700 48px "Courier New", monospace`;
  ctx.font = leadFont; const lw = ctx.measureText(lead).width;
  ctx.font = codeFont; const cw = ctx.measureText(ev.code).width;
  const lx = (W - lw - cw) / 2, ly = y + 112 + qrSize + 72;
  ctx.textAlign = "left";
  ctx.font = leadFont; ctx.fillStyle = C.muted; ctx.fillText(lead, lx, ly);
  ctx.font = codeFont; ctx.fillStyle = C.coral; ctx.fillText(ev.code, lx + lw, ly + 2);
  ctx.textAlign = "center";
  y += cardH + 70;

  // Tiga langkah
  const steps = [["1", "Scan QR"], ["2", "Masuk dengan Google"], ["3", `Jepret ${ev.maxShots} foto`]];
  const colW = (W - 160) / 3;
  steps.forEach(([n, t], i) => {
    const cx = 80 + colW * i + colW / 2;
    ctx.fillStyle = [C.soft, C.sunSoft, "#d6f5ec"][i];
    ctx.beginPath(); ctx.arc(cx, y + 36, 36, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.ink; ctx.font = `600 40px ${DISPLAY}`;
    ctx.fillText(n, cx, y + 50);
    ctx.font = `700 30px ${BODY}`; ctx.fillStyle = C.ink;
    ctx.fillText(t, cx, y + 118);
  });

  // Kaki kartu
  ctx.font = `600 30px ${BODY}`; ctx.fillStyle = C.muted;
  ctx.fillText("Foto terbuka bersama setelah film habis · Disposable Asiig", W / 2, H - 70);
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
