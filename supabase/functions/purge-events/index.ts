// Edge Function: hapus otomatis acara yang sudah lewat tanggal hapus (events.purge_at).
// Dipanggil harian oleh pg_cron (lihat supabase/cron.sql). File di Storage dihapus
// lewat Storage API (Supabase tidak mengizinkan hapus langsung dari tabel storage),
// lalu baris acara dihapus; foto, peserta, dan unduhan ikut terhapus (cascade).
//
// Variabel lingkungan:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  tersedia otomatis di Edge Functions
//   CRON_SECRET                              buat sendiri: Edge Functions -> Secrets
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MAX_EVENTS_PER_RUN = 20;

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response("Tidak diizinkan", { status: 401 });
  }

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: events, error } = await supa
    .from("events")
    .select("id, name, purge_at")
    .lte("purge_at", new Date().toISOString())
    .order("purge_at")
    .limit(MAX_EVENTS_PER_RUN);
  if (error) return json({ error: error.message }, 500);

  const done: unknown[] = [];
  for (const ev of events ?? []) {
    try {
      const photos = await removeFolder(supa, "photos", ev.id);
      const covers = await removeFolder(supa, "covers", ev.id);
      const { error: delErr } = await supa.from("events").delete().eq("id", ev.id);
      if (delErr) throw delErr;
      await supa.from("audit_log").insert({
        actor_email: "sistem (hapus otomatis)",
        action: "hapus_acara",
        target: ev.id,
        detail: { name: ev.name, purge_at: ev.purge_at, files: photos + covers },
      });
      done.push({ id: ev.id, name: ev.name, files: photos + covers });
    } catch (e) {
      done.push({ id: ev.id, name: ev.name, error: String((e as Error)?.message ?? e) });
    }
  }
  return json({ deleted: done.filter((d: any) => !d.error).length, results: done });
});

// Hapus semua file di folder <eventId>/ pada satu bucket; mengembalikan jumlah file
async function removeFolder(supa: ReturnType<typeof createClient>, bucket: string, folder: string) {
  let total = 0;
  for (;;) {
    const { data, error } = await supa.storage.from(bucket).list(folder, { limit: 100 });
    if (error) throw error;
    const paths = (data ?? []).filter((f) => f.id).map((f) => `${folder}/${f.name}`);
    if (!paths.length) return total;
    const { error: rmErr } = await supa.storage.from(bucket).remove(paths);
    if (rmErr) throw rmErr;
    total += paths.length;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
