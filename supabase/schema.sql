-- =====================================================================
-- TitipPotret — skema lengkap untuk Supabase (Opsi B1, paket P1)
-- Jalankan SEKALI di Supabase: SQL Editor -> New query -> tempel -> Run.
-- Isi: tabel (langkah 2), fungsi server (langkah 3), penyimpanan foto
-- (langkah 4), dan fungsi panel pemilik (langkah 8).
-- =====================================================================

-- ---------- Tabel ----------------------------------------------------

create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

-- Email yang boleh membuat acara (diisi pemilik lewat SQL Editor)
create table event_creators (
  email text primary key
);

create table events (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id),
  name        text not null check (length(name) between 1 and 80),
  join_code   text unique not null,
  max_shots   int  not null default 30 check (max_shots between 1 and 100),
  max_members int  not null default 60 check (max_members between 1 and 5000),
  invite_only boolean not null default false,
  is_open     boolean not null default true,
  reveal_at   timestamptz,   -- NULL = gulungan tampil saat jatahnya habis; diisi = mode cuci film
  purge_at    timestamptz,   -- tanggal rencana hapus
  created_at  timestamptz not null default now()
);

create table event_invites (
  event_id   uuid references events(id) on delete cascade,
  email      text not null,
  invited_at timestamptz not null default now(),
  primary key (event_id, email)
);

create table event_members (
  event_id   uuid references events(id) on delete cascade,
  user_id    uuid references profiles(id) on delete cascade,
  shots_used int  not null default 0,
  blocked    boolean not null default false,
  joined_at  timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table photos (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references events(id) on delete cascade,
  user_id        uuid not null references profiles(id) on delete cascade,
  seq            int  not null check (seq >= 1),
  client_shot_id uuid not null,
  status         text not null default 'pending' check (status in ('pending','ready')),
  file_path      text not null unique,
  thumb_path     text not null unique,
  taken_at       timestamptz not null default now(),
  hidden         boolean not null default false,
  unique (event_id, user_id, seq),
  unique (event_id, user_id, client_shot_id)
);
create index photos_album on photos (event_id, taken_at desc);

-- ---------- Profil otomatis saat login pertama -----------------------

create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',
                           new.raw_user_meta_data->>'name',
                           split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Untuk akun yang sudah login sebelum skema ini dijalankan
insert into profiles (id, name)
select u.id, coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
  from auth.users u
on conflict (id) do nothing;

-- ---------- Kunci semua tabel (tulis-menulis hanya lewat fungsi) -----

alter table profiles       enable row level security;
alter table event_creators enable row level security;
alter table events         enable row level security;
alter table event_invites  enable row level security;
alter table event_members  enable row level security;
alter table photos         enable row level security;

create policy "profil sendiri" on profiles for select to authenticated
  using (id = auth.uid());
create policy "keanggotaan sendiri" on event_members for select to authenticated
  using (user_id = auth.uid());
create policy "acara yang diikuti atau dimiliki" on events for select to authenticated
  using (owner_id = auth.uid() or exists (
    select 1 from event_members m where m.event_id = events.id and m.user_id = auth.uid()));
-- photos, event_invites, event_creators sengaja tanpa aturan baca.

-- ---------- Pembantu ------------------------------------------------

-- Kode undangan 6 karakter tanpa huruf/angka yang mirip (0/O, 1/I)
create function gen_code() returns text
language sql volatile set search_path = public as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                           1 + get_byte(b, i) % 32, 1), '' order by i)
    from (select uuid_send(gen_random_uuid()) as b) r, generate_series(0, 5) i;
$$;

create function assert_owner(p_event uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from events where id = p_event and owner_id = auth.uid()) then
    raise exception 'BUKAN_PEMILIK';
  end if;
end $$;

-- ---------- Langkah 3: fungsi inti -----------------------------------

-- 3a. Masuk acara dengan kode undangan
create function join_event(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_ev  events%rowtype;
begin
  if v_uid is null then raise exception 'BELUM_LOGIN'; end if;

  select * into v_ev from events where join_code = upper(trim(p_code));
  if not found then raise exception 'KODE_SALAH'; end if;

  if exists (select 1 from event_members
             where event_id = v_ev.id and user_id = v_uid) then
    return v_ev.id;                                     -- sudah anggota
  end if;

  if v_ev.owner_id <> v_uid then
    if v_ev.invite_only and not exists (
         select 1 from event_invites
         where event_id = v_ev.id and lower(email) = lower(auth.jwt()->>'email')) then
      raise exception 'TIDAK_DIUNDANG';
    end if;

    perform 1 from events where id = v_ev.id for update; -- antre agar kuota peserta tepat
    if (select count(*) from event_members where event_id = v_ev.id) >= v_ev.max_members then
      raise exception 'ACARA_PENUH';
    end if;
  end if;

  insert into event_members (event_id, user_id) values (v_ev.id, v_uid);
  return v_ev.id;
end $$;

-- 3b. Memesan satu potretan (penjaga jatah).
-- Pengecekan id lama dilakukan sebelum cek acara tutup, supaya kiriman ulang
-- foto yang sudah dipesan tetap bisa selesai walaupun acara baru ditutup.
create function reserve_shot(p_event uuid, p_client_shot uuid)
returns table (o_photo_id uuid, o_seq int, o_file_path text, o_thumb_path text)
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
     for update;                                        -- kunci baris: antre satu per satu
  if not found then raise exception 'BUKAN_PESERTA'; end if;

  return query                                          -- panggilan ulang: kembalikan yang lama
    select p.id, p.seq, p.file_path, p.thumb_path from photos p
     where p.event_id = p_event and p.user_id = v_uid and p.client_shot_id = p_client_shot;
  if found then return; end if;

  if v_blocked then raise exception 'BUKAN_PESERTA'; end if;

  select e.max_shots, e.is_open into v_max, v_open from events e where e.id = p_event;
  if not v_open then raise exception 'ACARA_TUTUP'; end if;
  if v_used >= v_max then raise exception 'FILM_HABIS'; end if;

  select coalesce(max(p.seq), 0) + 1 into v_seq
    from photos p where p.event_id = p_event and p.user_id = v_uid;

  update event_members set shots_used = v_used + 1
   where event_id = p_event and user_id = v_uid;

  return query
    insert into photos (id, event_id, user_id, seq, client_shot_id, file_path, thumb_path)
    values (v_id, p_event, v_uid, v_seq, p_client_shot,
            p_event || '/' || v_uid || '/' || v_id || '.jpg',
            p_event || '/' || v_uid || '/' || v_id || '_t.jpg')
    returning photos.id, photos.seq, photos.file_path, photos.thumb_path;
end $$;

-- 3c. Konfirmasi setelah kedua file terunggah (P1: file harus ada di Storage)
create function confirm_shot(p_photo uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update photos p set status = 'ready', taken_at = now()
   where p.id = p_photo and p.user_id = auth.uid() and p.status = 'pending'
     and exists (select 1 from storage.objects o
                  where o.bucket_id = 'photos' and o.name = p.file_path)
     and exists (select 1 from storage.objects o
                  where o.bucket_id = 'photos' and o.name = p.thumb_path);
  if found then return; end if;
  if exists (select 1 from photos where id = p_photo and user_id = auth.uid()
               and status = 'ready') then
    return;                                             -- sudah dikonfirmasi sebelumnya
  end if;
  raise exception 'FILE_BELUM_ADA';
end $$;

-- 3d. Album: hanya gulungan yang sudah habis (atau mode cuci film)
create function visible_photos(p_event uuid) returns setof photos
language sql stable security definer set search_path = public as $$
  select p.*
    from photos p
    join events e        on e.id = p.event_id
    join event_members m on m.event_id = p.event_id and m.user_id = p.user_id
   where p.event_id = p_event
     and p.status = 'ready'
     and (
       e.owner_id = auth.uid()                           -- pemilik melihat semua (moderasi)
       or (
         not p.hidden
         and exists (select 1 from event_members me
                      where me.event_id = p_event and me.user_id = auth.uid()
                        and not me.blocked)
         and case
               when e.reveal_at is not null then now() >= e.reveal_at   -- mode cuci film
               else m.shots_used >= e.max_shots or not e.is_open        -- gulungan habis
             end
       )
     );
$$;

create function get_album(p_event uuid, p_before timestamptz default null, p_limit int default 60)
returns table (photo_id uuid, seq int, owner_name text, taken_at timestamptz,
               thumb_path text, file_path text, hidden boolean)
language sql stable security definer set search_path = public as $$
  select v.id, v.seq, pr.name, v.taken_at, v.thumb_path, v.file_path, v.hidden
    from visible_photos(p_event) v
    join profiles pr on pr.id = v.user_id
   where p_before is null or v.taken_at < p_before
   order by v.taken_at desc
   limit least(greatest(p_limit, 1), 100);
$$;

-- Status pemanggil di satu acara (penghitung jatah, peran)
create function my_status(p_event uuid)
returns table (event_id uuid, name text, join_code text, max_shots int, max_members int,
               invite_only boolean, is_open boolean, reveal_at timestamptz,
               purge_at timestamptz, is_owner boolean, is_member boolean,
               shots_used int, blocked boolean, pending int)
language sql stable security definer set search_path = public as $$
  select e.id, e.name,
         case when e.owner_id = auth.uid() then e.join_code end,
         e.max_shots, e.max_members, e.invite_only, e.is_open, e.reveal_at, e.purge_at,
         e.owner_id = auth.uid(), m.user_id is not null,
         coalesce(m.shots_used, 0), coalesce(m.blocked, false),
         (select count(*)::int from photos p
           where p.event_id = e.id and p.user_id = auth.uid() and p.status = 'pending')
    from events e
    left join event_members m on m.event_id = e.id and m.user_id = auth.uid()
   where e.id = p_event
     and (e.owner_id = auth.uid() or m.user_id is not null);
$$;

-- Daftar acara milik / yang diikuti pemanggil
create function my_events()
returns table (event_id uuid, name text, is_owner boolean, is_open boolean,
               max_shots int, shots_used int, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.id, e.name, e.owner_id = auth.uid(), e.is_open, e.max_shots,
         coalesce(m.shots_used, 0), e.created_at
    from events e
    left join event_members m on m.event_id = e.id and m.user_id = auth.uid()
   where e.owner_id = auth.uid() or m.user_id is not null
   order by e.created_at desc;
$$;

create function can_create_event() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from event_creators
                  where lower(email) = lower(auth.jwt()->>'email'));
$$;

-- ---------- Langkah 4: penyimpanan foto (Supabase Storage) -----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg'];

-- Boleh unggah hanya ke nama file yang sudah dipesan dan masih pending
create function can_upload(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from photos p
                  where p.user_id = auth.uid() and p.status = 'pending'
                    and (p.file_path = p_name or p.thumb_path = p_name));
$$;

-- Boleh baca hanya foto yang lolos aturan album
create function can_view(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from photos p
                  where (p.file_path = p_name or p.thumb_path = p_name)
                    and p.id in (select v.id from visible_photos(p.event_id) v));
$$;

-- Pemilik acara boleh membaca/menghapus semua file di folder acaranya
create function owns_path(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from events e
                  where e.id::text = split_part(p_name, '/', 1)
                    and e.owner_id = auth.uid());
$$;

create policy "unggah foto yang dipesan" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.can_upload(name));
create policy "baca foto album" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (public.can_view(name) or public.owns_path(name)));
create policy "pemilik hapus foto acara" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.owns_path(name));
-- Tidak ada aturan ubah: peserta tidak bisa menimpa atau menghapus foto.

-- ---------- Langkah 8: panel pemilik ---------------------------------

create function create_event(p_name text, p_max_shots int default 30,
                             p_max_members int default 60,
                             p_invite_only boolean default false)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_try int := 0;
begin
  if not can_create_event() then raise exception 'TIDAK_BOLEH_MEMBUAT'; end if;
  loop
    begin
      insert into events (owner_id, name, join_code, max_shots, max_members, invite_only)
      values (auth.uid(), trim(p_name), gen_code(), p_max_shots, p_max_members, p_invite_only)
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 5 then raise; end if;
    end;
  end loop;
  insert into event_members (event_id, user_id) values (v_id, auth.uid());
  return v_id;
end $$;

create function set_event(p_event uuid, p_name text, p_is_open boolean,
                          p_reveal_at timestamptz, p_purge_at timestamptz,
                          p_max_members int, p_invite_only boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  update events set name = trim(p_name), is_open = p_is_open, reveal_at = p_reveal_at,
                    purge_at = p_purge_at, max_members = p_max_members,
                    invite_only = p_invite_only
   where id = p_event;
end $$;

create function rotate_code(p_event uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_try int := 0;
begin
  perform assert_owner(p_event);
  loop
    begin
      v_code := gen_code();
      update events set join_code = v_code where id = p_event;
      return v_code;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 5 then raise; end if;
    end;
  end loop;
end $$;

create function get_invites(p_event uuid) returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  return query select email from event_invites where event_id = p_event order by email;
end $$;

create function set_invites(p_event uuid, p_emails text[]) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform assert_owner(p_event);
  delete from event_invites where event_id = p_event;
  insert into event_invites (event_id, email)
  select distinct p_event, lower(trim(x)) from unnest(p_emails) x
   where trim(x) like '%_@_%';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create function hide_photo(p_photo uuid, p_hidden boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_event uuid;
begin
  select event_id into v_event from photos where id = p_photo;
  perform assert_owner(v_event);
  update photos set hidden = p_hidden where id = p_photo;
end $$;

create function block_member(p_event uuid, p_user uuid, p_blocked boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  if p_user = auth.uid() then raise exception 'TIDAK_BISA_DIRI_SENDIRI'; end if;
  update event_members set blocked = p_blocked where event_id = p_event and user_id = p_user;
end $$;

-- Hapus potretan pending yang macet dan kembalikan jatahnya.
-- Mengembalikan nama file supaya panel bisa membersihkan sisa unggahan.
create function release_pending(p_event uuid, p_user uuid)
returns table (file_path text)
language plpgsql security definer set search_path = public as $$
declare v_n int; v_paths text[];
begin
  perform assert_owner(p_event);
  perform 1 from event_members where event_id = p_event and user_id = p_user for update;
  with d as (
    delete from photos p
     where p.event_id = p_event and p.user_id = p_user and p.status = 'pending'
    returning p.file_path, p.thumb_path)
  select count(*)::int, coalesce(array_agg(d.file_path) || array_agg(d.thumb_path), '{}')
    into v_n, v_paths from d;
  update event_members set shots_used = greatest(0, shots_used - v_n)
   where event_id = p_event and user_id = p_user;
  return query select unnest(v_paths);
end $$;

create function list_members(p_event uuid)
returns table (user_id uuid, name text, email text, shots_used int, pending int,
               blocked boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  return query
    select m.user_id, pr.name, u.email::text, m.shots_used,
           (select count(*)::int from photos p where p.event_id = p_event
              and p.user_id = m.user_id and p.status = 'pending'),
           m.blocked, m.joined_at
      from event_members m
      join profiles pr on pr.id = m.user_id
      join auth.users u on u.id = m.user_id
     where m.event_id = p_event
     order by m.joined_at;
end $$;

-- Semua nama file acara (untuk unduh album dan hapus acara)
create function owner_paths(p_event uuid)
returns table (photo_id uuid, owner_name text, seq int, status text,
               file_path text, thumb_path text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  return query
    select p.id, pr.name, p.seq, p.status, p.file_path, p.thumb_path
      from photos p join profiles pr on pr.id = p.user_id
     where p.event_id = p_event
     order by pr.name, p.seq;
end $$;

-- Hapus acara beserta seluruh baris terkait (file dihapus panel lebih dulu)
create function delete_event(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_owner(p_event);
  delete from events where id = p_event;
end $$;

-- ---------- Hak eksekusi --------------------------------------------
-- Semua fungsi hanya untuk pengguna yang sudah login.

revoke execute on all functions in schema public from public, anon;
grant execute on function
  join_event(text), reserve_shot(uuid, uuid), confirm_shot(uuid),
  get_album(uuid, timestamptz, int), my_status(uuid), my_events(), can_create_event(),
  can_upload(text), can_view(text), owns_path(text),
  create_event(text, int, int, boolean),
  set_event(uuid, text, boolean, timestamptz, timestamptz, int, boolean),
  rotate_code(uuid), get_invites(uuid), set_invites(uuid, text[]),
  hide_photo(uuid, boolean), block_member(uuid, uuid, boolean),
  release_pending(uuid, uuid), list_members(uuid), owner_paths(uuid), delete_event(uuid)
to authenticated;
-- Fungsi pembantu (visible_photos, assert_owner, gen_code, handle_new_user)
-- tidak diberikan langsung; dipanggil dari dalam fungsi lain.

-- =====================================================================
-- Setelah Run berhasil, daftarkan email Anda sebagai pembuat acara:
--   insert into event_creators (email) values ('email-anda@gmail.com');
-- =====================================================================
