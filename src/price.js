// Rumus harga TitipPotret, sama persis dengan price_quote_raw() di supabase/v2.sql.
// Dipakai untuk angka langsung di layar (halaman harga, wizard, tambah tamu); nominal yang
// ditagih tetap dihitung ulang server saat pesanan dibuat. Tanpa DOM, supaya bisa dites di Node.
// cfg: hasil price_settings() — { roll_tiers, discounts, free_guests, free_shots, min }

export function quote(cfg, guests, shots, unlimited = false) {
  // Unlimited: harga tetap, tanpa diskon jumlah tamu
  if (unlimited) return { rate: null, subtotal: cfg.price_unlimited, discount_pct: 0, volume_discount: 0, total: cfg.price_unlimited, free: false, unlimited: true };
  const tiers = cfg.roll_tiers || [];
  const rate = (tiers.find(([max]) => shots <= max) || tiers[tiers.length - 1] || [0, 0])[1];
  const band = [...(cfg.discounts || [])].sort((a, b) => b[0] - a[0]).find(([min]) => guests >= min);
  const pct = band ? band[1] : 0;
  const subtotal = guests * rate;
  const free = guests <= cfg.free_guests && shots <= cfg.free_shots;
  const total = free ? 0 : Math.max(cfg.min, Math.ceil((subtotal * (100 - pct)) / 100000) * 1000);
  return { rate, subtotal, discount_pct: pct, volume_discount: subtotal - Math.round((subtotal * (100 - pct)) / 100), total, free, unlimited: false };
}

// Biaya masa simpan foto, sama dengan keep_fee() di database
export function keepFee(cfg, days) {
  if (!cfg.payments_enabled || days <= cfg.keep_free_days) return 0;
  if (days >= cfg.keep_flat_days) return cfg.keep_flat;
  return (days - cfg.keep_free_days) * cfg.keep_per_day;
}

// Batas potretan per tamu (rentang harga tertinggi saat pembayaran aktif)
export const shotsCap = (cfg) => cfg.shots_cap || cfg.max_shots_limit || 100;

// Rentang harga potretan: [{ from, to, rate }] untuk pilihan upgrade bertahap
export function tiers(cfg) {
  return (cfg.roll_tiers || []).map(([to, rate], i, a) => ({ from: i ? a[i - 1][0] + 1 : 1, to: Math.min(to, shotsCap(cfg)), rate }))
    .filter((t) => t.from <= shotsCap(cfg));
}

export const rp = (n) => "Rp" + Math.round(Number(n) || 0).toLocaleString("id-ID");
