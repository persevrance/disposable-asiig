-- =====================================================================
-- Jadwal hapus otomatis acara yang lewat tanggal hapus (sekali sehari).
-- Jalankan SETELAH Edge Function purge-events terpasang (lihat README 1b).
--
-- JANGAN simpan nilai asli di file ini (file ini masuk git). Salin ke
-- SQL Editor, ganti dua nilai <...> di sana (tanda < > ikut dihapus), lalu Run.
--
-- Matikan "Verify JWT" pada fungsi purge-events: fungsi dijaga CRON_SECRET,
-- dan key format baru (sb_publishable_...) bukan JWT sehingga akan ditolak.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Hapus jadwal lama dengan nama yang sama (aman dijalankan ulang)
select cron.unschedule(jobid) from cron.job where jobname = 'hapus-acara-kedaluwarsa';

-- Setiap hari pukul 03.15 WIB (20.15 UTC)
select cron.schedule(
  'hapus-acara-kedaluwarsa',
  '15 20 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/purge-events',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', '<CRON-SECRET>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Cek jadwal:            select * from cron.job;
-- Cek hasil terakhir:    select * from cron.job_run_details order by start_time desc limit 5;
-- Uji sekarang (tanpa menunggu jadwal): jalankan isi blok select net.http_post(...) di atas,
-- lalu lihat hasilnya:   select status_code, content from net._http_response order by created desc limit 1;
