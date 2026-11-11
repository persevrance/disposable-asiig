import "./style.css";
import { supabase, configured, rpc, friendly } from "./supabase.js";
import { flushQueue } from "./shoot.js";
import { renderCamera } from "./camera-view.js";
import { renderAlbum } from "./album.js";
import { renderPanel } from "./owner.js";
import { el, esc, toast } from "./ui.js";

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

function setView(node) {
  cleanup(); cleanup = () => {};
  app.replaceChildren(node);
}

// ---------- Layar login ----------
function renderLogin() {
  const code = localStorage.getItem("pendingCode");
  setView(el(`
    <main class="center">
      <div class="logo">📷</div>
      <h1>Disposable Asiig</h1>
      <p class="lead">Kamera sekali pakai untuk acara bersama. Setiap peserta punya 30 jepretan, tanpa hapus dan tanpa ulang.</p>
      ${code ? `<p class="pill">Undangan acara: <b>${esc(code)}</b></p>` : ""}
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
}

// ---------- Persetujuan sebelum masuk acara ----------
function renderJoin(code) {
  setView(el(`
    <main class="center">
      <h1>Masuk acara</h1>
      <p class="pill">Kode: <b>${esc(code)}</b></p>
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
        <h1>Disposable Asiig</h1>
        <button class="btn small ghost" data-act="logout">Keluar</button>
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
    await supabase.auth.signOut();
  };
  view.querySelector("form.join").onsubmit = (e) => {
    e.preventDefault();
    renderJoin(e.target.elements.code.value.trim().toUpperCase());
  };

  try {
    const [events, canCreate] = await Promise.all([rpc("my_events"), rpc("can_create_event")]);
    const box = view.querySelector(".events");
    box.replaceChildren(...(events.length
      ? events.map((ev) => {
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

    if (canCreate) {
      const form = el(`
        <form class="card create">
          <h3>Buat acara baru</h3>
          <label>Nama acara <input name="name" required maxlength="80" /></label>
          <div class="row">
            <label>Jatah foto <input name="max_shots" type="number" min="1" max="100" value="30" /></label>
            <label>Maks. peserta <input name="max_members" type="number" min="1" max="5000" value="60" /></label>
          </div>
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
  if (tab === "panel" && !status.is_owner) tab = "kamera";

  const view = el(`
    <main class="event">
      <header class="top">
        <a class="back" href="#/" aria-label="Kembali">‹</a>
        <h1>${esc(status.name)}</h1>
      </header>
      <nav class="tabs">
        <a href="#/e/${eventId}" class="${tab === "kamera" ? "on" : ""}">Kamera</a>
        <a href="#/e/${eventId}/album" class="${tab === "album" ? "on" : ""}">Album</a>
        ${status.is_owner ? `<a href="#/e/${eventId}/panel" class="${tab === "panel" ? "on" : ""}">Panel</a>` : ""}
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

boot();
