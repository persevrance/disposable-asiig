// Tab Album: daftar foto, muat bertahap, diperbarui tiap 15 detik
import { rpc, friendly } from "./supabase.js";
import { getUrls } from "./storage.js";
import { el, esc, toast, fmtDate } from "./ui.js";

const PAGE = 60;

export async function renderAlbum(root, status) {
  const items = new Map(); // photo_id -> row
  let oldest = null;
  let endReached = false;
  let loading = false;

  const view = el(`
    <section class="album">
      <div class="grid"></div>
      <div class="sentinel"></div>
      <div class="empty" hidden></div>
    </section>`);
  root.replaceChildren(view);
  const grid = view.querySelector(".grid");
  const empty = view.querySelector(".empty");

  function emptyText() {
    if (status.reveal_at && new Date(status.reveal_at) > new Date())
      return `Mode cuci film: semua foto tampil pada ${fmtDate(status.reveal_at)}.`;
    return `Foto tampil setelah pemotretnya menghabiskan ${status.max_shots} jepretan atau saat acara ditutup.`;
  }

  // Sisipkan ubin sesuai urutan taken_at (terbaru di atas)
  async function addRows(rows) {
    const fresh = rows.filter((r) => !items.has(r.photo_id));
    if (!fresh.length) return;
    const urls = await getUrls(fresh.map((r) => r.thumb_path));
    for (const r of fresh) {
      items.set(r.photo_id, r);
      const n = el(`
        <button class="tile${r.hidden ? " is-hidden" : ""}" data-id="${r.photo_id}" data-t="${esc(r.taken_at)}">
          <img loading="lazy" alt="Foto ${r.seq} oleh ${esc(r.owner_name)}" src="${esc(urls[r.thumb_path] || "")}" />
          ${r.hidden ? `<span class="badge">disembunyikan</span>` : ""}
        </button>`);
      n.onclick = () => openPhoto(r);
      const t = new Date(r.taken_at);
      const after = [...grid.children].find((c) => new Date(c.dataset.t) < t);
      grid.insertBefore(n, after || null);
    }
  }

  function updateEmpty() {
    empty.hidden = items.size > 0;
    empty.textContent = emptyText();
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

  async function openPhoto(r) {
    const box = el(`
      <div class="lightbox" role="dialog" aria-modal="true">
        <img alt="" />
        <div class="lb-bar">
          <span>#${r.seq} · ${esc(r.owner_name)} · ${esc(fmtDate(r.taken_at))}</span>
          <span class="lb-actions">
            ${status.is_owner ? `<button class="btn small" data-act="hide">${r.hidden ? "Tampilkan" : "Sembunyikan"}</button>` : ""}
            <button class="btn small" data-act="close">Tutup</button>
          </span>
        </div>
      </div>`);
    document.body.append(box);
    const close = () => box.remove();
    box.querySelector('[data-act="close"]').onclick = close;
    box.onclick = (e) => { if (e.target === box) close(); };
    const hide = box.querySelector('[data-act="hide"]');
    if (hide) hide.onclick = async () => {
      try {
        await rpc("hide_photo", { p_photo: r.photo_id, p_hidden: !r.hidden });
        r.hidden = !r.hidden;
        const tile = grid.querySelector(`[data-id="${r.photo_id}"]`);
        tile?.classList.toggle("is-hidden", r.hidden);
        tile?.querySelector(".badge")?.remove();
        if (r.hidden) tile?.append(el(`<span class="badge">disembunyikan</span>`));
        close();
      } catch (e) { toast(friendly(e)); }
    };
    try {
      const urls = await getUrls([r.file_path]);
      box.querySelector("img").src = urls[r.file_path];
    } catch (e) { toast(friendly(e)); }
  }

  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
  io.observe(view.querySelector(".sentinel"));
  await loadMore();
  const timer = setInterval(poll, 15000);

  return () => { clearInterval(timer); io.disconnect(); };
}
