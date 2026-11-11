// Tes SQL: menjalankan schema.sql + v2.sql di Postgres sungguhan (PGlite, WebAssembly)
// dengan tiruan skema auth dan storage milik Supabase.
// Jalankan: npm run test:sql
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb, unique (bucket_id, name));
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
async function shot(who) {
  const r = (await as(who, `select * from reserve_shot($1, gen_random_uuid())`, [ev]))[0];
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

await as("host", `select delete_event($1)`, [ev]);
ok((await db.query(`select count(*)::int n from photos`)).rows[0].n === 0, "delete_event cascades");

// reset then reinstall
await db.exec(read("reset.sql"));
await db.exec(read("schema.sql"));
await db.exec(read("v2.sql"));
console.log("reset + reinstall ran");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
