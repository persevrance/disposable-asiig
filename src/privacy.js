// Data & privasi (UU PDP): tamu meminta foto di satu acara dihapus, atau akunnya dihapus.
// Permintaan diproses superadmin di Dashboard -> Privasi.
import { rpc, friendly } from "./supabase.js";
import { esc, toast, fmtDate, modal } from "./ui.js";
import { t } from "./i18n.js";

const STATUS = { open: "Menunggu", done: "Selesai", rejected: "Ditolak" };

export async function openPrivacy() {
  let events = [], reqs = [];
  try { [events, reqs] = await Promise.all([rpc("my_events"), rpc("my_data_requests").catch(() => [])]); }
  catch (e) { toast(friendly(e)); return; }
  const joined = events.filter((e) => !e.is_owner);
  const { box, close } = modal(`
    <form class="dialog privacy">
      <h3>${t("Data & privasi")}</h3>
      <p>${t("Minta foto Anda dihapus dari sebuah acara, atau hapus akun beserta semua foto dan ucapan Anda. Permintaan diproses admin, biasanya dalam 3 hari kerja.")}</p>
      <div class="radio-list">
        <label class="radio"><input type="radio" name="kind" value="photos" ${joined.length ? "checked" : "disabled"} />
          <span><b>${t("Hapus foto saya di satu acara")}</b><small>${t("Foto dan ucapan Anda di acara itu dihapus. Akun tetap ada.")}</small></span></label>
        <label class="radio"><input type="radio" name="kind" value="account" ${joined.length ? "" : "checked"} />
          <span><b>${t("Hapus akun saya")}</b><small>${t("Akun, semua foto, unduhan, dan ucapan Anda dihapus permanen.")}</small></span></label>
      </div>
      <label class="pv-event">${t("Acara")}
        <select name="event">${joined.map((e) => `<option value="${e.event_id}">${esc(e.name)}</option>`).join("")}</select></label>
      <label>${t("Catatan (opsional)")} <textarea name="note" rows="2" maxlength="500"></textarea></label>
      ${reqs.length ? `<div class="pv-history"><b>${t("Permintaan Anda")}</b><ul>${reqs.map((r) => `
        <li><span>${r.kind === "account" ? t("Hapus akun") : t("Hapus foto di {e}", { e: esc(r.event_name || "-") })}</span>
          <span class="tag ${r.status === "done" ? "ok" : r.status === "rejected" ? "bad" : "warn"}">${t(STATUS[r.status])}</span>
          <small>${esc(fmtDate(r.created_at))}${r.reply ? ` · ${esc(r.reply)}` : ""}</small></li>`).join("")}</ul></div>` : ""}
      <div class="dialog-actions">
        <button type="button" class="btn ghost" data-act="no">${t("Tutup")}</button>
        <button class="btn danger-fill">${t("Kirim permintaan")}</button>
      </div>
    </form>`);
  const f = box.querySelector("form");
  const sync = () => { box.querySelector(".pv-event").hidden = f.elements.kind.value !== "photos"; };
  f.querySelectorAll('input[name="kind"]').forEach((r) => (r.onchange = sync));
  sync();
  box.querySelector('[data-act="no"]').onclick = close;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const kind = f.elements.kind.value;
    try {
      await rpc("request_data_deletion", {
        p_kind: kind, p_event: kind === "photos" ? f.elements.event.value : null, p_note: f.elements.note.value,
      });
      toast(t("Permintaan terkirim. Anda bisa melihat statusnya di sini."), 5000);
      close();
    } catch (err) { toast(friendly(err)); }
  };
}
