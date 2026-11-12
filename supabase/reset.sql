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
drop policy if exists "suara: unggah"            on storage.objects;
drop policy if exists "suara: dengar"            on storage.objects;
drop policy if exists "suara: hapus"             on storage.objects;

drop view if exists stored_objects;
drop table if exists creator_requests, data_requests, guestbook, album_watch, push_subscriptions, r2_objects,
  photo_reports, favorites, client_errors, downloads, audit_log, user_roles, app_settings,
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
  admin_ban(uuid, boolean), admin_audit(int),
  my_verified_email(), admin_overdue_events(), admin_client_errors(int),
  admin_events(text, text, text, int, int), admin_users(text, text, int, int),
  admin_audit(int, int, text, text, timestamptz), event_stats(uuid), album_progress(uuid),
  admin_live_events(),
  log_client_error(uuid, text, text, text),
  my_event_quota(), admin_set_event_limit(text, int, int),
  -- fase 3
  open_now(events), owner_bytes(uuid), reserve_shot(uuid, uuid, text),
  get_album(uuid, timestamptz, int, text, uuid), album_owners(uuid), toggle_favorite(uuid),
  duplicate_event(uuid), report_photo(uuid, text, text), list_reports(uuid),
  resolve_reports(uuid, text), admin_trends(int), slideshow_photos(uuid, int),
  admin_set_storage_limit(text, int),
  -- fase 4
  r2_viewable(text[]), r2_deletable(text[]), save_push(text, text, text, text),
  watch_album(uuid, boolean), my_album_watch(uuid), due_album_notifications(),
  mark_album_notified(uuid[]), drop_push(text[]), r2_migration_batch(int),
  add_message(uuid, text, text, int), confirm_message(uuid), list_messages(uuid),
  hide_message(uuid, boolean), delete_message(uuid), owner_voice_paths(uuid),
  can_upload_voice(text), can_hear_voice(text), can_delete_voice(text),
  request_data_deletion(text, uuid, text), my_data_requests(), admin_data_requests(text),
  admin_request_paths(bigint), admin_process_request(bigint, text, text),
  -- pengajuan pembuat acara
  normalize_wa(text), my_creator_request(), request_creator(text, text, date, int, text),
  admin_creator_requests(text), admin_resolve_creator_request(bigint, boolean, text)
cascade;
