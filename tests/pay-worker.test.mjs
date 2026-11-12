// Tes rute pembayaran Worker (worker/pay.js) dengan Midtrans dan Supabase tiruan.
// Jalankan: npm run test:pay
import { createHash } from "node:crypto";
import worker from "../worker/index.js";

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fails++; };

const env = {
  SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "sb_secret_x",
  MIDTRANS_SERVER_KEY: "Mid-server-API", MIDTRANS_SIGNATURE_KEY: "Mid-server-SIG", MIDTRANS_PRODUCTION: "false",
  ASSETS: { fetch: () => new Response("asset") },
};

// Tiruan fetch: catat panggilan, jawab sesuai URL
let calls = [];
let midtransStatus = { order_id: "JPR-20261112-ABC123", transaction_status: "settlement", payment_type: "qris", gross_amount: "89100.00", status_code: "200" };
let order = { id: "JPR-20261112-ABC123", event_id: "e1", kind: "new", guests: 50, shots: 24, amount: 89100, status: "pending", snap_token: null, window_min: 15, production: false, user_id: "secret" };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url, init, body });
  const j = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/rest/v1/rpc/start_order")) return j(order);
  if (url.endsWith("/rest/v1/rpc/order_status")) return j(order);
  if (url.endsWith("/rest/v1/rpc/set_order_snap")) return j(null);
  if (url.endsWith("/rest/v1/rpc/midtrans_notify")) { if (body.p_status === "settlement") order = { ...order, status: "paid" }; return j("paid"); }
  if (url.endsWith("/auth/v1/user")) return j({ email: "host@x.id", user_metadata: { full_name: "Host" } });
  if (url === "https://app.sandbox.midtrans.com/snap/v1/transactions") return j({ token: "snap-tok", redirect_url: "https://pay/x" }, 201);
  if (url.startsWith("https://api.sandbox.midtrans.com/v2/")) return j(midtransStatus);
  return j({ error: "unexpected " + url }, 500);
};

const req = (path, body, headers = {}) => new Request(`https://jepretin.test${path}`, {
  method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const call = async (path, body, headers) => { const r = await worker.fetch(req(path, body, headers), env, {}); return [r.status, await r.json()]; };
const sig = (o, code, gross, key) => createHash("sha512").update(`${o}${code}${gross}${key}`).digest("hex");

// health: tidak membuka rahasia
let [s, b] = await call("/api/pay/health");
ok(s === 200 && b.ok === true && b.signature_key === true && !JSON.stringify(b).includes("Mid-server"), "health without secrets");

// checkout butuh login
[s, b] = await call("/api/pay/checkout", { event_id: "e1" });
ok(s === 401, "checkout requires login");

// checkout: start_order dengan JWT pengguna, Snap dengan Server Key, token disimpan dengan service key
calls = [];
[s, b] = await call("/api/pay/checkout", { event_id: "e1", promo: "PERDANA" }, { Authorization: "Bearer user-jwt" });
const so = calls.find((c) => c.url.endsWith("/rpc/start_order"));
const snap = calls.find((c) => c.url.includes("/snap/v1/transactions"));
const saved = calls.find((c) => c.url.endsWith("/rpc/set_order_snap"));
ok(s === 200 && b.snap_token === "snap-tok" && !("user_id" in b), "checkout returns snap token, no internal fields");
ok(so.init.headers.Authorization === "Bearer user-jwt" && so.body.p_promo === "PERDANA", "start_order called as user");
ok(snap.init.headers.Authorization === "Basic " + btoa("Mid-server-API:"), "snap uses server key");
ok(snap.body.transaction_details.gross_amount === 89100 && snap.body.item_details[0].price === 89100 && snap.body.expiry.duration === 15, "snap payload amount and expiry");
ok(saved.init.headers.apikey === "sb_secret_x" && saved.body.p_token === "snap-tok", "token saved with service key");

// Mode berbeda antara pengaturan dan Worker
order = { ...order, production: true };
[s, b] = await call("/api/pay/checkout", { event_id: "e1" }, { Authorization: "Bearer user-jwt" });
ok(s === 500 && /MODE_MIDTRANS_TIDAK_SAMA/.test(b.error), "production mismatch rejected");
order = { ...order, production: false };

// Webhook: tanda tangan salah ditolak; Server Key bukan kunci tanda tangan
calls = [];
[s, b] = await call("/api/pay/webhook", { order_id: order.id, status_code: "200", gross_amount: "89100.00", transaction_status: "settlement", signature_key: sig(order.id, "200", "89100.00", "Mid-server-API") });
ok(s === 401 && !calls.some((c) => c.url.includes("midtrans_notify")), "signature with server key rejected");
[s, b] = await call("/api/pay/webhook", { order_id: order.id, status_code: "200", gross_amount: "89100.00", signature_key: "x" });
ok(s === 401, "garbage signature rejected");

// Webhook sah: status diambil ulang dari API Midtrans, bukan dari isi notifikasi
calls = [];
[s, b] = await call("/api/pay/webhook", { order_id: order.id, status_code: "200", gross_amount: "89100.00", transaction_status: "settlement", signature_key: sig(order.id, "200", "89100.00", "Mid-server-SIG") });
const nt = calls.find((c) => c.url.endsWith("/rpc/midtrans_notify"));
ok(s === 200 && calls.some((c) => c.url.startsWith("https://api.sandbox.midtrans.com/v2/")), "webhook re-checks Midtrans status");
ok(nt.body.p_status === "settlement" && nt.body.p_gross === 89100 && nt.body.p_type === "qris", "midtrans_notify gets official status");

// Notifikasi palsu "settlement" padahal Midtrans bilang pending: yang dipakai pending
order = { ...order, status: "pending" };
midtransStatus = { ...midtransStatus, transaction_status: "pending" };
calls = [];
await call("/api/pay/webhook", { order_id: order.id, status_code: "200", gross_amount: "89100.00", transaction_status: "settlement", signature_key: sig(order.id, "200", "89100.00", "Mid-server-SIG") });
ok(calls.find((c) => c.url.endsWith("/rpc/midtrans_notify")).body.p_status === "pending", "forged settlement overridden by API status");

// Cek status manual (tanpa webhook): order_status sebagai pengguna, lalu Midtrans
midtransStatus = { ...midtransStatus, transaction_status: "settlement" };
calls = [];
[s, b] = await call("/api/pay/status", { order_id: order.id }, { Authorization: "Bearer user-jwt" });
ok(s === 200 && b.status === "paid" && calls.filter((c) => c.url.endsWith("/rpc/order_status")).length === 2, "manual status check settles order");

// Belum dikonfigurasi
[s, b] = await worker.fetch(req("/api/pay/checkout", {}, { Authorization: "Bearer x" }), { ...env, MIDTRANS_SERVER_KEY: "" }, {}).then(async (r) => [r.status, await r.json()]);
ok(s === 503 && /PEMBAYARAN_BELUM_SIAP/.test(b.error), "missing server key = 503");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
