// Data kolase v2: tata letak, ornamen, ukuran, dan latar. Menambah pilihan cukup satu entri.
// Kotak tata letak = [x, y, w, h] dalam pecahan area foto (0–1).
// Nama ornamen samakan dengan valid_ornament() di supabase/v2.sql.

const grid = (cols, rows) => {
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([c / cols, r / rows, 1 / cols, 1 / rows]);
  return out;
};
export const rowsToCells = (rows) => {
  const out = [];
  rows.forEach((cols, r) => { for (let c = 0; c < cols; c++) out.push([c / cols, r / rows.length, 1 / cols, 1 / rows.length]); });
  return out;
};

// Tata letak Otomatis: jumlah foto per baris dari atas, menyesuaikan jumlah foto (kolase v1)
export const ROWS = {
  1: [1], 2: [1, 1], 3: [1, 2], 4: [2, 2], 5: [2, 3], 6: [3, 3], 7: [2, 3, 2], 8: [3, 2, 3], 9: [3, 3, 3],
};
// Story lebih tinggi: tambah satu baris supaya foto tidak terlalu memanjang
export const ROWS_STORY = {
  1: [1], 2: [1, 1], 3: [1, 1, 1], 4: [1, 2, 1], 5: [1, 2, 2], 6: [2, 2, 2], 7: [1, 2, 2, 2], 8: [2, 2, 2, 2], 9: [2, 3, 2, 2],
};

export const LAYOUTS = [
  { id: "auto",  name: "Otomatis", cells: null },
  { id: "1x1",   name: "1×1",      cells: [[0, 0, 1, 1]] },
  { id: "2v",    name: "2 baris",  cells: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]] },
  { id: "2h",    name: "2 kolom",  cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
  { id: "1p2",   name: "1 + 2",    cells: [[0, 0, 1, 0.6], [0, 0.6, 0.5, 0.4], [0.5, 0.6, 0.5, 0.4]] },
  { id: "2x2",   name: "2×2",      cells: grid(2, 2) },
  { id: "strip", name: "Strip",    cells: grid(1, 4) },
  { id: "2x3",   name: "2×3",      cells: grid(2, 3) },
  { id: "3x3",   name: "3×3",      cells: grid(3, 3) },
];

// Kotak untuk tata letak + jumlah foto + ukuran
export function layoutCells(layoutId, n, story) {
  const l = LAYOUTS.find((x) => x.id === layoutId) || LAYOUTS[0];
  return l.cells || rowsToCells((story ? ROWS_STORY : ROWS)[Math.min(9, Math.max(1, n))]);
}

// Ornamen = lapisan di atas tata letak. gap: jarak antarfoto (px pada lebar 1080).
export const ORNAMENTS = [
  { id: "polos",    name: "Polos",       gap: 10 },
  { id: "film",     name: "Roll film",   gap: 14, bg: "gelap", band: 44 },
  { id: "polaroid", name: "Polaroid",    gap: 36 },
  { id: "tanggal",  name: "Cap tanggal", gap: 10, stamp: true },
  { id: "selotip",  name: "Selotip",     gap: 36 },
  { id: "konfeti",  name: "Konfeti",     gap: 10 },
  { id: "kartu",    name: "Kartu acara", gap: 10, card: true },
  // Tema dengan kop (masthead): nama acara dan tanggal di atas, kaki hanya logo
  { id: "koran",    name: "Koran lama",  gap: 18, bg: "koran", head: 220, masthead: true },
  { id: "kamera",   name: "Kamera retro", gap: 16, bg: "kamera", head: 150 },
  { id: "scrapbook", name: "Scrapbook & perangko", gap: 40, bg: "kraft", head: 190, masthead: true },
];

// Latar khusus ornamen (tidak muncul di pilihan "Latar" editor)
export const ORN_BACKGROUNDS = {
  koran:  { bg: "#eee4cf", ink: "#1f1b16", muted: "#5d5446", cell: "#d8ccb3", body: "#1f1b16", cut: "#eee4cf" },
  kamera: { bg: "#221e1b", ink: "#f2ebe0", muted: "#b8ab99", cell: "#38322d", body: "#f2ebe0", cut: "#221e1b" },
  kraft:  { bg: "#e3cfab", ink: "#3a281a", muted: "#6b5440", cell: "#d2bb95", body: "#3a281a", cut: "#e3cfab" },
};
export const WASHI = ["rgba(255, 134, 168, .82)", "rgba(134, 196, 245, .82)", "rgba(255, 201, 77, .85)", "rgba(90, 216, 182, .8)"];

export const SIZES = {
  feed:   { name: "Feed",  ratio: "4:5",  w: 1080, h: 1350 },
  square: { name: "Kotak", ratio: "1:1",  w: 1080, h: 1080 },
  story:  { name: "Story", ratio: "9:16", w: 1080, h: 1920 },
};

// bg latar, ink teks, muted keterangan, cell kotak kosong, body/cut warna logo
export const BACKGROUNDS = {
  krem:  { name: "Krem",       bg: "#fff7ec", ink: "#1f2a44", muted: "#5b6475", cell: "#e6dccd", body: "#1f2a44", cut: "#fff7ec" },
  gelap: { name: "Gelap",      bg: "#141b2b", ink: "#f3eee6", muted: "#b7bfcc", cell: "#1b2438", body: "#fff7ec", cut: "#141b2b" },
  putih: { name: "Putih",      bg: "#ffffff", ink: "#1f2a44", muted: "#5b6475", cell: "#e6dccd", body: "#1f2a44", cut: "#ffffff" },
  koral: { name: "Koral muda", bg: "#fde4d8", ink: "#1f2a44", muted: "#5b6475", cell: "#f6c9b6", body: "#1f2a44", cut: "#fde4d8" },
};

export const CONFETTI = ["#e8603c", "#ffc94d", "#5ad8b6", "#c0a8ff", "#86c4f5"];
export const STAMP = "#ff9f43";
export const TAPE = "rgba(255, 201, 77, 0.78)";
export const CARD = { bg: "#1f2a44", ink: "#fff7ec", muted: "#c9cfdb" };
