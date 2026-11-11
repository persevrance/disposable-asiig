// Tab Album: daftar foto, muat bertahap, diperbarui tiap 15 detik, unduh dengan kuota
import { zipSync } from "fflate";
import { rpc, friendly } from "./supabase.js";
import { getUrls } from "./storage.js";
import { el, esc, toast, fmtDate, download, safeName, modal, confirmDialog } from "./ui.js";

const PAGE = 60;

export async function renderAlbum(root, status) {
  const items = new Map(); // photo_id -> row
  const selected = new Set();
  let oldest = null;
  let endReached = false;
  let loading = false;
  let selecting = false;

  const view = el(`
    <section class="album">
      <div class="album-bar">
        <span class="dl-quota"></span>
        <button class="btn small" data-act="select">Pilih untuk unduh</button>
      </div>
      <div class="grid"></div>
      <div class="sentinel"></div>
      <div class="empty" hidden></div>
      <div class="select-bar" hidden>
        <span class="sel-info"></span>
        <button class="btn small ghost" data-act="cancel">Batal</button>
        <button class="btn small primary" data-act="get">Unduh</button>
      </div>
    </section>`);
  root.replaceChildren(view);
  const grid = view.querySelector(".grid");
  const empty = view.querySelector(".empty");
  const quotaEl = view.querySelector(".dl-quota");
  const selBar = view.querySelector(".select-bar");
  const selInfo = view.querySelector(".sel-info");
  const selectBtn = view.querySelector('[data-act="select"]');

  // ---- kuota unduhan ----
  const unlimited = () => status.can_manage;
  const quotaLeft = () => Math.max(0, status.max_shots - (status.downloads_used || 0));
  // Foto yang memakai kuota: milik orang lain dan belum pernah diunduh
  const cost = (ids) => [...ids].filter((id) => { const r = items.get(id); return r && !r.is_mine && !r.downloaded; }).length;

  function updateQuota() {
    quotaEl.textContent = unlimited()
      ? "Unduh ukuran penuh tanpa batas (pengelola acara)."
      : `Sisa unduhan: ${quotaLeft()} dari ${status.max_shots} · foto Anda sendiri gratis`;
  }

  function updateSelBar() {
    const c = cost(selected);
    selInfo.textContent = unlimited() || !c
      ? `${selected.size} dipilih`
      : `${selected.size} dipilih · memakai ${c} kuota`;
    const over = !unlimited() && c > quotaLeft();
    selInfo.classList.toggle("warn", over);
    view.querySelector('[data-act="get"]').disabled = !selected.size || over;
  }

  function setSelecting(on) {
    selecting = on;
    selected.clear();
    grid.classList.toggle("selecting", on);
    grid.querySelectorAll(".tile.selected").forEach((t) => t.classList.remove("selected"));
    selBar.hidden = !on;
    selectBtn.hidden = on;
    updateSelBar();
  }
  selectBtn.onclick = () => setSelecting(true);
  view.querySelector('[data-act="cancel"]').onclick = () => setSelecting(false);
  view.querySelector('[data-act="get"]').onclick = async (e) => {
    e.currentTarget.disabled = true;
    const ok = await getPhotos([...selected]);
    if (ok) setSelecting(false); else updateSelBar();
  };

  function emptyText() {
    if (status.reveal_at && new Date(status.reveal_at) > new Date())
      return `Mode cuci film: semua foto tampil pada ${fmtDate(status.reveal_at)}.`;
    return `Foto tampil setelah pemotretnya menghabiskan ${status.max_shots} jepretan atau saat acara ditutup.`;
  }

  const label = (r) => (r.owner_name ? `#${r.seq} · ${r.owner_name}` : "Tamu");

  // Sisipkan ubin sesuai urutan taken_at (terbaru di atas)
  async function addRows(rows) {
    const fresh = rows.filter((r) => !items.has(r.photo_id));
    if (!fresh.length) return;
    const urls = await getUrls(fresh.map((r) => r.thumb_path));
    for (const r of fresh) {
      items.set(r.photo_id, r);
      const n = el(`
        <button class="tile${r.hidden ? " is-hidden" : ""}" data-id="${r.photo_id}" data-t="${esc(r.taken_at)}">
          <img loading="lazy" alt="Foto ${esc(label(r))}" src="${esc(urls[r.thumb_path] || "")}" />
          ${r.hidden ? `<span class="badge">disembunyikan</span>` : ""}
          ${r.is_mine ? `<span class="badge mine">milik Anda</span>` : ""}
          <span class="check" aria-hidden="true">✓</span>
        </button>`);
      n.onclick = () => {
        if (!selecting) return openPhoto(r);
        if (selected.has(r.photo_id)) selected.delete(r.photo_id); else selected.add(r.photo_id);
        n.classList.toggle("selected", selected.has(r.photo_id));
        updateSelBar();
      };
      const t = new Date(r.taken_at);
      const after = [...grid.children].find((c) => new Date(c.dataset.t) < t);
      grid.insertBefore(n, after || null);
    }
  }

  function updateEmpty() {
    empty.hidden = items.size > 0;
    empty.textContent = emptyText();
    view.querySelector(".album-bar").hidden = items.size === 0;
  }

  async function loadMore() {
    if (loading || endReached) return;
    loading = true;
    try {
      const rows = await rpc("get_album", { p_event: status.event_id, p_before: oldest, p_limit: PAGE });
      if (rows.length < PAGE) endReached = true;
      if (rows.length) oldest = rows[rows.length - 1].taken_at;
      await addRows(rows);
    } catch (e) {
      toast(friendly(e));
    } finally {
      loading = false;
      updateEmpty();
    }
  }

  async function poll() {
    try {
      const rows = await rpc("get_album", { p_event: status.event_id, p_before: null, p_limit: 100 });
      // Gulungan yang baru habis bisa berisi foto lama: sisipkan sesuai urutan,
      // dan izinkan gulir ke bawah memuat lagi yang lebih lama.
      const fresh = rows.filter((r) => !items.has(r.photo_id));
      if (fresh.length) {
        await addRows(fresh);
        if (!oldest) oldest = rows[rows.length - 1].taken_at;
        endReached = false;
      }
      updateEmpty();
    } catch { /* coba lagi nanti */ }
  }

  // ---- unduh ukuran penuh ----
  // Klaim di server (memotong kuota), ambil file, lalu simpan.
  async function getPhotos(ids) {
    if (!ids.length) return false;
    const c = cost(ids);
    if (!unlimited() && c > quotaLeft()) { toast("Kuota unduhan tidak cukup."); return false; }
    if (!unlimited() && c > 0 && !(await confirmDialog({
      title: `Unduh ${ids.length} foto ukuran penuh?`,
      text: `${c} foto memakai kuota unduhan (sisa ${quotaLeft()}). Kuota yang terpakai tidak kembali.`,
      ok: "Unduh",
    }))) return false;

    const prog = toastProgress(`Menyiapkan ${ids.length} foto…`);
    try {
      const rows = await rpc("claim_downloads", { p_event: status.event_id, p_photos: ids });
      status.downloads_used = (status.downloads_used || 0) + c;
      for (const r of rows) { const it = items.get(r.photo_id); if (it) it.downloaded = true; }
      updateQuota();

      const urls = await getUrls(rows.map((r) => r.file_path));
      const files = [];
      let done = 0;
      await Promise.all(rows.map(async (r, i) => {
        const res = await fetch(urls[r.file_path]);
        if (!res.ok) throw new Error("Gagal mengambil foto");
        const it = items.get(r.photo_id);
        const who = it?.owner_name ? `${safeName(it.owner_name)}-${String(it.seq).padStart(2, "0")}` : `foto-${i + 1}`;
        files.push({ name: `${safeName(status.name, "album")}-${who}.jpg`, blob: await res.blob() });
        prog(`Mengambil ${++done} / ${rows.length} foto…`);
      }));
      prog(null);
      await deliver(files);
      return true;
    } catch (e) {
      prog(null);
      toast(friendly(e));
      return false;
    }
  }

  // HP: lembar bagikan ("Simpan gambar" ke galeri) lewat satu ketukan lagi.
  // Laptop / banyak foto: unduh langsung atau ZIP.
  async function deliver(files) {
    const asFiles = files.map((f) => new File([f.blob], f.name, { type: "image/jpeg" }));
    const touch = matchMedia("(pointer: coarse)").matches;
    if (touch && files.length <= 10 && navigator.canShare?.({ files: asFiles })) {
      const { box, close } = modal(`
        <div class="ready">
          <h3>${files.length} foto siap</h3>
          <p class="hint">Ketuk Simpan, lalu pilih "Simpan Gambar" / "Simpan ke galeri".</p>
          <div class="row"><button class="btn ghost" data-act="file">Unduh sebagai file</button>
          <button class="btn primary" data-act="share">Simpan</button></div>
        </div>`);
      box.querySelector('[data-act="share"]').onclick = async () => {
        try { await navigator.share({ files: asFiles }); close(); }
        catch (e) { if (e.name !== "AbortError") { saveFiles(files); close(); } }
      };
      box.querySelector('[data-act="file"]').onclick = () => { saveFiles(files); close(); };
      return;
    }
    saveFiles(files);
  }

  function saveFiles(files) {
    if (files.length === 1) {
      const url = URL.createObjectURL(files[0].blob);
      download(url, files[0].name);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    Promise.all(files.map(async (f) => [f.name, [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }]]))
      .then((entries) => {
        const zip = zipSync(Object.fromEntries(entries));
        const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
        download(url, `${safeName(status.name, "album")}.zip`);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      });
  }

  async function openPhoto(r) {
    const box = el(`
      <div class="lightbox" role="dialog" aria-modal="true">
        <img alt="" />
        <div class="lb-bar">
          <span>${esc(label(r))} · ${esc(fmtDate(r.taken_at))}</span>
          <span class="lb-actions">
            <button class="btn small" data-act="dl">${r.is_mine || r.downloaded || unlimited() ? "Unduh" : "Unduh (1 kuota)"}</button>
            ${status.can_manage ? `<button class="btn small" data-act="hide">${r.hidden ? "Tampilkan" : "Sembunyikan"}</button>` : ""}
            <button class="btn small" data-act="close">Tutup</button>
          </span>
        </div>
      </div>`);
    document.body.append(box);
    const close = () => box.remove();
    box.querySelector('[data-act="close"]').onclick = close;
    box.onclick = (e) => { if (e.target === box) close(); };
    box.querySelector('[data-act="dl"]').onclick = async (e) => {
      e.currentTarget.disabled = true;
      if (await getPhotos([r.photo_id])) close(); else e.currentTarget.disabled = false;
    };
    const hide = box.querySelector('[data-act="hide"]');
    if (hide) hide.onclick = async () => {
      try {
        await rpc("hide_photo", { p_photo: r.photo_id, p_hidden: !r.hidden });
        r.hidden = !r.hidden;
        const tile = grid.querySelector(`[data-id="${r.photo_id}"]`);
        tile?.classList.toggle("is-hidden", r.hidden);
        tile?.querySelector(".badge:not(.mine)")?.remove();
        if (r.hidden) tile?.append(el(`<span class="badge">disembunyikan</span>`));
        close();
      } catch (e) { toast(friendly(e)); }
    };
    try {
      const urls = await getUrls([r.medium_path]);
      box.querySelector("img").src = urls[r.medium_path];
    } catch (e) { toast(friendly(e)); }
  }

  updateQuota();
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
  io.observe(view.querySelector(".sentinel"));
  await loadMore();
  const timer = setInterval(poll, 15000);

  return () => { clearInterval(timer); io.disconnect(); };
}

// Toast yang bisa diperbarui; panggil dengan null untuk menutup
function toastProgress(first) {
  toast(first, 60000);
  return (msg) => (msg ? toast(msg, 60000) : toast("Selesai.", 1200));
}
