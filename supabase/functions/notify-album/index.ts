// Edge Function: kirim notifikasi browser "album sudah terbuka" ke tamu yang memintanya.
// Album dianggap terbuka penuh saat acara tertutup (sakelar atau jadwal selesai) atau waktu
// cuci film lewat. Dipicu aplikasi (saat acara ditutup, dan sesekali saat aplikasi dibuka),
// jadi tidak butuh jadwal server. Aman dipanggil berulang: tiap acara dikabari sekali.
//
// Variabel lingkungan (Edge Functions -> Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   dari: npx web-push generate-vapid-keys
//   VAPID_SUBJECT                          mailto:alamat-anda@contoh.com
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY tersedia otomatis
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return json({ error: "VAPID belum diatur" }, 500);
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@disposable-asiig.my.id", pub, priv);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: rows, error } = await supa.rpc("due_album_notifications");
  if (error) return json({ error: error.message }, 500);
  if (!rows?.length) return json({ sent: 0 });

  const events = new Set<string>();
  const gone: string[] = [];
  let sent = 0;
  // Maks. 200 kiriman per panggilan; sisanya pada panggilan berikutnya
  for (const r of rows.slice(0, 200)) {
    events.add(r.event_id);
    const payload = JSON.stringify({
      title: "Album sudah terbuka",
      body: `Semua foto ${r.event_name} sudah bisa dilihat. Album is now open.`,
      url: `/#/e/${r.event_id}/album`,
      tag: `album-${r.event_id}`,
    });
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, { TTL: 86400 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) gone.push(r.endpoint);   // langganan sudah tidak berlaku
    }
  }
  const done = rows.length <= 200 ? [...events] : [...events].filter((id) => !rows.slice(200).some((r) => r.event_id === id));
  if (done.length) await supa.rpc("mark_album_notified", { p_events: done });
  if (gone.length) await supa.rpc("drop_push", { p_endpoints: gone });
  return json({ sent, events: done.length, removed: gone.length });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
