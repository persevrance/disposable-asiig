import "./style.css";
import "./brand.css";
import { supabase, configured, rpc, friendly } from "./supabase.js";
import { flushQueue } from "./shoot.js";
import { renderCamera } from "./camera-view.js";
import { renderAlbum } from "./album.js";
import { renderSlideshow } from "./slideshow.js";
import "./install.js"; // tangkap prompt pasang aplikasi sedini mungkin
import { renderPanel, deleteEventFiles } from "./owner.js";
import { renderAdmin } from "./admin.js";
import { mountPayment } from "./payment.js";
import { renderGuestbook } from "./guestbook.js";
import { openPrivacy } from "./privacy.js";
import { coverUrl, setStorageBackend } from "./storage.js";
import { setVapidKey } from "./push.js";
import { noteEventSize } from "./realtime.js";
import { el, esc, toast, copyText, ICON, brandLockup, fmtRange, modal, initial, confirmDialog, liveCountdown } from "./ui.js";
import { landingHtml } from "./landing.js";
import { renderPricing } from "./pricing-page.js";
import { renderCreate } from "./create-event.js";
import { themeSwitch, bindThemeSwitch } from "./theme.js";
import { myCreatorRequest, openCreatorRequest, requestStatusCard } from "./creator-request.js";
import { t, langSwitch, bindLangSwitch } from "./i18n.js";

const app = document.getElementById("app");
let cleanup = () => {};
let session = null;

// ---------- Kode undangan dari link ?kode=ABC123 ----------
const params = new URLSearchParams(location.search);
if (params.get("kode")) {
  localStorage.setItem("pendingCode", params.get("kode").trim().toUpperCase());
  params.delete("kode");
  const q = params.toString();
  history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
}

// ---------- Tautan khusus acara: domain/<slug> -> kode undangan ----------
// Worker menyajikan index.html untuk alamat yang tidak dikenal (single-page-application).
async function resolveSlugPath() {
  const m = location.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{1,38}[A-Za-z0-9])\/?$/);
  if (!m) return;
  try {
    const code = await rpc("resolve_slug", { p_slug: m[1].toLowerCase() });
    if (code) localStorage.setItem("pendingCode", code);
    else toast(t("Tautan acara tidak ditemukan. Minta kode undangan ke penyelenggara."), 6000);
  } catch { /* tetap buka halaman utama */ }
  history.replaceState(null, "", "/" + location.search + location.hash);
}

// ---------- Acara yang dimasuki dengan kode DI PERANGKAT INI ----------
// Keanggotaan tersimpan per akun di server, tetapi beranda hanya menampilkan
// acara yang kodenya sudah dimasukkan di perangkat ini (dan acara milik sendiri).
// Daftar ini dihapus saat keluar, jadi login berikutnya perlu kode lagi.
const joinedKey = () => `joined:${session?.user?.id}`;
function joinedHere() {
  try { return JSON.parse(localStorage.getItem(joinedKey()) || "[]"); } catch { return []; }
}
function rememberJoined(id) {
  try {
    const list = joinedHere().filter((x) => x !== id);
    list.unshift(id);
    localStorage.setItem(joinedKey(), JSON.stringify(list.slice(0, 50)));
  } catch { /* penyimpanan diblokir: acara tetap bisa dibuka lewat kode */ }
}
function forgetJoined() {
  try { localStorage.removeItem(joinedKey()); } catch { /* abaikan */ }
}

// Link langsung ke halaman acara (mis. link album) harus bertahan melewati login Google,
// yang selalu kembali ke halaman utama.
const PENDING_HASH = "pendingHash";
function savePendingHash() {
  if (/^#\/(e\/|buat)/.test(location.hash)) {
    try { localStorage.setItem(PENDING_HASH, location.hash); } catch { /* abaikan */ }
  }
}
function takePendingHash() {
  try {
    const h = localStorage.getItem(PENDING_HASH);
    localStorage.removeItem(PENDING_HASH);
    return h;
  } catch { return null; }
}

// Maksud dari halaman depan (mis. "create") yang dilanjutkan setelah login
const INTENT = "intent";
function takeIntent() {
  try { const v = localStorage.getItem(INTENT); localStorage.removeItem(INTENT); return v; } catch { return null; }
}

function setView(node) {
  cleanup(); cleanup = () => {};
  document.body.classList.remove("cam-page", "has-bottom-nav", "show-page");
  app.replaceChildren(node);
}

async function googleLogin() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin },
  });
  if (error) toast(friendly(error));
}

// ---------- Halaman depan (belum login) ----------
function renderLogin() {
  savePendingHash();
  const code = localStorage.getItem("pendingCode");
  const shareLink = code ? `${location.origin}/?kode=${code}` : location.origin;
  setView(el(landingHtml({ code, shareLink })));
  bindLangSwitch(app);

  const login = googleLogin;
  app.querySelectorAll('[data-act="google"]').forEach((b) => (b.onclick = () => {
    // Ingat maksud "buat acara" melewati login Google
    if (b.dataset.intent) { try { localStorage.setItem(INTENT, b.dataset.intent); } catch { /* abaikan */ } }
    login();
  }));
  // Bukan link #anchor: router berbasis hash akan merender ulang halaman
  app.querySelectorAll("[data-scroll]").forEach((b) => (b.onclick = () =>
    document.getElementById(b.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" })));

  // Gabung pakai kode: simpan kode, lalu login. Setelah kembali dari Google, router membuka persetujuan acara.
  const form = app.querySelector("#lp-code");
  const show = app.querySelector('[data-act="show-code"]');
  if (show) show.onclick = () => {
    form.hidden = !form.hidden;
    show.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) form.querySelector("input").focus();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const c = e.target.elements.code.value.trim().toUpperCase();
    if (!c) return;
    try { localStorage.setItem("pendingCode", c); } catch { /* abaikan */ }
    login();
  };

  const copy = app.querySelector('[data-act="copy"]');
  if (copy) copy.onclick = () => copyText(shareLink, {
    done: t("Link disalin. Tempel di Chrome/Safari."),
    title: t("Salin link lalu buka di Chrome/Safari"),
  });
}

// ---------- Persetujuan sebelum masuk acara ----------
async function renderJoin(code) {
  let ev = null;
  try { ev = (await rpc("event_preview", { p_code: code }))[0] || null; } catch { /* tampilkan tanpa pratinjau */ }
  const cover = ev?.cover_path ? ` style="background-image:url('${esc(coverUrl(ev.cover_path))}')"` : "";
  setView(el(`
    <main class="join">
      <div class="join-hero${cover ? " has-cover" : ""}"${cover} role="img" aria-label="${t("Sampul acara")}">
        <button type="button" class="join-back" data-act="no" aria-label="${t("Kembali")}">${ICON.back}</button>
        <div class="join-lang">${langSwitch()}</div>
        <span class="join-code">${t("Kode")} ${esc(code)}</span>
      </div>
      <div class="join-body">
        <div class="join-title">
          <h1>${ev ? esc(ev.name) : t("Masuk acara")}</h1>
          ${ev?.host_name ? `<span>${esc(t("oleh {h}", { h: ev.host_name }))}</span>` : ""}
          ${ev?.starts_at || ev?.ends_at ? `<span>${esc(fmtRange(ev.starts_at, ev.ends_at))}</span>` : ""}
        </div>
        ${ev?.welcome_text ? `<p class="welcome">${esc(ev.welcome_text)}</p>` : ""}
        ${ev && !ev.is_open ? `<p class="hint">${t("Pemotretan acara ini sudah ditutup, tetapi Anda masih bisa melihat album.")}</p>` : ""}
        ${ev?.is_open && ev.lock_until_start && ev.starts_at && new Date(ev.starts_at) > new Date()
          ? `<p class="join-wait">${ICON.clock}<span>${t("Kamera aktif dalam")} <b></b></span></p>` : ""}
        <ul class="join-rules">
          <li><span class="jr-ic coral jr-num">${ev?.unlimited ? "∞" : ev ? ev.max_shots : ICON.film}</span><div><b>${ev?.unlimited ? t("Jepretan tanpa batas") : ev ? t("{n} jepretan untukmu", { n: ev.max_shots }) : t("Jepretan terbatas")}</b><span>${t("Nggak bisa dihapus, nggak bisa diulang.")}</span></div></li>
          <li><span class="jr-ic sun">${ICON.clock}</span><div><b>${t("Hasil terlihat setelah film habis")}</b><span>${t("Seperti kamera film, fotonya dicuci dulu.")}</span></div></li>
          ${ev?.album_private
            ? `<li><span class="jr-ic mint">${ICON.lock}</span><div><b>${t("Album khusus penyelenggara")}</b><span>${t("Kamu melihat fotomu sendiri; semua foto dikumpulkan untuk penyelenggara.")}</span></div></li>`
            : `<li><span class="jr-ic mint">${ICON.people}</span><div><b>${t("Masuk album bersama")}</b><span>${t("Semua tamu bisa melihat fotomu.")}</span></div></li>`}
        </ul>
        <div class="join-actions">
          <button class="btn primary lp-big" data-act="yes">${t("Setuju dan mulai memotret")}</button>
          <p class="fine">${ev?.album_private ? t("Dengan masuk, kamu setuju fotomu dibagikan ke penyelenggara acara.") : t("Dengan masuk, kamu setuju foto dibagikan ke peserta acara.")} <a href="/privacy.html">${t("Kebijakan privasi")}</a></p>
        </div>
      </div>
    </main>`));
  bindLangSwitch(app);
  const waitB = app.querySelector(".join-wait b");
  if (waitB) liveCountdown(waitB, ev.starts_at, (x) => (waitB.textContent = x), () => (waitB.closest(".join-wait").textContent = t("Acara sudah mulai. Selamat memotret!")));
  app.querySelector('[data-act="no"]').onclick = () => {
    localStorage.removeItem("pendingCode");
    location.hash = "#/";
    route();
  };
  app.querySelector('[data-act="yes"]').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try {
      const id = await rpc("join_event", { p_code: code });
      rememberJoined(id);
      localStorage.removeItem("pendingCode");
      location.hash = `#/e/${id}`;
    } catch (err) {
      localStorage.removeItem("pendingCode");
      toast(friendly(err), 5000);
      location.hash = "#/";
      route();
    }
  };
}

// ---------- Beranda: isian kode sebagai fokus, lalu acara di perangkat ini ----------
async function renderHome() {
  const meta = session.user.user_metadata || {};
  const fullName = meta.full_name || meta.name || session.user.email.split("@")[0];
  const first = fullName.split(/\s+/)[0];
  const view = el(`
    <main class="home">
      <header class="home-top">
        <span class="home-brand">${brandLockup(34)}</span>
        <button type="button" class="avatar-btn" data-act="account" aria-label="${t("Akun")}: ${esc(fullName)}" aria-haspopup="dialog">${initial(fullName)}</button>
      </header>
      <div class="home-hello">
        <span>${t("Hai, {n}", { n: esc(first) })}</span>
        <h1>${t("Mau ikut memotret di acara siapa?")}</h1>
      </div>
      <form class="home-join">
        <label for="join-code">${t("Kode acara")}</label>
        <input id="join-code" class="code-input" name="code" placeholder="ABC123" maxlength="12" aria-describedby="join-hint"
               autocapitalize="characters" autocomplete="off" spellcheck="false" required />
        <span id="join-hint" class="hint">${t("6 huruf atau angka dari penyelenggara")}</span>
        <button class="btn primary lp-big">${t("Gabung")}</button>
        <span class="home-scan">${ICON.scan}<span>${t("atau scan QR dengan kamera HP")}</span></span>
      </form>
      <section class="home-events" hidden>
        <h2>${t("Acaramu")}</h2>
        <div class="events"></div>
      </section>
      <div class="events-empty empty-home" hidden><p>${t("Belum ada acara di perangkat ini.")}<br>${t("Masukkan kode di atas untuk mulai memotret.")}</p></div>
      <div class="req-slot"></div>
      <p class="home-create" hidden>${t("Mau bikin acara sendiri?")} <a class="linklike" href="#/buat" data-act="create">${t("Buat acara")}</a></p>
    </main>`);
  setView(view);

  // Menu akun: Dashboard, data & privasi, bahasa, keluar
  let role = null;
  view.querySelector('[data-act="account"]').onclick = () => {
    const { box, close } = modal(`
      <div class="account-menu">
        <div class="am-head"><span class="avatar-btn">${initial(fullName)}</span><div><b>${esc(fullName)}</b><small>${esc(session.user.email)}</small></div></div>
        <div class="sheet-actions">
          ${role === "superadmin" || role === "creator" ? `<a class="btn" href="#/admin">${ICON.panel} Dashboard</a>` : ""}
          <button class="btn" data-act="privacy">${ICON.shield} ${t("Data & privasi")}</button>
          <a class="btn" href="/privacy.html">${ICON.lock} ${t("Kebijakan privasi")}</a>
          <button class="btn danger" data-act="logout">${t("Keluar")}</button>
        </div>
        <div class="am-row"><span>${t("Tema")}</span>${themeSwitch()}</div>
        <div class="am-row"><span>${t("Bahasa")}</span>${langSwitch()}</div>
      </div>`);
    bindLangSwitch(box);
    bindThemeSwitch(box);
    box.querySelector('a[href="#/admin"]')?.addEventListener("click", close);
    box.querySelector('[data-act="privacy"]').onclick = () => { close(); openPrivacy(); };
    box.querySelector('[data-act="logout"]').onclick = async () => {
      close();
      forgetJoined();
      await supabase.auth.signOut();
    };
  };
  view.querySelector("form.home-join").onsubmit = (e) => {
    e.preventDefault();
    renderJoin(e.target.elements.code.value.trim().toUpperCase());
  };
  // Buat acara: pembuat acara langsung ke wizard; yang lain mengajukan diri (atau melihat status pengajuan)
  let canCreate = false, request = null;
  const reqSlot = view.querySelector(".req-slot");
  const createBtn = view.querySelector('[data-act="create"]');
  const showRequest = () => {
    const card = requestStatusCard(request, { onRetry: () => openCreatorRequest({ prev: request, onDone: refreshRequest }) });
    reqSlot.replaceChildren(...(card ? [card] : []));
    view.querySelector(".home-create").hidden = !canCreate && request?.status === "open";
  };
  async function refreshRequest() { request = await myCreatorRequest(); showRequest(); }
  const startCreate = (e) => {
    if (canCreate) { if (!e) location.hash = "#/buat"; return; }   // klik tautan: biarkan menuju #/buat
    e?.preventDefault();
    if (request?.status === "open") toast(t("Pengajuan Anda masih ditinjau."));
    else openCreatorRequest({ prev: request, onDone: refreshRequest });
  };
  createBtn.onclick = startCreate;

  try {
    const [events, can, myRole] = await Promise.all([
      rpc("my_events"), rpc("can_create_event"), rpc("my_role"),
    ]);
    role = myRole;
    canCreate = can;
    if (!canCreate) request = await myCreatorRequest();
    showRequest();
    // Datang dari tombol "Buat acara" di halaman depan: lanjutkan maksudnya setelah login
    if (takeIntent() === "create") startCreate();
    const here = joinedHere();
    const shown = events.filter((ev) => ev.is_owner || here.includes(ev.event_id));
    view.querySelector(".home-events").hidden = !shown.length;
    view.querySelector(".events-empty").hidden = shown.length > 0;
    // Peringatan: acara milik sendiri yang belum dibayar
    const drafts = shown.filter((ev) => ev.is_owner && ev.pay_status === "draft");
    view.querySelector(".draft-warn")?.remove();
    if (drafts.length) {
      view.querySelector(".home-events").before(el(`
        <a class="draft-warn" href="#/e/${drafts[0].event_id}">${ICON.lock}
          <span><b>${drafts.length === 1 ? `“${esc(drafts[0].name)}” belum dibayar` : `${drafts.length} acara belum dibayar`}</b>
          <small>Selesaikan pembayaran supaya acara aktif dan tamu bisa bergabung.</small></span>
          <span class="btn small primary">Bayar</span></a>`));
    }
    view.querySelector(".events").replaceChildren(...shown.map((ev) => {
      if (ev.is_owner && ev.pay_status === "draft") {
        return el(`
          <a class="home-event draft" href="#/e/${ev.event_id}">
            <span class="he-thumb" aria-hidden="true">${ICON.lock}</span>
            <span class="he-text"><b>${esc(ev.name)}</b><small>Draf · selesaikan pembayaran untuk mengaktifkan</small></span>
            <span class="tag bad">Belum dibayar</span>
          </a>`);
      }
      const left = Math.max(0, ev.max_shots - ev.shots_used);
      const photos = ev.photos ? ` · ${t("{n} foto", { n: ev.photos })}` : "";
      const sub = ev.is_owner && !ev.shots_used ? t("Acara Anda") + photos
        : !ev.is_open ? t("Album terbuka") + photos
        : left > 0 ? t("{n} jepretan tersisa", { n: left }) : t("Film habis · lihat album");
      const tag = ev.is_open ? `<span class="tag ok">${t("Berlangsung")}</span>` : `<span class="tag hot">${t("Album")}</span>`;
      const thumb = ev.cover_path
        ? `<span class="he-thumb has-cover" style="background-image:url('${esc(coverUrl(ev.cover_path))}')" aria-hidden="true"></span>`
        : `<span class="he-thumb" aria-hidden="true">${ICON.film}</span>`;
      return el(`
        <a class="home-event" href="#/e/${ev.event_id}${ev.is_open && left > 0 ? "" : "/album"}">
          ${thumb}
          <span class="he-text"><b>${esc(ev.name)}</b><small>${sub}</small></span>
          ${tag}
        </a>`);
    }));
  } catch (e) {
    const box = view.querySelector(".events-empty");
    box.hidden = false;
    box.textContent = friendly(e);
  }
}

// ---------- Draf belum dibayar: wajib selesaikan pembayaran ----------
function renderPayGate(status) {
  const view = el(`
    <main class="pay-gate">
      <div class="pg-in">
        <a class="round-btn ghost-round pg-back" href="#/" aria-label="${t("Kembali ke beranda")}">${ICON.back}</a>
        <div class="pg-body">
          <span class="pg-icon" aria-hidden="true">${ICON.lock}</span>
          <h1>Selesaikan pembayaran dulu</h1>
          <p><b>${esc(status.name)}</b> masih draf karena pembayarannya belum selesai, jadi acara ini belum bisa dibuka.</p>
          <ul class="pg-list">
            <li>${ICON.people}<span>Tamu belum bisa bergabung lewat QR atau kode undangan.</span></li>
            <li>${ICON.camera}<span>Kamera, album, dan Panel acara terkunci sampai lunas.</span></li>
            <li>${ICON.check}<span>Pengaturan acaramu aman tersimpan (${status.max_members} tamu × ${status.max_shots} jepretan).</span></li>
          </ul>
          <div class="pg-actions">
            <button type="button" class="btn primary" data-act="pay">Selesaikan pembayaran</button>
            <button type="button" class="btn ghost" data-act="delete">Hapus draf</button>
          </div>
        </div>
      </div>
    </main>`);
  setView(view);
  view.querySelector('[data-act="pay"]').onclick = () => {
    const host = el(`<div class="dialog pay-host"></div>`);
    view.querySelector(".pg-body").replaceWith(host);
    cleanup = mountPayment(host, status, { onPaid: () => { toast("Acara aktif. Selamat!"); route(); } }) || cleanup;
  };
  view.querySelector('[data-act="delete"]').onclick = async () => {
    if (!(await confirmDialog({ title: "Hapus draf acara?", text: `“${status.name}” dan pengaturannya dihapus. Belum ada pembayaran yang tercatat lunas untuk draf ini.`, ok: "Hapus draf", danger: true }))) return;
    try {
      await deleteEventFiles(status.event_id, status.cover_path).catch(() => {});
      await rpc("delete_event", { p_event: status.event_id });
      toast("Draf dihapus.");
      location.hash = "#/";
    } catch (e) { toast(friendly(e)); }
  };
}

// ---------- Halaman acara dengan tab ----------
async function renderEvent(eventId, tab) {
  let status;
  try {
    status = (await rpc("my_status", { p_event: eventId }))[0];
    if (status) noteEventSize(status.event_id, status.max_members);
  } catch (e) {
    toast(friendly(e));
  }
  if (!status) {
    toast(t("Acara tidak ditemukan atau Anda bukan peserta."));
    location.hash = "#/";
    return;
  }
  status.me = session.user.id;
  // Draf belum dibayar: pemilik tidak bisa membuka acara, hanya halaman penyelesaian pembayaran.
  // Superadmin tetap bisa masuk (mis. untuk menandai lunas manual dari Panel).
  if (status.pay_status === "draft" && !status.is_admin) return renderPayGate(status);
  // Acara yang dibuka lewat link di perangkat ini ikut tampil di beranda
  if (status.is_member) rememberJoined(eventId);
  if (tab === "layar") {
    if (!status.can_manage) { location.hash = `#/e/${eventId}/album`; return; }
    const box = el(`<main class="show-wrap"></main>`);
    setView(box);
    cleanup = await renderSlideshow(box, status, { exit: () => (location.hash = `#/e/${eventId}/panel`) });
    return;
  }
  if (tab === "panel" && !status.can_manage) tab = "kamera";
  if (tab === "ucapan" && !status.is_member && !status.can_manage) tab = "album";
  if (tab === "kamera" && !status.is_member) tab = status.can_manage ? "panel" : "album"; // superadmin bukan peserta

  const backHref = status.is_admin && !status.is_member ? "#/admin/acara" : "#/";
  const tabLink = (id, href, icon, label) =>
    `<a href="${href}" class="${tab === id ? "on" : ""}" ${tab === id ? 'aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  // Kamera: layar penuh tanpa tab bawah; album dibuka lewat satu tombol di samping shutter
  const cam = tab === "kamera";
  const view = el(`
    <main class="event${cam ? " cam-mode" : " wide"}">
      <header class="top${cam ? " cam-top" : ""}">
        <a class="back" href="${backHref}" aria-label="${t("Kembali")}">${ICON.back}</a>
        ${cam
          ? `<div class="cam-title"><small>${t("Acara")}</small><h1>${esc(status.name)}</h1></div>`
          : `<span class="top-event">${esc(status.name)}</span>`}
      </header>
      ${cam ? "" : `
      <nav class="tabs" aria-label="${t("Navigasi tamu")}">
        ${status.is_member ? tabLink("kamera", `#/e/${eventId}`, ICON.camTab, t("Kamera")) : ""}
        ${tabLink("album", `#/e/${eventId}/album`, ICON.gridTab, t("Album"))}
        ${tabLink("ucapan", `#/e/${eventId}/ucapan`, ICON.chatTab, t("Buku tamu"))}
        ${status.can_manage ? tabLink("panel", `#/e/${eventId}/panel`, ICON.panelTab, "Panel") : ""}
      </nav>`}
      <div class="tab-body"></div>
    </main>`);
  setView(view);
  document.body.classList.toggle("has-bottom-nav", !cam);
  document.body.classList.toggle("cam-page", cam);
  const body = view.querySelector(".tab-body");
  const go = (to) => { location.hash = `#/e/${eventId}${to === "kamera" ? "" : "/" + to}`; };

  if (tab === "album") cleanup = await renderAlbum(body, status);
  else if (tab === "ucapan") cleanup = await renderGuestbook(body, status);
  else if (tab === "panel") cleanup = await renderPanel(body, status, { reload: route, home: () => (location.hash = "#/") });
  else cleanup = await renderCamera(body, status, go);
}

// Pengaturan global yang dipakai seluruh aplikasi: lokasi foto (Supabase/R2) dan kunci notifikasi
let settingsFor = null;
async function loadSettings() {
  if (!session || settingsFor === session.user.id) return;
  try {
    const s = await rpc("get_settings");
    setStorageBackend(s?.storage_backend);
    setVapidKey(s?.vapid_public_key);
    settingsFor = session.user.id;
  } catch { /* tetap pakai bawaan: Supabase Storage, tanpa notifikasi */ }
}

// ---------- Router ----------
async function route() {
  if (/^#\/harga/.test(location.hash)) return renderPricing(setView, { loggedIn: Boolean(session) });
  // Buat acara tanpa login: langsung ke login Google, lalu kembali ke #/buat
  if (!session && /^#\/buat/.test(location.hash)) { savePendingHash(); renderLogin(); return googleLogin(); }
  if (!session) return renderLogin();
  await loadSettings();
  const pending = localStorage.getItem("pendingCode");
  if (pending) return renderJoin(pending);
  const back = takePendingHash();
  if (back && back !== location.hash) { location.hash = back; return; } // hashchange memanggil route lagi
  if (/^#\/buat/.test(location.hash)) return renderCreate(setView, { me: session.user });
  const a = location.hash.match(/^#\/admin(?:\/(\w+))?/);
  if (a) return renderAdmin(app, a[1] || "ringkasan", { setView, me: session.user });
  const m = location.hash.match(/^#\/e\/([0-9a-f-]{36})(?:\/(album|panel|layar|ucapan))?/);
  if (m) return renderEvent(m[1], m[2] || "kamera");
  return renderHome();
}

// ---------- Mulai ----------
async function boot() {
  if (!configured) {
    app.innerHTML = `<main class="center"><h1>Belum dikonfigurasi</h1>
      <p class="lead">Isi VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY di file .env (lokal) atau di variabel lingkungan Cloudflare Pages, lalu build ulang.</p></main>`;
    return;
  }
  await resolveSlugPath();
  const { data } = await supabase.auth.getSession();
  session = data.session;
  supabase.auth.onAuthStateChange((event, s) => {
    const changed = Boolean(s) !== Boolean(session) || s?.user?.id !== session?.user?.id;
    session = s;
    if (changed) route();
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("online", () => session && flushQueue());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && session) flushQueue();
  });
  await route();
  if (session) { await loadSettings(); flushQueue(); }
}

// Kerangka aplikasi disimpan di HP supaya tetap terbuka saat sinyal hilang
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

boot();
