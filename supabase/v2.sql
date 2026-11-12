-- =====================================================================
-- Disposable Asiig v2 — jalankan SETELAH schema.sql.
-- Aman dijalankan ulang, dan aman untuk database yang sudah berisi data.
-- Isi: peran (superadmin/creator), pengaturan global, efek film,
-- resolusi, sembunyikan nama, gulungan per tamu, unduh untuk tamu
-- dengan kuota, sampul undangan, blokir akun, log aktivitas.
-- =====================================================================

-- ---------- Efek film yang dikenal (samakan dengan src/film.js) -----

create or replace function valid_film(p text) returns boolean
language sql immutable as $$
  select p in ('asli', 'senja', 'pagi', 'pastel', 'klasik', 'sinema', 'kenangan');
$$;

-- ---------- Tabel baru ----------------------------------------------

-- Peran per email (orang bisa diberi peran sebelum pernah login)
create table if not exists user_roles (
  email    text primary key check (email = lower(trim(email)) and email like '%_@_%'),
  role     text not null check (role in ('superadmin', 'creator')),
  added_by uuid references profiles(id) on delete set null,
  added_at timestamptz not null default now()
);

-- Pindahkan daftar pembuat acara lama ke user_roles
do $$ begin
  if to_regclass('public.event_creators') is not null then
    insert into user_roles (email, role)
    select lower(trim(email)), 'creator' from event_creators where trim(email) like '%_@_%'
    on conflict (email) do nothing;
    drop table event_creators;
  end if;
end $$;

-- Pengaturan global (selalu tepat satu baris)
create table if not exists app_settings (
  id                boolean primary key default true check (id),
  max_shots_limit   int  not null default 100  check (max_shots_limit between 1 and 500),
  max_members_limit int  not null default 300  check (max_members_limit between 1 and 5000),
  default_film      text not null default 'senja' check (valid_film(default_film)),
  photo_max_side    int  not null default 2560 check (photo_max_side between 1280 and 4096),
  jpeg_quality      int  not null default 88   check (jpeg_quality between 60 and 95),
  mirror_preview    boolean not null default true,   -- kamera depan: jendela bidik dicerminkan
  mirror_photo      boolean not null default false,  -- kamera depan: hasil foto dicerminkan
  flash_enabled     boolean not null default true,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references profiles(id) on delete set null
);
insert into app_settings (id) values (true) on conflict (id) do nothing;
-- Kuota storage paket Supabase (untuk meter di Ringkasan), dalam MB
alter table app_settings add column if not exists storage_quota_mb int not null default 1024
  check (storage_quota_mb between 100 and 1000000);

create table if not exists downloads (
  event_id uuid not null references events(id) on delete cascade,
  user_id  uuid not null references profiles(id) on delete cascade,
  photo_id uuid not null references photos(id) on delete cascade,
  at       timestamptz not null default now(),
  primary key (user_id, photo_id)
);
create index if not exists downloads_event_user on downloads (event_id, user_id);

create table if not exists audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  action      text not null,
  target      text,
  detail      jsonb not null default '{}'
);
create index if not exists audit_log_at on audit_log (at desc);

-- Kegagalan kamera/unggah yang dilaporkan HP peserta (disimpan 30 hari)
create table if not exists client_errors (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  user_id  uuid references profiles(id) on delete cascade,
  event_id uuid references events(id) on delete set null,
  kind     text not null,
  detail   text,
  ua       text
);
create index if not exists client_errors_at   on client_errors (at desc);
create index if not exists client_errors_user on client_errors (user_id, at desc);

alter table user_roles   enable row level security;
alter table app_settings enable row level security;
alter table downloads    enable row level security;
alter table audit_log    enable row level security;
alter table client_errors enable row level security;
-- Sengaja tanpa aturan baca: semua akses lewat fungsi.

-- ---------- Kolom baru ----------------------------------------------

alter table profiles add column if not exists banned boolean not null default false;

-- Batas jumlah acara per pembuat acara (diatur superadmin). NULL = tanpa batas.
-- events_created menghitung acara yang pernah dibuat; tidak berkurang saat
-- acara dihapus. Superadmin bisa mengatur ulang hitungannya.
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'user_roles'
                    and column_name = 'events_created') then
    alter table user_roles add column events_created int not null default 0
      check (events_created >= 0);
    -- Isi awal dari acara yang masih ada
    update user_roles r set events_created = (
      select count(*) from events e join auth.users u on u.id = e.owner_id
       where lower(u.email) = r.email);
  end if;
end $$;
alter table user_roles add column if not exists event_limit int
  check (event_limit is null or event_limit between 0 and 10000);

alter table events drop constraint if exists events_max_shots_check;
alter table events add constraint events_max_shots_check check (max_shots between 1 and 500);

alter table events
  add column if not exists film           text    check (film is null or valid_film(film)),
  add column if not exists hide_names     boolean not null default false,
  add column if not exists mirror_preview boolean,          -- NULL = ikut pengaturan global
  add column if not exists mirror_photo   boolean,
  add column if not exists photo_max_side int     check (photo_max_side is null or photo_max_side between 1280 and 4096),
  add column if not exists cover_path     text,
  add column if not exists welcome_text   text    check (welcome_text is null or length(welcome_text) <= 300),
  add column if not exists allow_film_choice boolean not null default true;  -- tamu boleh ganti efek film

-- Versi sedang untuk dilihat di album; NULL pada foto lama (dari v1)
alter table photos add column if not exists medium_path text unique;

-- ---------- Fase 3: kolom dan tabel ---------------------------------

-- Jadwal acara. Setelah ends_at lewat, acara dianggap tertutup (tanpa jadwal server).
alter table events
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at   timestamptz;
-- Efek film yang dipakai saat memotret (NULL pada foto lama)
alter table photos add column if not exists film text;
-- Kuota storage per pembuat acara (MB). NULL = tanpa batas.
alter table user_roles add column if not exists storage_limit_mb int
  check (storage_limit_mb is null or storage_limit_mb between 1 and 10000000);
-- Nilai awal batas untuk pembuat acara yang baru ditambahkan. NULL = tanpa batas.
alter table app_settings
  add column if not exists creator_event_limit int
    check (creator_event_limit is null or creator_event_limit between 0 and 10000),
  add column if not exists creator_storage_mb int
    check (creator_storage_mb is null or creator_storage_mb between 1 and 10000000);

-- Foto favorit, per pengguna
create table if not exists favorites (
  user_id  uuid not null references profiles(id) on delete cascade,
  photo_id uuid not null references photos(id) on delete cascade,
  at       timestamptz not null default now(),
  primary key (user_id, photo_id)
);

-- Laporan foto dari peserta (moderasi)
create table if not exists photo_reports (
  id          bigserial primary key,
  photo_id    uuid not null references photos(id) on delete cascade,
  event_id    uuid not null references events(id) on delete cascade,
  reporter_id uuid not null references profiles(id) on delete cascade,
  reason      text not null check (reason in ('tidak_pantas', 'privasi', 'lainnya')),
  note        text check (note is null or length(note) <= 300),
  at          timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null,
  resolution  text,
  unique (photo_id, reporter_id)
);
create index if not exists photo_reports_open on photo_reports (event_id) where resolved_at is null;

alter table favorites     enable row level security;
alter table photo_reports enable row level security;

-- ---------- Fase 4: kolom dan tabel ---------------------------------

-- Penyimpanan foto: 'supabase' (Storage) atau 'r2' (Cloudflare R2 lewat Worker situs)
alter table app_settings
  add column if not exists storage_backend text not null default 'supabase'
    check (storage_backend in ('supabase', 'r2')),
  add column if not exists vapid_public_key text check (vapid_public_key is null or length(vapid_public_key) <= 200),
  -- Kuota R2 untuk meter di Ringkasan (paket gratis 10 GB), dalam MB
  add column if not exists r2_quota_mb int not null default 10240 check (r2_quota_mb between 100 and 10000000);

-- File foto yang tersimpan di R2 (dicatat Worker dengan service key setelah unggah/pindah)
create table if not exists r2_objects (
  name text primary key,
  size bigint not null default 0,
  at   timestamptz not null default now()
);
alter table r2_objects enable row level security;

-- Semua file aplikasi di Supabase Storage dan R2 (untuk ukuran dan cek unggahan).
-- File yang masih ada di kedua tempat (sedang dipindah) dihitung sekali.
create or replace view stored_objects as
  select o.bucket_id, o.name, coalesce((o.metadata->>'size')::bigint, 0) as size, o.created_at
    from storage.objects o where o.bucket_id in ('photos', 'covers')
  union all
  select 'photos', r.name, r.size, r.at
    from r2_objects r
   where not exists (select 1 from storage.objects o where o.bucket_id = 'photos' and o.name = r.name);
revoke all on stored_objects from public, anon, authenticated;

-- Notifikasi album terbuka
alter table events add column if not exists album_notified_at timestamptz;
create table if not exists push_subscriptions (
  endpoint   text primary key check (length(endpoint) <= 1000),
  user_id    uuid not null references profiles(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now()
);
create table if not exists album_watch (
  event_id   uuid not null references events(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

-- Buku tamu: ucapan teks dan/atau suara
create table if not exists guestbook (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references events(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  body       text check (body is null or length(body) <= 500),
  audio_path text unique,
  audio_secs int check (audio_secs is null or audio_secs between 1 and 60),
  status     text not null default 'ready' check (status in ('pending', 'ready')),
  hidden     boolean not null default false,
  created_at timestamptz not null default now(),
  check (body is not null or audio_path is not null)
);
create index if not exists guestbook_event on guestbook (event_id, created_at desc);

-- Permintaan hapus data (UU PDP)
create table if not exists data_requests (
  id         bigserial primary key,
  user_id    uuid references profiles(id) on delete set null,
  email      text,
  kind       text not null check (kind in ('photos', 'account')),
  event_id   uuid references events(id) on delete set null,
  note       text check (note is null or length(note) <= 500),
  status     text not null default 'open' check (status in ('open', 'done', 'rejected')),
  created_at timestamptz not null default now(),
  done_at    timestamptz,
  done_by    uuid references profiles(id) on delete set null,
  reply      text
);

alter table push_subscriptions enable row level security;
alter table album_watch        enable row level security;
alter table guestbook          enable row level security;
alter table data_requests      enable row level security;

-- Rekaman suara buku tamu (privat, kecil)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voices', 'voices', false, 2097152, array['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/aac'])
on conflict (id) do update
  set public = false, file_size_limit = 2097152,
      allowed_mime_types = array['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/aac'];

-- Acara terbuka untuk memotret saat ini: sakelar terbuka DAN waktu selesai belum lewat
create or replace function open_now(e events) returns boolean
language sql stable as $$
  select e.is_open and (e.ends_at is null or now() < e.ends_at);
$$;

-- ---------- Penyimpanan ---------------------------------------------

-- Foto ukuran penuh bisa beberapa MB
update storage.buckets set file_size_limit = 15728640 where id = 'photos';

-- Sampul/kartu undangan: publik (memang untuk dibagikan), nama file acak
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 3145728, array['image/jpeg'])
on conflict (id) do update
  set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];

-- ---------- Pembantu peran ------------------------------------------

-- Email akun pemanggil, hanya jika sudah terverifikasi. Peran dicocokkan dengan
-- ini (bukan klaim email di JWT), supaya akun email+password yang belum
-- dikonfirmasi tidak bisa memakai email superadmin.
create or replace function my_verified_email() returns text
language sql stable security definer set search_path = public as $$
  select lower(u.email) from auth.users u
   where u.id = auth.uid() and u.email_confirmed_at is not null;
$$;

create or replace function is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles
                  where email = my_verified_email() and role = 'superadmin');
$$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from user_roles where email = my_verified_email();
$$;

create or replace function can_create_event() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where email = my_verified_email())
     and not coalesce((select banned from profiles where id = auth.uid()), false);
$$;

create or replace function can_manage(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_superadmin()
      or exists (select 1 from events where id = p_event and owner_id = auth.uid());
$$;

create or replace function assert_owner(p_event uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not can_manage(p_event) then raise exception 'BUKAN_PEMILIK'; end if;
end $$;

create or replace function assert_superadmin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_superadmin() then raise exception 'BUKAN_SUPERADMIN'; end if;
end $$;

create or replace function assert_not_banned() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'BELUM_LOGIN'; end if;
  if exists (select 1 from profiles where id = auth.uid() and banned) then
    raise exception 'AKUN_DIBLOKIR';
  end if;
end $$;

create or replace function log_audit(p_action text, p_target text, p_detail jsonb default '{}')
returns void
language sql security definer set search_path = public as $$
  insert into audit_log (actor_id, actor_email, action, target, detail)
  values (auth.uid(), lower(auth.jwt()->>'email'), p_action, p_target, coalesce(p_detail, '{}'));
$$;

-- Pengaturan global untuk aplikasi (semua pengguna login boleh membaca)
create or replace function get_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(s) - 'id' - 'updated_by' from app_settings s;
$$;

-- ---------- Fungsi inti (diganti) -----------------------------------

create or replace function join_event(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_ev  events%rowtype;
begin
  perform assert_not_banned();

  select * into v_ev from events where join_code = upper(trim(p_code));
  if not found then raise exception 'KODE_SALAH'; end if;

  if exists (select 1 from event_members
             where event_id = v_ev.id and user_id = v_uid) then
    return v_ev.id;
  end if;

  if v_ev.owner_id <> v_uid then
    if v_ev.invite_only and not exists (
         select 1 from event_invites
         where event_id = v_ev.id and lower(email) = lower(auth.jwt()->>'email')) then
      raise exception 'TIDAK_DIUNDANG';
    end if;

    perform 1 from events where id = v_ev.id for update;
    if (select count(*) from event_members where event_id = v_ev.id) >= v_ev.max_members then
      raise exception 'ACARA_PENUH';
    end if;
  end if;

  insert into event_members (event_id, user_id) values (v_ev.id, v_uid);
  return v_ev.id;
end $$;

-- Pratinjau acara dari kode undangan (layar "Masuk acara")
drop function if exists event_preview(text);
create function event_preview(p_code text)
returns table (name text, cover_path text, welcome_text text, is_open boolean, max_shots int,
               starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.name, e.cover_path, e.welcome_text, open_now(e), e.max_shots, e.starts_at, e.ends_at
    from events e
   where auth.uid() is not null and e.join_code = upper(trim(p_code));
$$;

-- Memesan satu jepretan. Nama file tidak memuat user_id supaya
-- foto dari orang yang sama tidak bisa dikelompokkan dari URL-nya.
-- p_film: efek film yang dipakai HP (dicatat untuk penampil foto)
drop function if exists reserve_shot(uuid, uuid);
drop function if exists reserve_shot(uuid, uuid, text);
create function reserve_shot(p_event uuid, p_client_shot uuid, p_film text default null)
returns table (o_photo_id uuid, o_seq int, o_file_path text, o_medium_path text, o_thumb_path text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_used int; v_blocked boolean; v_max int; v_open boolean; v_seq int;
  v_id uuid := gen_random_uuid();
begin
  if v_uid is null then raise exception 'BELUM_LOGIN'; end if;

  select m.shots_used, m.blocked into v_used, v_blocked
    from event_members m
   where m.event_id = p_event and m.user_id = v_uid
     for update;
  if not found then raise exception 'BUKAN_PESERTA'; end if;

  return query                                          -- panggilan ulang: kembalikan yang lama
    select p.id, p.seq, p.file_path, p.medium_path, p.thumb_path from photos p
     where p.event_id = p_event and p.user_id = v_uid and p.client_shot_id = p_client_shot;
  if found then return; end if;

  if v_blocked then raise exception 'BUKAN_PESERTA'; end if;
  perform assert_not_banned();

  select e.max_shots, open_now(e) into v_max, v_open from events e where e.id = p_event;
  if not v_open then raise exception 'ACARA_TUTUP'; end if;
  if v_used >= v_max then raise exception 'FILM_HABIS'; end if;

  select coalesce(max(p.seq), 0) + 1 into v_seq
    from photos p where p.event_id = p_event and p.user_id = v_uid;

  update event_members set shots_used = v_used + 1
   where event_id = p_event and user_id = v_uid;

  return query
    insert into photos (id, event_id, user_id, seq, client_shot_id, file_path, medium_path, thumb_path, film)
    values (v_id, p_event, v_uid, v_seq, p_client_shot,
            p_event || '/' || v_id || '.jpg',
            p_event || '/' || v_id || '_m.jpg',
            p_event || '/' || v_id || '_t.jpg',
            case when valid_film(p_film) then p_film end)
    returning photos.id, photos.seq, photos.file_path, photos.medium_path, photos.thumb_path;
end $$;

create or replace function confirm_shot(p_photo uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update photos p set status = 'ready', taken_at = now()
   where p.id = p_photo and p.user_id = auth.uid() and p.status = 'pending'
     and exists (select 1 from stored_objects o
                  where o.bucket_id = 'photos' and o.name = p.file_path)
     and exists (select 1 from stored_objects o
                  where o.bucket_id = 'photos' and o.name = p.thumb_path)
     and (p.medium_path is null or exists (select 1 from stored_objects o
                  where o.bucket_id = 'photos' and o.name = p.medium_path));
  if found then return; end if;
  if exists (select 1 from photos where id = p_photo and user_id = auth.uid()
               and status = 'ready') then
    return;
  end if;
  raise exception 'FILE_BELUM_ADA';
end $$;

-- Album: gulungan yang sudah habis (atau acara ditutup / cuci film).
-- Pemilik acara dan superadmin melihat semua.
create or replace function visible_photos(p_event uuid) returns setof photos
language sql stable security definer set search_path = public as $$
  select p.*
    from photos p
    join events e        on e.id = p.event_id
    join event_members m on m.event_id = p.event_id and m.user_id = p.user_id
   where p.event_id = p_event
     and p.status = 'ready'
     and (
       e.owner_id = auth.uid() or is_superadmin()
       or (
         not p.hidden
         and exists (select 1 from event_members me join profiles pr on pr.id = me.user_id
                      where me.event_id = p_event and me.user_id = auth.uid()
                        and not me.blocked and not pr.banned)
         and case
               when e.reveal_at is not null then now() >= e.reveal_at
               else m.shots_used >= e.max_shots or not open_now(e)
             end
       )
     );
$$;

-- Nama pengunggah (dan nomor urutnya) disembunyikan bila hide_names aktif,
-- kecuali untuk pemilik acara, superadmin, dan foto milik sendiri.
-- p_filter: all | mine | fav. p_owner: foto satu tamu (diabaikan bila nama disembunyikan).
drop function if exists get_album(uuid, timestamptz, int);
drop function if exists get_album(uuid, timestamptz, int, text, uuid);
create function get_album(p_event uuid, p_before timestamptz default null, p_limit int default 60,
                          p_filter text default 'all', p_owner uuid default null)
returns table (photo_id uuid, seq int, owner_name text, taken_at timestamptz,
               thumb_path text, medium_path text, hidden boolean,
               is_mine boolean, downloaded boolean, film text, is_fav boolean)
language sql stable security definer set search_path = public as $$
  with ctx as (select can_manage(p_event) as manage)
  select v.id,
         case when e.hide_names and not ctx.manage and v.user_id <> auth.uid() then null else v.seq end,
         case when e.hide_names and not ctx.manage and v.user_id <> auth.uid() then null else pr.name end,
         v.taken_at, v.thumb_path, coalesce(v.medium_path, v.file_path), v.hidden,
         v.user_id = auth.uid(),
         exists (select 1 from downloads d where d.photo_id = v.id and d.user_id = auth.uid()),
         v.film,
         exists (select 1 from favorites f where f.photo_id = v.id and f.user_id = auth.uid())
    from visible_photos(p_event) v
    join events e    on e.id = v.event_id
    join profiles pr on pr.id = v.user_id
    cross join ctx
   where (p_before is null or v.taken_at < p_before)
     and (coalesce(p_filter, 'all') <> 'mine' or v.user_id = auth.uid())
     and (coalesce(p_filter, 'all') <> 'fav'
          or exists (select 1 from favorites f where f.photo_id = v.id and f.user_id = auth.uid()))
     and (p_owner is null
          or (v.user_id = p_owner and (not e.hide_names or ctx.manage or p_owner = auth.uid())))
   order by v.taken_at desc
   limit least(greatest(p_limit, 1), 100);
$$;

-- Tamu yang fotonya sudah tampil di album (untuk saringan per tamu).
-- Kosong bila nama pengunggah disembunyikan, kecuali untuk pengelola acara.
create or replace function album_owners(p_event uuid)
returns table (user_id uuid, name text, photos int)
language sql stable security definer set search_path = public as $$
  select v.user_id, pr.name, count(*)::int
    from visible_photos(p_event) v
    join events e    on e.id = v.event_id
    join profiles pr on pr.id = v.user_id
   where not e.hide_names or can_manage(p_event)
   group by v.user_id, pr.name
   order by pr.name;
$$;

-- Tandai / batalkan favorit. Mengembalikan keadaan baru.
create or replace function toggle_favorite(p_photo uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_event uuid;
begin
  perform assert_not_banned();
  select event_id into v_event from photos where id = p_photo;
  if v_event is null or not exists (select 1 from visible_photos(v_event) v where v.id = p_photo) then
    raise exception 'FOTO_TIDAK_ADA';
  end if;
  delete from favorites where user_id = auth.uid() and photo_id = p_photo;
  if found then return false; end if;
  insert into favorites (user_id, photo_id) values (auth.uid(), p_photo);
  return true;
end $$;

-- Status pemanggil di satu acara, termasuk pengaturan efektif kamera
drop function if exists my_status(uuid);
create function my_status(p_event uuid)
returns table (event_id uuid, name text, join_code text, max_shots int, max_members int,
               invite_only boolean, is_open boolean, reveal_at timestamptz,
               purge_at timestamptz, is_owner boolean, is_admin boolean, can_manage boolean,
               is_member boolean, shots_used int, blocked boolean, pending int,
               film text, hide_names boolean, cover_path text, welcome_text text,
               mirror_preview boolean, mirror_photo boolean, photo_max_side int,
               jpeg_quality int, flash_enabled boolean,
               ev_film text, ev_mirror_preview boolean, ev_mirror_photo boolean,
               ev_photo_max_side int, downloads_used int,
               max_shots_limit int, max_members_limit int, allow_film_choice boolean,
               starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.id, e.name,
         case when can_manage(e.id) then e.join_code end,
         e.max_shots, e.max_members, e.invite_only, open_now(e), e.reveal_at, e.purge_at,
         e.owner_id = auth.uid(), is_superadmin(), can_manage(e.id),
         m.user_id is not null,
         coalesce(m.shots_used, 0), coalesce(m.blocked, false),
         (select count(*)::int from photos p
           where p.event_id = e.id and p.user_id = auth.uid() and p.status = 'pending'),
         coalesce(e.film, s.default_film), e.hide_names, e.cover_path, e.welcome_text,
         coalesce(e.mirror_preview, s.mirror_preview), coalesce(e.mirror_photo, s.mirror_photo),
         coalesce(e.photo_max_side, s.photo_max_side), s.jpeg_quality, s.flash_enabled,
         e.film, e.mirror_preview, e.mirror_photo, e.photo_max_side,
         (select count(*)::int from downloads d join photos p on p.id = d.photo_id
           where d.event_id = e.id and d.user_id = auth.uid() and p.user_id <> auth.uid()),
         s.max_shots_limit, s.max_members_limit, e.allow_film_choice,
         e.starts_at, e.ends_at
    from events e
    cross join app_settings s
    left join event_members m on m.event_id = e.id and m.user_id = auth.uid()
   where e.id = p_event
     and (e.owner_id = auth.uid() or m.user_id is not null or is_superadmin());
$$;

-- Daftar acara milik / yang diikuti pemanggil (status terbuka memperhitungkan jadwal)
create or replace function my_events()
returns table (event_id uuid, name text, is_owner boolean, is_open boolean,
               max_shots int, shots_used int, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.id, e.name, e.owner_id = auth.uid(), open_now(e), e.max_shots,
         coalesce(m.shots_used, 0), e.created_at
    from events e
    left join event_members m on m.event_id = e.id and m.user_id = auth.uid()
   where e.owner_id = auth.uid() or m.user_id is not null
   order by e.created_at desc;
$$;

-- ---------- Unduh untuk tamu ----------------------------------------

-- Klaim foto untuk diunduh ukuran penuh. Kuota: max_shots foto orang lain
-- per acara. Foto sendiri dan foto yang sudah pernah diklaim tidak dihitung.
-- Pemilik acara dan superadmin tanpa batas.
create or replace function claim_downloads(p_event uuid, p_photos uuid[])
returns table (photo_id uuid, file_path text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_manage boolean;
  v_max int; v_used int; v_new int;
begin
  perform assert_not_banned();
  if coalesce(array_length(p_photos, 1), 0) > 100 then raise exception 'TERLALU_BANYAK'; end if;
  v_manage := can_manage(p_event);

  if not v_manage then
    perform 1 from event_members
     where event_id = p_event and user_id = v_uid and not blocked
       for update;                                      -- antre: kuota dihitung tepat
    if not found then raise exception 'BUKAN_PESERTA'; end if;

    select e.max_shots into v_max from events e where e.id = p_event;
    select count(*) into v_used
      from downloads d join photos p on p.id = d.photo_id
     where d.event_id = p_event and d.user_id = v_uid and p.user_id <> v_uid;
    select count(*) into v_new
      from visible_photos(p_event) v
     where v.id = any(p_photos) and v.user_id <> v_uid
       and not exists (select 1 from downloads d where d.photo_id = v.id and d.user_id = v_uid);
    if v_used + v_new > v_max then raise exception 'KUOTA_UNDUH_HABIS'; end if;
  end if;

  insert into downloads (event_id, user_id, photo_id)
  select p_event, v_uid, v.id from visible_photos(p_event) v where v.id = any(p_photos)
  on conflict do nothing;

  return query
    select v.id, v.file_path from visible_photos(p_event) v where v.id = any(p_photos);
end $$;

-- ---------- Penyimpanan: aturan baca/tulis --------------------------

create or replace function can_upload(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from photos p
                  where p.user_id = auth.uid() and p.status = 'pending'
                    and (p.file_path = p_name or p.thumb_path = p_name or p.medium_path = p_name));
$$;

-- Thumbnail dan versi sedang: siapa pun yang boleh melihat fotonya.
-- Ukuran penuh: hanya pemotretnya atau yang sudah mengklaim unduhan
-- (pemilik acara dan superadmin lewat owns_path). Foto lama tanpa versi
-- sedang tetap terbaca seperti di v1.
create or replace function can_view(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from photos p
     where (p.thumb_path = p_name or p.medium_path = p_name
            or (p.file_path = p_name
                and (p.medium_path is null or p.user_id = auth.uid()
                     or exists (select 1 from downloads d
                                 where d.photo_id = p.id and d.user_id = auth.uid()))))
       and p.id in (select v.id from visible_photos(p.event_id) v));
$$;

create or replace function owns_path(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_superadmin()
      or exists (select 1 from events e
                  where e.id::text = split_part(p_name, '/', 1)
                    and e.owner_id = auth.uid());
$$;

drop policy if exists "sampul: baca pengelola"  on storage.objects;
drop policy if exists "sampul: unggah"          on storage.objects;
drop policy if exists "sampul: hapus"           on storage.objects;
create policy "sampul: baca pengelola" on storage.objects for select to authenticated
  using (bucket_id = 'covers' and public.owns_path(name));
create policy "sampul: unggah" on storage.objects for insert to authenticated
  with check (bucket_id = 'covers' and public.owns_path(name));
create policy "sampul: hapus" on storage.objects for delete to authenticated
  using (bucket_id = 'covers' and public.owns_path(name));

-- ---------- Panel pemilik (diganti / baru) --------------------------

-- Total ukuran file (foto + sampul) semua acara milik satu pengguna, dalam byte
create or replace function owner_bytes(p_owner uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(o.size), 0)::bigint
    from stored_objects o
    join events e on e.id::text = split_part(o.name, '/', 1)
   where e.owner_id = p_owner;
$$;

drop function if exists create_event(text, int, int, boolean);
create or replace function create_event(p_name text, p_max_shots int default 30,
                             p_max_members int default 60,
                             p_invite_only boolean default false,
                             p_film text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_try int := 0; s app_settings%rowtype; r user_roles%rowtype;
begin
  perform assert_not_banned();
  if not can_create_event() then raise exception 'TIDAK_BOLEH_MEMBUAT'; end if;
  -- Kunci baris peran supaya dua permintaan bersamaan tidak melewati batas
  select * into r from user_roles where email = my_verified_email() for update;
  if r.role <> 'superadmin' and r.event_limit is not null
     and r.events_created >= r.event_limit then
    raise exception 'BATAS_ACARA_HABIS';
  end if;
  if r.role <> 'superadmin' and r.storage_limit_mb is not null
     and owner_bytes(auth.uid()) >= r.storage_limit_mb::bigint * 1048576 then
    raise exception 'BATAS_STORAGE_HABIS';
  end if;
  select * into s from app_settings;
  if p_max_shots is null or p_max_shots < 1 or p_max_shots > s.max_shots_limit then
    raise exception 'JATAH_MELEBIHI_BATAS';
  end if;
  if p_max_members is null or p_max_members < 1 or p_max_members > s.max_members_limit then
    raise exception 'PESERTA_MELEBIHI_BATAS';
  end if;
  if p_film is not null and not valid_film(p_film) then raise exception 'FILM_TIDAK_DIKENAL'; end if;
  loop
    begin
      insert into events (owner_id, name, join_code, max_shots, max_members, invite_only, film)
      values (auth.uid(), trim(p_name), gen_code(), p_max_shots, p_max_members, p_invite_only,
              coalesce(p_film, s.default_film))
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 5 then raise; end if;
    end;
  end loop;
  insert into event_members (event_id, user_id) values (v_id, auth.uid());
  update user_roles set events_created = events_created + 1 where email = r.email;
  perform log_audit('buat_acara', v_id::text, jsonb_build_object('name', trim(p_name)));
  return v_id;
end $$;

-- Duplikat acara: salin pengaturan dan daftar undangan, tanpa peserta, foto, dan jadwal.
-- Batas acara dan storage tetap berlaku (lewat create_event). Sampul disalin oleh aplikasi.
create or replace function duplicate_event(p_event uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare e events%rowtype; v_id uuid;
begin
  perform assert_owner(p_event);
  select * into e from events where id = p_event;
  v_id := create_event(left(e.name, 69) || ' (salinan)', e.max_shots, e.max_members,
                       e.invite_only, e.film);
  update events set hide_names = e.hide_names, allow_film_choice = e.allow_film_choice,
                    welcome_text = e.welcome_text, mirror_preview = e.mirror_preview,
                    mirror_photo = e.mirror_photo, photo_max_side = e.photo_max_side
   where id = v_id;
  insert into event_invites (event_id, email)
  select v_id, email from event_invites where event_id = p_event;
  return v_id;
end $$;

-- Sisa batas acara dan storage pemanggil. limit NULL = tanpa batas.
create or replace function my_event_quota() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'limit', case when r.role = 'superadmin' then null else r.event_limit end,
           'used',  r.events_created,
           'storage_limit_mb', case when r.role = 'superadmin' then null else r.storage_limit_mb end,
           'storage_bytes', owner_bytes(auth.uid()))
    from user_roles r where r.email = my_verified_email();
$$;

-- Ubah acara dengan patch JSON: hanya kunci yang dikirim yang diubah.
-- mirror_preview, mirror_photo, photo_max_side hanya untuk superadmin.
drop function if exists set_event(uuid, text, boolean, timestamptz, timestamptz, int, boolean);
create or replace function set_event(p_event uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  e events%rowtype;
  s app_settings%rowtype;
  v_admin boolean := is_superadmin();
  v int;
begin
  perform assert_owner(p_event);
  select * into e from events where id = p_event for update;
  select * into s from app_settings;

  if (p_patch ?| array['mirror_preview', 'mirror_photo', 'photo_max_side']) and not v_admin then
    raise exception 'BUKAN_SUPERADMIN';
  end if;

  if p_patch ? 'name'         then e.name := trim(p_patch->>'name'); end if;
  if p_patch ? 'is_open'      then e.is_open := (p_patch->>'is_open')::boolean; end if;
  if p_patch ? 'reveal_at'    then e.reveal_at := (p_patch->>'reveal_at')::timestamptz; end if;
  if p_patch ? 'purge_at'     then e.purge_at := (p_patch->>'purge_at')::timestamptz; end if;
  if p_patch ? 'invite_only'  then e.invite_only := (p_patch->>'invite_only')::boolean; end if;
  if p_patch ? 'hide_names'   then e.hide_names := (p_patch->>'hide_names')::boolean; end if;
  if p_patch ? 'allow_film_choice' then e.allow_film_choice := (p_patch->>'allow_film_choice')::boolean; end if;
  if p_patch ? 'welcome_text' then e.welcome_text := nullif(trim(p_patch->>'welcome_text'), ''); end if;
  if p_patch ? 'mirror_preview' then e.mirror_preview := (p_patch->>'mirror_preview')::boolean; end if;
  if p_patch ? 'mirror_photo'   then e.mirror_photo := (p_patch->>'mirror_photo')::boolean; end if;
  if p_patch ? 'photo_max_side' then e.photo_max_side := (p_patch->>'photo_max_side')::int; end if;
  if p_patch ? 'starts_at' then e.starts_at := (p_patch->>'starts_at')::timestamptz; end if;
  if p_patch ? 'ends_at'   then e.ends_at := (p_patch->>'ends_at')::timestamptz; end if;
  -- Membuka lagi acara yang selesai karena jadwal: jadwal selesai dihapus
  if (p_patch->>'is_open')::boolean and not (p_patch ? 'ends_at') and e.ends_at <= now() then
    e.ends_at := null;
  end if;
  if e.starts_at is not null and e.ends_at is not null and e.ends_at <= e.starts_at then
    raise exception 'JADWAL_TIDAK_VALID';
  end if;

  if p_patch ? 'film' then
    if p_patch->>'film' is not null and not valid_film(p_patch->>'film') then
      raise exception 'FILM_TIDAK_DIKENAL';
    end if;
    e.film := p_patch->>'film';
  end if;

  if p_patch ? 'max_members' then
    v := (p_patch->>'max_members')::int;
    if v is null or v < 1 or v > s.max_members_limit then raise exception 'PESERTA_MELEBIHI_BATAS'; end if;
    e.max_members := v;
  end if;

  if p_patch ? 'max_shots' then
    v := (p_patch->>'max_shots')::int;
    if v is null or v < 1 or v > s.max_shots_limit then raise exception 'JATAH_MELEBIHI_BATAS'; end if;
    if v < e.max_shots and not v_admin then raise exception 'JATAH_TIDAK_BOLEH_TURUN'; end if;
    if v < (select coalesce(max(shots_used), 0) from event_members where event_id = p_event) then
      raise exception 'JATAH_DI_BAWAH_PEMAKAIAN';
    end if;
    e.max_shots := v;
  end if;

  update events set name = e.name, is_open = e.is_open, reveal_at = e.reveal_at,
                    purge_at = e.purge_at, invite_only = e.invite_only,
                    hide_names = e.hide_names, welcome_text = e.welcome_text,
                    allow_film_choice = e.allow_film_choice,
                    mirror_preview = e.mirror_preview, mirror_photo = e.mirror_photo,
                    photo_max_side = e.photo_max_side, film = e.film,
                    max_members = e.max_members, max_shots = e.max_shots,
                    starts_at = e.starts_at, ends_at = e.ends_at
   where id = p_event;
  perform log_audit('ubah_acara', p_event::text, p_patch);
end $$;

-- Pasang/hapus sampul. Mengembalikan path lama supaya file lama dibersihkan.
create or replace function set_cover(p_event uuid, p_path text) returns text
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  perform assert_owner(p_event);
  if p_path is not null and split_part(p_path, '/', 1) <> p_event::text then
    raise exception 'SAMPUL_SALAH';
  end if;
  select cover_path into v_old from events where id = p_event for update;
  update events set cover_path = p_path where id = p_event;
  perform log_audit('ubah_sampul', p_event::text, jsonb_build_object('path', p_path));
  return v_old;
end $$;

-- Gulungan satu tamu (pemilik acara / superadmin)
create or replace function get_roll(p_event uuid, p_user uuid)
returns table (photo_id uuid, seq int, status text, taken_at timestamptz,
               thumb_path text, medium_path text, hidden boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_owner(p_event);
  return query
    select p.id, p.seq, p.status, p.taken_at, p.thumb_path,
           coalesce(p.medium_path, p.file_path), p.hidden
      from photos p
     where p.event_id = p_event and p.user_id = p_user
     order by p.seq;
end $$;

create or replace function block_member(p_event uuid, p_user uuid, p_blocked boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  if p_user = auth.uid() then raise exception 'TIDAK_BISA_DIRI_SENDIRI'; end if;
  update event_members set blocked = p_blocked where event_id = p_event and user_id = p_user;
  perform log_audit(case when p_blocked then 'blokir_peserta' else 'pulihkan_peserta' end,
                    p_event::text, jsonb_build_object('user', p_user));
end $$;

create or replace function release_pending(p_event uuid, p_user uuid)
returns table (file_path text)
language plpgsql security definer set search_path = public as $$
declare v_n int; v_paths text[];
begin
  perform assert_owner(p_event);
  perform 1 from event_members where event_id = p_event and user_id = p_user for update;
  with d as (
    delete from photos p
     where p.event_id = p_event and p.user_id = p_user and p.status = 'pending'
    returning p.file_path, p.thumb_path, p.medium_path)
  select count(*)::int,
         coalesce(array_agg(d.file_path) || array_agg(d.thumb_path)
                  || array_remove(array_agg(d.medium_path), null), '{}')
    into v_n, v_paths from d;
  update event_members set shots_used = greatest(0, shots_used - v_n)
   where event_id = p_event and user_id = p_user;
  return query select unnest(v_paths);
end $$;

drop function if exists owner_paths(uuid);
create function owner_paths(p_event uuid)
returns table (photo_id uuid, owner_name text, seq int, status text,
               file_path text, medium_path text, thumb_path text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_owner(p_event);
  return query
    select p.id, pr.name, p.seq, p.status, p.file_path, p.medium_path, p.thumb_path
      from photos p join profiles pr on pr.id = p.user_id
     where p.event_id = p_event
     order by pr.name, p.seq;
end $$;

create or replace function delete_event(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  perform assert_owner(p_event);
  select name into v_name from events where id = p_event;
  delete from events where id = p_event;
  perform log_audit('hapus_acara', p_event::text, jsonb_build_object('name', v_name));
end $$;

-- ---------- Dashboard superadmin ------------------------------------

create or replace function admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform assert_superadmin();
  return jsonb_build_object(
    'users',         (select count(*) from profiles),
    'banned',        (select count(*) from profiles where banned),
    'superadmins',   (select count(*) from user_roles where role = 'superadmin'),
    'creators',      (select count(*) from user_roles where role = 'creator'),
    'events',        (select count(*) from events),
    'events_open',   (select count(*) from events e where open_now(e)),
    'reports_open',  (select count(distinct photo_id) from photo_reports where resolved_at is null),
    'members_total',     (select count(*) from event_members),
    'shooters_total',    (select count(*) from event_members where shots_used > 0),
    'rolls_total',       (select count(*) from event_members m join events e on e.id = m.event_id
                           where m.shots_used >= e.max_shots),
    'downloaders_total', (select count(*) from (select distinct event_id, user_id from downloads) d),
    'photos',        (select count(*) from photos where status = 'ready'),
    'pending',       (select count(*) from photos where status = 'pending'),
    'downloads',     (select count(*) from downloads),
    'photo_bytes',   (select coalesce(sum((metadata->>'size')::bigint), 0)
                        from storage.objects where bucket_id = 'photos'),
    'cover_bytes',   (select coalesce(sum((metadata->>'size')::bigint), 0)
                        from storage.objects where bucket_id = 'covers'),
    'voice_bytes',   (select coalesce(sum((metadata->>'size')::bigint), 0)
                        from storage.objects where bucket_id = 'voices'),
    'r2_bytes',      (select coalesce(sum(size), 0) from r2_objects),
    'r2_quota_mb',   (select r2_quota_mb from app_settings),
    'r2_files',      (select count(*) from r2_objects),
    'storage_backend', (select storage_backend from app_settings),
    'data_requests_open', (select count(*) from data_requests where status = 'open'),
    'storage_quota_mb', (select storage_quota_mb from app_settings),
    'camera_errors_24h', (select count(*) from client_errors where at > now() - interval '24 hours'),
    'overdue_events', (select count(*) from events where purge_at <= now()),
    'stuck_pending', (select count(*) from photos where status = 'pending'
                       and taken_at < now() - interval '1 hour'),
    'creators_at_limit', (select count(*) from user_roles where role = 'creator'
                           and event_limit is not null and events_created >= event_limit));
end $$;

drop function if exists admin_roles();
create function admin_roles()
returns table (email text, role text, added_at timestamptz, added_by text, user_name text,
               event_limit int, events_created int, storage_limit_mb int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select r.email, r.role, r.added_at, ab.name,
           (select pr.name from auth.users u join profiles pr on pr.id = u.id
             where lower(u.email) = r.email limit 1),
           r.event_limit, r.events_created, r.storage_limit_mb
      from user_roles r
      left join profiles ab on ab.id = r.added_by
     order by r.role desc, r.email;
end $$;

-- p_role NULL = cabut peran. Superadmin tidak bisa mengubah perannya sendiri
-- (mencegah tidak ada superadmin sama sekali).
create or replace function admin_set_role(p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email));
begin
  perform assert_superadmin();
  if v_email = my_verified_email() then raise exception 'TIDAK_BISA_DIRI_SENDIRI'; end if;
  if v_email not like '%_@_%' then raise exception 'EMAIL_TIDAK_VALID'; end if;
  if p_role is null then
    delete from user_roles where email = v_email;
  else
    -- Peran baru mendapat batas bawaan dari pengaturan global; peran lama tetap batasnya
    insert into user_roles (email, role, added_by, event_limit, storage_limit_mb)
    select v_email, p_role, auth.uid(), s.creator_event_limit, s.creator_storage_mb from app_settings s
    on conflict (email) do update set role = excluded.role, added_by = excluded.added_by,
                                      added_at = now();
  end if;
  perform log_audit('ubah_peran', v_email, jsonb_build_object('role', p_role));
end $$;

-- Atur batas acara satu pembuat acara. p_limit NULL = tanpa batas.
-- p_used (opsional) mengatur ulang hitungan acara yang sudah dibuat.
create or replace function admin_set_event_limit(p_email text, p_limit int, p_used int default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email));
begin
  perform assert_superadmin();
  if p_limit is not null and (p_limit < 0 or p_limit > 10000) then
    raise exception 'BATAS_ACARA_TIDAK_VALID';
  end if;
  if p_used is not null and p_used < 0 then raise exception 'BATAS_ACARA_TIDAK_VALID'; end if;
  update user_roles set event_limit = p_limit,
                        events_created = coalesce(p_used, events_created)
   where email = v_email;
  if not found then raise exception 'PERAN_TIDAK_ADA'; end if;
  perform log_audit('ubah_batas_acara', v_email,
                    jsonb_build_object('limit', p_limit, 'used', p_used));
end $$;

-- Atur kuota storage satu pembuat acara (MB). NULL = tanpa batas.
create or replace function admin_set_storage_limit(p_email text, p_mb int) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email));
begin
  perform assert_superadmin();
  if p_mb is not null and (p_mb < 1 or p_mb > 10000000) then raise exception 'BATAS_STORAGE_TIDAK_VALID'; end if;
  update user_roles set storage_limit_mb = p_mb where email = v_email;
  if not found then raise exception 'PERAN_TIDAK_ADA'; end if;
  perform log_audit('ubah_batas_storage', v_email, jsonb_build_object('mb', p_mb));
end $$;

create or replace function admin_set_settings(p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_superadmin();
  update app_settings set
    max_shots_limit   = coalesce((p_patch->>'max_shots_limit')::int,   max_shots_limit),
    max_members_limit = coalesce((p_patch->>'max_members_limit')::int, max_members_limit),
    default_film      = coalesce(p_patch->>'default_film',             default_film),
    photo_max_side    = coalesce((p_patch->>'photo_max_side')::int,    photo_max_side),
    jpeg_quality      = coalesce((p_patch->>'jpeg_quality')::int,      jpeg_quality),
    mirror_preview    = coalesce((p_patch->>'mirror_preview')::boolean, mirror_preview),
    mirror_photo      = coalesce((p_patch->>'mirror_photo')::boolean,   mirror_photo),
    flash_enabled     = coalesce((p_patch->>'flash_enabled')::boolean,  flash_enabled),
    storage_quota_mb  = coalesce((p_patch->>'storage_quota_mb')::int,  storage_quota_mb),
    r2_quota_mb       = coalesce((p_patch->>'r2_quota_mb')::int,       r2_quota_mb),
    -- Boleh dikosongkan (NULL = tanpa batas), jadi pakai "ada kuncinya" bukan coalesce
    creator_event_limit = case when p_patch ? 'creator_event_limit'
                               then (p_patch->>'creator_event_limit')::int else creator_event_limit end,
    creator_storage_mb  = case when p_patch ? 'creator_storage_mb'
                               then (p_patch->>'creator_storage_mb')::int else creator_storage_mb end,
    storage_backend   = coalesce(p_patch->>'storage_backend', storage_backend),
    vapid_public_key  = case when p_patch ? 'vapid_public_key'
                             then nullif(trim(p_patch->>'vapid_public_key'), '') else vapid_public_key end,
    updated_at = now(), updated_by = auth.uid()
  where id;
  perform log_audit('ubah_pengaturan', null, p_patch);
end $$;

-- Superadmin: semua acara. Pembuat acara: hanya acaranya sendiri.
-- p_status: all | open | closed | overdue. p_sort: created | activity | photos | bytes | members | name.
-- total_count = jumlah baris sebelum dipotong halaman.
-- p_sort 'date' = jadwal acara terdekat dulu (yang belum berjadwal di akhir).
drop function if exists admin_events(text);
drop function if exists admin_events(text, text, text, int, int);
create function admin_events(p_search text default null, p_status text default 'all',
                                        p_sort text default 'created', p_limit int default 25,
                                        p_offset int default 0)
returns table (event_id uuid, name text, owner_name text, owner_email text, join_code text,
               is_open boolean, max_shots int, max_members int, film text, hide_names boolean,
               members int, shooters int, rolls_done int, downloaders int,
               photos int, pending int, bytes bigint,
               created_at timestamptz, purge_at timestamptz, last_photo_at timestamptz,
               total_count bigint, starts_at timestamptz, ends_at timestamptz,
               cover_path text, reports int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_admin boolean := is_superadmin();
begin
  if not v_admin and not can_create_event() then raise exception 'TIDAK_BOLEH_MEMBUAT'; end if;
  return query
    with sz as (
      select split_part(o.name, '/', 1) as ev, sum(o.size) as b
        from stored_objects o where o.bucket_id = 'photos' group by 1),
    base as (
      select e.id as b_id, e.name as b_name, pr.name as b_owner, u.email::text as b_email,
             e.join_code as b_code, open_now(e) as b_open, e.max_shots as b_shots,
             e.starts_at as b_starts, e.ends_at as b_ends, e.cover_path as b_cover,
             (select count(distinct r.photo_id)::int from photo_reports r
               where r.event_id = e.id and r.resolved_at is null) as b_reports,
             e.max_members as b_max_members, e.film as b_film, e.hide_names as b_hide,
             e.created_at as b_created, e.purge_at as b_purge,
             coalesce(sz.b, 0)::bigint as b_bytes,
             (select count(*)::int from event_members m where m.event_id = e.id) as b_members,
             (select count(*)::int from event_members m where m.event_id = e.id and m.shots_used > 0) as b_shooters,
             (select count(*)::int from event_members m where m.event_id = e.id and m.shots_used >= e.max_shots) as b_rolls,
             (select count(distinct d.user_id)::int from downloads d where d.event_id = e.id) as b_dl,
             (select count(*)::int from photos p where p.event_id = e.id and p.status = 'ready') as b_photos,
             (select count(*)::int from photos p where p.event_id = e.id and p.status = 'pending') as b_pending,
             (select max(p.taken_at) from photos p where p.event_id = e.id and p.status = 'ready') as b_last
        from events e
        join profiles pr on pr.id = e.owner_id
        left join auth.users u on u.id = e.owner_id
        left join sz on sz.ev = e.id::text
       where (v_admin or e.owner_id = auth.uid())
         and (coalesce(p_status, 'all') = 'all'
              or (p_status = 'open' and open_now(e))
              or (p_status = 'closed' and not open_now(e))
              or (p_status = 'overdue' and e.purge_at <= now())
              or (p_status = 'reported' and exists (select 1 from photo_reports r
                                                     where r.event_id = e.id and r.resolved_at is null)))
         and (p_search is null or p_search = ''
              or e.name ilike '%' || p_search || '%' or pr.name ilike '%' || p_search || '%'
              or u.email ilike '%' || p_search || '%' or e.join_code = upper(trim(p_search))))
    select b.b_id, b.b_name, b.b_owner, b.b_email, b.b_code, b.b_open, b.b_shots, b.b_max_members,
           b.b_film, b.b_hide, b.b_members, b.b_shooters, b.b_rolls, b.b_dl, b.b_photos, b.b_pending,
           b.b_bytes, b.b_created, b.b_purge, b.b_last, count(*) over (),
           b.b_starts, b.b_ends, b.b_cover, b.b_reports
      from base b
     order by
       -- 'date': yang akan datang/berlangsung (terdekat dulu), lalu yang sudah lewat, lalu tanpa jadwal
       case when p_sort = 'date' then b.b_starts is null end asc,
       case when p_sort = 'date' then coalesce(b.b_ends, b.b_starts) < now() end asc,
       case when p_sort = 'date' and coalesce(b.b_ends, b.b_starts) >= now() then b.b_starts end asc,
       case when p_sort = 'date' then b.b_starts end desc,
       case when p_sort = 'name'     then b.b_name end asc,
       case when p_sort = 'photos'   then b.b_photos end desc,
       case when p_sort = 'bytes'    then b.b_bytes end desc,
       case when p_sort = 'members'  then b.b_members end desc,
       case when p_sort = 'activity' then b.b_last end desc nulls last,
       b.b_created desc
     limit least(greatest(coalesce(p_limit, 25), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- p_filter: all | superadmin | creator | banned | none
drop function if exists admin_users(text);
drop function if exists admin_users(text, text, int, int);
create function admin_users(p_search text default null, p_filter text default 'all',
                                       p_limit int default 25, p_offset int default 0)
returns table (user_id uuid, name text, email text, role text, banned boolean,
               event_limit int, events_created int,
               events_owned int, events_joined int, photos int,
               last_sign_in_at timestamptz, created_at timestamptz, total_count bigint,
               storage_limit_mb int, storage_bytes bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select pr.id, pr.name, u.email::text, r.role, pr.banned, r.event_limit, r.events_created,
           (select count(*)::int from events e where e.owner_id = pr.id),
           (select count(*)::int from event_members m where m.user_id = pr.id),
           (select count(*)::int from photos p where p.user_id = pr.id and p.status = 'ready'),
           u.last_sign_in_at, pr.created_at, count(*) over (),
           r.storage_limit_mb,
           case when r.role is not null or exists (select 1 from events e where e.owner_id = pr.id)
                then owner_bytes(pr.id) else 0 end
      from profiles pr
      join auth.users u on u.id = pr.id
      left join user_roles r on r.email = lower(u.email)
     where (p_search is null or p_search = ''
            or pr.name ilike '%' || p_search || '%' or u.email ilike '%' || p_search || '%')
       and (coalesce(p_filter, 'all') = 'all'
            or (p_filter = 'superadmin' and r.role = 'superadmin')
            or (p_filter = 'creator' and r.role = 'creator')
            or (p_filter = 'banned' and pr.banned)
            or (p_filter = 'none' and r.role is null))
     order by pr.created_at desc
     limit least(greatest(coalesce(p_limit, 25), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function admin_ban(p_user uuid, p_banned boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_superadmin();
  if p_user = auth.uid() then raise exception 'TIDAK_BISA_DIRI_SENDIRI'; end if;
  update profiles set banned = p_banned where id = p_user;
  perform log_audit(case when p_banned then 'blokir_akun' else 'pulihkan_akun' end,
                    p_user::text, '{}');
end $$;

drop function if exists admin_audit(int);
create or replace function admin_audit(p_limit int default 50, p_offset int default 0,
                                       p_action text default null, p_actor text default null,
                                       p_since timestamptz default null)
returns table (at timestamptz, actor_email text, action text, target text, detail jsonb,
               target_label text, user_label text, total_count bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select a.at, a.actor_email, a.action, a.target, a.detail,
           coalesce((select ev.name from events ev where ev.id::text = a.target),
                    (select pr.name from profiles pr where pr.id::text = a.target),
                    a.detail->>'name', a.target),
           (select pr.name from profiles pr where pr.id::text = a.detail->>'user'),
           count(*) over ()
      from audit_log a
     where (p_action is null or p_action = '' or a.action = p_action)
       and (p_actor is null or p_actor = '' or a.actor_email ilike '%' || p_actor || '%')
       and (p_since is null or a.at >= p_since)
     order by a.at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- Acara yang sudah lewat tanggal hapus (cadangan jika jadwal otomatis belum dipasang)
create or replace function admin_overdue_events()
returns table (event_id uuid, name text, purge_at timestamptz, cover_path text, photos int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select e.id, e.name, e.purge_at, e.cover_path,
           (select count(*)::int from photos p where p.event_id = e.id)
      from events e where e.purge_at <= now()
     order by e.purge_at;
end $$;

-- ---------- Catatan kegagalan kamera --------------------------------

create or replace function log_client_error(p_event uuid, p_kind text, p_detail text, p_ua text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  -- Paling banyak 20 catatan per akun per jam
  if (select count(*) from client_errors
       where user_id = auth.uid() and at > now() - interval '1 hour') >= 20 then
    return;
  end if;
  insert into client_errors (user_id, event_id, kind, detail, ua)
  values (auth.uid(),
          (select id from events where id = p_event),
          left(coalesce(nullif(trim(p_kind), ''), 'lain'), 40),
          left(p_detail, 2000), left(p_ua, 400));
  delete from client_errors where at < now() - interval '30 days';
end $$;

create or replace function admin_client_errors(p_limit int default 50)
returns table (at timestamptz, kind text, detail text, ua text, user_name text, event_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select c.at, c.kind, c.detail, c.ua, pr.name, e.name
      from client_errors c
      left join profiles pr on pr.id = c.user_id
      left join events e on e.id = c.event_id
     order by c.at desc
     limit least(greatest(p_limit, 1), 500);
end $$;

-- ---------- Fase 2: statistik acara dan dashboard -------------------

-- Ringkasan satu acara untuk kartu status di Panel (pemilik/superadmin)
create or replace function event_stats(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  return (select jsonb_build_object(
      'members',      (select count(*) from event_members m where m.event_id = e.id),
      'max_members',  e.max_members,
      'shooters',     (select count(*) from event_members m where m.event_id = e.id and m.shots_used > 0),
      'rolls_done',   (select count(*) from event_members m where m.event_id = e.id and m.shots_used >= e.max_shots),
      'photos',       (select count(*) from photos p where p.event_id = e.id and p.status = 'ready'),
      'pending',      (select count(*) from photos p where p.event_id = e.id and p.status = 'pending'),
      'downloaders',  (select count(distinct d.user_id) from downloads d where d.event_id = e.id),
      'last_photo_at', (select max(p.taken_at) from photos p where p.event_id = e.id and p.status = 'ready'))
    from events e where e.id = p_event);
end $$;

-- Progres album untuk peserta: gulungan sendiri dan berapa tamu yang filmnya sudah habis
create or replace function album_progress(p_event uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
      'members',    (select count(*) from event_members m where m.event_id = e.id),
      'rolls_done', (select count(*) from event_members m where m.event_id = e.id and m.shots_used >= e.max_shots),
      'my_used',    (select m.shots_used from event_members m where m.event_id = e.id and m.user_id = auth.uid()),
      'max_shots',  e.max_shots)
    from events e
   where e.id = p_event
     and (e.owner_id = auth.uid() or is_superadmin()
          or exists (select 1 from event_members m where m.event_id = e.id and m.user_id = auth.uid()));
$$;

-- Acara yang sedang berlangsung: terbuka dan ada foto dalam 6 jam terakhir
create or replace function admin_live_events()
returns table (event_id uuid, name text, owner_name text, members int, rolls_done int,
               photos_hour int, last_photo_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select e.id, e.name, pr.name,
           (select count(*)::int from event_members m where m.event_id = e.id),
           (select count(*)::int from event_members m where m.event_id = e.id and m.shots_used >= e.max_shots),
           (select count(*)::int from photos p where p.event_id = e.id and p.status = 'ready'
              and p.taken_at > now() - interval '1 hour'),
           (select max(p.taken_at) from photos p where p.event_id = e.id and p.status = 'ready')
      from events e join profiles pr on pr.id = e.owner_id
     where open_now(e)
       and exists (select 1 from photos p where p.event_id = e.id and p.taken_at > now() - interval '6 hours')
     order by 7 desc nulls last
     limit 10;
end $$;

-- ---------- Fase 3: moderasi, tren, mode layar ----------------------

-- Peserta melaporkan foto yang bisa dilihatnya. Satu laporan per orang per foto.
-- Tiga pelapor berbeda: foto disembunyikan otomatis sampai ditinjau.
create or replace function report_photo(p_photo uuid, p_reason text, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_event uuid; v_n int;
begin
  perform assert_not_banned();
  select event_id into v_event from photos where id = p_photo;
  if v_event is null or not exists (select 1 from visible_photos(v_event) v where v.id = p_photo) then
    raise exception 'FOTO_TIDAK_ADA';
  end if;
  if p_reason is null or p_reason not in ('tidak_pantas', 'privasi', 'lainnya') then
    raise exception 'ALASAN_TIDAK_VALID';
  end if;
  insert into photo_reports (photo_id, event_id, reporter_id, reason, note)
  values (p_photo, v_event, auth.uid(), p_reason, nullif(left(trim(coalesce(p_note, '')), 300), ''))
  on conflict (photo_id, reporter_id) do nothing;
  select count(*) into v_n from photo_reports where photo_id = p_photo and resolved_at is null;
  if v_n >= 3 then update photos set hidden = true where id = p_photo and not hidden; end if;
end $$;

-- Laporan yang belum ditinjau, dikelompokkan per foto.
-- p_event NULL = semua acara (superadmin); diisi = satu acara (pengelola acara).
create or replace function list_reports(p_event uuid default null)
returns table (photo_id uuid, event_id uuid, event_name text, thumb_path text, medium_path text,
               uploader_id uuid, uploader_name text, hidden boolean, reports int,
               reasons text[], notes text[], last_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if p_event is null then perform assert_superadmin(); else perform assert_owner(p_event); end if;
  return query
    select p.id, e.id, e.name, p.thumb_path, coalesce(p.medium_path, p.file_path),
           p.user_id, pr.name, p.hidden, count(*)::int,
           array_agg(distinct r.reason), array_remove(array_agg(r.note), null), max(r.at)
      from photo_reports r
      join photos p    on p.id = r.photo_id
      join events e    on e.id = r.event_id
      join profiles pr on pr.id = p.user_id
     where r.resolved_at is null and (p_event is null or r.event_id = p_event)
     group by p.id, e.id, pr.id
     order by max(r.at) desc
     limit 200;
end $$;

-- Tindak laporan satu foto: hide = sembunyikan, block = sembunyikan + blokir pemotret
-- dari acara, dismiss = laporan tidak terbukti (foto ditampilkan lagi).
create or replace function resolve_reports(p_photo uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare v_event uuid; v_user uuid;
begin
  select event_id, user_id into v_event, v_user from photos where id = p_photo;
  if v_event is null then raise exception 'FOTO_TIDAK_ADA'; end if;
  perform assert_owner(v_event);
  if p_action is null or p_action not in ('hide', 'block', 'dismiss') then
    raise exception 'AKSI_TIDAK_VALID';
  end if;
  update photos set hidden = (p_action <> 'dismiss') where id = p_photo;
  if p_action = 'block' and v_user <> auth.uid() then
    update event_members set blocked = true where event_id = v_event and user_id = v_user;
  end if;
  update photo_reports set resolved_at = now(), resolved_by = auth.uid(), resolution = p_action
   where photo_id = p_photo and resolved_at is null;
  perform log_audit('moderasi', v_event::text,
                    jsonb_build_object('photo', p_photo, 'action', p_action, 'user', v_user));
end $$;

-- Tren harian (zona WIB) dari data yang masih tersimpan, 7–90 hari terakhir
create or replace function admin_trends(p_days int default 30)
returns table (day date, photos int, users int, events int, active_events int, bytes bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_today date := (now() at time zone 'Asia/Jakarta')::date;
begin
  perform assert_superadmin();
  return query
    with d as (
      select g::date as dd
        from generate_series(v_today - (least(greatest(coalesce(p_days, 30), 7), 90) - 1), v_today,
                             interval '1 day') g),
    ph as (
      select (p.taken_at at time zone 'Asia/Jakarta')::date as dd, count(*)::int as n,
             count(distinct p.event_id)::int as ev
        from photos p where p.status = 'ready' group by 1),
    us as (select (pr.created_at at time zone 'Asia/Jakarta')::date as dd, count(*)::int as n
             from profiles pr group by 1),
    ev as (select (e.created_at at time zone 'Asia/Jakarta')::date as dd, count(*)::int as n
             from events e group by 1),
    st as (select (o.created_at at time zone 'Asia/Jakarta')::date as dd,
                  sum(o.size)::bigint as b
             from stored_objects o group by 1)
    select d.dd, coalesce(ph.n, 0), coalesce(us.n, 0), coalesce(ev.n, 0), coalesce(ph.ev, 0),
           coalesce(st.b, 0)::bigint
      from d
      left join ph on ph.dd = d.dd
      left join us on us.dd = d.dd
      left join ev on ev.dd = d.dd
      left join st on st.dd = d.dd
     order by d.dd;
end $$;

-- Mode layar (proyektor): foto yang sudah terbuka untuk tamu dan tidak disembunyikan.
-- Hanya pengelola acara yang membuka layar ini.
create or replace function slideshow_photos(p_event uuid, p_limit int default 300)
returns table (photo_id uuid, medium_path text, taken_at timestamptz, owner_name text, film text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_owner(p_event);
  return query
    select p.id, coalesce(p.medium_path, p.file_path), p.taken_at,
           case when e.hide_names then null else pr.name end, p.film
      from photos p
      join events e        on e.id = p.event_id
      join event_members m on m.event_id = p.event_id and m.user_id = p.user_id
      join profiles pr     on pr.id = p.user_id
     where p.event_id = p_event and p.status = 'ready' and not p.hidden
       and case when e.reveal_at is not null then now() >= e.reveal_at
                else m.shots_used >= e.max_shots or not open_now(e) end
     order by p.taken_at desc
     limit least(greatest(coalesce(p_limit, 300), 1), 500);
end $$;

-- ---------- Fase 4: R2, notifikasi, buku tamu, data pribadi --------

-- R2: file yang boleh dibaca / dihapus pemanggil (dipanggil Worker dengan JWT pengguna)
create or replace function r2_viewable(p_paths text[]) returns setof text
language sql stable security definer set search_path = public as $$
  select x from unnest(p_paths[1:200]) x where can_view(x) or owns_path(x);
$$;
create or replace function r2_deletable(p_paths text[]) returns setof text
language sql stable security definer set search_path = public as $$
  select x from unnest(p_paths[1:500]) x where owns_path(x);
$$;

-- R2 (service role): foto yang masih di Supabase Storage dan belum ada di R2, untuk dipindah
create or replace function r2_migration_batch(p_limit int default 20)
returns table (name text, size bigint, remaining bigint)
language sql stable security definer set search_path = public as $$
  select o.name, coalesce((o.metadata->>'size')::bigint, 0), count(*) over ()
    from storage.objects o
   where o.bucket_id = 'photos'
     and not exists (select 1 from r2_objects r where r.name = o.name)
   order by o.name
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- Langganan notifikasi browser milik pemanggil
create or replace function save_push(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_not_banned();
  if p_endpoint !~ '^https://' then raise exception 'LANGGANAN_TIDAK_VALID'; end if;
  insert into push_subscriptions (endpoint, user_id, p256dh, auth, ua)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_ua, 300))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
                                       auth = excluded.auth, ua = excluded.ua;
  -- Paling banyak 10 perangkat per akun
  delete from push_subscriptions where endpoint in (
    select endpoint from push_subscriptions where user_id = auth.uid()
     order by created_at desc offset 10);
end $$;

-- Minta / batalkan kabar saat album acara terbuka penuh. Mengembalikan keadaan baru.
create or replace function watch_album(p_event uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from event_members where event_id = p_event and user_id = auth.uid() and not blocked)
     and not can_manage(p_event) then
    raise exception 'BUKAN_PESERTA';
  end if;
  if p_on then
    insert into album_watch (event_id, user_id) values (p_event, auth.uid()) on conflict do nothing;
  else
    delete from album_watch where event_id = p_event and user_id = auth.uid();
  end if;
  return p_on;
end $$;

create or replace function my_album_watch(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from album_watch where event_id = p_event and user_id = auth.uid());
$$;

-- Untuk Edge Function notify-album (service role): kabar yang jatuh tempo.
-- Album dianggap terbuka penuh saat acara tertutup (sakelar / jadwal) atau waktu cuci film lewat.
create or replace function due_album_notifications()
returns table (event_id uuid, event_name text, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select e.id, e.name, s.endpoint, s.p256dh, s.auth
    from events e
    join album_watch w on w.event_id = e.id
    join push_subscriptions s on s.user_id = w.user_id
   where e.album_notified_at is null
     and (not open_now(e) or (e.reveal_at is not null and now() >= e.reveal_at));
$$;
create or replace function mark_album_notified(p_events uuid[]) returns void
language sql security definer set search_path = public as $$
  update events set album_notified_at = now() where id = any(p_events);
$$;
create or replace function drop_push(p_endpoints text[]) returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = any(p_endpoints);
$$;

-- Buku tamu: tulis ucapan (maks. 3 per tamu per acara). Bila ada suara, kembalikan
-- path tujuan unggah; ucapan baru tampil setelah confirm_message.
create or replace function add_message(p_event uuid, p_body text, p_audio_ext text default null,
                                       p_audio_secs int default null)
returns table (o_id uuid, o_audio_path text)
language plpgsql security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid(); v_path text; v_body text := nullif(trim(coalesce(p_body, '')), '');
begin
  perform assert_not_banned();
  if not exists (select 1 from event_members where event_id = p_event and user_id = auth.uid() and not blocked)
     and not can_manage(p_event) then
    raise exception 'BUKAN_PESERTA';
  end if;
  if (select count(*) from guestbook where event_id = p_event and user_id = auth.uid()) >= 3 then
    raise exception 'UCAPAN_PENUH';
  end if;
  if p_audio_ext is not null then
    if p_audio_ext not in ('webm', 'm4a', 'ogg', 'mp3', 'aac') then raise exception 'FORMAT_SUARA'; end if;
    v_path := p_event || '/' || v_id || '.' || p_audio_ext;
  end if;
  if v_body is null and v_path is null then raise exception 'UCAPAN_KOSONG'; end if;
  insert into guestbook (id, event_id, user_id, body, audio_path, audio_secs, status)
  values (v_id, p_event, auth.uid(), left(v_body, 500), v_path,
          case when v_path is not null then least(greatest(coalesce(p_audio_secs, 1), 1), 60) end,
          case when v_path is null then 'ready' else 'pending' end);
  return query select v_id, v_path;
end $$;

create or replace function confirm_message(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update guestbook g set status = 'ready'
   where g.id = p_id and g.user_id = auth.uid() and g.status = 'pending'
     and exists (select 1 from storage.objects o where o.bucket_id = 'voices' and o.name = g.audio_path);
  if found or exists (select 1 from guestbook where id = p_id and user_id = auth.uid() and status = 'ready') then
    return;
  end if;
  raise exception 'FILE_BELUM_ADA';
end $$;

-- Ucapan yang terlihat: peserta melihat yang tidak disembunyikan; pengelola melihat semua.
create or replace function list_messages(p_event uuid)
returns table (id uuid, name text, body text, audio_path text, audio_secs int,
               created_at timestamptz, is_mine boolean, hidden boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_manage boolean := can_manage(p_event);
begin
  if not v_manage and not exists (select 1 from event_members m join profiles pr on pr.id = m.user_id
                                   where m.event_id = p_event and m.user_id = auth.uid()
                                     and not m.blocked and not pr.banned) then
    raise exception 'BUKAN_PESERTA';
  end if;
  return query
    select g.id,
           case when e.hide_names and not v_manage and g.user_id <> auth.uid() then null else pr.name end,
           g.body, g.audio_path, g.audio_secs, g.created_at, g.user_id = auth.uid(), g.hidden
      from guestbook g
      join events e    on e.id = g.event_id
      join profiles pr on pr.id = g.user_id
     where g.event_id = p_event and g.status = 'ready' and (v_manage or not g.hidden or g.user_id = auth.uid())
     order by g.created_at desc
     limit 500;
end $$;

create or replace function hide_message(p_id uuid, p_hidden boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_event uuid;
begin
  select event_id into v_event from guestbook where id = p_id;
  perform assert_owner(v_event);
  update guestbook set hidden = p_hidden where id = p_id;
end $$;

-- Hapus ucapan sendiri atau (pengelola) ucapan siapa pun. Mengembalikan path suara untuk dihapus.
create or replace function delete_message(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare g guestbook%rowtype;
begin
  select * into g from guestbook where id = p_id;
  if not found then raise exception 'UCAPAN_TIDAK_ADA'; end if;
  if g.user_id <> auth.uid() then perform assert_owner(g.event_id); end if;
  delete from guestbook where id = p_id;
  return g.audio_path;
end $$;

create or replace function can_upload_voice(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from guestbook g where g.audio_path = p_name
                  and g.user_id = auth.uid() and g.status = 'pending');
$$;
create or replace function can_hear_voice(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from guestbook g
     where g.audio_path = p_name
       and (g.user_id = auth.uid() or can_manage(g.event_id)
            or (not g.hidden and exists (select 1 from event_members m join profiles pr on pr.id = m.user_id
                                          where m.event_id = g.event_id and m.user_id = auth.uid()
                                            and not m.blocked and not pr.banned))));
$$;
-- Hapus file suara: pengelola acara (owns_path) atau pemilik ucapan yang sudah dihapus barisnya
create or replace function can_delete_voice(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select owns_path(p_name)
      or not exists (select 1 from guestbook g where g.audio_path = p_name)
         and exists (select 1 from event_members m where m.event_id::text = split_part(p_name, '/', 1)
                                                     and m.user_id = auth.uid());
$$;

drop policy if exists "suara: unggah" on storage.objects;
drop policy if exists "suara: dengar" on storage.objects;
drop policy if exists "suara: hapus"  on storage.objects;
create policy "suara: unggah" on storage.objects for insert to authenticated
  with check (bucket_id = 'voices' and public.can_upload_voice(name));
create policy "suara: dengar" on storage.objects for select to authenticated
  using (bucket_id = 'voices' and public.can_hear_voice(name));
create policy "suara: hapus" on storage.objects for delete to authenticated
  using (bucket_id = 'voices' and public.can_delete_voice(name));

-- Semua file suara acara (untuk hapus acara)
create or replace function owner_voice_paths(p_event uuid) returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  return query select audio_path from guestbook where event_id = p_event and audio_path is not null;
end $$;

-- ---------- Data pribadi (UU PDP) ----------

create or replace function request_data_deletion(p_kind text, p_event uuid default null, p_note text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if auth.uid() is null then raise exception 'BELUM_LOGIN'; end if;
  if p_kind not in ('photos', 'account') then raise exception 'AKSI_TIDAK_VALID'; end if;
  if p_kind = 'photos' and (p_event is null or not exists (
       select 1 from event_members where event_id = p_event and user_id = auth.uid())) then
    raise exception 'BUKAN_PESERTA';
  end if;
  if exists (select 1 from data_requests where user_id = auth.uid() and status = 'open'
               and kind = p_kind and event_id is not distinct from p_event) then
    raise exception 'PERMINTAAN_SUDAH_ADA';
  end if;
  insert into data_requests (user_id, email, kind, event_id, note)
  values (auth.uid(), lower(auth.jwt()->>'email'), p_kind, case when p_kind = 'photos' then p_event end,
          nullif(left(trim(coalesce(p_note, '')), 500), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function my_data_requests()
returns table (id bigint, kind text, event_name text, status text, created_at timestamptz,
               done_at timestamptz, reply text)
language sql stable security definer set search_path = public as $$
  select r.id, r.kind, e.name, r.status, r.created_at, r.done_at, r.reply
    from data_requests r left join events e on e.id = r.event_id
   where r.user_id = auth.uid()
   order by r.created_at desc;
$$;

create or replace function admin_data_requests(p_status text default 'open')
returns table (id bigint, user_id uuid, user_name text, email text, kind text, event_id uuid,
               event_name text, note text, status text, created_at timestamptz, done_at timestamptz,
               reply text, photos int, owned_events int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select r.id, r.user_id, pr.name, r.email, r.kind, r.event_id, e.name, r.note, r.status,
           r.created_at, r.done_at, r.reply,
           (select count(*)::int from photos p where p.user_id = r.user_id
              and (r.kind = 'account' or p.event_id = r.event_id)),
           (select count(*)::int from events x where x.owner_id = r.user_id)
      from data_requests r
      left join profiles pr on pr.id = r.user_id
      left join events e on e.id = r.event_id
     where coalesce(p_status, 'all') = 'all' or r.status = p_status
     order by r.created_at desc
     limit 200;
end $$;

-- File milik satu permintaan (foto 3 ukuran + suara), dihapus aplikasi sebelum barisnya
create or replace function admin_request_paths(p_request bigint)
returns table (bucket text, path text)
language plpgsql stable security definer set search_path = public as $$
declare r data_requests%rowtype;
begin
  perform assert_superadmin();
  select * into r from data_requests where id = p_request;
  if not found then raise exception 'PERMINTAAN_TIDAK_ADA'; end if;
  return query
    select 'photos'::text, x from photos p,
           unnest(array_remove(array[p.file_path, p.medium_path, p.thumb_path], null)) x
     where p.user_id = r.user_id and (r.kind = 'account' or p.event_id = r.event_id)
    union all
    select 'voices', g.audio_path from guestbook g
     where g.user_id = r.user_id and g.audio_path is not null
       and (r.kind = 'account' or g.event_id = r.event_id);
end $$;

-- Jalankan permintaan: hapus foto (dan ucapan) di acara itu, atau hapus akun seluruhnya.
-- Akun yang masih memiliki acara tidak bisa dihapus sebelum acaranya dihapus.
create or replace function admin_process_request(p_request bigint, p_action text, p_reply text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare r data_requests%rowtype; v_email text;
begin
  perform assert_superadmin();
  select * into r from data_requests where id = p_request for update;
  if not found then raise exception 'PERMINTAAN_TIDAK_ADA'; end if;
  if r.status <> 'open' then raise exception 'PERMINTAAN_SELESAI'; end if;
  if p_action = 'reject' then
    update data_requests set status = 'rejected', done_at = now(), done_by = auth.uid(),
                             reply = nullif(trim(coalesce(p_reply, '')), '') where id = p_request;
  elsif p_action = 'done' then
    if r.kind = 'photos' then
      delete from photos where user_id = r.user_id and event_id = r.event_id;
      delete from guestbook where user_id = r.user_id and event_id = r.event_id;
    else
      if r.user_id = auth.uid() then raise exception 'TIDAK_BISA_DIRI_SENDIRI'; end if;
      if exists (select 1 from events where owner_id = r.user_id) then raise exception 'MASIH_PUNYA_ACARA'; end if;
      select lower(email) into v_email from auth.users where id = r.user_id;
      delete from user_roles where email = v_email;
      delete from auth.users where id = r.user_id;      -- profil dan semua data ikut terhapus (cascade)
    end if;
    update data_requests set status = 'done', done_at = now(), done_by = auth.uid(),
                             reply = nullif(trim(coalesce(p_reply, '')), '') where id = p_request;
  else
    raise exception 'AKSI_TIDAK_VALID';
  end if;
  perform log_audit('permintaan_data', r.user_id::text,
                    jsonb_build_object('kind', r.kind, 'action', p_action, 'event', r.event_id, 'email', r.email));
end $$;

-- ---------- Hak eksekusi --------------------------------------------

revoke execute on all functions in schema public from public, anon;

-- Pembantu internal: hanya dipanggil dari dalam fungsi lain
revoke execute on function
  log_audit(text, text, jsonb), assert_owner(uuid), assert_superadmin(), assert_not_banned(),
  gen_code(), handle_new_user(), visible_photos(uuid), my_verified_email(),
  open_now(events), owner_bytes(uuid),
  due_album_notifications(), mark_album_notified(uuid[]), drop_push(text[]), r2_migration_batch(int)
from authenticated;

grant execute on function
  valid_film(text), is_superadmin(), my_role(), can_create_event(), can_manage(uuid),
  get_settings(), join_event(text), event_preview(text),
  reserve_shot(uuid, uuid, text), confirm_shot(uuid),
  get_album(uuid, timestamptz, int, text, uuid), my_status(uuid), my_events(),
  album_owners(uuid), toggle_favorite(uuid), duplicate_event(uuid),
  report_photo(uuid, text, text), list_reports(uuid), resolve_reports(uuid, text),
  admin_trends(int), slideshow_photos(uuid, int), admin_set_storage_limit(text, int),
  r2_viewable(text[]), r2_deletable(text[]), save_push(text, text, text, text),
  watch_album(uuid, boolean), my_album_watch(uuid),
  add_message(uuid, text, text, int), confirm_message(uuid), list_messages(uuid),
  hide_message(uuid, boolean), delete_message(uuid), owner_voice_paths(uuid),
  can_upload_voice(text), can_hear_voice(text), can_delete_voice(text),
  request_data_deletion(text, uuid, text), my_data_requests(), admin_data_requests(text),
  admin_request_paths(bigint), admin_process_request(bigint, text, text),
  claim_downloads(uuid, uuid[]),
  can_upload(text), can_view(text), owns_path(text),
  create_event(text, int, int, boolean, text), set_event(uuid, jsonb), set_cover(uuid, text),
  get_roll(uuid, uuid), rotate_code(uuid), get_invites(uuid), set_invites(uuid, text[]),
  hide_photo(uuid, boolean), block_member(uuid, uuid, boolean),
  release_pending(uuid, uuid), list_members(uuid), owner_paths(uuid), delete_event(uuid),
  my_event_quota(), admin_set_event_limit(text, int, int),
  admin_overview(), admin_roles(), admin_set_role(text, text), admin_set_settings(jsonb),
  admin_events(text, text, text, int, int), admin_users(text, text, int, int),
  admin_ban(uuid, boolean), admin_audit(int, int, text, text, timestamptz),
  event_stats(uuid), album_progress(uuid), admin_live_events(),
  admin_overdue_events(), admin_client_errors(int), log_client_error(uuid, text, text, text)
to authenticated;

-- Fungsi untuk Edge Function notify-album: hanya service_role
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function due_album_notifications(), mark_album_notified(uuid[]), drop_push(text[]),
      r2_migration_batch(int) to service_role;
  end if;
end $$;

-- =====================================================================
-- Setelah Run berhasil, jadikan email Anda superadmin (sekali saja):
--   insert into user_roles (email, role) values ('email-anda@gmail.com', 'superadmin')
--   on conflict (email) do update set role = 'superadmin';
-- Pembuat acara lain ditambahkan dari Dashboard -> Peran.
-- =====================================================================
