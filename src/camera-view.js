// Tab Kamera: jendela bidik, shutter, penghitung sisa jatah
import { openCamera, stopCamera, captureFromVideo, captureFromFile } from "./camera.js";
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
        <video playsinline muted autoplay></video>
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

  const video = view.querySelector("video");
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

  async function start() {
    try {
      stopCamera(stream);
      stream = await openCamera(video, facing);
      video.classList.toggle("mirror", facing === "user");
      placeholder.hidden = true;
      flip.disabled = false;
    } catch (e) {
      placeholder.querySelector("p").textContent =
        "Kamera tidak bisa dibuka (izin ditolak atau tidak didukung). Gunakan tombol di bawah.";
      placeholder.querySelector('[data-act="open"]').hidden = true;
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
    if (stream) take(() => captureFromVideo(video));
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

  return () => { stopCamera(stream); window.removeEventListener("online", onOnline); };
}
