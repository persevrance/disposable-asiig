// Kolase v2: 1–9 foto pilihan tamu. Empat pilihan bebas yang bisa dipadukan: tata letak,
// ornamen (lapisan, bukan template), ukuran, dan teks. Data pilihan ada di collage-layouts.js.
// Dibuat di HP (canvas), tidak diunggah, tidak memakai kuota unduhan (BR-09).
// photos: [{ id, url, thumb, owner_name }] — url ukuran sedang (1080 px), thumb 400 px.
// Pratinjau editor memakai thumbnail; foto sedang baru dimuat saat Selesai.
import { el, esc, toast, modal, download, safeName, fmtRange, ICON } from "./ui.js";
import { t, locale } from "./i18n.js";
import {
  LAYOUTS, ORNAMENTS, SIZES, BACKGROUNDS, ORN_BACKGROUNDS, WASHI, CONFETTI, STAMP, TAPE, CARD, layoutCells,
} from "./collage-layouts.js";

export const COLLAGE_MAX = 9;
const FLASH = "#e8603c";
const DISPLAY = '"Plus Jakarta Sans", system-ui, sans-serif';
const BODY = '"Plus Jakarta Sans", system-ui, sans-serif';
const ORN = Object.fromEntries(ORNAMENTS.map((o) => [o.id, o]));
const PREVIEW_SCALE = 0.5;

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("img"));
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Logo TitipPotret (kotak 100×100: label titipan berbentuk kamera) di (x, y) berukuran size
const TAG = "M34 12 H82 Q90 12 90 20 V80 Q90 88 82 88 H34 L10 50 Z";
function drawMark(ctx, x, y, size, body, cut, accent = FLASH) {
  const k = size / 100;
  const dot = (cx, cy, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); };
  ctx.save();
  ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = body; ctx.fill(new Path2D(TAG));
  dot(24, 50, 4.5, cut);
  ctx.fillStyle = accent; roundRect(ctx, 72, 19, 10, 6, 2); ctx.fill();
  dot(60, 50, 18, cut);
  dot(60, 50, 10, accent);
  dot(56.5, 46.5, 3, cut);
  ctx.restore();
}

// Wordmark "Titip" Medium + "Potret" ExtraBold, rata kiri di (x, y); mengembalikan lebarnya
function wordmarkWidth(ctx, px) {
  ctx.font = `500 ${px}px ${DISPLAY}`; const a = ctx.measureText("Titip").width;
  ctx.font = `800 ${px}px ${DISPLAY}`; return a + ctx.measureText("Potret").width;
}
function drawWordmark(ctx, x, y, px) {
  ctx.font = `500 ${px}px ${DISPLAY}`; ctx.fillText("Titip", x, y);
  const a = ctx.measureText("Titip").width;
  ctx.font = `800 ${px}px ${DISPLAY}`; ctx.fillText("Potret", x + a, y);
}

// Potong teks dengan "…" bila melebihi lebar
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

function cover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

// Angka acak berbenih (benih event_id): konfeti sama setiap kali kolase dibuat ulang
function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const pad2 = (n) => String(n).padStart(2, "0");
const SERIF = 'Georgia, "Times New Roman", serif';
const MONO = '"Courier New", ui-monospace, monospace';
// Tanggal acara untuk kolase: tanggal mulai acara, atau hari ini bila acara belum berjadwal
function eventDate(ev, style = "long") {
  const d = ev.starts_at ? new Date(ev.starts_at) : new Date();
  return d.toLocaleDateString(locale, style === "long" ? { weekday: "long", day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "long", year: "numeric" });
}
function stampText(ev) {
  const d = ev.starts_at ? new Date(ev.starts_at) : new Date();
  return `'${String(d.getFullYear()).slice(2)} ${pad2(d.getMonth() + 1)} ${pad2(d.getDate())}`;
}

// Font Plus Jakarta Sans harus termuat dulu, kalau tidak teks jatuh ke font cadangan
async function fontsReady() {
  try {
    await Promise.all([document.fonts?.load(`600 48px ${DISPLAY}`), document.fonts?.load(`700 26px ${BODY}`)].filter(Boolean));
    await document.fonts?.ready;
  } catch { /* abaikan */ }
}

// Geometri dalam px ukuran keluaran (lebar 1080)
function geometry(o, n) {
  const F = SIZES[o.size], orn = ORN[o.orn];
  const story = o.size === "story";
  const m = 56, band = orn.band || 0, head = orn.head || 0;
  // Teks di kaki: nama dan/atau tanggal. Ornamen berkop menaruh teksnya di kop, kakinya hanya logo.
  const wantText = o.name || o.date;
  const showText = !orn.masthead && (wantText || Boolean(orn.card));
  const textFoot = story ? 360 : o.size === "square" ? 150 : 170;
  const logoFoot = story ? 300 : 110;                     // logo saja tanpa nama acara
  const top = (story ? 220 : m) + band + head;            // Story: ruang aman tampilan Instagram
  const foot = (showText ? textFoot : o.logo ? logoFoot : m) + band;
  const area = { x: m, y: top, w: F.w - 2 * m, h: F.h - top - foot };
  const gap = orn.gap;
  const cells = layoutCells(o.layout, n, story).map(([fx, fy, fw, fh]) => ({
    x: area.x + fx * (area.w + gap), y: area.y + fy * (area.h + gap),
    w: fw * (area.w + gap) - gap, h: fh * (area.h + gap) - gap,
  }));
  return { F, story, m, band, head, top, foot, showText, area, cells, headY: (story ? 220 : m) + band - (story ? 0 : 20) };
}

function theme(o) {
  const orn = ORN[o.orn];
  if (orn.bg) return ORN_BACKGROUNDS[orn.bg] || BACKGROUNDS[orn.bg];
  if (orn.card && o.bg === "gelap") return BACKGROUNDS.krem;
  return BACKGROUNDS[o.bg];
}

// Kop ornamen (di atas grid foto): koran, kamera, scrapbook. Nama/tanggal mengikuti sakelar teks.
function drawHead(ctx, o, g, th, ev, rnd) {
  const { F, m } = g, y0 = g.top - g.head, h = g.head - 24;
  const name = o.name ? ev.name || "" : "", date = o.date ? eventDate(ev) : "";
  if (o.orn === "koran") {
    ctx.fillStyle = th.ink; ctx.textBaseline = "alphabetic";
    // baris kecil di atas: edisi | tanggal
    ctx.font = `700 22px ${SERIF}`; ctx.textAlign = "left";
    ctx.fillText(t("EDISI KHUSUS"), m, y0 + 30);
    ctx.textAlign = "right"; ctx.fillText(date ? date.toUpperCase() : t("CETAKAN TITIPPOTRET"), F.w - m, y0 + 30);
    ctx.fillRect(m, y0 + 44, F.w - 2 * m, 4); ctx.fillRect(m, y0 + 52, F.w - 2 * m, 1.5);
    // judul koran = nama acara
    ctx.textAlign = "center";
    let fs = 96; ctx.font = `900 ${fs}px ${SERIF}`;
    const title = (name || "Kabar Hari Ini").toUpperCase();
    while (fs > 44 && ctx.measureText(title).width > F.w - 2 * m) { fs -= 4; ctx.font = `900 ${fs}px ${SERIF}`; }
    ctx.fillText(fit(ctx, title, F.w - 2 * m), F.w / 2, y0 + 58 + Math.min(110, h - 70) * 0.5 + fs * 0.35);
    ctx.fillRect(m, y0 + h - 6, F.w - 2 * m, 1.5); ctx.fillRect(m, y0 + h, F.w - 2 * m, 4);
    return;
  }
  if (o.orn === "kamera") {
    // bodi kamera: pelat atas, jendela bidik, rana, dan lensa
    const bx = m, by = y0 + 6, bw = F.w - 2 * m, bh = h - 12;
    ctx.fillStyle = "#3b3530"; roundRect(ctx, bx, by, bw, bh, 22); ctx.fill();
    ctx.fillStyle = "#4a433d"; roundRect(ctx, bx + 10, by + 10, bw - 20, bh * 0.36, 14); ctx.fill();
    ctx.fillStyle = "#151210"; roundRect(ctx, bx + 36, by + bh * 0.52, 120, bh * 0.3, 8); ctx.fill();   // jendela bidik
    ctx.fillStyle = "#6ec3ff"; ctx.globalAlpha = .35; roundRect(ctx, bx + 46, by + bh * 0.56, 100, bh * 0.22, 6); ctx.fill(); ctx.globalAlpha = 1;
    const lx = bx + bw - 120, ly = by + bh / 2 + 6, lr = Math.min(52, bh * 0.42);
    for (const [r, c] of [[lr, "#151210"], [lr * 0.72, "#2c2724"], [lr * 0.45, "#0b0908"], [lr * 0.16, "#5c7da8"]]) {
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(lx, ly, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#c4471f"; ctx.beginPath(); ctx.arc(bx + bw - 250, by + 24, 14, 0, Math.PI * 2); ctx.fill();   // tombol rana
    ctx.fillStyle = th.ink; ctx.font = `700 26px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("TITIPPOTRET 35", bx + 180, by + bh * 0.67);
    ctx.fillStyle = th.muted; ctx.font = `700 20px ${MONO}`;
    ctx.fillText(date ? eventDate(ev, "short").toUpperCase() : "ISO 400", bx + 180, by + bh * 0.67 + 30);
    return;
  }
  if (o.orn === "scrapbook") {
    // perangko bergerigi + cap pos di kanan, nama & tanggal tulisan tangan di kiri
    const sw = 128, sh = 150, sx = F.w - m - sw - 10, sy = y0 - 8;
    ctx.save(); ctx.translate(sx + sw / 2, sy + sh / 2); ctx.rotate((4 * Math.PI) / 180); ctx.translate(-(sx + sw / 2), -(sy + sh / 2));
    ctx.shadowColor = "rgba(60, 40, 20, .25)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#fffaf2"; ctx.fillRect(sx, sy, sw, sh);
    ctx.shadowColor = "transparent";
    ctx.fillStyle = th.bg;   // gerigi perangko
    for (let x = sx; x <= sx + sw; x += 16) { for (const yy of [sy, sy + sh]) { ctx.beginPath(); ctx.arc(x, yy, 6, 0, Math.PI * 2); ctx.fill(); } }
    for (let yy = sy; yy <= sy + sh; yy += 16) { for (const x of [sx, sx + sw]) { ctx.beginPath(); ctx.arc(x, yy, 6, 0, Math.PI * 2); ctx.fill(); } }
    ctx.fillStyle = "#c4471f"; ctx.fillRect(sx + 16, sy + 16, sw - 32, sh - 32);
    drawMark(ctx, sx + sw / 2 - 34, sy + 40, 68, "#fff7ec", "#c4471f", "#1f2a44");
    ctx.fillStyle = "#fff7ec"; ctx.font = `700 22px ${DISPLAY}`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText("Rp 2026", sx + sw / 2, sy + sh - 30);
    ctx.restore();
    // cap pos melingkar bertanggal
    const pcx = sx - 20, pcy = sy + sh * 0.62, pr = 70;
    ctx.save(); ctx.strokeStyle = "rgba(58, 40, 26, .55)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(pcx, pcy, pr, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(pcx, pcy, pr - 14, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(58, 40, 26, .6)"; ctx.font = `700 20px ${MONO}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const d = ev.starts_at ? new Date(ev.starts_at) : new Date();
    ctx.fillText(`${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`, pcx, pcy - 10);
    ctx.fillText(String(d.getFullYear()), pcx, pcy + 14);
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.moveTo(pcx + pr + 8, pcy - 30 + k * 20); ctx.bezierCurveTo(pcx + pr + 60, pcy - 44 + k * 20, pcx + pr + 90, pcy - 16 + k * 20, pcx + pr + 140, pcy - 30 + k * 20); ctx.stroke(); }
    ctx.restore();
    // nama acara dan tanggal
    const tw = sx - 120 - m;
    ctx.fillStyle = th.ink; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    let fs = 64; ctx.font = `600 ${fs}px ${DISPLAY}`;
    while (fs > 36 && ctx.measureText(name).width > tw) { fs -= 4; ctx.font = `600 ${fs}px ${DISPLAY}`; }
    if (name) ctx.fillText(fit(ctx, name, tw), m, y0 + 74);
    if (date) { ctx.font = `600 28px ${BODY}`; ctx.fillStyle = th.muted; ctx.fillText(fit(ctx, date, tw), m, y0 + (name ? 118 : 74)); }
    // garis coretan di bawah nama
    if (name) {
      ctx.strokeStyle = "#c4471f"; ctx.lineWidth = 5; ctx.lineCap = "round";
      const w = Math.min(tw, ctx.measureText(name).width + 40);
      ctx.beginPath(); ctx.moveTo(m, y0 + 140); ctx.bezierCurveTo(m + w * 0.3, y0 + 132, m + w * 0.7, y0 + 148, m + w * 0.55, y0 + 138); ctx.stroke();
    }
  }
}

// Urutan menggambar sama untuk semua kombinasi: latar → lapisan bawah ornamen → tiap kotak
// (bingkai, foto, hiasan) → lapisan atas ornamen (hanya di tepi) → kaki.
async function draw(o, imgs, ev, { scale = 1, preview = false } = {}) {
  const g = geometry(o, imgs.length);
  const { F, m, band } = g;
  const orn = ORN[o.orn];
  const th = theme(o);
  const c = document.createElement("canvas");
  c.width = Math.round(F.w * scale); c.height = Math.round(F.h * scale);
  const ctx = c.getContext("2d");
  ctx.scale(scale, scale);
  await fontsReady();

  // 1. Latar
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, F.w, F.h);

  // 1b. Tekstur latar ornamen (berbenih: sama setiap kali dibuat ulang)
  const rnd = seeded(String(ev.event_id || ev.name || "jepretin") + o.orn);
  if (o.orn === "koran" || o.orn === "scrapbook") {
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = o.orn === "koran" ? `rgba(60, 45, 25, ${0.03 + rnd() * 0.05})` : `rgba(110, 80, 45, ${0.04 + rnd() * 0.06})`;
      const x = rnd() * F.w, y = rnd() * F.h;
      if (o.orn === "koran") ctx.fillRect(x, y, 1.6 + rnd() * 2, 1.6 + rnd() * 2);
      else { ctx.save(); ctx.translate(x, y); ctx.rotate(rnd() * Math.PI); ctx.fillRect(0, 0, 6 + rnd() * 14, 1.2); ctx.restore(); }
    }
  }
  if (orn.head) drawHead(ctx, o, g, th, ev, rnd);

  // 2. Lapisan bawah: lubang film di atas dan bawah
  if (band) {
    const k = Math.floor(F.w / 54), hw = 24, hh = 18;
    ctx.fillStyle = "#fff7ec";
    for (let i = 0; i < k; i++) {
      const x = 18 + i * (F.w - 36) / k;
      roundRect(ctx, x, (band - hh) / 2, hw, hh, 4); ctx.fill();
      roundRect(ctx, x, F.h - band + (band - hh) / 2, hw, hh, 4); ctx.fill();
    }
  }

  // 3. Tiap kotak
  const stamp = orn.stamp || o.stamp, stampStr = stampText(ev);
  const pol = o.orn === "polaroid" || o.orn === "scrapbook";
  g.cells.forEach((b, i) => {
    const img = imgs[i];
    ctx.save();
    let p = b, radius = band ? 4 : 6;
    if (pol) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const tilt = o.orn === "scrapbook" ? (rnd() * 3 - 1.5) : (i % 2 ? 2 : -2);
      ctx.translate(cx, cy); ctx.rotate((tilt * Math.PI) / 180); ctx.translate(-cx, -cy);
      ctx.save();
      ctx.shadowColor = "rgba(31, 42, 68, .22)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.restore();
      const side = Math.max(12, Math.min(b.w, b.h) * 0.05);
      const bottom = o.orn === "scrapbook" ? side : Math.max(36, b.h * 0.14);
      p = { x: b.x + side, y: b.y + side, w: Math.max(1, b.w - side * 2), h: Math.max(1, b.h - side - bottom) };
      radius = 2;
    }
    ctx.save();
    roundRect(ctx, p.x, p.y, p.w, p.h, radius); ctx.clip();
    ctx.fillStyle = pol ? "#e6dccd" : th.cell; ctx.fillRect(p.x, p.y, p.w, p.h);
    if (img) cover(ctx, img, p.x, p.y, p.w, p.h);
    // Koran lama: foto hitam-putih bernuansa sepia seperti cetakan koran
    if (img && o.orn === "koran") {
      ctx.globalCompositeOperation = "saturation"; ctx.fillStyle = "#808080"; ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = "#e6d6b6"; ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
    if (o.orn === "koran") { ctx.lineWidth = 3; ctx.strokeStyle = th.ink; ctx.strokeRect(p.x, p.y, p.w, p.h); }
    // Kamera retro: sudut jendela bidik dan nomor frame (di tepi, tidak menutupi wajah)
    if (o.orn === "kamera") {
      const inset = Math.max(12, Math.min(p.w, p.h) * 0.05), len = Math.max(18, Math.min(p.w, p.h) * 0.12);
      ctx.strokeStyle = "rgba(255, 248, 240, .92)"; ctx.lineWidth = 4; ctx.lineCap = "square";
      for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = sx ? p.x + p.w - inset : p.x + inset, y = sy ? p.y + p.h - inset : p.y + inset;
        const dx = sx ? -len : len, dy = sy ? -len : len;
        ctx.beginPath(); ctx.moveTo(x + dx, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy); ctx.stroke();
      }
      if (img) {
        const fs = Math.max(16, Math.round(Math.min(p.w, p.h) * 0.06));
        ctx.font = `700 ${fs}px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillStyle = STAMP; ctx.shadowColor = "rgba(0, 0, 0, .4)"; ctx.shadowBlur = 4;
        ctx.fillText(`${pad2(i + 1)}A`, p.x + inset + 16, p.y + p.h - inset - 14);
        ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
      }
    }
    if (!img && preview) {
      ctx.setLineDash([14, 10]); ctx.lineWidth = 4; ctx.strokeStyle = th.muted;
      roundRect(ctx, p.x + 2, p.y + 2, p.w - 4, p.h - 4, radius); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = th.muted; ctx.font = `800 ${Math.round(Math.min(p.w, p.h) * 0.28)}px ${BODY}`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("+", p.x + p.w / 2, p.y + p.h / 2);
    }
    // Hiasan di atas foto: cap tanggal di pojok (tidak di tengah, tidak menutupi wajah)
    if (img && stamp) {
      const fs = Math.max(18, Math.round(Math.min(p.w, p.h) * 0.07));
      ctx.font = `700 ${fs}px "Courier New", ui-monospace, monospace`;
      ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      ctx.shadowColor = "rgba(0, 0, 0, .35)"; ctx.shadowBlur = 4;
      ctx.fillStyle = STAMP; ctx.fillText(stampStr, p.x + p.w - fs * 0.6, p.y + p.h - fs * 0.45);
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
    }
    // Scrapbook: selotip washi miring di dua sudut atas
    if (o.orn === "scrapbook") {
      const tw = Math.min(150, b.w * 0.34), tt = tw * 0.28;
      for (const [sx, rot] of [[0, -38], [1, 38]]) {
        ctx.save();
        ctx.translate(sx ? b.x + b.w - tw * 0.18 : b.x + tw * 0.18, b.y + tt * 0.2); ctx.rotate((rot * Math.PI) / 180);
        ctx.fillStyle = WASHI[Math.floor(rnd() * WASHI.length)]; ctx.fillRect(-tw / 2, -tt / 2, tw, tt);
        ctx.restore();
      }
    }
    // Hiasan di tepi kotak: selotip
    if (o.orn === "selotip") {
      const tw = Math.min(180, b.w * 0.42), tt = tw * 0.3;
      ctx.save();
      ctx.translate(b.x + b.w / 2, b.y); ctx.rotate((-5 * Math.PI) / 180);
      ctx.fillStyle = TAPE; ctx.fillRect(-tw / 2, -tt / 2, tw, tt);
      ctx.restore();
    }
    ctx.restore();
  });

  // 4. Lapisan atas: konfeti hanya di margin bingkai
  if (o.orn === "konfeti") {
    const rnd = seeded(String(ev.event_id || ev.name || "jepretin"));
    const pal = [ev.collage_theme?.accent || CONFETTI[0], ...CONFETTI.slice(1)];
    const bottomY = F.h - Math.min(g.foot, m + band);
    for (let i = 0; i < 26; i++) {
      const side = i % 4;   // atas, kanan, bawah, kiri
      const x = side === 1 ? F.w - m * rnd() : side === 3 ? m * rnd() : 12 + rnd() * (F.w - 24);
      const y = side === 0 ? 8 + rnd() * (g.top - 16) : side === 2 ? bottomY + 8 + rnd() * (F.h - bottomY - 16) : g.top + rnd() * g.area.h;
      const s = 12 + rnd() * 14;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rnd() * Math.PI);
      ctx.fillStyle = pal[i % pal.length];
      if (i % 2) { ctx.beginPath(); ctx.arc(0, 0, s / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-s / 2, -s / 4, s, s / 2);
      ctx.restore();
    }
  }

  // 5. Kaki: nama acara, tanggal, jumlah foto, logo; atau kartu acara
  const fy = F.h - g.foot, fh = g.foot - band;
  const card = Boolean(orn.card);
  if (card) { ctx.fillStyle = CARD.bg; ctx.fillRect(0, fy, F.w, fh); }
  const ink = card ? CARD.ink : th.ink, muted = card ? CARD.muted : th.muted;
  const cy = g.story ? fy + (g.showText ? 120 : 100) : fy + fh / 2;
  let textRight = F.w - m;
  if (o.logo) {
    const markSize = 48;
    const wmW = wordmarkWidth(ctx, 34);
    const lx = F.w - m - (markSize + 12 + wmW);
    drawMark(ctx, lx, cy - markSize / 2 - 2, markSize, card ? CARD.ink : th.body, card ? CARD.bg : th.cut);
    ctx.fillStyle = ink; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    drawWordmark(ctx, lx + markSize + 12, cy, 34);
    textRight = lx - 40;
  }
  if (g.showText) {
    const textW = textRight - m;
    const used = Math.min(imgs.filter(Boolean).length, g.cells.length);
    const kamera = o.orn === "kamera";
    // Baris utama: nama acara (atau tanggal bila nama dimatikan); baris kedua: tanggal · jumlah foto
    const main = o.name ? ev.name || "" : eventDate(ev, "short");
    const sub = [o.name && o.date ? eventDate(ev, "short") : "", t("{n} foto", { n: used })].filter(Boolean).join(" · ");
    ctx.textAlign = "left";
    ctx.font = kamera ? `700 ${g.story ? 44 : 38}px ${MONO}` : `600 ${g.story ? 50 : 44}px ${DISPLAY}`; ctx.fillStyle = ink;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fit(ctx, kamera ? main.toUpperCase() : main, textW), m, cy - 4);
    ctx.font = kamera ? `700 ${g.story ? 26 : 23}px ${MONO}` : `600 ${g.story ? 28 : 25}px ${BODY}`; ctx.fillStyle = kamera ? STAMP : muted;
    ctx.textBaseline = "top";
    ctx.fillText(fit(ctx, sub, textW), m, cy + 10);
  }
  return { canvas: c, g };
}

// Ikon mini tata letak (kotak di dalam 32×40)
const mini = (cells, on) => cells.map(([x, y, w, h]) =>
  `<i style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%" class="${on ? "on" : ""}"></i>`).join("");

export async function openCollage(ev, photos, { pickMore } = {}) {
  if (!photos.length) { toast(t("Pilih paling sedikit 1 foto untuk kolase.")); return; }
  const cfg = ev.collage_theme || {};
  const allowed = ORNAMENTS.filter((o) => !cfg.allowed?.length || cfg.allowed.includes(o.id) || o.id === cfg.ornament);
  const logoOptional = cfg.logo_optional === true;     // BR-19: wajib di acara gratis
  const S = {
    tab: "layout", layout: "auto", size: "feed", bg: "krem", name: true, date: true, stamp: false, logo: true,
    orn: allowed.some((o) => o.id === cfg.ornament) ? cfg.ornament : (allowed[0]?.id || "polos"),
  };
  let list = photos.slice(0, COLLAGE_MAX);
  let swapFrom = null;
  const thumbs = new Map();                            // id -> Image (pratinjau)

  const TABS = [["layout", t("Tata letak")], ["orn", t("Ornamen")], ["size", t("Ukuran")], ["text", t("Teks")]];
  const { box, close } = modal(`
    <div class="dialog collage2">
      <div class="cl-view cl-editor">
        <div class="cl-head">
          <button type="button" class="round-btn ghost-round" data-act="close" aria-label="${t("Tutup")}">${ICON.close}</button>
          <h3>${t("Kolase")}</h3>
          <button type="button" class="btn small primary" data-act="done" disabled>${t("Selesai")}</button>
        </div>
        <div class="cl-stage">
          <div class="cl-preview" role="img" aria-label="${t("Pratinjau kolase")}">
            <img alt="" hidden /><div class="cl-hits"></div>
          </div>
          <p class="hint cl-msg">${t("Menyiapkan foto…")}</p>
        </div>
        <div class="cl-panel">
          <div class="cl-tabs" role="tablist" aria-label="${t("Pengaturan kolase")}">
            ${TABS.map(([id, label]) => `<button type="button" role="tab" id="cl-tab-${id}" aria-controls="cl-pane-${id}" data-tab="${id}">${label}</button>`).join("")}
          </div>
          ${TABS.map(([id]) => `<div class="cl-pane" id="cl-pane-${id}" role="tabpanel" aria-labelledby="cl-tab-${id}" tabindex="0"></div>`).join("")}
        </div>
      </div>
      <div class="cl-view cl-result" hidden>
        <div class="cl-head">
          <button type="button" class="round-btn ghost-round" data-act="back" aria-label="${t("Kembali ke editor")}">${ICON.back}</button>
          <h3>${t("Kolase siap")}</h3>
          <button type="button" class="btn small ghost" data-act="close">${t("Tutup")}</button>
        </div>
        <div class="cl-stage"><div class="cl-final"><p class="hint">${t("Menyiapkan kolase…")}</p></div></div>
        <div class="cl-panel">
          <div class="cl-share">
            <button type="button" class="cl-share-btn" data-share="story">${ICON.phone}<span>Story</span></button>
            <button type="button" class="cl-share-btn" data-share="wa">${ICON.chat}<span>WhatsApp</span></button>
            <button type="button" class="cl-share-btn" data-share="more">${ICON.share}<span>${t("Lainnya")}</span></button>
          </div>
          <button type="button" class="btn primary cl-save" data-act="save">${ICON.download} ${t("Simpan ke galeri")}</button>
          <p class="hint cl-info"></p>
        </div>
      </div>
    </div>`, { wide: true });
  box.querySelector(".modal-card").classList.add("collage-card");
  box.querySelectorAll('[data-act="close"]').forEach((b) => (b.onclick = () => { ro?.disconnect(); close(); }));
  const editor = box.querySelector(".cl-editor"), result = box.querySelector(".cl-result");
  const prevBox = box.querySelector(".cl-preview"), prevImg = prevBox.querySelector("img");
  const hits = box.querySelector(".cl-hits"), msg = box.querySelector(".cl-msg");
  const doneBtn = box.querySelector('[data-act="done"]');

  async function loadThumbs() {
    await Promise.all(list.map(async (p) => {
      if (thumbs.has(p.id)) return;
      const img = await loadImage(p.thumb || p.url).catch(() => (p.thumb ? loadImage(p.url).catch(() => null) : null));
      thumbs.set(p.id, img);
    }));
    list = list.filter((p) => thumbs.get(p.id));
  }

  const layoutName = () => t(LAYOUTS.find((l) => l.id === S.layout).name);
  function hintText(g) {
    const n = list.length, need = g.cells.length;
    const small = Math.min(...g.cells.map((c) => Math.min(c.w, c.h)));
    if ((S.orn === "polaroid" || S.orn === "selotip") && small < 200) return t("Kotak terlalu kecil untuk ornamen ini. Coba 2×3.");
    if (S.layout === "auto") return t("Susunan menyesuaikan {n} foto yang dipilih.", { n });
    if (need > n) return t("Butuh {need} foto. Ketuk kotak kosong untuk menambah.", { need });
    if (need < n) return t("{k} foto terakhir tidak dipakai. Ketuk dua foto untuk menukar, atau tahan dan geser.", { k: n - need });
    return t("Pas untuk {n} foto. Ketuk dua foto untuk menukar, atau tahan dan geser.", { n });
  }

  function renderPanel(g) {
    box.querySelectorAll("[data-tab]").forEach((b) => {
      const on = b.dataset.tab === S.tab;
      b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
    });
    box.querySelectorAll(".cl-pane").forEach((p) => (p.hidden = p.id !== `cl-pane-${S.tab}`));
    const pane = box.querySelector(`#cl-pane-${S.tab}`);
    const pick = (k, v, on, inner, extra = "") => `<button type="button" class="cl-pick ${extra}" data-k="${k}" data-v="${v}" aria-pressed="${on}">${inner}</button>`;
    if (S.tab === "layout") {
      pane.innerHTML = `
        <div class="cl-grid cols-5">${LAYOUTS.map((l) => pick("layout", l.id, S.layout === l.id,
          `<span class="cl-mini" aria-hidden="true">${mini(l.cells || layoutCells("auto", list.length, false), S.layout === l.id)}</span><span>${esc(t(l.name))}</span>`)).join("")}</div>
        <p class="cl-hint">${esc(hintText(g))}</p>`;
    } else if (S.tab === "orn") {
      const forced = ORN[S.orn].bg || (ORN[S.orn].card && S.bg === "gelap");
      pane.innerHTML = `
        <div class="cl-grid cols-4">${allowed.map((o) => pick("orn", o.id, S.orn === o.id,
          `<span class="sw sw-${o.id}" aria-hidden="true"></span><span>${esc(t(o.name))}</span>`)).join("")}</div>
        <div class="cl-bgs" role="group" aria-label="${t("Warna latar")}">
          <span>${t("Latar")}</span>
          ${Object.entries(BACKGROUNDS).map(([id, b]) => `<button type="button" class="cl-bg" data-k="bg" data-v="${id}" aria-pressed="${S.bg === id}" aria-label="${esc(t("Latar {x}", { x: t(b.name) }))}" style="background:${b.bg}"></button>`).join("")}
        </div>
        ${forced ? `<p class="cl-hint">${t("Ornamen ini memakai latarnya sendiri.")}</p>` : ""}
        ${(S.orn === "polaroid" || S.orn === "selotip") && Math.min(...g.cells.map((c) => Math.min(c.w, c.h))) < 200 ? `<p class="cl-hint">${t("Kotak terlalu kecil untuk ornamen ini. Coba 2×3.")}</p>` : ""}`;
    } else if (S.tab === "size") {
      pane.innerHTML = `<div class="cl-grid cols-3">${Object.entries(SIZES).map(([id, z]) => pick("size", id, S.size === id,
        `<span class="cl-shape" aria-hidden="true" style="width:${Math.round(z.w / 40)}px;height:${Math.round(z.h / 40)}px"></span><b>${esc(t(z.name))}</b><small>${z.ratio}</small>`, "size")).join("")}</div>`;
    } else {
      const rows = [
        ["name", t("Nama acara"), t("Di kaki atau kop kolase"), false],
        ["date", t("Tanggal"), t("Tanggal acara, atau hari ini bila belum berjadwal"), false],
        ["stamp", t("Cap tanggal di tiap foto"), t("Gaya kamera sekali pakai"), false],
        ["logo", t("Logo TitipPotret"), logoOptional ? t("Boleh dimatikan untuk acara ini") : t("Wajib di acara gratis; bisa dimatikan di acara berbayar"), !logoOptional],
      ];
      pane.innerHTML = `<div class="cl-toggles">${rows.map(([k, name, desc, locked]) => `
        <div class="cl-toggle">
          <span><b>${esc(name)}</b><small>${esc(desc)}</small></span>
          <button type="button" class="switch bare" role="switch" data-toggle="${k}" aria-checked="${Boolean(S[k])}" aria-label="${esc(name)}" ${locked ? "disabled" : ""}><span class="knob"></span></button>
        </div>`).join("")}</div>`;
    }
  }

  // Ukuran pratinjau = ruang yang tersedia dengan rasio ukuran terpilih (kotak ketuk ikut pas)
  const stage = editor.querySelector(".cl-stage");
  function fitPreview() {
    const sz = SIZES[S.size];
    const w = Math.max(80, stage.clientWidth - 32), h = Math.max(80, stage.clientHeight - 16);
    const k = Math.min(w / sz.w, h / sz.h);
    prevBox.style.width = `${Math.floor(sz.w * k)}px`;
    prevBox.style.height = `${Math.floor(sz.h * k)}px`;
  }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitPreview()) : null;
  ro?.observe(stage);

  let token = 0;
  async function render() {
    const my = ++token;
    const imgs = list.map((p) => thumbs.get(p.id));
    const { canvas, g } = await draw(S, imgs, ev, { scale: PREVIEW_SCALE, preview: true });
    if (my !== token) return;
    prevImg.src = canvas.toDataURL("image/jpeg", 0.85);
    prevImg.hidden = false;
    const ornName = t(ORN[S.orn].name), sz = SIZES[S.size];
    prevBox.setAttribute("aria-label", t("Pratinjau kolase: {l}, ornamen {o}, {s} {r}", { l: layoutName(), o: ornName, s: t(sz.name), r: sz.ratio }));
    fitPreview();
    // Ketuk kotak: kosong = tambah foto, isi = pilih lalu tukar dengan kotak berikutnya
    hits.innerHTML = g.cells.map((c, i) => {
      const filled = Boolean(imgs[i]);
      const label = filled
        ? (swapFrom === i ? t("Foto {n} dipilih, ketuk foto lain untuk menukar", { n: i + 1 }) : t("Foto {n}, ketuk untuk menukar atau tahan untuk menggeser", { n: i + 1 }))
        : t("Kotak kosong, tambah foto");
      return `<button type="button" class="cl-hit${swapFrom === i ? " on" : ""}" data-i="${i}" aria-label="${esc(label)}"
        style="left:${(c.x / sz.w) * 100}%;top:${(c.y / sz.h) * 100}%;width:${(c.w / sz.w) * 100}%;height:${(c.h / sz.h) * 100}%"></button>`;
    }).join("");
    msg.textContent = list.length ? "" : t("Foto tidak bisa dimuat untuk kolase. Coba lagi nanti.");
    doneBtn.disabled = !list.length;
    renderPanel(g);
  }

  // Tahan lalu geser: pindahkan foto ke kotak lain (urutan bergeser). Ketuk biasa tetap menukar.
  let drag = null, skipClick = false;
  const hitAt = (x, y) => document.elementFromPoint(x, y)?.closest?.(".cl-hit");
  hits.onpointerdown = (e) => {
    const b = e.target.closest(".cl-hit"); if (!b || !list[Number(b.dataset.i)]) return;
    const d = { from: Number(b.dataset.i), x: e.clientX, y: e.clientY, el: b, on: false, over: null };
    d.timer = setTimeout(() => {
      d.on = true; b.classList.add("dragging"); hits.classList.add("drag-mode");
      try { b.setPointerCapture(e.pointerId); } catch { /* abaikan */ }
      navigator.vibrate?.(15);
    }, 350);
    drag = d;
  };
  hits.onpointermove = (e) => {
    if (!drag) return;
    if (!drag.on) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) { clearTimeout(drag.timer); drag = null; } return; }
    e.preventDefault();
    const t2 = hitAt(e.clientX, e.clientY);
    if (drag.over && drag.over !== t2) drag.over.classList.remove("drop");
    drag.over = t2 && t2 !== drag.el ? t2 : null;
    drag.over?.classList.add("drop");
  };
  const endDrag = (e) => {
    if (!drag) return;
    clearTimeout(drag.timer);
    const d = drag; drag = null;
    if (!d.on) return;
    skipClick = true; setTimeout(() => (skipClick = false), 50);
    hits.classList.remove("drag-mode");
    const t2 = e.type === "pointerup" ? hitAt(e.clientX, e.clientY) : null;
    const to = t2 ? Number(t2.dataset.i) : d.from;
    if (to !== d.from) {
      const [moved] = list.splice(d.from, 1);
      list.splice(Math.min(to, list.length), 0, moved);
    }
    swapFrom = null;
    render();
  };
  hits.onpointerup = endDrag;
  hits.onpointercancel = endDrag;

  hits.onclick = async (e) => {
    if (skipClick) return;
    const b = e.target.closest(".cl-hit"); if (!b) return;
    const i = Number(b.dataset.i);
    if (!list[i]) {
      if (!pickMore) return;
      const p = await pickMore(list.map((x) => x.id));
      if (!p || list.some((x) => x.id === p.id) || list.length >= COLLAGE_MAX) return;
      list.push(p); swapFrom = null;
      await loadThumbs();
    } else if (swapFrom === null) {
      swapFrom = i;
    } else {
      if (swapFrom !== i) [list[swapFrom], list[i]] = [list[i], list[swapFrom]];
      swapFrom = null;
    }
    render();
  };

  // Pilihan di panel: langsung terlihat di pratinjau, tanpa tombol terapkan
  box.querySelector(".cl-panel").onclick = (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { S.tab = tab.dataset.tab; render(); return; }
    const p = e.target.closest("[data-k]");
    if (p) { S[p.dataset.k] = p.dataset.v; swapFrom = null; render(); return; }
    const sw = e.target.closest("[data-toggle]");
    if (sw && !sw.disabled) { S[sw.dataset.toggle] = !S[sw.dataset.toggle]; render(); }
  };
  // Panah kiri/kanan berpindah tab
  box.querySelector(".cl-tabs").onkeydown = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const ids = TABS.map(([id]) => id);
    S.tab = ids[(ids.indexOf(S.tab) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
    render().then(() => box.querySelector(`#cl-tab-${S.tab}`).focus());
  };

  // ---- Simpan atau bagikan: foto ukuran sedang, JPEG 0,92 ----
  const full = new Map();                              // id -> Image ukuran sedang
  async function finalCanvas(size = S.size) {
    await Promise.all(list.map(async (p) => {
      if (!full.has(p.id)) full.set(p.id, await loadImage(p.url).catch(() => thumbs.get(p.id)));
    }));
    return (await draw({ ...S, size }, list.map((p) => full.get(p.id)), ev)).canvas;
  }
  let final = null;
  const blob = (c) => new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
  const fileName = (size) => `kolase-${safeName(ev.name, "acara")}-${size}.jpg`;
  async function save(c, size) {
    const url = URL.createObjectURL(await blob(c));
    download(url, fileName(size));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function share(c, size) {
    const file = new File([await blob(c)], fileName(size), { type: "image/jpeg" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: ev.name }); } catch { /* dibatalkan */ }
    } else {
      toast(t("Perangkat ini tidak bisa membagikan langsung. Kolase diunduh; unggah dari galeri."), 5000);
      save(c, size);
    }
  }

  doneBtn.onclick = async () => {
    editor.hidden = true; result.hidden = false;
    const slot = result.querySelector(".cl-final");
    slot.innerHTML = `<p class="hint">${t("Menyiapkan kolase…")}</p>`;
    try {
      final = await finalCanvas();
      const sz = SIZES[S.size];
      const img = el(`<img alt="${esc(t("Kolase {l}, ornamen {o}, {k} foto", { l: layoutName(), o: t(ORN[S.orn].name), k: Math.min(list.length, geometry(S, list.length).cells.length) }))}" />`);
      img.src = final.toDataURL("image/jpeg", 0.85);
      slot.replaceChildren(img);
      result.querySelector(".cl-info").textContent = t("{s} {r} · {w} × {h} px. Dibuat di HP ini dan tidak memakai kuota unduhan.", { s: t(sz.name), r: sz.ratio, w: sz.w, h: sz.h });
      result.querySelector('[data-act="back"]').focus();
    } catch { slot.innerHTML = `<p class="hint">${t("Foto tidak bisa dimuat untuk kolase. Coba lagi nanti.")}</p>`; }
  };
  result.querySelector('[data-act="back"]').onclick = () => { result.hidden = true; editor.hidden = false; doneBtn.focus(); };
  result.querySelector('[data-act="save"]').onclick = () => final && save(final, S.size);
  result.querySelectorAll("[data-share]").forEach((b) => (b.onclick = async () => {
    if (!final) return;
    if (b.dataset.share === "story" && S.size !== "story") {
      b.disabled = true;
      try { await share(await finalCanvas("story"), "story"); } finally { b.disabled = false; }
      return;
    }
    share(final, S.size);
  }));

  try {
    await loadThumbs();
    if (!list.length) { msg.textContent = t("Foto tidak bisa dimuat untuk kolase. Coba lagi nanti."); return; }
    await render();
  } catch { msg.textContent = t("Foto tidak bisa dimuat untuk kolase. Coba lagi nanti."); }
}

// Untuk tes asap: gambar kolase tanpa UI
export { draw as drawCollage, geometry as collageGeometry };
