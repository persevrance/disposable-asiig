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
