-- =====================================================================
-- Jadwal hapus otomatis acara yang lewat tanggal hapus (sekali sehari).
-- Jalankan SETELAH Edge Function purge-events terpasang (lihat README).
-- Ganti tiga nilai bertanda <...> sebelum Run.
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
      'Authorization', 'Bearer <ANON-KEY>',
      'x-cron-secret', '<CRON-SECRET>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Cek jadwal:            select * from cron.job;
-- Cek hasil terakhir:    select * from cron.job_run_details order by start_time desc limit 5;
