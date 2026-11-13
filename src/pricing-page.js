// Halaman harga publik (#/harga), bisa dibuka tanpa login. Angka dari price_settings()
// dan rumus src/price.js, jadi selalu sama dengan yang ditagih saat membuat acara.
import { supabase, rpc, friendly } from "./supabase.js";
import { quote, rp } from "./price.js";
import { el, esc, toast, brandLockup } from "./ui.js";
import { t, langSwitch, bindLangSwitch } from "./i18n.js";

const G_PRESETS = [5, 25, 50, 100, 200, 300];
const R_PRESETS = [[12, "12"], [24, "24"], [27, "27 · klasik"], [36, "36"], [50, "50"]];

export async function renderPricing(setView, { loggedIn }) {
  const view = el(`
    <div class="landing pricing-page">
      <header class="lp-nav">
        <a class="lp-logo" href="#/" aria-label="TitipPotret">${brandLockup(42)}</a>
        <nav aria-label="${t("Navigasi utama")}">
          <a class="lp-link" href="#/">${t("Beranda")}</a>
          <a class="lp-link" href="#/harga" aria-current="page">${t("Harga")}</a>
          ${langSwitch()}
          ${loggedIn ? "" : `<button type="button" class="btn lp-outline" data-act="login">${t("Masuk")}</button>`}
        </nav>
      </header>
      <section class="pr-hero">
        <h1>${t("Bayar sesuai acaramu.")}</h1>
        <p class="pr-lead"></p>
      </section>
      <div class="pr-body"><p class="hint">${t("Memuat harga…")}</p></div>
    </div>`);
  setView(view);
  bindLangSwitch(view);
  const login = async () => {
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin } });
    if (error) toast(friendly(error));
  };
  view.querySelector('[data-act="login"]')?.addEventListener("click", login);

  let cfg;
  try { cfg = await rpc("price_settings"); }
  catch (e) { view.querySelector(".pr-body").innerHTML = `<p class="hint">${esc(friendly(e))}</p>`; return; }
  view.querySelector(".pr-lead").textContent = t("Tentukan sendiri jumlah tamu dan isi roll filmnya. Bayar sekali per acara, tanpa langganan. Sampai {n} tamu gratis.", { n: cfg.free_guests });
  const maxG = Math.min(cfg.max_members_limit, 2000), maxR = Math.min(cfg.max_shots_limit, 100);
  const st = { g: Math.min(50, maxG), r: Math.min(24, maxR) };

  view.querySelector(".pr-body").innerHTML = `
    <section class="pr-calc">
      <div class="pr-pick card">
        <div class="pr-field">
          <div class="pr-row"><label for="pr-g">${t("Jumlah tamu")}</label><output class="pr-big" data-out="g"></output></div>
          <input id="pr-g" type="range" min="1" max="${maxG}" step="1" />
          <div class="chips" role="group" aria-label="${t("Jumlah tamu")}">${G_PRESETS.filter((v) => v <= maxG).map((v) => `<button type="button" class="chip" data-g="${v}">${v}</button>`).join("")}</div>
        </div>
        <div class="pr-field">
          <div class="pr-row"><label for="pr-r">${t("Isi roll per tamu")}</label><span><output class="pr-big" data-out="r"></output> <small>${t("potretan")}</small></span></div>
          <input id="pr-r" type="range" min="1" max="${maxR}" step="1" />
          <div class="chips" role="group" aria-label="${t("Isi roll per tamu")}">${R_PRESETS.filter(([v]) => v <= maxR).map(([v, l]) => `<button type="button" class="chip" data-r="${v}">${esc(t(l))}</button>`).join("")}</div>
        </div>
      </div>
      <div class="pr-total" aria-live="polite">
        <span class="pr-k">${t("Total untuk acaramu")}</span>
        <b class="pr-sum"></b>
        <span class="pr-per"></span>
        <div class="pr-lines"></div>
        <button type="button" class="btn pr-cta" data-act="create">${t("Buat acara dengan pengaturan ini")}</button>
        <small>${t("Bisa tambah tamu atau potretan nanti, cukup bayar selisihnya.")}</small>
      </div>
    </section>
    <section class="pr-how">
      <h2>${t("Cara harga dihitung")}</h2>
      <div class="pr-cards">
        <div class="card"><b>${t("Tarif per tamu, sesuai isi roll")}</b>
          ${cfg.roll_tiers.map(([max, p], i) => `<div class="pr-line"><span>${i ? cfg.roll_tiers[i - 1][0] + 1 : 1}–${max} ${t("potretan")}</span><b>${rp(p)}</b></div>`).join("")}</div>
        <div class="card"><b>${t("Makin ramai, makin murah")}</b>
          ${cfg.discounts.length ? cfg.discounts.map(([min, p], i) => `<div class="pr-line"><span>${min}${cfg.discounts[i + 1] ? `–${cfg.discounts[i + 1][0] - 1}` : "+"} ${t("tamu")}</span><b class="ok-text">−${p}%</b></div>`).join("") : `<p class="hint">–</p>`}</div>
        <div class="card"><b>${t("Aturan kecil")}</b>
          <p>${t("Gratis untuk {g} tamu dengan roll sampai {r}.", { g: cfg.free_guests, r: cfg.free_shots })}</p>
          <p>${t("Pembayaran minimum {m}, dibulatkan ke atas per Rp1.000.", { m: rp(cfg.min) })}</p>
          <p>${t("Semua fitur termasuk di setiap acara.")}</p></div>
        <div class="card pr-unl"><b>${t("Unlimited tamu & potretan")}</b>
          <span class="pr-unl-price">${rp(cfg.price_unlimited)}</span>
          <p>${t("Tanpa batas tamu dan potretan, harga tetap tanpa diskon. Album dibuka setelah acara selesai.")}</p></div>
        <div class="card"><b>${t("Masa simpan foto")}</b>
          <div class="pr-line"><span>${t("Sampai {d} hari", { d: cfg.keep_free_days })}</span><b>${t("Gratis")}</b></div>
          <div class="pr-line"><span>${t("{a}–{b} hari", { a: cfg.keep_free_days + 1, b: cfg.keep_flat_days - 1 })}</span><b>${t("{x}/hari", { x: rp(cfg.keep_per_day) })}</b></div>
          <div class="pr-line"><span>${t("{a}–{b} hari", { a: cfg.keep_flat_days, b: cfg.keep_max_days })}</span><b>${rp(cfg.keep_flat)}</b></div>
          <p>${t("Setelah masa simpan, foto dihapus otomatis.")}</p></div>
      </div>
    </section>
    <section class="pr-faq">
      <h2>${t("Pertanyaan umum")}</h2>
      ${[
        ["Bisa pilih jumlah tamu yang tidak bulat, misalnya 37?", "Bisa. Jumlah tamu dan isi roll bebas diatur, harganya langsung dihitung ulang."],
        ["Kalau tamunya ternyata lebih banyak?", "Tambah tamu atau potretan kapan saja dari panel acara. Kamu cukup membayar selisihnya, dan tamu yang sudah masuk tidak terganggu."],
        ["Apakah tamu perlu membayar atau memasang aplikasi?", "Tidak. Tamu cukup scan QR dan masuk dengan akun Google."],
        ["Metode pembayarannya apa saja?", "QRIS, e-wallet, dan virtual account bank lewat Midtrans."],
      ].map(([q, a]) => `<details class="card"><summary>${t(q)}</summary><p>${t(a)}</p></details>`).join("")}
      <p class="hint pr-legal"><a href="/syarat.html">${t("Syarat layanan")}</a> · <a href="/pengembalian-dana.html">${t("Kebijakan pengembalian dana")}</a> · <a href="/privacy.html">${t("Kebijakan privasi")}</a></p>
    </section>`;

  const gIn = view.querySelector("#pr-g"), rIn = view.querySelector("#pr-r");
  function render() {
    gIn.value = st.g; rIn.value = st.r;
    view.querySelector('[data-out="g"]').textContent = st.g;
    view.querySelector('[data-out="r"]').textContent = st.r;
    view.querySelectorAll("[data-g]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.g) === st.g)));
    view.querySelectorAll("[data-r]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.r) === st.r)));
    const q = quote(cfg, st.g, st.r);
    view.querySelector(".pr-sum").textContent = q.total ? rp(q.total) : t("Gratis");
    view.querySelector(".pr-per").textContent = q.total ? t("sekitar {x} per tamu", { x: rp(q.total / st.g) }) : t("Cocok untuk mencoba bersama teman dekat.");
    view.querySelector(".pr-lines").innerHTML = `
      <div><span>${st.g} ${t("tamu")} × ${rp(q.rate)}</span><span>${rp(q.subtotal)}</span></div>
      <div><span>${q.discount_pct ? t("Diskon {p}% jumlah tamu", { p: q.discount_pct }) : t("Diskon jumlah tamu")}</span><span class="ok-text">${q.discount_pct ? `−${rp(q.volume_discount)}` : "–"}</span></div>
      <div><span>${t("Total potretan maksimum")}</span><span>${(st.g * st.r).toLocaleString("id-ID")} ${t("foto")}</span></div>`;
  }
  gIn.oninput = () => { st.g = Number(gIn.value); render(); };
  rIn.oninput = () => { st.r = Number(rIn.value); render(); };
  view.querySelector(".pr-calc").addEventListener("click", (e) => {
    const g = e.target.closest("[data-g]"), r = e.target.closest("[data-r]");
    if (g) st.g = Number(g.dataset.g);
    if (r) st.r = Number(r.dataset.r);
    if (g || r) render();
  });
  // Buat acara dengan ukuran ini: ke #/buat (router meminta login Google bila perlu)
  view.querySelector('[data-act="create"]').onclick = () => {
    try { localStorage.setItem("createPreset", JSON.stringify({ guests: st.g, shots: st.r })); }
    catch { /* penyimpanan diblokir: halaman memakai angka bawaan */ }
    location.hash = "#/buat";
  };
  render();
}
