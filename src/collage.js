// Kolase untuk dibagikan: 2–9 foto pilihan tamu, dengan nama acara dan logo Jepretin.
// Desain minimalis: grid rapat (jarak tipis, sudut halus), ruang lega, kaki rata kiri-kanan
// (nama acara + tanggal | logo). Tata letak baris menyesuaikan jumlah foto, tanpa foto diulang.
// photos: [{ url, owner_name }] (URL ukuran sedang). Hasil: JPEG lewat lembar bagikan atau unduh.
import { el, esc, toast, modal, download, safeName, fmtRange } from "./ui.js";
import { t } from "./i18n.js";

const FORMATS = {
  feed:   { w: 1080, h: 1350, label: "Feed 4:5" },
  square: { w: 1080, h: 1080, label: "Kotak 1:1" },
  story:  { w: 1080, h: 1920, label: "Story 9:16" },
};
const THEMES = {
  light: { label: "Krem",  bg: "#fff8f0", ink: "#2d1b33", muted: "#6e5d72", cell: "#efdccb", body: "#2d1b33", cut: "#fff8f0" },
  dark:  { label: "Gelap", bg: "#1c1220", ink: "#f6eaf0", muted: "#bba9c0", cell: "#2b1d31", body: "#fff8f0", cut: "#1c1220" },
};
const FLASH = "#ff5c8a";
const DISPLAY = '"Fredoka", "Nunito", system-ui, sans-serif';
const BODY = '"Nunito", system-ui, sans-serif';

// Jumlah foto per baris, dari atas ke bawah. Baris berisi sedikit foto = foto lebih besar.
const ROWS = {
  2: [1, 1], 3: [1, 2], 4: [2, 2], 5: [2, 3], 6: [3, 3], 7: [2, 3, 2], 8: [3, 2, 3], 9: [3, 3, 3],
};
// Story lebih tinggi: tambah satu baris supaya foto tidak terlalu memanjang
const ROWS_STORY = {
  2: [1, 1], 3: [1, 1, 1], 4: [1, 2, 1], 5: [1, 2, 2], 6: [2, 2, 2], 7: [1, 2, 2, 2], 8: [2, 2, 2, 2], 9: [2, 3, 2, 2],
};

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
function drawMark(ctx, x, y, size, th) {
  const k = size / 64;
  ctx.save();
  ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = th.body;
  roundRect(ctx, 44, 9, 9, 7, 2); ctx.fill();
  roundRect(ctx, 4, 14, 56, 38, 10); ctx.fill();
  ctx.fillStyle = th.cut; roundRect(ctx, 10, 20, 11, 7, 2.5); ctx.fill();
  ctx.fillStyle = FLASH; roundRect(ctx, 42, 20, 12, 7, 2.5); ctx.fill();
  ctx.fillStyle = th.cut; ctx.beginPath(); ctx.arc(32, 35, 11.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = th.body; ctx.beginPath(); ctx.arc(32, 35, 6.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = th.cut; ctx.beginPath(); ctx.arc(29.5, 32.5, 1.8, 0, Math.PI * 2); ctx.fill();
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

async function draw(format, theme, imgs, ev) {
  const F = FORMATS[format], th = THEMES[theme];
  const story = format === "story";
  const c = document.createElement("canvas");
  c.width = F.w; c.height = F.h;
  const ctx = c.getContext("2d");
  await Promise.all([document.fonts?.load(`600 48px ${DISPLAY}`), document.fonts?.load(`700 26px ${BODY}`)].filter(Boolean)).catch(() => {});

  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, F.w, F.h);

  // Ruang: margin luar, kaki untuk teks. Story memberi ruang aman atas-bawah untuk tampilan Instagram.
  const m = 56, gap = 10, radius = 6;
  const top = story ? 220 : m;
  const foot = story ? 360 : format === "square" ? 150 : 170;
  const gx = m, gy = top, gw = F.w - m * 2, gh = F.h - top - foot;

  const n = Math.min(9, Math.max(2, imgs.length));
  const rows = (story ? ROWS_STORY : ROWS)[n];
  const rh = (gh - gap * (rows.length - 1)) / rows.length;
  let i = 0;
  rows.forEach((cols, r) => {
    const cw = (gw - gap * (cols - 1)) / cols;
    for (let k = 0; k < cols; k++) {
      const x = gx + k * (cw + gap), y = gy + r * (rh + gap);
      ctx.save();
      roundRect(ctx, x, y, cw, rh, radius); ctx.clip();
      ctx.fillStyle = th.cell; ctx.fillRect(x, y, cw, rh);
      if (imgs[i]) cover(ctx, imgs[i], x, y, cw, rh);
      ctx.restore();
      i++;
    }
  });

  // Kaki: kiri nama acara + keterangan, kanan logo + wordmark
  const fy = F.h - foot, cy = story ? fy + 120 : fy + foot / 2;
  const markSize = 48;
  ctx.font = `600 34px ${DISPLAY}`;
  const wm = "jepretin", wmW = ctx.measureText(wm).width;
  const lockW = markSize + 12 + wmW;
  const lx = F.w - m - lockW;
  drawMark(ctx, lx, cy - markSize / 2 - 2, markSize, th);
  ctx.fillStyle = th.ink; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.fillText(wm, lx + markSize + 12, cy);

  const textW = lx - m - 40;
  ctx.font = `600 ${story ? 50 : 44}px ${DISPLAY}`; ctx.fillStyle = th.ink;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(fit(ctx, ev.name, textW), m, cy - 4);
  const when = fmtRange(ev.starts_at, ev.ends_at);
  const sub = [when, t("{n} foto", { n: imgs.length })].filter(Boolean).join(" · ");
  ctx.font = `600 ${story ? 28 : 25}px ${BODY}`; ctx.fillStyle = th.muted;
  ctx.textBaseline = "top";
  ctx.fillText(fit(ctx, sub, textW), m, cy + 10);
  return c;
}

export async function openCollage(ev, photos) {
  if (photos.length < 2) { toast(t("Pilih paling sedikit 2 foto untuk kolase.")); return; }
  const { box, close } = modal(`
    <div class="dialog collage">
      <div class="collage-head">
        <h3>${t("Kolase")}</h3>
        <button type="button" class="round-btn" data-act="close" aria-label="${t("Tutup")}">×</button>
      </div>
      <div class="collage-preview"><p class="hint">${t("Menyiapkan foto…")}</p></div>
      <div class="collage-opts">
        <div class="chips" role="group" aria-label="${t("Format kolase")}" data-group="format">
          ${Object.entries(FORMATS).map(([k, f], i) => `<button type="button" class="chip" data-v="${k}" aria-pressed="${i === 0}">${t(f.label)}</button>`).join("")}
        </div>
        <div class="chips" role="group" aria-label="${t("Tema kolase")}" data-group="theme">
          ${Object.entries(THEMES).map(([k, x], i) => `<button type="button" class="chip theme-chip ${k}" data-v="${k}" aria-pressed="${i === 0}"><i aria-hidden="true"></i>${t(x.label)}</button>`).join("")}
        </div>
      </div>
      <p class="hint">${t("Kolase dibuat di HP ini dan tidak diunggah.")}</p>
      <div class="collage-actions">
        <button class="btn" data-act="save">${t("Unduh")}</button>
        <button class="btn primary" data-act="share">${t("Bagikan")}</button>
      </div>
    </div>`, { wide: true });
  box.querySelector('[data-act="close"]').onclick = close;
  const prev = box.querySelector(".collage-preview");
  const imgs = (await Promise.all(photos.slice(0, 9).map((p) => loadImage(p.url).catch(() => null)))).filter(Boolean);
  if (imgs.length < 2) { prev.innerHTML = `<p class="hint">${t("Foto tidak bisa dimuat untuk kolase. Coba lagi nanti.")}</p>`; return; }
  const state = { format: "feed", theme: "light" };
  let canvas = null;
  async function render() {
    canvas = await draw(state.format, state.theme, imgs, ev);
    prev.replaceChildren(el(`<img alt="${esc(t("Pratinjau kolase"))}" />`));
    prev.querySelector("img").src = canvas.toDataURL("image/jpeg", 0.85);
  }
  box.querySelectorAll(".collage-opts .chips").forEach((g) => (g.onclick = (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    g.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    state[g.dataset.group] = b.dataset.v;
    render();
  }));
  const blob = () => new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
  const fileName = () => `kolase-${safeName(ev.name, "acara")}-${state.format}.jpg`;
  box.querySelector('[data-act="save"]').onclick = async () => {
    const url = URL.createObjectURL(await blob());
    download(url, fileName());
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  box.querySelector('[data-act="share"]').onclick = async () => {
    const file = new File([await blob()], fileName(), { type: "image/jpeg" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: ev.name }); } catch { /* dibatalkan */ }
    } else {
      toast(t("Perangkat ini tidak bisa membagikan langsung. Kolase diunduh; unggah dari galeri."), 5000);
      box.querySelector('[data-act="save"]').click();
    }
  };
  try { await render(); } catch { prev.innerHTML = `<p class="hint">${t("Foto tidak bisa dimuat untuk kolase. Coba lagi nanti.")}</p>`; }
}
