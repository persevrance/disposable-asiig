// Dashboard: #/admin/<tab>. Superadmin melihat semua tab;
// pembuat acara hanya tab Acara (acaranya sendiri), yang menjadi pusat kerjanya.
import QRCode from "qrcode";
import { supabase, rpc, friendly } from "./supabase.js";
import { themeSwitch, bindThemeSwitch } from "./theme.js";
import { FILMS, filmName } from "./film.js";
import { RESOLUTIONS, deleteEventFiles, duplicateEvent, cardData, resizeImage } from "./owner.js";
import { uploadCover, coverUrl, removeFiles, removeVoices, r2Health, migrateToR2, setStorageBackend } from "./storage.js";
import { pingAlbum } from "./realtime.js";
import { kickNotify, setVapidKey, joinCreationWaitlist } from "./push.js";
import { downloadQrCard, printQrCard } from "./qrcard.js";
import { renderReports } from "./moderation.js";
import {
  el, esc, toast, fmtDate, fmtBytes, confirmDialog, typeToConfirm, actionSheet, modal, copyText, ICON,
  fmtRange, fromLocalInput, toLocalInput, downloadCsv, brandLockup, initial,
} from "./ui.js";

const TABS = [
  ["ringkasan", "Ringkasan"],
  ["acara", "Acara"],
  ["pembuatan", "Pembuatan acara"],
  ["pengguna", "Pengguna & peran"],
  ["moderasi", "Moderasi"],
  ["privasi", "Privasi"],
  ["pengaturan", "Pengaturan"],
  ["log", "Log"],
];
const CREATOR_TABS = ["acara"];
const ALIASES = { peran: "pengguna" }; // tautan lama
const PAGE = 25;

export async function renderAdmin(app, tab, { setView, me }) {
  let role = null;
  try { role = await rpc("my_role"); } catch { /* ditangani di bawah */ }
  if (role !== "superadmin" && role !== "creator") {
    toast("Dashboard hanya untuk superadmin dan pembuat acara.");
    location.hash = "#/";
    return;
  }
  tab = ALIASES[tab] || tab;
  const tabs = role === "superadmin" ? TABS : TABS.filter(([t]) => CREATOR_TABS.includes(t));
  if (!tabs.some(([t]) => t === tab)) tab = tabs[0][0];
  const superadmin = role === "superadmin";
  const label = (t, n) => (t === "acara" && !superadmin ? "Acara saya" : n);
  const meta = me?.user_metadata || {};
  const who = meta.full_name || meta.name || me?.email || "";
  // Header: terang untuk pembuat acara, gelap untuk superadmin (desain Jepretin)
  const view = el(`
    <div class="admin-shell">
      <header class="admin-head${superadmin ? " dark" : ""}">
        <div class="admin-head-in">
          <a class="admin-logo" href="#/" aria-label="Jepretin, kembali ke beranda">${brandLockup(34, { dark: superadmin })}</a>
          ${superadmin ? `<span class="admin-badge">Superadmin</span>` : ""}
          <nav class="admin-nav" aria-label="Navigasi dashboard">
            ${tabs.map(([t, n]) => `<a href="#/admin/${t}" class="${t === tab ? "on" : ""}" ${t === tab ? 'aria-current="page"' : ""}>${label(t, n)}</a>`).join("")}
          </nav>
          <button type="button" class="avatar-btn" data-act="account" aria-label="Akun: ${esc(who)}" aria-haspopup="dialog">${initial(who)}</button>
        </div>
      </header>
      <main class="page admin wide">
        <div class="admin-title">
          <div><h1>${esc(label(tab, tabs.find(([t]) => t === tab)[1]))}</h1><span class="admin-sub"></span></div>
          <div class="admin-title-actions"></div>
        </div>
        <div class="admin-body"><p class="hint">Memuat…</p></div>
      </main>
    </div>`);
  setView(view);
  const body = view.querySelector(".admin-body");
  // Menu akun: kembali ke beranda, tema tampilan, keluar
  view.querySelector('[data-act="account"]').onclick = () => {
    const { box, close } = modal(`
      <div class="account-menu">
        <div class="am-head"><span class="avatar-btn">${initial(who)}</span><div><b>${esc(who)}</b><small>${esc(me?.email || "")}</small></div></div>
        <div class="sheet-actions">
          <a class="btn" href="#/">${ICON.back} Ke beranda</a>
          <button class="btn danger" data-act="logout">Keluar</button>
        </div>
        <div class="am-row"><span>Tema</span>${themeSwitch()}</div>
      </div>`);
    bindThemeSwitch(box);
    box.querySelector('a[href="#/"]').addEventListener("click", close);
    box.querySelector('[data-act="logout"]').onclick = async () => {
      close();
      try { localStorage.removeItem(`joined:${me?.id}`); } catch { /* abaikan */ }  // sama seperti keluar dari beranda
      await supabase.auth.signOut();
      location.hash = "#/";
    };
  };
  // Angka yang menunggu tindakan di menu: laporan foto, pengajuan pembuat acara, permintaan data
  if (superadmin) rpc("admin_overview").then((o) => {
    const set = (t, n) => {
      const a = view.querySelector(`.admin-nav a[href="#/admin/${t}"]`);
      if (a && n > 0) a.insertAdjacentHTML("beforeend", ` <span class="nav-count" aria-label="${n} menunggu">${n}</span>`);
    };
    set("moderasi", o.reports_open); set("pengguna", o.creator_requests_open); set("privasi", o.data_requests_open);
    set("pembuatan", o.events_review);
  }).catch(() => {});
  const render = { ringkasan, acara, pembuatan, pengguna, moderasi, privasi, pengaturan, log }[tab];
  try { await render(body, me, role); }
  catch (e) { body.replaceChildren(el(`<p class="hint">${esc(friendly(e))}</p>`)); }
}

// ---------- Pembantu tampilan ----------
const stat = (label, value, sub) => `
  <div class="stat"><b>${Number(value).toLocaleString("id-ID")}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const funnelRow = (label, n, of, cls = "") => `
  <div class="funnel-row"><span>${label}</span><div class="bar ${cls}"><span style="width:${pct(n, of)}%"></span></div><b>${n}</b></div>`;

// Tombol pilihan (saring)
function chips(options, value, onChange, label) {
  const n = el(`<div class="chips" role="group" aria-label="${esc(label)}">
    ${options.map(([v, t]) => `<button type="button" class="chip" data-v="${v}" aria-pressed="${v === value}">${esc(t)}</button>`).join("")}
  </div>`);
  n.onclick = (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    n.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
    onChange(b.dataset.v);
  };
  return n;
}

function pagerEl(total, offset, onPage) {
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + PAGE, total);
  const n = el(`
    <div class="pager">
      <span>${from}–${to} dari ${Number(total).toLocaleString("id-ID")}</span>
      <div class="row tight">
        <button class="btn small" data-p="-1" ${offset <= 0 ? "disabled" : ""}>‹ Sebelumnya</button>
        <button class="btn small" data-p="1" ${to >= total ? "disabled" : ""}>Berikutnya ›</button>
      </div>
    </div>`);
  n.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => onPage(Math.max(0, offset + Number(b.dataset.p) * PAGE))));
  return n;
}

async function deleteEventFully(eventId, coverPath) {
  if (coverPath === undefined) coverPath = (await rpc("my_status", { p_event: eventId }))[0]?.cover_path;
  await deleteEventFiles(eventId, coverPath);
  await rpc("delete_event", { p_event: eventId });
}

// ---------- Pembuatan acara ditutup (dilihat penyelenggara) ----------
function creationClosedDialog(gate) {
  const reopen = gate.reopen_at ? fmtDate(gate.reopen_at) : "";
  const { box, close } = modal(`
    <div class="dialog creation-closed">
      <span class="cc-icon" aria-hidden="true">${ICON.calendar}</span>
      <h3>Pembuatan acara baru sedang ditutup</h3>
      <p>${esc(gate.message || "Kapasitas sedang penuh. Kami akan membuka lagi secepatnya.")}</p>
      ${reopen ? `<p class="hint">Dibuka lagi otomatis: <b>${esc(reopen)}</b></p>` : ""}
      <ul class="cc-list">
        <li>${ICON.check}Acara yang sudah kamu buat tetap berjalan normal.</li>
        <li>${ICON.check}Tamu tetap bisa bergabung dan memotret di acara yang ada.</li>
        <li>${ICON.check}Pengaturan acara tetap bisa diubah, kecuali menambah tamu atau roll.</li>
      </ul>
      <button type="button" class="btn primary" data-act="notify">${ICON.bell} ${gate.waiting ? "Kamu akan dikabari" : "Kabari saya saat dibuka"}</button>
      <button type="button" class="btn ghost" data-act="close">Tutup</button>
    </div>`);
  const btn = box.querySelector('[data-act="notify"]');
  btn.disabled = Boolean(gate.waiting);
  box.querySelector('[data-act="close"]').onclick = close;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const pushed = await joinCreationWaitlist();
      btn.innerHTML = `${ICON.bell} Kamu akan dikabari`;
      toast(pushed ? "Kami kirim notifikasi saat pembuatan acara dibuka lagi." : "Tercatat. Notifikasi belum aktif di perangkat ini, jadi cek lagi nanti.", 5000);
    } catch (e) { toast(friendly(e)); btn.disabled = false; }
  };
}

// ---------- Buat acara: wizard tiga langkah, diakhiri kartu QR ----------
// Dipakai juga dari beranda. Langkah: (1) nama & jadwal, (2) jatah & film,
// (3) sampul, sambutan, cuci film & rencana hapus. Lalu layar selesai dengan QR.
const REVEAL_CHOICES = [
  ["", "Saat film tiap tamu habis (bawaan)"],
  ["end", "Semua foto terbuka saat acara selesai"],
  ["end+2", "2 jam setelah acara selesai"],
  ["next9", "Besok pagi pukul 09.00 setelah acara"],
];
const PURGE_CHOICES = [["", "Tanpa rencana hapus"], ["30", "30 hari setelah acara"], ["90", "90 hari setelah acara"]];

function revealAt(choice, endsIso) {
  if (!choice || !endsIso) return null;
  const end = new Date(endsIso);
  if (choice === "end") return end.toISOString();
  if (choice === "end+2") return new Date(end.getTime() + 2 * 3600e3).toISOString();
  const d = new Date(end); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

export async function createEventDialog() {
  let settings, quota, gate;
  try {
    [settings, quota, gate] = await Promise.all([
      rpc("get_settings"), rpc("my_event_quota").catch(() => null), rpc("creation_state").catch(() => null),
    ]);
  } catch (e) { toast(friendly(e)); return; }
  // Pembuatan acara ditutup superadmin: tampilkan pesan penutupan, bukan wizard
  if (gate && !gate.bypass && gate.mode === "closed") { creationClosedDialog(gate); return; }
  // Hanya acara kecil: batas tamu dan roll mengikuti status, bukan batas global
  const small = Boolean(gate && !gate.bypass && gate.mode === "limited");
  if (small) {
    settings.max_members_limit = Math.min(settings.max_members_limit, gate.max_guests);
    settings.max_shots_limit = Math.min(settings.max_shots_limit, gate.max_shots);
  }
  const limited = quota && quota.limit !== null && quota.limit !== undefined;
  const left = limited ? Math.max(0, quota.limit - quota.used) : null;
  if (left === 0) {
    await confirmDialog({
      title: "Batas acara habis",
      text: `Anda sudah membuat ${quota.used} dari ${quota.limit} acara. Hubungi superadmin untuk menambahnya.`,
      ok: "Mengerti", cancel: "Tutup",
    });
    return;
  }
  const storageFull = quota?.storage_limit_mb && Number(quota.storage_bytes) >= quota.storage_limit_mb * 1048576;
  if (storageFull) {
    await confirmDialog({
      title: "Kuota storage penuh",
      text: `Acara Anda memakai ${fmtBytes(quota.storage_bytes)} dari ${fmtBytes(quota.storage_limit_mb * 1048576)}. Hapus acara lama atau hubungi superadmin.`,
      ok: "Mengerti", cancel: "Tutup",
    });
    return;
  }

  const { box, close } = modal(`
    <form class="dialog wizard" novalidate>
      <div class="wiz-head">
        <div class="wiz-top">
          <button type="button" class="round-btn ghost-round" data-act="cancel" aria-label="Batal">${ICON.close}</button>
          <span class="wiz-count">Langkah 1 dari 3</span>
        </div>
        <div class="wiz-steps" aria-hidden="true"><i class="on"></i><i></i><i></i></div>
        <h3 class="wiz-title">Nama dan jadwal</h3>
      </div>
      ${limited ? `<p class="hint">Sisa batas: <b>${left}</b> dari ${quota.limit} acara.</p>` : ""}
      ${small ? `<p class="note warn-note">Pembuatan acara sedang dibatasi: maks. <b>${settings.max_members_limit}</b> peserta × <b>${settings.max_shots_limit}</b> jepretan.${gate.message ? ` ${esc(gate.message)}` : ""}</p>` : ""}

      <fieldset class="wiz-step" data-step="1">
        <label>Nama acara <input name="name" required maxlength="80" autofocus placeholder="Contoh: Pernikahan Rani & Bima" /></label>
        <div class="date-row">
          <label>Mulai <input type="datetime-local" name="starts_at" /></label>
          <label>Selesai <input type="datetime-local" name="ends_at" /></label>
        </div>
        <p class="hint">Opsional, tapi disarankan: acara tertutup otomatis saat waktu selesai lewat, dan jadwalnya tampil di kartu QR.</p>
      </fieldset>

      <fieldset class="wiz-step" data-step="2" hidden>
        <div class="wiz-field">
          <label for="wiz-shots" class="wiz-label">Jatah jepretan per tamu</label>
          <div class="stepper">
            <button type="button" data-step-by="-1" aria-label="Kurangi">−</button>
            <input id="wiz-shots" name="max_shots" type="number" inputmode="numeric" min="1" max="${settings.max_shots_limit}" value="${Math.min(30, settings.max_shots_limit)}" />
            <button type="button" data-step-by="1" aria-label="Tambah">+</button>
          </div>
          <small class="hint">Batas maksimum mengikuti pengaturan admin (${settings.max_shots_limit}).</small>
        </div>
        <label>Maks. peserta <input name="max_members" type="number" min="1" max="${settings.max_members_limit}" value="${Math.min(60, settings.max_members_limit)}" /></label>
        <div class="wiz-field">
          <span class="wiz-label">Efek film bawaan</span>
          <input type="hidden" name="film" value="${esc(FILMS[settings.default_film] ? settings.default_film : "asli")}" />
          <div class="film-grid" role="group" aria-label="Efek film bawaan">
            ${Object.entries(FILMS).map(([id, fl]) => `
              <button type="button" class="film-card" data-film="${id}" aria-pressed="${id === (FILMS[settings.default_film] ? settings.default_film : "asli")}" title="${esc(fl.desc)}">
                <span class="film-swatch fs-${id}"></span><b>${esc(fl.name)}</b>
              </button>`).join("")}
          </div>
        </div>
        <label class="check"><input type="checkbox" name="allow_film_choice" checked /> Tamu boleh memilih efek film sendiri</label>
        <label class="check"><input type="checkbox" name="hide_names" /> Sembunyikan nama pengunggah di album</label>
        <label class="check"><input type="checkbox" name="invite_only" /> Hanya email yang diundang (daftar diisi di Panel)</label>
      </fieldset>

      <fieldset class="wiz-step" data-step="3" hidden>
        <div class="wiz-cover">
          <div class="cover-preview"><span>Belum ada sampul</span></div>
          <label class="btn small">Pilih sampul<input type="file" accept="image/*" name="cover" hidden /></label>
        </div>
        <label>Kalimat sambutan (opsional)
          <textarea name="welcome_text" rows="2" maxlength="300" placeholder="Contoh: Abadikan momen bahagia kami, ya!"></textarea></label>
        <label>Kapan foto terbuka untuk semua tamu
          <select name="reveal">${REVEAL_CHOICES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
        <label>Rencana hapus foto
          <select name="purge">${PURGE_CHOICES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
        <p class="hint wiz-need-end" hidden>Pilihan berdasarkan waktu selesai butuh jadwal selesai di langkah 1.</p>
      </fieldset>

      <div class="wiz-actions">
        <button type="button" class="btn" data-act="back">Batal</button>
        <button class="btn primary" data-act="next">Lanjut</button>
      </div>
    </form>`, { wide: true });
  const form = box.querySelector("form");
  const f = form.elements;
  const backBtn = box.querySelector('[data-act="back"]');
  const nextBtn = box.querySelector('[data-act="next"]');
  const TITLES = ["Nama dan jadwal", "Jatah dan efek film", "Sampul dan pembukaan album"];
  const NEXT = ["Lanjut ke jatah", "Lanjut ke sampul", "Buat acara"];
  let step = 1, coverFile = null;

  box.querySelector('[data-act="cancel"]').onclick = () => close();
  // Stepper jatah jepretan
  form.querySelectorAll("[data-step-by]").forEach((b) => (b.onclick = () => {
    const v = Math.min(settings.max_shots_limit, Math.max(1, (Number(f.max_shots.value) || 0) + Number(b.dataset.stepBy)));
    f.max_shots.value = v;
  }));
  // Kartu efek film
  form.querySelector(".film-grid").onclick = (e) => {
    const c = e.target.closest(".film-card");
    if (!c) return;
    f.film.value = c.dataset.film;
    form.querySelectorAll(".film-card").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  };

  function show() {
    form.querySelectorAll(".wiz-step").forEach((x) => { x.hidden = Number(x.dataset.step) !== step; });
    form.querySelectorAll(".wiz-steps i").forEach((d, i) => d.classList.toggle("on", i < step));
    box.querySelector(".wiz-count").textContent = `Langkah ${step} dari 3`;
    box.querySelector(".wiz-title").textContent = TITLES[step - 1];
    backBtn.textContent = step === 1 ? "Batal" : "Kembali";
    nextBtn.textContent = NEXT[step - 1];
    const noEnd = !f.ends_at.value;
    for (const sel of [f.reveal, f.purge]) {
      [...sel.options].forEach((o) => { o.disabled = noEnd && o.value !== "" && sel === f.reveal; });
      if (sel === f.reveal && noEnd && sel.value) sel.value = "";
    }
    box.querySelector(".wiz-need-end").hidden = !noEnd;
    form.querySelector(`.wiz-step[data-step="${step}"] input, .wiz-step[data-step="${step}"] select`)?.focus();
  }

  function valid() {
    if (step === 1) {
      if (!f.name.value.trim()) { toast("Isi nama acara."); f.name.focus(); return false; }
      const a = fromLocalInput(f.starts_at.value), b = fromLocalInput(f.ends_at.value);
      if (a && b && new Date(b) <= new Date(a)) { toast("Waktu selesai harus setelah waktu mulai."); return false; }
    }
    if (step === 2) {
      const shots = Number(f.max_shots.value), members = Number(f.max_members.value);
      if (!(shots >= 1 && shots <= settings.max_shots_limit)) { toast(`Jatah foto 1–${settings.max_shots_limit}.`); return false; }
      if (!(members >= 1 && members <= settings.max_members_limit)) { toast(`Peserta 1–${settings.max_members_limit}.`); return false; }
    }
    return true;
  }

  f.cover.onchange = () => {
    coverFile = f.cover.files[0] || null;
    const prev = box.querySelector(".cover-preview");
    prev.innerHTML = coverFile ? `<img alt="Pratinjau sampul" />` : `<span>Belum ada sampul</span>`;
    if (coverFile) prev.querySelector("img").src = URL.createObjectURL(coverFile);
  };
  backBtn.onclick = () => { if (step === 1) close(); else { step--; show(); } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!valid()) return;
    if (step < 3) { step++; show(); return; }
    nextBtn.disabled = true; backBtn.disabled = true;
    nextBtn.textContent = "Membuat…";
    try {
      const id = await rpc("create_event", {
        p_name: f.name.value.trim(),
        p_max_shots: Number(f.max_shots.value),
        p_max_members: Number(f.max_members.value),
        p_invite_only: f.invite_only.checked,
        p_film: f.film.value,
      });
      const starts = fromLocalInput(f.starts_at.value), ends = fromLocalInput(f.ends_at.value);
      const purgeDays = Number(f.purge.value);
      const purgeBase = ends || starts || new Date().toISOString();
      const patch = {
        starts_at: starts, ends_at: ends,
        welcome_text: f.welcome_text.value,
        allow_film_choice: f.allow_film_choice.checked,
        hide_names: f.hide_names.checked,
        reveal_at: revealAt(f.reveal.value, ends),
        purge_at: purgeDays ? new Date(new Date(purgeBase).getTime() + purgeDays * 86400e3).toISOString() : null,
      };
      try { await rpc("set_event", { p_event: id, p_patch: patch }); }
      catch (err) { toast("Acara dibuat, tetapi sebagian pengaturan gagal disimpan: " + friendly(err), 6000); }
      let coverPath = null;
      if (coverFile) {
        try {
          const blob = await resizeImage(coverFile, 1600, 0.85);
          coverPath = `${id}/${crypto.randomUUID()}.jpg`;
          await uploadCover(coverPath, blob);
          await rpc("set_cover", { p_event: id, p_path: coverPath });
        } catch { coverPath = null; toast("Sampul gagal diunggah. Pasang lagi dari Panel.", 5000); }
      }
      const st = (await rpc("my_status", { p_event: id }))[0];
      showDone(st || { event_id: id, name: f.name.value, join_code: "", max_shots: Number(f.max_shots.value), cover_path: coverPath, starts_at: starts, ends_at: ends });
    } catch (err) {
      toast(friendly(err));
      nextBtn.disabled = false; backBtn.disabled = false; nextBtn.textContent = "Buat acara";
    }
  };

  // Layar selesai: QR dan kartu siap cetak
  function showDone(st) {
    const link = `${location.origin}/?kode=${st.join_code}`;
    const when = fmtRange(st.starts_at, st.ends_at);
    form.replaceWith(el(`
      <div class="dialog wiz-done">
        <div class="wiz-done-head">${ICON.check}<h3>Acara siap</h3></div>
        <p><b>${esc(st.name)}</b>${when ? `<br>${esc(when)}` : ""}</p>
        ${st.needs_review ? `<p class="warn-note">Acara sebesar ini ditinjau superadmin dulu. Tamu sudah bisa bergabung; kamera aktif setelah tinjauan selesai.</p>` : ""}
        <div class="invite">
          <canvas class="qr" aria-label="Kode QR undangan"></canvas>
          <div><p class="code">${esc(st.join_code)}</p><p class="link">${esc(link)}</p></div>
        </div>
        <p class="hint">Bagikan link ke tamu, atau cetak kartu QR untuk meja tamu.</p>
        <div class="row">
          <button class="btn small primary" data-act="card-dl">Unduh kartu QR</button>
          <button class="btn small" data-act="card-print">${ICON.printer} Cetak</button>
          <button class="btn small" data-act="copy">${ICON.link} Salin link</button>
        </div>
        <div class="dialog-actions"><a class="btn primary" href="#/e/${st.event_id}/panel" data-act="panel">Buka Panel acara</a></div>
      </div>`));
    const done = box.querySelector(".wiz-done");
    QRCode.toCanvas(done.querySelector(".qr"), link, { width: 160, margin: 1 });
    done.querySelector('[data-act="card-dl"]').onclick = () => downloadQrCard(cardData(st)).catch((e) => toast(friendly(e)));
    done.querySelector('[data-act="card-print"]').onclick = () => printQrCard(cardData(st)).catch((e) => toast(friendly(e)));
    done.querySelector('[data-act="copy"]').onclick = () => copyText(link, { done: "Link undangan disalin." });
    done.querySelector('[data-act="panel"]').onclick = () => close();
    done.querySelector('[data-act="card-dl"]').focus();
  }
  show();
}

// ---------- Ringkasan: perlu perhatian, berlangsung, angka ----------
const ERROR_KINDS = {
  DENIED: "Izin kamera ditolak", NOT_HTTPS: "Bukan HTTPS", IN_APP: "Browser bawaan aplikasi",
  UNSUPPORTED: "Browser tidak mendukung", NO_CAMERA: "Kamera tidak ada", BUSY: "Kamera dipakai aplikasi lain",
  OTHER: "Lainnya", BLACK_VIEWFINDER: "Jendela bidik hitam", DARK_FRAMES: "Gambar kamera gelap",
  SHOT_FAILED: "Jepretan gagal diproses",
};
// Ringkas user agent menjadi "iPhone · Safari"
function shortUA(ua = "") {
  const dev = (ua.match(/iPhone|iPad|Android [\d.]+|Windows|Mac OS X|Linux/) || ["?"])[0];
  const br = (ua.match(/Instagram|FBAV|WhatsApp|Line\/|SamsungBrowser|CriOS|FxiOS|EdgA?|Firefox|Chrome|Safari/) || ["?"])[0];
  const names = { CriOS: "Chrome", FxiOS: "Firefox", FBAV: "Facebook", "Line/": "LINE", Edg: "Edge", EdgA: "Edge" };
  return `${dev} · ${names[br] || br}`;
}

async function ringkasan(body) {
  const [o, overdue, errors, live, trends] = await Promise.all([
    rpc("admin_overview"), rpc("admin_overdue_events"),
    rpc("admin_client_errors", { p_limit: 20 }), rpc("admin_live_events"),
    rpc("admin_trends", { p_days: 30 }).catch(() => []),
  ]);
  // Dua tempat penyimpanan, masing-masing dengan kuotanya. Foto baru masuk ke yang aktif.
  const MB = 1024 * 1024;
  const r2Active = o.storage_backend === "r2";
  const sb = { name: "Supabase Storage", used: Number(o.photo_bytes) + Number(o.cover_bytes) + Number(o.voice_bytes || 0),
    quota: Number(o.storage_quota_mb || 1024) * MB, active: !r2Active };
  const r2 = { name: "Cloudflare R2", used: Number(o.r2_bytes || 0), quota: Number(o.r2_quota_mb || 10240) * MB, active: r2Active };
  for (const x of [sb, r2]) x.pct = Math.min(100, (x.used / x.quota) * 100);
  const act = r2Active ? r2 : sb;
  const photoBytes = Number(o.photo_bytes) + Number(o.r2_bytes || 0);
  const avg = o.photos ? photoBytes / o.photos : 0;
  const left = avg ? Math.max(0, Math.floor((act.quota - act.used) / avg)) : null;
  const showR2 = r2Active || Number(o.r2_files) > 0;

  // Hal yang perlu ditindak, urut dari yang paling mendesak
  const items = [];
  for (const x of showR2 ? [sb, r2] : [sb]) {
    if (x.pct <= 85) continue;
    items.push([`${x.name} terpakai ${x.pct.toFixed(0)}%`,
      x.active
        ? (left !== null ? `Cukup untuk sekitar ${left.toLocaleString("id-ID")} foto lagi. Turunkan resolusi, hapus acara lama, atau naikkan kuota.` : "Turunkan resolusi, hapus acara lama, atau naikkan kuota.")
        : "Foto baru tidak lagi disimpan di sini. Pindahkan foto lama atau hapus acara lama.",
      `<a class="btn small" href="#/admin/pengaturan">Pengaturan</a>`]);
  }
  const meter = (x) => `
        <div class="storage-row${x.active ? " active" : ""}">
          <div class="storage-head"><b>${x.name}</b>${x.active ? `<span class="tag ok">foto baru di sini</span>` : ""}
            <span>${fmtBytes(x.used)} dari ${fmtBytes(x.quota)} (${x.pct.toFixed(1)}%)</span></div>
          <div class="meter" role="img" aria-label="${x.name} terpakai ${x.pct.toFixed(0)} persen"><span style="width:${x.pct.toFixed(1)}%" class="${x.pct > 85 ? "hot" : ""}"></span></div>
        </div>`;
  // Kapasitas: meter yang melewati 75% (sekarang atau perkiraan), status pembuatan acara
  const MODE_TEXT = { limited: "dibatasi (hanya acara kecil)", closed: "ditutup" };
  const modeNote = o.creation_mode && o.creation_mode !== "open"
    ? ` Pembuatan acara ${MODE_TEXT[o.creation_mode]}${o.creation_mode_auto ? " otomatis" : ""}.` : "";
  let capItems = 0;
  if (o.capacity && o.capacity_warn) for (const m of o.capacity.meters) {
    const peak = Math.max(Number(m.pct) || 0, Number(m.proj_pct) || 0);
    if (peak < 75) continue;
    capItems++;
    items.push([`${METERS[m.key]?.name || m.key} ${Number(m.pct).toFixed(0)}%`,
      `Perkiraan ${Number(m.proj_pct).toFixed(0)}% setelah acara terjadwal.${modeNote}`,
      `<a class="btn small" href="#/admin/pembuatan">Kapasitas</a>`, peak >= 90 ? "crit" : "mid"]);
  }
  if (!capItems && modeNote) items.push([`Pembuatan acara ${MODE_TEXT[o.creation_mode]}`,
    "Acara yang ada tetap berjalan. Buka lagi dari halaman Pembuatan acara bila kapasitas sudah cukup.",
    `<a class="btn small" href="#/admin/pembuatan">Pembuatan acara</a>`, "info"]);
  if (o.events_review > 0) items.push([`${o.events_review} acara besar perlu ditinjau`,
    "Pastikan kapasitas pada tanggalnya sebelum acara aktif.",
    `<a class="btn small" href="#/admin/pembuatan">Tinjau</a>`, "mid"]);
  if (o.reports_open > 0) items.push([`${o.reports_open} foto dilaporkan tamu`,
    "Tinjau dan sembunyikan bila perlu. Foto otomatis disembunyikan setelah tiga laporan.",
    `<a class="btn small" href="#/admin/moderasi">Moderasi</a>`]);
  if (o.data_requests_open > 0) items.push([`${o.data_requests_open} permintaan hapus data`,
    "Permintaan dari pengguna (UU PDP). Proses atau tolak dengan alasan.",
    `<a class="btn small" href="#/admin/privasi">Privasi</a>`]);
  if (o.creator_requests_open > 0) items.push([`${o.creator_requests_open} pengajuan pembuat acara`,
    "Hubungi lewat WhatsApp bila perlu, lalu setujui atau tolak dengan alasan.",
    `<a class="btn small" href="#/admin/pengguna">Tinjau</a>`]);
  if (overdue.length) items.push([`${overdue.length} acara lewat tanggal hapus`,
    overdue.slice(0, 3).map((e) => e.name).join(", ") + (overdue.length > 3 ? ", …" : ""),
    `<button class="btn small danger" data-act="purge">Hapus sekarang</button>`]);
  if (o.stuck_pending > 0) items.push([`${o.stuck_pending} foto tertahan lebih dari 1 jam`,
    "Biasanya HP peserta kehilangan sinyal. Jika peserta sudah pulang, lepas dari Panel acara → Peserta.",
    `<a class="btn small" href="#/admin/acara">Lihat acara</a>`]);
  if (o.camera_errors_24h >= 5) items.push([`${o.camera_errors_24h} kegagalan kamera dalam 24 jam`,
    "Cek jenis masalah, perangkat, dan browsernya di daftar bawah.",
    `<button class="btn small" data-act="to-errors">Lihat daftar</button>`]);
  if (o.creators_at_limit > 0) items.push([`${o.creators_at_limit} pembuat acara mencapai batas acara`,
    "Mereka tidak bisa membuat acara baru sampai batasnya ditambah.",
    `<a class="btn small" href="#/admin/pengguna">Pengguna & peran</a>`]);

  const view = el(`
    <div>
      ${items.length ? `
      <div class="card attention">
        <h3>Perlu perhatian</h3>
        <ul class="attention-list">${items.map(([t, s, a, lv]) => {
          // Tingkat: kritis (laporan, permintaan data), sedang (tertahan, kamera, tanggal hapus, storage), info
          const LV = { crit: ["crit", "Kritis"], mid: ["mid", "Sedang"], info: ["info", "Info"] };
          const lvl = lv ? LV[lv] : /dilaporkan|hapus data/.test(t) ? LV.crit : /batas acara/.test(t) ? LV.info : LV.mid;
          return `<li class="att-${lvl[0]}"><span class="att-tag">${lvl[1]}</span><div><b>${esc(t)}</b><small>${esc(s)}</small></div>${a}</li>`;
        }).join("")}</ul>
      </div>` : `
      <div class="card all-good"><b>Semua aman.</b> Tidak ada yang perlu ditindak saat ini.</div>`}

      ${live.length ? `
      <div class="card">
        <h3><span class="live-dot" aria-hidden="true"></span>Sedang berlangsung</h3>
        <div class="live-list">${live.map((e) => `
          <div class="live-item">
            <div><b>${esc(e.name)}</b><small>${esc(e.owner_name)} · ${e.photos_hour} foto dalam 1 jam · film habis ${e.rolls_done}/${e.members} · terakhir ${esc(fmtDate(e.last_photo_at))}</small></div>
            <a class="btn small" href="#/e/${e.event_id}/panel">Kelola</a>
          </div>`).join("")}</div>
      </div>` : ""}

      <div class="stats">
        ${stat("Pengguna", o.users, o.banned ? `${o.banned} diblokir` : "")}
        ${stat("Acara", o.events, `${o.events_open} terbuka`)}
        ${stat("Foto", o.photos, o.pending ? `${o.pending} belum terunggah` : "")}
        ${stat("Unduhan", o.downloads, "")}
        ${stat("Pembuat acara", o.creators, `${o.superadmins} superadmin`)}
        ${stat("Gagal kamera", o.camera_errors_24h, "24 jam terakhir")}
      </div>

      ${trends.length ? `
      <div class="card trends-card">
        <h3>Tren ${trends.length} hari terakhir</h3>
        <p class="hint">Dari data yang masih tersimpan; acara yang sudah dihapus tidak terhitung. Arahkan kursor atau ketuk batang untuk angka per hari.</p>
        <div class="trend-grid"></div>
        <details class="trend-table"><summary>Lihat sebagai tabel</summary>
          <div class="table-scroll"><table>
            <thead><tr><th>Tanggal</th><th class="num">Foto</th><th class="num">Acara aktif</th><th class="num">Pengguna baru</th><th class="num">Storage baru</th></tr></thead>
            <tbody>${[...trends].reverse().map((r) => `<tr><td>${esc(fmtDay(r.day))}</td><td class="num">${r.photos}</td><td class="num">${r.active_events}</td><td class="num">${r.users}</td><td class="num">${fmtBytes(r.bytes)}</td></tr>`).join("")}</tbody>
          </table></div>
        </details>
      </div>` : ""}

      ${o.members_total !== undefined ? `
      <div class="card">
        <h3>Perjalanan peserta, semua acara</h3>
        <div class="funnel">
          ${funnelRow("Masuk", o.members_total, Math.max(o.members_total, 1))}
          ${funnelRow("Memotret", o.shooters_total, Math.max(o.members_total, 1))}
          ${funnelRow("Film habis", o.rolls_total, Math.max(o.members_total, 1), "mint")}
          ${funnelRow("Mengunduh", o.downloaders_total, Math.max(o.members_total, 1))}
        </div>
      </div>` : ""}

      <div class="card">
        <h3>Storage</h3>
        ${meter(sb)}
        <p class="hint">Foto ${fmtBytes(o.photo_bytes)}, sampul ${fmtBytes(o.cover_bytes)}${Number(o.voice_bytes) ? `, rekaman suara ${fmtBytes(o.voice_bytes)}` : ""}</p>
        ${showR2 ? `${meter(r2)}<p class="hint">${Number(o.r2_files || 0).toLocaleString("id-ID")} file foto</p>` : ""}
        ${left !== null ? `<p class="hint">Rata-rata ${fmtBytes(avg)} per foto (3 ukuran). Sisa di ${act.name} cukup untuk sekitar <b>${left.toLocaleString("id-ID")}</b> foto lagi.</p>` : ""}
      </div>

      <div class="card errors-card">
        <h3>Kegagalan kamera terbaru</h3>
        ${errors.length ? `
        <div class="table-scroll"><table class="stack">
          <thead><tr><th>Waktu</th><th>Masalah</th><th>Peserta · acara</th><th>Perangkat</th></tr></thead>
          <tbody>${errors.map((r) => `
            <tr>
              <td data-label="Waktu"><small>${esc(fmtDate(r.at))}</small></td>
              <td><b>${esc(ERROR_KINDS[r.kind] || r.kind)}</b>${r.detail ? `<details><summary>Detail</summary><code>${esc(r.detail)}</code></details>` : ""}</td>
              <td data-label="Peserta"><small>${esc(r.user_name || "-")}<br>${esc(r.event_name || "-")}</small></td>
              <td data-label="Perangkat"><small>${esc(shortUA(r.ua))}</small></td>
            </tr>`).join("")}
          </tbody>
        </table></div>` : `<p class="hint">Belum ada laporan. Laporan dikirim otomatis saat kamera peserta gagal dibuka atau menampilkan gambar hitam.</p>`}
      </div>
    </div>`);
  body.replaceChildren(view);
  const grid = view.querySelector(".trend-grid");
  if (grid) {
    grid.append(
      trendChart("Foto masuk per hari", trends, "photos", (v) => `${v} foto`),
      trendChart("Acara aktif per hari", trends, "active_events", (v) => `${v} acara`),
      trendChart("Pengguna baru per hari", trends, "users", (v) => `${v} pengguna`),
      trendChart("Storage bertambah per hari", trends, "bytes", (v) => fmtBytes(v)),
    );
  }
  view.querySelector('[data-act="to-errors"]')?.addEventListener("click", () =>
    view.querySelector(".errors-card").scrollIntoView({ block: "start" }));
  const purge = view.querySelector('[data-act="purge"]');
  if (purge) purge.onclick = async () => {
    const ok = await typeToConfirm({
      title: `Hapus ${overdue.length} acara?`,
      text: "Semua foto dan data acara yang sudah lewat tanggal hapus akan dihapus permanen.",
      expect: "HAPUS", ok: "Hapus semua",
    });
    if (!ok) return;
    purge.disabled = true;
    let n = 0;
    for (const e of overdue) {
      try { await deleteEventFully(e.event_id, e.cover_path); n++; }
      catch (err) { toast(friendly(err)); }
    }
    toast(`${n} acara dihapus.`);
    ringkasan(body);
  };
}

// ---------- Grafik tren: batang satu seri per metrik (small multiples) ----------
const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short" });

export function trendChart(title, rows, key, fmt) {
  const vals = rows.map((r) => Number(r[key]) || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  const max = Math.max(...vals, 1);
  const W = 300, H = 96, top = 6, base = H - 2;
  const slot = W / vals.length, bw = Math.min(24, Math.max(2, slot - 2)); // 2px celah antarbatang
  const r = Math.min(4, bw / 2);
  // Batang dengan ujung atas membulat dan dasar persegi
  const bar = (i, v) => {
    const h = v ? Math.max(2, ((base - top) * v) / max) : 0;
    if (!h) return "";
    const x = i * slot + (slot - bw) / 2, y = base - h, rr = Math.min(r, h);
    return `<path class="tc-bar" data-i="${i}" d="M${x},${base}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + bw - rr}Q${x + bw},${y} ${x + bw},${y + rr}V${base}Z"/>`;
  };
  const sumText = key === "bytes" ? fmtBytes(total) : total.toLocaleString("id-ID");
  const n = el(`
    <figure class="trend">
      <figcaption><span>${esc(title)}</span><b>${esc(sumText)}</b></figcaption>
      <div class="tc-plot">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: total ${esc(sumText)} dalam ${vals.length} hari, tertinggi ${esc(fmt(max))}">
          <line class="tc-grid" x1="0" x2="${W}" y1="${top}" y2="${top}"/>
          <line class="tc-axis" x1="0" x2="${W}" y1="${base}" y2="${base}"/>
          ${vals.map((v, i) => bar(i, v)).join("")}
        </svg>
        <span class="tc-max">${esc(fmt(max))}</span>
        <div class="tc-tip" hidden></div>
      </div>
      <div class="tc-x"><span>${esc(fmtDay(rows[0].day))}</span><span>${esc(fmtDay(rows[rows.length - 1].day))}</span></div>
    </figure>`);
  // Hover/ketuk: area sasaran selebar slot (lebih besar dari batangnya)
  const plot = n.querySelector(".tc-plot"), tip = n.querySelector(".tc-tip"), svgEl = n.querySelector("svg");
  const showAt = (clientX) => {
    const rect = svgEl.getBoundingClientRect();
    const i = Math.max(0, Math.min(vals.length - 1, Math.floor(((clientX - rect.left) / rect.width) * vals.length)));
    n.querySelectorAll(".tc-bar").forEach((b) => b.classList.toggle("dim", Number(b.dataset.i) !== i));
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(fmt(vals[i]))}</b><span>${esc(fmtDay(rows[i].day))}</span>`;
    const x = ((i + 0.5) / vals.length) * rect.width;
    tip.style.left = `${Math.max(40, Math.min(rect.width - 40, x))}px`;
  };
  plot.addEventListener("pointermove", (e) => showAt(e.clientX));
  plot.addEventListener("pointerdown", (e) => showAt(e.clientX));
  plot.addEventListener("pointerleave", () => { tip.hidden = true; n.querySelectorAll(".tc-bar.dim").forEach((b) => b.classList.remove("dim")); });
  return n;
}

// ---------- Moderasi: laporan foto dari semua acara ----------
async function moderasi(body) {
  const view = el(`
    <div>
      <div class="card">
        <h3 class="with-icon">${ICON.shield}<span>Laporan foto</span></h3>
        <p class="hint">Laporan dari tamu di semua acara, dikelompokkan per foto. Pemilik acara juga melihat laporan acaranya di Panel → Album. Foto otomatis disembunyikan setelah tiga laporan dari orang berbeda.</p>
        <div class="report-list"><p class="hint">Memuat…</p></div>
      </div>
    </div>`);
  body.replaceChildren(view);
  const rows = await rpc("list_reports", { p_event: null });
  await renderReports(view.querySelector(".report-list"), rows, { showEvent: true });
}

// ---------- Privasi: permintaan hapus data (UU PDP) ----------
const KIND = { photos: "Hapus foto di satu acara", account: "Hapus akun" };
async function privasi(body) {
  const st = { status: "open" };
  const view = el(`
    <div>
      <div class="card">
        <h3 class="with-icon">${ICON.shield}<span>Permintaan hapus data</span></h3>
        <p class="hint">Dikirim pengguna dari beranda (Data & privasi). Proses menghapus file dan data terkait secara permanen; tolak bila perlu dengan alasan yang terlihat oleh pengguna.</p>
        <div class="filter-slot"></div>
        <div class="req-list" style="margin-top:.75rem"><p class="hint">Memuat…</p></div>
      </div>
    </div>`);
  body.replaceChildren(view);
  const list = view.querySelector(".req-list");
  view.querySelector(".filter-slot").append(chips([["open", "Menunggu"], ["done", "Selesai"], ["rejected", "Ditolak"], ["all", "Semua"]],
    st.status, (v) => { st.status = v; load(); }, "Saring permintaan"));

  async function process(r) {
    const account = r.kind === "account";
    if (account && r.owned_events) {
      await confirmDialog({ title: "Akun ini masih memiliki acara", text: `${r.user_name || r.email} memiliki ${r.owned_events} acara. Hapus acaranya dulu dari tab Acara, atau tolak permintaan dengan alasan.`, ok: "Mengerti", cancel: "Tutup" });
      return;
    }
    const ok = await typeToConfirm({
      title: account ? `Hapus akun ${r.email}?` : `Hapus foto ${r.user_name || r.email}?`,
      text: account ? `Akun, ${r.photos} foto, unduhan, favorit, dan ucapannya dihapus permanen.`
                    : `${r.photos} foto dan ucapannya di acara “${r.event_name}” dihapus permanen.`,
      expect: "HAPUS", ok: "Hapus permanen",
    });
    if (!ok) return;
    try {
      const paths = await rpc("admin_request_paths", { p_request: r.id });
      const photos = paths.filter((x) => x.bucket === "photos").map((x) => x.path);
      const voices = paths.filter((x) => x.bucket === "voices").map((x) => x.path);
      if (photos.length) await removeFiles(photos);
      if (voices.length) await removeVoices(voices).catch(() => {});
      await rpc("admin_process_request", { p_request: r.id, p_action: "done", p_reply: account ? "Akun dan data Anda sudah dihapus." : "Foto Anda sudah dihapus." });
      toast("Permintaan selesai diproses.");
      load();
    } catch (e) { toast(friendly(e)); }
  }
  async function reject(r) {
    const { box, close } = modal(`
      <form class="dialog">
        <h3>Tolak permintaan</h3>
        <p>${esc(r.email || "")} · ${esc(KIND[r.kind])}</p>
        <label>Alasan (terlihat oleh pengguna) <textarea name="reply" rows="3" maxlength="300" required></textarea></label>
        <div class="dialog-actions"><button type="button" class="btn ghost" data-act="no">Batal</button><button class="btn primary">Tolak</button></div>
      </form>`);
    box.querySelector('[data-act="no"]').onclick = close;
    box.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      try { await rpc("admin_process_request", { p_request: r.id, p_action: "reject", p_reply: e.target.elements.reply.value }); close(); load(); }
      catch (err) { toast(friendly(err)); }
    };
  }
  async function load() {
    let rows;
    try { rows = await rpc("admin_data_requests", { p_status: st.status }); }
    catch (e) { list.replaceChildren(el(`<p class="hint">${esc(friendly(e))}</p>`)); return; }
    if (!rows.length) { list.replaceChildren(el(`<p class="hint">Tidak ada permintaan.</p>`)); return; }
    list.replaceChildren(...rows.map((r) => {
      const n = el(`
        <article class="report-item">
          <div class="report-main">
            <b>${esc(KIND[r.kind])}${r.event_name ? ` · ${esc(r.event_name)}` : ""}</b>
            <small>${esc(r.user_name || "akun terhapus")} · ${esc(r.email || "")} · ${esc(fmtDate(r.created_at))}</small>
            <small>${r.photos} foto${r.kind === "account" ? ` · memiliki ${r.owned_events} acara` : ""}</small>
            ${r.note ? `<p class="report-notes">“${esc(r.note)}”</p>` : ""}
            ${r.status !== "open" ? `<small><span class="tag ${r.status === "done" ? "ok" : "bad"}">${r.status === "done" ? "Selesai" : "Ditolak"}</span> ${esc(fmtDate(r.done_at))}${r.reply ? ` · ${esc(r.reply)}` : ""}</small>` : `
            <div class="row tight wrap">
              <button class="btn small danger" data-a="done">Proses (hapus permanen)</button>
              <button class="btn small ghost" data-a="reject">Tolak…</button>
            </div>`}
          </div>
        </article>`);
      n.querySelector('[data-a="done"]')?.addEventListener("click", () => process(r));
      n.querySelector('[data-a="reject"]')?.addEventListener("click", () => reject(r));
      return n;
    }));
  }
  await load();
}

// ---------- Pembuatan acara: status Buka / Hanya acara kecil / Tutup, kapasitas, antrean ----------
// Status hanya menahan acara BARU (dan penambahan tamu/roll). Acara yang sudah dibuat atau
// berlangsung, tamu yang bergabung, dan jepretan tidak pernah dihentikan olehnya.
const CREATION_MODES = {
  open:    { label: "Buka",        title: "Menerima semua acara", badge: "Terbuka",  tone: "open",
             desc: "Semua akun pembuat acara bisa membuat acara sesuai batas global dan kuotanya." },
  limited: { label: "Hanya kecil", title: "Hanya acara kecil",    badge: "Dibatasi", tone: "limited",
             desc: "Akun tetap bisa membuat acara sampai batas tamu dan roll di bawah. Di atas itu wizard menolak dengan keterangan." },
  closed:  { label: "Tutup",       title: "Pembuatan acara ditutup", badge: "Ditutup", tone: "closed",
             desc: "Tidak ada acara baru yang bisa dibuat, dan tamu atau roll acara yang ada tidak bisa ditambah. Pesan di bawah ditampilkan ke penyelenggara." },
};
const METERS = {
  storage:   { name: "Storage foto (anggaran)", bytes: true, note: "Supabase Storage + R2, dibagi anggaran yang Anda tetapkan" },
  database:  { name: "Database", bytes: true, note: "Batas paket Supabase (Pro 8 GB)" },
  mau:       { name: "Pengguna aktif 30 hari", note: "MAU paket Supabase (Pro 100.000)" },
  r2_writes: { name: "Operasi tulis R2 bulan ini", note: "Gratis sampai 1 juta per bulan; tiap foto = 3 operasi" },
  worker:    { name: "Request Worker bulan ini", note: "Perkiraan: foto bulan ini × request per foto. Workers Paid termasuk 10 juta, lalu US$0,30 per juta" },
  realtime:  { name: "Koneksi realtime puncak", note: "Perkiraan: 60% peserta acara terbuka sampai 300 tamu; puncak = hari terjadwal terpadat" },
};
const capLevel = (m) => {
  const p = Math.max(Number(m.pct) || 0, Number(m.proj_pct) || 0);
  return p >= 90 ? ["Kritis", "bad"] : p >= 75 ? ["Waspada", "warn"] : ["Aman", "ok"];
};
const fmtNum = (n) => Number(n).toLocaleString("id-ID", { maximumFractionDigits: 0 });
const fmtMeter = (key, v) => (METERS[key]?.bytes ? fmtBytes(Number(v)) : fmtNum(v));

async function pembuatan(body) {
  try { await rpc("capacity_tick"); } catch { /* jadwal buka lagi tetap dihitung di creation_state */ }
  const c = await rpc("admin_capacity");
  const st = { mode: c.mode, filter: "all" };
  const auto = c.mode_auto ? " Dipasang otomatis oleh pengaman kapasitas." : "";

  const view = el(`
    <div class="creation">
      <section class="card mode-card" aria-labelledby="h-mode">
        <div class="mode-top">
          <div class="mode-text">
            <span class="mode-badge"></span>
            <h2 id="h-mode" class="mode-title"></h2>
            <p class="mode-desc"></p>
          </div>
          <div class="mode-radios" role="radiogroup" aria-label="Status pembuatan acara">
            ${Object.entries(CREATION_MODES).map(([id, m]) => `<button type="button" role="radio" data-mode="${id}">${m.label}</button>`).join("")}
          </div>
        </div>
        <div class="date-row mode-limited">
          <label>Maks. tamu per acara baru<input type="number" name="max_guests" min="1" max="5000" value="${c.max_guests}" /></label>
          <label>Maks. roll per tamu<input type="number" name="max_shots" min="1" max="500" value="${c.max_shots}" /></label>
        </div>
        <div class="mode-closed">
          <label>Pesan untuk penyelenggara<input type="text" name="message" maxlength="300" placeholder="Kapasitas penuh untuk minggu ini. Kami buka lagi Senin." value="${esc(c.message || "")}" /></label>
          <label>Buka lagi otomatis (opsional)<input type="datetime-local" name="reopen_at" value="${c.reopen_at ? toLocalInput(c.reopen_at) : ""}" /></label>
        </div>
        <div class="row tight wrap mode-actions">
          <button type="button" class="btn primary" data-act="save-mode">Simpan status</button>
          <span class="hint">${c.waitlist ? `${fmtNum(c.waitlist)} akun menunggu kabar "dibuka lagi".` : ""}</span>
        </div>
        <p class="hint">Acara yang sudah dibuat atau sedang berlangsung tidak terpengaruh. Tamu tetap bisa bergabung dan memotret.</p>
      </section>

      <section class="card" aria-labelledby="h-cap">
        <div class="sec-head">
          <h2 id="h-cap">Kapasitas sistem</h2>
          <span class="hint">Diperbarui ${esc(fmtDate(c.at))} · termasuk ${fmtNum(c.scheduled_events)} acara terjadwal 30 hari ke depan (${fmtNum(c.scheduled_photos)} foto perkiraan)</span>
        </div>
        <div class="cap-grid">${c.meters.map((m) => {
          const meta = METERS[m.key] || { name: m.key, note: "" };
          const [lv, tone] = capLevel(m);
          const pct = Math.min(100, Number(m.pct) || 0), proj = Math.min(100, Number(m.proj_pct) || 0);
          return `
          <div class="cap-card ${tone}">
            <div class="cap-head"><b>${esc(meta.name)}${m.estimate ? ` <small class="est">perkiraan</small>` : ""}</b><span class="tag ${tone}">${lv}</span></div>
            <span class="cap-val">${fmtMeter(m.key, m.used)} <small>/ ${fmtMeter(m.key, m.cap)}</small></span>
            <div class="cap-bar" role="img" aria-label="${esc(meta.name)}: ${pct.toFixed(0)}% terpakai, perkiraan ${proj.toFixed(0)}%">
              <span class="now" style="width:${pct}%"></span><span class="proj" style="left:${pct}%;width:${Math.max(0, proj - pct)}%"></span>
            </div>
            <small>${pct.toFixed(0)}% sekarang · ${proj.toFixed(0)}% perkiraan. ${esc(meta.note)}</small>
          </div>`;
        }).join("")}</div>
        <div class="cap-legend">
          <span><i class="now"></i>Terpakai sekarang</span>
          <span><i class="proj"></i>Perkiraan setelah acara terjadwal</span>
          <span>Waspada mulai 75%, kritis mulai 90%</span>
        </div>
        <p class="hint">Request Worker dan koneksi realtime tidak tercatat di database, jadi meternya dihitung dari model (bertanda "perkiraan"); angka pastinya ada di dasbor Cloudflare dan Supabase. Album acara di atas 300 tamu memakai polling, bukan realtime.</p>
        <details class="advanced">
          <summary>Anggaran kapasitas</summary>
          <form class="settings cap-settings">
            <div class="date-row">
              <label>Anggaran storage (GB)<input type="number" name="capacity_storage_gb" min="1" max="1000000" value="${c.settings.capacity_storage_gb}" /></label>
              <label>Batas database (GB)<input type="number" name="capacity_db_gb" min="1" max="100000" value="${c.settings.capacity_db_gb}" /></label>
            </div>
            <div class="date-row">
              <label>Batas MAU<input type="number" name="capacity_mau" min="100" max="100000000" value="${c.settings.capacity_mau}" /></label>
              <label>Operasi tulis R2 per bulan<input type="number" name="capacity_r2_writes" min="1000" max="2000000000" value="${c.settings.capacity_r2_writes}" /></label>
            </div>
            <div class="date-row">
              <label>Rata-rata ukuran foto (MB, 3 ukuran)<input type="number" name="photo_mb_estimate" min="0.1" max="50" step="0.01" value="${c.settings.photo_mb_estimate}" /></label>
              <label>Tinjau acara mulai (tamu)<input type="number" name="review_guests" min="1" max="5000" value="${c.settings.review_guests}" /></label>
            </div>
            <div class="date-row">
              <label>Batas koneksi realtime<input type="number" name="capacity_realtime" min="10" max="1000000" value="${c.settings.capacity_realtime}" /></label>
              <label>Request Worker per bulan<input type="number" name="capacity_worker_req" min="100000" max="100000000000" value="${c.settings.capacity_worker_req}" /></label>
            </div>
            <label>Request Worker per foto (model)<input type="number" name="worker_req_per_photo" min="1" max="10000" value="${c.settings.worker_req_per_photo}" /></label>
            <p class="hint">Perkiraan per acara = tamu × roll × 70% × ukuran foto. Acara juga masuk "Perlu ditinjau" bila perkiraannya lebih dari 5% anggaran storage.</p>
            <button class="btn small" type="submit">Simpan anggaran</button>
          </form>
        </details>
      </section>

      <section class="card" aria-labelledby="h-auto">
        <h2 id="h-auto">Pengaman otomatis</h2>
        <div class="auto-rules">${[
          ["capacity_auto_warn", "Peringatan ke superadmin", "Tampilkan di Perlu perhatian pada Ringkasan saat satu batas melewati 75%."],
          ["capacity_auto_limit", "Batasi otomatis di 85%", 'Ganti ke "Hanya acara kecil" saat perkiraan pemakaian melewati 85%.'],
          ["capacity_auto_close", "Tutup otomatis di 95%", "Hentikan pembuatan acara saat perkiraan pemakaian melewati 95%."],
        ].map(([k, name, desc]) => `
          <div class="auto-rule">
            <span><b>${name}</b><small>${desc}</small></span>
            <button type="button" class="switch bare" role="switch" data-rule="${k}" aria-checked="${Boolean(c.settings[k])}" aria-label="${name}"><span class="knob"></span></button>
          </div>`).join("")}</div>
        <p class="hint">Diperiksa tiap 5 menit oleh jadwal <code>pengaman-kapasitas</code> (supabase/cron.sql) dan setiap halaman ini dibuka. Pengaman tidak pernah membuka lagi pembuatan acara sendiri; gunakan jadwal buka lagi.</p>
      </section>

      <section class="card" aria-labelledby="h-queue">
        <div class="sec-head">
          <h2 id="h-queue">Acara baru dan terjadwal</h2>
        </div>
        <div class="queue-filter"></div>
        <div class="table-scroll"><table class="queue-table">
          <thead><tr><th>Acara</th><th>Tanggal</th><th class="num">Tamu × roll</th><th class="num">Perkiraan storage</th><th>Status</th><th><span class="sr-only">Aksi</span></th></tr></thead>
          <tbody></tbody>
        </table></div>
      </section>
    </div>`);
  body.replaceChildren(view);
  const f = (n) => view.querySelector(`[name="${n}"]`);

  function showMode() {
    const m = CREATION_MODES[st.mode];
    const card = view.querySelector(".mode-card");
    card.dataset.tone = m.tone;
    view.querySelector(".mode-badge").textContent = m.badge;
    view.querySelector(".mode-title").textContent = m.title;
    view.querySelector(".mode-desc").textContent = m.desc + (st.mode === c.mode ? auto : "");
    view.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === st.mode)));
    view.querySelector(".mode-limited").hidden = st.mode !== "limited";
    view.querySelector(".mode-closed").hidden = st.mode !== "closed";
  }
  view.querySelector(".mode-radios").onclick = (e) => {
    const b = e.target.closest("[data-mode]"); if (!b) return;
    st.mode = b.dataset.mode; showMode();
  };
  view.querySelector(".mode-radios").onkeydown = (e) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const ids = Object.keys(CREATION_MODES), d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : ids.length - 1;
    st.mode = ids[(ids.indexOf(st.mode) + d) % ids.length]; showMode();
    view.querySelector(`[data-mode="${st.mode}"]`).focus();
  };
  showMode();

  view.querySelector('[data-act="save-mode"]').onclick = async (e) => {
    const reopen = st.mode === "closed" ? fromLocalInput(f("reopen_at").value) : null;
    if (st.mode === "closed" && c.mode !== "closed") {
      const yes = await confirmDialog({
        title: "Tutup pembuatan acara baru?",
        text: "Tombol Buat acara diganti pesan penutupan untuk semua pembuat acara. Acara yang sudah ada tetap berjalan normal, tetapi tamu dan roll-nya tidak bisa ditambah. Akun yang menekan \"Kabari saya\" mendapat notifikasi saat dibuka lagi.",
        ok: "Ya, tutup sekarang", danger: true,
      });
      if (!yes) return;
    }
    e.currentTarget.disabled = true;
    try {
      await rpc("set_creation_mode", {
        p_mode: st.mode,
        p_message: st.mode === "closed" ? f("message").value : (st.mode === "limited" ? c.message : null),
        p_reopen_at: reopen,
        p_max_guests: st.mode === "limited" ? Number(f("max_guests").value) : null,
        p_max_shots: st.mode === "limited" ? Number(f("max_shots").value) : null,
      });
      // Dibuka lagi: kabari daftar tunggu lewat Edge Function notify-album
      if (st.mode === "open" && c.mode !== "open") kickNotify(true);
      toast("Status pembuatan acara disimpan.");
      pembuatan(body);
    } catch (err) { toast(friendly(err)); e.currentTarget.disabled = false; }
  };

  view.querySelector(".cap-settings").onsubmit = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const k of ["capacity_storage_gb", "capacity_db_gb", "capacity_mau", "capacity_r2_writes", "review_guests",
      "capacity_realtime", "capacity_worker_req", "worker_req_per_photo"]) patch[k] = Number(f(k).value);
    patch.photo_mb_estimate = Number(f("photo_mb_estimate").value);
    try { await rpc("admin_set_settings", { p_patch: patch }); toast("Anggaran disimpan."); pembuatan(body); }
    catch (err) { toast(friendly(err)); }
  };

  view.querySelector(".auto-rules").onclick = async (e) => {
    const b = e.target.closest("[data-rule]"); if (!b) return;
    const on = b.getAttribute("aria-checked") !== "true";
    b.setAttribute("aria-checked", String(on));
    try { await rpc("admin_set_settings", { p_patch: { [b.dataset.rule]: on } }); }
    catch (err) { b.setAttribute("aria-checked", String(!on)); toast(friendly(err)); }
  };

  // Antrean: acara yang perlu ditinjau dulu, lalu yang terjadwal
  const tbody = view.querySelector(".queue-table tbody");
  const statusOf = (q) => q.needs_review ? ["Perlu ditinjau", "warn"]
    : q.is_open ? ["Terbuka", "ok"]
    : q.starts_at && new Date(q.starts_at) > new Date() ? ["Terjadwal", ""]
    : ["Selesai", ""];
  function renderQueue() {
    const rows = c.queue.filter((q) => st.filter === "all" || (st.filter === "review" ? q.needs_review : !q.needs_review && q.starts_at && new Date(q.starts_at) > new Date()));
    tbody.innerHTML = rows.length ? rows.map((q) => {
      const [label, tone] = statusOf(q);
      return `<tr>
        <td><b>${esc(q.name)}</b><br><small class="hint">${esc(q.owner_name || "")}${q.photos ? ` · ${fmtNum(q.photos)} foto` : ""}</small></td>
        <td>${q.starts_at ? esc(fmtDate(q.starts_at)) : "<span class=\"hint\">Belum berjadwal</span>"}</td>
        <td class="num">${fmtNum(q.max_members)} × ${q.max_shots}</td>
        <td class="num">${fmtBytes(Number(q.est_bytes))}</td>
        <td><span class="tag ${tone}">${label}</span></td>
        <td class="row tight">
          ${q.needs_review ? `<button type="button" class="btn small primary" data-review="${q.id}">Tandai sudah ditinjau</button>` : ""}
          <a class="btn small" href="#/e/${q.id}/panel">Kelola</a>
        </td></tr>`;
    }).join("") : `<tr><td colspan="6" class="hint">Tidak ada acara di daftar ini.</td></tr>`;
  }
  view.querySelector(".queue-filter").append(chips(
    [["all", "Semua"], ["review", `Perlu ditinjau (${c.queue.filter((q) => q.needs_review).length})`], ["scheduled", "Terjadwal"]],
    st.filter, (v) => { st.filter = v; renderQueue(); }, "Saring acara"));
  tbody.onclick = async (e) => {
    const b = e.target.closest("[data-review]"); if (!b) return;
    b.disabled = true;
    try {
      await rpc("review_event", { p_event: b.dataset.review });
      const q = c.queue.find((x) => x.id === b.dataset.review); if (q) q.needs_review = false;
      toast("Acara ditandai sudah ditinjau.");
      renderQueue();
    } catch (err) { toast(friendly(err)); b.disabled = false; }
  };
  renderQueue();
}

// ---------- Acara ----------
async function acara(body, me, role) {
  const admin = role === "superadmin";
  const st = { q: "", status: "all", sort: admin ? "created" : "activity", offset: 0 };
  const selected = new Set();
  const canCreate = await rpc("can_create_event").catch(() => false);

  const view = el(`
    <div>
      <div class="toolbar">
        <input type="search" placeholder="${admin ? "Cari nama acara, pemilik, email, atau kode" : "Cari nama acara atau kode"}" aria-label="Cari acara" />
        <select aria-label="Urutkan">
          <option value="created">Terbaru dibuat</option>
          <option value="activity">Aktivitas terakhir</option>
          <option value="date">Jadwal acara</option>
          <option value="photos">Foto terbanyak</option>
          <option value="members">Peserta terbanyak</option>
          ${admin ? `<option value="bytes">Ukuran terbesar</option>` : ""}
          <option value="name">Nama (A–Z)</option>
        </select>
        <button class="btn small" data-act="csv">${ICON.download} CSV</button>
        ${canCreate ? `<button class="btn small primary" data-act="create">${ICON.plus} Buat acara</button>` : ""}
      </div>
      <div class="filter-slot"></div>
      <div class="bulk-slot" style="margin-top:.75rem"></div>
      <div class="results" style="margin-top:.75rem"><p class="hint">Memuat…</p></div>
    </div>`);
  body.replaceChildren(view);
  const results = view.querySelector(".results");
  const search = view.querySelector('input[type="search"]');
  const sortSel = view.querySelector("select");
  sortSel.value = st.sort;
  // Tombol Buat acara pindah ke baris judul (kanan), seperti desain "Acara saya"
  const createBtn = view.querySelector('[data-act="create"]');
  if (createBtn) {
    createBtn.className = "btn primary";
    body.closest(".admin-shell")?.querySelector(".admin-title-actions")?.append(createBtn);
    createBtn.addEventListener("click", () => createEventDialog());
  }
  const sub = body.closest(".admin-shell")?.querySelector(".admin-sub");
  // Ekspor semua acara sesuai saringan sekarang (maks. 2.000 baris)
  view.querySelector('[data-act="csv"]').onclick = async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    try {
      const all = [];
      for (let off = 0; off < 2000; off += 200) {
        const part = await rpc("admin_events", { p_search: st.q || null, p_status: st.status, p_sort: st.sort, p_limit: 200, p_offset: off });
        all.push(...part);
        if (part.length < 200) break;
      }
      downloadCsv(`acara-${new Date().toISOString().slice(0, 10)}`, [
        ["name", "Acara"], ["owner_name", "Pemilik"], ["owner_email", "Email pemilik"], ["join_code", "Kode"],
        [(e) => (e.is_open ? "terbuka" : "ditutup"), "Status"], [(e) => fmtDate(e.starts_at), "Mulai"], [(e) => fmtDate(e.ends_at), "Selesai"],
        ["members", "Peserta"], ["max_members", "Maks. peserta"], ["shooters", "Memotret"], ["rolls_done", "Film habis"],
        ["downloaders", "Mengunduh"], ["photos", "Foto"], ["pending", "Tertahan"], [(e) => Math.round(Number(e.bytes) / 1048576), "Ukuran (MB)"],
        ["reports", "Laporan"], [(e) => fmtDate(e.created_at), "Dibuat"], [(e) => fmtDate(e.last_photo_at), "Foto terakhir"],
      ], all);
    } catch (e) { toast(friendly(e)); }
    finally { b.disabled = false; }
  };
  view.querySelector(".filter-slot").append(chips(
    [["all", "Semua"], ["live", "Berlangsung"], ["scheduled", "Terjadwal"], ["done", "Selesai"], ["reported", "Ada laporan"], ...(admin ? [["overdue", "Lewat tanggal hapus"]] : [])],
    st.status, (v) => { st.status = v; st.offset = 0; load(); }, "Saring status"));
  let timer;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { st.q = search.value.trim(); st.offset = 0; load(); }, 300); };
  sortSel.onchange = () => { st.sort = sortSel.value; st.offset = 0; load(); };

  let rows = [];
  async function load() {
    try {
      rows = await rpc("admin_events", { p_search: st.q || null, p_status: st.status, p_sort: st.sort, p_limit: PAGE, p_offset: st.offset });
    } catch (e) { results.replaceChildren(el(`<p class="hint">${esc(friendly(e))}</p>`)); return; }
    const total = rows[0]?.total_count ?? 0;
    if (sub) sub.textContent = `${Number(total)} acara · ${sortSel.selectedOptions[0]?.textContent.toLowerCase() || ""}`;
    if (!rows.length) {
      results.replaceChildren(el(`<p class="hint">${!st.q && st.status === "all"
        ? (canCreate ? "Belum ada acara. Ketuk Buat acara untuk memulai." : "Belum ada acara.")
        : "Tidak ada acara yang cocok."}</p>`));
      renderBulk();
      return;
    }
    results.replaceChildren(admin ? tableView() : cardView(), pagerEl(Number(total), st.offset, (o) => { st.offset = o; load(); }));
    renderBulk();
  }

  // Superadmin: tabel dengan pilihan untuk aksi massal
  function tableView() {
    const n = el(`
      <div class="card table-scroll" style="padding:.25rem .5rem">
        <table class="stack event-table">
          <thead><tr>
            <th class="pick"><input type="checkbox" data-pick-all aria-label="Pilih semua di halaman ini" /></th>
            <th>Acara</th><th>Status</th><th class="num">Peserta</th><th class="num">Film habis</th>
            <th class="num">Foto</th><th class="num">Ukuran</th><th>Aktivitas</th><th></th>
          </tr></thead>
          <tbody>${rows.map((e) => `
            <tr data-id="${e.event_id}" class="${selected.has(e.event_id) ? "selected" : ""}">
              <td class="pick"><input type="checkbox" data-pick="${e.event_id}" ${selected.has(e.event_id) ? "checked" : ""} aria-label="Pilih ${esc(e.name)}" /></td>
              <td><a href="#/e/${e.event_id}/panel"><b>${esc(e.name)}</b></a><br><small>${esc(e.owner_name)} · ${esc(e.owner_email || "")}</small>
                ${e.starts_at || e.ends_at ? `<br><small>${esc(fmtRange(e.starts_at, e.ends_at))}</small>` : ""}</td>
              <td><span class="tag ${e.is_open ? "ok" : ""}">${e.is_open ? "Terbuka" : "Ditutup"}</span>
                ${e.reports ? `<br><span class="tag warn">${e.reports} dilaporkan</span>` : ""}
                ${e.purge_at && new Date(e.purge_at) <= new Date() ? `<br><span class="tag bad">lewat tanggal hapus</span>` : ""}</td>
              <td class="num" data-label="Peserta">${e.members}/${e.max_members}</td>
              <td class="num" data-label="Film habis">${e.rolls_done}</td>
              <td class="num" data-label="Foto">${e.photos}${e.pending ? ` <small>(${e.pending} tertahan)</small>` : ""}</td>
              <td class="num" data-label="Ukuran">${fmtBytes(e.bytes)}</td>
              <td data-label="Aktivitas"><small>${esc(fmtDate(e.last_photo_at) || "-")}</small></td>
              <td class="actions"><button class="btn small ghost icon-btn" data-more="${e.event_id}" aria-label="Aksi untuk ${esc(e.name)}">⋯</button></td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`);
    const all = n.querySelector("[data-pick-all]");
    all.checked = rows.every((e) => selected.has(e.event_id));
    all.onchange = () => {
      rows.forEach((e) => (all.checked ? selected.add(e.event_id) : selected.delete(e.event_id)));
      n.querySelectorAll("[data-pick]").forEach((c) => { c.checked = all.checked; c.closest("tr").classList.toggle("selected", all.checked); });
      renderBulk();
    };
    n.querySelectorAll("[data-pick]").forEach((c) => (c.onchange = () => {
      if (c.checked) selected.add(c.dataset.pick); else selected.delete(c.dataset.pick);
      c.closest("tr").classList.toggle("selected", c.checked);
      all.checked = rows.every((e) => selected.has(e.event_id));
      renderBulk();
    }));
    n.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => eventMenu(rows.find((e) => e.event_id === b.dataset.more))));
    return n;
  }

  // Pembuat acara: kartu dengan status langsung
  function cardView() {
    const n = el(`<div class="event-cards">${rows.map((e) => `
      <article class="event-card" data-id="${e.event_id}">
        <div class="ec-cover"${e.cover_path ? ` style="background-image:url('${esc(coverUrl(e.cover_path))}')"` : ""}>
          ${statusBadge(e)}
          ${e.reports ? `<a class="ec-report" href="#/e/${e.event_id}/panel">${e.reports} dilaporkan</a>` : ""}
        </div>
        <div class="ec-body">
          <div class="ec-title">
            <h2>${esc(e.name)}</h2>
            <span>${esc(fmtRange(e.starts_at, e.ends_at) || `Dibuat ${fmtDate(e.created_at)}`)}</span>
          </div>
          <div class="ec-bars">
            <div class="ec-row"><b>Peserta</b><span>${e.members} / ${e.max_members}</span></div>
            <div class="bar thin coral"><span style="width:${pct(e.members, e.max_members)}%"></span></div>
            <div class="ec-row"><b>Gulungan habis</b><span>${e.rolls_done} / ${e.members}</span></div>
            <div class="bar thin mint"><span style="width:${pct(e.rolls_done, e.members)}%"></span></div>
          </div>
          <small class="ec-meta">Kode ${esc(e.join_code)} · ${e.photos} foto${e.pending ? ` · <b>${e.pending} tertahan</b>` : ""} · ${fmtBytes(e.bytes)}</small>
          <div class="ec-actions">
            <a class="btn ec-dark" href="#/e/${e.event_id}/panel">Kelola</a>
            <a class="btn" href="#/e/${e.event_id}/album">Album</a>
            <button class="round-btn" data-more="${e.event_id}" aria-label="Menu lainnya untuk ${esc(e.name)}: bagikan, duplikat, hapus">${ICON.more}</button>
          </div>
        </div>
      </article>`).join("")}</div>`);
    n.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => eventMenu(rows.find((e) => e.event_id === b.dataset.more))));
    return n;
  }

  // Lencana status pada sampul: Berlangsung / Terjadwal / Selesai
  function statusBadge(e) {
    const now = new Date();
    if (e.is_open && e.starts_at && new Date(e.starts_at) > now) return `<span class="ec-badge sky">Terjadwal</span>`;
    if (e.is_open) return `<span class="ec-badge mint">Berlangsung</span>`;
    return `<span class="ec-badge grape">Selesai · album terbuka</span>`;
  }

  function eventMenu(e) {
    actionSheet(e.name, [
      { label: "Salin link undangan", run: () => copyText(`${location.origin}/?kode=${e.join_code}`, { done: "Link undangan disalin." }) },
      { label: e.is_open ? "Tutup acara" : "Buka acara", run: () => setOpen([e], !e.is_open) },
      { label: "Kartu QR siap cetak", run: () => downloadQrCard(cardData(e)).catch((err) => toast(friendly(err))) },
      { label: "Mode layar (proyektor)", run: () => { location.hash = `#/e/${e.event_id}/layar`; } },
      { label: "Duplikat acara…", run: () => duplicateEvent(e) },
      { label: "Hapus acara…", danger: true, run: async () => {
        const ok = await typeToConfirm({
          title: "Hapus acara dan semua foto?",
          text: `${e.photos} foto dan seluruh data acara dihapus permanen. Unduh album dulu bila perlu.`,
          expect: e.name, ok: "Hapus acara",
        });
        if (ok) removeEvents([e]);
      } },
    ]);
  }

  async function setOpen(list, open) {
    let n = 0;
    for (const e of list) {
      try {
        await rpc("set_event", { p_event: e.event_id, p_patch: { is_open: open } }); n++;
        if (!open) pingAlbum(e.event_id, "closed");
      }
      catch (err) { toast(friendly(err)); }
    }
    toast(`${n} acara ${open ? "dibuka" : "ditutup"}.`);
    if (!open) kickNotify(true);
    load();
  }
  async function removeEvents(list) {
    let n = 0;
    for (const e of list) {
      try { await deleteEventFully(e.event_id); selected.delete(e.event_id); n++; }
      catch (err) { toast(friendly(err)); }
    }
    toast(`${n} acara dihapus.`);
    load();
  }

  function renderBulk() {
    const slot = view.querySelector(".bulk-slot");
    if (!admin || !selected.size) { slot.replaceChildren(); return; }
    const list = () => rows.filter((e) => selected.has(e.event_id));
    const bar = el(`
      <div class="bulk-bar" role="region" aria-label="Aksi untuk acara terpilih">
        <span>${selected.size} dipilih</span>
        <button class="btn small" data-b="close">Tutup</button>
        <button class="btn small" data-b="open">Buka</button>
        <button class="btn small danger" data-b="delete">Hapus…</button>
        <button class="btn small ghost" data-b="clear">Batal pilih</button>
      </div>`);
    bar.querySelector('[data-b="close"]').onclick = () => setOpen(list(), false);
    bar.querySelector('[data-b="open"]').onclick = () => setOpen(list(), true);
    bar.querySelector('[data-b="clear"]').onclick = () => { selected.clear(); load(); };
    bar.querySelector('[data-b="delete"]').onclick = async () => {
      const l = list();
      const photos = l.reduce((a, e) => a + e.photos, 0);
      const ok = await typeToConfirm({
        title: `Hapus ${l.length} acara?`,
        text: `${photos} foto dan seluruh data ${l.length} acara dihapus permanen.`,
        expect: "HAPUS", ok: "Hapus semua",
      });
      if (ok) removeEvents(l);
    };
    slot.replaceChildren(bar);
  }

  await load();
}

// ---------- Pengguna & peran (tab Peran digabung ke sini) ----------
const roleName = (r) => (r === "superadmin" ? "Superadmin" : r === "creator" ? "Pembuat acara" : "");
const roleTag = (r) => (r ? `<span class="tag ${r === "superadmin" ? "hot" : ""}">${roleName(r)}</span>` : "");
const limitText = (r) => (r.event_limit === null || r.event_limit === undefined
  ? `${r.events_created ?? 0} acara dibuat · tanpa batas`
  : `${r.events_created ?? 0} dari ${r.event_limit} acara${r.events_created >= r.event_limit ? " · habis" : ""}`) +
  (r.storage_bytes !== undefined || r.storage_limit_mb
    ? ` · storage ${r.storage_bytes !== undefined ? fmtBytes(r.storage_bytes) : "?"}${r.storage_limit_mb ? ` dari ${fmtBytes(r.storage_limit_mb * 1048576)}` : ""}`
    : "");

// ---------- Pengajuan menjadi pembuat acara ----------
// Kartu di atas tab Pengguna & peran: pengajuan terbuka (setujui / tolak + hubungi via WhatsApp),
// riwayat yang sudah diputuskan di bawah lipatan.
const waLink = (phone, name, event) =>
  `https://wa.me/${encodeURIComponent(phone)}?text=${encodeURIComponent(`Halo ${name || ""}, kami dari Jepretin tentang pengajuan pembuat acara untuk "${event}".`)}`;
const waShow = (p) => `0${String(p).replace(/^62/, "")}`.replace(/(\d{4})(\d{4})(\d+)/, "$1 $2 $3");

async function loadCreatorRequests(slot, onChange) {
  let rows = [];
  try { rows = await rpc("admin_creator_requests", { p_status: "all" }); } catch { slot.replaceChildren(); return; }
  const open = rows.filter((r) => r.status === "open");
  const done = rows.filter((r) => r.status !== "open").slice(0, 20);
  if (!rows.length) { slot.replaceChildren(); return; }
  const item = (r) => `
    <li class="cr-item${r.status === "open" ? "" : " done"}" data-id="${r.id}">
      <div class="cr-main">
        <div class="cr-who"><b>${esc(r.user_name || r.email)}</b><small>${esc(r.email)}</small></div>
        <div class="cr-event"><b>${esc(r.event_name)}</b>
          <small>${[r.event_date ? esc(new Date(r.event_date + "T00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })) : "", r.guests ? `±${r.guests} tamu` : "", `diajukan ${esc(fmtDate(r.created_at))}`].filter(Boolean).join(" · ")}</small></div>
        ${r.note ? `<p class="cr-note">${esc(r.note)}</p>` : ""}
        ${r.status === "open" ? "" : `<small class="cr-result"><span class="tag ${r.status === "approved" ? "ok" : "bad"}">${r.status === "approved" ? "disetujui" : "ditolak"}</span>${r.reply ? ` ${esc(r.reply)}` : ""}</small>`}
      </div>
      <div class="cr-actions">
        <a class="btn small wa" href="${waLink(r.phone, r.user_name, r.event_name)}" target="_blank" rel="noopener">WhatsApp ${esc(waShow(r.phone))}</a>
        ${r.status === "open" ? `<button class="btn small primary" data-act="approve">Setujui</button>
        <button class="btn small ghost danger" data-act="reject">Tolak</button>` : ""}
      </div>
    </li>`;
  const card = el(`
    <div class="card creator-reqs">
      <h3>Pengajuan pembuat acara ${open.length ? `<span class="tab-count">${open.length}</span>` : ""}</h3>
      ${open.length ? `<ul class="cr-list">${open.map(item).join("")}</ul>` : `<p class="hint">Tidak ada pengajuan yang menunggu.</p>`}
      ${done.length ? `<details class="cr-history"><summary>Riwayat (${done.length})</summary><ul class="cr-list">${done.map(item).join("")}</ul></details>` : ""}
    </div>`);
  card.querySelectorAll('[data-act="approve"]').forEach((b) => (b.onclick = async () => {
    const r = rows.find((x) => String(x.id) === b.closest("[data-id]").dataset.id);
    if (!(await confirmDialog({ title: `Setujui ${r.user_name || r.email}?`, text: `${r.email} menjadi pembuat acara dengan batas bawaan dari Pengaturan.`, ok: "Setujui" }))) return;
    try { await rpc("admin_resolve_creator_request", { p_request: r.id, p_approve: true }); toast("Pengajuan disetujui."); loadCreatorRequests(slot, onChange); onChange?.(); }
    catch (e) { toast(friendly(e)); }
  }));
  card.querySelectorAll('[data-act="reject"]').forEach((b) => (b.onclick = () => {
    const r = rows.find((x) => String(x.id) === b.closest("[data-id]").dataset.id);
    const { box, close } = modal(`
      <form class="dialog">
        <h3>Tolak pengajuan ${esc(r.user_name || r.email)}?</h3>
        <label>Alasan (ditampilkan ke pengaju)
          <textarea name="reply" rows="3" maxlength="500" required autofocus placeholder="Contoh: Mohon lengkapi tanggal dan jumlah tamu."></textarea></label>
        <div class="dialog-actions"><button type="button" class="btn ghost" data-act="cancel">Batal</button><button class="btn danger-fill">Tolak</button></div>
      </form>`);
    box.querySelector('[data-act="cancel"]').onclick = close;
    box.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const reply = e.target.elements.reply.value.trim();
      if (!reply) { toast("Tulis alasan penolakan."); return; }
      try { await rpc("admin_resolve_creator_request", { p_request: r.id, p_approve: false, p_reply: reply }); close(); toast("Pengajuan ditolak."); loadCreatorRequests(slot, onChange); }
      catch (err) { toast(friendly(err)); }
    };
  }));
  slot.replaceChildren(card);
}

async function pengguna(body, me) {
  const st = { q: "", filter: "all", offset: 0 };
  const view = el(`
    <div>
      <div class="creator-req-slot"></div>
      <form class="card add-role">
        <h3>Beri peran lewat email</h3>
        <p class="hint">Pembuat acara bisa membuat dan mengelola acaranya sendiri. Superadmin bisa mengelola semuanya. Email tidak harus sudah pernah login.</p>
        <div class="row">
          <input name="email" type="email" placeholder="email@gmail.com" aria-label="Email" required />
          <select name="role" aria-label="Peran"><option value="creator">Pembuat acara</option><option value="superadmin">Superadmin</option></select>
          <button class="btn primary">Simpan</button>
        </div>
        <label class="limit-field" style="margin-top:.75rem">Batas jumlah acara (kosongkan = tanpa batas)
          <input name="limit" type="number" min="0" max="10000" placeholder="Tanpa batas" /></label>
      </form>
      <div class="pending-roles"></div>
      <div class="toolbar"><input type="search" placeholder="Cari nama atau email" aria-label="Cari pengguna" /></div>
      <div class="filter-slot"></div>
      <div class="results" style="margin-top:.75rem"><p class="hint">Memuat…</p></div>
    </div>`);
  body.replaceChildren(view);
  const results = view.querySelector(".results");
  loadCreatorRequests(view.querySelector(".creator-req-slot"), () => refresh());

  // Ubah peran / batas / blokir
  async function setRole(email, role, limit) {
    try {
      await rpc("admin_set_role", { p_email: email, p_role: role });
      if (limit !== undefined) await rpc("admin_set_event_limit", { p_email: email, p_limit: limit });
      toast("Tersimpan.");
      refresh();
      return true;
    } catch (e) { toast(friendly(e)); return false; }
  }
  function roleMenu(title, r, extra = []) {
    actionSheet(title, [
      ...(r.role !== "creator" ? [{ label: "Jadikan pembuat acara", run: () => setRole(r.email, "creator") }] : []),
      ...(r.role !== "superadmin" ? [{ label: "Jadikan superadmin", run: async () => {
        if (await confirmDialog({ title: `Jadikan ${r.email} superadmin?`, text: "Superadmin bisa mengelola semua acara, pengguna, dan pengaturan.", ok: "Jadikan superadmin" }))
          setRole(r.email, "superadmin");
      } }] : []),
      ...(r.role === "creator" ? [{ label: "Atur batas acara…", run: async () => { if (await limitDialog(r)) refresh(); } }] : []),
      ...(r.role === "creator" ? [{ label: "Atur kuota storage…", run: async () => { if (await storageDialog(r)) refresh(); } }] : []),
      ...(r.role ? [{ label: "Cabut peran", danger: true, run: async () => {
        if (await confirmDialog({ title: `Cabut peran ${r.email}?`, text: "Acara yang sudah dibuatnya tetap ada.", ok: "Cabut peran", danger: true }))
          setRole(r.email, null);
      } }] : []),
      ...extra,
    ]);
  }

  // Peran untuk email yang belum pernah login (tidak muncul di daftar pengguna)
  async function loadPending() {
    const box = view.querySelector(".pending-roles");
    try {
      const roles = (await rpc("admin_roles")).filter((r) => !r.user_name);
      if (!roles.length) { box.replaceChildren(); return; }
      const card = el(`
        <div class="card">
          <h3>Menunggu login pertama</h3>
          <p class="hint">Peran sudah diberikan, tetapi pemilik email belum pernah masuk.</p>
          <div class="table-scroll"><table class="stack"><tbody>${roles.map((r) => `
            <tr>
              <td><b>${esc(r.email)}</b> ${roleTag(r.role)}${r.role === "creator" ? `<br><small>${limitText(r)}</small>` : ""}</td>
              <td><small>ditambahkan ${esc(fmtDate(r.added_at))}${r.added_by ? ` oleh ${esc(r.added_by)}` : ""}</small></td>
              <td class="actions"><button class="btn small ghost icon-btn" data-email="${esc(r.email)}" aria-label="Aksi untuk ${esc(r.email)}">⋯</button></td>
            </tr>`).join("")}</tbody></table></div>
        </div>`);
      card.querySelectorAll("[data-email]").forEach((b) => (b.onclick = () => {
        const r = roles.find((x) => x.email === b.dataset.email);
        roleMenu(r.email, r);
      }));
      box.replaceChildren(card);
    } catch { box.replaceChildren(); }
  }

  async function load() {
    let rows;
    try {
      rows = await rpc("admin_users", { p_search: st.q || null, p_filter: st.filter, p_limit: PAGE, p_offset: st.offset });
    } catch (e) { results.replaceChildren(el(`<p class="hint">${esc(friendly(e))}</p>`)); return; }
    if (!rows.length) { results.replaceChildren(el(`<p class="hint">Tidak ada pengguna yang cocok.</p>`)); return; }
    const table = el(`
      <div class="card table-scroll" style="padding:.25rem .5rem">
        <table class="stack">
          <thead><tr><th>Pengguna</th><th>Aktivitas</th><th>Login terakhir</th><th></th></tr></thead>
          <tbody>${rows.map((u) => `
            <tr class="${u.banned ? "blocked" : ""}">
              <td><b>${esc(u.name)}</b> ${roleTag(u.role)} ${u.banned ? `<span class="tag bad">diblokir</span>` : ""}
                <br><small>${esc(u.email)}</small>${u.role === "creator" ? `<br><small>${limitText(u)}</small>` : ""}</td>
              <td data-label="Aktivitas"><small>${u.events_owned} acara dibuat · ${u.events_joined} diikuti · ${u.photos} foto</small></td>
              <td data-label="Login terakhir"><small>${esc(fmtDate(u.last_sign_in_at) || "-")}</small></td>
              <td class="actions">${u.user_id === me.id ? `<small>Anda</small>` :
                `<button class="btn small ghost icon-btn" data-user="${u.user_id}" aria-label="Aksi untuk ${esc(u.name)}">⋯</button>`}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`);
    table.querySelectorAll("[data-user]").forEach((b) => (b.onclick = () => {
      const u = rows.find((x) => x.user_id === b.dataset.user);
      roleMenu(u.name, u, [{
        label: u.banned ? "Pulihkan akun" : "Blokir akun…", danger: !u.banned,
        run: async () => {
          if (!u.banned && !(await confirmDialog({
            title: `Blokir ${u.name}?`,
            text: "Akun tidak bisa masuk acara, memotret, atau melihat album di seluruh aplikasi.",
            ok: "Blokir", danger: true,
          }))) return;
          try { await rpc("admin_ban", { p_user: u.user_id, p_banned: !u.banned }); load(); }
          catch (e) { toast(friendly(e)); }
        },
      }]);
    }));
    results.replaceChildren(table, pagerEl(Number(rows[0].total_count), st.offset, (o) => { st.offset = o; load(); }));
  }
  const refresh = () => { loadPending(); load(); };

  view.querySelector(".filter-slot").append(chips(
    [["all", "Semua"], ["superadmin", "Superadmin"], ["creator", "Pembuat acara"], ["none", "Tanpa peran"], ["banned", "Diblokir"]],
    st.filter, (v) => { st.filter = v; st.offset = 0; load(); }, "Saring pengguna"));
  let timer;
  view.querySelector('input[type="search"]').oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { st.q = e.target.value.trim(); st.offset = 0; load(); }, 300);
  };
  const form = view.querySelector("form");
  const syncLimit = () => { form.querySelector(".limit-field").hidden = form.elements.role.value !== "creator"; };
  form.elements.role.onchange = syncLimit;
  syncLimit();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const raw = f.limit.value.trim();
    const limit = f.role.value === "creator" && raw !== "" ? Number(raw) : undefined;
    if (await setRole(f.email.value.trim(), f.role.value, limit)) { f.email.value = ""; f.limit.value = ""; }
  };
  refresh();
}

// Dialog atur batas acara satu pembuat acara. Resolve true jika tersimpan.
function limitDialog(r) {
  return new Promise((resolve) => {
    let saved = false;
    const { box, close } = modal(`
      <form class="dialog">
        <h3>Batas acara</h3>
        <p>${esc(r.email)}</p>
        <label>Maks. acara yang boleh dibuat
          <input name="limit" type="number" min="0" max="10000" placeholder="Tanpa batas" value="${r.event_limit ?? ""}" autofocus /></label>
        <label>Acara yang sudah dibuat
          <input name="used" type="number" min="0" value="${r.events_created ?? 0}" /></label>
        <p class="hint">Kosongkan batas untuk tanpa batas. Hitungan tidak berkurang saat acara dihapus; ubah angkanya (misalnya ke 0) untuk memberi jatah baru.</p>
        <div class="dialog-actions">
          <button type="button" class="btn ghost" data-act="no">Batal</button>
          <button class="btn primary">Simpan</button>
        </div>
      </form>`, { onClose: () => resolve(saved) });
    const f = box.querySelector("form");
    box.querySelector('[data-act="no"]').onclick = close;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const limit = f.elements.limit.value.trim();
      const used = f.elements.used.value.trim();
      try {
        await rpc("admin_set_event_limit", {
          p_email: r.email,
          p_limit: limit === "" ? null : Number(limit),
          p_used: used === "" ? null : Number(used),
        });
        toast("Batas acara tersimpan.");
        saved = true;
        close();
      } catch (err) { toast(friendly(err)); }
    };
  });
}

// Dialog kuota storage satu pembuat acara (MB). Resolve true jika tersimpan.
function storageDialog(r) {
  return new Promise((resolve) => {
    let saved = false;
    const { box, close } = modal(`
      <form class="dialog">
        <h3>Kuota storage</h3>
        <p>${esc(r.email)}${r.storage_bytes !== undefined ? ` · terpakai ${fmtBytes(r.storage_bytes)}` : ""}</p>
        <label>Maks. storage semua acaranya (MB)
          <input name="mb" type="number" min="1" max="10000000" placeholder="Tanpa batas" value="${r.storage_limit_mb ?? ""}" autofocus /></label>
        <p class="hint">Kosongkan untuk tanpa batas. Saat kuota penuh, ia tidak bisa membuat acara baru; acara yang sedang berjalan tetap bisa dipakai memotret. 1024 MB = 1 GB.</p>
        <div class="dialog-actions">
          <button type="button" class="btn ghost" data-act="no">Batal</button>
          <button class="btn primary">Simpan</button>
        </div>
      </form>`, { onClose: () => resolve(saved) });
    const f = box.querySelector("form");
    box.querySelector('[data-act="no"]').onclick = close;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = f.elements.mb.value.trim();
      try {
        await rpc("admin_set_storage_limit", { p_email: r.email, p_mb: v === "" ? null : Number(v) });
        toast("Kuota storage tersimpan.");
        saved = true;
        close();
      } catch (err) { toast(friendly(err)); }
    };
  });
}

// ---------- Pengaturan global ----------
async function pengaturan(body) {
  const s = await rpc("get_settings");
  const view = el(`
    <form class="card settings">
      <h3>Pengaturan global</h3>
      <p class="hint">Berlaku untuk semua acara. Resolusi dan mirror bisa ditimpa per acara dari Panel acara.</p>

      <fieldset><legend>Batas</legend>
        <label>Maks. jepretan per peserta (batas untuk pembuat acara)
          <input type="number" name="max_shots_limit" min="1" max="500" value="${s.max_shots_limit}" /></label>
        <label>Maks. peserta per acara
          <input type="number" name="max_members_limit" min="1" max="5000" value="${s.max_members_limit}" /></label>
      </fieldset>

      <fieldset><legend>Batas bawaan pembuat acara baru</legend>
        <label>Maks. acara yang boleh dibuat
          <input type="number" name="creator_event_limit" min="0" max="10000" placeholder="Tanpa batas" value="${s.creator_event_limit ?? ""}" /></label>
        <label>Kuota storage (MB)
          <input type="number" name="creator_storage_mb" min="1" max="10000000" placeholder="Tanpa batas" value="${s.creator_storage_mb ?? ""}" /></label>
        <p class="hint">Diberikan saat seseorang dijadikan pembuat acara. Batas orang yang sudah punya peran tidak berubah; atur satu per satu di Pengguna & peran.</p>
      </fieldset>

      <fieldset><legend>Foto</legend>
        <label>Resolusi foto (sisi terpanjang)
          <select name="photo_max_side">${RESOLUTIONS.map((r) => `<option value="${r}" ${r === s.photo_max_side ? "selected" : ""}>${r} px${resNote(r)}</option>`).join("")}</select></label>
        <p class="hint">Resolusi sebenarnya dibatasi kamera dan browser HP. Safari iPhone biasanya memberi 1920–4032 px. Semakin tinggi, semakin cepat storage penuh.</p>
        <label>Kualitas JPEG: <b class="qv">${s.jpeg_quality}</b>
          <input type="range" name="jpeg_quality" min="60" max="95" step="1" value="${s.jpeg_quality}" /></label>
        <label>Efek film bawaan acara baru
          <select name="default_film">${Object.entries(FILMS).map(([id, f]) => `<option value="${id}" ${id === s.default_film ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>
      </fieldset>

      <fieldset><legend>Penyimpanan foto</legend>
        <label>Lokasi foto baru
          <select name="storage_backend">
            <option value="supabase" ${s.storage_backend !== "r2" ? "selected" : ""}>Supabase Storage</option>
            <option value="r2" ${s.storage_backend === "r2" ? "selected" : ""}>Cloudflare R2</option>
          </select></label>
        <div class="date-row quota-row">
          <label data-quota="supabase">Kuota Supabase (MB) <span class="tag ok quota-active">dipakai foto baru</span>
            <input type="number" name="storage_quota_mb" min="100" max="1000000" value="${s.storage_quota_mb}" /></label>
          <label data-quota="r2">Kuota R2 (MB) <span class="tag ok quota-active">dipakai foto baru</span>
            <input type="number" name="r2_quota_mb" min="100" max="10000000" value="${s.r2_quota_mb ?? 10240}" /></label>
        </div>
        <p class="hint">Dipakai meter storage dan perkiraan sisa foto di Ringkasan. Supabase gratis 1024 MB (Pro 102400 MB); R2 gratis 10240 MB (10 GB), lebih dari itu dibayar per GB.</p>
        <p class="hint r2-status">Memeriksa Worker R2…</p>
        <div class="row tight wrap">
          <button type="button" class="btn small" data-act="migrate" disabled>Pindahkan foto lama ke R2</button>
        </div>
        <p class="hint migrate-progress" hidden></p>
      </fieldset>

      <fieldset><legend>Notifikasi album</legend>
        <label>Kunci publik VAPID
          <input name="vapid_public_key" maxlength="200" placeholder="Kosong = notifikasi mati" value="${esc(s.vapid_public_key || "")}" autocomplete="off" spellcheck="false" /></label>
        <p class="hint">Dari <code>npx web-push generate-vapid-keys</code>. Kunci privat disimpan di Secrets Edge Function <code>notify-album</code>, bukan di sini.</p>
      </fieldset>

      <fieldset><legend>Kamera</legend>
        <label class="check"><input type="checkbox" name="flash_enabled" ${s.flash_enabled ? "checked" : ""}/> Tampilkan tombol flash</label>
        <label class="check"><input type="checkbox" name="mirror_preview" ${s.mirror_preview ? "checked" : ""}/> Cerminkan jendela bidik kamera depan (seperti cermin)</label>
        <label class="check"><input type="checkbox" name="mirror_photo" ${s.mirror_photo ? "checked" : ""}/> Cerminkan hasil foto kamera depan</label>
        <p class="hint">Hasil foto biasanya tidak dicerminkan, supaya tulisan di foto terbaca normal.</p>
      </fieldset>

      <p class="hint">Terakhir diubah ${esc(fmtDate(s.updated_at))}</p>
      <div class="row">
        <button class="btn primary">Simpan pengaturan</button>
        <button type="button" class="btn ghost" data-act="defaults">Kembalikan ke bawaan</button>
      </div>
    </form>`);
  body.replaceChildren(view);
  const f = view.elements;
  f.jpeg_quality.oninput = () => { view.querySelector(".qv").textContent = f.jpeg_quality.value; };
  const optNum = (v) => (v.trim() === "" ? null : Number(v));
  const read = () => ({
    max_shots_limit: Number(f.max_shots_limit.value),
    max_members_limit: Number(f.max_members_limit.value),
    storage_quota_mb: Number(f.storage_quota_mb.value),
    r2_quota_mb: Number(f.r2_quota_mb.value),
    creator_event_limit: optNum(f.creator_event_limit.value),
    creator_storage_mb: optNum(f.creator_storage_mb.value),
    photo_max_side: Number(f.photo_max_side.value),
    jpeg_quality: Number(f.jpeg_quality.value),
    default_film: f.default_film.value,
    flash_enabled: f.flash_enabled.checked,
    mirror_preview: f.mirror_preview.checked,
    mirror_photo: f.mirror_photo.checked,
    storage_backend: f.storage_backend.value,
    vapid_public_key: f.vapid_public_key.value.trim() || null,
  });
  // Tandai kuota yang dipakai foto baru, ikut pilihan lokasi
  const syncQuota = () => view.querySelectorAll("[data-quota]").forEach((l) => l.classList.toggle("active", l.dataset.quota === f.storage_backend.value));
  f.storage_backend.addEventListener("change", syncQuota);
  syncQuota();
  // R2: status Worker dan pemindahan foto lama
  const statusEl = view.querySelector(".r2-status");
  const migrateBtn = view.querySelector('[data-act="migrate"]');
  let r2ok = false;
  r2Health().then((h) => {
    r2ok = Boolean(h.ok);
    statusEl.innerHTML = h.ok
      ? `<span class="tag ok">Worker R2 siap</span> Foto lama tetap terbaca dan disalin ke R2 saat dibuka; tombol di bawah memindahkan semuanya sekaligus.`
      : `<span class="tag bad">Worker R2 belum siap</span> ${h.r2 === false ? "Bucket R2 belum terpasang di Worker. " : ""}${h.service === false || h.sign === false || h.supabase === false ? "Rahasia Worker belum lengkap (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, SIGN_SECRET). " : ""}Lihat README bagian R2.`;
    migrateBtn.disabled = !h.ok;
    if (!h.ok) [...f.storage_backend.options].find((o) => o.value === "r2").disabled = s.storage_backend !== "r2";
  });
  migrateBtn.onclick = async () => {
    const prog = view.querySelector(".migrate-progress");
    migrateBtn.disabled = true; prog.hidden = false;
    let total = 0;
    try {
      for (;;) {
        const r = await migrateToR2(20);
        total += r.moved;
        prog.textContent = `Dipindahkan ${total} file, sisa ${r.remaining}…`;
        if (!r.remaining || !r.moved) break;
      }
      prog.textContent = `Selesai: ${total} file dipindahkan ke R2.`;
    } catch (e) { prog.textContent = `Berhenti: ${friendly(e)}. Ketuk lagi untuk melanjutkan.`; }
    migrateBtn.disabled = false;
  };
  // Isi formulir dengan nilai bawaan (belum disimpan sampai tombol Simpan)
  view.querySelector('[data-act="defaults"]').onclick = () => {
    for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
      const input = f[k];
      if (input.type === "checkbox") input.checked = v; else input.value = v ?? "";
    }
    f.jpeg_quality.oninput();
    syncQuota();
    toast("Nilai bawaan diisi. Periksa lalu Simpan.");
  };
  view.onsubmit = async (e) => {
    e.preventDefault();
    const next = read();
    const changed = Object.keys(next).filter((k) => (s[k] ?? null) !== next[k]);
    if (!changed.length) { toast("Tidak ada perubahan."); return; }
    if (next.storage_backend === "r2" && s.storage_backend !== "r2" && !r2ok) { toast("Worker R2 belum siap. Lengkapi pemasangan dulu (README bagian R2)."); return; }
    if (!(await changesDialog(changed.map((k) => [SETTING_LABELS[k] || k, settingText(k, s[k]), settingText(k, next[k])])))) return;
    try {
      await rpc("admin_set_settings", { p_patch: Object.fromEntries(changed.map((k) => [k, next[k]])) });
      Object.assign(s, next);
      setStorageBackend(s.storage_backend);
      setVapidKey(s.vapid_public_key);
      toast("Pengaturan tersimpan.");
    } catch (err) { toast(friendly(err)); }
  };
}

// Nilai bawaan di supabase/v2.sql (app_settings)
const SETTING_DEFAULTS = {
  max_shots_limit: 100, max_members_limit: 300, storage_quota_mb: 1024, r2_quota_mb: 10240,
  creator_event_limit: null, creator_storage_mb: null,
  photo_max_side: 2560, jpeg_quality: 88, default_film: "senja",
  flash_enabled: true, mirror_preview: true, mirror_photo: false,
  storage_backend: "supabase", vapid_public_key: null,
};
const SETTING_LABELS = {
  max_shots_limit: "Maks. jepretan per peserta", max_members_limit: "Maks. peserta per acara",
  storage_quota_mb: "Kuota Supabase (MB)", r2_quota_mb: "Kuota R2 (MB)", creator_event_limit: "Batas acara pembuat baru",
  creator_storage_mb: "Kuota storage pembuat baru (MB)", photo_max_side: "Resolusi foto",
  jpeg_quality: "Kualitas JPEG", default_film: "Efek film bawaan", flash_enabled: "Tombol flash",
  mirror_preview: "Cermin jendela bidik", mirror_photo: "Cermin hasil foto",
  storage_backend: "Lokasi foto baru", vapid_public_key: "Kunci VAPID",
};
function settingText(k, v) {
  if (k === "storage_backend") return v === "r2" ? "Cloudflare R2" : "Supabase Storage";
  if (k === "vapid_public_key") return v ? `${String(v).slice(0, 10)}…` : "kosong (notifikasi mati)";
  if (v === null || v === undefined || v === "") return "tanpa batas";
  if (typeof v === "boolean") return v ? "nyala" : "mati";
  if (k === "default_film") return filmName(v);
  if (k === "photo_max_side") return `${v} px`;
  return String(v);
}
// Ringkasan perubahan sebelum disimpan. rows: [label, lama, baru]
function changesDialog(rows) {
  return new Promise((resolve) => {
    let ok = false;
    const { box, close } = modal(`
      <div class="dialog">
        <h3>Simpan ${rows.length} perubahan?</h3>
        <p>Berlaku untuk semua acara yang tidak punya pengaturan sendiri.</p>
        <ul class="changes">${rows.map(([l, a, b]) => `<li><span>${esc(l)}</span><span><s>${esc(a)}</s> → <b>${esc(b)}</b></span></li>`).join("")}</ul>
        <div class="dialog-actions">
          <button class="btn ghost" data-act="no">Batal</button>
          <button class="btn primary" data-act="yes" autofocus>Simpan</button>
        </div>
      </div>`, { onClose: () => resolve(ok) });
    box.querySelector('[data-act="no"]').onclick = close;
    box.querySelector('[data-act="yes"]').onclick = () => { ok = true; close(); };
  });
}
// Perkiraan kasar ukuran per foto (3 ukuran, kualitas ~88)
const resNote = (r) => ({ 1280: " · ±0,4 MB/foto", 1600: " · ±0,6 MB/foto", 2048: " · ±1 MB/foto",
  2560: " · ±1,5 MB/foto", 3264: " · ±2,4 MB/foto", 4096: " · ±3,5 MB/foto" })[r] || "";

// ---------- Log: kalimat yang terbaca, bisa disaring ----------
const ACTIONS = {
  buat_acara: "Membuat acara", ubah_acara: "Mengubah acara", hapus_acara: "Menghapus acara",
  ubah_sampul: "Mengubah sampul", blokir_peserta: "Memblokir peserta", pulihkan_peserta: "Memulihkan peserta",
  ubah_peran: "Mengubah peran", ubah_batas_acara: "Mengubah batas acara",
  ubah_pengaturan: "Mengubah pengaturan global", blokir_akun: "Memblokir akun", pulihkan_akun: "Memulihkan akun",
  ubah_batas_storage: "Mengubah kuota storage", moderasi: "Menindak laporan foto",
  permintaan_data: "Memproses permintaan data",
};
const MODERATION = { hide: "menyembunyikan foto yang dilaporkan", block: "menyembunyikan foto dan memblokir pemotret", dismiss: "mengabaikan laporan foto" };
const FIELDS = {
  name: "nama", max_shots: "jatah", max_members: "batas peserta",
  max_shots_limit: "batas jepretan", max_members_limit: "batas peserta", storage_quota_mb: "kuota Supabase (MB)", r2_quota_mb: "kuota R2 (MB)",
  jpeg_quality: "kualitas JPEG", creator_event_limit: "batas acara bawaan", creator_storage_mb: "kuota storage bawaan (MB)",
};
function describeChange(k, v) {
  const onOff = (on, off) => (v ? on : off);
  switch (k) {
    case "is_open": return onOff("membuka acara", "menutup acara");
    case "hide_names": return onOff("menyembunyikan nama pengunggah", "menampilkan nama pengunggah");
    case "allow_film_choice": return onOff("mengizinkan tamu memilih film", "melarang tamu memilih film");
    case "invite_only": return onOff("hanya untuk undangan", "terbuka untuk semua yang punya kode");
    case "flash_enabled": return onOff("menampilkan tombol flash", "menyembunyikan tombol flash");
    case "mirror_preview": return v === null ? "cermin jendela bidik ikut global" : onOff("mencerminkan jendela bidik", "tidak mencerminkan jendela bidik");
    case "mirror_photo": return v === null ? "cermin foto ikut global" : onOff("mencerminkan hasil foto", "tidak mencerminkan hasil foto");
    case "film": case "default_film": return `film ${filmName(v)}`;
    case "reveal_at": return v ? `cuci film ${fmtDate(v)}` : "tanpa cuci film";
    case "purge_at": return v ? `rencana hapus ${fmtDate(v)}` : "tanpa rencana hapus";
    case "photo_max_side": return v ? `resolusi ${v} px` : "resolusi ikut global";
    case "welcome_text": return "mengubah kalimat sambutan";
    case "starts_at": return v ? `mulai ${fmtDate(v)}` : "tanpa waktu mulai";
    case "ends_at": return v ? `selesai ${fmtDate(v)}` : "tanpa waktu selesai";
    default: return `${FIELDS[k] || k} ${v ?? "-"}`;
  }
}
function describe(r) {
  const d = r.detail || {};
  const t = r.target_label || r.target || "";
  const patch = () => Object.entries(d).map(([k, v]) => describeChange(k, v)).join(", ");
  switch (r.action) {
    case "buat_acara": return `membuat acara “${d.name || t}”`;
    case "ubah_pembuatan_acara": {
      const m = { open: "Buka", limited: "Hanya acara kecil", closed: "Tutup" }[r.target] || r.target;
      return `${d.auto ? "pengaman otomatis " : ""}mengubah status pembuatan acara menjadi ${m}${d.auto === "jadwal" ? " (jadwal buka lagi)" : d.peak ? ` (perkiraan ${Math.round(d.peak)}%)` : ""}`;
    }
    case "tinjau_acara": return `menandai acara “${t}” sudah ditinjau`;
    case "hapus_acara": return `menghapus acara “${d.name || t}”${d.files !== undefined ? ` (${d.files} file)` : ""}`;
    case "ubah_sampul": return `${d.path ? "mengganti" : "menghapus"} sampul acara “${t}”`;
    case "ubah_acara": return `mengubah acara “${t}”: ${patch()}`;
    case "blokir_peserta": return `memblokir ${r.user_label || "peserta"} di acara “${t}”`;
    case "pulihkan_peserta": return `memulihkan ${r.user_label || "peserta"} di acara “${t}”`;
    case "ubah_peran": return d.role ? `menjadikan ${r.target} ${roleName(d.role).toLowerCase()}` : `mencabut peran ${r.target}`;
    case "ubah_batas_acara": return `mengatur batas acara ${r.target}: ${d.limit === null || d.limit === undefined ? "tanpa batas" : `${d.limit} acara`}${d.used !== null && d.used !== undefined ? `, hitungan ${d.used}` : ""}`;
    case "ubah_pengaturan": return `mengubah pengaturan global: ${patch()}`;
    case "blokir_akun": return `memblokir akun ${t}`;
    case "pulihkan_akun": return `memulihkan akun ${t}`;
    case "permintaan_data": return `${d.action === "reject" ? "menolak" : "memproses"} permintaan ${d.kind === "account" ? "hapus akun" : "hapus foto"} ${d.email || ""}`;
    case "ubah_batas_storage": return `mengatur kuota storage ${r.target}: ${d.mb ? `${d.mb} MB` : "tanpa batas"}`;
    case "moderasi": return `${MODERATION[d.action] || "menindak laporan foto"} di acara “${t}”${r.user_label && d.action === "block" ? ` (${r.user_label})` : ""}`;
    default: return `${r.action} ${t}`;
  }
}

async function log(body) {
  const st = { action: "", actor: "", since: "7", offset: 0 };
  const view = el(`
    <div>
      <div class="toolbar">
        <select aria-label="Jenis aktivitas" data-action>
          <option value="">Semua aktivitas</option>
          ${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
        </select>
        <select aria-label="Rentang waktu" data-since>
          <option value="1">24 jam terakhir</option>
          <option value="7" selected>7 hari terakhir</option>
          <option value="30">30 hari terakhir</option>
          <option value="">Semua waktu</option>
        </select>
        <input type="search" placeholder="Cari email pelaku" aria-label="Cari email pelaku" />
        <button class="btn small" data-act="csv">${ICON.download} CSV</button>
      </div>
      <div class="card">
        <ul class="audit"></ul>
        <p class="hint empty-log" hidden>Tidak ada aktivitas yang cocok.</p>
        <button class="btn small" data-act="more" hidden>Muat lebih banyak</button>
      </div>
    </div>`);
  body.replaceChildren(view);
  const list = view.querySelector(".audit");
  const more = view.querySelector('[data-act="more"]');

  async function load(append = false) {
    if (!append) st.offset = 0;
    const since = st.since ? new Date(Date.now() - Number(st.since) * 86400000).toISOString() : null;
    let rows;
    try {
      rows = await rpc("admin_audit", { p_limit: 50, p_offset: st.offset, p_action: st.action || null, p_actor: st.actor || null, p_since: since });
    } catch (e) { toast(friendly(e)); return; }
    const html = rows.map((r) => `
      <li>
        <small>${esc(fmtDate(r.at))}</small>
        <div><b>${esc(r.actor_email || "sistem")}</b> ${esc(describe(r))}</div>
      </li>`).join("");
    if (append) list.insertAdjacentHTML("beforeend", html); else list.innerHTML = html;
    st.offset += rows.length;
    const total = Number(rows[0]?.total_count ?? st.offset);
    view.querySelector(".empty-log").hidden = list.children.length > 0;
    more.hidden = st.offset >= total;
  }
  view.querySelector("[data-action]").onchange = (e) => { st.action = e.target.value; load(); };
  view.querySelector("[data-since]").onchange = (e) => { st.since = e.target.value; load(); };
  let timer;
  view.querySelector('input[type="search"]').oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { st.actor = e.target.value.trim(); load(); }, 300);
  };
  more.onclick = () => load(true);
  // Ekspor log sesuai saringan (maks. 5.000 baris)
  view.querySelector('[data-act="csv"]').onclick = async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    try {
      const since = st.since ? new Date(Date.now() - Number(st.since) * 86400000).toISOString() : null;
      const all = [];
      for (let off = 0; off < 5000; off += 200) {
        const part = await rpc("admin_audit", { p_limit: 200, p_offset: off, p_action: st.action || null, p_actor: st.actor || null, p_since: since });
        all.push(...part);
        if (part.length < 200) break;
      }
      downloadCsv(`log-${new Date().toISOString().slice(0, 10)}`, [
        [(r) => new Date(r.at).toISOString(), "Waktu (UTC)"], ["actor_email", "Pelaku"], [(r) => ACTIONS[r.action] || r.action, "Aktivitas"],
        [(r) => describe(r), "Keterangan"], ["target", "Target"], [(r) => JSON.stringify(r.detail || {}), "Detail"],
      ], all);
    } catch (e) { toast(friendly(e)); }
    finally { b.disabled = false; }
  };
  await load();
}
