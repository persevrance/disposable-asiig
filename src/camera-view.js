// Tab Kamera: jendela bidik, flash, shutter, penghitung sisa jatah
import {
  openCamera, stopCamera, grabFrame, captureFromCanvas, captureFromFile, CAMERA_HELP,
  cameraCount, hasTorch, setTorch, grabSmall,
} from "./camera.js";
import { FILMS, filmName, applyFilm } from "./film.js";
import { shoot, flushQueue } from "./shoot.js";
import { queue } from "./queue.js";
import { rpc, friendly, errorCode } from "./supabase.js";
import { el, esc, toast, confetti, modal, fmtDate, ICON, badge } from "./ui.js";

const ICON_FLIP = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><path d="M9.5 13.5a3 3 0 0 1 5-2.2M14.5 11.3V9.5h-1.8M14.5 12.5a3 3 0 0 1-5 2.2M9.5 14.7v1.8h1.8"/></svg>`;
const ICON_FLASH = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>`;
const ICON_SOUND = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path class="wave" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/><path class="mute" d="m16 9 6 6M22 9l-6 6"/></svg>`;

const FLASH_KEY = "flashOn";
const loadFlash = () => { try { return localStorage.getItem(FLASH_KEY) === "1"; } catch { return false; } };
const saveFlash = (on) => { try { localStorage.setItem(FLASH_KEY, on ? "1" : "0"); } catch { /* abaikan */ } };
const SOUND_KEY = "shutterSound";
const loadSound = () => { try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch { return true; } };
const saveSound = (on) => { try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch { /* abaikan */ } };

// Suara rana kamera film, dibuat langsung (tanpa file): desis pendek lalu klik.
// AudioContext dibuat saat ketukan pertama (aturan autoplay browser).
let audio = null;
// Panggil langsung di dalam ketukan (sebelum await) supaya Safari mengizinkan suara
function primeAudio() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { /* tanpa suara */ }
}
function shutterSound() {
  try {
    if (!audio) return;
    const t = audio.currentTime;
    const len = Math.floor(audio.sampleRate * 0.12);
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = i < len * 0.08 ? 1 : Math.exp(-(i - len * 0.08) / (len * 0.12));
      const second = i > len * 0.55 && i < len * 0.6 ? 1.6 : 0;   // klik kedua: tirai menutup
      d[i] = (Math.random() * 2 - 1) * (env + second) * 0.5;
    }
    const src = audio.createBufferSource();
    src.buffer = buf;
    const filter = audio.createBiquadFilter();
    filter.type = "bandpass"; filter.frequency.value = 2400; filter.Q.value = 0.8;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.9, t);
    src.connect(filter).connect(gain).connect(audio.destination);
    src.start(t);
  } catch { /* tanpa suara */ }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Pilihan efek film tamu, diingat per acara di HP ini
const filmKey = (eventId) => `film:${eventId}`;
const loadFilm = (eventId) => { try { return localStorage.getItem(filmKey(eventId)); } catch { return null; } };
const saveFilm = (eventId, id) => { try { localStorage.setItem(filmKey(eventId), id); } catch { /* abaikan */ } };

export async function renderCamera(root, status, go) {
  let stream = null;
  let facing = "environment";
  let busy = false;
  let flashOn = loadFlash();
  let soundOn = loadSound();

  const view = el(`
    <section class="camera">
      <div class="viewfinder">
        <canvas class="vf-canvas"></canvas>
        <div class="vf-top">
          <button class="film-badge" data-act="film"></button>
          <span class="vf-right">
            <button class="vf-btn icon-only" data-act="sound" aria-pressed="true" aria-label="Suara rana">${ICON_SOUND}</button>
            <button class="vf-btn" data-act="flash" aria-pressed="false" hidden>${ICON_FLASH}<span>Mati</span></button>
          </span>
        </div>
        <div class="vf-diag" hidden></div>
        <div class="vf-placeholder">
          <p>Kamera belum dibuka.</p>
          <button class="btn primary" data-act="open">Buka kamera</button>
          <label class="btn ghost file-fallback" hidden>
            Ambil foto dengan aplikasi kamera
            <input type="file" accept="image/*" capture="environment" hidden />
          </label>
        </div>
        <div class="developing" hidden>Mencuci foto…</div>
        <div class="flash"></div>
      </div>
      <div class="controls">
        <button class="ctl" data-act="flip" aria-label="Balik kamera" disabled>${ICON_FLIP}</button>
        <button class="shutter" data-act="shoot" aria-label="Jepret" disabled></button>
        <div class="ctl counter" aria-live="polite"><b>--</b><small>sisa</small></div>
      </div>
      <p class="cam-hint" aria-live="polite"></p>
      <p class="queue-note" hidden></p>
    </section>`);
  root.replaceChildren(view);

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
  const counter = view.querySelector(".counter b");
  const note = view.querySelector(".queue-note");
  const hint = view.querySelector(".cam-hint");
  const fileLabel = view.querySelector(".file-fallback");
  const fileInput = fileLabel.querySelector("input");
  const filmBtn = view.querySelector('[data-act="film"]');
  const soundBtn = view.querySelector('[data-act="sound"]');
  function updateSoundBtn() {
    soundBtn.setAttribute("aria-pressed", String(soundOn));
    soundBtn.classList.toggle("muted", !soundOn);
    soundBtn.title = soundOn ? "Suara rana nyala" : "Suara rana mati";
  }
  soundBtn.onclick = () => { soundOn = !soundOn; saveSound(soundOn); updateSoundBtn(); toast(soundOn ? "Suara rana nyala" : "Suara rana mati", 1500); };

  // ---- Efek film: bawaan acara, atau pilihan tamu jika diizinkan ----
  function currentFilm() {
    if (!status.allow_film_choice) return status.film || "asli";
    const mine = loadFilm(status.event_id);
    return FILMS[mine] ? mine : status.film || "asli";
  }
  function updateFilmBtn() {
    filmBtn.innerHTML = `${ICON.film}<span>${esc(filmName(currentFilm()))}</span>${status.allow_film_choice ? ICON.chevronDown : ""}`;
    filmBtn.disabled = !status.allow_film_choice;
    filmBtn.setAttribute("aria-label", status.allow_film_choice ? `Efek film: ${filmName(currentFilm())}. Ketuk untuk mengganti` : `Efek film: ${filmName(currentFilm())}`);
  }
  filmBtn.onclick = () => { if (status.allow_film_choice) openFilmPicker(); };

  // Lembar pemilih dengan pratinjau dari gambar kamera saat ini
  function openFilmPicker() {
    const sample = grabSmall(video);
    const sheet = el(`
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Pilih efek film">
        <div class="sheet-card">
          <div class="sheet-head"><h3>Pilih efek film</h3><button class="btn small" data-act="close">Tutup</button></div>
          <p class="hint">Efek langsung tercetak di foto dan tidak bisa diubah setelah dijepret. Boleh ganti kapan saja untuk jepretan berikutnya.</p>
          <div class="film-list"></div>
        </div>
      </div>`);
    const list = sheet.querySelector(".film-list");
    const now = currentFilm();
    for (const [id, f] of Object.entries(FILMS)) {
      const item = el(`
        <button class="film-item${id === now ? " on" : ""}" data-id="${id}" aria-pressed="${id === now}">
          <span class="film-thumb"></span>
          <b>${esc(f.name)}</b>
          <small>${esc(f.desc)}</small>
          ${id === status.film ? `<span class="tag">bawaan acara</span>` : ""}
        </button>`);
      const thumb = item.querySelector(".film-thumb");
      if (sample) {
        const c = document.createElement("canvas");
        c.width = sample.width; c.height = sample.height;
        const ctx = c.getContext("2d");
        if (mirrorPreview()) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(sample, 0, 0);
        applyFilm(c, id);
        thumb.append(c);
      } else thumb.classList.add("film-swatch", `fs-${id}`);
      item.onclick = () => {
        saveFilm(status.event_id, id);
        updateFilmBtn();
        close();
        toast(`Efek film: ${f.name}`);
      };
      list.append(item);
    }
    const close = () => sheet.remove();
    sheet.querySelector('[data-act="close"]').onclick = close;
    sheet.onclick = (e) => { if (e.target === sheet) close(); };
    document.body.append(sheet);
  }

  // Pengaturan efektif dari server (global + per acara)
  const mirrorPreview = () => facing === "user" && status.mirror_preview;
  const devOpts = (fromVideo) => ({
    maxSide: status.photo_max_side || 2560,
    quality: (status.jpeg_quality || 88) / 100,
    mirror: fromVideo && facing === "user" && status.mirror_photo,
    film: currentFilm(),
  });

  // Laporkan kegagalan ke server (dibatasi di server; diam saja jika gagal)
  function report(kind, detail) {
    rpc("log_client_error", {
      p_event: status.event_id, p_kind: kind, p_detail: String(detail || "").slice(0, 2000),
      p_ua: navigator.userAgent.slice(0, 400),
    }).catch(() => {});
  }

  async function remaining() {
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
    counter.textContent = n;
  }

  async function refresh() {
    const left = await remaining();
    const waiting = (await queue.forEvent(status.event_id)).length;
    setCounter(left);
    hint.textContent = status.reveal_at && new Date(status.reveal_at) > new Date()
      ? `Semua foto terbuka ${fmtDate(status.reveal_at)}.`
      : left > 0 ? `Foto Anda terbuka di album setelah ${left} jepretan lagi.` : "";
    note.hidden = waiting === 0;
    note.textContent = `${waiting} foto tersimpan di HP dan akan terkirim otomatis saat ada sinyal.`;
    const blocked = status.blocked || !status.is_open || left <= 0;
    shutter.disabled = busy || blocked || (!stream && fileLabel.hidden);
    if (left <= 0 && !status.blocked) showDone("Film habis", "Gulungan Anda selesai. Foto Anda akan tampil di album bersama peserta lain.", true);
    else if (!status.is_open) showDone("Acara ditutup", "Pemotretan sudah selesai.");
    else if (status.blocked) showDone("Akses dihentikan", "Pemilik acara menghentikan akses Anda.");
  }

  let done = false;
  function showDone(title, text, party = false) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    setTorch(stream, false);
    stopCamera(stream); stream = null;
    view.replaceChildren(el(`
      <div class="done">
        <div class="film-icon">${badge(party ? "sparkle" : "film", party ? "sun" : "coral", "xl")}</div>
        <h2>${esc(title)}</h2>
        <p>${esc(text)}</p>
        <button class="btn primary">Lihat album</button>
      </div>`));
    view.querySelector("button").onclick = () => go("album");
    if (party) confetti();
  }

  // ---- Flash ----
  // Kamera belakang: lampu (torch) jika browser mengizinkan. Kamera depan: layar putih.
  function flashAvailable() {
    if (!status.flash_enabled || !stream) return false;
    return facing === "user" || hasTorch(stream);
  }
  function updateFlashBtn() {
    const avail = flashAvailable();
    flashBtn.hidden = !avail;
    flashBtn.setAttribute("aria-pressed", String(flashOn));
    flashBtn.classList.toggle("on", flashOn);
    flashBtn.querySelector("span").textContent = flashOn ? "Nyala" : "Mati";
    flashBtn.title = facing === "user" ? "Flash layar" : "Flash";
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
    cctx.drawImage(video, dx, dy, dw, dh);
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
      diagBox.textContent = (dark ? "Gambar dari kamera hitam. Tutup lensa? Coba balik kamera. " : "") +
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
      msg.textContent = "Jendela bidik tetap hitam. Matikan Mode Daya Rendah (Pengaturan -> Baterai) lalu coba lagi, " +
        "atau gunakan tombol aplikasi kamera di bawah. " + diag();
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
      msg.textContent = "Membuka kamera…";
      stream = await openCamera(video, facing, status.photo_max_side || 2560);
      flip.disabled = (await cameraCount()) < 2;
      updateFlashBtn();
      startPreview();
      if (!stream.needsTap && (await waitLive(2000))) {
        placeholder.hidden = true;
      } else {
        // iOS menahan pemutaran otomatis: minta satu ketukan lagi
        msg.textContent = "Kamera siap. Ketuk Mulai untuk menyalakan jendela bidik.";
        openBtn.textContent = "Mulai";
        openBtn.disabled = false;
        openBtn.onclick = kick;
      }
    } catch (e) {
      const help = CAMERA_HELP[e.code] || CAMERA_HELP.OTHER;
      report(e.code || "OTHER", `${e.detail || e.message || ""} ${diag()}`);
      msg.textContent = help + (e.detail ? ` (${e.detail})` : "") + " Sementara itu, foto bisa diambil dengan tombol di bawah.";
      openBtn.textContent = "Coba lagi";
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
      if (e.code === "FILE_LAMA") toast("Foto itu bukan jepretan baru. Ambil foto langsung dengan kamera.", 5000);
      else {
        if (!errorCode(e) && navigator.onLine) report("SHOT_FAILED", e?.message || e);
        toast(errorCode(e) ? friendly(e) : "Foto tersimpan di HP, akan dikirim saat koneksi kembali.");
      }
    } finally {
      developing.hidden = true;
      await syncStatus();
      busy = false;
      refresh();
    }
  }

  view.querySelector('[data-act="open"]').onclick = start;
  flip.onclick = () => { facing = facing === "user" ? "environment" : "user"; start(); };
  shutter.onclick = () => {
    if (!stream) return;
    if (!video.videoWidth || video.paused) return toast("Jendela bidik belum menyala. Ketuk Mulai dulu.");
    if (soundOn) primeAudio();
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

  // Pertama kali di acara ini: kenalkan aturan main. Tombol terakhir adalah ketukan
  // pengguna, jadi kamera boleh langsung dibuka (iOS mewajibkan ketukan).
  // Berikutnya: buka kamera otomatis bila izin kamera sudah diberikan.
  async function maybeAutoStart() {
    const key = `intro:${status.event_id}`;
    let seen = false;
    try { seen = localStorage.getItem(key) === "1"; } catch { seen = true; }
    if (!seen) {
      try { localStorage.setItem(key, "1"); } catch { /* abaikan */ }
      if ((await showIntro()) && !done && !stream) start();
      return;
    }
    try {
      const perm = await navigator.permissions?.query({ name: "camera" });
      if (perm?.state === "granted" && !done && !stream) start();
    } catch { /* browser tanpa Permissions API: tunggu ketukan Buka kamera */ }
  }

  function showIntro() {
    const reveal = status.reveal_at && new Date(status.reveal_at) > new Date();
    const steps = [
      [badge("film", "coral", "lg"), `${status.max_shots} jepretan`, `Anda punya satu gulungan berisi ${status.max_shots} jepretan. Pilih momen terbaik.`],
      [badge("lock", "grape", "lg"), "Tanpa hapus, tanpa ulang", "Seperti kamera film: setiap jepretan langsung tercetak dan tidak bisa dilihat dulu."],
      [badge("sparkle", "mint", "lg"), reveal ? "Terbuka bersamaan" : "Terbuka setelah film habis",
        reveal ? `Semua foto tamu muncul di album ${fmtDate(status.reveal_at)}.`
               : "Foto Anda muncul di album setelah jepretan terakhir, bersama foto tamu lain."],
    ];
    return new Promise((resolve) => {
      let i = 0, go = false;
      const { box, close } = modal(`
        <div class="intro" aria-live="polite">
          <div class="intro-art" aria-hidden="true"></div>
          <h3></h3>
          <p></p>
          <div class="intro-dots" aria-hidden="true">${steps.map(() => "<i></i>").join("")}</div>
          <div class="dialog-actions">
            <button class="btn ghost" data-act="skip">Lewati</button>
            <button class="btn primary" data-act="next" autofocus>Lanjut</button>
          </div>
        </div>`, { onClose: () => resolve(go) });
      const show = () => {
        const [art, title, text] = steps[i];
        box.querySelector(".intro-art").innerHTML = art;
        box.querySelector("h3").textContent = title;
        box.querySelector("p").textContent = text;
        box.querySelectorAll(".intro-dots i").forEach((d, n) => d.classList.toggle("on", n === i));
        box.querySelector('[data-act="next"]').textContent = i === steps.length - 1 ? "Mulai memotret" : "Lanjut";
      };
      box.querySelector('[data-act="next"]').onclick = () => {
        if (i < steps.length - 1) { i++; show(); } else { go = true; close(); }
      };
      box.querySelector('[data-act="skip"]').onclick = () => { go = true; close(); };
      show();
    });
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
