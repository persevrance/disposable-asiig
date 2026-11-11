-- =====================================================================
-- PEMBERSIH: menghapus semua tabel, fungsi, trigger, dan aturan akses
-- yang dibuat schema.sql dan v2.sql. SEMUA DATA ACARA HILANG.
-- Akun login (auth.users) dan file di bucket tidak disentuh.
-- Pakai hanya jika schema.sql gagal karena "already exists".
-- Setelah ini, jalankan schema.sql lalu v2.sql lagi.
-- =====================================================================

drop trigger if exists on_auth_user_created on auth.users;

drop policy if exists "unggah foto yang dipesan" on storage.objects;
drop policy if exists "baca foto album"          on storage.objects;
drop policy if exists "pemilik hapus foto acara" on storage.objects;
drop policy if exists "sampul: baca pengelola"   on storage.objects;
drop policy if exists "sampul: unggah"           on storage.objects;
drop policy if exists "sampul: hapus"            on storage.objects;

drop table if exists downloads, audit_log, user_roles, app_settings,
  photos, event_members, event_invites, events, event_creators, profiles cascade;

drop function if exists
  handle_new_user(), gen_code(), assert_owner(uuid),
  join_event(text), reserve_shot(uuid, uuid), confirm_shot(uuid),
  visible_photos(uuid), get_album(uuid, timestamptz, int),
  my_status(uuid), my_events(), can_create_event(),
  can_upload(text), can_view(text), owns_path(text), viewable_paths(text[]),
  create_event(text, int, int, boolean),
  create_event(text, int, int, boolean, text),
  set_event(uuid, text, boolean, timestamptz, timestamptz, int, boolean),
  set_event(uuid, jsonb),
  rotate_code(uuid), get_invites(uuid), set_invites(uuid, text[]),
  hide_photo(uuid, boolean), block_member(uuid, uuid, boolean),
  release_pending(uuid, uuid), list_members(uuid), owner_paths(uuid), delete_event(uuid),
  -- v2
  valid_film(text), is_superadmin(), my_role(), can_manage(uuid),
  assert_superadmin(), assert_not_banned(), log_audit(text, text, jsonb), get_settings(),
  event_preview(text), claim_downloads(uuid, uuid[]), set_cover(uuid, text),
  get_roll(uuid, uuid), admin_overview(), admin_roles(), admin_set_role(text, text),
  admin_set_settings(jsonb), admin_events(text), admin_users(text),
  admin_ban(uuid, boolean), admin_audit(int)
cascade;
