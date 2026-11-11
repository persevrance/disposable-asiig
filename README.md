# Disposable Asiig

Kamera sekali pakai berbasis web dengan album bersama. Opsi B1, paket P1:
Supabase (login Google, database, penyimpanan foto) + Cloudflare Pages
(tampilan) di `disposable-asiig.my.id`.

- Jatah jepretan per acara (batas maksimum diatur superadmin), dijaga di server dengan kunci baris.
- Tanpa hapus, tanpa ulang. Foto peserta tampil di album setelah jatahnya habis,
  saat acara ditutup, atau pada waktu "cuci film".
- Foto disimpan dulu di HP (IndexedDB) lalu dikirim; sinyal putus tidak memotong jatah dua kali.
- 7 efek film, flash (lampu kamera belakang / layar untuk kamera depan), resolusi dan mirror dari pengaturan.
- Tamu bisa mengunduh foto ukuran penuh, maks. sejumlah jatah jepretan (foto sendiri gratis).
- Peran: superadmin (dashboard `#/admin`), pembuat acara, tamu. Rancangan lengkap: [docs/RANCANGAN.md](docs/RANCANGAN.md).

## Susunan

```
index.html
public/            manifest, ikon, halaman privasi
src/
  main.js          login, beranda, masuk acara, router
  supabase.js      koneksi + pesan error
  camera.js        buka kamera, ambil bingkai, efek film, kompres
  camera-view.js   tab Kamera
  shoot.js         pesan jatah -> unggah -> konfirmasi, antrean kirim ulang
  queue.js         antrean IndexedDB
  film.js          preset efek film
  album.js         tab Album + unduh dengan kuota
  owner.js         tab Panel (pemilik acara / superadmin), gulungan per tamu, sampul
  admin.js         dashboard superadmin
  storage.js       SATU-SATUNYA file yang berbeda antara P1 dan P2
supabase/schema.sql  skema v1: tabel, fungsi, aturan akses, bucket
supabase/v2.sql      perubahan v2 (peran, pengaturan, unduhan, sampul, log); aman diulang
supabase/reset.sql   menghapus semua objek v1 + v2 (data hilang)
supabase/cron.sql    jadwal hapus otomatis harian (pg_cron -> Edge Function)
supabase/functions/purge-events/  Edge Function penghapus acara kedaluwarsa
public/sw.js         service worker: aplikasi tetap terbuka tanpa sinyal
```

## Pemasangan

### 1. Database (sekali)

1. Supabase -> SQL Editor -> New query -> tempel isi `supabase/schema.sql` -> Run.
   (Lewati jika database v1 sudah terpasang.)
2. New query -> tempel isi `supabase/v2.sql` -> Run. Aman untuk database yang sudah berisi data;
   daftar `event_creators` lama otomatis pindah ke `user_roles` sebagai pembuat acara.
   Hasil: 10 tabel di Table Editor, bucket `photos` dan `covers` di Storage.
3. Jadikan email Anda superadmin:
   ```sql
   insert into user_roles (email, role) values ('email-anda@gmail.com', 'superadmin')
   on conflict (email) do update set role = 'superadmin';
   ```
4. Login, buka **Dashboard** di beranda: tambahkan pembuat acara di tab Peran, atur batas jepretan,
   resolusi, mirror, dan kuota storage di tab Pengaturan.
5. Authentication -> Sign In / Providers -> **Email: matikan**. Aplikasi hanya memakai Google;
   peran dicocokkan dengan email terverifikasi, dan mematikan login email menutup celah pendaftaran palsu.

### 1b. Hapus otomatis acara (disarankan)

Acara dengan "Rencana hapus foto" yang sudah lewat dihapus tiap malam beserta semua fotonya.

1. Supabase -> Edge Functions -> **Deploy a new function** -> Via Editor. Nama: `purge-events`,
   tempel isi `supabase/functions/purge-events/index.ts`, lalu Deploy.
   (Atau dengan CLI: `supabase functions deploy purge-events`.)
2. Edge Functions -> **Secrets** -> tambah `CRON_SECRET` berisi teks acak panjang.
3. SQL Editor -> tempel `supabase/cron.sql`, ganti `<PROJECT-REF>`, `<ANON-KEY>`, `<CRON-SECRET>` -> Run.
4. Cek: `select * from cron.job_run_details order by start_time desc limit 5;` setelah jadwal berjalan.
   Hasil penghapusan tercatat di Dashboard -> Log sebagai "sistem (hapus otomatis)".

Jika langkah ini belum dipasang, acara yang lewat tanggal muncul di Dashboard -> Ringkasan
dengan tombol "Hapus sekarang".

### 2. Google

Google Auth Platform -> Audience -> tambahkan email Anda sebagai test user.
Sebelum acara dengan tamu, tekan **Publish app** supaya siapa pun bisa login.

### 3. Uji di laptop

```bash
cp .env.example .env      # isi VITE_SUPABASE_ANON_KEY
npm install
npm run dev               # http://localhost:5173
```

Login dengan Google, buat acara di beranda, lalu cek tabel `profiles` dan `events`.
Untuk mencoba dari HP di WiFi yang sama: `npm run dev -- --host`
(kamera di HP baru bisa dibuka setelah aplikasi berjalan di HTTPS, langkah 4).

### 4. Cloudflare Pages + domain

1. Push repositori ini ke GitHub (`persevrance/disposable-asiig`).
2. Cloudflare -> Workers & Pages -> Create -> Pages -> Connect to Git -> pilih repositori.
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
3. Setelah terpasang: proyek Pages -> Custom domains -> `disposable-asiig.my.id`.
4. Supabase -> Authentication -> URL Configuration:
   - Site URL: `https://disposable-asiig.my.id`
   - Redirect URLs: `https://disposable-asiig.my.id`, `http://localhost:5173`,
     dan alamat `https://<nama>.pages.dev` jika ingin menguji di sana.

Link undangan: `https://disposable-asiig.my.id/?kode=ABC123` (ada tombol salin dan QR di Panel).

## Uji di HP (daftar periksa)

- [ ] Login Google di Android (Chrome) dan iPhone (Safari).
- [ ] Link `?kode=` memasukkan peserta setelah layar persetujuan.
- [ ] Tamu yang login di perangkat/jendela baru tidak melihat acara apa pun di beranda sampai memasukkan kode; setelah Keluar, acara hilang lagi dari beranda.
- [ ] Jendela bidik muncul; kamera depan/belakang bisa ditukar.
- [ ] Satu jepretan: penghitung 30 -> 29, foto belum tampil di album.
- [ ] Mode pesawat saat memotret: foto terkirim sendiri setelah online, jatah hanya berkurang satu.
- [ ] Buat acara dengan jatah 3: setelah jepretan ke-3 muncul "Film habis" dan foto tampil di HP lain.
- [ ] Flash: kamera belakang Android menyalakan lampu sesaat; kamera depan memutihkan layar. Di iPhone, tombol flash kamera belakang hanya muncul jika Safari mendukung `torch`.
- [ ] Balik kamera ke depan: jendela bidik dan hasil foto dicerminkan sesuai Pengaturan.
- [ ] Efek film: ketuk label film di jendela bidik, pratinjau tiap efek muncul dari gambar kamera; pilihan tetap setelah muat ulang. Matikan "Tamu boleh memilih efek film sendiri" di Panel: label tidak bisa diketuk dan efek bawaan dipakai.
- [ ] Resolusi: ubah di Dashboard, foto baru mengikuti (cek ukuran di tab Ringkasan).
- [ ] Unduh sebagai tamu: sisa kuota berkurang hanya untuk foto orang lain; foto sendiri gratis.
- [ ] Sembunyikan nama: tamu melihat "Tamu", pemilik acara tetap melihat nama.
- [ ] Sampul: tampil di layar "Masuk acara" dan di atas halaman acara.
- [ ] Link dibuka dari WhatsApp/Instagram: muncul peringatan "Buka di Chrome atau Safari dulu"; di Android tombol "Buka di Chrome" membuka Chrome langsung.
- [ ] Tanpa sinyal: buka aplikasi sekali saat online, aktifkan mode pesawat, muat ulang -> aplikasi tetap terbuka dan foto masuk antrean.
- [ ] Jendela bidik menampilkan bingkai foto utuh (ada pita gelap di tepi bila rasio layar berbeda).
- [ ] Album lebih dari 100 foto: Unduh album memunculkan tombol per bagian (maks. 100 foto per ZIP).
- [ ] Tolak izin kamera di HP uji -> muncul di Dashboard -> Ringkasan -> Kegagalan kamera terbaru.
- [ ] Semua konfirmasi (hapus, ganti kode, blokir, unduh berkuota) tampil sebagai dialog aplikasi, bukan dialog browser.
- [ ] Panel: tutup acara -> gulungan yang belum habis tampil.
- [ ] Panel: sembunyikan foto, blokir peserta, unduh ZIP, hapus acara.

## Naik ke P2 (nanti)

Ganti `src/storage.js` dengan versi R2 dan tambahkan `functions/api/` sesuai tab
"Langkah pengembangan P1 dan P2", langkah 7. Fungsi `uploadPhoto`, `getUrls`, dan
`removeFiles` harus tetap punya nama dan bentuk yang sama.
