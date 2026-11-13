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
   Superadmin bisa membatasi jumlah acara tiap pembuat acara (`user_roles.event_limit`, NULL = tanpa batas) dari tab Peran. Hitungan `user_roles.events_created` tidak berkurang saat acara dihapus; superadmin bisa mengubahnya untuk memberi jatah baru. Superadmin sendiri tidak dibatasi.
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

## Fase 1 perbaikan (dari review UI/UX + system analyst)

- [x] Palet lolos kontras AA, target sentuh 44px, fokus keyboard, animasi menghormati reduced motion
- [x] Service worker (`public/sw.js`) untuk kerangka aplikasi
- [x] ZIP album bertahap, maks. 100 foto per file
- [x] Hapus otomatis lewat Edge Function `purge-events` + `supabase/cron.sql`; cadangan tombol di Ringkasan
- [x] Peran dicocokkan dengan email terverifikasi (`my_verified_email()`)
- [x] Dialog aplikasi menggantikan `confirm()`/`prompt()`
- [x] Tombol "Buka di Chrome" (intent) untuk Android
- [x] Jendela bidik menampilkan bingkai foto utuh (contain)
- [x] Catatan kegagalan kamera (`client_errors`) dan daftarnya di Ringkasan
- [x] Aksi Tutup/Hapus acara di Dashboard pindah ke menu ⋯
- [x] Kuota storage menjadi pengaturan (`app_settings.storage_quota_mb`)

## Fase 2 perbaikan

- [x] Kartu pengenalan aturan main + petunjuk di bawah penghitung; aturan di layar masuk jadi tiga poin
- [x] Penampil foto: geser, panah keyboard, ketuk dua kali untuk zoom, penanda urutan
- [x] Pil "foto baru" dan progres album (`album_progress`)
- [x] Panel: kartu status (sakelar buka/tutup, angka, funnel dari `event_stats`) + sub-tab; peserta sebagai kartu dengan bilah progres
- [x] Navigasi bawah di HP; tab Kamera layar gelap
- [x] Tema gelap mengikuti pengaturan HP (semua warna lewat token)
- [x] Kamera menyala otomatis bila izin sudah ada
- [x] Efek film dan kompres di Web Worker (`develop.js`, `develop-worker.js`), cadangan thread utama
- [x] Dashboard dan Panel lebar di laptop
- [x] Beranda tamu: isian kode sebagai fokus; buat acara pindah ke Dashboard
- [x] Tes SQL di repo (`npm run test:sql`). Folder migrasi Supabase CLI sengaja ditunda: memindahkan
      `schema.sql`/`v2.sql` akan mengubah alur "jalankan ulang v2.sql" di SQL Editor.
- [x] Dashboard pembuat acara: tombol Buat acara, kartu status dengan funnel
- [x] Ringkasan superadmin: Perlu perhatian + Sedang berlangsung (`admin_live_events`)
- [x] Tabel acara dan pengguna: cari, saring, urut, halaman, aksi massal (`admin_events`, `admin_users`)
- [x] Tab Peran digabung ke Pengguna & peran
- [x] Log terbaca dengan saringan (`admin_audit` dengan label nama)

## Fase 3 fitur bernilai

Jalankan ulang `supabase/v2.sql` sebelum merilis tampilan Fase 3.

- [x] Mode layar `#/e/<id>/layar`: slideshow untuk proyektor, foto baru didahulukan, QR di pojok, layar tetap menyala (`slideshow_photos`)
- [x] Kartu QR siap cetak A6 (PNG dan cetak) dengan sampul, nama, jadwal, QR, kode (`src/qrcard.js`)
- [x] Funnel masuk / memotret / film habis / mengunduh di Panel, kartu Dashboard, dan total di Ringkasan
- [x] Saringan album: semua, foto saya, favorit, per tamu (`get_album` p_filter/p_owner, `album_owners`, `toggle_favorite`)
- [x] Efek film dicatat per foto (`photos.film`, `reserve_shot` p_film) dan tampil di penampil
- [x] Link album permanen `#/e/<id>/album` yang bertahan melewati login, kartu "Simpan album ini", ajakan pasang di layar utama
- [x] Suara rana (bisa dimatikan) dan angka penghitung bergulir
- [x] Wizard buat acara tiga langkah (nama & jadwal, jatah & film, sampul & pembukaan album), diakhiri QR
- [x] Jadwal acara `starts_at`/`ends_at`: tertutup otomatis lewat `open_now()` tanpa jadwal server; cuci film dan rencana hapus dari wizard
- [x] Duplikat acara (`duplicate_event`, sampul disalin di Storage)
- [x] Tren 30 hari di Ringkasan (`admin_trends`), dengan tabel
- [x] Kuota storage per pembuat acara (`user_roles.storage_limit_mb`, `owner_bytes`) dan batas bawaan pembuat baru di Pengaturan
- [x] Laporkan foto dan tab Moderasi (`photo_reports`, `report_photo`, `list_reports`, `resolve_reports`); tiga pelapor menyembunyikan foto otomatis
- [x] Ringkasan perubahan pengaturan sebelum simpan, tombol kembalikan ke bawaan

## Fase 4 pertumbuhan

Jalankan ulang `supabase/v2.sql`; untuk R2 dan notifikasi ikuti README bagian 1c dan 1d.

- [x] Notifikasi browser "album terbuka" (`push_subscriptions`, `album_watch`, Edge Function `notify-album`, dipicu aplikasi tanpa pg_cron)
- [x] Buku tamu teks + suara maks. 60 detik, 3 per tamu (`guestbook`, bucket `voices`, tab Ucapan)
- [x] Kolase v2 (BR-09: 1–9 foto, dibuat di HP, tidak diunggah, tanpa kuota unduhan): tata letak, ornamen, ukuran, dan teks sebagai pilihan bebas (`src/collage.js`, `src/collage-layouts.js`); tema per acara `events.collage_theme` (diatur di Panel → Pengaturan → Kolase tamu); tukar foto dengan ketuk, pindah dengan tahan-geser
- [x] BR-19: logo Jepretin di kolase wajib; boleh dimatikan bila `collage_theme.logo_optional` (diatur superadmin, sampai pembayaran tersedia)
- [x] Pengaman kapasitas: status pembuatan acara Buka / Hanya acara kecil / Tutup (`set_creation_mode`, `can_create_event(tamu, roll)`), meter kapasitas (`admin_capacity`; request Worker dan realtime puncak sebagai perkiraan model), pengaman otomatis 85%/95% (`capacity_tick`, cron 5 menit), tinjauan acara besar (`needs_review`, `review_event`; kamera aktif setelah ditinjau), daftar tunggu "Kabari saya" (`creation_waitlist`, push lewat `notify-album`)
- [x] Pembayaran Midtrans Snap: harga per tamu × tarif roll × (1 − diskon), minimum, kuota gratis (`price_quote_raw`, `src/price.js`); acara berbayar = draf sampai lunas (`events.pay_status`); pesanan dan kode promo (`orders`, `promo_codes`, `start_order`); tambah tamu bayar selisih; webhook dan cek status di Worker (`worker/pay.js`, tanda tangan Signature Secret Key + cek ulang ke API status); Dashboard → Keuangan; halaman harga publik `#/harga`
- [x] Buat acara v2 (#/buat, `src/create-event.js`): halaman penuh lima langkah sesuai kanvas (jenis & nama, waktu & buka album, kamera, tamu & privasi, sampul & tautan), lalu bayar dan "Acaramu sudah siap!"; nama penyelenggara, tautan khusus `domain/<slug>` (`resolve_slug`), album hanya penyelenggara (`album_private`), cap tanggal / unggah galeri / kamera depan bisa diatur
- [x] Layanan mandiri: saat pembayaran aktif, semua akun Google terverifikasi bisa langsung membuat acara tanpa pengajuan (`can_create_event`); email di kolom "Email pembuat acara" (`events.creator_email`) otomatis menjadi pembuat acara saat pesanan lunas. Saat pembayaran mati, alur pengajuan pembuat acara tetap berlaku.
- [x] Realtime hanya untuk acara sampai 300 tamu; di atasnya album memakai polling 30–60 detik dengan jeda acak
- [x] Foto di Cloudflare R2 lewat Worker situs (`worker/index.js`); hak akses tetap dari fungsi database; foto lama dipindah otomatis saat dibaca atau sekaligus dari Pengaturan (`r2_objects`, `stored_objects`)
- [x] Album realtime: broadcast Supabase per acara, polling jadi cadangan 60 detik
- [x] Bahasa Inggris untuk layar tamu (`src/i18n.js`), deteksi otomatis + tombol ID/EN
- [x] Permintaan hapus foto / akun (UU PDP): `data_requests`, tab Privasi superadmin
- [x] Ekspor CSV: log, daftar acara, laporan peserta per acara
- Email ditunda (notifikasi cukup lewat push)

## Catatan storage

Kuota gratis Supabase sekitar 1 GB storage. Pada 2560px satu foto (3 file) kira-kira 1,2–2 MB, jadi sekitar 500–800 foto.
Turunkan resolusi di dashboard atau pindah ke Cloudflare R2 (`src/storage.js`) jika acara besar.
