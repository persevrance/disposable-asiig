// Tab Album: daftar foto, saringan (semua / foto saya / favorit / per tamu), muat bertahap,
// diperbarui tiap 15 detik, unduh dengan kuota, favorit, dan laporan foto.
import { zipSync } from "fflate";
import { rpc, friendly } from "./supabase.js";
import { getUrls } from "./storage.js";
import { attachZoom } from "./zoom.js";
import { filmName } from "./film.js";
import { canInstall, promptInstall } from "./install.js";
import { onAlbumPing, albumLive } from "./realtime.js";
import { pushSupport, enableAlbumNotify, disableAlbumNotify, albumNotifyOn, kickNotify } from "./push.js";
import { openCollage } from "./collage.js";
import { el, esc, toast, fmtDate, download, safeName, modal, confirmDialog, copyText, ICON } from "./ui.js";
import { t } from "./i18n.js";

const PAGE = 60;

const REASONS = () => [
  ["tidak_pantas", t("Tidak pantas"), t("Konten tidak sopan atau menyinggung")],
  ["privasi", t("Privasi"), t("Saya ada di foto ini dan tidak ingin dibagikan")],
  ["lainnya", t("Lainnya"), t("Alasan lain")],
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
      <div class="page-head">
        <div class="ph-text">
          <h1>${t("Album")}</h1>
          <span class="album-sub">${esc(status.name)}</span>
        </div>
        <div class="album-bar ph-actions">
          <button class="round-btn" data-act="collage" aria-label="${t("Kolase")}" title="${t("Kolase")}">${ICON.grid}</button>
          <button class="round-btn" data-act="select" aria-label="${t("Pilih untuk unduh")}" title="${t("Pilih untuk unduh")}">${ICON.download}</button>
        </div>
      </div>
      <div class="album-filter" hidden>
        <div class="chips" role="group" aria-label="${t("Saring album")}">
          <button type="button" class="chip" data-f="all" aria-pressed="true">${t("Semua")}</button>
          ${status.is_member ? `<button type="button" class="chip" data-f="mine" aria-pressed="false">${t("Foto saya")}</button>` : ""}
          <button type="button" class="chip" data-f="fav" aria-pressed="false">${t("Favorit")}</button>
          <select class="chip owner-filter" aria-label="${t("Foto dari tamu")}" hidden></select>
        </div>
      </div>
      <div class="album-progress" hidden></div>
      <div class="keep-slot"></div>
      <div class="notify-slot"></div>
      <p class="dl-quota"></p>
      <button class="new-pill" hidden></button>
      <div class="grid"></div>
      <div class="sentinel"></div>
      <div class="empty" hidden></div>
      <div class="select-bar" hidden>
        <span class="sel-info"></span>
        <button class="btn small ghost" data-act="cancel">${t("Batal")}</button>
        <button class="btn small" data-act="auto" hidden>${t("Pilihkan otomatis")}</button>
        <button class="btn small" data-act="sel-collage">${t("Kolase")}</button>
        <button class="btn small primary" data-act="get">${t("Unduh")}</button>
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
    progressEl.hidden = false;
    // Strip ringkas: "Gulunganmu 30/30 · 18 dari 42 tamu sudah habis filmnya"
    if (typeof progress.photos === "number") view.querySelector(".album-sub").textContent = `${status.name} · ${t("{n} foto", { n: progress.photos })}`;
    progressEl.title = reveal ? t("Semua foto terbuka {d}.", { d: fmtDate(status.reveal_at) })
      : t("Foto setiap tamu muncul di sini setelah filmnya habis atau acara ditutup.");
    progressEl.innerHTML = `
      ${mine ? `<b>${t("Gulunganmu {a}/{b}", { a: progress.my_used, b: progress.max_shots })}</b>` : ""}
      <span>${mine ? "· " : ""}${t("{a} dari {b} tamu sudah habis filmnya", { a: progress.rolls_done, b: progress.members })}</span>
      ${reveal ? `<small>${esc(t("Semua foto terbuka {d}.", { d: fmtDate(status.reveal_at) }))}</small>` : ""}`;
    renderKeepCard();
    renderNotify();
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
          <b>${t("Simpan album ini")}</b>
          <p>${t("Foto tamu lain terus bertambah sampai acara selesai. Buka lagi kapan saja lewat link ini atau dari layar utama HP.")}</p>
        </div>
        <div class="row tight wrap">
          <button class="btn small" data-act="link">${ICON.link} ${t("Salin link album")}</button>
          ${canInstall() ? `<button class="btn small primary" data-act="install">${ICON.phone} ${t("Pasang di layar utama")}</button>` : ""}
          <button class="btn small ghost" data-act="hide">${t("Tutup")}</button>
        </div>
      </div>`);
    card.querySelector('[data-act="link"]').onclick = () =>
      copyText(link, { done: t("Link album disalin. Buka dengan akun Google yang sama."), title: t("Link album") });
    card.querySelector('[data-act="install"]')?.addEventListener("click", async () => {
      if (await promptInstall()) toast(t("Aplikasi terpasang di layar utama."));
    });
    card.querySelector('[data-act="hide"]').onclick = () => {
      try { localStorage.setItem(keepKey, "1"); } catch { /* abaikan */ }
      card.remove();
    };
    slot.replaceChildren(card);
  }

  // ---- kabari saya saat album terbuka penuh (notifikasi browser) ----
  // Tampil selama acara masih terbuka dan belum ada waktu cuci film yang lewat.
  let notifyOn = null;
  async function renderNotify() {
    const slot = view.querySelector(".notify-slot");
    const revealed = status.reveal_at && new Date(status.reveal_at) <= new Date();
    const sup = pushSupport();
    if (!status.is_open || revealed || sup === "off" || sup === "unsupported") { slot.replaceChildren(); return; }
    if (notifyOn === null) notifyOn = await albumNotifyOn(status.event_id);
    const card = el(`
      <div class="notify-card">
        ${ICON.bell}
        <span>${notifyOn ? t("Anda akan dikabari saat semua foto terbuka.")
          : sup === "ios-install" ? t("Di iPhone, pasang aplikasi di layar utama dulu untuk menerima kabar saat album terbuka.")
          : sup === "denied" ? t("Notifikasi diblokir di browser ini. Izinkan di pengaturan situs untuk menerima kabar.")
          : t("Ingin dikabari saat semua foto terbuka?")}</span>
        ${sup === "ok" ? `<button class="btn small ${notifyOn ? "ghost" : "primary"}" data-act="notify">${notifyOn ? t("Batalkan") : t("Kabari saya")}</button>` : ""}
      </div>`);
    card.querySelector('[data-act="notify"]')?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        if (notifyOn) { await disableAlbumNotify(status.event_id); notifyOn = false; toast(t("Kabar album dibatalkan.")); }
        else { await enableAlbumNotify(status.event_id); notifyOn = true; toast(t("Siap. Anda akan dikabari saat album terbuka.")); }
      } catch (err) { toast(err?.message?.length < 120 ? err.message : friendly(err)); }
      renderNotify();
    });
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
    ownerSel.innerHTML = `<option value="">${t("Per tamu")}</option>` + owners.map((o) =>
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
      ? t("Unduh ukuran penuh tanpa batas (pengelola acara).")
      : t("Sisa unduhan: {a} dari {b} · foto Anda sendiri gratis", { a: quotaLeft(), b: status.max_shots });
  }

  // Mode pilih: "download" (unduh, memakai kuota) atau "collage" (2–9 foto, tanpa kuota)
  const COLLAGE_MAX = 9;
  let selMode = "download";
  const collageBtn = view.querySelector('[data-act="sel-collage"]');
  function updateSelBar() {
    if (selMode === "collage") {
      selInfo.textContent = t("{n}/{max} dipilih", { n: selected.size, max: COLLAGE_MAX });
      selInfo.classList.remove("warn");
      collageBtn.disabled = selected.size < 2;
      return;
    }
    const c = cost(selected);
    selInfo.textContent = unlimited() || !c
      ? t("{n} dipilih", { n: selected.size })
      : t("{n} dipilih · memakai {c} kuota", { n: selected.size, c });
    const over = !unlimited() && c > quotaLeft();
    selInfo.classList.toggle("warn", over);
    view.querySelector('[data-act="get"]').disabled = !selected.size || over;
    collageBtn.disabled = selected.size < 2;
  }

  function setSelecting(on, mode = "download") {
    selecting = on;
    selMode = mode;
    selected.clear();
    grid.classList.toggle("selecting", on);
    grid.querySelectorAll(".tile.selected").forEach((t) => t.classList.remove("selected"));
    selBar.hidden = !on;
    selBar.classList.toggle("collage-mode", mode === "collage");
    selectBtn.hidden = on;
    view.querySelector('[data-act="collage"]').hidden = on;
    view.querySelector('[data-act="get"]').hidden = mode === "collage";
    view.querySelector('[data-act="auto"]').hidden = mode !== "collage";
    collageBtn.textContent = mode === "collage" ? t("Buat kolase") : t("Kolase");
    collageBtn.classList.toggle("primary", mode === "collage");
    if (on && mode === "collage") toast(t("Ketuk 2–9 foto untuk kolase."), 2500);
    updateSelBar();
  }
  selectBtn.onclick = () => setSelecting(true);
  view.querySelector('[data-act="cancel"]').onclick = () => setSelecting(false);
  view.querySelector('[data-act="get"]').onclick = async (e) => {
    e.currentTarget.disabled = true;
    const ok = await getPhotos([...selected]);
    if (ok) setSelecting(false); else updateSelBar();
  };

  // ---- kolase: dari foto terpilih, atau favorit lalu foto terbaru ----
  async function collageFrom(ids) {
    const rows = ids.map((id) => items.get(id)).filter(Boolean).slice(0, 9);
    try {
      const urls = await getUrls(rows.map((r) => r.medium_path));
      openCollage(status, rows.map((r) => ({ url: urls[r.medium_path], owner_name: r.owner_name })).filter((p) => p.url));
    } catch (e) { toast(friendly(e)); }
  }
  // Tombol kolase di kepala album: masuk mode pilih khusus kolase
  view.querySelector('[data-act="collage"]').onclick = () => setSelecting(true, "collage");
  // Pilihkan otomatis: favorit dulu, lalu foto terbaru
  view.querySelector('[data-act="auto"]').onclick = () => {
    const all = [...items.values()].filter((r) => !r.hidden);
    const pick = [...all.filter((r) => r.is_fav), ...all.filter((r) => !r.is_fav)].slice(0, COLLAGE_MAX).map((r) => r.photo_id);
    setSelecting(false);
    collageFrom(pick);
  };
  collageBtn.onclick = () => { const ids = [...selected]; setSelecting(false); collageFrom(ids); };

  function emptyText() {
    if (filter.kind === "fav") return t("Belum ada favorit. Ketuk ikon hati saat melihat foto untuk menyimpannya di sini.");
    if (filter.kind === "mine") return t("Foto Anda muncul di sini setelah film Anda habis atau acara ditutup.");
    if (filter.owner) return t("Belum ada foto dari tamu ini.");
    if (status.reveal_at && new Date(status.reveal_at) > new Date())
      return t("Mode cuci film: semua foto tampil pada {d}.", { d: fmtDate(status.reveal_at) });
    return t("Foto tampil setelah pemotretnya menghabiskan {n} jepretan atau saat acara ditutup.", { n: status.max_shots });
  }

  const label = (r) => (r.owner_name ? `#${r.seq} · ${r.owner_name}` : t("Tamu"));

  function tileBadges(r) {
    return `${r.hidden ? `<span class="badge">${t("disembunyikan")}</span>` : ""}
      ${r.is_mine ? `<span class="badge mine">${t("milik Anda")}</span>` : ""}
      ${r.is_fav ? `<span class="badge fav" aria-label="${t("Favorit")}">${ICON.heart}</span>` : ""}`;
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
          <img loading="lazy" alt="${esc(t("Foto {x}", { x: label(r) }))}" src="${esc(urls[r.thumb_path] || "")}" />
          <span class="tile-badges">${tileBadges(r)}</span>
          <span class="check" aria-hidden="true">${ICON.check}</span>
        </button>`);
      n.onclick = () => {
        if (!selecting) return openViewer(r.photo_id);
        if (selected.has(r.photo_id)) selected.delete(r.photo_id);
        else if (selMode === "collage" && selected.size >= COLLAGE_MAX) { toast(t("Kolase paling banyak {n} foto.", { n: COLLAGE_MAX })); return; }
        else selected.add(r.photo_id);
        n.classList.toggle("selected", selected.has(r.photo_id));
        updateSelBar();
      };
      const takenAt = new Date(r.taken_at);
      const after = [...grid.children].find((c) => new Date(c.dataset.t) < takenAt);
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
          pill.textContent = t("{n} foto baru", { n: freshCount });
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
    if (!unlimited() && c > quotaLeft()) { toast(t("Kuota unduhan tidak cukup.")); return false; }
    if (!unlimited() && c > 0 && !(await confirmDialog({
      title: t("Unduh {n} foto ukuran penuh?", { n: ids.length }),
      text: t("{c} foto memakai kuota unduhan (sisa {left}). Kuota yang terpakai tidak kembali.", { c, left: quotaLeft() }),
      ok: t("Unduh"),
    }))) return false;

    const prog = toastProgress(t("Menyiapkan {n} foto…", { n: ids.length }));
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
        if (!res.ok) throw new Error(t("Gagal mengambil foto"));
        const it = items.get(r.photo_id);
        const who = it?.owner_name ? `${safeName(it.owner_name)}-${String(it.seq).padStart(2, "0")}` : `foto-${i + 1}`;
        files.push({ name: `${safeName(status.name, "album")}-${who}.jpg`, blob: await res.blob() });
        prog(t("Mengambil {a} / {b} foto…", { a: ++done, b: rows.length }));
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
          <h3>${t("{n} foto siap", { n: files.length })}</h3>
          <p class="hint">${t("Ketuk Simpan, lalu pilih \"Simpan Gambar\" / \"Simpan ke galeri\".")}</p>
          <div class="row"><button class="btn ghost" data-act="file">${t("Unduh sebagai file")}</button>
          <button class="btn primary" data-act="share">${t("Simpan")}</button></div>
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
          <h3>${t("Laporkan foto")}</h3>
          <p>${t("Laporan dikirim ke pengelola acara. Nama Anda tidak ditampilkan ke pemotret.")}</p>
          <div class="radio-list">${REASONS().map(([v, title, d], i) => `
            <label class="radio"><input type="radio" name="reason" value="${v}" ${i === 0 ? "checked" : ""}/>
              <span><b>${title}</b><small>${d}</small></span></label>`).join("")}
          </div>
          <label>${t("Catatan (opsional)")} <textarea name="note" rows="2" maxlength="300"></textarea></label>
          <div class="dialog-actions">
            <button type="button" class="btn ghost" data-act="no">${t("Batal")}</button>
            <button class="btn primary">${t("Kirim laporan")}</button>
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
          toast(t("Terima kasih. Laporan dikirim ke pengelola acara."));
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
      <div class="lightbox" role="dialog" aria-modal="true" aria-label="${t("Penampil foto")}">
        <div class="lb-top">
          <button class="lb-icon" data-act="close" aria-label="${t("Tutup")}">${ICON.close}</button>
          <span class="lb-count"></span>
          ${status.can_manage ? `<span class="lb-icon-gap"></span>` : `<button class="lb-icon" data-act="report" aria-label="${t("Laporkan foto")}" title="${t("Laporkan foto")}">${ICON.flag}</button>`}
        </div>
        <div class="lb-frame"><div class="lb-stage"><img class="lb-img" alt="" draggable="false" /></div></div>
        <button class="lb-nav prev" data-act="prev" aria-label="${t("Foto sebelumnya")}">${ICON.back}</button>
        <button class="lb-nav next" data-act="next" aria-label="${t("Foto berikutnya")}">${ICON.back}</button>
        <div class="lb-bar">
          <div class="lb-info"><span class="lb-avatar" aria-hidden="true"></span><span><b class="lb-who"></b><small class="lb-film"></small></span></div>
          <div class="lb-actions">
            <button class="lb-btn lb-fav" data-act="fav" aria-pressed="false">${ICON.heart}<span>${t("Favorit")}</span></button>
            <button class="lb-btn light" data-act="dl"></button>
            ${status.can_manage ? `<button class="lb-btn wide" data-act="hide"></button>` : ""}
          </div>
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
      const who = r.owner_name || t("Tamu");
      box.querySelector(".lb-avatar").textContent = who.trim()[0]?.toUpperCase() || "?";
      box.querySelector(".lb-who").textContent = who;
      box.querySelector(".lb-film").textContent = [
        r.seq ? t("Jepretan {a}/{b}", { a: r.seq, b: status.max_shots }) : "",
        fmtDate(r.taken_at),
        r.film ? t("Efek {f}", { f: t(filmName(r.film)) }) : "",
      ].filter(Boolean).join(" · ");
      box.querySelector('[data-act="prev"]').disabled = idx <= 0;
      box.querySelector('[data-act="next"]').disabled = idx >= list.length - 1 && endReached;
      box.querySelector('[data-act="dl"]').innerHTML = `${ICON.download}<span>${r.is_mine || r.downloaded || unlimited() ? t("Simpan") : t("Simpan (1 kuota)")}</span>`;
      favBtn.setAttribute("aria-pressed", String(Boolean(r.is_fav)));
      favBtn.setAttribute("aria-label", r.is_fav ? t("Hapus dari favorit") : t("Tambah ke favorit"));
      favBtn.classList.toggle("on", Boolean(r.is_fav));
      if (reportBtn) reportBtn.hidden = r.is_mine;
      const hideBtn = box.querySelector('[data-act="hide"]');
      if (hideBtn) hideBtn.textContent = r.hidden ? t("Tampilkan") : t("Sembunyikan");
      setZoom(false);
      img.classList.add("loading");
      img.alt = t("Foto {x}", { x: label(r) });
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
        toast(r.is_fav ? t("Disimpan di Favorit.") : t("Dihapus dari Favorit."), 1500);
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
  kickNotify();
  // Realtime: muat ulang segera saat ada foto baru; polling jarang sebagai cadangan
  let wait = 0;
  const off = onAlbumPing(status.event_id, (m) => {
    if (m.state) return;
    if (m.kind === "message") return;
    clearTimeout(wait);
    wait = setTimeout(() => { poll(); if (m.kind === "closed") kickNotify(true); }, 1200);
  });
  // Tanpa realtime: tiap 15 detik seperti dulu. Dengan realtime: cadangan tiap 60 detik.
  const timer = setInterval(() => { if (!albumLive(status.event_id)) poll(); }, 15000);
  const slow = setInterval(poll, 60000);

  return () => { clearInterval(timer); clearInterval(slow); clearTimeout(wait); off(); io.disconnect(); window.removeEventListener("scroll", onScroll); };
}

// Toast yang bisa diperbarui; panggil dengan null untuk menutup
function toastProgress(first) {
  toast(first, 60000);
  return (msg) => (msg ? toast(msg, 60000) : toast(t("Selesai."), 1200));
}
