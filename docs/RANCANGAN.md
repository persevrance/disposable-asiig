# Rancangan Disposable Asiig v2

Database: `supabase/schema.sql` (v1) lalu `supabase/v2.sql` (perubahan v2, aman diulang).

## Peran

| Peran | Siapa | Bisa apa |
|---|---|---|
| Superadmin | `user_roles.role = 'superadmin'` (yang pertama lewat SQL) | Dashboard `#/admin`, kelola peran, pengaturan global, kelola semua acara |
| Pembuat acara | `user_roles.role = 'creator'`, ditambah superadmin | Membuat dan mengelola acaranya sendiri (tab Panel) |
| Tamu | Siapa saja yang login Google dan punya kode/link | Memotret, melihat album, mengunduh sesuai kuota |

## Keputusan

1. Tamu tetap wajib login Google. Ada peringatan untuk browser bawaan aplikasi (Google menolak login di sana).
   Beranda hanya menampilkan acara milik sendiri dan acara yang kodenya dimasukkan di perangkat ini (`localStorage`, per akun); daftar itu dihapus saat keluar.
2. Hanya email dengan peran `creator`/`superadmin` yang bisa membuat acara.
3. Jatah jepretan diatur pembuat acara, 1 sampai `app_settings.max_shots_limit`. Pembuat acara hanya bisa menaikkan; superadmin bisa menurunkan selama tidak di bawah pemakaian.
4. Efek film: pembuat acara memilih efek bawaan; tamu boleh menggantinya sendiri dari jendela bidik (pratinjau dari gambar kamera, diingat per acara di HP). Pembuat acara bisa mematikan pilihan tamu (`events.allow_film_choice`). Efek dibakar ke foto di HP (`src/film.js`). Nama preset buatan sendiri, bukan merek.
5. Tidak ada unggah dari galeri. Cadangan `<input capture>` menolak file yang `lastModified`-nya lebih dari 3 menit.
6. Foto tampil setelah film habis (tetap; acara ditutup dan cuci film juga tetap).
7. Antrean offline tetap.
8. Sembunyikan nama pengunggah (`events.hide_names`): nama hanya terlihat oleh pemilik acara dan superadmin. Nama file foto tidak lagi berisi `user_id`. Gulungan tiap tamu bisa dilihat di Panel.
9. Unduh untuk tamu: maks `max_shots` foto orang lain per acara (`downloads`). Foto sendiri gratis. File penuh hanya bisa dibaca setelah di-claim; album memakai versi sedang.
10. Resolusi diatur superadmin (`photo_max_side`, global + override per acara). Tiap foto: penuh, sedang (1080px), thumbnail (400px).
11. Dashboard (`#/admin`), tombolnya hanya tampil untuk superadmin dan pembuat acara. Superadmin: ringkasan + storage, peran, pengaturan, semua acara, pengguna (blokir), log aktivitas. Pembuat acara: hanya tab Acara berisi acaranya sendiri.
12. Flash manual (senter untuk kamera belakang jika didukung, layar putih untuk kamera depan). Kontrol kamera 3 kolom proporsional. Mirror diatur superadmin. Sampul/kartu undangan per acara (bucket publik `covers`).
13. Tema warna ceria (krem, koral, kuning, mint).
14. Penyimpanan tetap Supabase.

## Tahapan

- [x] 1. Tema warna baru
- [x] 2. Database v2 (`supabase/v2.sql`)
- [x] 3. Dashboard: peran, pengaturan
- [x] 4. Dashboard: acara, pengguna, ringkasan, log
- [x] 5. Kamera: resolusi dari pengaturan, 3 ukuran file, cek file lama
- [x] 6. Efek film
- [x] 7. Flash, tata letak kontrol, mirror
- [x] 8. Sembunyikan nama, gulungan per tamu
- [x] 9. Unduh untuk tamu dengan kuota
- [x] 10. Sampul undangan
- [x] 11. Peringatan browser bawaan aplikasi, README

## Catatan storage

Kuota gratis Supabase sekitar 1 GB storage. Pada 2560px satu foto (3 file) kira-kira 1,2–2 MB, jadi sekitar 500–800 foto.
Turunkan resolusi di dashboard atau pindah ke Cloudflare R2 (`src/storage.js`) jika acara besar.
