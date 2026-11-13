// Tab Panel: untuk pemilik acara dan superadmin
import QRCode from "qrcode";
import { zipSync } from "fflate";
import { rpc, friendly } from "./supabase.js";
import { getUrls, removeFiles, uploadCover, coverUrl, removeCover, copyCover, removeVoices } from "./storage.js";
import { pingAlbum } from "./realtime.js";
import { kickNotify } from "./push.js";
import { FILMS } from "./film.js";
import { ORNAMENTS } from "./collage-layouts.js";
import { openPayment, openUpgrade, paymentsOn } from "./payment.js";
import { rp } from "./price.js";
import { downloadQrCard, printQrCard } from "./qrcard.js";
import { openCrop } from "./crop.js";
import { renderReports } from "./moderation.js";
import { attachZoom } from "./zoom.js";
import {
  el, esc, toast, fmtDate, toLocalInput, fromLocalInput, download, safeName, modal,
  confirmDialog, typeToConfirm, copyText, actionSheet, ICON, fmtRange, downloadCsv, initial,
} from "./ui.js";

export const RESOLUTIONS = [1280, 1600, 2048, 2560, 3264, 4096];
// Jumlah foto per file ZIP: 100 foto ukuran penuh (~100–350 MB) masih aman di memori HP
const ZIP_PART = 100;

const filmOptions = (current, withDefault = false) =>
  (withDefault ? `<option value="">Ikut bawaan</option>` : "") +
  Object.entries(FILMS).map(([id, f]) =>
    `<option value="${id}" ${id === current ? "selected" : ""}>${esc(f.name)} — ${esc(f.desc)}</option>`).join("");

// Pilihan tiga keadaan untuk override per acara: bawaan / ya / tidak
const triOptions = (v) => `
  <option value="" ${v == null ? "selected" : ""}>Ikut pengaturan global</option>
  <option value="true" ${v === true ? "selected" : ""}>Ya</option>
  <option value="false" ${v === false ? "selected" : ""}>Tidak</option>`;
const triValue = (s) => (s === "" ? null : s === "true");

// Link undangan: tautan khusus (domain/<slug>) bila ada, kalau tidak ?kode=. Kode tetap berlaku.
export const inviteLink = (ev) => (ev.slug ? `${location.origin}/${ev.slug}` : `${location.origin}/?kode=${ev.join_code}`);

// Data kartu QR siap cetak dari status acara
export const cardData = (ev) => ({
  name: ev.name, code: ev.join_code, link: inviteLink(ev),
  coverUrl: coverUrl(ev.cover_path), maxShots: ev.max_shots, starts: ev.starts_at, ends: ev.ends_at,
});

// Duplikat acara: pengaturan, undangan, dan sampul; lalu buka Panel acara baru
export async function duplicateEvent(ev) {
  if (!(await confirmDialog({
    title: `Duplikat "${ev.name}"?`,
    text: "Pengaturan, daftar undangan, dan sampul disalin ke acara baru. Peserta, foto, dan jadwal tidak ikut. Kode undangan baru dibuat.",
    ok: "Duplikat",
  }))) return null;
  try {
    const id = await rpc("duplicate_event", { p_event: ev.event_id });
    if (ev.cover_path) {
      const to = `${id}/${crypto.randomUUID()}.jpg`;
      try { await copyCover(ev.cover_path, to); await rpc("set_cover", { p_event: id, p_path: to }); }
      catch { toast("Acara diduplikat, tetapi sampul gagal disalin. Pasang sampul dari Panel.", 5000); }
    }
    toast("Acara diduplikat. Atur jadwalnya di Pengaturan.");
    location.hash = `#/e/${id}/panel`;
    return id;
  } catch (e) { toast(friendly(e)); return null; }
}

export async function renderPanel(root, status, { reload, home }) {
  const theme = status.collage_theme || {};
  const link = inviteLink(status);
  const tabKey = `panelTab:${status.event_id}`;
  const endedBySchedule = !status.is_open && status.ends_at && new Date(status.ends_at) <= new Date();
  const when = fmtRange(status.starts_at, status.ends_at);
  const view = el(`
    <section class="panel">
      ${status.is_admin && !status.is_owner ? `<p class="pill admin-pill">Anda mengelola acara ini sebagai superadmin</p>` : ""}
      ${status.pay_status === "draft" ? `
      <div class="review-banner pay-banner" role="status">
        <div><b>Acara belum dibayar</b>
          <small>Tamu belum bisa bergabung dan kamera belum aktif. Selesaikan pembayaran untuk mengaktifkan QR undangan.</small></div>
        <div class="row tight">
          <button type="button" class="btn small primary" data-act="pay">Bayar sekarang</button>
          ${status.is_admin ? `<button type="button" class="btn small" data-act="mark-paid">Tandai lunas (manual)</button>` : ""}
        </div>
      </div>` : ""}
      ${status.needs_review ? `
      <div class="review-banner" role="status">
        <div><b>Menunggu tinjauan superadmin</b>
          <small>Acara sebesar ini dicek dulu kapasitasnya pada tanggalnya. Tamu sudah bisa bergabung; kamera aktif setelah tinjauan selesai.</small></div>
        ${status.is_admin ? `<button type="button" class="btn small primary" data-act="review">Tandai sudah ditinjau</button>` : ""}
      </div>` : ""}

      <div class="status-card">
        <div class="status-head">
          <span class="status-live${status.is_open ? " on" : ""}">${status.is_open ? "Terbuka · berlangsung" : endedBySchedule ? "Selesai sesuai jadwal" : "Ditutup"}</span>
          ${status.is_open && status.ends_at ? `<small>Tutup otomatis ${esc(new Date(status.ends_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }))}</small>`
            : when ? `<small>${esc(when)}</small>` : ""}
        </div>
        <h2 class="status-name">${esc(status.name)}</h2>
        <div class="status-stats">
          <div class="sstat"><b><span data-s="members">–</span><small>/${status.max_members}</small></b><span>peserta</span></div>
          <div class="sstat"><b data-s="photos">–</b><span>foto</span></div>
          <div class="sstat"><b data-s="rolls">–</b><span>film habis</span></div>
          <div class="sstat pending-stat" hidden><b data-s="pending">–</b><span>belum terunggah</span></div>
        </div>
        <div class="status-actions">
          <button class="btn sc-light" data-act="card">${ICON.printer} Bagikan QR</button>
          <button class="btn sc-outline" data-act="toggle-open">${status.is_open ? "Tutup acara" : "Buka acara"}</button>
        </div>
        <div class="status-more">
          <button class="linklike" data-act="upgrade" hidden>${ICON.people} Tambah tamu atau jepretan</button>
          <button class="linklike" data-act="share">${ICON.link} Salin link undangan</button>
          <a class="linklike" href="#/e/${status.event_id}/layar">${ICON.play} Mode layar</a>
        </div>
      </div>

      <nav class="subtabs" role="tablist" aria-label="Bagian panel">
        <button role="tab" data-tab="undangan">Undangan</button>
        <button role="tab" data-tab="peserta">Peserta</button>
        <button role="tab" data-tab="pengaturan">Pengaturan</button>
        <button role="tab" data-tab="album">Album<span class="tab-count" hidden></span></button>
      </nav>

      <div class="subpanel two-col" data-tab="undangan" role="tabpanel">
        <div class="card">
          <h3>Undangan</h3>
          <div class="invite">
            <canvas class="qr" aria-label="Kode QR undangan"></canvas>
            <div>
              <p class="code">${esc(status.join_code)}</p>
              <p class="link">${esc(link)}</p>
              <div class="row">
                <button class="btn small" data-act="copy">Salin link</button>
                <button class="btn small" data-act="qr">Unduh QR</button>
                <button class="btn small ghost" data-act="rotate">Ganti kode</button>
              </div>
            </div>
          </div>
          <div class="qr-card-box">
            <b>Kartu QR siap cetak</b>
            <p class="hint">Ukuran A6 dengan sampul, nama acara, jadwal, QR, dan kode. Taruh di meja tamu atau tempel di pintu masuk.</p>
            <div class="row">
              <button class="btn small primary" data-act="card-dl">Unduh kartu (PNG)</button>
              <button class="btn small" data-act="card-print">${ICON.printer} Cetak</button>
            </div>
          </div>
        </div>
        <div class="card">
          <h3>Sampul / kartu undangan</h3>
          <p class="hint">Tampil di layar masuk acara dan di atas halaman acara. JPG/PNG, diperkecil otomatis.</p>
          <div class="cover-edit">
            <div class="cover-preview">${status.cover_path ? `<img alt="Sampul acara" src="${esc(coverUrl(status.cover_path))}" />` : `<span>Belum ada sampul</span>`}</div>
            <div class="row">
              <label class="btn small">Pilih gambar<input type="file" accept="image/*" data-act="cover" hidden /></label>
              ${status.cover_path ? `<button class="btn small ghost" data-act="uncover">Hapus sampul</button>` : ""}
            </div>
          </div>
        </div>
      </div>

      <div class="subpanel" data-tab="peserta" role="tabpanel" hidden>
        <div class="funnel-card"><span class="fc-title">Funnel tamu</span><div class="funnel" aria-label="Perjalanan peserta"></div></div>
        <div class="member-tools">
          <input type="search" placeholder="Cari nama atau email" aria-label="Cari peserta" data-act="member-search" />
          <button class="btn small" data-act="member-csv">${ICON.download} Laporan (CSV)</button>
          <select aria-label="Urutkan peserta" data-act="member-sort">
            <option value="joined">Urut waktu masuk</option>
            <option value="shots">Jepretan terbanyak</option>
            <option value="pending">Ada yang belum terunggah</option>
          </select>
        </div>
        <p class="hint member-count"></p>
        <div class="member-list"><p class="hint">Memuat…</p></div>
      </div>

      <div class="subpanel" data-tab="pengaturan" role="tabpanel" hidden>
        <form class="card settings">
          <h3>Pengaturan acara</h3>
          <label>Nama acara <input name="name" required maxlength="80" value="${esc(status.name)}" /></label>
          <div class="date-row">
            <label>Mulai <input type="datetime-local" name="starts_at" value="${toLocalInput(status.starts_at)}" /></label>
            <label>Selesai <input type="datetime-local" name="ends_at" value="${toLocalInput(status.ends_at)}" /></label>
          </div>
          <p class="hint">Opsional. Saat waktu selesai lewat, acara tertutup otomatis dan semua foto terbuka di album.</p>
          <label>Kalimat sambutan (opsional)
            <textarea name="welcome_text" rows="2" maxlength="300" placeholder="Contoh: Abadikan momen bahagia kami, ya!">${esc(status.welcome_text || "")}</textarea>
          </label>
          <label>Efek film bawaan <select name="film">${filmOptions(status.ev_film || status.film)}</select></label>
          <label class="check"><input type="checkbox" name="allow_film_choice" ${status.allow_film_choice ? "checked" : ""}/> Tamu boleh memilih efek film sendiri</label>
          <label class="check"><input type="checkbox" name="hide_names" ${status.hide_names ? "checked" : ""}/> Sembunyikan nama pengunggah (hanya Anda dan superadmin yang tahu)</label>
          <label>Ditampilkan sebagai penyelenggara <input name="host_name" maxlength="60" placeholder="Contoh: Panitia Wisuda" value="${esc(status.host_name || "")}" /></label>
          <label>Tautan khusus
            <span class="slug-field"><span>${esc(location.host)}/</span><input name="slug" maxlength="40" autocomplete="off" spellcheck="false" placeholder="wisuda2026" value="${esc(status.slug || "")}" /></span></label>
          <p class="hint">Huruf kecil, angka, dan tanda hubung (3–40). Kode ${esc(status.join_code || "")} tetap berlaku.</p>
          <label class="check"><input type="checkbox" name="album_private" ${status.album_private ? "checked" : ""}/> Album hanya untuk penyelenggara (tamu cuma melihat fotonya sendiri)</label>
          <label class="check"><input type="checkbox" name="date_stamp" ${status.date_stamp !== false ? "checked" : ""}/> Cap tanggal di foto</label>
          <label class="check"><input type="checkbox" name="allow_gallery" ${status.allow_gallery ? "checked" : ""}/> Tamu boleh mengunggah dari galeri</label>
          <label class="check"><input type="checkbox" name="allow_front" ${status.allow_front !== false ? "checked" : ""}/> Tamu boleh memakai kamera depan</label>
          <label class="check"><input type="checkbox" name="lock_until_start" ${status.lock_until_start ? "checked" : ""}/> Kamera baru aktif saat acara dimulai (tamu melihat hitung mundur)</label>
          <fieldset class="collage-theme">
            <legend>Kolase tamu</legend>
            <label>Ornamen bawaan
              <select name="cl_ornament">${ORNAMENTS.map((o) => `<option value="${o.id}" ${(theme.ornament || "polos") === o.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
            <p class="hint">Ornamen yang boleh dipilih tamu:</p>
            <div class="orn-checks">${ORNAMENTS.map((o) => `
              <label class="check"><input type="checkbox" name="cl_allowed" value="${o.id}" ${!theme.allowed?.length || theme.allowed.includes(o.id) ? "checked" : ""}/> ${esc(o.name)}</label>`).join("")}
            </div>
            <label class="check"><input type="checkbox" name="cl_accent_on" ${theme.accent ? "checked" : ""}/> Warna aksen sendiri (konfeti)</label>
            <input type="color" name="cl_accent" aria-label="Warna aksen kolase" value="${esc(theme.accent || "#ff5c8a")}" />
            ${status.is_admin ? `
            <label class="check"><input type="checkbox" name="cl_logo_optional" ${theme.logo_optional ? "checked" : ""}/> Tamu boleh mematikan logo Jepretin (acara berbayar)</label>`
            : `<p class="hint">Logo Jepretin ${theme.logo_optional ? "boleh dimatikan tamu di acara ini." : "wajib tampil di kolase acara gratis."}</p>`}
          </fieldset>
          <details class="advanced">
            <summary>Pengaturan lanjutan</summary>
            <label class="check"><input type="checkbox" name="reveal" ${status.reveal_at ? "checked" : ""}/> Mode cuci film: semua foto tampil bersamaan pada</label>
            <input type="datetime-local" name="reveal_at" aria-label="Waktu cuci film" value="${toLocalInput(status.reveal_at)}" />
            <label style="margin-top:.75rem">Rencana hapus foto <input type="date" name="purge_at" value="${status.purge_at ? toLocalInput(status.purge_at).slice(0, 10) : ""}" /></label>
            <label class="check"><input type="checkbox" name="invite_only" ${status.invite_only ? "checked" : ""}/> Hanya email di daftar undangan</label>
            <textarea name="invites" rows="4" placeholder="Satu email per baris" aria-label="Daftar email undangan" ${status.invite_only ? "" : "hidden"}></textarea>
            ${status.is_admin ? `
            <fieldset class="admin-only">
              <legend>Khusus superadmin</legend>
              <label>Resolusi foto
                <select name="photo_max_side">
                  <option value="">Ikut pengaturan global</option>
                  ${RESOLUTIONS.map((r) => `<option value="${r}" ${status.ev_photo_max_side === r ? "selected" : ""}>${r} px</option>`).join("")}
                </select>
              </label>
              <label>Cerminkan jendela bidik kamera depan <select name="mirror_preview">${triOptions(status.ev_mirror_preview)}</select></label>
              <label>Cerminkan hasil foto kamera depan <select name="mirror_photo">${triOptions(status.ev_mirror_photo)}</select></label>
            </fieldset>` : ""}
          </details>
          <button class="btn primary" type="submit">Simpan</button>
        </form>
        <div class="card pay-history" hidden>
          <h3>Pembayaran</h3>
          <div class="pay-history-list"></div>
        </div>
        <div class="card">
          <h3>Acara berikutnya</h3>
          <p class="hint">Buat acara baru dengan pengaturan, undangan, dan sampul yang sama. Peserta dan foto tidak ikut.</p>
          <button class="btn small" data-act="duplicate">${ICON.copy} Duplikat acara</button>
        </div>
      </div>

      <div class="subpanel two-col" data-tab="album" role="tabpanel" hidden>
        <div class="card reports-card span-2" hidden>
          <h3 class="with-icon">${ICON.shield}<span>Laporan foto dari tamu</span></h3>
          <div class="report-list"></div>
        </div>
        <div class="card">
          <h3>Unduh album</h3>
          <p class="hint">Semua foto ukuran penuh sebagai ZIP. Album besar dibagi menjadi beberapa file berisi paling banyak ${ZIP_PART} foto supaya memori perangkat tidak habis.</p>
          <button class="btn" data-act="zip">Unduh album (ZIP)</button>
          <p class="zip-progress hint" hidden></p>
          <div class="zip-parts" hidden></div>
        </div>
        <div class="card danger">
          <h3>Hapus acara</h3>
          <p class="hint">Menghapus semua foto dari server beserta data acara. Unduh album dulu. Tidak bisa dibatalkan.</p>
          <button class="btn danger" data-act="delete">Hapus acara dan semua foto</button>
        </div>
      </div>
    </section>`);
  root.replaceChildren(view);
  // --- pembayaran ---
  view.querySelector('[data-act="pay"]')?.addEventListener("click", () => openPayment(status, { onPaid: reload }));
  view.querySelector('[data-act="mark-paid"]')?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;   // e.currentTarget kosong lagi setelah await
    if (!(await confirmDialog({ title: "Tandai acara sudah dibayar?", text: "Pakai bila pembayaran diterima di luar Midtrans. Tercatat di log.", ok: "Tandai lunas" }))) return;
    btn.disabled = true;
    try { await rpc("admin_set_pay_status", { p_event: status.event_id, p_status: "paid" }); toast("Acara ditandai lunas."); reload(); }
    catch (err) { toast(friendly(err)); btn.disabled = false; }
  });
  let membersNow = null;
  paymentsOn().then((on) => {
    if (!on || status.pay_status === "draft") return;
    const b = view.querySelector('[data-act="upgrade"]');
    b.hidden = false;
    b.onclick = () => openUpgrade(status, { members: membersNow, onPaid: reload });
  });
  rpc("event_orders", { p_event: status.event_id }).then((rows) => {
    if (!rows?.length) return;
    const card = view.querySelector(".pay-history");
    card.hidden = false;
    const LABEL = { pending: ["Menunggu", "warn"], paid: ["Lunas", "ok"], expired: ["Kedaluwarsa", ""], failed: ["Gagal", "bad"], refunded: ["Dikembalikan", "bad"] };
    card.querySelector(".pay-history-list").innerHTML = rows.map((o) => {
      const [l, tone] = LABEL[o.status] || [o.status, ""];
      return `<div class="pay-row"><div><b>${rp(o.amount)}</b><small>${o.kind === "upgrade" ? "Tambah" : "Acara"} ${o.guests} tamu × ${o.shots} · ${esc(fmtDate(o.paid_at || o.created_at))} · <code>${esc(o.id)}</code></small></div><span class="tag ${tone}">${l}</span></div>`;
    }).join("");
  }).catch(() => {});

  view.querySelector('[data-act="review"]')?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await rpc("review_event", { p_event: status.event_id }); toast("Acara ditandai sudah ditinjau."); reload(); }
    catch (err) { toast(friendly(err)); btn.disabled = false; }
  });
  const form = view.querySelector("form.settings");

  // --- sub-tab ---
  function selectTab(name) {
    view.querySelectorAll(".subtabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    view.querySelectorAll(".subpanel").forEach((p) => { p.hidden = p.dataset.tab !== name; });
    try { sessionStorage.setItem(tabKey, name); } catch { /* abaikan */ }
  }
  view.querySelectorAll(".subtabs [role=tab]").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
  let firstTab = null;
  try { firstTab = sessionStorage.getItem(tabKey); } catch { /* abaikan */ }
  selectTab(firstTab || "undangan");

  // --- kartu status ---
  view.querySelector('[data-act="toggle-open"]').onclick = async (e) => {
    const b = e.currentTarget;
    const open = !status.is_open;
    if (!open && !(await confirmDialog({
      title: "Tutup acara?",
      text: "Peserta tidak bisa memotret lagi, dan foto semua peserta langsung terbuka di album.",
      ok: "Tutup acara",
    }))) return;
    b.disabled = true;
    try {
      await rpc("set_event", { p_event: status.event_id, p_patch: { is_open: open } });
      if (!open) { pingAlbum(status.event_id, "closed"); kickNotify(true); }
      toast(open ? "Acara dibuka." : "Acara ditutup.");
      reload();
    } catch (err) { toast(friendly(err)); b.disabled = false; }
  };
  view.querySelector('[data-act="share"]').onclick = () => copyText(link, { done: "Link undangan disalin." });
  view.querySelector('[data-act="card"]').onclick = () => {
    selectTab("undangan");
    view.querySelector(".qr-card-box").scrollIntoView({ block: "center" });
  };
  view.querySelector('[data-act="card-dl"]').onclick = () => downloadQrCard(cardData(status)).catch((e) => toast(friendly(e)));
  view.querySelector('[data-act="card-print"]').onclick = () => printQrCard(cardData(status)).catch((e) => toast(friendly(e)));
  view.querySelector('[data-act="duplicate"]').onclick = () => duplicateEvent(status);

  // --- laporan foto ---
  async function loadReports() {
    let rows = [];
    try { rows = await rpc("list_reports", { p_event: status.event_id }); } catch { return; }
    const card = view.querySelector(".reports-card");
    const count = view.querySelector(".tab-count");
    card.hidden = !rows.length;
    count.hidden = !rows.length;
    count.textContent = rows.length;
    if (rows.length) renderReports(card.querySelector(".report-list"), rows, { onChange: loadReports });
  }
  loadReports();
  rpc("event_stats", { p_event: status.event_id }).then((st) => {
    if (!st) return;
    const set = (k, v) => { view.querySelector(`[data-s="${k}"]`).textContent = Number(v).toLocaleString("id-ID"); };
    set("members", st.members); set("photos", st.photos); set("rolls", st.rolls_done); set("pending", st.pending);
    membersNow = st.members;
    view.querySelector(".pending-stat").hidden = !st.pending;
    // Funnel tamu: batang tegak, angka dan label di bawahnya
    const top = Math.max(st.members, 1);
    const steps = [["masuk", st.members], ["memotret", st.shooters], ["film habis", st.rolls_done], ["mengunduh", st.downloaders]];
    view.querySelector(".funnel").innerHTML = `
      <div class="fn-bars" aria-hidden="true">${steps.map(([, n], i) =>
        `<span style="height:${Math.max(4, Math.round((n / top) * 100))}%;opacity:${1 - i * 0.15}"></span>`).join("")}</div>
      <div class="fn-labels">${steps.map(([l, n]) => `<span><b>${n}</b>${l}</span>`).join("")}</div>`;
  }).catch(() => {});

  // --- undangan ---
  QRCode.toCanvas(view.querySelector(".qr"), link, { width: 180, margin: 1 });
  view.querySelector('[data-act="copy"]').onclick = () => copyText(link);
  view.querySelector('[data-act="qr"]').onclick = async () => {
    const url = await QRCode.toDataURL(link, { width: 1024, margin: 2 });
    download(url, `undangan-${status.join_code}.png`);
  };
  view.querySelector('[data-act="rotate"]').onclick = async () => {
    if (!(await confirmDialog({
      title: "Ganti kode undangan?",
      text: "Link dan QR lama tidak bisa dipakai lagi. Peserta yang sudah masuk tetap aman.",
      ok: "Ganti kode",
    }))) return;
    try { await rpc("rotate_code", { p_event: status.event_id }); toast("Kode diganti."); reload(); }
    catch (e) { toast(friendly(e)); }
  };

  // --- sampul ---
  view.querySelector('[data-act="cover"]').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const cropped = await openCrop(file).catch(() => null);
    if (!cropped) return; // dibatalkan / gagal dibaca
    try {
      toast("Mengunggah sampul…", 20000);
      const path = `${status.event_id}/${crypto.randomUUID()}.jpg`;
      await uploadCover(path, cropped);
      const old = await rpc("set_cover", { p_event: status.event_id, p_path: path });
      await removeCover(old).catch(() => {});
      toast("Sampul tersimpan.");
      reload();
    } catch (err) { toast(friendly(err)); }
  };
  const uncover = view.querySelector('[data-act="uncover"]');
  if (uncover) uncover.onclick = async () => {
    if (!(await confirmDialog({ title: "Hapus sampul acara?", ok: "Hapus sampul", danger: true }))) return;
    try {
      const old = await rpc("set_cover", { p_event: status.event_id, p_path: null });
      await removeCover(old).catch(() => {});
      reload();
    } catch (err) { toast(friendly(err)); }
  };

  // --- pengaturan ---
  const invitesBox = form.elements.invites;
  form.elements.invite_only.onchange = (e) => { invitesBox.hidden = !e.target.checked; };
  if (status.invite_only) {
    rpc("get_invites", { p_event: status.event_id })
      .then((rows) => { invitesBox.value = rows.map((r) => r.get_invites ?? r).join("\n"); })
      .catch(() => {});
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const reveal = f.reveal.checked ? fromLocalInput(f.reveal_at.value) : null;
    if (f.reveal.checked && !reveal) return toast("Isi waktu cuci film.");
    const startsAt = fromLocalInput(f.starts_at.value), endsAt = fromLocalInput(f.ends_at.value);
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) return toast("Waktu selesai harus setelah waktu mulai.");
    if (f.lock_until_start.checked && !startsAt) return toast("Isi waktu mulai supaya kamera bisa aktif otomatis saat acara dimulai.");
    const patch = {
      name: f.name.value,
      welcome_text: f.welcome_text.value,
      film: f.film.value,
      hide_names: f.hide_names.checked,
      host_name: f.host_name.value,
      slug: f.slug.value.trim().toLowerCase(),
      album_private: f.album_private.checked,
      date_stamp: f.date_stamp.checked,
      allow_gallery: f.allow_gallery.checked,
      allow_front: f.allow_front.checked,
      lock_until_start: f.lock_until_start.checked,
      allow_film_choice: f.allow_film_choice.checked,
      reveal_at: reveal,
      purge_at: f.purge_at.value ? new Date(f.purge_at.value + "T00:00").toISOString() : null,
      invite_only: f.invite_only.checked,
      starts_at: startsAt,
      ends_at: endsAt,
    };
    // Tema kolase: semua ornamen dicentang = tanpa batasan; ornamen bawaan selalu ikut diizinkan
    const allowed = [...form.querySelectorAll('[name="cl_allowed"]:checked')].map((x) => x.value);
    if (!allowed.length) return toast("Pilih paling sedikit satu ornamen kolase.");
    const nextTheme = { ornament: f.cl_ornament.value };
    if (allowed.length < ORNAMENTS.length) nextTheme.allowed = [...new Set([...allowed, f.cl_ornament.value])];
    if (f.cl_accent_on.checked) nextTheme.accent = f.cl_accent.value;
    if (status.is_admin) nextTheme.logo_optional = f.cl_logo_optional.checked;
    else if (theme.logo_optional !== undefined) nextTheme.logo_optional = theme.logo_optional;
    if (JSON.stringify(nextTheme) !== JSON.stringify(theme)) patch.collage_theme = nextTheme;
    if (status.is_admin) {
      patch.photo_max_side = f.photo_max_side.value ? Number(f.photo_max_side.value) : null;
      patch.mirror_preview = triValue(f.mirror_preview.value);
      patch.mirror_photo = triValue(f.mirror_photo.value);
    }
    try {
      await rpc("set_event", { p_event: status.event_id, p_patch: patch });
      if (f.invite_only.checked) {
        const emails = invitesBox.value.split(/[\s,;]+/).filter(Boolean);
        const n = await rpc("set_invites", { p_event: status.event_id, p_emails: emails });
        toast(`Tersimpan. ${n} email di daftar undangan.`);
      } else toast("Tersimpan.");
      reload();
    } catch (err) { toast(friendly(err)); }
  };

  // --- peserta: kartu dengan bilah progres ---
  let members = [];
  const listBox = view.querySelector(".member-list");
  const searchBox = view.querySelector('[data-act="member-search"]');
  const sortBox = view.querySelector('[data-act="member-sort"]');
  function renderMembers() {
    const q = searchBox.value.trim().toLowerCase();
    let rows = members.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.email || "").toLowerCase().includes(q));
    if (sortBox.value === "shots") rows = [...rows].sort((a, b) => b.shots_used - a.shots_used);
    if (sortBox.value === "pending") rows = rows.filter((m) => m.pending > 0);
    view.querySelector(".member-count").textContent =
      `${members.length} dari maks. ${status.max_members} peserta${rows.length !== members.length ? ` · ${rows.length} ditampilkan` : ""}. Ketuk nama untuk melihat gulungannya.`;
    if (!rows.length) { listBox.replaceChildren(el(`<p class="hint">Tidak ada peserta yang cocok.</p>`)); return; }
    listBox.replaceChildren(...rows.map((m) => {
      const pct = Math.round((Math.min(m.shots_used, status.max_shots) / status.max_shots) * 100);
      const n = el(`
        <div class="member-card${m.blocked ? " blocked" : ""}">
          <span class="mc-avatar" aria-hidden="true">${initial(m.name)}</span>
          <div class="mc-main">
            <div class="mc-row"><button class="linklike" data-act="roll">${esc(m.name)}</button>
              ${m.blocked ? `<span class="tag bad">diblokir</span>` : ""}
              <span class="mc-used">${m.shots_used}/${status.max_shots}</span></div>
            <div class="bar thin mint"><span style="width:${pct}%"></span></div>
            <small>${esc(m.email)}${m.pending ? ` · <b>${m.pending} belum terunggah</b>` : ""}</small>
          </div>
          <button class="mc-menu" data-act="menu" aria-label="Aksi untuk ${esc(m.name)}">${ICON.moreV}</button>
        </div>`);
      n.querySelector('[data-act="roll"]').onclick = () => showRoll(status, m);
      n.querySelector('[data-act="menu"]').onclick = () => actionSheet(m.name, [
        { label: "Lihat gulungan", run: () => showRoll(status, m) },
        ...(m.pending ? [{ label: `Lepas ${m.pending} jepretan macet…`, run: () => releasePending(m) }] : []),
        ...(m.user_id === status.me ? [] : [{
          label: m.blocked ? "Pulihkan akses" : "Blokir dari acara ini", danger: !m.blocked,
          run: () => setBlocked(m, !m.blocked),
        }]),
      ]);
      return n;
    }));
  }
  view.querySelector('[data-act="member-csv"]').onclick = () => downloadCsv(`laporan-${safeName(status.name, "acara")}`, [
    ["name", "Nama"], ["email", "Email"], ["shots_used", "Jepretan"], [() => status.max_shots, "Jatah"],
    [(m) => (m.shots_used >= status.max_shots ? "ya" : "tidak"), "Film habis"], ["pending", "Belum terunggah"],
    [(m) => (m.blocked ? "ya" : "tidak"), "Diblokir"], [(m) => fmtDate(m.joined_at), "Masuk"],
  ], members);
  searchBox.oninput = renderMembers;
  sortBox.onchange = renderMembers;

  async function loadMembers() {
    try {
      members = await rpc("list_members", { p_event: status.event_id });
      renderMembers();
    } catch (e) { listBox.textContent = friendly(e); }
  }
  async function setBlocked(m, blocked) {
    if (blocked && !(await confirmDialog({
      title: `Blokir ${m.name}?`,
      text: "Peserta ini tidak bisa memotret lagi dan tidak bisa melihat album acara ini.",
      ok: "Blokir", danger: true,
    }))) return;
    try {
      await rpc("block_member", { p_event: status.event_id, p_user: m.user_id, p_blocked: blocked });
      loadMembers();
    } catch (e) { toast(friendly(e)); }
  }
  async function releasePending(m) {
    if (!(await confirmDialog({
      title: "Lepas jepretan yang macet?",
      text: "Jepretan yang belum terunggah dihapus dan jatahnya dikembalikan. Jika HP peserta masih menyimpan fotonya, foto itu akan dikirim ulang sebagai jepretan baru.",
      ok: "Lepas jepretan",
    }))) return;
    try {
      const rows = await rpc("release_pending", { p_event: status.event_id, p_user: m.user_id });
      const paths = rows.map((r) => r.file_path ?? r.release_pending ?? r);
      await removeFiles(paths).catch(() => {});
      toast("Jepretan macet dilepas.");
      loadMembers();
    } catch (e) { toast(friendly(e)); }
  }
  loadMembers();

  // --- unduh ZIP (bertahap supaya memori tidak habis) ---
  view.querySelector('[data-act="zip"]').onclick = async (ev) => {
    const btn = ev.currentTarget;
    const prog = view.querySelector(".zip-progress");
    const partsBox = view.querySelector(".zip-parts");
    btn.disabled = true;
    try {
      const rows = (await rpc("owner_paths", { p_event: status.event_id })).filter((r) => r.status === "ready");
      if (!rows.length) { toast("Belum ada foto."); return; }
      const parts = [];
      for (let i = 0; i < rows.length; i += ZIP_PART) parts.push(rows.slice(i, i + ZIP_PART));
      if (parts.length === 1) { await downloadPart(parts[0], 1, 1, prog); return; }
      partsBox.hidden = false;
      partsBox.replaceChildren(
        el(`<p class="hint">${rows.length} foto dibagi menjadi ${parts.length} file. Unduh satu per satu.</p>`),
        ...parts.map((p, i) => {
          const b = el(`<button class="btn small">Bagian ${i + 1} dari ${parts.length} · ${p.length} foto</button>`);
          b.onclick = async () => {
            b.disabled = true;
            try {
              await downloadPart(p, i + 1, parts.length, prog);
              b.innerHTML = `${ICON.check} Bagian ${i + 1} terunduh`;
            } catch (e) { toast(friendly(e)); b.disabled = false; }
          };
          return b;
        }));
    } catch (e) {
      toast(friendly(e));
      prog.hidden = true;
    } finally { btn.disabled = false; }
  };

  async function downloadPart(rows, n, total, prog) {
    prog.hidden = false;
    const label = total > 1 ? `Bagian ${n}/${total}: ` : "";
    const files = {};
    for (let i = 0; i < rows.length; i += 25) {
      const batch = rows.slice(i, i + 25);
      const urls = await getUrls(batch.map((r) => r.file_path));
      await Promise.all(batch.map(async (r) => {
        const res = await fetch(urls[r.file_path]);
        if (!res.ok) throw new Error("Gagal mengunduh " + r.file_path);
        files[`${safeName(r.owner_name, "peserta")}/${String(r.seq).padStart(2, "0")}.jpg`] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
      }));
      prog.textContent = `${label}mengambil ${Math.min(i + 25, rows.length)} / ${rows.length} foto…`;
    }
    prog.textContent = `${label}membuat ZIP…`;
    const zip = zipSync(files);
    const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    const base = safeName(status.name, "album");
    download(url, total > 1 ? `${base}-bagian-${String(n).padStart(2, "0")}.zip` : `${base}.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    prog.textContent = `Selesai: ${rows.length} foto${total > 1 ? ` (bagian ${n} dari ${total})` : ""}.`;
  }

  // --- hapus acara ---
  view.querySelector('[data-act="delete"]').onclick = async () => {
    if (!(await typeToConfirm({
      title: "Hapus acara dan semua foto?",
      text: "Semua foto dihapus dari server beserta data acara. Unduh album dulu. Tidak bisa dibatalkan.",
      expect: status.name,
      ok: "Hapus acara",
    }))) return;
    try {
      await deleteEventFiles(status.event_id, status.cover_path);
      await rpc("delete_event", { p_event: status.event_id });
      toast("Acara dihapus.");
      home();
    } catch (e) { toast(friendly(e)); }
  };

  return () => {};
}

// Hapus semua file acara (foto 3 ukuran + sampul) sebelum barisnya dihapus
export async function deleteEventFiles(eventId, coverPath) {
  const rows = await rpc("owner_paths", { p_event: eventId });
  await removeFiles(rows.flatMap((r) => [r.file_path, r.thumb_path, r.medium_path].filter(Boolean)));
  await removeCover(coverPath).catch(() => {});
  // Rekaman suara buku tamu (database lama belum punya fungsinya: lewati)
  const voices = await rpc("owner_voice_paths", { p_event: eventId }).catch(() => []);
  const vp = voices.map((v) => (typeof v === "string" ? v : v.owner_voice_paths)).filter(Boolean);
  if (vp.length) await removeVoices(vp).catch(() => {});
}

// Gulungan satu tamu: semua jepretannya, termasuk yang belum tampil di album
export async function showRoll(status, member) {
  const { box, close } = modal(`
    <div class="roll">
      <div class="roll-head">
        <div><h3>${esc(member.name)}</h3><p class="hint">${esc(member.email)} · ${member.shots_used}/${status.max_shots} jepretan</p></div>
        <button class="btn small" data-act="close">Tutup</button>
      </div>
      <div class="grid roll-grid"><p class="hint">Memuat…</p></div>
    </div>`, { wide: true });
  box.querySelector('[data-act="close"]').onclick = close;
  const grid = box.querySelector(".roll-grid");
  try {
    const rows = await rpc("get_roll", { p_event: status.event_id, p_user: member.user_id });
    const ready = rows.filter((r) => r.status === "ready");
    const urls = await getUrls(ready.map((r) => r.thumb_path));
    const time = (iso) => new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    const slots = [];
    const total = Math.max(status.max_shots, ...rows.map((r) => r.seq));
    for (let i = 1; i <= total; i++) {
      const r = rows.find((x) => x.seq === i);
      if (!r) slots.push(`<div class="tile slot empty-slot"><span>${i}</span></div>`);
      else if (r.status !== "ready") slots.push(`<div class="tile slot"><span>${i}</span><span class="badge">belum terunggah</span></div>`);
      else slots.push(`
        <button class="tile${r.hidden ? " is-hidden" : ""}" data-i="${ready.indexOf(r)}" aria-label="Foto ${i}, ${esc(fmtDate(r.taken_at))}">
          <img loading="lazy" alt="" src="${esc(urls[r.thumb_path] || "")}" />
          <span class="badge">${i} · ${esc(time(r.taken_at))}</span>
          ${r.hidden ? `<span class="badge mine hidden-tag">disembunyikan</span>` : ""}
        </button>`);
    }
    grid.innerHTML = slots.join("");
    grid.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => openRollViewer(member, ready, Number(b.dataset.i))));
  } catch (e) { grid.textContent = friendly(e); }
}

// Penampil foto gulungan: sama seperti penampil Album (geser, panah, zoom), di atas jendela gulungan
function openRollViewer(member, list, start) {
  let idx = start;
  const box = el(`
    <div class="lightbox over-modal" role="dialog" aria-modal="true" aria-label="Foto ${esc(member.name)}">
      <div class="lb-top">
        <span class="lb-count"></span>
        <button class="lb-icon" data-act="close" aria-label="Tutup">×</button>
      </div>
      <div class="lb-stage"><img class="lb-img" alt="" draggable="false" /></div>
      <button class="lb-nav prev" data-act="prev" aria-label="Foto sebelumnya">‹</button>
      <button class="lb-nav next" data-act="next" aria-label="Foto berikutnya">›</button>
      <div class="lb-bar"><span class="lb-info"><span class="lb-who"></span><small class="lb-film"></small></span></div>
    </div>`);
  const img = box.querySelector(".lb-img");
  const before = document.activeElement;
  document.body.append(box);
  box.querySelector('[data-act="close"]').focus();
  const cache = new Map();
  async function url(r) {
    if (!cache.has(r.medium_path)) cache.set(r.medium_path, (await getUrls([r.medium_path]))[r.medium_path]);
    return cache.get(r.medium_path);
  }
  async function show() {
    const r = list[idx];
    box.querySelector(".lb-count").textContent = `${idx + 1} / ${list.length}`;
    box.querySelector(".lb-who").textContent = `${member.name} · #${r.seq} · ${fmtDate(r.taken_at)}`;
    box.querySelector(".lb-film").textContent = r.hidden ? "Disembunyikan dari album" : "";
    box.querySelector('[data-act="prev"]').disabled = idx <= 0;
    box.querySelector('[data-act="next"]').disabled = idx >= list.length - 1;
    zoom.reset();
    img.classList.add("loading");
    try { const u = await url(r); if (list[idx] === r) img.src = u; } catch (e) { toast(friendly(e)); }
    if (list[idx + 1]) url(list[idx + 1]).then((u) => { new Image().src = u; }).catch(() => {});
  }
  const step = (d) => { const n = idx + d; if (n >= 0 && n < list.length) { idx = n; show(); } };
  const zoom = attachZoom(box.querySelector(".lb-stage"), img, { onSwipe: step });
  img.onload = () => { img.classList.remove("loading"); zoom.measure(); };
  // Esc menutup penampil saja, bukan jendela gulungan di belakangnya
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopImmediatePropagation(); close(); }
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
  };
  document.addEventListener("keydown", onKey, true);
  function close() {
    document.removeEventListener("keydown", onKey, true);
    zoom.destroy();
    box.remove();
    before?.focus?.();
  }
  box.querySelector('[data-act="close"]').onclick = close;
  box.querySelector('[data-act="prev"]').onclick = () => step(-1);
  box.querySelector('[data-act="next"]').onclick = () => step(1);
  show();
}
