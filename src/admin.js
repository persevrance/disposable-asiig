// Dashboard superadmin: #/admin/<tab>
import { rpc, friendly } from "./supabase.js";
import { FILMS, filmName } from "./film.js";
import { RESOLUTIONS, deleteEventFiles } from "./owner.js";
import { el, esc, toast, fmtDate, fmtBytes } from "./ui.js";

// Kuota storage paket gratis Supabase; ubah jika paket di-upgrade
const STORAGE_QUOTA = 1024 ** 3;

const TABS = [
  ["ringkasan", "Ringkasan"],
  ["acara", "Acara"],
  ["peran", "Peran"],
  ["pengguna", "Pengguna"],
  ["pengaturan", "Pengaturan"],
  ["log", "Log"],
];

export async function renderAdmin(app, tab, { setView, me }) {
  if (!TABS.some(([t]) => t === tab)) tab = "ringkasan";
  const view = el(`
    <main class="page admin">
      <header class="top">
        <a class="back" href="#/" aria-label="Kembali">‹</a>
        <h1>Dashboard</h1>
        <span class="pill small-pill">Superadmin</span>
      </header>
      <nav class="tabs scroll">
        ${TABS.map(([t, n]) => `<a href="#/admin/${t}" class="${t === tab ? "on" : ""}">${n}</a>`).join("")}
      </nav>
      <div class="admin-body"><p class="hint">Memuat…</p></div>
    </main>`);
  setView(view);
  const body = view.querySelector(".admin-body");
  const render = { ringkasan, acara, peran, pengguna, pengaturan, log }[tab];
  try { await render(body, me); }
  catch (e) { body.replaceChildren(el(`<p class="hint">${esc(friendly(e))}</p>`)); }
}

// ---------- Ringkasan ----------
async function ringkasan(body) {
  const o = await rpc("admin_overview");
  const used = Number(o.photo_bytes) + Number(o.cover_bytes);
  const pct = Math.min(100, (used / STORAGE_QUOTA) * 100);
  const avg = o.photos ? Number(o.photo_bytes) / o.photos : 0;
  const left = avg ? Math.max(0, Math.floor((STORAGE_QUOTA - used) / avg)) : null;
  body.replaceChildren(el(`
    <div>
      <div class="stats">
        ${stat("Pengguna", o.users, o.banned ? `${o.banned} diblokir` : "")}
        ${stat("Acara", o.events, `${o.events_open} terbuka`)}
        ${stat("Foto", o.photos, o.pending ? `${o.pending} belum terunggah` : "")}
        ${stat("Unduhan", o.downloads, "")}
        ${stat("Pembuat acara", o.creators, `${o.superadmins} superadmin`)}
      </div>
      <div class="card">
        <h3>Storage</h3>
        <div class="meter"><span style="width:${pct.toFixed(1)}%" class="${pct > 85 ? "hot" : ""}"></span></div>
        <p class="hint">${fmtBytes(used)} dari ${fmtBytes(STORAGE_QUOTA)} (${pct.toFixed(1)}%) · foto ${fmtBytes(o.photo_bytes)}, sampul ${fmtBytes(o.cover_bytes)}</p>
        ${left !== null ? `<p class="hint">Rata-rata ${fmtBytes(avg)} per foto (3 ukuran). Sisa cukup untuk sekitar <b>${left.toLocaleString("id-ID")}</b> foto lagi.</p>` : ""}
        <p class="hint">Hemat storage: turunkan resolusi di Pengaturan, atau hapus acara lama setelah albumnya diunduh.</p>
      </div>
    </div>`));
}
const stat = (label, value, sub) => `
  <div class="stat"><b>${Number(value).toLocaleString("id-ID")}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;

// ---------- Acara ----------
async function acara(body) {
  const view = el(`
    <div>
      <form class="card search"><div class="row">
        <input name="q" placeholder="Cari nama acara, pemilik, email, atau kode" />
        <button class="btn">Cari</button>
      </div></form>
      <div class="list"><p class="hint">Memuat…</p></div>
    </div>`);
  body.replaceChildren(view);
  const list = view.querySelector(".list");

  async function load(q = "") {
    const rows = await rpc("admin_events", { p_search: q || null });
    if (!rows.length) return list.replaceChildren(el(`<p class="hint">Tidak ada acara.</p>`));
    list.replaceChildren(...rows.map((e) => {
      const n = el(`
        <div class="card event-admin">
          <div class="ea-head">
            <div>
              <b>${esc(e.name)}</b>
              <small>${esc(e.owner_name)} · ${esc(e.owner_email || "")}</small>
            </div>
            <span class="tag ${e.is_open ? "ok" : ""}">${e.is_open ? "Terbuka" : "Ditutup"}</span>
          </div>
          <p class="hint">${e.members} peserta · ${e.photos} foto · ${fmtBytes(e.bytes)} · ${e.max_shots} jepretan · ${esc(filmName(e.film))}${e.hide_names ? " · nama disembunyikan" : ""} · dibuat ${esc(fmtDate(e.created_at))}</p>
          <div class="row">
            <a class="btn small primary" href="#/e/${e.event_id}/panel">Kelola</a>
            <a class="btn small" href="#/e/${e.event_id}/album">Album</a>
            <button class="btn small ghost" data-act="toggle">${e.is_open ? "Tutup" : "Buka"}</button>
            <button class="btn small danger" data-act="delete">Hapus</button>
          </div>
        </div>`);
      n.querySelector('[data-act="toggle"]').onclick = async () => {
        try { await rpc("set_event", { p_event: e.event_id, p_patch: { is_open: !e.is_open } }); load(view.querySelector("input").value); }
        catch (err) { toast(friendly(err)); }
      };
      n.querySelector('[data-act="delete"]').onclick = async () => {
        const typed = prompt(`Hapus acara beserta ${e.photos} foto? Ketik nama acara:\n${e.name}`);
        if (typed === null) return;
        if (typed.trim() !== e.name.trim()) return toast("Nama tidak cocok.");
        try {
          const st = (await rpc("my_status", { p_event: e.event_id }))[0];
          await deleteEventFiles(e.event_id, st?.cover_path);
          await rpc("delete_event", { p_event: e.event_id });
          toast("Acara dihapus.");
          load(view.querySelector("input").value);
        } catch (err) { toast(friendly(err)); }
      };
      return n;
    }));
  }
  view.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); load(ev.target.elements.q.value.trim()).catch((e) => toast(friendly(e))); };
  await load();
}

// ---------- Peran ----------
async function peran(body, me) {
  const view = el(`
    <div>
      <form class="card add-role">
        <h3>Tambah peran</h3>
        <p class="hint">Pembuat acara bisa membuat dan mengelola acaranya sendiri. Superadmin bisa mengelola semuanya. Email tidak harus sudah pernah login.</p>
        <div class="row">
          <input name="email" type="email" placeholder="email@gmail.com" required />
          <select name="role"><option value="creator">Pembuat acara</option><option value="superadmin">Superadmin</option></select>
          <button class="btn primary">Simpan</button>
        </div>
      </form>
      <div class="card"><h3>Daftar peran</h3><div class="list"><p class="hint">Memuat…</p></div></div>
    </div>`);
  body.replaceChildren(view);
  const list = view.querySelector(".list");

  async function load() {
    const rows = await rpc("admin_roles");
    list.replaceChildren(el(`
      <table>
        <thead><tr><th>Email</th><th>Peran</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><b>${esc(r.email)}</b><br><small>${r.user_name ? esc(r.user_name) : "belum pernah login"} · ditambahkan ${esc(fmtDate(r.added_at))}${r.added_by ? ` oleh ${esc(r.added_by)}` : ""}</small></td>
            <td><span class="tag ${r.role === "superadmin" ? "hot" : ""}">${r.role === "superadmin" ? "Superadmin" : "Pembuat acara"}</span></td>
            <td class="actions">${r.email === me.email.toLowerCase() ? `<small>Anda</small>` : `
              <button class="btn small ghost" data-swap="${esc(r.email)}" data-role="${r.role === "superadmin" ? "creator" : "superadmin"}">${r.role === "superadmin" ? "Jadikan pembuat" : "Jadikan superadmin"}</button>
              <button class="btn small danger" data-del="${esc(r.email)}">Cabut</button>`}
            </td>
          </tr>`).join("")}
        </tbody>
      </table>`));
    list.querySelectorAll("[data-swap]").forEach((b) => (b.onclick = () => setRole(b.dataset.swap, b.dataset.role)));
    list.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => {
      if (confirm(`Cabut peran ${b.dataset.del}? Acara yang sudah dibuatnya tetap ada.`)) setRole(b.dataset.del, null);
    }));
  }
  async function setRole(email, role) {
    try { await rpc("admin_set_role", { p_email: email, p_role: role }); toast("Tersimpan."); await load(); }
    catch (e) { toast(friendly(e)); }
  }
  view.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    await setRole(f.email.value.trim(), f.role.value);
    f.email.value = "";
  };
  await load();
}

// ---------- Pengguna ----------
async function pengguna(body, me) {
  const view = el(`
    <div>
      <form class="card search"><div class="row">
        <input name="q" placeholder="Cari nama atau email" />
        <button class="btn">Cari</button>
      </div></form>
      <div class="card"><div class="list"><p class="hint">Memuat…</p></div></div>
    </div>`);
  body.replaceChildren(view);
  const list = view.querySelector(".list");

  async function load(q = "") {
    const rows = await rpc("admin_users", { p_search: q || null });
    list.replaceChildren(el(`
      <table>
        <thead><tr><th>Pengguna</th><th>Aktivitas</th><th></th></tr></thead>
        <tbody>${rows.map((u) => `
          <tr class="${u.banned ? "blocked" : ""}">
            <td><b>${esc(u.name)}</b> ${u.role ? `<span class="tag ${u.role === "superadmin" ? "hot" : ""}">${u.role === "superadmin" ? "Superadmin" : "Pembuat"}</span>` : ""}<br><small>${esc(u.email)}</small></td>
            <td><small>${u.events_owned} acara dibuat · ${u.events_joined} diikuti · ${u.photos} foto<br>Login terakhir ${esc(fmtDate(u.last_sign_in_at) || "-")}</small></td>
            <td class="actions">${u.user_id === me.id ? `<small>Anda</small>` :
              `<button class="btn small ${u.banned ? "" : "danger"}" data-ban="${u.user_id}" data-banned="${u.banned}">${u.banned ? "Pulihkan" : "Blokir"}</button>`}</td>
          </tr>`).join("")}
        </tbody>
      </table>`));
    list.querySelectorAll("[data-ban]").forEach((b) => (b.onclick = async () => {
      const ban = b.dataset.banned !== "true";
      if (ban && !confirm("Blokir akun ini dari seluruh aplikasi? Ia tidak bisa masuk acara, memotret, atau melihat album.")) return;
      try { await rpc("admin_ban", { p_user: b.dataset.ban, p_banned: ban }); await load(view.querySelector("input").value); }
      catch (e) { toast(friendly(e)); }
    }));
  }
  view.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); load(ev.target.elements.q.value.trim()).catch((e) => toast(friendly(e))); };
  await load();
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

// ---------- Log ----------
const ACTIONS = {
  buat_acara: "membuat acara", ubah_acara: "mengubah acara", hapus_acara: "menghapus acara",
  ubah_sampul: "mengubah sampul", blokir_peserta: "memblokir peserta", pulihkan_peserta: "memulihkan peserta",
  ubah_peran: "mengubah peran", ubah_pengaturan: "mengubah pengaturan global",
  blokir_akun: "memblokir akun", pulihkan_akun: "memulihkan akun",
};
async function log(body) {
  const rows = await rpc("admin_audit", { p_limit: 300 });
  body.replaceChildren(el(`
    <div class="card">
      <h3>Log aktivitas</h3>
      ${rows.length ? `<ul class="audit">${rows.map((r) => `
        <li>
          <small>${esc(fmtDate(r.at))}</small>
          <div><b>${esc(r.actor_email || "sistem")}</b> ${esc(ACTIONS[r.action] || r.action)}${r.target ? ` <code>${esc(r.target)}</code>` : ""}</div>
          ${Object.keys(r.detail || {}).length ? `<code class="detail">${esc(JSON.stringify(r.detail))}</code>` : ""}
        </li>`).join("")}</ul>` : `<p class="hint">Belum ada aktivitas.</p>`}
    </div>`));
}
