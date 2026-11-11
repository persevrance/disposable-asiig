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
