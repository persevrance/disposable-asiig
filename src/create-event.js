// Buat acara v2 (#/buat), halaman penuh lima langkah sesuai desain kanvas:
// 1 jenis & nama, 2 waktu & buka album, 3 kamera, 4 tamu & privasi, 5 sampul & tautan,
// lalu pembayaran (bila berbayar) dan layar "Acaramu sudah siap!".
// Isian disimpan di sessionStorage supaya tidak hilang saat halaman dimuat ulang.
import QRCode from "qrcode";
import { rpc, friendly } from "./supabase.js";
import { FILMS } from "./film.js";
import { uploadCover } from "./storage.js";
import { openCrop } from "./crop.js";
import { duplicateEvent, cardData, inviteLink } from "./owner.js";
import { downloadQrCard } from "./qrcard.js";
import { creationClosedDialog } from "./admin.js";
import { priceSettings, mountPayment } from "./payment.js";
import { quote, rp } from "./price.js";
import { el, esc, toast, fmtBytes, confirmDialog, actionSheet, copyText, ICON, fromLocalInput, fmtRange } from "./ui.js";

const DRAFT = "createDraft";
const TYPES = [
  { id: "nikahan", name: "Nikahan", shots: 36, film: "pastel" },
  { id: "wisuda", name: "Wisuda", shots: 24, film: "senja" },
  { id: "ulang_tahun", name: "Ulang tahun", shots: 24, film: "pagi" },
  { id: "gathering", name: "Gathering", shots: 12, film: "asli" },
  { id: "trip", name: "Trip", shots: 36, film: "pagi" },
  { id: "lainnya", name: "Lainnya" },
];
const OPEN_MODES = [
  { id: "roll", name: "Per gulungan", tag: "Khas Jepretin", desc: () => "Foto tamu terbuka begitu filmnya habis" },
  { id: "after", name: "Setelah acara selesai", desc: (d) => `Semua terbuka serentak${d.ends ? ` pukul ${hhmm(d.ends)}` : " saat acara selesai"}` },
  { id: "delay", name: "Cuci film dulu", desc: (d) => `Terbuka ${d.delayH} jam setelah acara selesai` },
  { id: "time", name: "Waktu tertentu", desc: () => "Pilih tanggal dan jam sendiri" },
];
const KEEP = [[30, "30 hari"], [90, "90 hari"], [0, "Tidak dihapus otomatis"]];
const G_PRESETS = [5, 25, 50, 100, 200, 300];
const R_PRESETS = [[12, "12"], [24, "24"], [27, "27 · klasik"], [36, "36"], [50, "50"]];

const stampText = (iso) => { const d = iso ? new Date(iso) : new Date(); return `'${String(d.getFullYear()).slice(2)} ${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getDate()).padStart(2, "0")}`; };
const hhmm = (iso) => new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
const dayMon = (iso) => new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export async function renderCreate(setView, { me } = {}) {
  let settings, quota, gate, price, can, role;
  try {
    [settings, quota, gate, price, can, role] = await Promise.all([
      rpc("get_settings"), rpc("my_event_quota").catch(() => null), rpc("creation_state").catch(() => null),
      priceSettings(true).catch(() => null), rpc("can_create_event").catch(() => false), rpc("my_role").catch(() => null),
    ]);
  } catch (e) { toast(friendly(e)); location.hash = "#/"; return; }
  const back = role ? "#/admin/acara" : "#/";
  // Belum berperan pembuat acara: beranda membuka formulir pengajuan (atau status pengajuannya)
  if (!can) { try { localStorage.setItem("intent", "create"); } catch { /* abaikan */ } location.hash = "#/"; return; }
  if (gate && !gate.bypass && gate.mode === "closed") { location.hash = back; creationClosedDialog(gate); return; }
  if (quota?.limit != null && quota.used >= quota.limit) {
    location.hash = back;
    confirmDialog({ title: "Batas acara habis", text: `Anda sudah membuat ${quota.used} dari ${quota.limit} acara. Hubungi superadmin untuk menambahnya.`, ok: "Mengerti", cancel: "Tutup" });
    return;
  }
  if (quota?.storage_limit_mb && Number(quota.storage_bytes) >= quota.storage_limit_mb * 1048576) {
    location.hash = back;
    confirmDialog({ title: "Kuota storage penuh", text: `Acara Anda memakai ${fmtBytes(quota.storage_bytes)} dari ${fmtBytes(quota.storage_limit_mb * 1048576)}. Hapus acara lama atau hubungi superadmin.`, ok: "Mengerti", cancel: "Tutup" });
    return;
  }
  const small = Boolean(gate && !gate.bypass && gate.mode === "limited");
  const maxShots = small ? Math.min(settings.max_shots_limit, gate.max_shots) : settings.max_shots_limit;
  const maxGuests = small ? Math.min(settings.max_members_limit, gate.max_guests) : settings.max_members_limit;
  const paid = Boolean(price?.payments_enabled && !gate?.bypass);
  const defFilm = FILMS[settings.default_film] ? settings.default_film : "asli";

  // Isian: dari sesi sebelumnya, atau ukuran yang dipilih di halaman harga
  let preset = null;
  try { preset = JSON.parse(localStorage.getItem("createPreset") || "null"); localStorage.removeItem("createPreset"); } catch { /* abaikan */ }
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(DRAFT) || "null"); } catch { /* abaikan */ }
  const meta = me?.user_metadata || {};
  const D = Object.assign({
    step: 1, type: "", name: "", host: meta.full_name || meta.name || "", starts: "", ends: "",
    lockStart: false, open: "roll", delayH: 2, openAt: "", keepDays: 30, film: defFilm, shots: Math.min(24, maxShots),
    creatorEmail: me?.email || "", dateStamp: true, gallery: false, front: true, filmChoice: true, inviteOnly: false, guests: Math.min(50, maxGuests),
    albumPrivate: false, showNames: true, welcome: "", slug: "", slugTouched: false,
  }, saved || {}, preset ? { guests: Math.min(preset.guests, maxGuests), shots: Math.min(preset.shots, maxShots) } : {});
  let coverFile = null, coverUrl = "", slugState = { ok: true }, slugTimer = 0;
  const save = () => { try { sessionStorage.setItem(DRAFT, JSON.stringify(D)); } catch { /* abaikan */ } };
  const touched = () => Boolean(D.name || D.welcome || D.starts);

  const view = el(`<main class="create" aria-live="polite"></main>`);
  setView(view);

  // ---------- kerangka langkah ----------
  function frame(title, body, { sub = "", nextLabel = "Lanjut", back = true } = {}) {
    view.innerHTML = `
      <div class="cr-in">
        <div class="cr-top">
          <button type="button" class="round-btn ghost-round" data-act="${D.step === 1 ? "cancel" : "prev"}" aria-label="${D.step === 1 ? "Batal" : "Kembali"}">${D.step === 1 ? ICON.close : ICON.back}</button>
          <span class="cr-count">Langkah ${D.step} dari 5</span>
        </div>
        <div class="cr-steps" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= D.step ? "on" : ""}"></i>`).join("")}</div>
        <div class="cr-title"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div>
        <form class="cr-body" novalidate>${body}</form>
        <div class="cr-actions${back ? "" : " single"}">
          ${back ? `<button type="button" class="btn" data-act="prev">Kembali</button>` : ""}
          <button type="button" class="btn primary" data-act="next">${nextLabel}</button>
        </div>
      </div>`;
    view.querySelector(".cr-body").onsubmit = (e) => { e.preventDefault(); next(); };
    view.querySelectorAll('[data-act="prev"]').forEach((b) => (b.onclick = () => { D.step--; save(); render(); }));
    view.querySelector('[data-act="cancel"]')?.addEventListener("click", async () => {
      if (touched() && !(await confirmDialog({ title: "Batalkan pembuatan acara?", text: "Isian yang sudah ditulis akan dihapus.", ok: "Batalkan", cancel: "Lanjut mengisi", danger: true }))) return;
      try { sessionStorage.removeItem(DRAFT); } catch { /* abaikan */ }
      location.hash = back;
    });
    view.querySelector('[data-act="next"]').onclick = next;
    window.scrollTo(0, 0);
  }
  const f = () => view.querySelector(".cr-body").elements;
  // Pilihan bertombol (radio/toggle) di dalam form: data-set="kunci" data-v="nilai"
  function bindPicks(after) {
    view.querySelectorAll("[data-set]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.set, v = b.dataset.v;
      D[k] = v === "true" ? true : v === "false" ? false : isNaN(Number(v)) || v === "" ? v : Number(v);
      save(); after ? after(k) : render();
    }));
    view.querySelectorAll("[data-flip]").forEach((b) => (b.onclick = () => { D[b.dataset.flip] = !D[b.dataset.flip]; save(); render(); }));
  }
  const sw = (k, name, desc, on = D[k]) => `
    <div class="cr-toggle"><span><b>${name}</b><small>${desc}</small></span>
      <button type="button" class="switch bare" role="switch" data-flip="${k}" aria-checked="${Boolean(on)}" aria-label="${esc(name)}"><span class="knob"></span></button></div>`;

  // ---------- 1. Jenis dan nama ----------
  function step1() {
    frame("Acara apa yang mau dibuat?", `
      <div class="cr-types" role="group" aria-label="Jenis acara">${TYPES.map((x) => `
        <button type="button" class="cr-pick" data-type="${x.id}" aria-pressed="${D.type === x.id}">
          <b>${x.name}</b><small>${x.shots ? `${Math.min(x.shots, maxShots)} · ${esc(FILMS[x.film]?.name || "")}` : "atur sendiri"}</small></button>`).join("")}
      </div>
      <label>Nama acara<input name="name" required maxlength="80" placeholder="Contoh: Wisuda Angkatan 2026" value="${esc(D.name)}" autocomplete="off" /></label>
      <label>Ditampilkan sebagai penyelenggara<input name="host" maxlength="60" placeholder="Contoh: Panitia Wisuda" value="${esc(D.host)}" /></label>
      ${paid ? `<label>Email pembuat acara<input name="creatorEmail" type="email" inputmode="email" autocomplete="email" required placeholder="nama@email.com" value="${esc(D.creatorEmail)}" aria-describedby="cr-email-hint" />
        <small id="cr-email-hint" class="hint">Otomatis menjadi pembuat acara setelah pembayaran lunas: bisa mengelola acara ini dan membuat acara berikutnya di Dashboard. Login Google harus memakai email ini.</small></label>` : ""}
      <button type="button" class="linklike cr-dup" data-act="dup">${ICON.copy} Duplikat dari acara sebelumnya</button>`,
    { sub: "Template mengisi pengaturan awal. Semuanya tetap bisa diubah.", back: false });
    view.querySelectorAll("[data-type]").forEach((b) => (b.onclick = () => {
      const t = TYPES.find((x) => x.id === b.dataset.type);
      D.type = t.id;
      if (t.shots) { D.shots = Math.min(t.shots, maxShots); D.film = FILMS[t.film] ? t.film : D.film; }
      readStep(); save(); render();
    }));
    view.querySelector('[data-act="dup"]').onclick = async () => {
      let rows = [];
      try { rows = (await rpc("my_events")).filter((e) => e.is_owner).slice(0, 10); } catch (e) { return toast(friendly(e)); }
      if (!rows.length) return toast("Belum ada acara sebelumnya untuk diduplikat.");
      actionSheet("Duplikat dari acara", rows.map((e) => ({
        label: `${e.name}${e.starts_at ? ` · ${fmtRange(e.starts_at, e.ends_at)}` : ""}`,
        run: async () => { const id = await duplicateEvent(e); if (id) { try { sessionStorage.removeItem(DRAFT); } catch { /* abaikan */ } } },
      })));
    };
    queueMicrotask(() => f().name.focus());
  }

  // ---------- 2. Waktu dan buka album ----------
  function revealIso() {
    if (D.open === "after") return D.ends ? fromLocalInput(D.ends) : null;
    if (D.open === "delay") return D.ends ? new Date(new Date(fromLocalInput(D.ends)).getTime() + D.delayH * 3600e3).toISOString() : null;
    if (D.open === "time") return D.openAt ? fromLocalInput(D.openAt) : null;
    return null;
  }
  function purgeIso() {
    if (!D.keepDays) return null;
    const base = fromLocalInput(D.ends) || fromLocalInput(D.starts) || new Date().toISOString();
    return new Date(new Date(base).getTime() + D.keepDays * 86400e3).toISOString();
  }
  function step2() {
    const rev = revealIso(), purge = purgeIso();
    frame("Kapan acaranya?", `
      <div class="date-row">
        <label>Mulai<input type="datetime-local" name="starts" value="${esc(D.starts)}" /></label>
        <label>Selesai<input type="datetime-local" name="ends" value="${esc(D.ends)}" /></label>
      </div>
      <p class="hint cr-tight">Kamera berhenti otomatis saat acara selesai.</p>
      <div class="cr-toggles">${sw("lockStart", "Kamera aktif saat acara dimulai", D.starts ? `Sebelum ${hhmm(fromLocalInput(D.starts))}, tamu yang sudah bergabung melihat hitung mundur` : "Butuh waktu mulai. Sebelum itu tamu melihat hitung mundur")}</div>
      <fieldset class="cr-radios"><legend>Kapan album dibuka?</legend>
        ${OPEN_MODES.map((m) => `
          <button type="button" class="cr-radio" role="radio" aria-checked="${D.open === m.id}" data-set="open" data-v="${m.id}">
            <i aria-hidden="true"></i><span><b>${m.name}${m.tag ? ` <em>${m.tag}</em>` : ""}</b><small>${esc(m.desc(D))}</small></span></button>`).join("")}
      </fieldset>
      ${D.open === "delay" ? `<label>Durasi cuci film<select name="delayH">${[1, 2, 3, 6, 12, 24].map((h) => `<option value="${h}" ${D.delayH === h ? "selected" : ""}>${h} jam setelah selesai</option>`).join("")}</select></label>` : ""}
      ${D.open === "time" ? `<label>Album dibuka pada<input type="datetime-local" name="openAt" value="${esc(D.openAt)}" /></label>` : ""}
      <div class="cr-timeline" role="list" aria-label="Garis waktu acara">
        <span role="listitem"><b>${D.starts ? hhmm(fromLocalInput(D.starts)) : "–"}</b>mulai</span>
        <span role="listitem"><b>${D.ends ? hhmm(fromLocalInput(D.ends)) : "–"}</b>kamera berhenti</span>
        <span role="listitem" class="hot"><b>${D.open === "roll" ? "per tamu" : rev ? hhmm(rev) : "–"}</b>${D.open === "roll" ? "film habis = terbuka" : `album dibuka${rev && D.ends && dayMon(rev) !== dayMon(fromLocalInput(D.ends)) ? ` ${dayMon(rev)}` : ""}`}</span>
        <span role="listitem"><b>${purge ? dayMon(purge) : "–"}</b>hapus otomatis</span>
      </div>
      <label>Simpan foto selama<select name="keepDays">${KEEP.map(([v, l]) => `<option value="${v}" ${D.keepDays === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>`);
    bindPicks((k) => { readStep(); render(); });
    view.querySelector(".cr-body").addEventListener("change", () => { readStep(); save(); render(); });
  }

  // ---------- 3. Kamera ----------
  function step3() {
    const fl = FILMS[D.film] || FILMS[defFilm];
    const rate = paid ? quote(price, 1, D.shots).rate : 0;
    frame("Atur kameranya", `
      <div class="cr-film">
        <div class="cr-polaroid"><span class="film-swatch fs-${esc(D.film)}" role="img" aria-label="Pratinjau efek film ${esc(fl.name)}">${D.dateStamp ? `<em>${stampText(fromLocalInput(D.starts))}</em>` : ""}</span></div>
        <div><b>Efek film: ${esc(fl.name)}</b><p>${esc(fl.desc)}</p></div>
      </div>
      <div class="cr-chips" role="group" aria-label="Efek film">${Object.entries(FILMS).map(([id, x]) => `
        <button type="button" class="cr-chip" data-set="film" data-v="${id}" aria-pressed="${D.film === id}"><span class="film-swatch fs-${id}" aria-hidden="true"></span>${esc(x.name)}</button>`).join("")}</div>
      <div class="cr-field">
        <span class="cr-label">Jatah jepretan per tamu</span>
        <div class="cr-stepper">
          <button type="button" data-step="shots" data-by="-1" aria-label="Kurangi jepretan" ${D.shots <= 1 ? "disabled" : ""}>−</button>
          <input type="number" name="shots" inputmode="numeric" min="1" max="${maxShots}" value="${D.shots}" aria-label="Jatah jepretan per tamu" />
          <button type="button" data-step="shots" data-by="1" aria-label="Tambah jepretan" ${D.shots >= maxShots ? "disabled" : ""}>+</button>
        </div>
        <div class="chips">${R_PRESETS.filter(([v]) => v <= maxShots).map(([v, l]) => `<button type="button" class="chip" data-set="shots" data-v="${v}" aria-pressed="${D.shots === v}">${l}</button>`).join("")}</div>
        <small class="hint">Bebas 1–${maxShots} jepretan${small ? " (sedang dibatasi)" : ""}.${paid ? ` Tarif per tamu untuk isi ini: <b>${rp(rate)}</b>` : ""}</small>
      </div>
      <div class="cr-toggles">
        ${sw("dateStamp", "Tanda tanggal", "Cap tanggal oranye di pojok foto")}
        ${sw("gallery", "Izinkan unggah dari galeri", "Matikan agar semua foto diambil saat acara")}
        ${sw("front", "Izinkan kamera depan", "Tamu bisa selfie")}
        ${sw("filmChoice", "Tamu boleh memilih efek film", "Kalau mati, semua foto memakai efek di atas")}
      </div>`);
    bindPicks();
    bindSteppers("shots", 1, maxShots);
  }
  function bindSteppers(k, min, max) {
    view.querySelectorAll(`[data-step="${k}"]`).forEach((b) => (b.onclick = () => { D[k] = Math.min(max, Math.max(min, D[k] + Number(b.dataset.by))); save(); render(); }));
    const inp = f()[k];
    inp.onchange = () => { D[k] = Math.min(max, Math.max(min, Math.round(Number(inp.value) || min))); save(); render(); };
  }

  // ---------- 4. Tamu dan privasi ----------
  function step4() {
    const q = paid ? quote(price, D.guests, D.shots) : null;
    frame("Siapa yang ikut?", `
      <div class="cr-seg" role="radiogroup" aria-label="Cara bergabung">
        <button type="button" role="radio" aria-checked="${!D.inviteOnly}" data-set="inviteOnly" data-v="false"><b>Siapa pun dengan link</b><small>Scan QR atau kode</small></button>
        <button type="button" role="radio" aria-checked="${D.inviteOnly}" data-set="inviteOnly" data-v="true"><b>Hanya yang diundang</b><small>Daftar email, diisi di Panel</small></button>
      </div>
      <div class="cr-card">
        <div class="cr-row"><label for="cr-g" class="cr-label">Jumlah tamu</label>
          <div class="cr-stepper small">
            <button type="button" data-step="guests" data-by="-1" aria-label="Kurangi tamu" ${D.guests <= 1 ? "disabled" : ""}>−</button>
            <input id="cr-g" type="number" name="guests" inputmode="numeric" min="1" max="${maxGuests}" value="${D.guests}" />
            <button type="button" data-step="guests" data-by="1" aria-label="Tambah tamu" ${D.guests >= maxGuests ? "disabled" : ""}>+</button>
          </div></div>
        <div class="chips">${G_PRESETS.filter((v) => v <= maxGuests).map((v) => `<button type="button" class="chip" data-set="guests" data-v="${v}" aria-pressed="${D.guests === v}">${v}</button>`).join("")}</div>
        ${q ? `<div class="cr-price"><span>${D.guests} tamu × ${D.shots} jepretan${q.discount_pct ? ` · diskon ${q.discount_pct}%` : ""}</span><b>${q.total ? rp(q.total) : "Gratis"}</b></div>
        <small class="hint">Bisa tambah tamu atau jepretan kapan saja, cukup bayar selisihnya. <a href="#/harga" target="_blank" rel="noopener">Cara hitung</a></small>`
          : `<small class="hint">Maksimal ${maxGuests} tamu${small ? " (sedang dibatasi)" : ""}.</small>`}
      </div>
      <div class="cr-field">
        <span class="cr-label">Siapa yang bisa melihat album?</span>
        <div class="cr-seg two" role="radiogroup" aria-label="Akses album">
          <button type="button" role="radio" aria-checked="${!D.albumPrivate}" data-set="albumPrivate" data-v="false"><b>Semua tamu</b></button>
          <button type="button" role="radio" aria-checked="${D.albumPrivate}" data-set="albumPrivate" data-v="true"><b>Hanya penyelenggara</b></button>
        </div>
        ${D.albumPrivate ? `<small class="hint">Tamu tetap melihat fotonya sendiri.</small>` : ""}
        <div class="cr-toggles">${sw("showNames", "Tampilkan nama pemotret", "Nama muncul di bawah foto")}</div>
      </div>`);
    bindPicks();
    bindSteppers("guests", 1, maxGuests);
  }

  // ---------- 5. Sampul dan tautan ----------
  function step5() {
    if (!D.slugTouched && !D.slug && D.name) D.slug = slugify(D.name);
    const q = paid ? quote(price, D.guests, D.shots) : null;
    const rev = revealIso();
    const openText = D.open === "roll" ? "Per gulungan" : D.open === "delay" ? `Cuci film ${D.delayH} jam` : rev ? `${dayMon(rev)}, ${hhmm(rev)}` : "Setelah acara";
    frame("Sampul dan tautan", `
      <div class="cr-cover">
        <div class="cr-cover-pick">
          <label class="cr-upload">${ICON.album}<span>${coverFile ? "Ganti sampul" : "Pilih sampul"}</span><input type="file" name="cover" accept="image/*" hidden /></label>
          <small class="hint">Foto atau kartu undangan. Bisa dipotong manual.</small>
        </div>
        <div class="cr-phone" role="img" aria-label="Pratinjau layar tamu">
          <div><span class="cr-ph-cover"${coverUrl ? ` style="background-image:url('${coverUrl}')"` : ""}></span>
            <b>${esc(D.name || "Nama acara")}</b><i></i><i></i><em></em></div>
        </div>
      </div>
      <label><span>Pesan sambutan <span class="cr-opt">(opsional)</span></span>
        <textarea name="welcome" rows="2" maxlength="300" placeholder="Abadikan momen dari sudut pandangmu!">${esc(D.welcome)}</textarea></label>
      <label for="cr-slug"><span>Tautan khusus <span class="cr-opt">(opsional)</span></span></label>
      <span class="slug-field cr-slug ${D.slug ? (slugState.ok ? "ok" : "bad") : ""}"><span>${esc(location.host)}/</span>
        <input id="cr-slug" name="slug" maxlength="40" autocomplete="off" spellcheck="false" placeholder="wisuda2026" value="${esc(D.slug)}" aria-describedby="cr-slug-msg" /></span>
      <small id="cr-slug-msg" class="cr-slug-msg"></small>
      <div class="cr-summary">
        <b>Ringkasan</b>
        <div><span>Waktu</span><span>${esc(fmtRange(fromLocalInput(D.starts), fromLocalInput(D.ends)) || "Belum diatur")}${D.lockStart ? " · kamera aktif saat mulai" : ""}</span></div>
        <div><span>Album dibuka</span><span>${esc(openText)}${D.albumPrivate ? " · hanya penyelenggara" : ""}</span></div>
        <div><span>Kamera</span><span>${D.shots} jepretan · ${esc(FILMS[D.film]?.name || "")}</span></div>
        <div><span>Tamu</span><span>${D.guests} tamu${q ? ` · ${q.total ? rp(q.total) : "Gratis"}` : ""}</span></div>
      </div>`,
    { nextLabel: q?.total ? "Lanjut bayar" : "Buat acara" });
    const fe = f();
    fe.cover.onchange = async () => {
      const file = fe.cover.files[0];
      fe.cover.value = ""; // supaya file yang sama bisa dipilih lagi
      if (!file) return;
      const cropped = await openCrop(file);
      if (!cropped) return; // dibatalkan
      if (coverUrl) URL.revokeObjectURL(coverUrl);
      coverFile = cropped;
      coverUrl = URL.createObjectURL(cropped);
      readStep(); render();
    };
    fe.welcome.oninput = () => { D.welcome = fe.welcome.value; save(); };
    fe.slug.oninput = () => {
      const v = fe.slug.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (v !== fe.slug.value) fe.slug.value = v;
      D.slug = v; D.slugTouched = true; save(); checkSlug();
    };
    checkSlug();
  }
  function checkSlug() {
    clearTimeout(slugTimer);
    const msg = view.querySelector(".cr-slug-msg"), box = view.querySelector(".cr-slug");
    if (!msg) return;
    const show = (ok, text) => { slugState = { ok }; box.classList.toggle("ok", ok && Boolean(D.slug)); box.classList.toggle("bad", !ok); msg.textContent = text; msg.className = `cr-slug-msg ${ok ? "ok" : "bad"}`; };
    if (!D.slug) { slugState = { ok: true }; box.classList.remove("ok", "bad"); msg.className = "cr-slug-msg"; msg.textContent = "Kosongkan bila cukup memakai kode undangan."; return; }
    msg.textContent = "Memeriksa…"; msg.className = "cr-slug-msg";
    slugTimer = setTimeout(async () => {
      try {
        const r = await rpc("slug_available", { p_slug: D.slug });
        show(r.ok, r.ok ? "Tersedia · kode undangan cadangan tetap dibuat" : r.reason === "taken" ? "Sudah dipakai acara lain" : "Huruf kecil, angka, dan tanda hubung, 3–40 karakter");
      } catch { show(true, ""); }
    }, 350);
  }

  // ---------- simpan isian langkah yang tampil ----------
  function readStep() {
    const fe = view.querySelector(".cr-body")?.elements;
    if (!fe) return;
    if (fe.name) D.name = fe.name.value;
    if (fe.host) D.host = fe.host.value;
    if (fe.creatorEmail) D.creatorEmail = fe.creatorEmail.value.trim();
    if (fe.starts) D.starts = fe.starts.value;
    if (fe.ends) D.ends = fe.ends.value;
    if (fe.delayH) D.delayH = Number(fe.delayH.value);
    if (fe.openAt) D.openAt = fe.openAt.value;
    if (fe.keepDays) D.keepDays = Number(fe.keepDays.value);
    if (fe.shots) D.shots = Math.min(maxShots, Math.max(1, Math.round(Number(fe.shots.value) || 1)));
    if (fe.guests) D.guests = Math.min(maxGuests, Math.max(1, Math.round(Number(fe.guests.value) || 1)));
    if (fe.welcome) D.welcome = fe.welcome.value;
  }
  function valid() {
    if (D.step === 1 && !D.name.trim()) { toast("Isi nama acara."); f().name?.focus(); return false; }
    if (D.step === 1 && paid && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(D.creatorEmail)) { toast("Isi email pembuat acara yang valid."); f().creatorEmail?.focus(); return false; }
    if (D.step === 2) {
      const s = fromLocalInput(D.starts), e = fromLocalInput(D.ends);
      if (s && e && new Date(e) <= new Date(s)) { toast("Waktu selesai harus setelah waktu mulai."); return false; }
      if ((D.open === "after" || D.open === "delay") && !e) { toast("Pilihan ini butuh waktu selesai acara."); return false; }
      if (D.lockStart && !s) { toast("Isi waktu mulai supaya kamera bisa aktif otomatis saat acara dimulai."); return false; }
      if (D.open === "time" && !D.openAt) { toast("Pilih waktu album dibuka."); return false; }
    }
    if (D.step === 5 && D.slug && !slugState.ok) { toast("Tautan khusus belum bisa dipakai. Ubah atau kosongkan."); return false; }
    return true;
  }
  function next() {
    readStep();
    if (!valid()) return;
    save();
    if (D.step < 5) { D.step++; save(); render(); return; }
    submit();
  }

  // ---------- buat acara, lalu bayar bila perlu ----------
  async function submit() {
    const btn = view.querySelector('[data-act="next"]');
    btn.disabled = true; btn.textContent = "Membuat acara…";
    let id;
    try {
      id = await rpc("create_event", {
        p_name: D.name.trim(), p_max_shots: D.shots, p_max_members: D.guests,
        p_invite_only: D.inviteOnly, p_film: D.film,
      });
    } catch (e) { toast(friendly(e), 6000); btn.disabled = false; btn.textContent = "Coba lagi"; return; }
    try { sessionStorage.removeItem(DRAFT); } catch { /* abaikan */ }
    const patch = {
      starts_at: fromLocalInput(D.starts), ends_at: fromLocalInput(D.ends),
      reveal_at: revealIso(), purge_at: purgeIso(), welcome_text: D.welcome,
      hide_names: !D.showNames, allow_film_choice: D.filmChoice, event_type: D.type || null,
      host_name: D.host, album_private: D.albumPrivate, date_stamp: D.dateStamp,
      allow_gallery: D.gallery, allow_front: D.front, lock_until_start: Boolean(D.lockStart && D.starts),
      ...(paid && D.creatorEmail ? { creator_email: D.creatorEmail } : {}),
    };
    try { await rpc("set_event", { p_event: id, p_patch: patch }); }
    catch (e) { toast("Acara dibuat, tetapi sebagian pengaturan gagal disimpan: " + friendly(e), 6000); }
    if (D.slug) {
      try { await rpc("set_event", { p_event: id, p_patch: { slug: D.slug } }); }
      catch (e) { toast(`Tautan khusus tidak tersimpan: ${friendly(e)} Atur lagi dari Panel.`, 6000); }
    }
    if (coverFile) {
      try {
        const path = `${id}/${crypto.randomUUID()}.jpg`;
        await uploadCover(path, coverFile);
        await rpc("set_cover", { p_event: id, p_path: path });
      } catch { toast("Sampul gagal diunggah. Pasang lagi dari Panel.", 5000); }
    }
    const st = (await rpc("my_status", { p_event: id }).catch(() => []))[0];
    if (!st) { location.hash = `#/e/${id}/panel`; return; }
    if (st.pay_status === "draft") return payStep(st);
    done(st, false);
  }

  function payStep(st) {
    view.innerHTML = `<div class="cr-in"><div class="dialog pay-host"></div></div>`;
    mountPayment(view.querySelector(".pay-host"), st, {
      onPaid: async () => done((await rpc("my_status", { p_event: st.event_id }).catch(() => []))[0] || st, true),
    });
  }

  // ---------- Acaramu sudah siap! ----------
  function done(st, wasPaid) {
    const link = inviteLink(st);
    const pretty = link.replace(/^https?:\/\//, "");
    view.innerHTML = `
      <div class="cr-in cr-done">
        <div class="cr-confetti" aria-hidden="true"></div>
        <div class="cr-done-head">
          <span class="tag ok">${wasPaid ? "Pembayaran diterima" : st.pay_status === "paid" ? "Lunas" : "Aktif"} · ${st.max_members} tamu × ${st.max_shots} jepretan</span>
          <h1>Acaramu sudah siap!</h1>
          <p>Bagikan ke tamu sebelum acara dimulai.</p>
        </div>
        <div class="cr-qr card">
          <canvas class="qr" aria-label="Kode QR acara"></canvas>
          <div class="copy-row"><code>${esc(pretty)}</code><button type="button" class="btn small" data-act="copy">${ICON.copy} Salin</button></div>
          <small class="hint">Kode cadangan <b>${esc(st.join_code)}</b></small>
        </div>
        <div class="cr-share">
          <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Yuk ikut memotret di ${st.name}! Buka ${link}`)}">${ICON.chat} Kirim ke WhatsApp</a>
          <button type="button" class="btn" data-act="card">${ICON.printer} Cetak kartu QR</button>
        </div>
        <div class="cr-actions">
          <a class="btn primary" href="#/e/${st.event_id}/panel">Ke panel acara</a>
          <a class="btn" href="#/e/${st.event_id}">Coba sebagai tamu</a>
        </div>
      </div>`;
    QRCode.toCanvas(view.querySelector(".qr"), link, { width: 200, margin: 1 }).catch(() => {});
    view.querySelector('[data-act="copy"]').onclick = () => copyText(link, { done: "Link undangan disalin." });
    view.querySelector('[data-act="card"]').onclick = () => downloadQrCard(cardData(st)).catch((e) => toast(friendly(e)));
    window.scrollTo(0, 0);
  }

  function render() {
    [step1, step2, step3, step4, step5][D.step - 1]();
  }
  if (D.step < 1 || D.step > 5) D.step = 1;
  render();
}
