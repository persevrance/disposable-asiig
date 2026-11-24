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
  const maxPrice = cfg.keep_max_price ?? cfg.keep_flat;
  if (days >= cfg.keep_max_days) return maxPrice;
  if (days >= cfg.keep_flat_days) return Math.min(maxPrice, cfg.keep_flat + (days - cfg.keep_flat_days) * cfg.keep_per_day);
  return (days - cfg.keep_free_days) * cfg.keep_per_day;
}

// Biaya ubah jadwal selesai, sama dengan reschedule_fee() di database: tanggal (zona Asia/Jakarta)
// bergeser N hari = N × per hari; hanya jam di hari yang sama = biaya tetap; sebelumnya tanpa jadwal = 1 hari.
const jktDay = (d) => Math.floor((new Date(d).getTime() + 7 * 3600e3) / 86400e3);
export function rescheduleFee(cfg, oldEnd, newEnd) {
  if (!cfg.payments_enabled || !newEnd) return 0;
  if (oldEnd && new Date(oldEnd).getTime() === new Date(newEnd).getTime()) return 0;
  const perDay = cfg.reschedule_per_day ?? 3890, sameDay = cfg.reschedule_same_day ?? 1890;
  if (!oldEnd) return perDay;
  const days = Math.abs(jktDay(newEnd) - jktDay(oldEnd));
  return days ? days * perDay : sameDay;
}

// Hari tambahan acara, sama dengan event_extra_days() di database: gratis sampai event_base_hours
// dari waktu mulai, lalu tiap 24 jam (dibulatkan ke atas) satu hari tambahan.
export function extraDays(cfg, start, end) {
  if (!cfg.payments_enabled || !start || !end) return 0;
  const hours = (new Date(end).getTime() - new Date(start).getTime()) / 3600e3;
  if (!(hours > 0)) return 0;
  return Math.max(0, Math.ceil((hours - (cfg.event_base_hours ?? 24)) / 24));
}
export const extraDayFee = (cfg, days) => (cfg.payments_enabled && days > 0 ? days * (cfg.extra_day_price ?? 25000) : 0);

// Biaya layanan pembayaran (biaya Midtrans + PPN) yang dibebankan ke pembeli, sama dengan pay_fee()
// di database: total T supaya T − biaya Midtrans(T) ≥ base, dibulatkan ke atas per Rp100.
// Hanya untuk simulasi di panel Keuangan; nominal sungguhan dihitung server (price_quote / start_order).
export function payFee(cfg, base, method) {
  const f = cfg.pay_fees?.[method];
  if (!(base > 0) || cfg.pay_fee_to_buyer === false || !f) return 0;
  const k = f.incl ? 1 : 1 + Number(cfg.pay_fee_tax_pct ?? 11) / 100;
  const total = (base + f.flat * k) / (1 - (f.pct / 100) * k);
  return Math.ceil(Math.round(total * 1e6) / 1e8) * 100 - base;   // pembulatan dulu: hindari sisa float
}

// Batas potretan per tamu (rentang harga tertinggi saat pembayaran aktif)
export const shotsCap = (cfg) => cfg.shots_cap || cfg.max_shots_limit || 100;

// Rentang harga potretan: [{ from, to, rate }] untuk pilihan upgrade bertahap
export function tiers(cfg) {
  return (cfg.roll_tiers || []).map(([to, rate], i, a) => ({ from: i ? a[i - 1][0] + 1 : 1, to: Math.min(to, shotsCap(cfg)), rate }))
    .filter((t) => t.from <= shotsCap(cfg));
}

export const rp = (n) => "Rp" + Math.round(Number(n) || 0).toLocaleString("id-ID");
