// Kolase v2: 1–9 foto pilihan tamu. Empat pilihan bebas yang bisa dipadukan: tata letak,
// ornamen (lapisan, bukan template), ukuran, dan teks. Data pilihan ada di collage-layouts.js.
// Dibuat di HP (canvas), tidak diunggah, tidak memakai kuota unduhan (BR-09).
// photos: [{ id, url, thumb, owner_name }] — url ukuran sedang (1080 px), thumb 400 px.
// Pratinjau editor memakai thumbnail; foto sedang baru dimuat saat Selesai.
import { el, esc, toast, modal, download, safeName, fmtRange, ICON } from "./ui.js";
import { t } from "./i18n.js";
import {
  LAYOUTS, ORNAMENTS, SIZES, BACKGROUNDS, CONFETTI, STAMP, TAPE, CARD, layoutCells,
} from "./collage-layouts.js";

export const COLLAGE_MAX = 9;
const FLASH = "#ff5c8a";
const DISPLAY = '"Fredoka", "Nunito", system-ui, sans-serif';
const BODY = '"Nunito", system-ui, sans-serif';
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

// Logo kamera Jepretin (kotak 64×64) di (x, y) berukuran size
function drawMark(ctx, x, y, size, body, cut) {
  const k = size / 64;
  ctx.save();
  ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = body;
  roundRect(ctx, 44, 9, 9, 7, 2); ctx.fill();
  roundRect(ctx, 4, 14, 56, 38, 10); ctx.fill();
  ctx.fillStyle = cut; roundRect(ctx, 10, 20, 11, 7, 2.5); ctx.fill();
  ctx.fillStyle = FLASH; roundRect(ctx, 42, 20, 12, 7, 2.5); ctx.fill();
  ctx.fillStyle = cut; ctx.beginPath(); ctx.arc(32, 35, 11.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(32, 35, 6.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = cut; ctx.beginPath(); ctx.arc(29.5, 32.5, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
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
function stampText(ev) {
  const d = ev.starts_at ? new Date(ev.starts_at) : new Date();
  return `'${String(d.getFullYear()).slice(2)} ${pad2(d.getMonth() + 1)} ${pad2(d.getDate())}`;
}

// Font Fredoka/Nunito harus termuat dulu, kalau tidak teks jatuh ke font cadangan
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
  const m = 56, band = orn.band || 0;
  const showText = o.foot || Boolean(orn.card);
  const textFoot = story ? 360 : o.size === "square" ? 150 : 170;
  const logoFoot = story ? 300 : 110;                     // logo saja tanpa nama acara
  const top = (story ? 220 : m) + band;                   // Story: ruang aman tampilan Instagram
  const foot = (showText ? textFoot : o.logo ? logoFoot : m) + band;
  const area = { x: m, y: top, w: F.w - 2 * m, h: F.h - top - foot };
  const gap = orn.gap;
  const cells = layoutCells(o.layout, n, story).map(([fx, fy, fw, fh]) => ({
    x: area.x + fx * (area.w + gap), y: area.y + fy * (area.h + gap),
    w: fw * (area.w + gap) - gap, h: fh * (area.h + gap) - gap,
  }));
  return { F, story, m, band, top, foot, showText, area, cells };
}

function theme(o) {
  const orn = ORN[o.orn];
  if (orn.bg) return BACKGROUNDS[orn.bg];
  if (orn.card && o.bg === "gelap") return BACKGROUNDS.krem;
  return BACKGROUNDS[o.bg];
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

  // 2. Lapisan bawah: lubang film di atas dan bawah
  if (band) {
    const k = Math.floor(F.w / 54), hw = 24, hh = 18;
    ctx.fillStyle = "#fff8f0";
    for (let i = 0; i < k; i++) {
      const x = 18 + i * (F.w - 36) / k;
      roundRect(ctx, x, (band - hh) / 2, hw, hh, 4); ctx.fill();
      roundRect(ctx, x, F.h - band + (band - hh) / 2, hw, hh, 4); ctx.fill();
    }
  }

  // 3. Tiap kotak
  const stamp = orn.stamp || o.stamp, stampStr = stampText(ev);
  const pol = o.orn === "polaroid";
  g.cells.forEach((b, i) => {
    const img = imgs[i];
    ctx.save();
    let p = b, radius = band ? 4 : 6;
    if (pol) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      ctx.translate(cx, cy); ctx.rotate(((i % 2 ? 2 : -2) * Math.PI) / 180); ctx.translate(-cx, -cy);
      ctx.save();
      ctx.shadowColor = "rgba(45, 27, 51, .22)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.restore();
      const side = Math.max(12, Math.min(b.w, b.h) * 0.05), bottom = Math.max(36, b.h * 0.14);
      p = { x: b.x + side, y: b.y + side, w: Math.max(1, b.w - side * 2), h: Math.max(1, b.h - side - bottom) };
      radius = 2;
    }
    ctx.save();
    roundRect(ctx, p.x, p.y, p.w, p.h, radius); ctx.clip();
    ctx.fillStyle = pol ? "#efdccb" : th.cell; ctx.fillRect(p.x, p.y, p.w, p.h);
    if (img) cover(ctx, img, p.x, p.y, p.w, p.h);
    ctx.restore();
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
    ctx.font = `600 34px ${DISPLAY}`;
    const wm = "jepretin", wmW = ctx.measureText(wm).width;
    const lx = F.w - m - (markSize + 12 + wmW);
    drawMark(ctx, lx, cy - markSize / 2 - 2, markSize, card ? CARD.ink : th.body, card ? CARD.bg : th.cut);
    ctx.fillStyle = ink; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(wm, lx + markSize + 12, cy);
    textRight = lx - 40;
  }
  if (g.showText) {
    const textW = textRight - m;
    const used = Math.min(imgs.filter(Boolean).length, g.cells.length);
    ctx.textAlign = "left";
    ctx.font = `600 ${g.story ? 50 : 44}px ${DISPLAY}`; ctx.fillStyle = ink;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fit(ctx, ev.name || "", textW), m, cy - 4);
    const when = fmtRange(ev.starts_at, ev.ends_at);
    const sub = [when, t("{n} foto", { n: used })].filter(Boolean).join(" · ");
    ctx.font = `600 ${g.story ? 28 : 25}px ${BODY}`; ctx.fillStyle = muted;
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
    tab: "layout", layout: "auto", size: "feed", bg: "krem", foot: true, stamp: false, logo: true,
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
        ["foot", t("Nama acara dan tanggal"), t("Di kaki kolase"), false],
        ["stamp", t("Cap tanggal di tiap foto"), t("Gaya kamera sekali pakai"), false],
        ["logo", t("Logo Jepretin"), logoOptional ? t("Boleh dimatikan untuk acara ini") : t("Wajib di acara gratis; bisa dimatikan di acara berbayar"), !logoOptional],
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
