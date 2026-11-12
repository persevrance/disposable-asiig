// Mode layar untuk proyektor/TV: foto yang sudah terbuka untuk tamu tampil bergantian,
// dengan QR undangan di pojok supaya tamu lain ikut memotret. Foto baru didahulukan.
// Hanya untuk pengelola acara (pemilik / superadmin).
import QRCode from "qrcode";
import { rpc, friendly } from "./supabase.js";
import { getUrls } from "./storage.js";
import { filmName } from "./film.js";
import { el, esc, toast, ICON } from "./ui.js";

const POLL_MS = 20000;
const URL_TTL = 50 * 60 * 1000; // URL bertanda tangan berlaku 1 jam; perbarui sebelum habis

export async function renderSlideshow(root, status, { exit }) {
  const link = `${location.origin}/?kode=${status.join_code}`;
  let speed = 8;
  try { speed = Number(localStorage.getItem("slideSpeed")) || 8; } catch { /* abaikan */ }
  const view = el(`
    <section class="slideshow" tabindex="-1">
      <div class="show-stage">
        <img class="show-img a" alt="" />
        <img class="show-img b" alt="" />
      </div>
      <div class="show-empty" hidden>
        <canvas class="show-qr-big" aria-label="Kode QR undangan"></canvas>
        <h2>${esc(status.name)}</h2>
        <p>Scan untuk ikut memotret. Foto muncul di layar ini setelah film tamu habis.</p>
        <p class="show-code-big">${esc(status.join_code)}</p>
      </div>
      <div class="show-title"><b>${esc(status.name)}</b><span class="show-count"></span></div>
      <div class="show-caption" aria-live="polite"></div>
      <div class="show-qr-card">
        <canvas class="show-qr" aria-label="Kode QR undangan"></canvas>
        <div><b>Ikut memotret</b><span>Scan atau kode</span><span class="show-code">${esc(status.join_code)}</span></div>
      </div>
      <div class="show-controls">
        <button class="btn small" data-act="exit">‹ Keluar</button>
        <button class="btn small" data-act="pause" aria-pressed="false">Jeda</button>
        <label class="show-speed">Ganti tiap
          <select data-act="speed">${[5, 8, 12, 20].map((s) => `<option value="${s}" ${s === speed ? "selected" : ""}>${s} detik</option>`).join("")}</select>
        </label>
        <button class="btn small" data-act="full">${ICON.expand} Layar penuh</button>
      </div>
    </section>`);
  root.replaceChildren(view);
  document.body.classList.add("show-page");

  QRCode.toCanvas(view.querySelector(".show-qr"), link, { width: 150, margin: 1 });
  QRCode.toCanvas(view.querySelector(".show-qr-big"), link, { width: 320, margin: 1 });

  const imgs = [view.querySelector(".show-img.a"), view.querySelector(".show-img.b")];
  let front = 0;
  const photos = new Map();     // photo_id -> row
  let order = [];               // urutan putar
  const fresh = [];             // foto baru: tampil lebih dulu
  let pos = 0, paused = false, timer = 0, pollTimer = 0, stopped = false;
  const urls = new Map();       // medium_path -> { url, at }

  async function urlFor(paths) {
    const need = paths.filter((p) => !urls.has(p) || Date.now() - urls.get(p).at > URL_TTL);
    for (let i = 0; i < need.length; i += 100) {
      const got = await getUrls(need.slice(i, i + 100));
      for (const [p, u] of Object.entries(got)) urls.set(p, { url: u, at: Date.now() });
    }
  }

  async function load(first = false) {
    let rows;
    try { rows = await rpc("slideshow_photos", { p_event: status.event_id }); }
    catch (e) { if (first) toast(friendly(e)); return; }
    const known = new Set(photos.keys());
    const ids = new Set(rows.map((r) => r.photo_id));
    for (const r of rows) photos.set(r.photo_id, r);
    // Foto yang disembunyikan pengelola keluar dari putaran
    for (const id of known) if (!ids.has(id)) photos.delete(id);
    order = rows.map((r) => r.photo_id);
    if (!first) for (const r of rows) if (!known.has(r.photo_id)) fresh.push(r.photo_id);
    view.querySelector(".show-count").textContent = `${rows.length.toLocaleString("id-ID")} foto`;
    view.querySelector(".show-empty").hidden = rows.length > 0;
    view.querySelector(".show-qr-card").hidden = rows.length === 0;
    await urlFor(rows.slice(0, 60).map((r) => r.medium_path)).catch(() => {});
  }

  function nextId() {
    while (fresh.length) { const id = fresh.shift(); if (photos.has(id)) return { id, isNew: true }; }
    if (!order.length) return null;
    pos = pos % order.length;
    return { id: order[pos++], isNew: false };
  }

  async function advance() {
    clearTimeout(timer);
    if (stopped) return;
    const n = nextId();
    if (n) {
      const r = photos.get(n.id);
      try {
        await urlFor([r.medium_path]);
        const back = imgs[1 - front];
        back.src = urls.get(r.medium_path).url;
        await back.decode();
        if (stopped) return;
        back.classList.add("on");
        imgs[front].classList.remove("on");
        front = 1 - front;
        const who = r.owner_name ? esc(r.owner_name) : "";
        const film = r.film ? `Film ${esc(filmName(r.film))}` : "";
        view.querySelector(".show-caption").innerHTML =
          `${n.isNew ? `<span class="tag ok">baru</span>` : ""}${[who, film].filter(Boolean).join(" · ")}`;
        // Siapkan URL beberapa foto berikutnya
        const ahead = order.slice(pos, pos + 5).map((id) => photos.get(id)?.medium_path).filter(Boolean);
        urlFor(ahead).catch(() => {});
      } catch { /* foto gagal dimuat: lanjut ke berikutnya */ }
    }
    if (!paused) timer = setTimeout(advance, speed * 1000);
  }

  // ---- kontrol: muncul saat mouse bergerak / layar disentuh, lalu menghilang ----
  let idle = 0;
  const wake = () => {
    view.classList.add("controls-on");
    clearTimeout(idle);
    idle = setTimeout(() => view.classList.remove("controls-on"), 3000);
  };
  view.addEventListener("pointermove", wake);
  view.addEventListener("pointerdown", wake);
  wake();
  view.querySelector('[data-act="exit"]').onclick = () => exit();
  const pauseBtn = view.querySelector('[data-act="pause"]');
  pauseBtn.onclick = () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Putar" : "Jeda";
    pauseBtn.setAttribute("aria-pressed", String(paused));
    if (paused) clearTimeout(timer); else advance();
  };
  view.querySelector('[data-act="speed"]').onchange = (e) => {
    speed = Number(e.target.value);
    try { localStorage.setItem("slideSpeed", String(speed)); } catch { /* abaikan */ }
    if (!paused) { clearTimeout(timer); timer = setTimeout(advance, speed * 1000); }
  };
  const fullBtn = view.querySelector('[data-act="full"]');
  fullBtn.hidden = !document.documentElement.requestFullscreen;
  fullBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else view.requestFullscreen?.().catch(() => toast("Layar penuh tidak diizinkan browser."));
  };
  const onKey = (e) => {
    if (e.key === " ") { e.preventDefault(); pauseBtn.click(); }
    else if (e.key === "ArrowRight") advance();
    else if (e.key === "f") fullBtn.click();
  };
  document.addEventListener("keydown", onKey);

  // ---- layar tetap menyala ----
  let lock = null;
  const keepAwake = async () => {
    try { if (document.visibilityState === "visible") lock = await navigator.wakeLock?.request("screen"); } catch { /* tidak didukung */ }
  };
  const onVisible = () => { if (document.visibilityState === "visible") keepAwake(); };
  document.addEventListener("visibilitychange", onVisible);
  keepAwake();

  await load(true);
  advance();
  pollTimer = setInterval(() => load(), POLL_MS);
  view.focus();

  return () => {
    stopped = true;
    clearTimeout(timer); clearTimeout(idle); clearInterval(pollTimer);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVisible);
    lock?.release?.().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.classList.remove("show-page");
  };
}
