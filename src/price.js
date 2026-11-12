// Rumus harga Jepretin, sama persis dengan price_quote_raw() di supabase/v2.sql.
// Dipakai untuk angka langsung di layar (halaman harga, wizard, tambah tamu); nominal yang
// ditagih tetap dihitung ulang server saat pesanan dibuat. Tanpa DOM, supaya bisa dites di Node.
// cfg: hasil price_settings() — { roll_tiers, discounts, free_guests, free_shots, min }

export function quote(cfg, guests, shots) {
  const tiers = cfg.roll_tiers || [];
  const rate = (tiers.find(([max]) => shots <= max) || tiers[tiers.length - 1] || [0, 0])[1];
  const band = [...(cfg.discounts || [])].sort((a, b) => b[0] - a[0]).find(([min]) => guests >= min);
  const pct = band ? band[1] : 0;
  const subtotal = guests * rate;
  const free = guests <= cfg.free_guests && shots <= cfg.free_shots;
  const total = free ? 0 : Math.max(cfg.min, Math.ceil((subtotal * (100 - pct)) / 100000) * 1000);
  return { rate, subtotal, discount_pct: pct, volume_discount: subtotal - Math.round((subtotal * (100 - pct)) / 100), total, free };
}

export const rp = (n) => "Rp" + Math.round(Number(n) || 0).toLocaleString("id-ID");
