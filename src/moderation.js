// Daftar laporan foto dengan aksi tindak lanjut. Dipakai di Panel acara (satu acara)
// dan tab Moderasi superadmin (semua acara).
import { rpc, friendly } from "./supabase.js";
import { getUrls } from "./storage.js";
import { el, esc, toast, fmtDate, confirmDialog, modal } from "./ui.js";

const REASON = { tidak_pantas: "Tidak pantas", privasi: "Privasi", lainnya: "Lainnya" };

// rows: hasil list_reports. onChange dipanggil setelah laporan ditindak.
export async function renderReports(box, rows, { showEvent = false, onChange } = {}) {
  if (!rows.length) {
    box.replaceChildren(el(`<p class="hint">Tidak ada laporan yang menunggu. Laporan dari tamu muncul di sini.</p>`));
    return;
  }
  let urls = {};
  try { urls = await getUrls(rows.map((r) => r.thumb_path)); } catch { /* tampil tanpa gambar */ }
  box.replaceChildren(...rows.map((r) => {
    const n = el(`
      <article class="report-item">
        <button class="report-thumb" aria-label="Lihat foto lebih besar">
          <img alt="Foto yang dilaporkan" src="${esc(urls[r.thumb_path] || "")}" loading="lazy" />
          ${r.hidden ? `<span class="badge">disembunyikan</span>` : ""}
        </button>
        <div class="report-main">
          <b>${r.reports} laporan · ${r.reasons.map((x) => esc(REASON[x] || x)).join(", ")}</b>
          <small>Pemotret: ${esc(r.uploader_name)}${showEvent ? ` · acara “${esc(r.event_name)}”` : ""} · terakhir ${esc(fmtDate(r.last_at))}</small>
          ${r.notes?.length ? `<ul class="report-notes">${r.notes.map((t) => `<li>“${esc(t)}”</li>`).join("")}</ul>` : ""}
          <div class="row tight wrap">
            ${r.hidden ? "" : `<button class="btn small primary" data-a="hide">Sembunyikan</button>`}
            <button class="btn small danger" data-a="block">Sembunyikan + blokir pemotret</button>
            <button class="btn small ghost" data-a="dismiss">${r.hidden ? "Tampilkan lagi" : "Abaikan"}</button>
            ${showEvent ? `<a class="btn small ghost" href="#/e/${r.event_id}/panel">Buka acara</a>` : ""}
          </div>
        </div>
      </article>`);
    n.querySelector(".report-thumb").onclick = async () => {
      const u = await getUrls([r.medium_path]).catch(() => ({}));
      const { box: m, close } = modal(`<div class="report-preview"><img alt="Foto yang dilaporkan" src="${esc(u[r.medium_path] || "")}" /><div class="dialog-actions"><button class="btn" data-act="x">Tutup</button></div></div>`, { wide: true });
      m.querySelector('[data-act="x"]').onclick = close;
    };
    n.querySelectorAll("[data-a]").forEach((b) => (b.onclick = async () => {
      const action = b.dataset.a;
      if (action === "block" && !(await confirmDialog({
        title: `Blokir ${r.uploader_name}?`,
        text: "Foto ini disembunyikan, dan pemotret tidak bisa memotret atau melihat album acara ini lagi. Bisa dipulihkan dari Panel → Peserta.",
        ok: "Blokir", danger: true,
      }))) return;
      n.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        await rpc("resolve_reports", { p_photo: r.photo_id, p_action: action });
        toast(action === "dismiss" ? "Laporan diabaikan." : action === "block" ? "Foto disembunyikan dan pemotret diblokir." : "Foto disembunyikan.");
        n.remove();
        if (!box.children.length) renderReports(box, [], { showEvent, onChange });
        onChange?.();
      } catch (e) {
        toast(friendly(e));
        n.querySelectorAll("button").forEach((x) => (x.disabled = false));
      }
    }));
    return n;
  }));
}
