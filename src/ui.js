// Pembantu kecil untuk membuat tampilan tanpa framework
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
  return new Date(iso).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
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
export function confirmDialog({ title, text = "", ok = "Lanjutkan", cancel = "Batal", danger = false }) {
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
export function typeToConfirm({ title, text, expect, ok = "Hapus" }) {
  return new Promise((resolve) => {
    let result = false;
    const { box, close } = modal(`
      <form class="dialog">
        <h3>${esc(title)}</h3>
        <p>${esc(text)}</p>
        <label for="ttc-input">Ketik <b>${esc(expect)}</b> untuk melanjutkan</label>
        <input id="ttc-input" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
        <div class="dialog-actions">
          <button type="button" class="btn ghost" data-act="no">Batal</button>
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
      <input readonly value="${esc(value)}" aria-label="Teks untuk disalin" />
      <div class="dialog-actions"><button class="btn primary" data-act="ok">Selesai</button></div>
    </div>`);
  const input = box.querySelector("input");
  input.onfocus = () => input.select();
  setTimeout(() => { input.focus(); input.select(); }, 0);
  box.querySelector('[data-act="ok"]').onclick = close;
}

export async function copyText(value, { done = "Link disalin.", title = "Salin link" } = {}) {
  try {
    await navigator.clipboard.writeText(value);
    toast(done);
    return true;
  } catch {
    showCopy({ title, text: "Tekan lama teks di bawah lalu pilih Salin.", value });
    return false;
  }
}

// Daftar aksi (menu ⋯). actions: [{ label, danger, run }]
export function actionSheet(title, actions) {
  const { box, close } = modal(`
    <div class="dialog">
      <h3>${esc(title)}</h3>
      <div class="sheet-actions"></div>
      <div class="dialog-actions"><button class="btn ghost" data-act="no">Batal</button></div>
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
});

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
