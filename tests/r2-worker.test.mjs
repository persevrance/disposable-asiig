// Tes rute foto R2 di Worker (worker/index.js) dengan R2 dan Supabase tiruan:
// bundel thumbnail (/api/r2/thumbs) dan URL bertanda tangan yang stabil (/api/r2/sign).
// Jalankan: npm run test:r2
import worker from "../worker/index.js";

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fails++; };

const E = "11111111-1111-1111-1111-111111111111";
const p = (n, suf = "_t") => `${E}/${String(n).padStart(8, "0")}-2222-2222-2222-222222222222${suf}.jpg`;

const files = new Map([[p(1), "AAA"], [p(2), "BBBBB"], [p(3), "C"]]);
const env = {
  SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "sb_secret_x", SIGN_SECRET: "rahasia",
  ASSETS: { fetch: () => new Response("asset") },
  PHOTOS: {
    get: async (k) => (files.has(k) ? {
      httpEtag: `"${k}"`, body: files.get(k),
      arrayBuffer: async () => new TextEncoder().encode(files.get(k)).buffer,
    } : null),
  },
};

// Supabase tiruan: r2_viewable mengizinkan semua kecuali p(2)
let viewableCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith("/rest/v1/rpc/r2_viewable")) {
    viewableCalls++;
    const { p_paths } = JSON.parse(init.body);
    return new Response(JSON.stringify(p_paths.filter((x) => x !== p(2))), { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "unexpected " + url }), { status: 500 });
};

const post = (route, body, auth = "Bearer jwt") => worker.fetch(new Request(`https://jepretin.test/api/r2/${route}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body),
}), env, { waitUntil() {} });

// Sama dengan pembaca bundel di src/storage.js (fetchBundle)
function unbundle(buf) {
  const headLen = new DataView(buf).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLen)));
  const out = {};
  let at = 4 + headLen;
  for (const [path, n] of head) { out[path] = new TextDecoder().decode(new Uint8Array(buf, at, n)); at += n; }
  return out;
}

console.log("bundel thumbnail");
{
  const res = await post("thumbs", { paths: [p(1), p(2), p(3), p(4), p(1), "../rahasia.jpg"] });
  ok(res.status === 200, "status 200");
  const got = unbundle(await res.arrayBuffer());
  ok(got[p(1)] === "AAA" && got[p(3)] === "C", "isi file yang diizinkan utuh dan berurutan");
  ok(!(p(2) in got), "file tanpa izin (r2_viewable) tidak disertakan");
  ok(!(p(4) in got), "file yang tidak ada di R2 dilewati (klien memakai URL biasa)");
  ok(Object.keys(got).length === 2, "path ganda dan path tidak valid dibuang");
  ok(viewableCalls === 1, "satu pemeriksaan izin untuk seluruh bundel");
}
{
  const many = Array.from({ length: 80 }, (_, i) => p(100 + i));
  let asked = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => { asked = JSON.parse(init.body).p_paths.length; return new Response("[]"); };
  await post("thumbs", { paths: many });
  globalThis.fetch = prev;
  ok(asked === 60, "maks. 60 thumbnail per bundel");
}
{
  const res = await post("thumbs", { paths: [p(1)] }, null);
  ok(res.status === 401, "tanpa login ditolak");
}
{
  const res = await post("thumbs", {});
  ok(res.status === 200 && Object.keys(unbundle(await res.arrayBuffer())).length === 0, "permintaan kosong: bundel kosong");
}

console.log("URL stabil");
{
  const a = await (await post("sign", { paths: [p(1)] })).json();
  const b = await (await post("sign", { paths: [p(1)] })).json();
  ok(a[p(1)] && a[p(1)] === b[p(1)], "dua permintaan berturut-turut mendapat URL yang sama");
  const exp = Number(new URL(a[p(1)], "https://x").searchParams.get("e"));
  const left = exp - Date.now() / 1000;
  ok(left >= 3 * 3600 - 5 && left <= 6 * 3600, "berlaku 3–6 jam");
  const res = await worker.fetch(new Request(`https://jepretin.test${a[p(1)]}`), env, { waitUntil() {} });
  ok(res.status === 200 && (await res.text()) === "AAA", "URL bertanda tangan bisa dibuka");
  const bad = await worker.fetch(new Request(`https://jepretin.test${a[p(1)].replace(/s=./, "s=0")}`), env, { waitUntil() {} });
  ok(bad.status === 403, "tanda tangan diubah: ditolak");
}

if (fails) { console.log(`\n${fails} tes gagal`); process.exit(1); }
console.log("\nsemua tes lolos");
