// Tab Album: daftar foto, saringan (semua / foto saya / favorit / per tamu), muat bertahap,
// diperbarui tiap 15 detik, unduh dengan kuota, favorit, dan laporan foto.
import { zipSync } from "fflate";
import { rpc, friendly } from "./supabase.js";
import { getUrls } from "./storage.js";
import { attachZoom } from "./zoom.js";
import { filmName } from "./film.js";
import { canInstall, promptInstall } from "./install.js";
import { el, esc, toast, fmtDate, download, safeName, modal, confirmDialog, copyText, ICON } from "./ui.js";

const PAGE = 60;

const REASONS = [
  ["tidak_pantas", "Tidak pantas", "Konten tidak sopan atau menyinggung"],
  ["privasi", "Privasi", "Saya ada di foto ini dan tidak ingin dibagikan"],
  ["lainnya", "Lainnya", "Alasan lain"],
];

export async function renderAlbum(root, status) {
  const items = new Map(); // photo_id -> row
  const selected = new Set();
  let oldest = null;
  let endReached = false;
  let loading = false;
  let selecting = false;
  let gen = 0;                                     // naik setiap saringan berganti
  const filter = { kind: "all", owner: null };

  const view = el(`
    <section class="album">
      <div class="keep-slot"></div>
      <div class="album-progress" hidden></div>
      <button class="new-pill" hidden></button>
      <div class="album-filter" hidden>
        <div class="chips" role="group" aria-label="Saring album">
          <button type="button" class="chip" data-f="all" aria-pressed="true">Semua</button>
          ${status.is_member ? `<button type="button" class="chip" data-f="mine" aria-pressed="false">Foto saya</button>` : ""}
          <button type="button" class="chip" data-f="fav" aria-pressed="false">${ICON.heart}<span>Favorit</span></button>
        </div>
        <select class="owner-filter" aria-label="Foto dari tamu" hidden></select>
      </div>
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
  const filterBar = view.querySelector(".album-filter");
  const ownerSel = view.querySelector(".owner-filter");
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
    renderKeepCard();
  }

  // ---- simpan album: link permanen + pasang di layar utama ----
  // Muncul setelah gulungan tamu habis atau acara ditutup, bisa ditutup.
  const keepKey = `keepCard:${status.event_id}`;
  function renderKeepCard() {
    const slot = view.querySelector(".keep-slot");
    let dismissed = false;
    try { dismissed = localStorage.getItem(keepKey) === "1"; } catch { /* abaikan */ }
    const rollDone = progress && progress.my_used !== null && progress.my_used >= progress.max_shots;
    if (dismissed || !status.is_member || !(rollDone || !status.is_open)) { slot.replaceChildren(); return; }
    if (slot.firstChild) return;
    const link = `${location.origin}/#/e/${status.event_id}/album`;
    const card = el(`
      <div class="card keep-card">
        <div>
          <b>Simpan album ini</b>
          <p>Foto tamu lain terus bertambah sampai acara selesai. Buka lagi kapan saja lewat link ini atau dari layar utama HP.</p>
        </div>
        <div class="row tight wrap">
          <button class="btn small" data-act="link">${ICON.link} Salin link album</button>
          ${canInstall() ? `<button class="btn small primary" data-act="install">${ICON.phone} Pasang di layar utama</button>` : ""}
          <button class="btn small ghost" data-act="hide">Tutup</button>
        </div>
      </div>`);
    card.querySelector('[data-act="link"]').onclick = () =>
      copyText(link, { done: "Link album disalin. Buka dengan akun Google yang sama.", title: "Link album" });
    card.querySelector('[data-act="install"]')?.addEventListener("click", async () => {
      if (await promptInstall()) toast("Aplikasi terpasang di layar utama.");
    });
    card.querySelector('[data-act="hide"]').onclick = () => {
      try { localStorage.setItem(keepKey, "1"); } catch { /* abaikan */ }
      card.remove();
    };
    slot.replaceChildren(card);
  }

  // ---- pil "foto baru" saat pengguna sedang menggulir ke bawah ----
  pill.onclick = () => {
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    freshCount = 0;
    pill.hidden = true;
  };
  const onScroll = () => { if (window.scrollY < 120 && !pill.hidden) { freshCount = 0; pill.hidden = true; } };
  window.addEventListener("scroll", onScroll, { passive: true });

  // ---- saringan ----
  // Hanya kirim parameter baru bila dipakai, supaya tetap jalan di database lama
  const albumArgs = (before, limit) => {
    const a = { p_event: status.event_id, p_before: before, p_limit: limit };
    if (filter.kind !== "all") a.p_filter = filter.kind;
    if (filter.owner) a.p_owner = filter.owner;
    return a;
  };
  filterBar.querySelector(".chips").onclick = (e) => {
    const b = e.target.closest(".chip");
    if (!b || (b.dataset.f === filter.kind && !filter.owner)) return;
    filter.kind = b.dataset.f;
    filter.owner = null;          // chip apa pun (termasuk Semua) melepas saringan per tamu
    ownerSel.value = "";
    syncChips();
    reload();
  };
  ownerSel.onchange = () => {
    filter.owner = ownerSel.value || null;
    if (filter.owner) filter.kind = "all";
    syncChips();
    reload();
  };
  function syncChips() {
    filterBar.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.f === filter.kind && !filter.owner)));
  }
  async function loadOwners() {
    let owners = [];
    try { owners = await rpc("album_owners", { p_event: status.event_id }); } catch { /* database lama: tanpa saringan tamu */ }
    ownerSel.hidden = owners.length < 2;
    if (ownerSel.hidden) return;
    ownerSel.innerHTML = `<option value="">Semua tamu</option>` + owners.map((o) =>
      `<option value="${o.user_id}" ${o.user_id === filter.owner ? "selected" : ""}>${esc(o.name)} (${o.photos})</option>`).join("");
  }
  function reload() {
    gen++;
    items.clear();
    grid.replaceChildren();
    oldest = null;
    endReached = false;
    loading = false;
    if (selecting) setSelecting(false);
    loadMore();
  }

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
    if (filter.kind === "fav") return "Belum ada favorit. Ketuk ikon hati saat melihat foto untuk menyimpannya di sini.";
    if (filter.kind === "mine") return "Foto Anda muncul di sini setelah film Anda habis atau acara ditutup.";
    if (filter.owner) return "Belum ada foto dari tamu ini.";
    if (status.reveal_at && new Date(status.reveal_at) > new Date())
      return `Mode cuci film: semua foto tampil pada ${fmtDate(status.reveal_at)}.`;
    return `Foto tampil setelah pemotretnya menghabiskan ${status.max_shots} jepretan atau saat acara ditutup.`;
  }

  const label = (r) => (r.owner_name ? `#${r.seq} · ${r.owner_name}` : "Tamu");

  function tileBadges(r) {
    return `${r.hidden ? `<span class="badge">disembunyikan</span>` : ""}
      ${r.is_mine ? `<span class="badge mine">milik Anda</span>` : ""}
      ${r.is_fav ? `<span class="badge fav" aria-label="Favorit">${ICON.heart}</span>` : ""}`;
  }

  // Sisipkan ubin sesuai urutan taken_at (terbaru di atas)
  async function addRows(rows, myGen) {
    const fresh = rows.filter((r) => !items.has(r.photo_id));
    if (!fresh.length) return;
    const urls = await getUrls(fresh.map((r) => r.thumb_path));
    if (myGen !== gen) return;                     // saringan berganti selama menunggu
    for (const r of fresh) {
      if (items.has(r.photo_id)) continue;
      items.set(r.photo_id, r);
      const n = el(`
        <button class="tile${r.hidden ? " is-hidden" : ""}" data-id="${r.photo_id}" data-t="${esc(r.taken_at)}">
          <img loading="lazy" alt="Foto ${esc(label(r))}" src="${esc(urls[r.thumb_path] || "")}" />
          <span class="tile-badges">${tileBadges(r)}</span>
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
  function refreshTile(r) {
    const tile = grid.querySelector(`[data-id="${r.photo_id}"]`);
    if (!tile) return;
    tile.classList.toggle("is-hidden", r.hidden);
    tile.querySelector(".tile-badges").innerHTML = tileBadges(r);
  }

  let everHadPhotos = false;
  function updateEmpty() {
    if (items.size) everHadPhotos = true;
    empty.hidden = items.size > 0;
    empty.textContent = emptyText();
    view.querySelector(".album-bar").hidden = items.size === 0;
    filterBar.hidden = !everHadPhotos && filter.kind === "all" && !filter.owner;
  }

  async function loadMore() {
    if (loading || endReached) return;
    loading = true;
    const myGen = gen;
    try {
      const rows = await rpc("get_album", albumArgs(oldest, PAGE));
      if (myGen !== gen) return;
      if (rows.length < PAGE) endReached = true;
      if (rows.length) oldest = rows[rows.length - 1].taken_at;
      await addRows(rows, myGen);
    } catch (e) {
      if (myGen === gen) toast(friendly(e));
    } finally {
      if (myGen === gen) { loading = false; updateEmpty(); }
    }
  }

  async function poll() {
    const myGen = gen;
    try {
      const rows = await rpc("get_album", albumArgs(null, 100));
      if (myGen !== gen) return;
      // Gulungan yang baru habis bisa berisi foto lama: sisipkan sesuai urutan,
      // dan izinkan gulir ke bawah memuat lagi yang lebih lama.
      const fresh = rows.filter((r) => !items.has(r.photo_id));
      if (fresh.length) {
        await addRows(fresh, myGen);
        if (!oldest) oldest = rows[rows.length - 1].taken_at;
        endReached = false;
        if (window.scrollY > 300) {
          freshCount += fresh.length;
          pill.textContent = `↑ ${freshCount} foto baru`;
          pill.hidden = false;
        }
        loadOwners();
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

  // ---- laporkan foto ----
  function reportDialog(r) {
    return new Promise((resolve) => {
      let sent = false;
      const { box, close } = modal(`
        <form class="dialog">
          <h3>Laporkan foto</h3>
          <p>Laporan dikirim ke pengelola acara. Nama Anda tidak ditampilkan ke pemotret.</p>
          <div class="radio-list">${REASONS.map(([v, t, d], i) => `
            <label class="radio"><input type="radio" name="reason" value="${v}" ${i === 0 ? "checked" : ""}/>
              <span><b>${t}</b><small>${d}</small></span></label>`).join("")}
          </div>
          <label>Catatan (opsional) <textarea name="note" rows="2" maxlength="300"></textarea></label>
          <div class="dialog-actions">
            <button type="button" class="btn ghost" data-act="no">Batal</button>
            <button class="btn primary">Kirim laporan</button>
          </div>
        </form>`, { onClose: () => resolve(sent) });
      const f = box.querySelector("form");
      box.querySelector('[data-act="no"]').onclick = close;
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector(".btn.primary");
        btn.disabled = true;
        try {
          await rpc("report_photo", { p_photo: r.photo_id, p_reason: f.elements.reason.value, p_note: f.elements.note.value });
          sent = true;
          toast("Terima kasih. Laporan dikirim ke pengelola acara.");
          close();
        } catch (err) { toast(friendly(err)); btn.disabled = false; }
      };
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
          <span class="lb-info"><span class="lb-who"></span><small class="lb-film"></small></span>
          <span class="lb-actions">
            <button class="btn small icon-btn lb-fav" data-act="fav" aria-pressed="false" aria-label="Favorit">${ICON.heart}</button>
            <button class="btn small" data-act="dl"></button>
            ${status.can_manage ? `<button class="btn small" data-act="hide"></button>` : ""}
            ${status.can_manage ? "" : `<button class="btn small icon-btn" data-act="report" aria-label="Laporkan foto" title="Laporkan foto">${ICON.flag}</button>`}
          </span>
        </div>
      </div>`);
    const stage = box.querySelector(".lb-stage");
    const img = box.querySelector(".lb-img");
    const favBtn = box.querySelector('[data-act="fav"]');
    const reportBtn = box.querySelector('[data-act="report"]');
    const before = document.activeElement;
    document.body.append(box);
    box.querySelector('[data-act="close"]').focus();

    async function show() {
      const r = items.get(id);
      if (!r) return close();
      const list = order();
      const idx = list.indexOf(id);
      box.querySelector(".lb-count").textContent = `${idx + 1} / ${list.length}${endReached ? "" : "+"}`;
      box.querySelector(".lb-who").textContent = `${label(r)} · ${fmtDate(r.taken_at)}`;
      box.querySelector(".lb-film").textContent = r.film ? `Film ${filmName(r.film)}` : "";
      box.querySelector('[data-act="prev"]').disabled = idx <= 0;
      box.querySelector('[data-act="next"]').disabled = idx >= list.length - 1 && endReached;
      box.querySelector('[data-act="dl"]').textContent = r.is_mine || r.downloaded || unlimited() ? "Unduh" : "Unduh (1 kuota)";
      favBtn.setAttribute("aria-pressed", String(Boolean(r.is_fav)));
      favBtn.setAttribute("aria-label", r.is_fav ? "Hapus dari favorit" : "Tambah ke favorit");
      favBtn.classList.toggle("on", Boolean(r.is_fav));
      if (reportBtn) reportBtn.hidden = r.is_mine;
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
      if (document.querySelector(".modal")) return;  // dialog laporan sedang terbuka
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
    favBtn.onclick = async () => {
      const r = items.get(id);
      favBtn.disabled = true;
      try {
        r.is_fav = await rpc("toggle_favorite", { p_photo: r.photo_id });
        refreshTile(r);
        toast(r.is_fav ? "Disimpan di Favorit." : "Dihapus dari Favorit.", 1500);
        show();
      } catch (e) { toast(friendly(e)); }
      finally { favBtn.disabled = false; }
    };
    if (reportBtn) reportBtn.onclick = () => reportDialog(items.get(id));
    const hide = box.querySelector('[data-act="hide"]');
    if (hide) hide.onclick = async () => {
      const r = items.get(id);
      try {
        await rpc("hide_photo", { p_photo: r.photo_id, p_hidden: !r.hidden });
        r.hidden = !r.hidden;
        refreshTile(r);
        show();
      } catch (e) { toast(friendly(e)); }
    };
    show();
  }

  updateQuota();
  loadProgress();
  loadOwners();
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
