// Tes SQL: menjalankan schema.sql + v2.sql di Postgres sungguhan (PGlite, WebAssembly)
// dengan tiruan skema auth dan storage milik Supabase.
// Jalankan: npm run test:sql
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { quote, keepFee, shotsCap } from "../src/price.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => readFileSync(`${root}/supabase/${f}`, "utf8");
const db = new PGlite();

const stub = `
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}', last_sign_in_at timestamptz, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage to authenticated;
grant select, insert, delete on storage.objects to authenticated;
grant execute on all functions in schema auth to authenticated;
`;

const U = {
  admin: ["00000000-0000-0000-0000-00000000000a", "admin@x.id", "Admin"],
  host:  ["00000000-0000-0000-0000-00000000000b", "host@x.id", "Host"],
  c:     ["00000000-0000-0000-0000-00000000000c", "c@x.id", "Cici"],
  d:     ["00000000-0000-0000-0000-00000000000d", "d@x.id", "Dodi"],
  // akun email+password yang BELUM dikonfirmasi, memakai email yang diberi peran
  evil:  ["00000000-0000-0000-0000-0000000000ee", "new@x.id", "Palsu"],
};

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fails++; };

async function as(who, sql, params = []) {
  const [id, email] = U[who];
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
    [id, JSON.stringify({ sub: id, email })]);
  await db.exec("set role authenticated");
  try { return (await db.query(sql, params)).rows; }
  finally { await db.exec("reset role"); }
}
async function expectErr(who, sql, params, code) {
  try { await as(who, sql, params); ok(false, `${code} expected for: ${sql}`); }
  catch (e) { ok(String(e.message).includes(code), `${code} <- ${sql.slice(0, 60)} (${e.message.slice(0, 60)})`); }
}

await db.exec(stub);
await db.exec(read("schema.sql"));
for (const [k, [id, email, name]] of Object.entries(U))
  await db.query(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, $4)`,
    [id, email, { full_name: name }, k === "evil" ? null : new Date().toISOString()]);
// v1 data: creator via event_creators, to test migration
await db.exec(`insert into event_creators (email) values ('HOST@x.id')`);
await db.exec(read("v2.sql"));
await db.exec(read("v2.sql")); // idempotent
console.log("schema + v2 (2x) ran");

ok((await db.query(`select role from user_roles where email='host@x.id'`)).rows[0]?.role === "creator", "event_creators migrated");
await db.exec(`insert into user_roles (email, role) values ('admin@x.id', 'superadmin')`);

ok((await as("admin", `select my_role() r`))[0].r === "superadmin", "my_role superadmin");
ok((await as("host", `select can_create_event() v`))[0].v === true, "host can create");
ok((await as("c", `select can_create_event() v`))[0].v === false, "guest cannot create");
await expectErr("c", `select create_event('x', 3)`, [], "TIDAK_BOLEH_MEMBUAT");
await expectErr("host", `select create_event('x', 101)`, [], "JATAH_MELEBIHI_BATAS");

const ev = (await as("host", `select create_event('Nikahan', 2, 60, false, 'pastel') id`))[0].id;
const code = (await db.query(`select join_code from events where id=$1`, [ev])).rows[0].join_code;
ok((await as("c", `select * from event_preview($1)`, [code]))[0].name === "Nikahan", "event_preview");
await as("c", `select join_event($1)`, [code]);
await as("d", `select join_event($1)`, [code]);

// C shoots 2 (finishes roll), D shoots 1
async function shot(who, film = null) {
  const r = (await as(who, `select * from reserve_shot($1, gen_random_uuid(), $2)`, [ev, film]))[0];
  ok(!r.o_file_path.includes(U[who][0]), "path has no user_id");
  for (const p of [r.o_file_path, r.o_medium_path, r.o_thumb_path])
    await as(who, `insert into storage.objects (bucket_id, name, metadata) values ('photos', $1, '{"size": 1000}')`, [p]);
  await as(who, `select confirm_shot($1)`, [r.o_photo_id]);
  return r;
}
const c1 = await shot("c"); const c2 = await shot("c"); const d1 = await shot("d");
await expectErr("c", `select * from reserve_shot($1, gen_random_uuid())`, [ev], "FILM_HABIS");

let album = await as("d", `select * from get_album($1)`, [ev]);
ok(album.length === 2 && album.every((r) => r.owner_name === "Cici"), "D sees C's 2 photos with name");
ok((await as("c", `select * from get_album($1)`, [ev])).length === 2, "C sees own 2 (D not finished)");
ok((await as("host", `select * from get_album($1)`, [ev])).length === 3, "host sees all");
ok((await as("admin", `select * from get_album($1)`, [ev])).length === 3, "superadmin sees all");

await as("host", `select set_event($1, '{"hide_names": true}')`, [ev]);
album = await as("d", `select * from get_album($1)`, [ev]);
ok(album.every((r) => r.owner_name === null && r.seq === null), "hide_names hides name from D");
ok((await as("host", `select * from get_album($1)`, [ev]))[0].owner_name !== null, "host still sees names");

// storage visibility
const seen = async (who, p) => (await as(who, `select count(*)::int n from storage.objects where name=$1`, [p]))[0].n === 1;
ok(await seen("d", c1.o_medium_path), "D can read C medium");
ok(!(await seen("d", c1.o_file_path)), "D cannot read C full before claim");
ok(await seen("c", c1.o_file_path), "C reads own full");
ok(await seen("host", c1.o_file_path), "host reads full");
ok(await seen("admin", d1.o_file_path), "admin reads full of unrevealed");
ok(!(await seen("c", d1.o_thumb_path)), "C cannot see D unrevealed thumb");

// downloads quota (max_shots = 2): own photos free
await as("host", `select set_event($1, '{"max_shots": 3}')`, [ev]); // now C has 1 left again -> C photos hidden
ok((await as("d", `select * from get_album($1)`, [ev])).length === 0, "raising max_shots re-hides C");
await expectErr("host", `select set_event($1, '{"max_shots": 2}')`, [ev], "JATAH_TIDAK_BOLEH_TURUN");
await as("admin", `select set_event($1, '{"max_shots": 2}')`, [ev]);
await expectErr("admin", `select set_event($1, '{"max_shots": 1}')`, [ev], "JATAH_DI_BAWAH_PEMAKAIAN");
await expectErr("host", `select set_event($1, '{"photo_max_side": 1600}')`, [ev], "BUKAN_SUPERADMIN");
await expectErr("c", `select set_event($1, '{"name": "x"}')`, [ev], "BUKAN_PEMILIK");

const cl = await as("d", `select * from claim_downloads($1, $2)`, [ev, [c1.o_photo_id, c2.o_photo_id]]);
ok(cl.length === 2 && cl[0].file_path, "D claims 2");
ok(await seen("d", c1.o_file_path), "D reads C full after claim");
ok((await as("d", `select downloads_used from my_status($1)`, [ev]))[0].downloads_used === 2, "downloads_used = 2");
// re-claim same: free
ok((await as("d", `select * from claim_downloads($1, $2)`, [ev, [c1.o_photo_id]])).length === 1, "re-claim free");
// D roll: shoot 1 more to finish, then claim own: free
await shot("d");
ok((await as("d", `select * from claim_downloads($1, $2)`, [ev, [d1.o_photo_id]])).length === 1, "own photo free");
ok((await as("d", `select * from get_album($1)`, [ev])).find((r) => r.photo_id === c1.o_photo_id).downloaded, "downloaded flag");
// C claims D's 2 photos -> 2 ok, but quota 2 so third impossible; test overflow with host lowering? use 3 ids
await db.exec(`update events set max_shots = 2`);
const dAll = (await as("c", `select photo_id from get_album($1) where not is_mine`, [ev])).map((r) => r.photo_id);
ok(dAll.length === 2, "C sees D's 2");
await as("c", `select * from claim_downloads($1, $2)`, [ev, [dAll[0]]]);
await db.exec(`update events set max_shots = 1`); // simulate quota 1
await expectErr("c", `select * from claim_downloads($1, $2)`, [ev, [dAll[1]]], "KUOTA_UNDUH_HABIS");
await db.exec(`update events set max_shots = 2`);

// roll, members, status
ok((await as("host", `select * from get_roll($1, $2)`, [ev, U.c[0]])).length === 2, "get_roll");
await expectErr("d", `select * from get_roll($1, $2)`, [ev, U.c[0]], "BUKAN_PEMILIK");
const st = (await as("admin", `select * from my_status($1)`, [ev]))[0];
ok(st && st.can_manage && st.is_admin && !st.is_member && st.film === "pastel" && st.photo_max_side === 2560, "my_status for admin");
ok((await as("d", `select join_code from my_status($1)`, [ev]))[0].join_code === null, "guest no join_code");

// cover
await expectErr("host", `select set_cover($1, 'other/x.jpg')`, [ev], "SAMPUL_SALAH");
await as("host", `insert into storage.objects (bucket_id, name) values ('covers', $1)`, [`${ev}/a.jpg`]);
ok((await as("host", `select set_cover($1, $2) old`, [ev, `${ev}/a.jpg`]))[0].old === null, "set_cover");
await expectErr("c", `insert into storage.objects (bucket_id, name) values ('covers', $1)`, [`${ev}/b.jpg`], "row-level security");

// dashboard events: creator sees own only, guest refused
const ev2 = (await as("admin", `select create_event('Punya admin', 2) id`))[0].id;
ok((await as("admin", `select * from admin_events(null)`)).length === 2, "admin sees all events");
// Fase 2: saring, urut, halaman
ok((await as("admin", `select * from admin_events(null, 'all', 'name', 1, 0)`)).length === 1, "admin_events pagination");
ok(Number((await as("admin", `select total_count from admin_events(null, 'all', 'name', 1, 0)`))[0].total_count) === 2, "admin_events total_count");
ok((await as("admin", `select name from admin_events(null, 'all', 'name')`))[0].name === "Nikahan", "admin_events sort by name");
await expectErr("host", `select * from admin_live_events()`, [], "BUKAN_SUPERADMIN");
const hostEvents = await as("host", `select * from admin_events(null)`);
ok(hostEvents.length === 1 && hostEvents[0].event_id === ev, "creator sees only own events");
await expectErr("c", `select * from admin_events(null)`, [], "TIDAK_BOLEH_MEMBUAT");
await expectErr("host", `select admin_overview()`, [], "BUKAN_SUPERADMIN");
await db.query(`delete from events where id = $1`, [ev2]);

// Fase 2: statistik acara dan progres album
const stats = (await as("host", `select event_stats($1) s`, [ev]))[0].s;
ok(stats.members === 3 && stats.photos === 4 && stats.shooters === 2 && stats.rolls_done === 2 && stats.downloaders === 2, `event_stats ${JSON.stringify(stats)}`);
await expectErr("d", `select event_stats($1)`, [ev], "BUKAN_PEMILIK");
const prog = (await as("d", `select album_progress($1) p`, [ev]))[0].p;
ok(prog.max_shots === 2 && prog.members === 3 && prog.my_used === 2, `album_progress ${JSON.stringify(prog)}`);
ok((await as("evil", `select album_progress($1) p`, [ev]))[0].p === null, "album_progress hidden from non-member");
const evRow = (await as("host", `select * from admin_events(null)`))[0];
ok(evRow.shooters === 2 && evRow.photos === 4 && evRow.rolls_done === 2 && evRow.join_code === code, "admin_events live stats");
ok((await as("admin", `select * from admin_live_events()`)).length === 1, "live events");

// guest film choice
ok((await as("d", `select allow_film_choice v from my_status($1)`, [ev]))[0].v === true, "allow_film_choice default true");
await as("host", `select set_event($1, '{"allow_film_choice": false}')`, [ev]);
ok((await as("d", `select allow_film_choice v from my_status($1)`, [ev]))[0].v === false, "host disables film choice");
await expectErr("c", `select set_event($1, '{"allow_film_choice": true}')`, [ev], "BUKAN_PEMILIK");

// admin
await as("admin", `select admin_set_role('New@X.id', 'creator')`);
ok((await as("admin", `select * from admin_roles()`)).length === 3, "admin_roles");
await expectErr("admin", `select admin_set_role('admin@x.id', null)`, [], "TIDAK_BISA_DIRI_SENDIRI");
await expectErr("host", `select admin_overview()`, [], "BUKAN_SUPERADMIN");
const ov = (await as("admin", `select admin_overview() o`))[0].o;
ok(ov.photos === 4 && ov.photo_bytes === 12000, `admin_overview ${JSON.stringify(ov)}`);
await as("admin", `select admin_set_settings('{"max_shots_limit": 40, "photo_max_side": 1600, "mirror_photo": true}')`);
const s = (await as("c", `select get_settings() s`))[0].s;
ok(s.max_shots_limit === 40 && s.photo_max_side === 1600 && s.mirror_photo === true, "settings saved");
await expectErr("admin", `select admin_set_settings('{"default_film": "kodak"}')`, [], "check constraint");
ok((await as("admin", `select * from admin_events('nikah')`))[0].bytes == 12000, "admin_events");
ok((await as("admin", `select * from admin_users(null)`)).length === 5, "admin_users");
ok((await as("admin", `select * from admin_users(null, 'creator')`)).length === 2, "admin_users filter creator (host + new@x.id)");
ok((await as("admin", `select * from admin_users(null, 'none')`)).length === 2, "admin_users filter none (c, d)");
// T4: email belum terverifikasi tidak mendapat peran walau emailnya terdaftar
ok((await as("evil", `select my_role() r`))[0].r === null, "unverified email gets no role");
ok((await as("evil", `select can_create_event() v`))[0].v === false, "unverified cannot create");
await db.exec(`insert into user_roles (email, role) values ('new@x.id', 'superadmin') on conflict (email) do update set role = 'superadmin'`);
ok((await as("evil", `select is_superadmin() v`))[0].v === false, "unverified is not superadmin");
await expectErr("evil", `select admin_overview()`, [], "BUKAN_SUPERADMIN");
await db.exec(`update user_roles set role = 'creator' where email = 'new@x.id'`);
// DS4: kuota storage
await as("admin", `select admin_set_settings('{"storage_quota_mb": 8192}')`);
ok((await as("admin", `select admin_overview() o`))[0].o.storage_quota_mb === 8192, "storage quota setting");
// T7: catatan kegagalan kamera, dibatasi 20/jam
for (let i = 0; i < 25; i++) await as("c", `select log_client_error($1, 'DENIED', 'detail', 'UA')`, [ev]);
const errs = await as("admin", `select * from admin_client_errors(100)`);
ok(errs.length === 20 && errs[0].event_name === "Nikahan", "client errors rate limited to 20");
ok((await as("admin", `select admin_overview() o`))[0].o.camera_errors_24h === 20, "overview camera errors");
await expectErr("c", `select * from admin_client_errors(10)`, [], "BUKAN_SUPERADMIN");
await expectErr("c", `insert into client_errors (kind) values ('x')`, [], "permission denied");
// T5: acara lewat tanggal hapus
await as("host", `select set_event($1, '{"purge_at": "2020-01-01T00:00:00Z"}')`, [ev]);
const od = await as("admin", `select * from admin_overdue_events()`);
ok(od.length === 1 && od[0].event_id === ev, "overdue events listed");
ok((await as("admin", `select admin_overview() o`))[0].o.overdue_events === 1, "overview overdue count");
await as("host", `select set_event($1, '{"purge_at": null}')`, [ev]);
await as("admin", `select admin_ban($1, true)`, [U.d[0]]);
await expectErr("d", `select join_event($1)`, [code], "AKUN_DIBLOKIR");
ok((await as("d", `select * from get_album($1)`, [ev])).length === 0, "banned sees nothing");
ok((await as("admin", `select * from admin_audit(50)`)).length >= 6, "audit log");
const auditEv = await as("admin", `select * from admin_audit(50, 0, 'buat_acara')`);
ok(auditEv.length >= 1 && auditEv.every((r) => r.action === "buat_acara") && auditEv.some((r) => r.target_label === "Nikahan"), "audit filter + label");
const auditBan = (await as("admin", `select * from admin_audit(5, 0, 'blokir_akun')`))[0];
ok(auditBan && auditBan.target_label === "Dodi", "audit user label");
await expectErr("c", `select log_audit('x', 'y', '{}')`, [], "permission denied");
await expectErr("c", `select * from visible_photos($1)`, [ev], "permission denied");

// Batas acara per pembuat acara
await as("admin", `select admin_set_event_limit('host@x.id', 1, 1)`);
await expectErr("host", `select create_event('Kedua', 2)`, [], "BATAS_ACARA_HABIS");
ok((await as("host", `select my_event_quota() q`))[0].q.limit === 1, "my_event_quota");
await as("admin", `select admin_set_event_limit('host@x.id', null)`);
ok((await as("host", `select my_event_quota() q`))[0].q.limit === null, "event limit removed");
ok((await as("admin", `select create_event('Admin tanpa batas', 2) id`))[0].id, "superadmin ignores limit");

// release_pending returns medium path too
await db.exec(`update events set max_shots = 5`);
await db.exec(`update profiles set banned = false`);
const pend = (await as("c", `select * from reserve_shot($1, gen_random_uuid())`, [ev]))[0];
const rel = await as("host", `select * from release_pending($1, $2)`, [ev, U.c[0]]);
ok(rel.length === 3 && rel.some((r) => r.file_path === pend.o_medium_path), "release_pending paths");

// ---------- Fase 3 ----------
await db.exec(`update events set max_shots = 3`); // C: 2/3, D: 2/3 -> gulungan belum habis
const k1 = await shot("c", "klasik");               // C habis (3/3)
await shot("d", "bukan-film");                      // D habis, film tidak dikenal -> NULL
const filmOf = async (who, id) => (await as(who, `select film from get_album($1) where photo_id = $2`, [ev, id]))[0]?.film;
ok((await filmOf("d", k1.o_photo_id)) === "klasik", "film recorded per photo");
ok((await db.query(`select count(*)::int n from photos where film is null and event_id = $1`, [ev])).rows[0].n >= 1, "unknown film stored as null");

// Favorit dan saringan album
ok((await as("d", `select toggle_favorite($1) v`, [k1.o_photo_id]))[0].v === true, "favorite on");
const favs = await as("d", `select * from get_album($1, null, 60, 'fav')`, [ev]);
ok(favs.length === 1 && favs[0].is_fav, "filter fav");
ok((await as("c", `select count(*)::int n from get_album($1, null, 60, 'fav')`, [ev]))[0].n === 0, "favorites are per user");
ok((await as("d", `select toggle_favorite($1) v`, [k1.o_photo_id]))[0].v === false, "favorite off");
await expectErr("evil", `select toggle_favorite($1)`, [k1.o_photo_id], "FOTO_TIDAK_ADA");
const mine = await as("c", `select * from get_album($1, null, 60, 'mine')`, [ev]);
ok(mine.length === 3 && mine.every((r) => r.is_mine), "filter mine");
ok((await as("d", `select * from album_owners($1)`, [ev])).length === 0, "album_owners empty when names hidden");
ok((await as("d", `select count(*)::int n from get_album($1, null, 60, 'all', $2)`, [ev, U.c[0]]))[0].n === 0, "owner filter blocked when names hidden");
ok((await as("host", `select * from album_owners($1)`, [ev])).length === 2, "album_owners for host");
await as("host", `select set_event($1, '{"hide_names": false}')`, [ev]);
const owners = await as("d", `select * from album_owners($1)`, [ev]);
ok(owners.length === 2 && owners.find((o) => o.name === "Cici").photos === 3, "album_owners for guest");
const onlyC = await as("d", `select * from get_album($1, null, 60, 'all', $2)`, [ev, U.c[0]]);
ok(onlyC.length === 3 && onlyC.every((r) => r.owner_name === "Cici"), "filter per guest");

// Jadwal acara: selesai otomatis, dibuka lagi menghapus jadwal selesai
await db.exec(`update events set max_shots = 4`);   // C dan D bisa memotret lagi
await expectErr("host", `select set_event($1, '{"starts_at": "2030-01-02T00:00:00Z", "ends_at": "2030-01-01T00:00:00Z"}')`, [ev], "JADWAL_TIDAK_VALID");
await as("host", `select set_event($1, '{"starts_at": "2020-01-01T00:00:00Z", "ends_at": "2020-01-01T05:00:00Z"}')`, [ev]);
ok((await as("d", `select is_open from my_status($1)`, [ev]))[0].is_open === false, "ended event reads as closed");
ok((await as("d", `select is_open from my_events() where event_id = $1`, [ev]))[0].is_open === false, "my_events uses schedule");
await expectErr("d", `select * from reserve_shot($1, gen_random_uuid())`, [ev], "ACARA_TUTUP");
ok((await as("c", `select count(*)::int n from get_album($1)`, [ev]))[0].n === 6, "ended event reveals all");
ok((await as("c", `select starts_at from event_preview($1)`, [code]))[0].starts_at !== null, "event_preview has schedule");
ok((await as("admin", `select count(*)::int n from admin_events(null, 'closed')`))[0].n >= 1, "admin_events closed by schedule");
await as("host", `select set_event($1, '{"is_open": true}')`, [ev]);
const reopened = (await as("host", `select is_open, ends_at from my_status($1)`, [ev]))[0];
ok(reopened.is_open === true && reopened.ends_at === null, "reopen clears ends_at");
ok((await as("admin", `select count(*)::int n from admin_events(null, 'all', 'date')`))[0].n >= 1, "admin_events sort by date");
await db.exec(`update events set max_shots = 3`);

// Laporan foto dan moderasi
await expectErr("d", `select report_photo($1, 'jelek')`, [k1.o_photo_id], "ALASAN_TIDAK_VALID");
await as("d", `select report_photo($1, 'privasi', 'wajah saya')`, [k1.o_photo_id]);
await as("d", `select report_photo($1, 'lainnya')`, [k1.o_photo_id]); // laporan kedua dari orang yang sama diabaikan
let reps = await as("host", `select * from list_reports($1)`, [ev]);
ok(reps.length === 1 && reps[0].reports === 1 && reps[0].uploader_name === "Cici" && reps[0].notes[0] === "wajah saya", "list_reports for owner");
await expectErr("c", `select * from list_reports($1)`, [ev], "BUKAN_PEMILIK");
await expectErr("host", `select * from list_reports(null)`, [], "BUKAN_SUPERADMIN");
ok((await as("admin", `select * from list_reports(null)`)).length === 1, "list_reports all for superadmin");
ok((await as("admin", `select admin_overview() o`))[0].o.reports_open === 1, "overview reports_open");
ok((await as("admin", `select count(*)::int n from admin_events(null, 'reported')`))[0].n === 1, "admin_events reported filter");
await as("host", `select report_photo($1, 'tidak_pantas')`, [k1.o_photo_id]);
await as("admin", `select report_photo($1, 'tidak_pantas')`, [k1.o_photo_id]);
ok((await db.query(`select hidden from photos where id = $1`, [k1.o_photo_id])).rows[0].hidden === true, "3 reporters auto-hide");
await expectErr("c", `select resolve_reports($1, 'dismiss')`, [k1.o_photo_id], "BUKAN_PEMILIK");
await as("host", `select resolve_reports($1, 'dismiss')`, [k1.o_photo_id]);
ok((await db.query(`select hidden from photos where id = $1`, [k1.o_photo_id])).rows[0].hidden === false, "dismiss shows photo again");
ok((await as("host", `select * from list_reports($1)`, [ev])).length === 0, "resolved reports leave the list");
await as("d", `select report_photo($1, 'privasi')`, [k1.o_photo_id]);
ok((await as("host", `select * from list_reports($1)`, [ev])).length === 0, "same reporter cannot reopen");
await as("d", `select report_photo($1, 'tidak_pantas')`, [c1.o_photo_id]);
await as("host", `select resolve_reports($1, 'block')`, [c1.o_photo_id]);
const cMember = (await db.query(`select blocked from event_members where event_id = $1 and user_id = $2`, [ev, U.c[0]])).rows[0];
ok(cMember.blocked === true && (await db.query(`select hidden from photos where id = $1`, [c1.o_photo_id])).rows[0].hidden, "block hides photo and blocks uploader");
ok((await as("admin", `select count(*)::int n from admin_audit(50, 0, 'moderasi')`))[0].n === 2, "moderation logged");
await db.query(`update event_members set blocked = false where user_id = $1`, [U.c[0]]);

// Mode layar: hanya foto yang terbuka untuk tamu dan tidak disembunyikan
const slides = await as("host", `select * from slideshow_photos($1)`, [ev]);
ok(slides.length === 5 && !slides.some((r) => r.photo_id === c1.o_photo_id), `slideshow skips hidden photo (${slides.length})`);
await expectErr("c", `select * from slideshow_photos($1)`, [ev], "BUKAN_PEMILIK");

// Duplikat acara
await as("host", `select set_invites($1, array['a@x.id', 'b@x.id'])`, [ev]);
const dup = (await as("host", `select duplicate_event($1) id`, [ev]))[0].id;
const dupRow = (await db.query(`select name, max_shots, hide_names, owner_id from events where id = $1`, [dup])).rows[0];
ok(dupRow.name === "Nikahan (salinan)" && dupRow.max_shots === 3 && dupRow.owner_id === U.host[0], "duplicate_event copies settings");
ok((await db.query(`select count(*)::int n from event_invites where event_id = $1`, [dup])).rows[0].n === 2, "duplicate copies invites");
ok((await db.query(`select count(*)::int n from event_members where event_id = $1`, [dup])).rows[0].n === 1, "duplicate has only owner");
await expectErr("c", `select duplicate_event($1)`, [ev], "BUKAN_PEMILIK");
await db.query(`delete from events where id = $1`, [dup]);

// Kuota storage per pembuat acara dan batas bawaan
await as("admin", `select admin_set_storage_limit('host@x.id', 1)`);
const q = (await as("host", `select my_event_quota() q`))[0].q;
ok(q.storage_limit_mb === 1 && Number(q.storage_bytes) > 0, `my_event_quota storage ${JSON.stringify(q)}`);
await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('photos', $1, '{"size": 2000000}')`, [`${ev}/besar.jpg`]);
await expectErr("host", `select create_event('Ketiga', 2)`, [], "BATAS_STORAGE_HABIS");
ok(Number((await as("admin", `select storage_bytes from admin_users('host')`))[0].storage_bytes) > 2000000, "admin_users storage_bytes");
await as("admin", `select admin_set_storage_limit('host@x.id', null)`);
await expectErr("host", `select admin_set_storage_limit('host@x.id', 5)`, [], "BUKAN_SUPERADMIN");
await as("admin", `select admin_set_settings('{"creator_event_limit": 5, "creator_storage_mb": 2048}')`);
await as("admin", `select admin_set_role('fresh@x.id', 'creator')`);
const fresh = (await as("admin", `select * from admin_roles() where email = 'fresh@x.id'`))[0];
ok(fresh.event_limit === 5 && fresh.storage_limit_mb === 2048, "new creator gets default limits");
await as("admin", `select admin_set_settings('{"creator_event_limit": null}')`);
const s3 = (await as("admin", `select get_settings() s`))[0].s;
ok(s3.creator_event_limit === null && s3.creator_storage_mb === 2048, "settings can clear default limit");

// Tren 30 hari
const tr = await as("admin", `select * from admin_trends(30)`);
ok(tr.length === 30 && tr.reduce((a, r) => a + r.photos, 0) >= 6 && Number(tr[29].bytes) > 0, "admin_trends");
await expectErr("host", `select * from admin_trends(30)`, [], "BUKAN_SUPERADMIN");

// ---------- Fase 4 ----------
// R2: file yang tercatat di r2_objects dianggap ada (confirm_shot) dan ikut dihitung ukurannya
await db.exec(`update events set max_shots = 6`);
const r2shot = (await as("d", `select * from reserve_shot($1, gen_random_uuid())`, [ev]))[0];
await expectErr("d", `select confirm_shot($1)`, [r2shot.o_photo_id], "FILE_BELUM_ADA");
await db.query(`insert into r2_objects (name, size) select unnest($1::text[]), 5000`, [[r2shot.o_file_path, r2shot.o_medium_path, r2shot.o_thumb_path]]);
await as("d", `select confirm_shot($1)`, [r2shot.o_photo_id]);
ok((await db.query(`select status from photos where id = $1`, [r2shot.o_photo_id])).rows[0].status === "ready", "confirm_shot accepts R2 files");
const ov4 = (await as("admin", `select admin_overview() o`))[0].o;
ok(Number(ov4.r2_bytes) === 15000 && ov4.r2_files === 3 && ov4.storage_backend === "supabase", `overview r2 ${ov4.r2_bytes}`);
ok(ov4.r2_quota_mb === 10240 && Number(ov4.voice_bytes) === 0, "overview r2 quota default 10 GB");
await as("admin", `select admin_set_settings('{"r2_quota_mb": 20480}')`);
ok((await as("admin", `select admin_overview() o`))[0].o.r2_quota_mb === 20480, "r2 quota setting");
ok(Number((await as("admin", `select bytes from admin_events('nikah')`))[0].bytes) >= 15000, "admin_events counts R2 bytes");
await expectErr("c", `select * from stored_objects`, [], "permission denied");
await expectErr("c", `select * from r2_objects`, [], "permission denied");
const viewable = (await as("host", `select r2_viewable($1) p`, [[r2shot.o_thumb_path, "lain/x.jpg"]])).map((r) => r.p);
ok(viewable.length === 1 && viewable[0] === r2shot.o_thumb_path, "r2_viewable filters paths");
ok((await as("c", `select r2_viewable($1) p`, [[r2shot.o_thumb_path]])).length === 0, "r2_viewable hides unrevealed photo");
ok((await as("c", `select r2_deletable($1) p`, [[r2shot.o_file_path]])).length === 0, "guest cannot delete");
ok((await as("host", `select r2_deletable($1) p`, [[r2shot.o_file_path]])).length === 1, "owner can delete");
await as("admin", `select admin_set_settings('{"storage_backend": "r2", "vapid_public_key": "BKxyz"}')`);
const s4 = (await as("c", `select get_settings() s`))[0].s;
ok(s4.storage_backend === "r2" && s4.vapid_public_key === "BKxyz", "settings: backend + vapid key");
await expectErr("admin", `select admin_set_settings('{"storage_backend": "s3"}')`, [], "check constraint");
await as("admin", `select admin_set_settings('{"storage_backend": "supabase"}')`);

// Notifikasi album
await expectErr("c", `select save_push('http://x', 'k', 'a')`, [], "LANGGANAN_TIDAK_VALID");
await as("c", `select save_push('https://push.example/c1', 'k', 'a', 'UA')`);
await as("c", `select save_push('https://push.example/c1', 'k2', 'a2')`); // perbarui, bukan ganda
ok((await db.query(`select count(*)::int n from push_subscriptions where user_id = $1`, [U.c[0]])).rows[0].n === 1, "save_push upserts");
ok((await as("c", `select watch_album($1, true) v`, [ev]))[0].v === true && (await as("c", `select my_album_watch($1) v`, [ev]))[0].v, "watch_album");
await expectErr("evil", `select watch_album($1, true)`, [ev], "BUKAN_PESERTA");
await expectErr("c", `select * from due_album_notifications()`, [], "permission denied");
ok((await db.query(`select count(*)::int n from due_album_notifications()`)).rows[0].n === 0, "not due while event open");
await as("host", `select set_event($1, '{"is_open": false}')`, [ev]);
const due = (await db.query(`select * from due_album_notifications()`)).rows;
ok(due.length === 1 && due[0].endpoint === "https://push.example/c1" && due[0].event_name === "Nikahan", "due after event closed");
await db.query(`select mark_album_notified($1)`, [[ev]]);
ok((await db.query(`select count(*)::int n from due_album_notifications()`)).rows[0].n === 0, "notified only once");
await db.query(`select drop_push($1)`, [["https://push.example/c1"]]);
await as("host", `select set_event($1, '{"is_open": true}')`, [ev]);

// Buku tamu
await expectErr("evil", `select * from add_message($1, 'hai')`, [ev], "BUKAN_PESERTA");
await expectErr("c", `select * from add_message($1, '   ')`, [ev], "UCAPAN_KOSONG");
await expectErr("c", `select * from add_message($1, null, 'exe', 5)`, [ev], "FORMAT_SUARA");
const m1 = (await as("c", `select * from add_message($1, 'Selamat ya!')`, [ev]))[0];
ok(m1.o_audio_path === null, "text message needs no upload");
const m2 = (await as("c", `select * from add_message($1, null, 'webm', 12)`, [ev]))[0];
ok(m2.o_audio_path.startsWith(ev + "/") && m2.o_audio_path.endsWith(".webm"), "voice path in event folder");
ok((await as("d", `select count(*)::int n from list_messages($1)`, [ev]))[0].n === 1, "pending voice not listed");
await expectErr("c", `select confirm_message($1)`, [m2.o_id], "FILE_BELUM_ADA");
await expectErr("d", `insert into storage.objects (bucket_id, name) values ('voices', $1)`, [m2.o_audio_path], "row-level security");
await as("c", `insert into storage.objects (bucket_id, name) values ('voices', $1)`, [m2.o_audio_path]);
await as("c", `select confirm_message($1)`, [m2.o_id]);
const msgs = await as("d", `select * from list_messages($1)`, [ev]);
ok(msgs.length === 2 && msgs.some((m) => m.audio_path === m2.o_audio_path && m.audio_secs === 12) && msgs[0].name === "Cici", "messages listed with name");
ok((await as("d", `select count(*)::int n from storage.objects where bucket_id = 'voices' and name = $1`, [m2.o_audio_path]))[0].n === 1, "member can hear voice");
ok((await as("evil", `select count(*)::int n from storage.objects where bucket_id = 'voices' and name = $1`, [m2.o_audio_path]))[0].n === 0, "outsider cannot hear voice");
await as("c", `select * from add_message($1, 'tiga')`, [ev]);
await expectErr("c", `select * from add_message($1, 'empat')`, [ev], "UCAPAN_PENUH");
await expectErr("d", `select hide_message($1, true)`, [m1.o_id], "BUKAN_PEMILIK");
await as("host", `select hide_message($1, true)`, [m1.o_id]);
ok((await as("d", `select count(*)::int n from list_messages($1)`, [ev]))[0].n === 2, "hidden message not shown to guests");
ok((await as("host", `select count(*)::int n from list_messages($1)`, [ev]))[0].n === 3, "manager sees hidden message");
await expectErr("d", `select delete_message($1)`, [m2.o_id], "BUKAN_PEMILIK");
ok((await as("c", `select delete_message($1) p`, [m2.o_id]))[0].p === m2.o_audio_path, "delete own message returns audio path");
ok((await as("c", `select can_delete_voice($1) v`, [m2.o_audio_path]))[0].v === true, "author may delete orphan voice file");
ok((await as("host", `select count(*)::int n from owner_voice_paths($1)`, [ev]))[0].n === 0, "owner_voice_paths");

// Permintaan hapus data
await expectErr("evil", `select request_data_deletion('photos', $1)`, [ev], "BUKAN_PESERTA");
const rq = (await as("d", `select request_data_deletion('photos', $1, 'hapus foto saya') id`, [ev]))[0].id;
await expectErr("d", `select request_data_deletion('photos', $1)`, [ev], "PERMINTAAN_SUDAH_ADA");
ok((await as("d", `select * from my_data_requests()`)).length === 1, "my_data_requests");
await expectErr("host", `select * from admin_data_requests()`, [], "BUKAN_SUPERADMIN");
const reqs = await as("admin", `select * from admin_data_requests()`);
ok(reqs.length === 1 && reqs[0].photos >= 1 && reqs[0].user_name === "Dodi", "admin_data_requests");
const dPaths = await as("admin", `select * from admin_request_paths($1)`, [rq]);
ok(dPaths.length >= 3 && dPaths.every((r) => r.bucket === "photos"), `admin_request_paths (${dPaths.length})`);
await as("admin", `select admin_process_request($1, 'done', 'Sudah dihapus')`, [rq]);
ok((await db.query(`select count(*)::int n from photos where user_id = $1 and event_id = $2`, [U.d[0], ev])).rows[0].n === 0, "photos request deletes user's photos");
await expectErr("admin", `select admin_process_request($1, 'done')`, [rq], "PERMINTAAN_SELESAI");
const rqHost = (await as("host", `select request_data_deletion('account') id`))[0].id;
await expectErr("admin", `select admin_process_request($1, 'done')`, [rqHost], "MASIH_PUNYA_ACARA");
await as("admin", `select admin_process_request($1, 'reject', 'Hapus acara Anda dulu')`, [rqHost]);
const rqC = (await as("c", `select request_data_deletion('account') id`))[0].id;
await as("admin", `select admin_process_request($1, 'done')`, [rqC]);
ok((await db.query(`select count(*)::int n from auth.users where id = $1`, [U.c[0]])).rows[0].n === 0, "account request deletes auth user");
ok((await db.query(`select count(*)::int n from photos where user_id = $1`, [U.c[0]])).rows[0].n === 0, "account deletion cascades photos");
ok((await as("admin", `select count(*)::int n from admin_audit(50, 0, 'permintaan_data')`))[0].n === 3, "data requests logged");

// ---- data beranda/album dan saringan status ----
const myEv = await as("host", `select * from my_events()`);
ok(myEv.length >= 1 && "cover_path" in myEv[0] && typeof myEv[0].photos === "number", "my_events returns cover + photos");
ok(typeof (await as("host", `select album_progress($1) p`, [ev]))[0].p.photos === "number", "album_progress returns photos");
for (const s of ["live", "scheduled", "done"])
  ok(Array.isArray(await as("host", `select * from admin_events(null, $1)`, [s])), `admin_events status ${s}`);

// ---- pengajuan menjadi pembuat acara ----
ok((await db.query(`select normalize_wa('0812-3456 7890') a, normalize_wa('+62 812 3456 7890') b, normalize_wa('12345') c`)).rows
  .every((r) => r.a === "6281234567890" && r.b === "6281234567890" && r.c === null), "normalize_wa");
await expectErr("host", `select request_creator('081234567890', 'Acara')`, [], "SUDAH_PEMBUAT_ACARA");
await expectErr("evil", `select request_creator('081234567890', 'Acara')`, [], "EMAIL_BELUM_TERVERIFIKASI");
await expectErr("d", `select request_creator('12345', 'Wisuda')`, [], "NOMOR_WA_TIDAK_VALID");
await expectErr("d", `select request_creator('081234567890', 'ab')`, [], "NAMA_ACARA_KOSONG");
const cr = (await as("d", `select request_creator('0812 3456 7890', 'Wisuda Angkatan', '2026-12-01', 40, 'tolong') id`))[0].id;
await expectErr("d", `select request_creator('081234567890', 'Lagi')`, [], "PENGAJUAN_SUDAH_ADA");
ok((await as("d", `select * from my_creator_request()`))[0]?.status === "open", "my_creator_request open");
await expectErr("host", `select * from admin_creator_requests()`, [], "BUKAN_SUPERADMIN");
const crs = await as("admin", `select * from admin_creator_requests()`);
ok(crs.length === 1 && crs[0].phone === "6281234567890" && crs[0].user_name === "Dodi", "admin_creator_requests");
ok((await as("admin", `select admin_overview() o`))[0].o.creator_requests_open === 1, "overview counts creator requests");
await expectErr("admin", `select admin_resolve_creator_request($1, false, '')`, [cr], "ALASAN_WAJIB");
await as("admin", `select admin_resolve_creator_request($1, false, 'Lengkapi data acara')`, [cr]);
ok((await as("d", `select * from my_creator_request()`))[0]?.reply === "Lengkapi data acara", "rejection reason visible");
const cr2 = (await as("d", `select request_creator('081234567890', 'Wisuda Angkatan 2026') id`))[0].id;
await as("admin", `select admin_resolve_creator_request($1, true)`, [cr2]);
ok((await as("d", `select can_create_event() v`))[0].v === true, "approved request grants creator");
await expectErr("admin", `select admin_resolve_creator_request($1, true)`, [cr2], "PERMINTAAN_SELESAI");

// ---- Kolase v2: tema kolase per acara ----
await as("host", `select set_event($1, $2)`, [ev, { collage_theme: { ornament: "film", accent: "#D6336C", allowed: ["polos", "film"], logo_optional: true } }]);
let theme = (await as("host", `select collage_theme from my_status($1)`, [ev]))[0].collage_theme;
ok(theme.ornament === "film" && theme.logo_optional === undefined, "collage_theme saved; logo_optional ignored for host");
await as("admin", `select set_event($1, $2)`, [ev, { collage_theme: { ornament: "film", logo_optional: true } }]);
await as("host", `select set_event($1, $2)`, [ev, { collage_theme: { ornament: "konfeti" } }]);
theme = (await as("host", `select collage_theme from my_status($1)`, [ev]))[0].collage_theme;
ok(theme.ornament === "konfeti" && theme.logo_optional === true, "logo_optional kept when host edits theme");
await expectErr("host", `select set_event($1, $2)`, [ev, { collage_theme: { ornament: "pelangi" } }], "TEMA_KOLASE_TIDAK_VALID");
await expectErr("host", `select set_event($1, $2)`, [ev, { collage_theme: { accent: "merah" } }], "TEMA_KOLASE_TIDAK_VALID");
await expectErr("host", `select set_event($1, $2)`, [ev, { collage_theme: { allowed: ["film", "x"] } }], "TEMA_KOLASE_TIDAK_VALID");

// ---- Pengaman kapasitas: status pembuatan acara ----
ok((await as("host", `select creation_state() s`))[0].s.mode === "open", "creation open by default");
await expectErr("host", `select set_creation_mode('closed')`, [], "BUKAN_SUPERADMIN");
await expectErr("admin", `select set_creation_mode('rusak')`, [], "STATUS_TIDAK_DIKENAL");
await expectErr("admin", `select set_creation_mode('closed', 'x', now() - interval '1 hour')`, [], "JADWAL_TIDAK_VALID");
await as("admin", `select set_creation_mode('limited', null, null, 50, 24)`);
ok((await as("host", `select can_create_event(50, 24) v`))[0].v.ok === true, "limited allows small event");
ok((await as("host", `select can_create_event(51, 24) v`))[0].v.code === "PEMBUATAN_DIBATASI", "limited rejects big event");
await expectErr("host", `select create_event('Besar', 30, 200)`, [], "PEMBUATAN_DIBATASI");
const small = (await as("host", `select create_event('Kecil', 24, 40) id`))[0].id;
await expectErr("host", `select set_event($1, $2)`, [small, { max_members: 80 }], "PEMBUATAN_DIBATASI");
await as("host", `select set_event($1, $2)`, [small, { max_members: 50 }]);
ok((await as("admin", `select can_create_event(2000, 100) v`))[0].v.ok === true, "superadmin bypasses limit");
await as("admin", `select set_creation_mode('closed', 'Penuh minggu ini', now() + interval '2 days')`);
const cs = (await as("host", `select creation_state() s`))[0].s;
ok(cs.mode === "closed" && cs.message === "Penuh minggu ini" && cs.reopen_at, "closed state with message");
await expectErr("host", `select create_event('Tutup', 3)`, [], "PEMBUATAN_DITUTUP");
ok((await db.query(`select count(*)::int n from audit_log where action = 'ubah_pembuatan_acara'`)).rows[0].n === 2, "mode changes audited");
await as("host", `select join_creation_waitlist(true)`);
ok((await as("host", `select creation_state() s`))[0].s.waiting === true, "waitlist joined");
await db.query(`insert into push_subscriptions (endpoint, user_id, p256dh, auth) values ('https://push/x', $1, 'k', 'a')`, [U.host[0]]);
ok((await db.query(`select * from due_waitlist_notifications()`)).rows.length === 0, "no waitlist push while closed");
// Jadwal buka lagi lewat: efektif Buka, lalu capacity_tick menyimpannya
await db.exec(`update app_settings set creation_reopen_at = now() - interval '1 minute'`);
ok((await as("host", `select creation_state() s`))[0].s.mode === "open", "reopen_at passed = open");
ok((await db.query(`select * from due_waitlist_notifications()`)).rows.length === 1, "waitlist push due after reopen");
ok((await as("admin", `select capacity_tick() a`))[0].a === "buka", "capacity_tick reopens on schedule");
await db.query(`select mark_waitlist_notified(array[$1::uuid])`, [U.host[0]]);
ok((await db.query(`select count(*)::int n from creation_waitlist`)).rows[0].n === 0, "waitlist cleared after notify");
await expectErr("host", `select capacity_tick()`, [], "BUKAN_SUPERADMIN");

// ---- Meter kapasitas, pengaman otomatis, tinjauan acara besar ----
await as("admin", `select admin_set_settings($1)`, [{ max_members_limit: 2000 }]);
const big = (await as("admin", `select create_event('Konser', 36, 2000) id`))[0].id;
await as("admin", `select set_event($1, $2)`, [big, { starts_at: new Date(Date.now() + 5 * 86400e3).toISOString() }]);
const capa = (await as("admin", `select admin_capacity() c`))[0].c;
const stor = capa.meters.find((m) => m.key === "storage");
ok(capa.scheduled_events === 1 && Number(stor.proj) > Number(stor.used), "scheduled event raises storage projection");
ok(capa.queue.some((q) => q.id === big), "scheduled event in queue");
ok(["worker", "realtime"].every((k) => capa.meters.find((m) => m.key === k)?.estimate === true), "worker and realtime estimate meters");
await expectErr("host", `select admin_capacity()`, [], "BUKAN_SUPERADMIN");
// Anggaran kecil: perkiraan > 95% → tutup otomatis
await as("admin", `select admin_set_settings($1)`, [{ capacity_storage_gb: 10 }]);
ok((await as("admin", `select capacity_tick() a`))[0].a === "tutup", "auto close at 95%");
const ovCap = (await as("admin", `select admin_overview() o`))[0].o;
ok(ovCap.creation_mode === "closed" && ovCap.creation_mode_auto === true, "overview shows auto-closed mode");
await as("admin", `select set_creation_mode('open')`);
await as("admin", `select admin_set_settings($1)`, [{ capacity_auto_close: false }]);
ok((await as("admin", `select capacity_tick() a`))[0].a === "batasi", "auto limit at 85% when auto close off");
await as("admin", `select admin_set_settings($1)`, [{ capacity_storage_gb: 800, capacity_auto_close: true }]);
await as("admin", `select set_creation_mode('open')`);
// Pembuat acara: acara 1.000 tamu masuk Perlu ditinjau
const rev = (await as("host", `select create_event('Wisuda Besar', 10, 1000) id`))[0].id;
ok((await db.query(`select needs_review from events where id = $1`, [rev])).rows[0].needs_review === true, "big event needs review");
ok((await as("admin", `select admin_overview() o`))[0].o.events_review === 1, "overview counts events to review");
const revCode = (await db.query(`select join_code from events where id = $1`, [rev])).rows[0].join_code;
await as("d", `select join_event($1)`, [revCode]);
ok((await as("host", `select needs_review from my_status($1)`, [rev]))[0].needs_review === true, "my_status exposes needs_review");
await expectErr("d", `select * from reserve_shot($1, gen_random_uuid())`, [rev], "ACARA_MENUNGGU_TINJAUAN");
await as("admin", `select review_event($1)`, [rev]);
ok((await as("d", `select * from reserve_shot($1, gen_random_uuid())`, [rev])).length === 1, "shooting allowed after review");
ok((await db.query(`select needs_review, reviewed_at from events where id = $1`, [rev])).rows[0].reviewed_at !== null, "review_event marks reviewed");
for (const id of [small, big, rev]) await as("admin", `select delete_event($1)`, [id]);

// ---- Buat acara v2: tautan khusus, penyelenggara, akses album, kamera ----
await as("host", `select set_event($1, $2)`, [ev, { slug: "Nikahan-Rara", host_name: "Rara & Ilham", event_type: "nikahan", date_stamp: false, allow_gallery: true, allow_front: false }]);
let ms = (await as("host", `select slug, host_name, event_type, date_stamp, allow_gallery, allow_front from my_status($1)`, [ev]))[0];
ok(ms.slug === "nikahan-rara" && ms.host_name === "Rara & Ilham" && ms.event_type === "nikahan" && !ms.date_stamp && ms.allow_gallery && !ms.allow_front, "v2 settings saved");
await expectErr("host", `select set_event($1, $2)`, [ev, { slug: "admin" }], "TAUTAN_TIDAK_VALID");
await expectErr("host", `select set_event($1, $2)`, [ev, { slug: "a b" }], "TAUTAN_TIDAK_VALID");
const evB = (await as("host", `select create_event('Kedua', 3) id`))[0].id;
await expectErr("host", `select set_event($1, $2)`, [evB, { slug: "nikahan-rara" }], "TAUTAN_DIPAKAI");
ok((await as("host", `select slug_available('nikahan-rara') v`))[0].v.reason === "taken", "slug_available taken");
ok((await as("host", `select slug_available('nikahan-rara', $1) v`, [ev]))[0].v.ok === true, "own slug available for same event");
ok((await as("host", `select slug_available('x') v`))[0].v.reason === "invalid", "slug_available invalid");
await db.exec("set role anon");
const viaSlug = (await db.query(`select resolve_slug('NIKAHAN-RARA') c`)).rows[0].c;
await db.exec("reset role");
ok(viaSlug === code, "resolve_slug works without login");
const pv = (await as("d", `select host_name, album_private from event_preview($1)`, [code]))[0];
ok(pv.host_name === "Rara & Ilham" && pv.album_private === false, "event_preview host_name");
const dupV2 = (await as("host", `select duplicate_event($1) id`, [ev]))[0].id;
const dupRow2 = (await db.query(`select slug, host_name, allow_front from events where id = $1`, [dupV2])).rows[0];
ok(dupRow2.slug === null && dupRow2.host_name === "Rara & Ilham" && dupRow2.allow_front === false, "duplicate copies v2 settings, not slug");
// Album hanya penyelenggara: tamu cuma melihat fotonya sendiri (acara 1 jepretan, dua pemotret)
const evP = (await as("host", `select create_event('Pribadi', 1, 10) id`))[0].id;
const codeP = (await db.query(`select join_code from events where id = $1`, [evP])).rows[0].join_code;
await as("d", `select join_event($1)`, [codeP]);
for (const who of ["host", "d"]) {
  const r = (await as(who, `select * from reserve_shot($1, gen_random_uuid())`, [evP]))[0];
  for (const pth of [r.o_file_path, r.o_medium_path, r.o_thumb_path])
    await as(who, `insert into storage.objects (bucket_id, name, metadata) values ('photos', $1, '{"size": 1000}')`, [pth]);
  await as(who, `select confirm_shot($1)`, [r.o_photo_id]);
}
const albumAll = await as("d", `select * from get_album($1)`, [evP]);
await as("host", `select set_event($1, $2)`, [evP, { album_private: true }]);
const albumPriv = await as("d", `select * from get_album($1)`, [evP]);
ok(albumAll.length === 2 && albumPriv.length === 1 && albumPriv[0].is_mine, `album_private hides others (${albumAll.length} -> ${albumPriv.length})`);
ok((await as("host", `select * from get_album($1)`, [evP])).length === 2, "owner still sees everything");
// Foto langsung terlihat tanpa menunggu roll habis (acara 3 jepretan, baru 1 terpakai)
const evI = (await as("host", `select create_event('Langsung', 3, 10) id`))[0].id;
await as("d", `select join_event($1)`, [(await db.query(`select join_code from events where id = $1`, [evI])).rows[0].join_code]);
{
  const r = (await as("d", `select * from reserve_shot($1, gen_random_uuid())`, [evI]))[0];
  for (const pth of [r.o_file_path, r.o_medium_path, r.o_thumb_path])
    await as("d", `insert into storage.objects (bucket_id, name, metadata) values ('photos', $1, '{"size": 1000}')`, [pth]);
  await as("d", `select confirm_shot($1)`, [r.o_photo_id]);
}
ok((await as("d", `select count(*)::int n from get_album($1) where not is_mine`, [evI]))[0].n === 0, "roll belum habis: foto orang lain belum terlihat");
await as("host", `select set_event($1, $2)`, [evI, { show_instantly: true }]);
ok((await as("host", `select show_instantly from my_status($1)`, [evI]))[0].show_instantly === true, "my_status shows show_instantly");
const hostShot = (await as("host", `select * from reserve_shot($1, gen_random_uuid())`, [evI]))[0];
for (const pth of [hostShot.o_file_path, hostShot.o_medium_path, hostShot.o_thumb_path])
  await as("host", `insert into storage.objects (bucket_id, name, metadata) values ('photos', $1, '{"size": 1000}')`, [pth]);
await as("host", `select confirm_shot($1)`, [hostShot.o_photo_id]);
ok((await as("d", `select count(*)::int n from get_album($1) where not is_mine`, [evI]))[0].n === 1, "show_instantly: foto langsung terlihat walau roll belum habis");
await as("host", `select delete_event($1)`, [evI]);
await as("host", `select set_event($1, $2)`, [ev, { slug: null }]);
for (const id of [evB, dupV2, evP]) await as("host", `select delete_event($1)`, [id]);

// ---- Kunci kamera sampai acara mulai ----
const evL = (await as("host", `select create_event('Nanti', 2, 10) id`))[0].id;
const codeL = (await db.query(`select join_code from events where id = $1`, [evL])).rows[0].join_code;
await as("host", `select set_event($1, $2)`, [evL, { starts_at: new Date(Date.now() + 3600e3).toISOString(), lock_until_start: true }]);
await as("d", `select join_event($1)`, [codeL]);
ok((await as("d", `select lock_until_start from event_preview($1)`, [codeL]))[0].lock_until_start === true, "event_preview shows camera lock");
ok((await as("d", `select lock_until_start from my_status($1)`, [evL]))[0].lock_until_start === true, "my_status shows camera lock");
await expectErr("d", `select * from reserve_shot($1, gen_random_uuid())`, [evL], "ACARA_BELUM_MULAI");
await as("host", `select set_event($1, $2)`, [evL, { starts_at: new Date(Date.now() - 60e3).toISOString() }]);
ok((await as("d", `select * from reserve_shot($1, gen_random_uuid())`, [evL])).length === 1, "camera unlocks once event starts");
await as("host", `select set_event($1, $2)`, [evL, { starts_at: new Date(Date.now() + 3600e3).toISOString(), lock_until_start: false }]);
ok((await as("d", `select * from reserve_shot($1, gen_random_uuid())`, [evL])).length === 1, "no lock = shooting before start allowed");
await as("host", `select delete_event($1)`, [evL]);

// ---- Pembayaran: rumus harga (SQL = src/price.js) ----
const cfg = (await as("host", `select price_settings() p`))[0].p;
ok(cfg.payments_enabled === false && cfg.min === 25000, "price_settings defaults");
const SIMS = [[5, 24, 0], [20, 12, 32000], [37, 30, 104000], [50, 24, 99000], [100, 36, 238000], [250, 27, 560000], [3, 100, 25000], [2000, 100, 8800000]];
for (const [g, r, want] of SIMS) {
  const q = (await db.query(`select price_quote_raw($1, $2) q`, [g, r])).rows[0].q;
  const js = quote(cfg, g, r);
  ok(q.total === want && js.total === want && js.volume_discount === Number(q.volume_discount), `harga ${g}×${r} = ${want} (sql ${q.total}, js ${js.total})`);
}
await expectErr("admin", `select admin_set_settings($1)`, [{ price_roll_tiers: [[24, 2000], [12, 1500]] }], "violates check");

// ---- Pembayaran mati: alur lama tidak berubah ----
const freeEv = (await as("host", `select create_event('Gratisan', 24, 300) id`))[0].id;
ok((await db.query(`select pay_status from events where id = $1`, [freeEv])).rows[0].pay_status === "free", "payments off: event free");
await expectErr("host", `select start_order($1)`, [freeEv], "PEMBAYARAN_NONAKTIF");
await as("host", `select delete_event($1)`, [freeEv]);

// ---- Pembayaran aktif: draf, pesanan, webhook ----
await as("admin", `select admin_set_settings($1)`, [{ payments_enabled: true, free_events_per_user: 2 }]);
const draft = (await as("host", `select create_event('Wisuda Lunas', 24, 50) id`))[0].id;
let dr = (await db.query(`select pay_status, join_code from events where id = $1`, [draft])).rows[0];
ok(dr.pay_status === "draft", "paid-size event starts as draft");
await expectErr("d", `select join_event($1)`, [dr.join_code], "ACARA_BELUM_DIBAYAR");
await expectErr("host", `select * from reserve_shot($1, gen_random_uuid())`, [draft], "ACARA_BELUM_DIBAYAR");
const fr1 = (await as("host", `select create_event('Kecil Gratis', 24, 5) id`))[0].id;
ok((await db.query(`select pay_status from events where id = $1`, [fr1])).rows[0].pay_status === "free", "free-size event active");
await expectErr("host", `select create_event('Gratis Kedua', 24, 5)`, [], "BATAS_ACARA_GRATIS");

// Kode promo
await expectErr("host", `select admin_save_promo($1)`, [{ code: "x" }], "BUKAN_SUPERADMIN");
await as("admin", `select admin_save_promo($1)`, [{ code: "perdana", kind: "percent", value: 10, max_discount: 50000, max_uses: 1 }]);
await as("admin", `select admin_save_promo($1)`, [{ code: "KAMPUS25", kind: "amount", value: 25000, email_domain: "kampus.ac.id" }]);
let pq = (await as("host", `select price_quote(50, 24, 'PERDANA') q`))[0].q;
ok(pq.total === 99000 && pq.promo_discount === 9900 && pq.amount === 89100, `price_quote with promo ${pq.amount}`);
pq = (await as("host", `select price_quote(50, 24, 'KAMPUS25') q`))[0].q;
ok(pq.promo_discount === 0 && /PROMO_TIDAK_BERLAKU/.test(pq.promo_error), "domain promo rejected softly");
await expectErr("host", `select start_order($1, null, null, 'KAMPUS25')`, [draft], "PROMO_TIDAK_BERLAKU");
await expectErr("d", `select start_order($1)`, [draft], "BUKAN_PEMILIK");

const o1 = (await as("host", `select start_order($1, null, null, 'perdana') o`, [draft]))[0].o;
ok(o1.kind === "new" && o1.amount === 89100 && o1.status === "pending" && /^JPR-\d{8}-[A-Z0-9]{6}$/.test(o1.id), `start_order ${o1.id} ${o1.amount}`);
const o1b = (await as("host", `select start_order($1, null, null, 'PERDANA') o`, [draft]))[0].o;
ok(o1b.id === o1.id, "same pending order reused");
await db.query(`select set_order_snap($1, 'tok', 'https://pay')`, [o1.id]);
await expectErr("d", `select order_status($1)`, [o1.id], "PESANAN_TIDAK_ADA");
// Webhook: nominal harus cocok; settlement melunasi; ulangan tidak menggandakan
try { await db.query(`select midtrans_notify($1, 'settlement', null, 'qris', 1000)`, [o1.id]); ok(false, "amount mismatch rejected"); }
catch (e) { ok(/NOMINAL_TIDAK_COCOK/.test(e.message), "amount mismatch rejected"); }
ok((await db.query(`select midtrans_notify($1, 'pending', null, 'qris', 89100) s`, [o1.id])).rows[0].s === "pending", "pending keeps order pending");
ok((await db.query(`select midtrans_notify($1, 'settlement', null, 'qris', '89100.00') s`, [o1.id])).rows[0].s === "paid", "settlement pays");
await db.query(`select midtrans_notify($1, 'settlement', null, 'qris', 89100)`, [o1.id]);
dr = (await db.query(`select pay_status, price_basis from events where id = $1`, [draft])).rows[0];
ok(dr.pay_status === "paid" && dr.price_basis === 99000, "event paid, basis = list price before promo");
ok((await db.query(`select used from promo_codes where code = 'PERDANA'`)).rows[0].used === 1, "promo counted once");
ok((await db.query(`select count(*)::int n from audit_log where action = 'bayar_acara'`)).rows[0].n === 1, "payment audited once");
ok((await as("host", `select order_status($1) o`, [o1.id]))[0].o.pay_status === "paid", "order_status shows paid");
ok((await db.query(`select midtrans_notify('JPR-20260101-XXXXXX', 'settlement') s`)).rows[0].s === "tidak_ada", "unknown order ignored");
pq = (await as("host", `select price_quote(50, 24, 'PERDANA') q`))[0].q;
ok(/PROMO_HABIS/.test(pq.promo_error || ""), "promo max_uses reached");
await as("d", `select join_event($1)`, [dr.join_code || (await db.query(`select join_code from events where id = $1`, [draft])).rows[0].join_code]);

// Tambah tamu: bayar selisih; set_event tidak bisa melewati pembayaran
await expectErr("host", `select set_event($1, $2)`, [draft, { max_members: 100 }], "PERLU_PEMBAYARAN");
await expectErr("host", `select start_order($1, 40, 24)`, [draft], "TIDAK_BOLEH_TURUN");
await expectErr("host", `select start_order($1, 50, 24)`, [draft], "TIDAK_ADA_PERUBAHAN");
const up = (await as("host", `select start_order($1, 100, 24) o`, [draft]))[0].o;
ok(up.kind === "upgrade" && up.list_price === 187000 && up.credit === 99000 && up.amount === 88000, `upgrade diff ${up.amount}`);
await db.query(`select midtrans_notify($1, 'settlement', null, 'gopay', 88000)`, [up.id]);
dr = (await db.query(`select max_members, price_basis from events where id = $1`, [draft])).rows[0];
ok(dr.max_members === 100 && dr.price_basis === 187000, "upgrade applied");
ok((await as("host", `select event_orders($1) o`, [draft]))[0].o.length === 2, "event_orders lists both");
// Gagal / kedaluwarsa
const up2 = (await as("host", `select start_order($1, 100, 36) o`, [draft]))[0].o;
ok((await db.query(`select midtrans_notify($1, 'expire', null, null, $2) s`, [up2.id, up2.amount])).rows[0].s === "expired", "expire marks order");
ok((await db.query(`select max_shots from events where id = $1`, [draft])).rows[0].max_shots === 24, "expired order changes nothing");
// Pembuatan ditutup juga menahan pembayaran
await as("admin", `select set_creation_mode('closed', 'Penuh')`);
await expectErr("host", `select start_order($1, 120, 24)`, [draft], "PEMBUATAN_DITUTUP");
await as("admin", `select set_creation_mode('open')`);
// Nominal 0 (draf diperkecil ke ukuran gratis) langsung lunas tanpa Midtrans
const d2 = (await as("admin", `select create_event('Draf Admin', 24, 50) id`))[0].id;
await as("admin", `select admin_set_pay_status($1, 'draft')`, [d2]);
const z = (await as("admin", `select start_order($1, 5, 24) o`, [d2]))[0].o;
ok(z.status === "paid" && z.amount === 0, "zero-amount order paid instantly");
ok((await db.query(`select pay_status from events where id = $1`, [d2])).rows[0].pay_status === "free", "zero list price -> free");
const fin = (await as("admin", `select admin_orders() r`))[0].r;
ok(fin.summary.revenue_total === 89100 + 88000 && fin.rows.length === 4, `admin_orders revenue ${fin.summary.revenue_total}`);
await expectErr("host", `select admin_orders()`, [], "BUKAN_SUPERADMIN");
// Layanan mandiri: akun tanpa peran bisa membuat acara saat pembayaran aktif;
// email pembuat acara mendapat peran setelah lunas (tanpa batas jumlah acara)
U.f = ["00000000-0000-0000-0000-00000000000f", "fani@x.id", "Fani"];
await db.query(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, now())`, [U.f[0], U.f[1], { full_name: "Fani" }]);
ok((await as("f", `select can_create_event() v`))[0].v === true && (await as("f", `select my_role() r`))[0].r === null, "self-serve: no role but can create");
const fEv = (await as("f", `select create_event('Ultah Fani', 24, 30) id`))[0].id;
let fRow = (await db.query(`select pay_status, creator_email from events where id = $1`, [fEv])).rows[0];
ok(fRow.pay_status === "draft" && fRow.creator_email === "fani@x.id", "self-serve event is draft, creator_email = own email");
await expectErr("f", `select set_event($1, $2)`, [fEv, { creator_email: "bukan-email" }], "EMAIL_TIDAK_VALID");
await as("f", `select set_event($1, $2)`, [fEv, { creator_email: " Klien@Kantor.ID " }]);
const fo = (await as("f", `select start_order($1) o`, [fEv]))[0].o;
await db.query(`select midtrans_notify($1, 'settlement', null, 'qris', $2)`, [fo.id, fo.amount]);
const granted = (await db.query(`select role, event_limit from user_roles where email = 'klien@kantor.id'`)).rows[0];
ok(granted?.role === "creator" && granted.event_limit === null, "paid event grants creator role to creator_email");
ok((await db.query(`select count(*)::int n from audit_log where action = 'ubah_peran' and target = 'klien@kantor.id'`)).rows[0].n === 1, "role grant audited");
for (const id of [draft, fr1, d2, fEv]) await as("admin", `select delete_event($1)`, [id]);
ok((await db.query(`select count(*)::int n from orders where event_id is null`)).rows[0].n === 5, "orders kept after event deleted");
// Metode bayar dipilih di layar Pembayaran: disimpan di pesanan, ganti metode = pesanan baru
const dm = (await as("host", `select create_event('Metode', 24, 50) id`))[0].id;
const mq = (await as("host", `select start_order($1, null, null, null, 'QRIS') o`, [dm]))[0].o;
ok(mq.pay_method === "qris" && mq.status === "pending", "order stores pay_method");
ok((await as("host", `select start_order($1, null, null, null, 'qris') o`, [dm]))[0].o.id === mq.id, "same method reuses pending order");
const mv = (await as("host", `select start_order($1, null, null, null, 'va') o`, [dm]))[0].o;
ok(mv.id !== mq.id && mv.pay_method === "va", "other method creates new order");
ok((await db.query(`select status from orders where id = $1`, [mq.id])).rows[0].status === "expired", "previous method order expired");
await expectErr("host", `select start_order($1, null, null, null, 'bitcoin')`, [dm], "METODE_TIDAK_DIKENAL");
await as("admin", `select delete_event($1)`, [dm]);

// ---- Harga v3: masa simpan foto, batas jepretan per rentang harga, Unlimited ----
const kf = async (d) => (await db.query(`select keep_fee($1) f`, [d])).rows[0].f;
const cfgV3 = (await as("host", `select price_settings() p`))[0].p;
for (const [d, want] of [[30, 0], [31, 3000], [45, 45000], [59, 87000], [60, 200000], [90, 200000]]) ok(await kf(d) === want && keepFee(cfgV3, d) === want, `keep_fee ${d} hari = ${want} (sql = js)`);
ok(quote(cfgV3, 1, 1, true).total === 999000 && shotsCap(cfgV3) === (await db.query(`select shots_cap() c`)).rows[0].c, "JS: Unlimited dan batas jepretan sama dengan SQL");
await as("admin", `select admin_set_settings($1)`, [{ max_shots_limit: 20 }]);
ok((await db.query(`select shots_cap() c`)).rows[0].c === 100, "batas jepretan = rentang harga tertinggi saat pembayaran aktif");
await expectErr("host", `select create_event('Simpan 91', 24, 10, false, null, false, 91)`, [], "MASA_SIMPAN_TIDAK_VALID");
// Ukuran gratis + simpan 45 hari = berbayar (draf)
const kEv = (await as("host", `select create_event('Simpan 45', 24, 3, false, null, false, 45) id`))[0].id;
ok((await db.query(`select pay_status, keep_days from events where id = $1`, [kEv])).rows[0].pay_status === "draft", "masa simpan > 30 hari membuat acara gratis jadi draf");
const kq = (await as("host", `select price_quote(3, 24, null, $1, false, 45) q`, [kEv]))[0].q;
ok(kq.total === 0 && kq.keep_fee === 45000 && kq.amount === 45000, `price_quote masa simpan ${kq.amount}`);
const ko = (await as("host", `select start_order($1) o`, [kEv]))[0].o;
ok(ko.amount === 45000 && ko.keep_days === 45 && ko.keep_fee === 45000, "start_order menagih masa simpan");
await as("host", `select set_event($1, $2)`, [kEv, { ends_at: "2026-12-01T10:00:00Z" }]);
await db.query(`select midtrans_notify($1, 'settlement', null, 'qris', 45000)`, [ko.id]);
let kRow = (await db.query(`select pay_status, keep_days, keep_basis, purge_at from events where id = $1`, [kEv])).rows[0];
ok(kRow.pay_status === "paid" && kRow.keep_basis === 45000 && new Date(kRow.purge_at).toISOString() === "2027-01-15T10:00:00.000Z", `lunas: simpan 45 hari, hapus ${new Date(kRow.purge_at).toISOString()}`);
// Rencana hapus tidak bisa melewati masa simpan yang dibayar
await as("host", `select set_event($1, $2)`, [kEv, { purge_at: "2027-06-01T00:00:00Z" }]);
ok(new Date((await db.query(`select purge_at from events where id = $1`, [kEv])).rows[0].purge_at).toISOString() === "2027-01-15T10:00:00.000Z", "rencana hapus dibatasi masa simpan");
await expectErr("host", `select set_event($1, $2)`, [kEv, { keep_days: 60 }], "PERLU_PEMBAYARAN");
// Perpanjang ke 60 hari: bayar selisih 200.000 − 45.000
const ke = (await as("host", `select start_order($1, null, null, null, null, null, 60) o`, [kEv]))[0].o;
ok(ke.kind === "upgrade" && ke.amount === 155000 && ke.keep_fee === 155000, `perpanjang masa simpan ${ke.amount}`);
await db.query(`select midtrans_notify($1, 'settlement', null, 'qris', 155000)`, [ke.id]);
ok((await db.query(`select keep_days, keep_basis from events where id = $1`, [kEv])).rows[0].keep_basis === 200000, "keep_basis jadi 200.000");
// Unlimited: Rp999.000 tanpa diskon dan promo; upgrade = selisih paket
const uq = (await as("host", `select price_quote(1, 1, 'KAMPUS25', null, true) q`))[0].q;
ok(uq.total === 999000 && uq.discount_pct === 0 && uq.promo_error === "PROMO_TIDAK_BERLAKU" && uq.amount === 999000, "Unlimited Rp999.000 tanpa diskon/promo");
const uEv = (await as("host", `select create_event('Konser Bebas', 24, 50) id`))[0].id;
const up0 = (await as("host", `select start_order($1) o`, [uEv]))[0].o;
await db.query(`select midtrans_notify($1, 'settlement', null, 'qris', $2)`, [up0.id, up0.amount]);
await expectErr("host", `select start_order($1, null, null, 'PERDANA', null, true)`, [uEv], "PROMO_TIDAK_BERLAKU");
const uo = (await as("host", `select start_order($1, null, null, null, 'qris', true) o`, [uEv]))[0].o;
ok(uo.unlimited === true && uo.list_price === 999000 && uo.amount === 999000 - up0.list_price, `upgrade ke Unlimited bayar ${uo.amount}`);
await db.query(`select midtrans_notify($1, 'settlement', null, 'qris', $2)`, [uo.id, uo.amount]);
const uRow = (await db.query(`select unlimited, max_members, max_shots, needs_review, join_code from events where id = $1`, [uEv])).rows[0];
ok(uRow.unlimited && uRow.max_members === 5000 && uRow.max_shots === 100 && !uRow.needs_review, "acara jadi Unlimited (tanpa tinjauan otomatis)");
await expectErr("host", `select start_order($1, 50, 24, null, null, false)`, [uEv], "TIDAK_BOLEH_TURUN");
// Unlimited: batas tamu tidak berlaku
const capEv = (await as("admin", `select create_event('Satu Tamu', 2, 1) id`))[0].id;
await as("admin", `select set_event($1, $2)`, [capEv, { unlimited: true, max_members: 1 }]);
await db.query(`update events set max_members = 1 where id = $1`, [capEv]);
await as("d", `select join_event($1)`, [(await db.query(`select join_code from events where id = $1`, [capEv])).rows[0].join_code]);
ok((await db.query(`select count(*)::int n from event_members where event_id = $1`, [capEv])).rows[0].n === 2, "Unlimited: tamu melebihi max_members tetap bisa bergabung");
for (const id of [kEv, uEv, capEv]) await as("admin", `select delete_event($1)`, [id]);
await as("admin", `select admin_set_settings($1)`, [{ max_shots_limit: 100 }]);
await as("admin", `select admin_set_settings($1)`, [{ payments_enabled: false }]);

await as("host", `select delete_event($1)`, [ev]);
ok((await db.query(`select count(*)::int n from photos`)).rows[0].n === 0, "delete_event cascades");

// reset then reinstall
await db.exec(read("reset.sql"));
await db.exec(read("schema.sql"));
await db.exec(read("v2.sql"));
console.log("reset + reinstall ran");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
