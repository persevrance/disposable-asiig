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

alter table user_roles   enable row level security;
alter table app_settings enable row level security;
alter table downloads    enable row level security;
alter table audit_log    enable row level security;
-- Sengaja tanpa aturan baca: semua akses lewat fungsi.

-- ---------- Kolom baru ----------------------------------------------

alter table profiles add column if not exists banned boolean not null default false;

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

-- ---------- Penyimpanan ---------------------------------------------

-- Foto ukuran penuh bisa beberapa MB
update storage.buckets set file_size_limit = 15728640 where id = 'photos';

-- Sampul/kartu undangan: publik (memang untuk dibagikan), nama file acak
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 3145728, array['image/jpeg'])
on conflict (id) do update
  set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];

-- ---------- Pembantu peran ------------------------------------------

create or replace function is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles
                  where email = lower(auth.jwt()->>'email') and role = 'superadmin');
$$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from user_roles where email = lower(auth.jwt()->>'email');
$$;

create or replace function can_create_event() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where email = lower(auth.jwt()->>'email'))
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
create or replace function event_preview(p_code text)
returns table (name text, cover_path text, welcome_text text, is_open boolean, max_shots int)
language sql stable security definer set search_path = public as $$
  select e.name, e.cover_path, e.welcome_text, e.is_open, e.max_shots
    from events e
   where auth.uid() is not null and e.join_code = upper(trim(p_code));
$$;

-- Memesan satu jepretan. Nama file tidak memuat user_id supaya
-- foto dari orang yang sama tidak bisa dikelompokkan dari URL-nya.
drop function if exists reserve_shot(uuid, uuid);
create function reserve_shot(p_event uuid, p_client_shot uuid)
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

  select e.max_shots, e.is_open into v_max, v_open from events e where e.id = p_event;
  if not v_open then raise exception 'ACARA_TUTUP'; end if;
  if v_used >= v_max then raise exception 'FILM_HABIS'; end if;

  select coalesce(max(p.seq), 0) + 1 into v_seq
    from photos p where p.event_id = p_event and p.user_id = v_uid;

  update event_members set shots_used = v_used + 1
   where event_id = p_event and user_id = v_uid;

  return query
    insert into photos (id, event_id, user_id, seq, client_shot_id, file_path, medium_path, thumb_path)
    values (v_id, p_event, v_uid, v_seq, p_client_shot,
            p_event || '/' || v_id || '.jpg',
            p_event || '/' || v_id || '_m.jpg',
            p_event || '/' || v_id || '_t.jpg')
    returning photos.id, photos.seq, photos.file_path, photos.medium_path, photos.thumb_path;
end $$;

create or replace function confirm_shot(p_photo uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update photos p set status = 'ready', taken_at = now()
   where p.id = p_photo and p.user_id = auth.uid() and p.status = 'pending'
     and exists (select 1 from storage.objects o
                  where o.bucket_id = 'photos' and o.name = p.file_path)
     and exists (select 1 from storage.objects o
                  where o.bucket_id = 'photos' and o.name = p.thumb_path)
     and (p.medium_path is null or exists (select 1 from storage.objects o
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
               else m.shots_used >= e.max_shots or not e.is_open
             end
       )
     );
$$;

-- Nama pengunggah (dan nomor urutnya) disembunyikan bila hide_names aktif,
-- kecuali untuk pemilik acara, superadmin, dan foto milik sendiri.
drop function if exists get_album(uuid, timestamptz, int);
create function get_album(p_event uuid, p_before timestamptz default null, p_limit int default 60)
returns table (photo_id uuid, seq int, owner_name text, taken_at timestamptz,
               thumb_path text, medium_path text, hidden boolean,
               is_mine boolean, downloaded boolean)
language sql stable security definer set search_path = public as $$
  with ctx as (select can_manage(p_event) as manage)
  select v.id,
         case when e.hide_names and not ctx.manage and v.user_id <> auth.uid() then null else v.seq end,
         case when e.hide_names and not ctx.manage and v.user_id <> auth.uid() then null else pr.name end,
         v.taken_at, v.thumb_path, coalesce(v.medium_path, v.file_path), v.hidden,
         v.user_id = auth.uid(),
         exists (select 1 from downloads d where d.photo_id = v.id and d.user_id = auth.uid())
    from visible_photos(p_event) v
    join events e    on e.id = v.event_id
    join profiles pr on pr.id = v.user_id
    cross join ctx
   where p_before is null or v.taken_at < p_before
   order by v.taken_at desc
   limit least(greatest(p_limit, 1), 100);
$$;

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
               max_shots_limit int, max_members_limit int, allow_film_choice boolean)
language sql stable security definer set search_path = public as $$
  select e.id, e.name,
         case when can_manage(e.id) then e.join_code end,
         e.max_shots, e.max_members, e.invite_only, e.is_open, e.reveal_at, e.purge_at,
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
         s.max_shots_limit, s.max_members_limit, e.allow_film_choice
    from events e
    cross join app_settings s
    left join event_members m on m.event_id = e.id and m.user_id = auth.uid()
   where e.id = p_event
     and (e.owner_id = auth.uid() or m.user_id is not null or is_superadmin());
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

drop function if exists create_event(text, int, int, boolean);
create or replace function create_event(p_name text, p_max_shots int default 30,
                             p_max_members int default 60,
                             p_invite_only boolean default false,
                             p_film text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_try int := 0; s app_settings%rowtype;
begin
  perform assert_not_banned();
  if not can_create_event() then raise exception 'TIDAK_BOLEH_MEMBUAT'; end if;
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
  perform log_audit('buat_acara', v_id::text, jsonb_build_object('name', trim(p_name)));
  return v_id;
end $$;

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
                    max_members = e.max_members, max_shots = e.max_shots
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
    'events_open',   (select count(*) from events where is_open),
    'photos',        (select count(*) from photos where status = 'ready'),
    'pending',       (select count(*) from photos where status = 'pending'),
    'downloads',     (select count(*) from downloads),
    'photo_bytes',   (select coalesce(sum((metadata->>'size')::bigint), 0)
                        from storage.objects where bucket_id = 'photos'),
    'cover_bytes',   (select coalesce(sum((metadata->>'size')::bigint), 0)
                        from storage.objects where bucket_id = 'covers'));
end $$;

create or replace function admin_roles()
returns table (email text, role text, added_at timestamptz, added_by text, user_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select r.email, r.role, r.added_at, ab.name,
           (select pr.name from auth.users u join profiles pr on pr.id = u.id
             where lower(u.email) = r.email limit 1)
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
  if v_email = lower(auth.jwt()->>'email') then raise exception 'TIDAK_BISA_DIRI_SENDIRI'; end if;
  if v_email not like '%_@_%' then raise exception 'EMAIL_TIDAK_VALID'; end if;
  if p_role is null then
    delete from user_roles where email = v_email;
  else
    insert into user_roles (email, role, added_by) values (v_email, p_role, auth.uid())
    on conflict (email) do update set role = excluded.role, added_by = excluded.added_by,
                                      added_at = now();
  end if;
  perform log_audit('ubah_peran', v_email, jsonb_build_object('role', p_role));
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
    updated_at = now(), updated_by = auth.uid()
  where id;
  perform log_audit('ubah_pengaturan', null, p_patch);
end $$;

-- Superadmin: semua acara. Pembuat acara: hanya acaranya sendiri.
create or replace function admin_events(p_search text default null)
returns table (event_id uuid, name text, owner_name text, owner_email text,
               is_open boolean, max_shots int, film text, hide_names boolean,
               members int, photos int, bytes bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_admin boolean := is_superadmin();
begin
  if not v_admin and not can_create_event() then raise exception 'TIDAK_BOLEH_MEMBUAT'; end if;
  return query
    with sz as (
      select split_part(o.name, '/', 1) as ev, sum((o.metadata->>'size')::bigint) as b
        from storage.objects o where o.bucket_id = 'photos' group by 1)
    select e.id, e.name, pr.name, u.email::text, e.is_open, e.max_shots, e.film, e.hide_names,
           (select count(*)::int from event_members m where m.event_id = e.id),
           (select count(*)::int from photos p where p.event_id = e.id and p.status = 'ready'),
           coalesce(sz.b, 0)::bigint, e.created_at
      from events e
      join profiles pr on pr.id = e.owner_id
      left join auth.users u on u.id = e.owner_id
      left join sz on sz.ev = e.id::text
     where (v_admin or e.owner_id = auth.uid())
       and (p_search is null or p_search = ''
        or e.name ilike '%' || p_search || '%' or pr.name ilike '%' || p_search || '%'
        or u.email ilike '%' || p_search || '%' or e.join_code = upper(trim(p_search)))
     order by e.created_at desc
     limit 200;
end $$;

create or replace function admin_users(p_search text default null)
returns table (user_id uuid, name text, email text, role text, banned boolean,
               events_owned int, events_joined int, photos int,
               last_sign_in_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select pr.id, pr.name, u.email::text, r.role, pr.banned,
           (select count(*)::int from events e where e.owner_id = pr.id),
           (select count(*)::int from event_members m where m.user_id = pr.id),
           (select count(*)::int from photos p where p.user_id = pr.id and p.status = 'ready'),
           u.last_sign_in_at, pr.created_at
      from profiles pr
      join auth.users u on u.id = pr.id
      left join user_roles r on r.email = lower(u.email)
     where p_search is null or p_search = ''
        or pr.name ilike '%' || p_search || '%' or u.email ilike '%' || p_search || '%'
     order by pr.created_at desc
     limit 300;
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

create or replace function admin_audit(p_limit int default 200)
returns table (at timestamptz, actor_email text, action text, target text, detail jsonb)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform assert_superadmin();
  return query
    select a.at, a.actor_email, a.action, a.target, a.detail
      from audit_log a order by a.at desc limit least(greatest(p_limit, 1), 1000);
end $$;

-- ---------- Hak eksekusi --------------------------------------------

revoke execute on all functions in schema public from public, anon;

-- Pembantu internal: hanya dipanggil dari dalam fungsi lain
revoke execute on function
  log_audit(text, text, jsonb), assert_owner(uuid), assert_superadmin(), assert_not_banned(),
  gen_code(), handle_new_user(), visible_photos(uuid)
from authenticated;

grant execute on function
  valid_film(text), is_superadmin(), my_role(), can_create_event(), can_manage(uuid),
  get_settings(), join_event(text), event_preview(text),
  reserve_shot(uuid, uuid), confirm_shot(uuid),
  get_album(uuid, timestamptz, int), my_status(uuid), my_events(),
  claim_downloads(uuid, uuid[]),
  can_upload(text), can_view(text), owns_path(text),
  create_event(text, int, int, boolean, text), set_event(uuid, jsonb), set_cover(uuid, text),
  get_roll(uuid, uuid), rotate_code(uuid), get_invites(uuid), set_invites(uuid, text[]),
  hide_photo(uuid, boolean), block_member(uuid, uuid, boolean),
  release_pending(uuid, uuid), list_members(uuid), owner_paths(uuid), delete_event(uuid),
  admin_overview(), admin_roles(), admin_set_role(text, text), admin_set_settings(jsonb),
  admin_events(text), admin_users(text), admin_ban(uuid, boolean), admin_audit(int)
to authenticated;

-- =====================================================================
-- Setelah Run berhasil, jadikan email Anda superadmin (sekali saja):
--   insert into user_roles (email, role) values ('email-anda@gmail.com', 'superadmin')
--   on conflict (email) do update set role = 'superadmin';
-- Pembuat acara lain ditambahkan dari Dashboard -> Peran.
-- =====================================================================
