// Tab Album: daftar foto, muat bertahap, diperbarui tiap 15 detik, unduh dengan kuota
import { zipSync } from "fflate";
import { rpc, friendly } from "./supabase.js";
import { getUrls } from "./storage.js";
import { attachZoom } from "./zoom.js";
import { el, esc, toast, fmtDate, download, safeName, modal, confirmDialog, ICON } from "./ui.js";

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
      <div class="album-progress" hidden></div>
      <button class="new-pill" hidden></button>
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
  const progressEl = view.querySelector(".album-progress");
  const pill = view.querySelector(".new-pill");
  let freshCount = 0;

  // ---- progres: gulungan sendiri dan tamu yang filmnya sudah habis ----
  let progress = null;
  async function loadProgress() {
    try { progress = await rpc("album_progress", { p_event: status.event_id }); } catch { return; }
    if (!progress) return;
    const reveal = status.reveal_at && new Date(status.reveal_at) > new Date();
    const mine = status.is_member && progress.my_used !== null && progress.my_used !== undefined;
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    progressEl.hidden = false;
    progressEl.innerHTML = `
      ${mine ? `
      <div class="ap-row"><b>Gulungan Anda</b><span>${progress.my_used} dari ${progress.max_shots} jepretan</span></div>
      <div class="bar"><span style="width:${pct(progress.my_used, progress.max_shots)}%"></span></div>` : ""}
      <div class="ap-row"><b>Tamu yang filmnya habis</b><span>${progress.rolls_done} dari ${progress.members}</span></div>
      <div class="bar mint"><span style="width:${pct(progress.rolls_done, progress.members)}%"></span></div>
      <small>${reveal ? `Semua foto terbuka ${esc(fmtDate(status.reveal_at))}.`
        : "Foto setiap tamu muncul di sini setelah filmnya habis atau acara ditutup."}</small>`;
  }

  // ---- pil "foto baru" saat pengguna sedang menggulir ke bawah ----
  pill.onclick = () => {
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    freshCount = 0;
    pill.hidden = true;
  };
  const onScroll = () => { if (window.scrollY < 120 && !pill.hidden) { freshCount = 0; pill.hidden = true; } };
  window.addEventListener("scroll", onScroll, { passive: true });

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
          <span class="check" aria-hidden="true">${ICON.check}</span>
        </button>`);
      n.onclick = () => {
        if (!selecting) return openViewer(r.photo_id);
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
        if (window.scrollY > 300) {
          freshCount += fresh.length;
          pill.textContent = `↑ ${freshCount} foto baru`;
          pill.hidden = false;
        }
      }
      updateEmpty();
      loadProgress();
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

  // ---- penampil foto: geser kiri/kanan, panah keyboard, ketuk dua kali untuk zoom ----
  const order = () => [...grid.querySelectorAll(".tile")].map((t) => t.dataset.id);
  const urlCache = new Map();
  async function mediumUrl(r) {
    if (!urlCache.has(r.medium_path)) {
      const urls = await getUrls([r.medium_path]);
      urlCache.set(r.medium_path, urls[r.medium_path]);
    }
    return urlCache.get(r.medium_path);
  }

  function openViewer(startId) {
    let id = startId;
    const box = el(`
      <div class="lightbox" role="dialog" aria-modal="true" aria-label="Penampil foto">
        <div class="lb-top">
          <span class="lb-count"></span>
          <button class="lb-icon" data-act="close" aria-label="Tutup">×</button>
        </div>
        <div class="lb-stage"><img class="lb-img" alt="" draggable="false" /></div>
        <button class="lb-nav prev" data-act="prev" aria-label="Foto sebelumnya">‹</button>
        <button class="lb-nav next" data-act="next" aria-label="Foto berikutnya">›</button>
        <div class="lb-bar">
          <span class="lb-info"></span>
          <span class="lb-actions">
            <button class="btn small" data-act="dl"></button>
            ${status.can_manage ? `<button class="btn small" data-act="hide"></button>` : ""}
          </span>
        </div>
      </div>`);
    const stage = box.querySelector(".lb-stage");
    const img = box.querySelector(".lb-img");
    const before = document.activeElement;
    document.body.append(box);
    box.querySelector('[data-act="close"]').focus();

    async function show() {
      const r = items.get(id);
      if (!r) return close();
      const list = order();
      const idx = list.indexOf(id);
      box.querySelector(".lb-count").textContent = `${idx + 1} / ${list.length}${endReached ? "" : "+"}`;
      box.querySelector(".lb-info").textContent = `${label(r)} · ${fmtDate(r.taken_at)}`;
      box.querySelector('[data-act="prev"]').disabled = idx <= 0;
      box.querySelector('[data-act="next"]').disabled = idx >= list.length - 1 && endReached;
      box.querySelector('[data-act="dl"]').textContent = r.is_mine || r.downloaded || unlimited() ? "Unduh" : "Unduh (1 kuota)";
      const hideBtn = box.querySelector('[data-act="hide"]');
      if (hideBtn) hideBtn.textContent = r.hidden ? "Tampilkan" : "Sembunyikan";
      setZoom(false);
      img.classList.add("loading");
      img.alt = `Foto ${label(r)}`;
      try {
        const url = await mediumUrl(r);
        if (id === r.photo_id) { img.src = url; }
      } catch (e) { toast(friendly(e)); }
      // Muat foto berikutnya lebih dulu, dan muat halaman album berikutnya jika hampir habis
      const nextId = list[idx + 1];
      if (nextId) mediumUrl(items.get(nextId)).then((u) => { new Image().src = u; }).catch(() => {});
      if (idx >= list.length - 3 && !endReached) loadMore();
    }
    img.onload = () => { img.classList.remove("loading"); zoom.measure(); };

    function step(dir) {
      const list = order();
      const idx = list.indexOf(id);
      const next = list[idx + dir];
      if (next) { id = next; show(); }
    }
    // Zoom foto (cubit, ketuk dua kali, roda mouse) dan geser untuk pindah foto
    const zoom = attachZoom(stage, img, { onSwipe: step });
    const setZoom = (on) => { if (!on) zoom.reset(); };

    const onKey = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    document.addEventListener("keydown", onKey);
    function close() {
      document.removeEventListener("keydown", onKey);
      zoom.destroy();
      box.remove();
      before?.focus?.();
    }
    box.querySelector('[data-act="close"]').onclick = close;
    box.querySelector('[data-act="prev"]').onclick = () => step(-1);
    box.querySelector('[data-act="next"]').onclick = () => step(1);
    box.querySelector('[data-act="dl"]').onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      await getPhotos([id]);
      b.disabled = false;
      show();
    };
    const hide = box.querySelector('[data-act="hide"]');
    if (hide) hide.onclick = async () => {
      const r = items.get(id);
      try {
        await rpc("hide_photo", { p_photo: r.photo_id, p_hidden: !r.hidden });
        r.hidden = !r.hidden;
        const tile = grid.querySelector(`[data-id="${r.photo_id}"]`);
        tile?.classList.toggle("is-hidden", r.hidden);
        tile?.querySelector(".badge:not(.mine)")?.remove();
        if (r.hidden) tile?.append(el(`<span class="badge">disembunyikan</span>`));
        show();
      } catch (e) { toast(friendly(e)); }
    };
    show();
  }

  updateQuota();
  loadProgress();
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
  io.observe(view.querySelector(".sentinel"));
  await loadMore();
  const timer = setInterval(poll, 15000);

  return () => { clearInterval(timer); io.disconnect(); window.removeEventListener("scroll", onScroll); };
}

// Toast yang bisa diperbarui; panggil dengan null untuk menutup
function toastProgress(first) {
  toast(first, 60000);
  return (msg) => (msg ? toast(msg, 60000) : toast("Selesai.", 1200));
}
