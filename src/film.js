// Efek film: diterapkan di HP saat memotret dan langsung menjadi bagian foto
// (seperti kamera sekali pakai: tidak ada versi "tanpa filter").
// Daftar id harus sama dengan valid_film() di supabase/v2.sql.
//
// Parameter (semua opsional):
//   contrast  kontras di sekitar abu-abu tengah (1 = asli)
//   gain      pengali per kanal [R, G, B]
//   offset    geser per kanal [R, G, B] (0..1)
//   shadow    rona bayangan [R, G, B], highlight: rona terang [R, G, B]
//   fade      angkat titik hitam (0..1), gamma: >1 lebih terang
//   sat       saturasi (0 = hitam putih), mono: paksa hitam putih
//   grain     butiran (0..~0.12), vignette: gelap di tepi (0..1)
//   stamp     warna cap tanggal
export const FILMS = {
  asli: {
    name: "Asli", desc: "Warna apa adanya, hanya cap tanggal",
    stamp: "#ff9a2e",
  },
  senja: {
    name: "Senja Hangat", desc: "Hangat dan sedikit pudar, butiran halus",
    contrast: 1.08, gain: [1.06, 1.0, 0.9], offset: [0.02, 0.01, -0.01], fade: 0.04,
    sat: 1.08, grain: 0.06, vignette: 0.28, stamp: "#ff9a2e",
  },
  pagi: {
    name: "Pagi Cerah", desc: "Terang, warna nyala, segar",
    contrast: 1.12, gain: [1.0, 1.02, 1.03], gamma: 1.08,
    sat: 1.22, grain: 0.035, vignette: 0.15, stamp: "#ffb02e",
  },
  pastel: {
    name: "Pastel Manis", desc: "Lembut, pudar, rona merah muda",
    contrast: 0.88, gain: [1.04, 0.99, 1.02], highlight: [0.03, 0, 0.02], fade: 0.1, gamma: 1.12,
    sat: 0.82, grain: 0.03, vignette: 0.1, stamp: "#ff7aa8",
  },
  klasik: {
    name: "Hitam Putih Klasik", desc: "Monokrom kontras dengan butiran kasar",
    mono: true, contrast: 1.2, grain: 0.1, vignette: 0.3, stamp: "#ff9a2e",
  },
  sinema: {
    name: "Malam Sinema", desc: "Bayangan biru kehijauan, sorot hangat",
    contrast: 1.1, shadow: [-0.02, 0.02, 0.06], highlight: [0.05, 0.01, -0.03],
    sat: 1.05, grain: 0.07, vignette: 0.3, stamp: "#ff5c3a",
  },
  kenangan: {
    name: "Kenangan Lawas", desc: "Kekuningan, pudar, tepi gelap",
    contrast: 0.95, gain: [1.03, 1.03, 0.86], offset: [0, 0.02, 0], fade: 0.12,
    sat: 0.75, grain: 0.08, vignette: 0.45, stamp: "#ffa23a",
  },
};

export const FILM_IDS = Object.keys(FILMS);
export const filmName = (id) => FILMS[id]?.name || FILMS.asli.name;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Kurva 256 nilai per kanal (dihitung sekali per jepretan)
function buildLut(f, c) {
  const lut = new Uint8ClampedArray(256);
  const contrast = f.contrast ?? 1, gain = f.gain?.[c] ?? 1, offset = f.offset?.[c] ?? 0;
  const sh = f.shadow?.[c] ?? 0, hi = f.highlight?.[c] ?? 0;
  const fade = f.fade ?? 0, gamma = f.gamma ?? 1;
  for (let i = 0; i < 256; i++) {
    let x = i / 255;
    x = (x - 0.5) * contrast + 0.5;
    x = x * gain + offset;
    x += sh * (1 - x) * (1 - x) + hi * x * x;
    x = clamp01(x);
    x = fade + x * (1 - fade);
    if (gamma !== 1) x = Math.pow(x, 1 / gamma);
    lut[i] = Math.round(clamp01(x) * 255);
  }
  return lut;
}

// Terapkan preset ke canvas (di tempat). Diproses per pita supaya memori
// tetap kecil pada foto resolusi tinggi.
export function applyFilm(canvas, id) {
  const f = FILMS[id];
  if (!f || id === "asli") return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const lr = buildLut(f, 0), lg = buildLut(f, 1), lb = buildLut(f, 2);
  const sat = f.mono ? 0 : (f.sat ?? 1);
  const grain = (f.grain ?? 0) * 255;
  const vig = f.vignette ?? 0;
  const cx = W / 2, cy = H / 2, inv = 1 / (cx * cx + cy * cy);
  let seed = (Math.random() * 0xffffffff) >>> 0 || 1;

  const BAND = 128;
  for (let y0 = 0; y0 < H; y0 += BAND) {
    const h = Math.min(BAND, H - y0);
    const img = ctx.getImageData(0, y0, W, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const dy = y0 + y - cy, dy2 = dy * dy;
      let i = y * W * 4;
      for (let x = 0; x < W; x++, i += 4) {
        let r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        if (sat !== 1) { r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
        let k = 1;
        if (vig) {
          const dx = x - cx, t = (dx * dx + dy2) * inv; // 0 di tengah, 1 di sudut
          k = 1 - vig * t * Math.sqrt(t);
        }
        let n = 0;
        if (grain) {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          n = ((seed >>> 0) / 4294967296 - 0.5) * grain;
        }
        d[i] = r * k + n; d[i + 1] = g * k + n; d[i + 2] = b * k + n;
      }
    }
    ctx.putImageData(img, 0, y0);
  }
}
