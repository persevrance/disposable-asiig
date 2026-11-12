// Kolase otomatis untuk dibagikan ke Instagram: 2×2 atau 3×3 (4:5, feed) dan Story 9:16.
// photos: [{ url, owner_name }] (URL ukuran sedang). Hasil: PNG/JPEG lewat lembar bagikan atau unduh.
import { el, esc, toast, modal, download, safeName, fmtRange } from "./ui.js";
import { t } from "./i18n.js";

const LAYOUTS = {
  grid4: { w: 1080, h: 1350, cols: 2, rows: 2, label: "Kotak 2×2" },
  grid9: { w: 1080, h: 1350, cols: 3, rows: 3, label: "Kotak 3×3" },
  story: { w: 1080, h: 1920, cols: 1, rows: 3, label: "Story 9:16" },
};
const C = { bg: "#fff7ec", ink: "#2d1b33", muted: "#6e5d72", coral: "#d6336c", frame: "#ffffff" };

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

async function draw(layout, imgs, ev) {
  const L = LAYOUTS[layout];
  const c = document.createElement("canvas");
  c.width = L.w; c.height = L.h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, L.w, L.h);
  const pad = 48, gap = 18, foot = layout === "story" ? 230 : 170;
  const gw = L.w - pad * 2, gh = L.h - pad - foot;
  const cw = (gw - gap * (L.cols - 1)) / L.cols, ch = (gh - gap * (L.rows - 1)) / L.rows;
  const n = L.cols * L.rows;
  for (let i = 0; i < n; i++) {
    const img = imgs[i % imgs.length];
    const x = pad + (i % L.cols) * (cw + gap), y = pad + Math.floor(i / L.cols) * (ch + gap);
    ctx.save();
    roundRect(ctx, x, y, cw, ch, 22); ctx.clip();
    const s = Math.max(cw / img.width, ch / img.height);
    const sw = cw / s, sh = ch / s;
    ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, cw, ch);
    ctx.restore();
  }
  // Kaki: nama acara, jadwal, merek
  ctx.textAlign = "center";
  const fy = L.h - foot;
  ctx.fillStyle = C.ink; ctx.font = `600 ${layout === "story" ? 64 : 52}px "Fredoka", "Nunito", system-ui, sans-serif`;
  let name = ev.name;
  while (ctx.measureText(name).width > L.w - 120 && name.length > 4) name = name.slice(0, -2);
  if (name !== ev.name) name = name.trimEnd() + "…";
  ctx.fillText(name, L.w / 2, fy + (layout === "story" ? 100 : 78));
  const when = fmtRange(ev.starts_at, ev.ends_at);
  ctx.fillStyle = C.muted; ctx.font = `700 30px "Nunito", system-ui, sans-serif`;
  ctx.fillText([when, "Disposable Asiig"].filter(Boolean).join(" · "), L.w / 2, fy + (layout === "story" ? 160 : 128));
  return c;
}

export async function openCollage(ev, photos) {
  if (photos.length < 2) { toast(t("Pilih paling sedikit 2 foto untuk kolase.")); return; }
  const { box, close } = modal(`
    <div class="dialog collage">
      <h3>${t("Buat kolase")}</h3>
      <div class="chips" role="group" aria-label="${t("Bentuk kolase")}">
        ${Object.entries(LAYOUTS).map(([k, l], i) => `<button type="button" class="chip" data-l="${k}" aria-pressed="${i === 0}">${t(l.label)}</button>`).join("")}
      </div>
      <div class="collage-preview"><p class="hint">${t("Menyiapkan foto…")}</p></div>
      <p class="hint">${t("Foto diambil dari pilihan Anda (atau favorit dan foto terbaru). Kolase dibuat di HP ini dan tidak diunggah.")}</p>
      <div class="dialog-actions">
        <button class="btn ghost" data-act="close">${t("Tutup")}</button>
        <button class="btn" data-act="save">${t("Unduh")}</button>
        <button class="btn primary" data-act="share">${t("Bagikan")}</button>
      </div>
    </div>`, { wide: true });
  box.querySelector('[data-act="close"]').onclick = close;
  const prev = box.querySelector(".collage-preview");
  let imgs;
  try {
    imgs = (await Promise.all(photos.slice(0, 9).map((p) => loadImage(p.url).catch(() => null)))).filter(Boolean);
  } catch { imgs = []; }
  if (imgs.length < 2) { prev.innerHTML = `<p class="hint">${t("Foto tidak bisa dimuat untuk kolase. Coba lagi nanti.")}</p>`; return; }
  let layout = "grid4", canvas = null;
  async function render() {
    canvas = await draw(layout, imgs, ev);
    prev.replaceChildren(el(`<img alt="${esc(t("Pratinjau kolase"))}" />`));
    prev.querySelector("img").src = canvas.toDataURL("image/jpeg", 0.85);
  }
  box.querySelector(".chips").onclick = (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    box.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    layout = b.dataset.l; render();
  };
  const blob = () => new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
  const fileName = () => `kolase-${safeName(ev.name, "acara")}-${layout}.jpg`;
  box.querySelector('[data-act="save"]').onclick = async () => {
    const url = URL.createObjectURL(await blob());
    download(url, fileName());
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const shareBtn = box.querySelector('[data-act="share"]');
  shareBtn.onclick = async () => {
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
