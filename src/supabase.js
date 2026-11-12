import { createClient } from "@supabase/supabase-js";
import { t } from "./i18n.js";

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
  BATAS_STORAGE_HABIS: "Kuota storage Anda sudah penuh. Hapus acara lama atau hubungi superadmin.",
  BATAS_STORAGE_TIDAK_VALID: "Kuota storage harus angka 1 ke atas (MB).",
  JADWAL_TIDAK_VALID: "Waktu selesai harus setelah waktu mulai.",
  FOTO_TIDAK_ADA: "Foto tidak ditemukan atau belum bisa dilihat.",
  ALASAN_TIDAK_VALID: "Pilih alasan laporan.",
  AKSI_TIDAK_VALID: "Aksi tidak dikenal.",
  LANGGANAN_TIDAK_VALID: "Langganan notifikasi tidak valid.",
  UCAPAN_PENUH: "Anda sudah mengirim 3 ucapan di acara ini.",
  UCAPAN_KOSONG: "Tulis ucapan atau rekam suara dulu.",
  UCAPAN_TIDAK_ADA: "Ucapan tidak ditemukan.",
  FORMAT_SUARA: "Format rekaman tidak didukung.",
  PERMINTAAN_SUDAH_ADA: "Permintaan yang sama masih diproses.",
  PENGAJUAN_SUDAH_ADA: "Pengajuan Anda masih ditinjau.",
  SUDAH_PEMBUAT_ACARA: "Akun Anda sudah bisa membuat acara.",
  NOMOR_WA_TIDAK_VALID: "Nomor WhatsApp tidak valid. Contoh: 0812 3456 7890.",
  NAMA_ACARA_KOSONG: "Isi nama acara yang direncanakan.",
  JUMLAH_TAMU_TIDAK_VALID: "Perkiraan jumlah tamu tidak valid.",
  EMAIL_BELUM_TERVERIFIKASI: "Email akun Anda belum terverifikasi.",
  ALASAN_WAJIB: "Tulis alasan penolakan.",
  PERMINTAAN_TIDAK_ADA: "Permintaan tidak ditemukan.",
  PERMINTAAN_SELESAI: "Permintaan ini sudah diproses.",
  MASIH_PUNYA_ACARA: "Akun ini masih memiliki acara. Hapus atau pindahkan acaranya dulu.",
  R2_BELUM_SIAP: "Penyimpanan R2 belum siap. Periksa pengaturan Worker.",
  TIDAK_BOLEH_UNGGAH: "Unggahan ditolak.",
  URL_KEDALUWARSA: "Link foto kedaluwarsa. Muat ulang halaman.",
};

export function errorCode(e) {
  const m = String(e?.message || e || "");
  return Object.keys(MESSAGES).find((k) => m.includes(k)) || null;
}

export function friendly(e) {
  const c = errorCode(e);
  if (c) return t(MESSAGES[c]);
  if (!navigator.onLine) return t("Tidak ada koneksi internet.");
  return t("Terjadi kesalahan: ") + (e?.message || e);
}
