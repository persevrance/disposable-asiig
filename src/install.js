// Pasang aplikasi di layar utama HP.
// Android/Chrome: memakai prompt bawaan (beforeinstallprompt).
// iPhone/iPad: Safari tidak punya prompt, jadi tampilkan langkahnya.
import { modal } from "./ui.js";

let deferred = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e;
});
window.addEventListener("appinstalled", () => { deferred = null; });

export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Apakah tombol "Pasang" layak ditampilkan di perangkat ini?
export const canInstall = () => !isStandalone() && (Boolean(deferred) || isIOS());

export async function promptInstall() {
  if (deferred) {
    const e = deferred;
    deferred = null;
    e.prompt();
    const choice = await e.userChoice.catch(() => null);
    return choice?.outcome === "accepted";
  }
  const { box, close } = modal(`
    <div class="dialog">
      <h3>Pasang di layar utama</h3>
      <ol class="steps">
        <li>Ketuk tombol <b>Bagikan</b> di Safari (kotak dengan panah ke atas).</li>
        <li>Gulir lalu pilih <b>Tambah ke Layar Utama</b>.</li>
        <li>Ketuk <b>Tambah</b>. Ikon Disposable Asiig muncul di layar utama.</li>
      </ol>
      <div class="dialog-actions"><button class="btn primary" data-act="ok">Mengerti</button></div>
    </div>`);
  box.querySelector('[data-act="ok"]').onclick = close;
  return false;
}
