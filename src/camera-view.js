// Tab Kamera: jendela bidik, shutter, penghitung sisa jatah
import { openCamera, stopCamera, captureFromVideo, captureFromFile, CAMERA_HELP } from "./camera.js";
import { shoot, flushQueue } from "./shoot.js";
import { queue } from "./queue.js";
import { rpc, friendly, errorCode } from "./supabase.js";
import { el, esc, toast } from "./ui.js";

export async function renderCamera(root, status, go) {
  let stream = null;
  let facing = "environment";
  let busy = false;

  const view = el(`
    <section class="camera">
      <div class="viewfinder">
        <canvas class="vf-canvas"></canvas>
        <div class="vf-diag" hidden></div>
        <div class="vf-placeholder">
          <p>Kamera belum dibuka.</p>
          <button class="btn primary" data-act="open">Buka kamera</button>
          <label class="btn ghost file-fallback" hidden>
            Ambil foto dengan aplikasi kamera
            <input type="file" accept="image/*" capture="environment" hidden />
          </label>
        </div>
        <div class="flash"></div>
      </div>
      <div class="controls">
        <button class="round" data-act="flip" aria-label="Tukar kamera" disabled>⟲</button>
        <button class="shutter" data-act="shoot" aria-label="Jepret" disabled></button>
        <div class="counter" aria-live="polite"><b>--</b><small>tersisa</small></div>
      </div>
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
  const counter = view.querySelector(".counter b");
  const note = view.querySelector(".queue-note");
  const fileLabel = view.querySelector(".file-fallback");
  const fileInput = fileLabel.querySelector("input");

  async function remaining() {
    const local = (await queue.forEvent(status.event_id)).filter((j) => !j.reserved).length;
    return Math.max(0, status.max_shots - status.shots_used - local);
  }

  async function refresh() {
    const left = await remaining();
    const waiting = (await queue.forEvent(status.event_id)).length;
    counter.textContent = left;
    note.hidden = waiting === 0;
    note.textContent = `${waiting} foto tersimpan di HP dan akan terkirim otomatis saat ada sinyal.`;
    const blocked = status.blocked || !status.is_open || left <= 0;
    shutter.disabled = busy || blocked || (!stream && fileLabel.hidden);
    if (left <= 0 && !status.blocked) showDone("Film habis", "Gulungan Anda selesai. Foto Anda akan tampil di album bersama peserta lain.");
    else if (!status.is_open) showDone("Acara ditutup", "Pemotretan sudah selesai.");
    else if (status.blocked) showDone("Akses dihentikan", "Pemilik acara menghentikan akses Anda.");
  }

  let done = false;
  function showDone(title, text) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    stopCamera(stream); stream = null;
    view.replaceChildren(el(`
      <div class="done">
        <div class="film-icon">🎞️</div>
        <h2>${esc(title)}</h2>
        <p>${esc(text)}</p>
        <button class="btn primary">Lihat album</button>
      </div>`));
    view.querySelector("button").onclick = () => go("album");
  }

  // Apakah video benar-benar menampilkan gambar (bukan hanya "berhasil dibuka")?
  const isLive = () => video.readyState >= 2 && video.videoWidth > 0 && !video.paused;

  async function waitLive(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (isLive()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return isLive();
  }

  // Ringkasan keadaan kamera untuk dilaporkan jika jendela bidik tetap hitam
  function diag() {
    const t = stream?.getVideoTracks()[0];
    const s = t?.getSettings?.() || {};
    return `[${video.videoWidth}x${video.videoHeight} rs=${video.readyState} ` +
      `paused=${video.paused} track=${t?.readyState || "-"}${t?.muted ? "/muted" : ""} ` +
      `set=${s.width || "?"}x${s.height || "?"} ${s.facingMode || ""}]`;
  }

  // ---- Jendela bidik: gambar video ke canvas tiap frame ----
  let raf = 0, frames = 0, darkSince = 0, luma = -1;
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
    const scale = Math.max(w / vw, h / vh); // seperti object-fit: cover
    const sw = w / scale, sh = h / scale;
    cctx.save();
    if (facing === "user") { cctx.translate(w, 0); cctx.scale(-1, 1); } // cermin hanya di layar
    cctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
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
    diagBox.hidden = !(dark || debug);
    if (!diagBox.hidden) {
      diagBox.textContent = (dark ? "Gambar dari kamera hitam. Tutup lensa? Coba tukar kamera. " : "") +
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
      placeholder.hidden = false;
      openBtn.disabled = true;
      msg.textContent = "Membuka kamera…";
      stream = await openCamera(video, facing);
      flip.disabled = false;
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
      msg.textContent = help + (e.detail ? ` (${e.detail})` : "") + " Sementara itu, foto bisa diambil dengan tombol di bawah.";
      openBtn.textContent = "Coba lagi";
      openBtn.disabled = false;
      fileLabel.hidden = false;
    }
    refresh();
  }

  async function take(capturePromise) {
    if (busy) return;
    if ((await remaining()) <= 0) return refresh();
    busy = true; shutter.disabled = true;
    try {
      const shot = await capturePromise();
      view.querySelector(".flash").classList.remove("go");
      void view.offsetWidth;
      view.querySelector(".flash").classList.add("go");
      navigator.vibrate?.(30);
      const p = shoot(status.event_id, shot);
      await refresh(); // penghitung turun segera (foto sudah di antrean)
      await p;
    } catch (e) {
      toast(errorCode(e) ? friendly(e) : "Foto tersimpan di HP, akan dikirim saat koneksi kembali.");
    } finally {
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
    take(() => captureFromVideo(video));
  };
  fileInput.onchange = () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (f) take(() => captureFromFile(f));
  };

  // Ambil ulang jatah dari server (diam saja jika sedang offline)
  async function syncStatus() {
    try {
      const s = (await rpc("my_status", { p_event: status.event_id }))[0];
      if (s) Object.assign(status, s);
    } catch { /* offline */ }
  }

  const onOnline = async () => {
    await flushQueue();
    await syncStatus();
    refresh();
  };
  window.addEventListener("online", onOnline);

  await refresh();
  flushQueue().then((n) => n && onOnline());

  return () => {
    cancelAnimationFrame(raf);
    stopCamera(stream);
    window.removeEventListener("online", onOnline);
  };
}
