// Pembantu kecil untuk membuat tampilan tanpa framework
import { t, locale } from "./i18n.js";

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer;
export function toast(msg, ms = 3500) {
  let t = document.getElementById("toast");
  if (!t) { t = el(`<div id="toast" role="status" aria-live="polite"></div>`); document.body.append(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

export function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

// ISO -> nilai <input type="datetime-local"> (jam lokal)
export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
}

export function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : null;
}

export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function safeName(s, fallback = "foto") {
  return String(s || "").replace(/[^\p{L}\p{N} _-]/gu, "").trim() || fallback;
}

// Unduh blob/URL lewat <a download>
export function download(url, name) {
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
}

// Dialog dasar; mengembalikan elemen kotak dan fungsi tutup.
// Tutup dengan Esc atau ketuk di luar kotak; fokus kembali ke elemen sebelumnya.
export function modal(inner, { wide = false, onClose } = {}) {
  const box = el(`<div class="modal" role="dialog" aria-modal="true"><div class="modal-card${wide ? " wide" : ""}"></div></div>`);
  box.firstElementChild.append(typeof inner === "string" ? el(inner) : inner);
  const before = document.activeElement;
  let closed = false;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    if (closed) return;
    closed = true;
    box.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
    before?.focus?.();
  }
  document.addEventListener("keydown", onKey);
  box.onclick = (e) => { if (e.target === box) close(); };
  document.body.append(box);
  queueMicrotask(() => (box.querySelector("[autofocus]") || box.querySelector("button, input"))?.focus());
  return { box, close };
}

// Pengganti confirm(): mengembalikan Promise<boolean>.
// Untuk aksi berbahaya, fokus awal ada di Batal.
export function confirmDialog({ title, text = "", ok = t("Lanjutkan"), cancel = t("Batal"), danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const { box, close } = modal(`
      <div class="dialog">
        <h3>${esc(title)}</h3>
        ${text ? `<p>${esc(text)}</p>` : ""}
        <div class="dialog-actions">
          <button class="btn ghost" data-act="no" ${danger ? "autofocus" : ""}>${esc(cancel)}</button>
          <button class="btn ${danger ? "danger-fill" : "primary"}" data-act="yes" ${danger ? "" : "autofocus"}>${esc(ok)}</button>
        </div>
      </div>`, { onClose: () => resolve(result) });
    box.querySelector('[data-act="no"]').onclick = close;
    box.querySelector('[data-act="yes"]').onclick = () => { result = true; close(); };
  });
}

// Konfirmasi dengan mengetik teks tertentu (untuk hapus permanen)
export function typeToConfirm({ title, text, expect, ok = t("Hapus") }) {
  return new Promise((resolve) => {
    let result = false;
    const { box, close } = modal(`
      <form class="dialog">
        <h3>${esc(title)}</h3>
        <p>${esc(text)}</p>
        <label for="ttc-input">${t("Ketik {x} untuk melanjutkan", { x: `<b>${esc(expect)}</b>` })}</label>
        <input id="ttc-input" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
        <div class="dialog-actions">
          <button type="button" class="btn ghost" data-act="no">${t("Batal")}</button>
          <button class="btn danger-fill" data-act="yes" disabled>${esc(ok)}</button>
        </div>
      </form>`, { onClose: () => resolve(result) });
    const input = box.querySelector("input");
    const yes = box.querySelector('[data-act="yes"]');
    input.oninput = () => { yes.disabled = input.value.trim() !== String(expect).trim(); };
    box.querySelector('[data-act="no"]').onclick = close;
    box.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      if (!yes.disabled) { result = true; close(); }
    };
  });
}

// Tampilkan teks yang bisa disalin manual (cadangan bila clipboard ditolak)
export function showCopy({ title, text = "", value }) {
  const { box, close } = modal(`
    <div class="dialog">
      <h3>${esc(title)}</h3>
      ${text ? `<p>${esc(text)}</p>` : ""}
      <input readonly value="${esc(value)}" aria-label="${t("Teks untuk disalin")}" />
      <div class="dialog-actions"><button class="btn primary" data-act="ok">${t("Selesai")}</button></div>
    </div>`);
  const input = box.querySelector("input");
  input.onfocus = () => input.select();
  setTimeout(() => { input.focus(); input.select(); }, 0);
  box.querySelector('[data-act="ok"]').onclick = close;
}

export async function copyText(value, { done = t("Link disalin."), title = t("Salin link") } = {}) {
  try {
    await navigator.clipboard.writeText(value);
    toast(done);
    return true;
  } catch {
    showCopy({ title, text: t("Tekan lama teks di bawah lalu pilih Salin."), value });
    return false;
  }
}

// Daftar aksi (menu ⋯). actions: [{ label, danger, run }]
export function actionSheet(title, actions) {
  const { box, close } = modal(`
    <div class="dialog">
      <h3>${esc(title)}</h3>
      <div class="sheet-actions"></div>
      <div class="dialog-actions"><button class="btn ghost" data-act="no">${t("Batal")}</button></div>
    </div>`);
  const list = box.querySelector(".sheet-actions");
  for (const a of actions) {
    const b = el(`<button class="btn${a.danger ? " danger" : ""}">${esc(a.label)}</button>`);
    b.onclick = () => { close(); a.run(); };
    list.append(b);
  }
  box.querySelector('[data-act="no"]').onclick = close;
}

// Konfeti kecil saat film habis (dilewati jika pengguna memilih kurangi gerakan)
export function confetti() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#ff5c8a", "#ffc23c", "#2ec4a0", "#5bb8ff", "#b48cff"];
  const layer = el(`<div class="confetti" aria-hidden="true"></div>`);
  for (let i = 0; i < 70; i++) {
    const s = document.createElement("i");
    s.style.left = Math.random() * 100 + "%";
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = Math.random() * 0.6 + "s";
    s.style.animationDuration = 1.8 + Math.random() * 1.4 + "s";
    s.style.setProperty("--dx", (Math.random() * 2 - 1) * 120 + "px");
    s.style.setProperty("--rot", Math.random() * 720 + "deg");
    layer.append(s);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3800);
}

// Ikon garis sederhana (warna mengikuti teks)
const svg = (paths, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const ICON = {
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>'),
  album: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-9 9"/>'),
  panel: svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
  share: svg('<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/>', 18),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 18),
};
Object.assign(ICON, {
  film: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 18),
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>', 16),
  heart: svg('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>', 18),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', 18),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', 18),
  phone: svg('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>', 18),
  play: svg('<path d="M7 4.5v15l12-7.5z"/>', 18),
  printer: svg('<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/>', 18),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', 18),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>', 18),
  shield: svg('<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/>', 18),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 18),
  chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', 18),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 18),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/>', 18),
  grid: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>', 18),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', 18),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>', 18),
});

// CSV untuk Excel/Sheets: pemisah koma, UTF-8 dengan BOM. rows: array objek, cols: [[kunci, judul]]
export function downloadCsv(name, cols, rows) {
  const cell = (v) => {
    const x = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const text = [cols.map(([, h]) => cell(h)).join(","), ...rows.map((r) => cols.map(([k]) => cell(typeof k === "function" ? k(r) : r[k])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" }));
  download(url, name.endsWith(".csv") ? name : `${name}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Waktu acara singkat: "Sab, 14 Des 2026 · 19.00–22.00"
export function fmtRange(start, end) {
  if (!start && !end) return "";
  const d = (x) => new Date(x).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const tm = (x) => new Date(x).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (start && end) {
    const same = new Date(start).toDateString() === new Date(end).toDateString();
    return same ? `${d(start)} · ${tm(start)}–${tm(end)}` : `${d(start)} ${tm(start)} – ${d(end)} ${tm(end)}`;
  }
  return start ? `${d(start)} · ${t("mulai")} ${tm(start)}` : `${t("selesai")} ${d(end)} ${tm(end)}`;
}

// Ikon dalam lingkaran berwarna lembut. tone: coral | sun | mint | grape; size: "" | lg | xl
export const badge = (name, tone = "coral", size = "") =>
  `<span class="icon-badge ${tone} ${size}" aria-hidden="true">${ICON[name]}</span>`;

// Logo aplikasi (sama dengan public/icon.svg, tanpa latar)
export const BRAND = `<svg viewBox="40 90 432 340" width="96" height="76" aria-hidden="true">
  <defs><linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5c8a"/><stop offset="1" stop-color="#ff9a5c"/></linearGradient></defs>
  <rect x="72" y="150" width="368" height="248" rx="48" fill="url(#brand-g)"/>
  <rect x="112" y="116" width="100" height="52" rx="16" fill="#ff5c8a"/>
  <rect x="330" y="124" width="64" height="40" rx="12" fill="#ffc23c"/>
  <circle cx="290" cy="274" r="88" fill="#fff"/>
  <circle cx="290" cy="274" r="64" fill="#2d1b33"/>
  <circle cx="268" cy="252" r="16" fill="#fff" opacity=".85"/>
  <rect x="112" y="200" width="60" height="30" rx="10" fill="#fff7ec"/>
  <circle cx="440" cy="110" r="12" fill="#2ec4a0"/>
  <circle cx="60" cy="410" r="9" fill="#b48cff"/>
</svg>`;
