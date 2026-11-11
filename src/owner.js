// Tab Panel: untuk pemilik acara dan superadmin
import QRCode from "qrcode";
import { zipSync } from "fflate";
import { rpc, friendly } from "./supabase.js";
import { getUrls, removeFiles, uploadCover, coverUrl, removeCover } from "./storage.js";
import { FILMS } from "./film.js";
import { el, esc, toast, fmtDate, toLocalInput, fromLocalInput, download, safeName, modal } from "./ui.js";

export const RESOLUTIONS = [1280, 1600, 2048, 2560, 3264, 4096];

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

export async function renderPanel(root, status, { reload, home }) {
  const link = `${location.origin}/?kode=${status.join_code}`;
  const view = el(`
    <section class="panel">
      ${status.is_admin && !status.is_owner ? `<p class="pill admin-pill">Anda mengelola acara ini sebagai superadmin</p>` : ""}
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

      <form class="card settings">
        <h3>Pengaturan acara</h3>
        <label>Nama acara <input name="name" required maxlength="80" value="${esc(status.name)}" /></label>
        <label>Kalimat sambutan (opsional)
          <textarea name="welcome_text" rows="2" maxlength="300" placeholder="Contoh: Abadikan momen bahagia kami, ya!">${esc(status.welcome_text || "")}</textarea>
        </label>
        <label>Efek film bawaan <select name="film">${filmOptions(status.ev_film || status.film)}</select></label>
        <label class="check"><input type="checkbox" name="allow_film_choice" ${status.allow_film_choice ? "checked" : ""}/> Tamu boleh memilih efek film sendiri</label>
        <label>Jatah jepretan per peserta
          <input type="number" name="max_shots" min="${status.is_admin ? 1 : status.max_shots}" max="${status.max_shots_limit}" value="${status.max_shots}" />
        </label>
        <p class="hint">Batas admin: ${status.max_shots_limit}. ${status.is_admin ? "" : "Jatah hanya bisa dinaikkan. "}Menaikkan jatah membuka lagi gulungan yang sudah habis, dan fotonya tersembunyi lagi sampai gulungan itu habis.</p>
        <label class="check"><input type="checkbox" name="is_open" ${status.is_open ? "checked" : ""}/> Acara terbuka (peserta bisa memotret)</label>
        <label class="check"><input type="checkbox" name="hide_names" ${status.hide_names ? "checked" : ""}/> Sembunyikan nama pengunggah (hanya Anda dan superadmin yang tahu)</label>
        <label class="check"><input type="checkbox" name="reveal" ${status.reveal_at ? "checked" : ""}/> Mode cuci film: semua foto tampil bersamaan pada</label>
        <input type="datetime-local" name="reveal_at" value="${toLocalInput(status.reveal_at)}" />
        <label>Rencana hapus foto <input type="date" name="purge_at" value="${status.purge_at ? toLocalInput(status.purge_at).slice(0, 10) : ""}" /></label>
        <label>Batas jumlah peserta <input type="number" name="max_members" min="1" max="${status.max_members_limit}" value="${status.max_members}" /></label>
        <label class="check"><input type="checkbox" name="invite_only" ${status.invite_only ? "checked" : ""}/> Hanya email di daftar undangan</label>
        <textarea name="invites" rows="4" placeholder="Satu email per baris" ${status.invite_only ? "" : "hidden"}></textarea>
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
        <button class="btn primary" type="submit">Simpan</button>
      </form>

      <div class="card">
        <h3>Peserta</h3>
        <p class="hint">Ketuk nama untuk melihat gulungannya.</p>
        <div class="members"><p class="hint">Memuat…</p></div>
      </div>

      <div class="card">
        <h3>Album</h3>
        <p class="hint">Unduh semua foto ukuran penuh sebagai satu file ZIP.</p>
        <button class="btn" data-act="zip">Unduh album (ZIP)</button>
        <p class="zip-progress hint" hidden></p>
      </div>

      <div class="card danger">
        <h3>Hapus acara</h3>
        <p class="hint">Menghapus semua foto dari server beserta data acara. Unduh album dulu. Tidak bisa dibatalkan.</p>
        <button class="btn danger" data-act="delete">Hapus acara dan semua foto</button>
      </div>
    </section>`);
  root.replaceChildren(view);
  const form = view.querySelector("form.settings");

  // --- undangan ---
  QRCode.toCanvas(view.querySelector(".qr"), link, { width: 180, margin: 1 });
  view.querySelector('[data-act="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast("Link disalin."); }
    catch { prompt("Salin link ini:", link); }
  };
  view.querySelector('[data-act="qr"]').onclick = async () => {
    const url = await QRCode.toDataURL(link, { width: 1024, margin: 2 });
    download(url, `undangan-${status.join_code}.png`);
  };
  view.querySelector('[data-act="rotate"]').onclick = async () => {
    if (!confirm("Ganti kode? Link dan QR lama tidak bisa dipakai lagi. Peserta yang sudah masuk tetap aman.")) return;
    try { await rpc("rotate_code", { p_event: status.event_id }); toast("Kode diganti."); reload(); }
    catch (e) { toast(friendly(e)); }
  };

  // --- sampul ---
  view.querySelector('[data-act="cover"]').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      toast("Mengunggah sampul…", 20000);
      const blob = await resizeImage(file, 1600, 0.85);
      const path = `${status.event_id}/${crypto.randomUUID()}.jpg`;
      await uploadCover(path, blob);
      const old = await rpc("set_cover", { p_event: status.event_id, p_path: path });
      await removeCover(old).catch(() => {});
      toast("Sampul tersimpan.");
      reload();
    } catch (err) { toast(friendly(err)); }
  };
  const uncover = view.querySelector('[data-act="uncover"]');
  if (uncover) uncover.onclick = async () => {
    if (!confirm("Hapus sampul acara?")) return;
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
    const patch = {
      name: f.name.value,
      welcome_text: f.welcome_text.value,
      film: f.film.value,
      is_open: f.is_open.checked,
      hide_names: f.hide_names.checked,
      allow_film_choice: f.allow_film_choice.checked,
      reveal_at: reveal,
      purge_at: f.purge_at.value ? new Date(f.purge_at.value + "T00:00").toISOString() : null,
      max_members: Number(f.max_members.value),
      invite_only: f.invite_only.checked,
    };
    if (Number(f.max_shots.value) !== status.max_shots) patch.max_shots = Number(f.max_shots.value);
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

  // --- peserta ---
  async function loadMembers() {
    const box = view.querySelector(".members");
    try {
      const rows = await rpc("list_members", { p_event: status.event_id });
      box.replaceChildren(el(`
        <table>
          <thead><tr><th>Peserta</th><th>Jatah</th><th></th></tr></thead>
          <tbody>${rows.map((m) => `
            <tr class="${m.blocked ? "blocked" : ""}">
              <td><button class="linklike" data-roll="${m.user_id}">${esc(m.name)}</button><br><small>${esc(m.email)}</small></td>
              <td>${m.shots_used}/${status.max_shots}${m.pending ? `<br><small>${m.pending} belum terunggah</small>` : ""}</td>
              <td class="actions">
                ${m.pending ? `<button class="btn small" data-release="${m.user_id}">Lepas macet</button>` : ""}
                ${m.user_id === status.me ? "" : `<button class="btn small ghost" data-block="${m.user_id}" data-blocked="${m.blocked}">${m.blocked ? "Pulihkan" : "Blokir"}</button>`}
              </td>
            </tr>`).join("")}
          </tbody>
        </table>`));
      box.insertAdjacentHTML("afterbegin", `<p class="hint">${rows.length} dari maks. ${status.max_members} peserta.</p>`);
      box.querySelectorAll("[data-roll]").forEach((b) => (b.onclick = () => {
        const m = rows.find((x) => x.user_id === b.dataset.roll);
        showRoll(status, m);
      }));
      box.querySelectorAll("[data-block]").forEach((b) => (b.onclick = async () => {
        try {
          await rpc("block_member", { p_event: status.event_id, p_user: b.dataset.block, p_blocked: b.dataset.blocked !== "true" });
          loadMembers();
        } catch (e) { toast(friendly(e)); }
      }));
      box.querySelectorAll("[data-release]").forEach((b) => (b.onclick = async () => {
        if (!confirm("Hapus jepretan yang belum terunggah dan kembalikan jatahnya? Jika HP peserta masih menyimpan fotonya, foto itu akan dikirim ulang sebagai jepretan baru.")) return;
        try {
          const rows = await rpc("release_pending", { p_event: status.event_id, p_user: b.dataset.release });
          const paths = rows.map((r) => r.file_path ?? r.release_pending ?? r);
          await removeFiles(paths).catch(() => {});
          toast("Jepretan macet dilepas.");
          loadMembers();
        } catch (e) { toast(friendly(e)); }
      }));
    } catch (e) { box.textContent = friendly(e); }
  }
  loadMembers();

  // --- unduh ZIP ---
  view.querySelector('[data-act="zip"]').onclick = async (ev) => {
    const btn = ev.currentTarget;
    const prog = view.querySelector(".zip-progress");
    btn.disabled = true; prog.hidden = false;
    try {
      const rows = (await rpc("owner_paths", { p_event: status.event_id })).filter((r) => r.status === "ready");
      if (!rows.length) { toast("Belum ada foto."); return; }
      const files = {};
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const urls = await getUrls(batch.map((r) => r.file_path));
        await Promise.all(batch.map(async (r) => {
          const res = await fetch(urls[r.file_path]);
          if (!res.ok) throw new Error("Gagal mengunduh " + r.file_path);
          files[`${safeName(r.owner_name, "peserta")}/${String(r.seq).padStart(2, "0")}.jpg`] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
        }));
        prog.textContent = `Mengunduh ${Math.min(i + 50, rows.length)} / ${rows.length} foto…`;
      }
      prog.textContent = "Membuat ZIP…";
      const zip = zipSync(files);
      const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
      download(url, `${safeName(status.name, "album")}.zip`);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      prog.textContent = `Selesai: ${rows.length} foto.`;
    } catch (e) {
      toast(friendly(e));
      prog.hidden = true;
    } finally { btn.disabled = false; }
  };

  // --- hapus acara ---
  view.querySelector('[data-act="delete"]').onclick = async () => {
    const typed = prompt(`Ketik nama acara untuk menghapus:\n${status.name}`);
    if (typed === null) return;
    if (typed.trim() !== status.name.trim()) return toast("Nama tidak cocok, acara tidak dihapus.");
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
    const slots = [];
    for (let i = 1; i <= status.max_shots; i++) {
      const r = rows.find((x) => x.seq === i);
      if (!r) slots.push(`<div class="tile slot empty-slot"><span>${i}</span></div>`);
      else if (r.status !== "ready") slots.push(`<div class="tile slot"><span>${i}</span><span class="badge">belum terunggah</span></div>`);
      else slots.push(`
        <button class="tile${r.hidden ? " is-hidden" : ""}" data-m="${esc(r.medium_path)}">
          <img loading="lazy" alt="Foto ${i}" src="${esc(urls[r.thumb_path] || "")}" />
          <span class="badge">${i} · ${esc(fmtDate(r.taken_at))}</span>
        </button>`);
    }
    grid.innerHTML = slots.join("");
    grid.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => {
      const u = await getUrls([b.dataset.m]);
      const lb = el(`<div class="lightbox"><img alt="" src="${esc(u[b.dataset.m] || "")}" /><div class="lb-bar"><span></span><button class="btn small">Tutup</button></div></div>`);
      lb.onclick = () => lb.remove();
      document.body.append(lb);
    }));
  } catch (e) { grid.textContent = friendly(e); }
}

// Perkecil gambar menjadi JPEG (untuk sampul)
async function resizeImage(file, maxSide, quality) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Gagal memproses gambar"))), "image/jpeg", quality));
}
