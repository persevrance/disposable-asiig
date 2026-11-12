// Tema tampilan: Otomatis (ikut perangkat) / Terang / Gelap, diingat per perangkat.
// Tema gelap aktif lewat kelas "dark" di <html>; skrip kecil di index.html memasangnya
// sebelum halaman tergambar supaya tidak berkedip.
import { t } from "./i18n.js";

const KEY = "theme";
const mq = window.matchMedia?.("(prefers-color-scheme: dark)");

export function getTheme() {
  try { const v = localStorage.getItem(KEY); if (v === "light" || v === "dark") return v; } catch { /* abaikan */ }
  return "auto";
}

function apply() {
  const pref = getTheme();
  const dark = pref === "dark" || (pref === "auto" && Boolean(mq?.matches));
  document.documentElement.classList.toggle("dark", dark);
  // Warna bilah status HP mengikuti tema yang sedang tampil
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#1a1220" : "#FFF8F0"));
}

export function setTheme(v) {
  try { if (v === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* abaikan */ }
  apply();
}

mq?.addEventListener?.("change", () => { if (getTheme() === "auto") apply(); });
apply();

// Tombol tiga pilihan untuk menu akun
export const themeSwitch = () => {
  const cur = getTheme();
  const opt = (v, label) => `<button type="button" data-theme-set="${v}" aria-pressed="${cur === v}">${label}</button>`;
  return `<span class="lang-switch theme-switch" role="group" aria-label="${t("Tema tampilan")}">
    ${opt("auto", t("Otomatis"))}${opt("light", t("Terang"))}${opt("dark", t("Gelap"))}
  </span>`;
};
export function bindThemeSwitch(root) {
  root.querySelectorAll("[data-theme-set]").forEach((b) => (b.onclick = () => {
    setTheme(b.dataset.themeSet);
    root.querySelectorAll("[data-theme-set]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
}
