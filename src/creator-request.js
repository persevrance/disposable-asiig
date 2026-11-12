// Pengajuan menjadi pembuat acara: untuk akun yang belum punya peran.
// Superadmin meninjau di Dashboard → Pengguna & peran dan menghubungi lewat WhatsApp.
import { rpc, friendly } from "./supabase.js";
import { el, esc, toast, modal, fmtDate } from "./ui.js";
import { t } from "./i18n.js";

// Status pengajuan terakhir milik pengguna (null bila belum pernah atau tabel belum ada)
export async function myCreatorRequest() {
  try { return (await rpc("my_creator_request"))[0] || null; } catch { return null; }
}

// Kartu status di beranda: sedang ditinjau / ditolak (dengan alasan)
export function requestStatusCard(req, { onRetry }) {
  if (!req || req.status === "approved") return null;
  const open = req.status === "open";
  const card = el(`
    <div class="req-card ${open ? "open" : "rejected"}" role="status">
      <b>${open ? t("Pengajuan pembuat acara sedang ditinjau") : t("Pengajuan pembuat acara ditolak")}</b>
      <span>${open
        ? t("Untuk {e}. Admin akan menghubungi Anda lewat WhatsApp.", { e: esc(req.event_name) })
        : esc(req.reply || t("Tanpa keterangan."))}</span>
      <small>${t("Dikirim {d}", { d: esc(fmtDate(req.created_at)) })}</small>
      ${open ? "" : `<button type="button" class="btn small" data-act="retry">${t("Ajukan lagi")}</button>`}
    </div>`);
  card.querySelector('[data-act="retry"]')?.addEventListener("click", onRetry);
  return card;
}

// Form pengajuan. prev: pengajuan sebelumnya (isian diisi ulang bila ditolak)
export function openCreatorRequest({ prev = null, onDone } = {}) {
  const wa = prev?.phone ? `0${String(prev.phone).replace(/^62/, "")}` : "";
  const { box, close } = modal(`
    <form class="dialog creator-req" novalidate>
      <h3>${t("Ajukan jadi pembuat acara")}</h3>
      <p>${t("Akun Anda belum bisa membuat acara. Ceritakan acaranya, admin akan meninjau dan menghubungi Anda lewat WhatsApp.")}</p>
      <label>${t("Nama acara yang direncanakan")}
        <input name="event_name" required minlength="3" maxlength="80" value="${esc(prev?.event_name || "")}" placeholder="${t("Contoh: Pernikahan Rani & Bima")}" autofocus /></label>
      <div class="date-row">
        <label>${t("Perkiraan tanggal")} <input name="event_date" type="date" value="${esc(prev?.event_date || "")}" /></label>
        <label>${t("Perkiraan jumlah tamu")} <input name="guests" type="number" inputmode="numeric" min="1" max="100000" value="${esc(prev?.guests ?? "")}" /></label>
      </div>
      <label>${t("Nomor WhatsApp")}
        <input name="phone" type="tel" inputmode="tel" autocomplete="tel" required value="${esc(wa)}" placeholder="0812 3456 7890" aria-describedby="wa-hint" />
        <small id="wa-hint" class="hint">${t("Hanya dipakai admin untuk menghubungi Anda soal pengajuan ini.")}</small></label>
      <label>${t("Catatan (opsional)")}
        <textarea name="note" rows="2" maxlength="500" placeholder="${t("Misalnya: acara kantor, butuh 3 acara per bulan")}">${esc(prev?.note || "")}</textarea></label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-act="cancel">${t("Batal")}</button>
        <button class="btn primary" data-act="send">${t("Kirim pengajuan")}</button>
      </div>
    </form>`);
  const form = box.querySelector("form");
  const f = form.elements;
  box.querySelector('[data-act="cancel"]').onclick = close;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (f.event_name.value.trim().length < 3) { toast(t("Isi nama acara yang direncanakan.")); f.event_name.focus(); return; }
    if (!/^[+\d][\d\s-]{8,}$/.test(f.phone.value.trim())) { toast(t("Nomor WhatsApp tidak valid. Contoh: 0812 3456 7890.")); f.phone.focus(); return; }
    const btn = box.querySelector('[data-act="send"]');
    btn.disabled = true;
    try {
      await rpc("request_creator", {
        p_phone: f.phone.value.trim(),
        p_event_name: f.event_name.value.trim(),
        p_event_date: f.event_date.value || null,
        p_guests: f.guests.value ? Number(f.guests.value) : null,
        p_note: f.note.value.trim() || null,
      });
      close();
      toast(t("Pengajuan terkirim. Admin akan menghubungi Anda lewat WhatsApp."), 5000);
      onDone?.();
    } catch (err) { toast(friendly(err)); btn.disabled = false; }
  };
}
