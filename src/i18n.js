// Bahasa tampilan tamu: Indonesia (sumber) atau Inggris.
// Teks ditulis dalam bahasa Indonesia dan dibungkus t("..."); kamus EN ada di i18n-en.js.
// Variabel: t("Sisa {n} foto", { n: 3 }). Panel dan Dashboard tetap berbahasa Indonesia.
import EN from "./i18n-en.js";

const KEY = "lang";
function detect() {
  try { const v = localStorage.getItem(KEY); if (v === "id" || v === "en") return v; } catch { /* abaikan */ }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || "id"];
  return langs.some((l) => /^(id|ms)\b/i.test(l)) ? "id" : "en";
}

export const lang = detect();
document.documentElement.lang = lang;
export const locale = lang === "en" ? "en-GB" : "id-ID";

export function setLang(l) {
  try { localStorage.setItem(KEY, l); } catch { /* abaikan */ }
  location.reload();
}

export function t(s, vars) {
  let out = lang === "en" ? (EN[s] ?? s) : s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  return out;
}

// Tombol ganti bahasa kecil: "ID · EN"
export const langSwitch = () => `
  <span class="lang-switch" role="group" aria-label="Bahasa / Language">
    <button type="button" data-lang="id" aria-pressed="${lang === "id"}">ID</button>
    <button type="button" data-lang="en" aria-pressed="${lang === "en"}">EN</button>
  </span>`;
export function bindLangSwitch(root) {
  root.querySelectorAll("[data-lang]").forEach((b) => (b.onclick = () => { if (b.dataset.lang !== lang) setLang(b.dataset.lang); }));
}
