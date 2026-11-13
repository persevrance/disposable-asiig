// Edge Function: kirim email dari antrean email_outbox (lihat bagian "Notifikasi email" di v2.sql).
// Dipanggil pg_net dengan body {"priority": "urgent" | "hourly" | "daily"}:
//   urgent  langsung saat kejadian (trigger) + jaring pengaman tiap 5 menit (pg_cron)
//   hourly  ringkasan per jam, satu email per penerima
//   daily   ringkasan harian 07.00 WIB, satu email per penerima
// Matikan "Verify JWT"; fungsi dijaga CRON_SECRET seperti purge-events.
//
// Variabel lingkungan (Edge Functions -> Secrets):
//   RESEND_API_KEY   dari resend.com (domain pengirim harus sudah diverifikasi)
//   EMAIL_FROM       mis. "TitipPotret <notifikasi@domain-anda.id>"
//   APP_URL          mis. https://domain-anda.id (tanpa garis miring di akhir)
//   CRON_SECRET      sama dengan yang dipakai purge-events dan disimpan di Vault
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  tersedia otomatis
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

type Row = {
  id: number;
  kind: string;
  recipient: string;
  priority: "urgent" | "hourly" | "daily";
  payload: Record<string, unknown>;
  created_at: string;
};
type Mail = { subject: string; html: string; text: string };

const BRAND = "TitipPotret";
const APP = (Deno.env.get("APP_URL") || "").replace(/\/+$/, "");

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response("Tidak diizinkan", { status: 401 });
  }
  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("EMAIL_FROM");
  if (!key || !from) return json({ error: "RESEND_API_KEY / EMAIL_FROM belum diatur" }, 500);

  const { priority } = await req.json().catch(() => ({}));
  if (!["urgent", "hourly", "daily"].includes(priority)) return json({ error: "priority tidak valid" }, 400);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: rows, error } = await supa.rpc("claim_emails", {
    p_priority: priority,
    p_limit: priority === "urgent" ? 50 : 200,
  });
  if (error) return json({ error: error.message }, 500);
  if (!rows?.length) return json({ sent: 0 });

  // urgent: satu email per kabar; ringkasan: satu email per penerima
  const batches: Row[][] = priority === "urgent"
    ? (rows as Row[]).map((r) => [r])
    : Object.values(groupBy(rows as Row[], (r) => r.recipient));

  const sent: number[] = [];
  const failed: Record<string, string> = {};
  let emails = 0;
  for (const batch of batches) {
    const mail = batch.length === 1 && priority === "urgent" ? single(batch[0]) : digest(batch, priority);
    const err = await send(key, from, batch[0].recipient, mail);
    if (err) for (const r of batch) failed[r.id] = err;
    else { sent.push(...batch.map((r) => r.id)); emails++; }
  }
  const fin = await supa.rpc("finish_emails", { p_sent: sent, p_failed: failed });
  if (fin.error) return json({ error: fin.error.message, sent: sent.length }, 500);
  return json({ priority, emails, rows: sent.length, failed: Object.keys(failed).length });
});

async function send(key: string, from: string, to: string, m: Mail): Promise<string | null> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: m.subject, html: m.html, text: m.text }),
    });
    if (res.ok) return null;
    return `${res.status} ${(await res.text()).slice(0, 300)}`;
  } catch (e) {
    return String((e as Error)?.message || e).slice(0, 300);
  }
}

// ---------- Isi email ----------

const REASONS: Record<string, string> = { tidak_pantas: "Tidak pantas", privasi: "Privasi", lainnya: "Lainnya" };

// Tiap jenis: judul untuk email tunggal, judul bagian ringkasan, satu baris ringkasan, tautan, isi tunggal.
const KINDS: Record<string, {
  subject: (p: P) => string;
  section: string;
  line: (p: P) => string;
  link: (p: P) => string;
  body?: (p: P) => string[];
}> = {
  payment_paid: {
    subject: (p) => `Pembayaran diterima: ${p.event_name}`,
    section: "Pembayaran diterima",
    line: (p) => `${p.event_name}: ${rupiah(p.amount)} (${p.order})`,
    link: (p) => (p.event_id ? `/#/e/${p.event_id}/panel` : "/#/"),
    body: (p) => [
      `Terima kasih, pembayaran untuk acara <b>${esc(p.event_name)}</b> sudah kami terima.`,
      table([
        ["Nomor pesanan", p.order],
        ["Jumlah", rupiah(p.amount)],
        ["Paket", p.unlimited ? "Tanpa batas tamu" : `${p.guests} tamu × ${p.shots} potret`],
        ["Masa simpan", p.keep_days ? `${p.keep_days} hari` : "-"],
        ["Metode", p.payment_type || "-"],
      ]),
      "Email ini adalah bukti pembayaran Anda.",
    ],
  },
  payment_paid_admin: {
    subject: (p) => `Pembayaran masuk: ${rupiah(p.amount)}`,
    section: "Pembayaran masuk",
    line: (p) => `${p.event_name}: ${rupiah(p.amount)} via ${p.payment_type || "-"} (${p.order})`,
    link: () => "/#/admin/acara",
  },
  payment_refunded: {
    subject: (p) => `Pengembalian dana: ${p.event_name}`,
    section: "Pengembalian dana",
    line: (p) => `${p.event_name}: ${rupiah(p.amount)} (${p.order})`,
    link: (p) => (p.event_id ? `/#/e/${p.event_id}/panel` : "/#/"),
    body: (p) => [
      `Dana sebesar <b>${rupiah(p.amount)}</b> untuk acara <b>${esc(p.event_name)}</b> (pesanan ${esc(p.order)}) sudah dikembalikan.`,
      "Waktu dana tiba tergantung metode pembayaran yang dipakai.",
    ],
  },
  payment_refunded_admin: {
    subject: (p) => `Refund tercatat: ${p.event_name}`,
    section: "Refund",
    line: (p) => `${p.event_name}: ${rupiah(p.amount)} (${p.order})`,
    link: () => "/#/admin/acara",
    body: (p) => [`Pesanan <b>${esc(p.order)}</b> untuk acara <b>${esc(p.event_name)}</b> berstatus refund (${rupiah(p.amount)}).`],
  },
  photo_report: {
    subject: (p) => `Laporan foto di ${p.event_name}`,
    section: "Laporan foto",
    line: (p) => `${p.event_name}: ${p.reports} laporan, alasan ${REASONS[String(p.reason)] || p.reason}${p.note ? ` ("${p.note}")` : ""}`,
    link: (p) => `/#/e/${p.event_id}/panel`,
  },
  photo_hidden: {
    subject: (p) => `Foto disembunyikan otomatis di ${p.event_name}`,
    section: "Foto disembunyikan otomatis",
    line: (p) => `${p.event_name}: ${p.reports} laporan`,
    link: (p) => `/#/e/${p.event_id}/panel`,
    body: (p) => [
      `Satu foto di acara <b>${esc(p.event_name)}</b> mendapat <b>${p.reports} laporan</b> dan sudah disembunyikan otomatis dari album.`,
      `Alasan terakhir: ${esc(REASONS[String(p.reason)] || p.reason)}${p.note ? `, "${esc(p.note)}"` : ""}.`,
      "Tinjau di panel moderasi: sembunyikan permanen, blokir pemotret, atau tampilkan lagi bila laporan tidak terbukti.",
    ],
  },
  event_created: {
    subject: (p) => `Acara baru: ${p.event_name}`,
    section: "Acara baru",
    line: (p) => `${p.event_name} oleh ${p.owner_email || "-"}: ${p.unlimited ? "tanpa batas" : `${p.guests} tamu × ${p.shots} potret`}, ${p.pay_status}`,
    link: () => "/#/admin/acara",
  },
  event_review: {
    subject: (p) => `Perlu ditinjau: ${p.event_name}`,
    section: "Acara perlu ditinjau",
    line: (p) => `${p.event_name} oleh ${p.owner_email || "-"}: ${p.unlimited ? "tanpa batas" : `${p.guests} tamu`}${p.starts_at ? `, mulai ${tanggal(p.starts_at)}` : ""}`,
    link: () => "/#/admin/pembuatan",
  },
  creator_request: {
    subject: (p) => `Pengajuan pembuat acara: ${p.email}`,
    section: "Pengajuan pembuat acara",
    line: (p) => `${p.email} (wa.me/${p.phone}): ${p.event_name}${p.event_date ? `, ${p.event_date}` : ""}${p.guests ? `, ${p.guests} tamu` : ""}`,
    link: () => "/#/admin/pengguna",
  },
  creator_decision: {
    subject: (p) => (p.status === "approved" ? "Pengajuan Anda disetujui" : "Pengajuan Anda belum disetujui"),
    section: "Keputusan pengajuan",
    line: (p) => `${p.event_name}: ${p.status === "approved" ? "disetujui" : "belum disetujui"}`,
    link: (p) => (p.status === "approved" ? "/#/admin/acara" : "/#/"),
    body: (p) => [
      p.status === "approved"
        ? `Pengajuan Anda untuk <b>${esc(p.event_name)}</b> disetujui. Sekarang Anda bisa membuat acara.`
        : `Pengajuan Anda untuk <b>${esc(p.event_name)}</b> belum bisa kami setujui.`,
      ...(p.reply ? [`Catatan dari admin: "${esc(p.reply)}"`] : []),
    ],
  },
  data_request: {
    subject: (p) => `Permintaan hapus data: ${p.email}`,
    section: "Permintaan hapus data (UU PDP)",
    line: (p) => `${p.email}: ${p.kind === "account" ? "hapus akun" : `hapus foto di ${p.event_name || "acara"}`}${p.note ? ` ("${p.note}")` : ""}`,
    link: () => "/#/admin/privasi",
  },
  capacity_closed: {
    subject: () => "Pembuatan acara ditutup otomatis",
    section: "Kapasitas",
    line: () => "Pembuatan acara ditutup otomatis (pemakaian ≥ 95%)",
    link: () => "/#/admin/pembuatan",
    body: () => [
      "Pengaman kapasitas menutup pembuatan acara baru karena perkiraan pemakaian sudah melewati 95%.",
      "Acara yang sudah berjalan tidak terpengaruh. Periksa meter kapasitas, lalu buka lagi bila sudah aman.",
    ],
  },
  capacity_limited: {
    subject: () => "Pembuatan acara dibatasi otomatis",
    section: "Kapasitas",
    line: () => "Pembuatan acara dibatasi ke acara kecil (pemakaian ≥ 85%)",
    link: () => "/#/admin/pembuatan",
  },
};
// deno-lint-ignore no-explicit-any
type P = Record<string, any>;

function kindOf(k: string) {
  return KINDS[k] || { subject: () => "Pemberitahuan", section: k, line: () => k, link: () => "/#/" };
}

function single(r: Row): Mail {
  const k = kindOf(r.kind), p = r.payload as P;
  const paras = k.body ? k.body(p) : [esc(k.line(p))];
  const url = APP + k.link(p);
  return {
    subject: `${k.subject(p)} · ${BRAND}`,
    html: layout(k.subject(p), paras.map((x) => (x.startsWith("<table") ? x : `<p>${x}</p>`)).join("") + button(url, "Buka")),
    text: [k.subject(p), "", ...paras.map(strip), "", url].join("\n"),
  };
}

function digest(rows: Row[], priority: string): Mail {
  const label = priority === "daily" ? "Ringkasan harian" : "Ringkasan per jam";
  const groups = groupBy(rows, (r) => kindOf(r.kind).section);
  const total = rows.length;
  let html = `<p>${total} kabar baru sejak ringkasan sebelumnya.</p>`;
  const text: string[] = [`${label} ${BRAND}`, `${total} kabar baru.`, ""];
  for (const [section, items] of Object.entries(groups)) {
    html += `<h3 style="margin:20px 0 6px;font-size:15px">${esc(section)} (${items.length})</h3><ul style="padding-left:18px;margin:0">`;
    text.push(`${section} (${items.length})`);
    for (const r of items.slice(0, 50)) {
      const k = kindOf(r.kind), p = r.payload as P, url = APP + k.link(p);
      html += `<li style="margin:4px 0"><a href="${esc(url)}" style="color:#b4532a">${esc(k.line(p))}</a></li>`;
      text.push(`- ${k.line(p)}  ${url}`);
    }
    if (items.length > 50) { html += `<li>…dan ${items.length - 50} lainnya</li>`; text.push(`- …dan ${items.length - 50} lainnya`); }
    html += "</ul>";
    text.push("");
  }
  const sections = Object.keys(groups);
  return {
    subject: `${label}: ${sections.length === 1 ? `${total} ${sections[0].toLowerCase()}` : `${total} kabar`} · ${BRAND}`,
    html: layout(label, html + button(`${APP}/#/admin`, "Buka dasbor")),
    text: text.join("\n"),
  };
}

function layout(title: string, inner: string) {
  return `<!doctype html><html><body style="margin:0;background:#f6f1ea;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2b2420">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="font-weight:700;font-size:18px;margin-bottom:16px">${BRAND}</div>
<div style="background:#fff;border-radius:12px;padding:24px;line-height:1.55;font-size:15px">
<h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>${inner}</div>
<p style="font-size:12px;color:#7a6e66;margin-top:16px">Email otomatis dari ${BRAND}. Jangan balas email ini.</p>
</div></body></html>`;
}
const button = (url: string, label: string) =>
  `<p style="margin-top:20px"><a href="${esc(url)}" style="display:inline-block;background:#b4532a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${esc(label)}</a></p>`;
const table = (rows: [string, unknown][]) =>
  `<table style="border-collapse:collapse;margin:12px 0">${rows.map(([k, v]) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#7a6e66">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("")}</table>`;

// ---------- Pembantu ----------

function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function strip(html: string) {
  return html.replace(/<tr>/g, "\n").replace(/<\/td><td[^>]*>/g, ": ").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
function rupiah(v: unknown) {
  return "Rp" + Number(v || 0).toLocaleString("id-ID");
}
function tanggal(v: unknown) {
  return new Date(String(v)).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
}
function groupBy<T>(xs: T[], f: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of xs) (out[f(x)] ||= []).push(x);
  return out;
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
