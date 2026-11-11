import "./style.css";
import { supabase, configured, rpc, friendly } from "./supabase.js";
import { flushQueue } from "./shoot.js";
import { renderCamera } from "./camera-view.js";
import { renderAlbum } from "./album.js";
import { renderPanel } from "./owner.js";
import { renderAdmin } from "./admin.js";
import { coverUrl } from "./storage.js";
import { inAppBrowser, isAndroid, chromeIntentUrl } from "./camera.js";
import { FILMS } from "./film.js";
import { el, esc, toast, copyText } from "./ui.js";

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

function setView(node) {
  cleanup(); cleanup = () => {};
  app.replaceChildren(node);
}

// ---------- Layar login ----------
function renderLogin() {
  const code = localStorage.getItem("pendingCode");
  const shareLink = code ? `${location.origin}/?kode=${code}` : location.origin;
  setView(el(`
    <main class="center">
      <div class="logo">📸</div>
      <h1 class="brand">Disposable Asiig</h1>
      <p class="lead">Kamera sekali pakai untuk acara bersama. Jepretan terbatas, tanpa hapus dan tanpa ulang. Semua foto terbuka setelah film habis!</p>
      ${code ? `<p class="pill">Undangan acara: <b>${esc(code)}</b></p>` : ""}
      ${inAppBrowser() ? `
        <div class="card warn-card">
          <b>Buka di Chrome atau Safari dulu</b>
          <p>Link ini terbuka di dalam aplikasi (WhatsApp/Instagram/dll.). Google menolak login dari sini dan kamera bisa terblokir.
          Ketuk menu <b>⋮</b> atau <b>⋯</b> lalu pilih <b>"Buka di browser"</b> / <b>"Buka di Safari"</b>.</p>
          <div class="row">
            ${isAndroid() ? `<a class="btn small primary" href="${esc(chromeIntentUrl(shareLink))}">Buka di Chrome</a>` : ""}
            <button class="btn small" data-act="copy">Salin link</button>
          </div>
        </div>` : ""}
      <button class="btn primary big" data-act="google">Masuk dengan Google</button>
      <p class="fine"><a href="/privacy.html">Kebijakan privasi</a></p>
    </main>`));
  app.querySelector('[data-act="google"]').onclick = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin },
    });
    if (error) toast(friendly(error));
  };
  const copy = app.querySelector('[data-act="copy"]');
  if (copy) copy.onclick = () => copyText(shareLink, {
    done: "Link disalin. Tempel di Chrome/Safari.",
    title: "Salin link lalu buka di Chrome/Safari",
  });
}

// ---------- Persetujuan sebelum masuk acara ----------
async function renderJoin(code) {
  let ev = null;
  try { ev = (await rpc("event_preview", { p_code: code }))[0] || null; } catch { /* tampilkan tanpa pratinjau */ }
  setView(el(`
    <main class="center">
      ${ev?.cover_path ? `<img class="join-cover" alt="Sampul acara" src="${esc(coverUrl(ev.cover_path))}" />` : `<div class="logo">🎉</div>`}
      <h1>${ev ? esc(ev.name) : "Masuk acara"}</h1>
      ${ev?.welcome_text ? `<p class="welcome">${esc(ev.welcome_text)}</p>` : ""}
      <p class="pill">Kode: <b>${esc(code)}</b>${ev ? ` · ${ev.max_shots} jepretan` : ""}</p>
      ${ev && !ev.is_open ? `<p class="hint">Pemotretan acara ini sudah ditutup, tetapi Anda masih bisa melihat album.</p>` : ""}
      <p class="lead">Foto yang Anda jepret akan terlihat oleh semua peserta acara ini setelah gulungan Anda habis atau acara ditutup. Foto tidak bisa dihapus atau diulang.</p>
      <button class="btn primary big" data-act="yes">Setuju dan masuk</button>
      <button class="btn ghost" data-act="no">Batal</button>
      <p class="fine"><a href="/privacy.html">Kebijakan privasi</a></p>
    </main>`));
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

// ---------- Beranda: daftar acara ----------
async function renderHome() {
  const view = el(`
    <main class="page">
      <header class="top">
        <h1 class="brand">Disposable Asiig</h1>
        <div class="row tight">
          <a class="btn small" href="#/admin" data-admin hidden>Dashboard</a>
          <button class="btn small ghost" data-act="logout">Keluar</button>
        </div>
      </header>
      <form class="card join">
        <h3>Punya kode acara?</h3>
        <div class="row">
          <input name="code" placeholder="Contoh: ABC123" maxlength="12" autocapitalize="characters" autocomplete="off" required />
          <button class="btn primary">Masuk</button>
        </div>
      </form>
      <div class="events"><p class="hint">Memuat…</p></div>
      <div class="create-slot"></div>
      <p class="fine">Masuk sebagai ${esc(session.user.email)} · <a href="/privacy.html">Privasi</a></p>
    </main>`);
  setView(view);

  view.querySelector('[data-act="logout"]').onclick = async () => {
    forgetJoined();
    await supabase.auth.signOut();
  };
  view.querySelector("form.join").onsubmit = (e) => {
    e.preventDefault();
    renderJoin(e.target.elements.code.value.trim().toUpperCase());
  };

  try {
    const [events, canCreate, role, settings, quota] = await Promise.all([
      rpc("my_events"), rpc("can_create_event"), rpc("my_role"), rpc("get_settings"),
      rpc("my_event_quota").catch(() => null), // null jika v2.sql terbaru belum dijalankan
    ]);
    // Dashboard hanya untuk superadmin dan pembuat acara
    view.querySelector("[data-admin]").hidden = !(role === "superadmin" || role === "creator");
    const here = joinedHere();
    const shown = events.filter((ev) => ev.is_owner || here.includes(ev.event_id));
    const box = view.querySelector(".events");
    box.replaceChildren(...(shown.length
      ? shown.map((ev) => {
          const n = el(`
            <a class="card event-item" href="#/e/${ev.event_id}">
              <div>
                <b>${esc(ev.name)}</b>
                <small>${ev.is_owner ? "Pemilik · " : ""}${ev.is_open ? "Terbuka" : "Ditutup"}</small>
              </div>
              <span class="mini-counter">${Math.max(0, ev.max_shots - ev.shots_used)}<small>/${ev.max_shots}</small></span>
            </a>`);
          return n;
        })
      : [el(`<p class="hint">Belum ada acara. Masukkan kode dari pemilik acara, atau buka link undangan.</p>`)]));

    const limited = quota && quota.limit !== null && quota.limit !== undefined;
    const left = limited ? Math.max(0, quota.limit - quota.used) : null;
    if (canCreate && left === 0) {
      view.querySelector(".create-slot").append(el(`
        <div class="card create">
          <h3>Buat acara baru</h3>
          <p class="hint">Batas acara Anda sudah habis (${quota.used} dari ${quota.limit} acara). Hubungi superadmin untuk menambahnya.</p>
        </div>`));
    } else if (canCreate) {
      const form = el(`
        <form class="card create">
          <h3>Buat acara baru</h3>
          ${limited ? `<p class="hint">Sisa batas: <b>${left}</b> dari ${quota.limit} acara.</p>` : ""}
          <label>Nama acara <input name="name" required maxlength="80" /></label>
          <div class="row">
            <label>Jatah foto (maks. ${settings.max_shots_limit}) <input name="max_shots" type="number" min="1" max="${settings.max_shots_limit}" value="${Math.min(30, settings.max_shots_limit)}" /></label>
            <label>Maks. peserta <input name="max_members" type="number" min="1" max="${settings.max_members_limit}" value="${Math.min(60, settings.max_members_limit)}" /></label>
          </div>
          <label>Efek film bawaan (tamu boleh menggantinya; bisa diubah di Panel)
            <select name="film">${Object.entries(FILMS).map(([id, f]) => `<option value="${id}" ${id === settings.default_film ? "selected" : ""}>${esc(f.name)} — ${esc(f.desc)}</option>`).join("")}</select>
          </label>
          <label class="check"><input type="checkbox" name="invite_only" /> Hanya email yang diundang</label>
          <button class="btn primary">Buat acara</button>
        </form>`);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const f = form.elements;
        try {
          const id = await rpc("create_event", {
            p_name: f.name.value,
            p_max_shots: Number(f.max_shots.value),
            p_max_members: Number(f.max_members.value),
            p_invite_only: f.invite_only.checked,
            p_film: f.film.value,
          });
          location.hash = `#/e/${id}/panel`;
        } catch (err) { toast(friendly(err)); }
      };
      view.querySelector(".create-slot").append(form);
    }
  } catch (e) {
    view.querySelector(".events").textContent = friendly(e);
  }
}

// ---------- Halaman acara dengan tab ----------
async function renderEvent(eventId, tab) {
  let status;
  try {
    status = (await rpc("my_status", { p_event: eventId }))[0];
  } catch (e) {
    toast(friendly(e));
  }
  if (!status) {
    toast("Acara tidak ditemukan atau Anda bukan peserta.");
    location.hash = "#/";
    return;
  }
  status.me = session.user.id;
  if (tab === "panel" && !status.can_manage) tab = "kamera";
  if (tab === "kamera" && !status.is_member) tab = status.can_manage ? "panel" : "album"; // superadmin bukan peserta

  const view = el(`
    <main class="event">
      ${status.cover_path ? `<div class="event-cover" style="background-image:url('${esc(coverUrl(status.cover_path))}')"></div>` : ""}
      <header class="top">
        <a class="back" href="${status.is_admin && !status.is_member ? "#/admin/acara" : "#/"}" aria-label="Kembali">‹</a>
        <h1>${esc(status.name)}</h1>
      </header>
      <nav class="tabs">
        ${status.is_member ? `<a href="#/e/${eventId}" class="${tab === "kamera" ? "on" : ""}">Kamera</a>` : ""}
        <a href="#/e/${eventId}/album" class="${tab === "album" ? "on" : ""}">Album</a>
        ${status.can_manage ? `<a href="#/e/${eventId}/panel" class="${tab === "panel" ? "on" : ""}">Panel</a>` : ""}
      </nav>
      <div class="tab-body"></div>
    </main>`);
  setView(view);
  const body = view.querySelector(".tab-body");
  const go = (t) => { location.hash = `#/e/${eventId}${t === "kamera" ? "" : "/" + t}`; };

  if (tab === "album") cleanup = await renderAlbum(body, status);
  else if (tab === "panel") cleanup = await renderPanel(body, status, { reload: route, home: () => (location.hash = "#/") });
  else cleanup = await renderCamera(body, status, go);
}

// ---------- Router ----------
async function route() {
  if (!session) return renderLogin();
  const pending = localStorage.getItem("pendingCode");
  if (pending) return renderJoin(pending);
  const a = location.hash.match(/^#\/admin(?:\/(\w+))?/);
  if (a) return renderAdmin(app, a[1] || "ringkasan", { setView, me: session.user });
  const m = location.hash.match(/^#\/e\/([0-9a-f-]{36})(?:\/(album|panel))?/);
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
  if (session) flushQueue();
}

// Kerangka aplikasi disimpan di HP supaya tetap terbuka saat sinyal hilang
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

boot();
