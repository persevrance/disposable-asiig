// Tab Ucapan (buku tamu): ucapan teks dan/atau rekaman suara maks. 60 detik.
// Paling banyak 3 ucapan per tamu per acara. Pengelola acara bisa menyembunyikan dan menghapus.
import { rpc, friendly } from "./supabase.js";
import { uploadVoice, voiceUrls, removeVoices } from "./storage.js";
import { onAlbumPing, pingAlbum } from "./realtime.js";
import { el, esc, toast, fmtDate, confirmDialog, ICON } from "./ui.js";
import { t } from "./i18n.js";

const MAX_SECS = 60;
const MAX_MSG = 3;

// Format rekaman yang didukung browser: Chrome/Android webm, Safari mp4
function pickFormat() {
  if (!window.MediaRecorder) return null;
  for (const [mime, ext, type] of [
    ["audio/webm;codecs=opus", "webm", "audio/webm"], ["audio/webm", "webm", "audio/webm"],
    ["audio/mp4", "m4a", "audio/mp4"], ["audio/ogg;codecs=opus", "ogg", "audio/ogg"],
  ]) if (MediaRecorder.isTypeSupported?.(mime)) return { mime, ext, type };
  return null;
}

export async function renderGuestbook(root, status) {
  const fmt = pickFormat();
  const view = el(`
    <section class="guestbook">
      <form class="card gb-form">
        <h3>${t("Tinggalkan ucapan")}</h3>
        <p class="hint">${t("Untuk {name}. Tulis pesan, rekam suara, atau keduanya.", { name: esc(status.name) })}</p>
        <label class="sr-only" for="gb-body">${t("Ucapan")}</label>
        <textarea id="gb-body" name="body" rows="3" maxlength="500" placeholder="${t("Selamat dan semoga bahagia selalu!")}"></textarea>
        <div class="gb-voice">
          ${fmt ? `<button type="button" class="btn small" data-act="rec">${ICON.mic}<span>${t("Rekam suara")}</span></button>` : `<p class="hint">${t("Perekaman suara tidak didukung browser ini.")}</p>`}
          <span class="gb-timer" hidden>0:00 / 1:00</span>
          <audio class="gb-preview" controls hidden></audio>
          <button type="button" class="btn small ghost" data-act="discard" hidden>${ICON.trash}<span>${t("Hapus rekaman")}</span></button>
        </div>
        <div class="row gb-send">
          <small class="gb-left"></small>
          <button class="btn primary" data-act="send">${t("Kirim ucapan")}</button>
        </div>
      </form>
      <h3 class="section-title">${t("Ucapan tamu")}</h3>
      <div class="gb-list"><p class="hint">${t("Memuat…")}</p></div>
    </section>`);
  root.replaceChildren(view);
  const form = view.querySelector(".gb-form");
  const list = view.querySelector(".gb-list");
  const recBtn = view.querySelector('[data-act="rec"]');
  const timer = view.querySelector(".gb-timer");
  const preview = view.querySelector(".gb-preview");
  const discardBtn = view.querySelector('[data-act="discard"]');
  let rows = [], recorder = null, chunks = [], voice = null, startedAt = 0, tick = 0, stream = null;

  const mm = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  function setVoice(v) {
    voice = v;
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.hidden = !v; discardBtn.hidden = !v;
    if (recBtn) recBtn.hidden = Boolean(v);
    if (v) preview.src = URL.createObjectURL(v.blob); else preview.removeAttribute("src");
  }
  function stopRec() {
    if (!recorder) return;
    recorder.stop();
  }
  if (recBtn) recBtn.onclick = async () => {
    if (recorder) return stopRec();
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast(t("Izin mikrofon ditolak. Izinkan mikrofon di pengaturan browser.")); return; }
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: fmt.mime });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      clearInterval(tick);
      stream.getTracks().forEach((tr) => tr.stop());
      const secs = Math.max(1, Math.min(MAX_SECS, Math.round((Date.now() - startedAt) / 1000)));
      const blob = new Blob(chunks, { type: fmt.type });
      recorder = null;
      recBtn.classList.remove("recording");
      recBtn.innerHTML = `${ICON.mic}<span>${t("Rekam suara")}</span>`;
      timer.hidden = true;
      if (blob.size > 2 * 1024 * 1024) { toast(t("Rekaman terlalu besar. Coba lebih singkat.")); return; }
      setVoice({ blob, secs, ext: fmt.ext });
    };
    recorder.start(1000);
    startedAt = Date.now();
    recBtn.classList.add("recording");
    recBtn.innerHTML = `${ICON.stop}<span>${t("Berhenti")}</span>`;
    timer.hidden = false;
    tick = setInterval(() => {
      const s = (Date.now() - startedAt) / 1000;
      timer.textContent = `${mm(s)} / 1:00`;
      if (s >= MAX_SECS) stopRec();
    }, 250);
  };
  discardBtn.onclick = () => setVoice(null);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = form.elements.body.value.trim();
    if (!body && !voice) { toast(t("Tulis ucapan atau rekam suara dulu.")); return; }
    const btn = form.querySelector('[data-act="send"]');
    btn.disabled = true;
    try {
      const r = (await rpc("add_message", {
        p_event: status.event_id, p_body: body || null,
        p_audio_ext: voice ? voice.ext : null, p_audio_secs: voice ? voice.secs : null,
      }))[0];
      if (r.o_audio_path) {
        await uploadVoice(r.o_audio_path, voice.blob);
        await rpc("confirm_message", { p_id: r.o_id });
      }
      form.reset();
      setVoice(null);
      toast(t("Ucapan terkirim. Terima kasih!"));
      pingAlbum(status.event_id, "message");
      load();
    } catch (err) { toast(friendly(err)); }
    finally { btn.disabled = false; }
  };

  async function load() {
    try { rows = await rpc("list_messages", { p_event: status.event_id }); }
    catch (e) { list.replaceChildren(el(`<p class="hint">${esc(friendly(e))}</p>`)); return; }
    const mine = rows.filter((r) => r.is_mine).length;
    const left = Math.max(0, MAX_MSG - mine);
    view.querySelector(".gb-left").textContent = left ? t("Sisa {n} ucapan dari {max}", { n: left, max: MAX_MSG }) : t("Anda sudah mengirim {max} ucapan.", { max: MAX_MSG });
    form.querySelector('[data-act="send"]').disabled = !left;
    if (!rows.length) { list.replaceChildren(el(`<div class="empty-home"><div class="logo">${ICON.chat}</div><p>${t("Belum ada ucapan. Jadilah yang pertama!")}</p></div>`)); return; }
    let urls = {};
    try { urls = await voiceUrls(rows.filter((r) => r.audio_path).map((r) => r.audio_path)); } catch { /* tanpa suara */ }
    list.replaceChildren(...rows.map((r) => {
      const n = el(`
        <article class="card gb-item${r.hidden ? " is-hidden" : ""}">
          <div class="gb-head"><b>${esc(r.name || t("Tamu"))}</b><small>${esc(fmtDate(r.created_at))}</small>
            ${r.hidden ? `<span class="tag">${t("disembunyikan")}</span>` : ""}</div>
          ${r.body ? `<p class="gb-body">${esc(r.body)}</p>` : ""}
          ${r.audio_path ? `<audio controls preload="none" src="${esc(urls[r.audio_path] || "")}"></audio>` : ""}
          ${status.can_manage || r.is_mine ? `<div class="row tight wrap">
            ${status.can_manage ? `<button class="btn small ghost" data-a="hide">${r.hidden ? t("Tampilkan") : t("Sembunyikan")}</button>` : ""}
            <button class="btn small ghost danger" data-a="del">${t("Hapus")}</button></div>` : ""}
        </article>`);
      n.querySelector('[data-a="hide"]')?.addEventListener("click", async () => {
        try { await rpc("hide_message", { p_id: r.id, p_hidden: !r.hidden }); load(); } catch (e) { toast(friendly(e)); }
      });
      n.querySelector('[data-a="del"]')?.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: t("Hapus ucapan ini?"), text: t("Ucapan dan rekamannya dihapus permanen."), ok: t("Hapus"), danger: true }))) return;
        try {
          const path = await rpc("delete_message", { p_id: r.id });
          if (path) await removeVoices([path]).catch(() => {});
          load();
        } catch (e) { toast(friendly(e)); }
      });
      return n;
    }));
  }

  await load();
  let wait = 0;
  const off = onAlbumPing(status.event_id, (m) => {
    if (m.kind !== "message") return;
    clearTimeout(wait); wait = setTimeout(load, 1500);
  });
  const timerId = setInterval(load, 60000);
  return () => { off(); clearInterval(timerId); clearTimeout(wait); if (recorder) stopRec(); stream?.getTracks().forEach((tr) => tr.stop()); };
}
