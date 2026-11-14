// Pembayaran acara lewat Midtrans Snap (layar desain "Ringkasan pembayaran", "Menunggu
// pembayaran", "Tambah tamu"). Harga dihitung ulang server (price_quote / start_order);
// token Snap dibuat Worker (/api/pay/checkout). Server Key tidak pernah sampai ke browser.
import { supabase, rpc, friendly } from "./supabase.js";
import { quote, rp, keepFee, shotsCap, rescheduleFee } from "./price.js";

// Pilihan cepat jatah potretan, sama dengan wizard buat acara
const R_PRESETS = [12, 24, 27, 36, 50];
import { el, esc, toast, modal, fmtRange, fmtDate, toLocalInput, fromLocalInput, ICON } from "./ui.js";

let cfgCache = null;
export async function priceSettings(force = false) {
  if (!cfgCache || force) cfgCache = await rpc("price_settings");
  return cfgCache;
}
export const paymentsOn = async () => Boolean((await priceSettings().catch(() => null))?.payments_enabled);

// Muat snap.js sekali (sandbox atau produksi sesuai Pengaturan harga)
let snapLoading = null;
function loadSnap(cfg) {
  if (window.snap) return Promise.resolve(window.snap);
  if (!cfg.midtrans_client_key) return Promise.reject(new Error("PEMBAYARAN_BELUM_SIAP"));
  snapLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = cfg.midtrans_production ? "https://app.midtrans.com/snap/snap.js" : "https://app.sandbox.midtrans.com/snap/snap.js";
    s.dataset.clientKey = cfg.midtrans_client_key;
    s.onload = () => (window.snap ? resolve(window.snap) : reject(new Error("MIDTRANS_GAGAL")));
    s.onerror = () => { snapLoading = null; reject(new Error("MIDTRANS_GAGAL: snap.js tidak termuat")); };
    document.head.append(s);
  });
  return snapLoading;
}

async function payFetch(route, body) {
  const { data } = await supabase.auth.getSession();
  const tok = data.session?.access_token;
  if (!tok) throw new Error("BELUM_LOGIN");
  const send = () => fetch(`/api/pay/${route}`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // "Failed to fetch" = koneksi putus sebelum ada jawaban (mis. koneksi HTTP/2 lama yang
  // sudah ditutup). Browser tidak mengulang POST sendiri; checkout dan status aman diulang
  // karena start_order memakai ulang pesanan tertunda yang sama.
  let res;
  try { res = await send(); } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    await new Promise((r) => setTimeout(r, 800));
    res = await send();
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

const PAY_LABEL = {
  qris: "QRIS", other_qris: "QRIS", gopay: "GoPay", shopeepay: "ShopeePay", bank_transfer: "Virtual account",
  echannel: "Mandiri Bill", credit_card: "Kartu kredit", cstore: "Gerai retail", akulaku: "Akulaku", tanpa_biaya: "Tanpa biaya",
};
// Metode yang bisa dipilih di layar Pembayaran (dipetakan ke enabled_payments di worker/pay.js)
const METHODS = [
  { id: "qris", name: "QRIS", desc: "Scan dari semua e-wallet & m-banking" },
  { id: "gopay", name: "GoPay", desc: "Buka aplikasi GoPay" },
  { id: "shopeepay", name: "ShopeePay", desc: "Buka aplikasi ShopeePay" },
  { id: "va", name: "Virtual account", desc: "BCA, BNI, BRI, Permata, Mandiri" },
];
const METHOD_KEY = "payMethod";
const loadMethod = () => { try { const v = localStorage.getItem(METHOD_KEY); return METHODS.some((m) => m.id === v) ? v : "qris"; } catch { return "qris"; } };
const saveMethod = (v) => { try { localStorage.setItem(METHOD_KEY, v); } catch { /* abaikan */ } };
const methodName = (id) => METHODS.find((m) => m.id === id)?.name || "";
const metaLine = (ev) => [fmtRange(ev.starts_at, ev.ends_at), `${ev.max_shots} potretan`].filter(Boolean).join(" · ");

// Layar pembayaran di dalam host. opts: { guests, shots, onPaid(order), onBack }
// guests/shots kosong = ukuran acara sekarang (bayar draf).
export function mountPayment(host, ev, opts = {}) {
  const guests = opts.guests ?? ev.max_members, shots = opts.shots ?? ev.max_shots;
  const unlimited = opts.unlimited ?? Boolean(ev.unlimited);
  const keepDays = opts.keepDays ?? ev.keep_days ?? 30;
  const endsAt = opts.endsAt || null;      // jadwal selesai baru (Upgrade acara), ditagih biaya ubah jadwal  const upgrade = ev.pay_status !== "draft";
  let promo = "", order = null, timer = 0, poll = 0, stopped = false, method = loadMethod();
  const stop = () => { stopped = true; clearInterval(timer); clearInterval(poll); };

  async function summary() {
    stop(); stopped = false;
    host.innerHTML = `<p class="hint">Menghitung harga…</p>`;
    let q;
    try { q = await rpc("price_quote", { p_guests: guests, p_shots: shots, p_promo: promo || null, p_event: ev.event_id, p_unlimited: unlimited, p_keep_days: keepDays, p_ends_at: endsAt }); }
    catch (e) { host.innerHTML = `<p class="hint">${esc(friendly(e))}</p>`; return; }
    const cfg = await priceSettings();
    host.innerHTML = `
      <div class="pay">
        <div class="pay-head">
          ${opts.onBack ? `<button type="button" class="round-btn ghost-round" data-act="back" aria-label="Kembali">${ICON.back}</button>` : ""}
          <h3>${upgrade ? "Upgrade acara" : "Pembayaran"}</h3>
        </div>
        <div class="pay-card pay-event">
          <span class="pay-thumb" aria-hidden="true">${ICON.camera}</span>
          <div><b>${esc(ev.name)}</b><small>${esc(metaLine({ ...ev, max_shots: shots }))}</small></div>
        </div>
        <div class="pay-card pay-lines">
          ${q.unlimited ? `<div><span>Unlimited tamu & potretan <small>(tanpa diskon)</small></span><span>${rp(q.subtotal)}</span></div>`
            : `<div><span>${guests} tamu × ${rp(q.rate)} <small>(${shots} potretan)</small></span><span>${rp(q.subtotal)}</span></div>`}
          ${q.discount_pct ? `<div class="minus"><span>Diskon jumlah tamu (${q.discount_pct}%)</span><span>−${rp(q.volume_discount)}</span></div>` : ""}
          ${q.free ? `<div class="minus"><span>Gratis (sampai ${cfg.free_guests} tamu × ${cfg.free_shots} potretan)</span><span>−${rp(q.subtotal)}</span></div>` : ""}
          ${!q.free && q.total > q.subtotal - q.volume_discount ? `<div><span>Pembayaran minimum</span><span>${rp(q.total)}</span></div>` : ""}
          ${q.credit ? `<div class="minus"><span>Sudah dibayar (sebelum promo)</span><span>−${rp(q.credit)}</span></div>` : ""}
          ${q.promo_discount ? `<div class="minus"><span>Kode promo ${esc(promo.toUpperCase())}</span><span>−${rp(q.promo_discount)}</span></div>` : ""}
          ${q.keep_fee ? `<div><span>Simpan foto ${q.keep_days} hari <small>(${q.keep_days >= cfg.keep_flat_days ? "paket" : `${q.keep_days - cfg.keep_free_days} hari × ${rp(cfg.keep_per_day)}`})</small></span><span>${rp(q.keep_fee)}</span></div>` : `<div><span>Simpan foto ${q.keep_days} hari</span><span>Gratis</span></div>`}
          ${q.keep_credit ? `<div class="minus"><span>Masa simpan sudah dibayar</span><span>−${rp(Math.min(q.keep_credit, q.keep_fee))}</span></div>` : ""}
          ${q.reschedule_fee ? `<div><span>Ubah jadwal selesai <small>(ke ${esc(fmtDate(q.ends_at))})</small></span><span>${rp(q.reschedule_fee)}</span></div>` : ""}
          <div class="pay-total"><span>Total</span><b>${rp(q.amount)}</b></div>
          <form class="pay-promo" novalidate>
            <label class="sr-only" for="pay-promo">Kode promo</label>
            <input id="pay-promo" name="promo" placeholder="Kode promo" maxlength="30" autocomplete="off" value="${esc(promo)}" />
            <button type="submit" class="btn small">${promo ? "Ganti" : "Pakai"}</button>
          </form>
          ${q.promo_error ? `<p class="pay-err" role="alert">${esc(friendly(q.promo_error))}</p>` : ""}
        </div>
        ${q.amount ? `<div class="pay-methods">
          <b id="pay-m-label">Metode pembayaran</b>
          <div class="pay-method-grid" role="radiogroup" aria-labelledby="pay-m-label">${METHODS.map((m) => `
            <button type="button" class="pay-method-opt" role="radio" data-method="${m.id}" aria-checked="${m.id === method}" tabindex="${m.id === method ? 0 : -1}">
              <i aria-hidden="true"></i><span><b>${m.name}</b><small>${m.desc}</small></span></button>`).join("")}
          </div>
          <small class="hint">Jendela Midtrans langsung membuka metode ini.</small>
        </div>` : ""}
        <p class="pay-note">${ICON.shield}<span>${upgrade
          ? "Perubahan berlaku begitu pembayaran terkonfirmasi. Tamu yang sudah masuk tidak terganggu."
          : "Acara tersimpan sebagai draf. Begitu pembayaran terkonfirmasi, acara langsung aktif dan QR siap dibagikan."}</span></p>
        <div class="pay-actions">
          <button type="button" class="btn primary" data-act="pay">${q.amount ? `Bayar ${rp(q.amount)} dengan ${methodName(method)}` : "Aktifkan tanpa biaya"}</button>
          <p class="hint">Dengan membayar, kamu menyetujui <a href="/syarat.html" target="_blank" rel="noopener">Syarat layanan</a> dan <a href="/pengembalian-dana.html" target="_blank" rel="noopener">Kebijakan pengembalian dana</a>.</p>
        </div>
      </div>`;
    host.querySelector('[data-act="back"]')?.addEventListener("click", () => { stop(); opts.onBack(); });
    host.querySelector(".pay-promo").onsubmit = (e) => { e.preventDefault(); promo = e.target.promo.value.trim(); summary(); };
    host.querySelector('[data-act="pay"]').onclick = (e) => pay(e.currentTarget, cfg, q.amount);
    // Pilih metode: klik, atau panah kiri/kanan/atas/bawah di dalam grup (pola radio)
    const group = host.querySelector(".pay-method-grid");
    if (group) {
      const pick = (id, focus) => {
        method = id; saveMethod(id);
        group.querySelectorAll("[data-method]").forEach((b) => {
          const on = b.dataset.method === id;
          b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1;
          if (on && focus) b.focus();
        });
        host.querySelector('[data-act="pay"]').textContent = `Bayar ${rp(q.amount)} dengan ${methodName(id)}`;
      };
      group.onclick = (e) => { const b = e.target.closest("[data-method]"); if (b) pick(b.dataset.method); };
      group.onkeydown = (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const ids = METHODS.map((m) => m.id);
        pick(ids[(ids.indexOf(method) + d + ids.length) % ids.length], true);
      };
    }
  }

  async function pay(btn, cfg, amount) {
    btn.disabled = true; btn.textContent = "Menyiapkan pembayaran…";
    try {
      order = await payFetch("checkout", { event_id: ev.event_id, guests, shots, promo: promo || null, method: amount ? method : null, unlimited, keep_days: keepDays, ends_at: endsAt });
      if (order.status === "paid") return done();
      await openSnap(cfg);
      waiting();
    } catch (e) {
      toast(friendly(e), 6000);
      btn.disabled = false; btn.textContent = "Coba lagi";
    }
  }

  async function openSnap(cfg) {
    const snap = await loadSnap(cfg || (await priceSettings()));
    snap.pay(order.snap_token, {
      onSuccess: () => check(true), onPending: () => check(false), onError: () => toast("Pembayaran gagal. Coba lagi atau pilih metode lain."),
      onClose: () => check(false),
    });
  }

  async function check(loud) {
    try {
      const o = await payFetch("status", { order_id: order.id });
      order = { ...order, ...o };
      if (o.status === "paid") return done();
      if (stopped) return;
      if (o.status === "expired" || o.status === "failed") return waiting();
      if (loud) toast("Pembayaran belum terkonfirmasi. Tunggu sebentar lalu cek lagi.");
      renderStatus();
    } catch (e) { if (loud) toast(friendly(e)); }
  }

  function waiting() {
    stop(); stopped = false;
    const dead = order.status === "expired" || order.status === "failed";
    host.innerHTML = `
      <div class="pay pay-wait">
        <span class="pay-icon ${dead ? "bad" : ""}" aria-hidden="true">${ICON.clock}</span>
        <h3>${dead ? (order.status === "failed" ? "Pembayaran gagal" : "Waktu pembayaran habis") : "Menunggu pembayaran"}</h3>
        <p>${dead ? "Buat pembayaran baru; acaramu tetap tersimpan." : "Selesaikan pembayaran di jendela Midtrans. Halaman ini otomatis berganti begitu pembayaran diterima."}</p>
        <div class="pay-card pay-lines">
          <div><span>Total</span><b>${rp(order.amount)}</b></div>
          <div><span>Metode</span><b class="pay-method">${esc(PAY_LABEL[order.payment_type] || methodName(order.pay_method) || order.payment_type || "Belum dipilih")}</b></div>
          <div><span>Bayar sebelum</span><b class="pay-deadline"></b></div>
          <div><span>No. pesanan</span><code>${esc(order.id)}</code></div>
        </div>
        <div class="pay-actions">
          ${dead ? `<button type="button" class="btn primary" data-act="again">Buat pembayaran baru</button>`
            : `<button type="button" class="btn primary" data-act="reopen">Buka lagi jendela pembayaran</button>
               <button type="button" class="btn" data-act="check">Saya sudah bayar, cek status</button>
               <button type="button" class="btn ghost" data-act="change">Ganti metode pembayaran</button>`}
          <p class="hint">Acaramu aman tersimpan${upgrade ? "" : " sebagai draf"} di <a href="#/">beranda</a> dan Panel acara.</p>
        </div>
      </div>`;
    host.querySelector('[data-act="reopen"]')?.addEventListener("click", () => openSnap().catch((e) => toast(friendly(e))));
    host.querySelector('[data-act="check"]')?.addEventListener("click", () => check(true));
    host.querySelector('[data-act="again"]')?.addEventListener("click", summary);
    // Ganti metode: kembali ke ringkasan; checkout berikutnya membuat pesanan baru dengan metode lain
    host.querySelector('[data-act="change"]')?.addEventListener("click", summary);
    renderStatus();
    if (dead) return;
    timer = setInterval(renderStatus, 1000);
    // Webhook Midtrans memperbarui database; cek ringan tiap 4 detik
    poll = setInterval(async () => {
      try {
        const o = await rpc("order_status", { p_order: order.id });
        if (o.status === "paid") done();
        else if (o.status !== order.status) { order = { ...order, ...o }; waiting(); }
      } catch { /* coba lagi */ }
    }, 4000);
  }

  function renderStatus() {
    const d = host.querySelector(".pay-deadline"); if (!d) return;
    const left = Math.max(0, new Date(order.expires_at) - Date.now());
    const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    d.textContent = `${new Date(order.expires_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })} · sisa ${mm}:${String(ss).padStart(2, "0")}`;
    d.classList.toggle("late", left === 0);
    const m = host.querySelector(".pay-method");
    if (m && order.payment_type) m.textContent = PAY_LABEL[order.payment_type] || order.payment_type;
  }

  function done() {
    stop();
    toast("Pembayaran diterima. Terima kasih!");
    opts.onPaid?.(order);
  }

  summary();
  return stop;
}

// Dialog pembayaran mandiri (Panel, Acara saya)
export function openPayment(ev, opts = {}) {
  const { box, close } = modal(`<div class="dialog pay-host"></div>`);
  const stop = mountPayment(box.querySelector(".pay-host"), ev, {
    ...opts, onPaid: (o) => { close(); opts.onPaid?.(o); },
  });
  const obs = new MutationObserver(() => { if (!box.isConnected) { stop(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
}

// Upgrade acara aktif: tamu, potretan per rentang harga (bertahap), Unlimited, perpanjang masa simpan.
// Semua dibayar sebagai selisih dari yang sudah dibayar.
export async function openUpgrade(ev, { members = null, onPaid } = {}) {
  const cfg = await priceSettings();
  const cap = shotsCap(cfg);
  const keepOpts = [...new Set([ev.keep_days, cfg.keep_free_days, Math.min(45, cfg.keep_max_days), cfg.keep_flat_days, cfg.keep_max_days])]
    .filter((d) => d >= ev.keep_days && d <= cfg.keep_max_days).sort((a, b) => a - b);
  // ends: jadwal selesai baru (ISO) atau null = tidak diubah
  // ends: jadwal selesai baru (ISO) atau null = tidak diubah
  const st = { g: ev.max_members, r: ev.max_shots, unl: Boolean(ev.unlimited), keep: ev.keep_days || cfg.keep_free_days, ends: null };
  const { box, close } = modal(`<div class="dialog pay-host"></div>`);
  const host = box.querySelector(".pay-host");
  const endsErr = () => {
    if (!st.ends) return "";
    if (new Date(st.ends) <= new Date()) return "Jadwal selesai harus di masa depan.";
    if (ev.starts_at && new Date(st.ends) <= new Date(ev.starts_at)) return "Jadwal selesai harus setelah waktu mulai.";
    return "";
  };
  function render() {
    const q = quote(cfg, st.g, st.r, st.unl);
    const credit = ev.pay_status === "paid" ? ev.price_basis : 0;
    const keepDue = Math.max(0, keepFee(cfg, st.keep) - (ev.keep_basis || 0));
    const resched = rescheduleFee(cfg, ev.ends_at, st.ends);
    const bad = endsErr();
    const diff = Math.max(0, q.total - credit) + keepDue + resched;
    const same = st.unl === Boolean(ev.unlimited) && st.g === ev.max_members && st.r === ev.max_shots && st.keep === ev.keep_days && !st.ends;
    // Potretan seperti saat pendaftaran: stepper − / angka / + dan pilihan cepat,
    // tidak boleh di bawah jatah yang aktif sekarang
    const minR = ev.max_shots;
    const presets = [...new Set([minR, ...R_PRESETS.filter((v) => v > minR && v <= cap)])];
    const rate = st.unl ? 0 : quote(cfg, 1, st.r).rate;
    host.innerHTML = `
      <div class="pay upgrade">
        ${!ev.unlimited && members !== null && members >= ev.max_members ? `<p class="pay-warn" role="status">${ICON.bell}<span><b>Peserta sudah penuh (${members}/${ev.max_members}).</b> Tamu baru tertahan di layar gabung.</span></p>` : ""}
        <h3>Upgrade acara</h3>
        ${ev.unlimited ? `<p class="hint">Acara ini sudah Unlimited tamu & potretan.</p>` : `
        <div class="pay-card steppers">
          <div class="stepper">
            <span><b>Jumlah tamu</b><small>sekarang ${ev.max_members}</small></span>
            <div><button type="button" data-step="g" data-by="-10" aria-label="Kurangi tamu" ${st.unl || st.g <= ev.max_members ? "disabled" : ""}>−</button>
              <output aria-live="polite">${st.unl ? "∞" : st.g}</output>
              <button type="button" data-step="g" data-by="10" aria-label="Tambah tamu" ${st.unl || st.g >= cfg.max_members_limit ? "disabled" : ""}>+</button></div>
          </div>
        </div>
        <div class="up-section">
          <b id="up-shots-l">Potretan per tamu</b>
          <div class="cr-stepper">
            <button type="button" data-shots-by="-1" aria-label="Kurangi potretan" ${st.unl || st.r <= minR ? "disabled" : ""}>−</button>
            <input type="number" data-act="shots" inputmode="numeric" min="${minR}" max="${cap}" value="${st.r}" aria-labelledby="up-shots-l" ${st.unl ? "disabled" : ""} />
            <button type="button" data-shots-by="1" aria-label="Tambah potretan" ${st.unl || st.r >= cap ? "disabled" : ""}>+</button>
          </div>
          <div class="chips">${presets.map((v) => `<button type="button" class="chip" data-shots="${v}" aria-pressed="${!st.unl && st.r === v}" ${st.unl ? "disabled" : ""}>${v}${v === minR ? " · sekarang" : ""}</button>`).join("")}</div>
          <small class="hint">Minimal ${minR} (jatah sekarang), maksimal ${cap}. Berlaku juga untuk tamu lama.${st.unl ? "" : ` Tarif per tamu untuk isi ini: <b>${rp(rate)}</b>`}</small>
        </div>
        <button type="button" class="up-unl" role="switch" data-act="unl" aria-checked="${st.unl}">
          <span><b>Unlimited tamu & potretan</b><small>${rp(cfg.price_unlimited)} · tanpa diskon & promo · album dibuka setelah acara selesai</small></span>
          <span class="switch bare" aria-hidden="true"><span class="knob"></span></span></button>`}
        ${keepOpts.length > 1 ? `
        <div class="up-section">
          <label for="up-keep"><b>Simpan foto</b></label>
          <select id="up-keep" data-act="keep">${keepOpts.map((d) => `<option value="${d}" ${d === st.keep ? "selected" : ""}>${d} hari${d === ev.keep_days ? " (sekarang)" : ` · ${keepFee(cfg, d) ? rp(keepFee(cfg, d)) : "gratis"}`}</option>`).join("")}</select>
        </div>` : ""}
        <div class="up-section">
          <label for="up-ends"><b>Jadwal selesai</b></label>
          <div class="up-ends">
            <input type="datetime-local" id="up-ends" data-act="ends" value="${toLocalInput(st.ends || ev.ends_at)}" min="${toLocalInput(new Date().toISOString())}" />
            ${st.ends ? `<button type="button" class="btn small ghost" data-act="ends-reset">Batal ubah</button>` : ""}
          </div>
          ${bad ? `<p class="pay-err" role="alert">${bad}</p>` : ""}
          <small class="hint">Sekarang: ${ev.ends_at ? esc(fmtDate(ev.ends_at)) : "tanpa jadwal selesai"}. Geser tanggal ${rp(cfg.reschedule_per_day ?? 3890)} per hari; ganti jam di hari yang sama ${rp(cfg.reschedule_same_day ?? 1890)}.</small>
        </div>
        <div class="pay-card pay-lines soft">
          <div><span>${st.unl ? "Unlimited" : `Paket (${st.g} × ${st.r})`}</span><span>${q.total ? rp(q.total) : "Gratis"}</span></div>
          ${credit ? `<div><span>Sudah dibayar (sebelum promo)</span><span>−${rp(credit)}</span></div>` : ""}
          ${keepDue ? `<div><span>Perpanjang simpan ke ${st.keep} hari</span><span>${rp(keepDue)}</span></div>` : ""}
          ${resched ? `<div><span>Ubah jadwal selesai</span><span>${rp(resched)}</span></div>` : ""}
          <div class="pay-total"><span>Bayar selisih</span><b>${rp(diff)}</b></div>
        </div>
        <div class="pay-actions">
          <button type="button" class="btn primary" data-act="next" ${same || bad ? "disabled" : ""}>${same ? "Pilih upgrade" : diff ? `Lanjut bayar ${rp(diff)}` : "Simpan tanpa biaya"}</button>
          <button type="button" class="btn ghost" data-act="close">Nanti saja</button>
        </div>
      </div>`;
    host.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => {
      st.g = Math.min(cfg.max_members_limit, Math.max(ev.max_members, st.g + Number(b.dataset.by)));
      render();
    }));
    const setShots = (v) => { st.r = Math.min(cap, Math.max(minR, Math.round(Number(v) || minR))); render(); };
    host.querySelectorAll("[data-shots-by]").forEach((b) => (b.onclick = () => setShots(st.r + Number(b.dataset.shotsBy))));
    host.querySelectorAll("[data-shots]").forEach((b) => (b.onclick = () => setShots(b.dataset.shots)));
    host.querySelector('[data-act="shots"]')?.addEventListener("change", (e) => setShots(e.target.value));
    host.querySelector('[data-act="unl"]')?.addEventListener("click", () => { st.unl = !st.unl; render(); });
    host.querySelector('[data-act="keep"]')?.addEventListener("change", (e) => { st.keep = Number(e.target.value); render(); });
    host.querySelector('[data-act="ends"]').addEventListener("change", (e) => {
      const v = fromLocalInput(e.target.value);
      // Sama dengan jadwal sekarang (atau dikosongkan) = tidak diubah
      st.ends = v && !(ev.ends_at && new Date(v).getTime() === new Date(ev.ends_at).getTime()) ? v : null;
      render();
    });
    host.querySelector('[data-act="ends-reset"]')?.addEventListener("click", () => { st.ends = null; render(); });
    host.querySelector('[data-act="close"]').onclick = close;
    host.querySelector('[data-act="next"]').onclick = () => {
      mountPayment(host, ev, { guests: st.g, shots: st.r, unlimited: st.unl, keepDays: st.keep, endsAt: st.ends, onBack: render, onPaid: (o) => { close(); onPaid?.(o); } });
    };
  }
  render();
}
