// Dashboard: #/admin/<tab>. Superadmin melihat semua tab;
// pembuat acara hanya tab Acara (acaranya sendiri), yang menjadi pusat kerjanya.
import { rpc, friendly } from "./supabase.js";
import { FILMS, filmName } from "./film.js";
import { RESOLUTIONS, deleteEventFiles } from "./owner.js";
import {
  el, esc, toast, fmtDate, fmtBytes, confirmDialog, typeToConfirm, actionSheet, modal, copyText, ICON,
} from "./ui.js";

const TABS = [
  ["ringkasan", "Ringkasan"],
  ["acara", "Acara"],
  ["pengguna", "Pengguna & peran"],
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
  const view = el(`
    <main class="page admin wide">
      <header class="top">
        <a class="back" href="#/" aria-label="Kembali ke beranda">‹</a>
        <h1>Dashboard</h1>
        <span class="pill small-pill">${role === "superadmin" ? "Superadmin" : "Pembuat acara"}</span>
      </header>
      ${tabs.length > 1 ? `<nav class="tabs scroll" aria-label="Bagian dashboard">
        ${tabs.map(([t, n]) => `<a href="#/admin/${t}" class="${t === tab ? "on" : ""}" ${t === tab ? 'aria-current="page"' : ""}>${n}</a>`).join("")}
      </nav>` : ""}
      <div class="admin-body"><p class="hint">Memuat…</p></div>
    </main>`);
  setView(view);
  const body = view.querySelector(".admin-body");
  const render = { ringkasan, acara, pengguna, pengaturan, log }[tab];
  try { await render(body, me, role); }
  catch (e) { body.replaceChildren(el(`<p class="hint">${esc(friendly(e))}</p>`)); }
}

// ---------- Pembantu tampilan ----------
const stat = (label, value, sub) => `
  <div class="stat"><b>${Number(value).toLocaleString("id-ID")}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const funnelRow = (label, n, of, cls = "") => `
  <div class="funnel-row"><span>${label}</span><div class="bar ${cls}"><span style="width:${pct(n, of)}%"></span></div><b>${n}</b></div>`;
function funnelHtml(e) {
  const of = Math.max(e.members, 1);
  return funnelRow(`Peserta / ${e.max_members}`, e.members, e.max_members) +
    funnelRow("Memotret", e.shooters, of) +
    funnelRow("Film habis", e.rolls_done, of, "mint") +
    funnelRow("Mengunduh", e.downloaders, of);
}

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

// ---------- Buat acara (dipakai juga dari beranda) ----------
export async function createEventDialog() {
  let settings, quota;
  try {
    [settings, quota] = await Promise.all([rpc("get_settings"), rpc("my_event_quota").catch(() => null)]);
  } catch (e) { toast(friendly(e)); return; }
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
  const { box, close } = modal(`
    <form class="dialog">
      <h3>Buat acara baru</h3>
      ${limited ? `<p>Sisa batas: <b>${left}</b> dari ${quota.limit} acara.</p>` : ""}
      <label>Nama acara <input name="name" required maxlength="80" autofocus placeholder="Contoh: Pernikahan Rani & Bima" /></label>
      <div class="row">
        <label>Jatah foto (maks. ${settings.max_shots_limit}) <input name="max_shots" type="number" min="1" max="${settings.max_shots_limit}" value="${Math.min(30, settings.max_shots_limit)}" /></label>
        <label>Maks. peserta <input name="max_members" type="number" min="1" max="${settings.max_members_limit}" value="${Math.min(60, settings.max_members_limit)}" /></label>
      </div>
      <label>Efek film bawaan
        <select name="film">${Object.entries(FILMS).map(([id, f]) => `<option value="${id}" ${id === settings.default_film ? "selected" : ""}>${esc(f.name)} — ${esc(f.desc)}</option>`).join("")}</select>
      </label>
      <label class="check"><input type="checkbox" name="invite_only" /> Hanya email yang diundang</label>
      <p class="hint">Sampul, undangan, dan pengaturan lain bisa diatur di Panel setelah acara dibuat.</p>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-act="no">Batal</button>
        <button class="btn primary">Buat acara</button>
      </div>
    </form>`);
  const form = box.querySelector("form");
  box.querySelector('[data-act="no"]').onclick = close;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const btn = form.querySelector(".btn.primary");
    btn.disabled = true;
    try {
      const id = await rpc("create_event", {
        p_name: f.name.value,
        p_max_shots: Number(f.max_shots.value),
        p_max_members: Number(f.max_members.value),
        p_invite_only: f.invite_only.checked,
        p_film: f.film.value,
      });
      close();
      location.hash = `#/e/${id}/panel`;
    } catch (err) { toast(friendly(err)); btn.disabled = false; }
  };
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
  const [o, overdue, errors, live] = await Promise.all([
    rpc("admin_overview"), rpc("admin_overdue_events"),
    rpc("admin_client_errors", { p_limit: 20 }), rpc("admin_live_events"),
  ]);
  const quota = Number(o.storage_quota_mb || 1024) * 1024 * 1024;
  const used = Number(o.photo_bytes) + Number(o.cover_bytes);
  const usedPct = Math.min(100, (used / quota) * 100);
  const avg = o.photos ? Number(o.photo_bytes) / o.photos : 0;
  const left = avg ? Math.max(0, Math.floor((quota - used) / avg)) : null;

  // Hal yang perlu ditindak, urut dari yang paling mendesak
  const items = [];
  if (usedPct > 85) items.push([`Storage terpakai ${usedPct.toFixed(0)}%`,
    left !== null ? `Cukup untuk sekitar ${left.toLocaleString("id-ID")} foto lagi. Turunkan resolusi atau hapus acara lama.` : "Turunkan resolusi atau hapus acara lama.",
    `<a class="btn small" href="#/admin/pengaturan">Pengaturan</a>`]);
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
        <ul class="attention-list">${items.map(([t, s, a]) => `<li><div><b>${esc(t)}</b><small>${esc(s)}</small></div>${a}</li>`).join("")}</ul>
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

      <div class="card">
        <h3>Storage</h3>
        <div class="meter" role="img" aria-label="Storage terpakai ${usedPct.toFixed(0)} persen"><span style="width:${usedPct.toFixed(1)}%" class="${usedPct > 85 ? "hot" : ""}"></span></div>
        <p class="hint">${fmtBytes(used)} dari ${fmtBytes(quota)} (${usedPct.toFixed(1)}%) · foto ${fmtBytes(o.photo_bytes)}, sampul ${fmtBytes(o.cover_bytes)}</p>
        ${left !== null ? `<p class="hint">Rata-rata ${fmtBytes(avg)} per foto (3 ukuran). Sisa cukup untuk sekitar <b>${left.toLocaleString("id-ID")}</b> foto lagi.</p>` : ""}
      </div>

      <div class="card errors-card">
        <h3>Kegagalan kamera terbaru</h3>
        ${errors.length ? `
        <div class="table-scroll"><table>
          <thead><tr><th>Waktu</th><th>Masalah</th><th>Peserta · acara</th><th>Perangkat</th></tr></thead>
          <tbody>${errors.map((r) => `
            <tr>
              <td><small>${esc(fmtDate(r.at))}</small></td>
              <td><b>${esc(ERROR_KINDS[r.kind] || r.kind)}</b>${r.detail ? `<details><summary>Detail</summary><code>${esc(r.detail)}</code></details>` : ""}</td>
              <td><small>${esc(r.user_name || "-")}<br>${esc(r.event_name || "-")}</small></td>
              <td><small>${esc(shortUA(r.ua))}</small></td>
            </tr>`).join("")}
          </tbody>
        </table></div>` : `<p class="hint">Belum ada laporan. Laporan dikirim otomatis saat kamera peserta gagal dibuka atau menampilkan gambar hitam.</p>`}
      </div>
    </div>`);
  body.replaceChildren(view);
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
          <option value="photos">Foto terbanyak</option>
          <option value="members">Peserta terbanyak</option>
          ${admin ? `<option value="bytes">Ukuran terbesar</option>` : ""}
          <option value="name">Nama (A–Z)</option>
        </select>
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
  view.querySelector('[data-act="create"]')?.addEventListener("click", () => createEventDialog());
  view.querySelector(".filter-slot").append(chips(
    [["all", "Semua"], ["open", "Terbuka"], ["closed", "Ditutup"], ...(admin ? [["overdue", "Lewat tanggal hapus"]] : [])],
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
        <table>
          <thead><tr>
            <th class="pick"><input type="checkbox" data-pick-all aria-label="Pilih semua di halaman ini" /></th>
            <th>Acara</th><th>Status</th><th class="num">Peserta</th><th class="num">Film habis</th>
            <th class="num">Foto</th><th class="num">Ukuran</th><th>Aktivitas</th><th></th>
          </tr></thead>
          <tbody>${rows.map((e) => `
            <tr data-id="${e.event_id}" class="${selected.has(e.event_id) ? "selected" : ""}">
              <td class="pick"><input type="checkbox" data-pick="${e.event_id}" ${selected.has(e.event_id) ? "checked" : ""} aria-label="Pilih ${esc(e.name)}" /></td>
              <td><a href="#/e/${e.event_id}/panel"><b>${esc(e.name)}</b></a><br><small>${esc(e.owner_name)} · ${esc(e.owner_email || "")}</small></td>
              <td><span class="tag ${e.is_open ? "ok" : ""}">${e.is_open ? "Terbuka" : "Ditutup"}</span>
                ${e.purge_at && new Date(e.purge_at) <= new Date() ? `<br><span class="tag bad">lewat tanggal hapus</span>` : ""}</td>
              <td class="num">${e.members}/${e.max_members}</td>
              <td class="num">${e.rolls_done}</td>
              <td class="num">${e.photos}${e.pending ? `<br><small>${e.pending} tertahan</small>` : ""}</td>
              <td class="num">${fmtBytes(e.bytes)}</td>
              <td><small>${esc(fmtDate(e.last_photo_at) || "-")}</small></td>
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
      <article class="card event-card" data-id="${e.event_id}">
        <div class="ec-head">
          <div><b>${esc(e.name)}</b><small>Kode ${esc(e.join_code)} · ${esc(filmName(e.film))} · dibuat ${esc(fmtDate(e.created_at))}</small></div>
          <span class="tag ${e.is_open ? "ok" : ""}">${e.is_open ? "Terbuka" : "Ditutup"}</span>
        </div>
        <div class="funnel">${funnelHtml(e)}</div>
        <p class="hint" style="margin:0">${e.photos} foto masuk${e.pending ? ` · <b>${e.pending} tertahan</b>` : ""} · ${fmtBytes(e.bytes)}${e.last_photo_at ? ` · terakhir ${esc(fmtDate(e.last_photo_at))}` : ""}</p>
        <div class="row">
          <a class="btn small primary" href="#/e/${e.event_id}/panel">Kelola</a>
          <a class="btn small" href="#/e/${e.event_id}/album">Album</a>
          <button class="btn small" data-share="${esc(e.join_code)}">${ICON.share} Bagikan</button>
          <button class="btn small ghost icon-btn" data-more="${e.event_id}" aria-label="Aksi lain untuk ${esc(e.name)}">⋯</button>
        </div>
      </article>`).join("")}</div>`);
    n.querySelectorAll("[data-share]").forEach((b) => (b.onclick = () =>
      copyText(`${location.origin}/?kode=${b.dataset.share}`, { done: "Link undangan disalin." })));
    n.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => eventMenu(rows.find((e) => e.event_id === b.dataset.more))));
    return n;
  }

  function eventMenu(e) {
    actionSheet(e.name, [
      { label: e.is_open ? "Tutup acara" : "Buka acara", run: () => setOpen([e], !e.is_open) },
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
      try { await rpc("set_event", { p_event: e.event_id, p_patch: { is_open: open } }); n++; }
      catch (err) { toast(friendly(err)); }
    }
    toast(`${n} acara ${open ? "dibuka" : "ditutup"}.`);
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
const limitText = (r) => r.event_limit === null || r.event_limit === undefined
  ? `${r.events_created ?? 0} acara dibuat · tanpa batas`
  : `${r.events_created ?? 0} dari ${r.event_limit} acara${r.events_created >= r.event_limit ? " · habis" : ""}`;

async function pengguna(body, me) {
  const st = { q: "", filter: "all", offset: 0 };
  const view = el(`
    <div>
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
          <div class="table-scroll"><table><tbody>${roles.map((r) => `
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
        <table>
          <thead><tr><th>Pengguna</th><th>Aktivitas</th><th>Login terakhir</th><th></th></tr></thead>
          <tbody>${rows.map((u) => `
            <tr class="${u.banned ? "blocked" : ""}">
              <td><b>${esc(u.name)}</b> ${roleTag(u.role)} ${u.banned ? `<span class="tag bad">diblokir</span>` : ""}
                <br><small>${esc(u.email)}</small>${u.role === "creator" ? `<br><small>${limitText(u)}</small>` : ""}</td>
              <td><small>${u.events_owned} acara dibuat · ${u.events_joined} diikuti · ${u.photos} foto</small></td>
              <td><small>${esc(fmtDate(u.last_sign_in_at) || "-")}</small></td>
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
        <label>Kuota storage paket Supabase (MB)
          <input type="number" name="storage_quota_mb" min="100" max="1000000" value="${s.storage_quota_mb}" /></label>
        <p class="hint">Dipakai meter storage di Ringkasan. Paket gratis 1024 MB (1 GB), paket Pro 102400 MB (100 GB).</p>
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

      <fieldset><legend>Kamera</legend>
        <label class="check"><input type="checkbox" name="flash_enabled" ${s.flash_enabled ? "checked" : ""}/> Tampilkan tombol flash</label>
        <label class="check"><input type="checkbox" name="mirror_preview" ${s.mirror_preview ? "checked" : ""}/> Cerminkan jendela bidik kamera depan (seperti cermin)</label>
        <label class="check"><input type="checkbox" name="mirror_photo" ${s.mirror_photo ? "checked" : ""}/> Cerminkan hasil foto kamera depan</label>
        <p class="hint">Hasil foto biasanya tidak dicerminkan, supaya tulisan di foto terbaca normal.</p>
      </fieldset>

      <p class="hint">Terakhir diubah ${esc(fmtDate(s.updated_at))}</p>
      <button class="btn primary">Simpan pengaturan</button>
    </form>`);
  body.replaceChildren(view);
  const f = view.elements;
  f.jpeg_quality.oninput = () => { view.querySelector(".qv").textContent = f.jpeg_quality.value; };
  view.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await rpc("admin_set_settings", { p_patch: {
        max_shots_limit: Number(f.max_shots_limit.value),
        max_members_limit: Number(f.max_members_limit.value),
        storage_quota_mb: Number(f.storage_quota_mb.value),
        photo_max_side: Number(f.photo_max_side.value),
        jpeg_quality: Number(f.jpeg_quality.value),
        default_film: f.default_film.value,
        flash_enabled: f.flash_enabled.checked,
        mirror_preview: f.mirror_preview.checked,
        mirror_photo: f.mirror_photo.checked,
      } });
      toast("Pengaturan tersimpan.");
    } catch (err) { toast(friendly(err)); }
  };
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
};
const FIELDS = {
  name: "nama", max_shots: "jatah", max_members: "batas peserta",
  max_shots_limit: "batas jepretan", max_members_limit: "batas peserta", storage_quota_mb: "kuota storage (MB)",
  jpeg_quality: "kualitas JPEG",
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
    default: return `${FIELDS[k] || k} ${v ?? "-"}`;
  }
}
function describe(r) {
  const d = r.detail || {};
  const t = r.target_label || r.target || "";
  const patch = () => Object.entries(d).map(([k, v]) => describeChange(k, v)).join(", ");
  switch (r.action) {
    case "buat_acara": return `membuat acara “${d.name || t}”`;
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
  await load();
}
