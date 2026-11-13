// Halaman depan untuk pengunjung yang belum login: perkenalan TitipPotret + tombol masuk.
// Tombol "Masuk" memakai login Google (diikat di main.js); "Buat acara" menuju #/buat,
// dan router meminta login Google dulu bila belum masuk.
import { esc, brandLockup, WORDMARK } from "./ui.js";
import { inAppBrowser, isAndroid, chromeIntentUrl } from "./camera.js";
import { t, langSwitch } from "./i18n.js";

const FEATURE_ICONS = {
  camera: '<rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  chat: '<path d="M4 5h16v11H8l-4 4z"/><path d="M9 10h6"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
};
const icon = (k, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FEATURE_ICONS[k]}</svg>`;

export function landingHtml({ code, shareLink }) {
  const features = [
    ["camera", "coral", t("Jatah potretan, tanpa hapus"), t("Penyelenggara menentukan jatahnya. Setiap foto berarti karena nggak bisa diulang.")],
    ["sun", "sun", t("Efek film"), t("Pilih nuansa foto dengan pratinjau langsung, dan efeknya tercatat di setiap foto.")],
    ["grid", "mint", t("Album bersama"), t("Foto muncul langsung tanpa muat ulang. Saring per tamu, foto saya, atau favorit.")],
    ["screen", "sky", t("Slideshow ke proyektor"), t("Tampilkan album di layar besar, lengkap dengan QR di pojok untuk tamu yang baru datang.")],
    ["chat", "grape", t("Buku tamu"), t("Tamu meninggalkan ucapan berupa teks atau rekaman suara.")],
    ["bell", "coral", t("Kabar saat album terbuka"), t("Notifikasi ke HP tamu, plus kolase otomatis yang siap dibagikan ke Instagram.")],
  ];
  const steps = [
    [t("Buat acara"), t("Isi nama dan tanggal, atur jatah potretan dan efek film. Kartu QR siap cetak langsung jadi.")],
    [t("Tamu scan dan potret"), t("Scan QR di meja tamu atau masukkan kode 6 huruf, login Google, lalu langsung memotret.")],
    [t("Album terbuka"), t("Setiap gulungan yang habis masuk ke album bersama. Atau aktifkan mode cuci film supaya semua foto terbuka setelah acara.")],
  ];
  const uses = [t("Nikahan"), t("Wisuda"), t("Ulang tahun"), t("Gathering kantor"), t("Liburan bareng"), t("Acara komunitas")];

  const warn = inAppBrowser() ? `
    <div class="card warn-card">
      <b>${t("Buka di Chrome atau Safari dulu")}</b>
      <p>${t("Link ini terbuka di dalam aplikasi (WhatsApp/Instagram/dll.). Google menolak login dari sini dan kamera bisa terblokir.")}
      ${t("Ketuk menu ⋮ atau ⋯ lalu pilih \"Buka di browser\" / \"Buka di Safari\".")}</p>
      <div class="row">
        ${isAndroid() ? `<a class="btn small primary" href="${esc(chromeIntentUrl(shareLink))}">${t("Buka di Chrome")}</a>` : ""}
        <button class="btn small" data-act="copy">${t("Salin link")}</button>
      </div>
    </div>` : "";

  // Datang lewat undangan: satu tombol saja, langsung login lalu masuk acara
  const cta = code
    ? `<button type="button" class="btn primary lp-big" data-act="google">${t("Masuk dengan Google")}</button>`
    : `<a class="btn primary lp-big" href="#/buat">${t("Buat acara")}</a>
       <button type="button" class="btn lp-big" data-act="show-code" aria-expanded="false" aria-controls="lp-code">${t("Gabung pakai kode")}</button>`;

  return `
    <div class="landing">
      <header class="lp-nav">
        <a class="lp-logo" href="/" aria-label="TitipPotret">${brandLockup(42)}</a>
        <nav aria-label="${t("Navigasi utama")}">
          <button type="button" class="lp-link" data-scroll="lp-cara">${t("Cara kerja")}</button>
          <button type="button" class="lp-link" data-scroll="lp-fitur">${t("Fitur")}</button>
          <a class="lp-link" href="#/harga">${t("Harga")}</a>
          ${langSwitch()}
          <button type="button" class="btn lp-outline" data-act="google">${t("Masuk")}</button>
        </nav>
      </header>

      <section class="lp-hero">
        <div class="lp-hero-text">
          <span class="lp-kicker">${t("Kamera sekali pakai untuk acaramu")}</span>
          <h1>${t("<b>Potretin</b> momennya,")} <span>${t("<b>jadiin</b> ceritanya.")}</span></h1>
          <p class="lp-lead">${t("Tamu scan QR, login dengan Google, lalu dapat jatah potretan. Nggak bisa dihapus, nggak bisa diulang. Begitu filmnya habis, fotonya masuk ke album bersama.")}</p>
          ${code ? `<p class="pill lp-invite">${t("Undangan acara:")} <b>${esc(code)}</b></p>` : ""}
          ${warn}
          <div class="lp-cta">${cta}</div>
          <form id="lp-code" class="lp-code" hidden>
            <label for="lp-code-input">${t("Kode acara")}</label>
            <div class="code-row">
              <input id="lp-code-input" class="code-input" name="code" placeholder="ABC123" maxlength="12"
                     autocapitalize="characters" autocomplete="off" spellcheck="false" required />
              <button class="btn primary">${t("Gabung")}</button>
            </div>
            <p class="hint">${t("Setelah login dengan Google, Anda langsung masuk ke acara.")}</p>
          </form>
          <p class="lp-note">${t("Tanpa install aplikasi. Langsung dari browser HP.")}</p>
        </div>

        <div class="lp-phone-wrap" aria-hidden="true">
          <div class="lp-phone">
            <div class="lp-screen">
              <div class="lp-screen-top"><span>${t("Wisuda Angkatan 2026")}</span><b>24</b></div>
              <div class="lp-vf"><i></i><i></i><i></i><i></i><span>${t("Pratinjau kamera")}</span></div>
              <div class="lp-screen-ctl"><span class="lp-thumb"></span><span class="lp-shutter"><span></span></span>${icon("bolt", 26)}</div>
            </div>
          </div>
          <div class="lp-float lp-float-left"><b>${t("Sisa potretan")}</b><span>${t("24 dari 30")}</span></div>
          <div class="lp-float lp-float-right">${t("Efek film: Senja Hangat")}</div>
        </div>
      </section>

      <section id="lp-cara" class="lp-how">
        <div class="lp-inner">
          <h2>${t("Tiga langkah, langsung jalan.")}</h2>
          <ol class="lp-steps">
            ${steps.map(([h, p], i) => `<li><span class="lp-num">0${i + 1}</span><h3>${h}</h3><p>${p}</p></li>`).join("")}
          </ol>
        </div>
      </section>

      <section id="lp-fitur" class="lp-inner lp-features">
        <div class="lp-head">
          <h2>${t("Serunya kamera film, praktisnya HP.")}</h2>
          <p>${t("Semua yang dibutuhkan penyelenggara dan tamu, dari meja tamu sampai foto tersimpan.")}</p>
        </div>
        <div class="lp-grid">
          ${features.map(([ic, tone, h, p]) => `<div class="lp-card"><span class="lp-ic ${tone}">${icon(ic)}</span><h3>${h}</h3><p>${p}</p></div>`).join("")}
        </div>
      </section>

      <section class="lp-inner lp-uses">
        <h2>${t("Cocok untuk")}</h2>
        <ul>${uses.map((u) => `<li>${u}</li>`).join("")}</ul>
      </section>

      <section class="lp-inner">
        <div class="lp-final">
          <h2>${t("Siap potret momen berikutnya?")}</h2>
          <p>${t("Buat acaramu, cetak kartu QR-nya, dan biarkan tamu yang memotret.")}</p>
          <a class="btn primary lp-big" href="#/buat">${t("Buat acara")}</a>
        </div>
      </section>

      <footer class="lp-foot">
        <div class="lp-inner">
          ${WORDMARK}
          <div><a href="#/harga">${t("Harga")}</a><a href="/syarat.html">${t("Syarat layanan")}</a><a href="/pengembalian-dana.html">${t("Kebijakan pengembalian dana")}</a><a href="/privacy.html">${t("Kebijakan privasi")}</a><span>© ${new Date().getFullYear()} TitipPotret</span></div>
        </div>
      </footer>
    </div>`;
}
