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

// Dialog sederhana; mengembalikan elemen kotak dan fungsi tutup
export function modal(inner, { wide = false } = {}) {
  const box = el(`<div class="modal" role="dialog" aria-modal="true"><div class="modal-card${wide ? " wide" : ""}"></div></div>`);
  box.firstElementChild.append(typeof inner === "string" ? el(inner) : inner);
  document.body.append(box);
  const close = () => box.remove();
  box.onclick = (e) => { if (e.target === box) close(); };
  return { box, close };
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
