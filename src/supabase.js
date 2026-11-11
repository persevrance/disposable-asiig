import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = Boolean(url && key);

export const supabase = configured
  ? createClient(url, key, { auth: { persistSession: true, detectSessionInUrl: true } })
  : null;

// Panggil fungsi database; lempar error berisi kode seperti FILM_HABIS
export async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}

const MESSAGES = {
  BELUM_LOGIN: "Silakan login dulu.",
  KODE_SALAH: "Kode acara tidak ditemukan.",
  TIDAK_DIUNDANG: "Email Anda tidak ada di daftar undangan acara ini.",
  ACARA_PENUH: "Acara sudah penuh.",
  ACARA_TUTUP: "Acara sudah ditutup.",
  BUKAN_PESERTA: "Anda bukan peserta aktif acara ini.",
  FILM_HABIS: "Film habis.",
  FILE_BELUM_ADA: "Unggahan belum lengkap, akan dicoba lagi.",
  BUKAN_PEMILIK: "Hanya pemilik acara yang bisa melakukan ini.",
  TIDAK_BOLEH_MEMBUAT: "Akun Anda belum terdaftar sebagai pembuat acara.",
  TIDAK_BISA_DIRI_SENDIRI: "Tidak bisa melakukan ini pada akun Anda sendiri.",
  BUKAN_SUPERADMIN: "Hanya superadmin yang bisa melakukan ini.",
  AKUN_DIBLOKIR: "Akun Anda diblokir oleh admin.",
  JATAH_MELEBIHI_BATAS: "Jumlah jepretan melebihi batas yang diatur admin.",
  PESERTA_MELEBIHI_BATAS: "Jumlah peserta melebihi batas yang diatur admin.",
  JATAH_TIDAK_BOLEH_TURUN: "Jatah jepretan hanya bisa dinaikkan.",
  JATAH_DI_BAWAH_PEMAKAIAN: "Jatah tidak boleh lebih kecil dari jepretan yang sudah dipakai peserta.",
  FILM_TIDAK_DIKENAL: "Efek film tidak dikenal.",
  KUOTA_UNDUH_HABIS: "Kuota unduhan Anda tidak cukup untuk foto sebanyak itu.",
  TERLALU_BANYAK: "Pilih paling banyak 100 foto sekaligus.",
  SAMPUL_SALAH: "Lokasi file sampul tidak valid.",
  EMAIL_TIDAK_VALID: "Alamat email tidak valid.",
  BATAS_ACARA_HABIS: "Batas jumlah acara Anda sudah habis. Hubungi superadmin untuk menambahnya.",
  BATAS_ACARA_TIDAK_VALID: "Batas acara harus angka 0 sampai 10000.",
  PERAN_TIDAK_ADA: "Email ini belum punya peran.",
};

export function errorCode(e) {
  const m = String(e?.message || e || "");
  return Object.keys(MESSAGES).find((k) => m.includes(k)) || null;
}

export function friendly(e) {
  const c = errorCode(e);
  if (c) return MESSAGES[c];
  if (!navigator.onLine) return "Tidak ada koneksi internet.";
  return "Terjadi kesalahan: " + (e?.message || e);
}
