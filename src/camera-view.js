// Tab Kamera: jendela bidik, flash, shutter, penghitung sisa jatah
import {
  openCamera, stopCamera, grabFrame, captureFromCanvas, captureFromFile, CAMERA_HELP,
  cameraCount, hasTorch, setTorch,
} from "./camera.js";
import { FILMS, filmName, applyFilm } from "./film.js";
import { shoot, flushQueue } from "./shoot.js";
import { queue } from "./queue.js";
import { rpc, friendly, errorCode } from "./supabase.js";
import { pushSupport, enableAlbumNotify, albumNotifyOn } from "./push.js";
import { promptInstall } from "./install.js";
import { el, esc, toast, confetti, fmtDate, fmtCountdown, liveCountdown, ICON, badge } from "./ui.js";
import { t } from "./i18n.js";

// Gulungan film untuk layar "Film habis"
const ROLL_ART = `<svg width="84" height="84" viewBox="0 0 64 64" aria-hidden="true"><circle cx="26" cy="32" r="20" fill="#2D1B33"/><circle cx="26" cy="32" r="7" fill="#FFF8F0"/><circle cx="26" cy="18" r="3" fill="#FFF8F0"/><circle cx="26" cy="46" r="3" fill="#FFF8F0"/><circle cx="12" cy="32" r="3" fill="#FFF8F0"/><circle cx="40" cy="32" r="3" fill="#FFF8F0"/><path d="M26 52h32v-8H34" fill="none" stroke="#D6336C" stroke-width="4" stroke-linecap="round"/></svg>`;
const ICON_SOUND = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path class="wave" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/><path class="mute" d="m16 9 6 6M22 9l-6 6"/></svg>`;

const FLASH_KEY = "flashOn";
const loadFlash = () => { try { return localStorage.getItem(FLASH_KEY) === "1"; } catch { return false; } };
const saveFlash = (on) => { try { localStorage.setItem(FLASH_KEY, on ? "1" : "0"); } catch { /* abaikan */ } };
const SOUND_KEY = "shutterSound";
const loadSound = () => { try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch { return true; } };
const saveSound = (on) => { try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch { /* abaikan */ } };

// Suara rana kamera film dan tik timer, dibuat langsung (tanpa file) sebagai WAV di memori lalu
// diputar lewat elemen <audio>. Alasannya: di iPhone, Web Audio ikut senyap saat sakelar
// silent/getar aktif, dan suara yang diputar setelah jeda (menunggu flash, mengambil bingkai) bisa
// ditolak. Elemen <audio> "dibuka" sekali di dalam ketukan (primeAudio), setelah itu boleh diputar
// kapan saja. Web Audio tetap dipakai sebagai cadangan bila <audio> gagal.
const RATE = 22050;
function wavUrl(samples) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
// Desis pendek + klik kedua (tirai menutup), disaring bandpass ~2,4 kHz
function shutterSamples() {
  const len = Math.floor(RATE * 0.14), out = new Float32Array(len);
  const w0 = (2 * Math.PI * 2400) / RATE, alpha = Math.sin(w0) / (2 * 0.8), a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < len; i++) {
    const env = i < len * 0.07 ? 1 : Math.exp(-(i - len * 0.07) / (len * 0.11));
    const second = i > len * 0.52 && i < len * 0.58 ? 1.7 : 0;
    const x = (Math.random() * 2 - 1) * (env + second);
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y * 1.6;
  }
  return out;
}
function tickSamples(freq) {
  const len = Math.floor(RATE * 0.08), out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const tt = i / RATE, env = Math.min(1, tt / 0.004) * Math.exp(-tt / 0.02);
    out[i] = (Math.sin(2 * Math.PI * freq * tt) > 0 ? 1 : -1) * env * 0.35;
  }
  return out;
}
let sounds = null;   // { shutter, tick, tickHigh }: HTMLAudioElement
let audio = null;    // AudioContext cadangan
function makeSounds() {
  const make = (samples) => { const a = new Audio(wavUrl(samples)); a.preload = "auto"; return a; };
  return { shutter: make(shutterSamples()), tick: make(tickSamples(1180)), tickHigh: make(tickSamples(1760)) };
}
// Panggil langsung di dalam ketukan (sebelum await): membuka elemen audio dan AudioContext
function primeAudio() {
  try {
    sounds ||= makeSounds();
    for (const a of Object.values(sounds)) {
      if (a.dataset.ready) continue;
      a.muted = true;
      a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; a.dataset.ready = "1"; })
        .catch(() => { a.muted = false; });
    }
  } catch { /* tanpa <audio> */ }
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { /* tanpa Web Audio */ }
}
function playEl(a, fallback) {
  if (!a) return fallback();
  try {
    a.muted = false; a.currentTime = 0;
    const pr = a.play();
    if (pr && pr.catch) pr.catch(fallback);
  } catch { fallback(); }
}
function shutterSound() { playEl(sounds?.shutter, webShutter); }
function tickSound(high = false) { playEl(high ? sounds?.tickHigh : sounds?.tick, () => webTick(high)); }
// Cadangan Web Audio (bila elemen <audio> ditolak browser)
function webShutter() {
  try {
    if (!audio) return;
    const src = audio.createBufferSource(), d = shutterSamples();
    const buf = audio.createBuffer(1, d.length, RATE); buf.copyToChannel(d, 0);
    src.buffer = buf; src.connect(audio.destination); src.start();
  } catch { /* tanpa suara */ }
}
function webTick(high) {
  try {
    if (!audio) return;
    const src = audio.createBufferSource(), d = tickSamples(high ? 1760 : 1180);
    const buf = audio.createBuffer(1, d.length, RATE); buf.copyToChannel(d, 0);
    src.buffer = buf; src.connect(audio.destination); src.start();
  } catch { /* tanpa suara */ }
}
const TIMER_KEY = "camTimer";
const TIMER_STEPS = [0, 3, 10];
const loadTimer = () => { try { const v = Number(localStorage.getItem(TIMER_KEY)); return TIMER_STEPS.includes(v) ? v : 0; } catch { return 0; } };
const saveTimer = (v) => { try { localStorage.setItem(TIMER_KEY, String(v)); } catch { /* abaikan */ } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Pilihan efek film tamu, diingat per acara di HP ini
const filmKey = (eventId) => `film:${eventId}`;
const loadFilm = (eventId) => { try { return localStorage.getItem(filmKey(eventId)); } catch { return null; } };
const saveFilm = (eventId, id) => { try { localStorage.setItem(filmKey(eventId), id); } catch { /* abaikan */ } };

export async function renderCamera(root, status, go) {
  let stream = null;
  let facing = "environment";   // kamera depan hanya bila acara mengizinkan (allow_front)
  let busy = false;
  let flashOn = loadFlash();
  let soundOn = loadSound();

  const view = el(`
    <section class="camera">
      <div class="viewfinder">
        <canvas class="vf-canvas"></canvas>
        <div class="vf-top">
          <button class="vf-btn icon-only" data-act="sound" aria-pressed="true" aria-label="${t("Suara rana")}">${ICON_SOUND}</button>
          <div class="vf-right">
            ${status.allow_gallery ? `<label class="vf-btn icon-only vf-gallery" aria-label="${t("Unggah dari galeri")}" title="${t("Unggah dari galeri")}">${ICON.album}<input type="file" accept="image/*" hidden /></label>` : ""}
            <button class="vf-btn icon-only vf-timer" data-act="timer" aria-pressed="false" aria-label="${t("Timer jepret")}" title="${t("Timer jepret")}">${ICON.clock}<b class="vf-timer-n" aria-hidden="true"></b></button>
            <button class="vf-btn icon-only" data-act="flip" aria-label="${t("Tukar kamera")}" disabled ${status.allow_front === false ? "hidden" : ""}>${ICON.flip}</button>
          </div>
        </div>
        <div class="film-chips" role="group" aria-label="${t("Efek film")}"></div>
        <div class="vf-diag" hidden></div>
        <div class="vf-placeholder">
          <p>${t("Kamera belum dibuka.")}</p>
          <button class="btn primary" data-act="open">${t("Buka kamera")}</button>
          <label class="btn ghost file-fallback" hidden>
            ${t("Ambil foto dengan aplikasi kamera")}
            <input type="file" accept="image/*" capture="environment" hidden />
          </label>
        </div>
        <div class="developing" hidden>${t("Mencuci foto…")}</div>
        <button type="button" class="vf-count" hidden aria-live="assertive"><b></b><span>${t("Ketuk untuk batal")}</span></button>
        <div class="vf-wait" hidden><span>${t("Kamera aktif dalam")}</span><b></b><small></small></div>
        <div class="flash"></div>
      </div>
      <p class="cam-hint" aria-live="polite"></p>
      <p class="queue-note" hidden></p>
      <div class="controls">
        <a class="album-thumb" href="#/e/${status.event_id}/album" aria-label="${t("Buka album")}">${ICON.gridTab}</a>
        <button class="shutter" data-act="shoot" aria-label="${t("Jepret")}" disabled><span></span></button>
        <button class="ctl flash-btn" data-act="flash" aria-pressed="false" aria-label="Flash" disabled>${ICON.bolt}</button>
      </div>
      <div class="counter" aria-live="polite"><b>--</b><small>${t("sisa jepretan")}</small></div>
    </section>`);
  root.replaceChildren(view);
  // Penghitung sisa tampil di kanan atas, sebaris dengan nama acara
  const counterBox = view.querySelector(".counter");
  const head = root.closest(".event")?.querySelector(".top");
  if (head) head.append(counterBox);

  // Video dibuat langsung (bukan dari <template>) dan hanya dipakai sebagai sumber gambar.
  // Yang tampil di layar adalah canvas yang digambar ulang tiap frame: cara ini tetap
  // jalan di Safari iOS yang kadang menampilkan elemen <video> kamera sebagai hitam.
  const video = document.createElement("video");
  video.className = "vf-source";
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.setAttribute("autoplay", "");
  video.muted = true;
  view.querySelector(".viewfinder").prepend(video);
  const canvas = view.querySelector(".vf-canvas");
  const cctx = canvas.getContext("2d");
  const diagBox = view.querySelector(".vf-diag");
  const debug = /debug/.test(location.hash) || /debug/.test(location.search);
  const placeholder = view.querySelector(".vf-placeholder");
  const shutter = view.querySelector('[data-act="shoot"]');
  const flip = view.querySelector('[data-act="flip"]');
  const flashBtn = view.querySelector('[data-act="flash"]');
  const developing = view.querySelector(".developing");
  const counter = counterBox.querySelector("b");
  const note = view.querySelector(".queue-note");
  const hint = view.querySelector(".cam-hint");
  const fileLabel = view.querySelector(".file-fallback");
  const fileInput = fileLabel.querySelector("input");
  const filmChips = view.querySelector(".film-chips");
  const soundBtn = view.querySelector('[data-act="sound"]');
  function updateSoundBtn() {
    soundBtn.setAttribute("aria-pressed", String(soundOn));
    soundBtn.classList.toggle("muted", !soundOn);
    soundBtn.title = soundOn ? t("Suara rana nyala") : t("Suara rana mati");
  }
  soundBtn.onclick = () => {
    soundOn = !soundOn; saveSound(soundOn); updateSoundBtn();
    if (soundOn) { primeAudio(); setTimeout(shutterSound, 120); }   // contoh bunyi supaya terdengar langsung
    toast(soundOn ? t("Suara rana nyala") : t("Suara rana mati"), 1500);
  };

  // ---- Efek film: bawaan acara, atau pilihan tamu jika diizinkan ----
  function currentFilm() {
    if (!status.allow_film_choice) return status.film || "asli";
    const mine = loadFilm(status.event_id);
    return FILMS[mine] ? mine : status.film || "asli";
  }
  // Chip efek film di bawah jendela bidik. Tanpa izin memilih: satu label efek bawaan.
  function updateFilmBtn() {
    const now = currentFilm();
    if (!status.allow_film_choice) {
      filmChips.innerHTML = now && now !== "asli"
        ? `<span class="film-chip static">${esc(t("Efek: {f}", { f: t(filmName(now)) }))}</span>` : "";
      return;
    }
    filmChips.innerHTML = Object.entries(FILMS).map(([id, f]) =>
      `<button type="button" class="film-chip" data-id="${id}" aria-pressed="${id === now}" title="${esc(t(f.desc))}">${esc(t(f.name))}</button>`).join("");
    const on = filmChips.querySelector('[aria-pressed="true"]');
    if (on) filmChips.scrollLeft = on.offsetLeft - (filmChips.clientWidth - on.offsetWidth) / 2;
  }
  filmChips.onclick = (e) => {
    const b = e.target.closest("button.film-chip");
    if (!b || !status.allow_film_choice) return;
    saveFilm(status.event_id, b.dataset.id);
    updateFilmBtn();
    toast(t("Efek: {f}", { f: t(filmName(b.dataset.id)) }), 1500);
  };

  // Pengaturan efektif dari server (global + per acara)
  // Kamera dikunci sampai acara mulai (pilihan penyelenggara)
  const notStarted = () => Boolean(status.lock_until_start && status.starts_at && new Date(status.starts_at) > new Date());
  const revealLater = () => Boolean(status.reveal_at && new Date(status.reveal_at) > new Date());
  const mirrorPreview = () => facing === "user" && status.mirror_preview;
  const devOpts = (fromVideo) => ({
    maxSide: status.photo_max_side || 2560,
    quality: (status.jpeg_quality || 88) / 100,
    mirror: fromVideo && facing === "user" && status.mirror_photo,
    film: currentFilm(),
    stamp: status.date_stamp !== false,
  });

  // Laporkan kegagalan ke server (dibatasi di server; diam saja jika gagal)
  function report(kind, detail) {
    rpc("log_client_error", {
      p_event: status.event_id, p_kind: kind, p_detail: String(detail || "").slice(0, 2000),
      p_ua: navigator.userAgent.slice(0, 400),
    }).catch(() => {});
  }

  async function remaining() {
    if (status.unlimited) return Infinity;   // paket Unlimited: jepretan tanpa batas
    const local = (await queue.forEvent(status.event_id)).filter((j) => !j.reserved).length;
    return Math.max(0, status.max_shots - status.shots_used - local);
  }

  // Angka sisa bergulir seperti penghitung film saat berkurang
  let shown = null;
  function setCounter(n) {
    if (shown !== null && n < shown) {
      counter.classList.remove("tick");
      void counter.offsetWidth;
      counter.classList.add("tick");
    }
    shown = n;
    counter.textContent = n === Infinity ? "∞" : n;
  }

  async function refresh() {
    const left = await remaining();
    const waiting = (await queue.forEvent(status.event_id)).length;
    setCounter(left);
    hint.textContent = revealLater()
      ? t("Semua foto terbuka dalam {x}.", { x: fmtCountdown(new Date(status.reveal_at) - Date.now()) })
      : status.show_instantly ? (status.unlimited ? t("Jepretan tanpa batas. Foto langsung tampil di album.") : t("Foto langsung tampil di album. Sisa {n} jepretan.", { n: left }))
      : status.unlimited ? t("Jepretan tanpa batas. Foto terbuka di album setelah acara selesai.")
      : left > 0 ? t("Foto Anda terbuka di album setelah {n} jepretan lagi.", { n: left }) : "";
    showWait();
    note.hidden = waiting === 0;
    note.textContent = t("{n} foto tersimpan di HP dan akan terkirim otomatis saat ada sinyal.", { n: waiting });
    const blocked = status.blocked || !status.is_open || left <= 0 || status.needs_review || notStarted();
    shutter.disabled = busy || blocked || (!stream && fileLabel.hidden);
    if (left <= 0 && !status.blocked) showDone(t("Film habis!"), t("Gulunganmu sudah dicuci dan masuk ke album bersama."), true);
    else if (!status.is_open) showDone(t("Acara ditutup"), t("Pemotretan sudah selesai."));
    else if (status.blocked) showDone(t("Akses dihentikan"), t("Pemilik acara menghentikan akses Anda."));
    else if (status.needs_review) hint.textContent = t("Acara ini masih ditinjau tim Jepretin. Kamera aktif setelah tinjauan selesai.");
  }

  function showWait() {
    const waitBox = view.querySelector(".vf-wait");
    if (!waitBox) return;
    const on = notStarted();
    waitBox.hidden = !on;
    if (!on) return;
    waitBox.querySelector("b").textContent = fmtCountdown(new Date(status.starts_at) - Date.now());
    waitBox.querySelector("small").textContent = t("Acara mulai {d}. Jepretan belum terpakai.", { d: fmtDate(status.starts_at) });
  }
  // Tiap detik: angka hitung mundur (kunci kamera / cuci film); saat waktunya tiba, muat ulang tampilan
  let wasLocked = notStarted(), wasReveal = revealLater();
  const clock = setInterval(() => {
    if (!view.isConnected) return clearInterval(clock);
    if (wasLocked && !notStarted()) { wasLocked = false; toast(t("Acara sudah mulai. Selamat memotret!")); refresh(); return; }
    if (wasReveal && !revealLater()) { wasReveal = false; refresh(); return; }
    if (busy) return;
    if (revealLater()) hint.textContent = t("Semua foto terbuka dalam {x}.", { x: fmtCountdown(new Date(status.reveal_at) - Date.now()) });
    if (notStarted()) showWait();
  }, 1000);

  // Layar selesai (desain "Film habis"): latar terang, progres gulungan tamu lain, kabar album
  let done = false;
  async function showDone(title, text, party = false) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    setTorch(stream, false);
    stopCamera(stream); stream = null;
    const ev = root.closest(".event");
    ev?.classList.remove("cam-mode");
    ev?.classList.add("cam-done");
    document.body.classList.remove("cam-page");
    counterBox.remove();
    view.replaceChildren(el(`
      <div class="done">
        ${party ? `<div class="confetti-dots" aria-hidden="true"><i></i><i></i><i></i><i></i></div>` : ""}
        <div class="done-art">${party ? ROLL_ART : badge("film", "coral", "xl")}</div>
        <div class="done-text">
          ${party ? `<span class="done-count">${status.max_shots} / ${status.max_shots}</span>` : ""}
          <h2>${esc(title)}</h2>
          <p>${esc(text)}</p>
          ${revealLater() ? `<p class="done-reveal">${t("Album terbuka dalam")} <b></b></p>` : ""}
        </div>
        <div class="done-progress" hidden></div>
        <div class="done-actions">
          <button class="btn primary lp-big" data-act="album">${t("Lihat album")}</button>
          <button class="btn lp-big" data-act="notify" hidden>${ICON.bell}<span>${t("Kabari saya saat album lengkap")}</span></button>
          <a class="done-link" href="#/e/${status.event_id}/ucapan">${t("Tulis ucapan di buku tamu")}</a>
        </div>
      </div>`));
    view.querySelector('[data-act="album"]').onclick = () => go("album");
    const rev = view.querySelector(".done-reveal b");
    if (rev) liveCountdown(rev, status.reveal_at, (x) => (rev.textContent = x), () => (rev.closest(".done-reveal").textContent = t("Album sudah terbuka.")));
    if (party) confetti();

    // Progres gulungan tamu lain
    try {
      const p = await rpc("album_progress", { p_event: status.event_id });
      if (p?.members) {
        const box = view.querySelector(".done-progress");
        const pct = Math.round((p.rolls_done / p.members) * 100);
        box.innerHTML = `
          <div class="ap-row"><b>${t("Gulungan tamu yang sudah habis")}</b><span>${t("{a} dari {b}", { a: p.rolls_done, b: p.members })}</span></div>
          <div class="bar mint"><span style="width:${pct}%"></span></div>
          <small>${t("Foto tamu lain muncul begitu film mereka habis.")}</small>`;
        box.hidden = false;
      }
    } catch { /* tanpa progres */ }

    // Kabari saat album lengkap (notifikasi browser), hanya bila didukung dan belum aktif
    const revealed = status.reveal_at && new Date(status.reveal_at) <= new Date();
    if (status.is_open && !revealed && pushSupport() === "ok" && !(await albumNotifyOn(status.event_id))) {
      const nb = view.querySelector('[data-act="notify"]');
      nb.hidden = false;
      nb.onclick = async () => {
        nb.disabled = true;
        try {
          await enableAlbumNotify(status.event_id);
          toast(t("Siap. Anda akan dikabari saat album terbuka."));
          nb.hidden = true;
        } catch (err) { toast(err?.message?.length < 120 ? err.message : friendly(err)); nb.disabled = false; }
      };
    } else if (status.is_open && !revealed && pushSupport() === "ios-install") {
      // iPhone: notifikasi hanya bisa setelah aplikasi dipasang di layar utama
      const nb = view.querySelector('[data-act="notify"]');
      nb.hidden = false;
      nb.querySelector("span").textContent = t("Pasang aplikasi untuk dapat kabar album");
      nb.onclick = () => promptInstall();
    }
  }

  // ---- Flash ----
  // Kamera belakang: lampu (torch) jika browser mengizinkan. Kamera depan: layar putih.
  function flashAvailable() {
    if (!status.flash_enabled || !stream) return false;
    return facing === "user" || hasTorch(stream);
  }
  // Tombol flash selalu di kanan shutter. Redup bila belum bisa dipakai; slotnya tetap ada
  // (tak terlihat) bila acara mematikan flash, supaya shutter tetap di tengah.
  function updateFlashBtn() {
    const avail = flashAvailable();
    const on = flashOn && avail;
    flashBtn.style.visibility = status.flash_enabled ? "" : "hidden";
    flashBtn.disabled = !avail;
    flashBtn.setAttribute("aria-pressed", String(on));
    flashBtn.classList.toggle("on", on);
    const name = facing === "user" ? t("Flash layar") : "Flash";
    const state = !stream ? t("buka kamera dulu") : !avail ? t("tidak didukung kamera ini") : on ? t("nyala") : t("mati");
    flashBtn.setAttribute("aria-label", `${name}: ${state}`);
    flashBtn.title = `${name}: ${state}`;
  }
  flashBtn.onclick = () => {
    flashOn = !flashOn;
    saveFlash(flashOn);
    updateFlashBtn();
  };

  // Jalankan fn() dengan flash menyala bila diaktifkan
  async function withFlash(fn) {
    if (!flashOn || !flashAvailable()) return fn();
    if (facing === "user") {
      const screen = el(`<div class="screen-flash"></div>`);
      document.body.append(screen);
      await wait(220); // beri waktu kamera menyesuaikan cahaya layar
      try { return await fn(); }
      finally { screen.classList.add("off"); setTimeout(() => screen.remove(), 300); }
    }
    await setTorch(stream, true);
    await wait(400); // eksposur menyesuaikan lampu
    try { return await fn(); }
    finally { setTorch(stream, false); }
  }

  // Apakah video benar-benar menampilkan gambar (bukan hanya "berhasil dibuka")?
  const isLive = () => video.readyState >= 2 && video.videoWidth > 0 && !video.paused;

  async function waitLive(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (isLive()) return true;
      await wait(150);
    }
    return isLive();
  }

  // Ringkasan keadaan kamera untuk dilaporkan jika jendela bidik tetap hitam
  function diag() {
    const t = stream?.getVideoTracks()[0];
    const s = t?.getSettings?.() || {};
    return `[${video.videoWidth}x${video.videoHeight} rs=${video.readyState} ` +
      `paused=${video.paused} track=${t?.readyState || "-"}${t?.muted ? "/muted" : ""} ` +
      `set=${s.width || "?"}x${s.height || "?"} ${s.facingMode || ""} torch=${hasTorch(stream)}]`;
  }

  // ---- Jendela bidik: gambar video ke canvas tiap frame ----
  let raf = 0, frames = 0, darkSince = 0, luma = -1, reportedDark = false;
  const probe = document.createElement("canvas");
  probe.width = probe.height = 16;
  const pctx = probe.getContext("2d", { willReadFrequently: true });

  // Pratinjau efek film: frame diperkecil (sisi panjang 480 px), diolah dengan kurva film
  // tanpa butiran, lalu diperbesar ke jendela bidik. Bila HP lambat, diolah tiap 2–3 frame.
  const fx = document.createElement("canvas");
  const fxctx = fx.getContext("2d", { willReadFrequently: true });
  let fxEvery = 1, fxTick = 0, fxAvg = 0, fxFilm = null;
  function filmFrame(vw, vh) {
    const film = currentFilm();
    if (!film || film === "asli") return null;
    const k = 480 / Math.max(vw, vh);
    const pw = Math.round(vw * Math.min(1, k)), ph = Math.round(vh * Math.min(1, k));
    if (fx.width !== pw || fx.height !== ph) { fx.width = pw; fx.height = ph; fxFilm = null; }
    if (film !== fxFilm || fxTick++ % fxEvery === 0) {
      const t0 = performance.now();
      fxctx.drawImage(video, 0, 0, pw, ph);
      applyFilm(fx, film, { preview: true });
      fxFilm = film;
      fxAvg = fxAvg * 0.9 + (performance.now() - t0) * 0.1;
      fxEvery = fxAvg > 28 ? 3 : fxAvg > 14 ? 2 : 1;
    }
    return fx;
  }

  function drawLoop() {
    raf = requestAnimationFrame(drawLoop);
    if (video.readyState < 2 || !video.videoWidth) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const vw = video.videoWidth, vh = video.videoHeight;
    // Seperti object-fit: contain, supaya yang terlihat sama persis dengan bingkai foto
    const scale = Math.min(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale, dx = (w - dw) / 2, dy = (h - dh) / 2;
    cctx.fillStyle = "#1a0f1f";
    cctx.fillRect(0, 0, w, h);
    cctx.save();
    if (mirrorPreview()) { cctx.translate(w, 0); cctx.scale(-1, 1); }
    let src = video;
    try { src = filmFrame(vw, vh) || video; } catch { src = video; }
    cctx.drawImage(src, dx, dy, dw, dh);
    cctx.restore();
    if (++frames % 30 === 0) checkDark();
  }

  // Ukur kecerahan rata-rata: membedakan "kamera mengirim gambar hitam" dari "tampilan gagal"
  function checkDark() {
    try {
      pctx.drawImage(video, 0, 0, 16, 16);
      const d = pctx.getImageData(0, 0, 16, 16).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      luma = Math.round(sum / (d.length / 4) / 3);
    } catch { luma = -2; }
    if (luma >= 0 && luma < 3) darkSince ||= Date.now(); else darkSince = 0;
    const dark = darkSince && Date.now() - darkSince > 3000;
    if (dark && !reportedDark) { reportedDark = true; report("DARK_FRAMES", `luma=${luma} ${diag()}`); }
    diagBox.hidden = !(dark || debug);
    if (!diagBox.hidden) {
      diagBox.textContent = (dark ? t("Gambar dari kamera hitam. Tutup lensa? Coba balik kamera.") + " " : "") +
        `frames=${frames} luma=${luma} ` + diag();
    }
  }

  function startPreview() {
    cancelAnimationFrame(raf);
    frames = 0; darkSince = 0;
    raf = requestAnimationFrame(drawLoop);
  }

  // Dipanggil dari ketukan pengguna: iOS mengizinkan play() di sini
  async function kick() {
    const msg = placeholder.querySelector("p");
    try {
      video.srcObject = null;
      video.srcObject = stream;
      await video.play();
    } catch { /* dicek di bawah */ }
    if (await waitLive(2500)) {
      placeholder.hidden = true;
    } else {
      report("BLACK_VIEWFINDER", diag());
      msg.textContent = t("Jendela bidik tetap hitam. Matikan Mode Daya Rendah (Pengaturan -> Baterai) lalu coba lagi, atau gunakan tombol aplikasi kamera di bawah.") + " " + diag();
      fileLabel.hidden = false;
    }
    refresh();
  }

  async function start() {
    const msg = placeholder.querySelector("p");
    const openBtn = placeholder.querySelector('[data-act="open"]');
    openBtn.onclick = start;
    try {
      stopCamera(stream); stream = null;
      updateFlashBtn();
      placeholder.hidden = false;
      openBtn.disabled = true;
      msg.textContent = t("Membuka kamera…");
      stream = await openCamera(video, facing, status.photo_max_side || 2560);
      flip.disabled = status.allow_front === false || (await cameraCount()) < 2;
      updateFlashBtn();
      startPreview();
      if (!stream.needsTap && (await waitLive(2000))) {
        placeholder.hidden = true;
      } else {
        // iOS menahan pemutaran otomatis: minta satu ketukan lagi
        msg.textContent = t("Kamera siap. Ketuk Mulai untuk menyalakan jendela bidik.");
        openBtn.textContent = t("Mulai");
        openBtn.disabled = false;
        openBtn.onclick = kick;
      }
    } catch (e) {
      const help = t(CAMERA_HELP[e.code] || CAMERA_HELP.OTHER);
      report(e.code || "OTHER", `${e.detail || e.message || ""} ${diag()}`);
      msg.textContent = help + (e.detail ? ` (${e.detail})` : "") + " " + t("Sementara itu, foto bisa diambil dengan tombol di bawah.");
      openBtn.textContent = t("Coba lagi");
      openBtn.disabled = false;
      fileLabel.hidden = false;
    }
    refresh();
  }

  async function take(capture) {
    if (busy) return;
    if ((await remaining()) <= 0) return refresh();
    busy = true; shutter.disabled = true;
    try {
      const shot = await capture();
      view.querySelector(".flash").classList.remove("go");
      void view.offsetWidth;
      view.querySelector(".flash").classList.add("go");
      navigator.vibrate?.(30);
      const p = shoot(status.event_id, shot, currentFilm());
      await refresh(); // penghitung turun segera (foto sudah di antrean)
      await p;
    } catch (e) {
      if (e.code === "FILE_LAMA") toast(t("Foto itu bukan jepretan baru. Ambil foto langsung dengan kamera."), 5000);
      else {
        if (!errorCode(e) && navigator.onLine) report("SHOT_FAILED", e?.message || e);
        toast(errorCode(e) ? friendly(e) : t("Foto tersimpan di HP, akan dikirim saat koneksi kembali."));
      }
    } finally {
      developing.hidden = true;
      await syncStatus();
      busy = false;
      refresh();
    }
  }

  // ---- Timer jepret: mati / 3 / 10 detik. Jatah baru terpakai saat foto benar-benar diambil. ----
  let timerSec = loadTimer();
  let countdown = null;
  const timerBtn = view.querySelector('[data-act="timer"]');
  const countBox = view.querySelector(".vf-count");
  function updateTimerBtn() {
    timerBtn.classList.toggle("on", timerSec > 0);
    timerBtn.setAttribute("aria-pressed", String(timerSec > 0));
    timerBtn.querySelector(".vf-timer-n").textContent = timerSec || "";
    timerBtn.setAttribute("aria-label", timerSec ? t("Timer jepret: {n} detik", { n: timerSec }) : t("Timer jepret: mati"));
  }
  timerBtn.onclick = () => {
    timerSec = TIMER_STEPS[(TIMER_STEPS.indexOf(timerSec) + 1) % TIMER_STEPS.length];
    saveTimer(timerSec);
    updateTimerBtn();
    toast(timerSec ? t("Timer {n} detik", { n: timerSec }) : t("Timer mati"), 1200);
  };
  updateTimerBtn();
  function cancelCountdown(msg) {
    if (!countdown) return;
    clearInterval(countdown);
    countdown = null;
    countBox.hidden = true;
    shutter.classList.remove("counting");
    if (msg) toast(msg, 1500);
  }
  countBox.onclick = () => cancelCountdown(t("Timer dibatalkan."));
  function startCountdown() {
    let n = timerSec;
    countBox.querySelector("b").textContent = n;
    countBox.hidden = false;
    shutter.classList.add("counting");
    if (soundOn) tickSound();
    countdown = setInterval(() => {
      if (!view.isConnected || !stream) return cancelCountdown();
      n -= 1;
      if (n <= 0) { cancelCountdown(); fire(); return; }
      countBox.querySelector("b").textContent = n;
      if (soundOn) tickSound(n <= 1);
    }, 1000);
  }

  view.querySelector('[data-act="open"]').onclick = start;
  flip.onclick = () => { cancelCountdown(); facing = facing === "user" ? "environment" : "user"; start(); };
  shutter.onclick = () => {
    if (countdown) return cancelCountdown(t("Timer dibatalkan."));
    if (!stream) return;
    if (!video.videoWidth || video.paused) return toast(t("Jendela bidik belum menyala. Ketuk Mulai dulu."));
    if (soundOn) primeAudio();
    if (timerSec > 0) return startCountdown();
    fire();
  };
  function fire() {
    if (!stream || !video.videoWidth) return;
    take(async () => {
      // Ambil bingkai saat flash menyala, lalu olah setelah flash padam
      const frame = await withFlash(async () => grabFrame(video));
      if (soundOn) shutterSound();
      developing.hidden = false;
      await wait(16); // biarkan tulisan "Mencuci" tampil sebelum proses berat
      return captureFromCanvas(frame, devOpts(true));
    });
  };
  fileInput.onchange = () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (f) take(() => { developing.hidden = false; return captureFromFile(f, devOpts(false)); });
  };
  // Unggah dari galeri (hanya bila penyelenggara mengizinkan); tetap memakai jatah jepretan
  const galleryInput = view.querySelector(".vf-gallery input");
  if (galleryInput) galleryInput.onchange = () => {
    const f = galleryInput.files[0];
    galleryInput.value = "";
    if (f) take(() => { developing.hidden = false; return captureFromFile(f, devOpts(false)); });
  };

  // Aturan main sudah tampil di layar "Setuju dan masuk", jadi tanpa pop-up pengenalan.
  // Pertama kali di acara ini: langsung minta izin kamera. Berikutnya: buka otomatis bila
  // izin sudah diberikan. (iOS yang menahan pemutaran tetap meminta satu ketukan "Mulai".)
  async function maybeAutoStart() {
    const key = `intro:${status.event_id}`;
    let seen = false;
    try { seen = localStorage.getItem(key) === "1"; localStorage.setItem(key, "1"); } catch { seen = true; }
    if (!seen) { if (!done && !stream) start(); return; }
    try {
      const perm = await navigator.permissions?.query({ name: "camera" });
      if (perm?.state === "granted" && !done && !stream) start();
    } catch { /* browser tanpa Permissions API: tunggu ketukan Buka kamera */ }
  }

  // Ambil ulang jatah dari server (diam saja jika sedang offline)
  async function syncStatus() {
    try {
      const s = (await rpc("my_status", { p_event: status.event_id }))[0];
      if (s) { Object.assign(status, s); updateFilmBtn(); }
    } catch { /* offline */ }
  }

  const onOnline = async () => {
    await flushQueue();
    await syncStatus();
    refresh();
  };
  window.addEventListener("online", onOnline);

  updateFlashBtn();
  updateFilmBtn();
  updateSoundBtn();
  await refresh();
  flushQueue().then((n) => n && onOnline());
  if (!done) maybeAutoStart();

  return () => {
    cancelAnimationFrame(raf);
    setTorch(stream, false);
    stopCamera(stream);
    window.removeEventListener("online", onOnline);
  };
}
