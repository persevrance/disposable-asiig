// Tab Panel: hanya untuk pemilik acara
import QRCode from "qrcode";
import { zipSync } from "fflate";
import { rpc, friendly } from "./supabase.js";
import { getUrls, removeFiles } from "./storage.js";
import { el, esc, toast, fmtDate, toLocalInput, fromLocalInput } from "./ui.js";

export async function renderPanel(root, status, { reload, home }) {
  const link = `${location.origin}/?kode=${status.join_code}`;
  const view = el(`
    <section class="panel">
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

      <form class="card settings">
        <h3>Pengaturan acara</h3>
        <label>Nama acara <input name="name" required maxlength="80" value="${esc(status.name)}" /></label>
        <label class="check"><input type="checkbox" name="is_open" ${status.is_open ? "checked" : ""}/> Acara terbuka (peserta bisa memotret)</label>
        <label class="check"><input type="checkbox" name="reveal" ${status.reveal_at ? "checked" : ""}/> Mode cuci film: semua foto tampil bersamaan pada</label>
        <input type="datetime-local" name="reveal_at" value="${toLocalInput(status.reveal_at)}" />
        <label>Rencana hapus foto <input type="date" name="purge_at" value="${status.purge_at ? toLocalInput(status.purge_at).slice(0, 10) : ""}" /></label>
        <label>Batas jumlah peserta <input type="number" name="max_members" min="1" max="5000" value="${status.max_members}" /></label>
        <label class="check"><input type="checkbox" name="invite_only" ${status.invite_only ? "checked" : ""}/> Hanya email di daftar undangan</label>
        <textarea name="invites" rows="4" placeholder="Satu email per baris" ${status.invite_only ? "" : "hidden"}></textarea>
        <p class="hint">Jatah per peserta: ${status.max_shots} foto (ditetapkan saat acara dibuat).</p>
        <button class="btn primary" type="submit">Simpan</button>
      </form>

      <div class="card">
        <h3>Peserta</h3>
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
    try {
      await rpc("set_event", {
        p_event: status.event_id,
        p_name: f.name.value,
        p_is_open: f.is_open.checked,
        p_reveal_at: reveal,
        p_purge_at: f.purge_at.value ? new Date(f.purge_at.value + "T00:00").toISOString() : null,
        p_max_members: Number(f.max_members.value),
        p_invite_only: f.invite_only.checked,
      });
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
              <td><b>${esc(m.name)}</b><br><small>${esc(m.email)}</small></td>
              <td>${m.shots_used}/${status.max_shots}${m.pending ? `<br><small>${m.pending} belum terunggah</small>` : ""}</td>
              <td class="actions">
                ${m.pending ? `<button class="btn small" data-release="${m.user_id}">Lepas macet</button>` : ""}
                ${m.user_id === status.me ? "" : `<button class="btn small ghost" data-block="${m.user_id}" data-blocked="${m.blocked}">${m.blocked ? "Pulihkan" : "Blokir"}</button>`}
              </td>
            </tr>`).join("")}
          </tbody>
        </table>`));
      box.insertAdjacentHTML("afterbegin", `<p class="hint">${rows.length} dari maks. ${status.max_members} peserta.</p>`);
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
          const safe = r.owner_name.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "peserta";
          files[`${safe}/${String(r.seq).padStart(2, "0")}.jpg`] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
        }));
        prog.textContent = `Mengunduh ${Math.min(i + 50, rows.length)} / ${rows.length} foto…`;
      }
      prog.textContent = "Membuat ZIP…";
      const zip = zipSync(files);
      const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
      download(url, `${status.name.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "album"}.zip`);
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
      const rows = await rpc("owner_paths", { p_event: status.event_id });
      await removeFiles(rows.flatMap((r) => [r.file_path, r.thumb_path]));
      await rpc("delete_event", { p_event: status.event_id });
      toast("Acara dihapus.");
      home();
    } catch (e) { toast(friendly(e)); }
  };

  return () => {};
}

function download(url, name) {
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
}
