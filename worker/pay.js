// Pembayaran Midtrans Snap di Worker situs (/api/pay/*). Harga dan hak akses tetap diputuskan
// database (start_order, order_status, midtrans_notify); Worker hanya bicara dengan Midtrans.
//
// Rahasia Worker (wrangler secret put / dasbor Cloudflare):
//   MIDTRANS_SERVER_KEY     Server Key (Settings -> Access Keys -> Server Keys) untuk API Snap & status
//   MIDTRANS_SIGNATURE_KEY  Signature Secret Key, untuk memeriksa tanda tangan notifikasi.
//                           Kosong = pakai MIDTRANS_SERVER_KEY (akun Midtrans lama: satu kunci).
//   MIDTRANS_PRODUCTION     "true" untuk produksi; selain itu sandbox
//   MIDTRANS_ENABLED_PAYMENTS  opsional, mis. "other_qris,gopay,shopeepay,bca_va,bni_va,bri_va"
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY  sama dengan API foto
//
// Rute:
//   GET  /api/pay/health    status konfigurasi (tanpa membuka rahasia)
//   POST /api/pay/checkout  { event_id, guests?, shots?, promo?, method? } -> pesanan + token Snap (sesi pengguna)
//                           method: qris | gopay | shopeepay | va (tanpa method: MIDTRANS_ENABLED_PAYMENTS)
//   POST /api/pay/status    { order_id } -> status pesanan; cek ulang ke Midtrans bila masih tertunda
//   POST /api/pay/webhook   Payment Notification URL di dasbor Midtrans

const isProd = (env) => String(env.MIDTRANS_PRODUCTION || "").toLowerCase() === "true";
const snapBase = (env) => (isProd(env) ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com");
const apiBase = (env) => (isProd(env) ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com");
const basicAuth = (env) => "Basic " + btoa(`${env.MIDTRANS_SERVER_KEY}:`);

// Metode yang dipilih di layar Pembayaran -> enabled_payments Snap (popup langsung ke metode itu)
export const METHOD_PAYMENTS = {
  qris: ["other_qris"],
  gopay: ["gopay"],
  shopeepay: ["shopeepay"],
  va: ["bca_va", "bni_va", "bri_va", "permata_va", "cimb_va", "echannel"],
};

export async function payApi(req, env, url, h) {
  const route = url.pathname.slice("/api/pay/".length);
  if (route === "health") {
    return h.json({
      ok: Boolean(env.MIDTRANS_SERVER_KEY && env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_KEY),
      server_key: Boolean(env.MIDTRANS_SERVER_KEY), signature_key: Boolean(env.MIDTRANS_SIGNATURE_KEY),
      production: isProd(env), service: Boolean(env.SUPABASE_SERVICE_KEY),
    });
  }
  if (req.method !== "POST") h.fail(405, "METODE");
  if (!env.MIDTRANS_SERVER_KEY || !env.SUPABASE_SERVICE_KEY) h.fail(503, "PEMBAYARAN_BELUM_SIAP");
  if (route === "webhook") return webhook(req, env, h);
  const body = await req.json().catch(() => ({}));
  const jwt = h.bearer(req);
  if (route === "checkout") return checkout(req, env, h, jwt, body);
  if (route === "status") return status(env, h, jwt, body);
  h.fail(404, "RUTE_TIDAK_ADA");
}

// ---------- checkout: pesanan di database, lalu token Snap ----------
async function checkout(req, env, h, jwt, body) {
  if (!body.event_id) h.fail(400, "ACARA_TIDAK_ADA");
  const order = await h.rpc(env, jwt, "start_order", {
    p_event: body.event_id, p_guests: body.guests ?? null, p_shots: body.shots ?? null, p_promo: body.promo || null,
    p_method: body.method || null,
  });
  if (order.production !== isProd(env)) h.fail(500, "MODE_MIDTRANS_TIDAK_SAMA");
  if (order.status !== "pending" || order.snap_token) return h.json(publicOrder(order));

  const user = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` },
  }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const meta = user.user_metadata || {};
  const origin = new URL(req.url).origin;
  const name = `${order.kind === "new" ? "Acara" : "Tambah"} ${order.guests} tamu x ${order.shots} jepretan`.slice(0, 50);
  const payload = {
    transaction_details: { order_id: order.id, gross_amount: order.amount },
    item_details: [{ id: order.kind, price: order.amount, quantity: 1, name }],
    customer_details: { first_name: String(meta.full_name || meta.name || "Penyelenggara").slice(0, 50), email: user.email || undefined },
    expiry: { unit: "minute", duration: order.window_min || 15 },
    callbacks: { finish: `${origin}/#/e/${order.event_id}/panel` },
  };
  const enabled = METHOD_PAYMENTS[order.pay_method]
    || String(env.MIDTRANS_ENABLED_PAYMENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (enabled.length) payload.enabled_payments = enabled;
  const res = await fetch(`${snapBase(env)}/snap/v1/transactions`, {
    method: "POST",
    headers: { Authorization: basicAuth(env), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const snap = await res.json().catch(() => ({}));
  if (!res.ok || !snap.token) h.fail(502, "MIDTRANS_GAGAL: " + String((snap.error_messages || []).join("; ") || res.status).slice(0, 200));
  await serviceRpc(env, h, "set_order_snap", { p_order: order.id, p_token: snap.token, p_url: snap.redirect_url });
  return h.json(publicOrder({ ...order, snap_token: snap.token, snap_url: snap.redirect_url }));
}

// ---------- status: untuk tombol "Saya sudah bayar, cek status" ----------
async function status(env, h, jwt, body) {
  if (!body.order_id) h.fail(400, "PESANAN_TIDAK_ADA");
  let order = await h.rpc(env, jwt, "order_status", { p_order: body.order_id });  // juga memeriksa pemilik
  if (order.status === "pending") {
    const st = await midtransStatus(env, order.id);
    if (st) {
      await notify(env, h, st);
      order = await h.rpc(env, jwt, "order_status", { p_order: body.order_id });
    }
  }
  return h.json(publicOrder(order));
}

// ---------- webhook: tanda tangan, lalu konfirmasi ke API status Midtrans ----------
async function webhook(req, env, h) {
  const n = await req.json().catch(() => null);
  if (!n?.order_id || !n.signature_key) h.fail(400, "NOTIFIKASI_TIDAK_VALID");
  const key = env.MIDTRANS_SIGNATURE_KEY || env.MIDTRANS_SERVER_KEY;
  const expected = await sha512(`${n.order_id}${n.status_code}${n.gross_amount}${key}`);
  if (!h.timingSafeEqual(expected, String(n.signature_key))) h.fail(401, "TANDA_TANGAN_SALAH");
  // Jangan percaya isi notifikasi begitu saja: ambil status resmi dari Midtrans
  const st = (await midtransStatus(env, n.order_id)) || n;
  const result = await notify(env, h, st);
  return h.json({ ok: true, result });
}

async function midtransStatus(env, orderId) {
  const res = await fetch(`${apiBase(env)}/v2/${encodeURIComponent(orderId)}/status`, {
    headers: { Authorization: basicAuth(env), Accept: "application/json" },
  }).catch(() => null);
  if (!res?.ok) return null;
  const st = await res.json().catch(() => null);
  // 404 di badan respons: transaksi belum dibuat (pengguna belum memilih metode)
  return st && st.transaction_status ? st : null;
}

async function notify(env, h, st) {
  return serviceRpc(env, h, "midtrans_notify", {
    p_order: st.order_id, p_status: st.transaction_status, p_fraud: st.fraud_status || null,
    p_type: st.payment_type || null, p_gross: st.gross_amount != null ? Number(st.gross_amount) : null,
  });
}

async function serviceRpc(env, h, fn, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...h.serviceHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) h.fail(502, (await res.text()).slice(0, 200));
  return res.json();
}

// Yang dikirim ke browser: tanpa data internal
function publicOrder(o) {
  const keep = ["id", "event_id", "event_name", "kind", "guests", "shots", "list_price", "credit", "promo_code", "pay_method",
    "promo_discount", "amount", "status", "snap_token", "snap_url", "payment_type", "expires_at", "paid_at", "pay_status"];
  return Object.fromEntries(keep.filter((k) => k in o).map((k) => [k, o[k]]));
}

async function sha512(s) {
  const buf = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
