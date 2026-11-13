# Disposable Asiig

Kamera sekali pakai berbasis web dengan album bersama. Opsi B1, paket P1:
Supabase (login Google, database, penyimpanan foto) + Cloudflare Pages
(tampilan) di `disposable-asiig.my.id`.

- Jatah potretan per acara (batas maksimum diatur superadmin), dijaga di server dengan kunci baris.
- Tanpa hapus, tanpa ulang. Foto peserta tampil di album setelah jatahnya habis,
  saat acara ditutup, atau pada waktu "cuci film".
- Foto disimpan dulu di HP (IndexedDB) lalu dikirim; sinyal putus tidak memotong jatah dua kali.
- 7 efek film, flash (lampu kamera belakang / layar untuk kamera depan), resolusi dan mirror dari pengaturan.
- Tamu bisa mengunduh foto ukuran penuh, maks. sejumlah jatah potretan (foto sendiri gratis).
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
4. Login, buka **Dashboard** di beranda: tambahkan pembuat acara di tab Peran, atur batas potretan,
   resolusi, dan mirror di tab Pengaturan.

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

### 5. Pembayaran Midtrans

Pembayaran berjalan di Worker situs (`worker/pay.js`, rute `/api/pay/*`), Worker yang sama dengan
API foto R2. Harga, pesanan, dan kode promo ada di database (`supabase/v2.sql`); rumusnya sama dengan
`src/price.js`. Selama **Aktifkan pembayaran** mati, semua acara gratis seperti sebelumnya.

1. Jalankan ulang `supabase/v2.sql` di SQL Editor.
2. Rahasia Worker (dasbor Cloudflare -> Worker -> Settings -> Variables and Secrets, atau
   `npx wrangler secret put <NAMA>`):
   - `MIDTRANS_SERVER_KEY`: Server Key dari Midtrans -> Settings -> Access Keys -> Server Keys
   - `MIDTRANS_SIGNATURE_KEY`: Signature Secret Key di halaman yang sama (untuk memeriksa notifikasi)
   - `MIDTRANS_PRODUCTION`: `false` untuk sandbox, `true` untuk produksi
   - `MIDTRANS_ENABLED_PAYMENTS` (opsional): mis. `other_qris,gopay,shopeepay,bca_va,bni_va,bri_va`
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` (sudah ada bila R2 terpasang)
3. Midtrans -> Settings -> Payment -> **Payment Notification URL**: `https://<domain>/api/pay/webhook`
   (juga tertera di Dashboard -> Keuangan, dengan tombol salin).
4. Deploy ulang Worker, lalu Dashboard -> **Keuangan**: tempel **Client Key**, pastikan "Worker pembayaran"
   berstatus Siap dan modenya sama (sandbox/produksi), atur harga dan kode promo, lalu nyalakan
   **Aktifkan pembayaran**.
5. Uji di sandbox: buat acara di atas batas gratis -> Bayar -> pilih QRIS -> bayar dengan
   [simulator Midtrans](https://simulator.sandbox.midtrans.com/) -> acara aktif dan QR muncul.
   Tanpa webhook pun bisa dicek dengan tombol "Saya sudah bayar, cek status".
6. Lengkapi bagian `[ISI]` di `public/syarat.html` dan `public/pengembalian-dana.html` sebelum
   meminta aktivasi produksi.

Tes: `npm run test:sql` (harga, pesanan, webhook di database) dan `npm run test:pay` (rute Worker
dengan Midtrans tiruan: tanda tangan, cek ulang status, Snap), serta `npm run test:r2` (bundel
thumbnail dan URL foto stabil di Worker).

### 6. Notifikasi email

Trigger database menaruh kabar di tabel `email_outbox`. Edge Function `send-email` mengirimnya
lewat [Resend](https://resend.com) (gratis 100 email/hari, 3.000/bulan). Kuota Worker Cloudflare
tidak terpakai sama sekali.

| Kejadian | Penerima | Kapan |
|---|---|---|
| Pembayaran lunas | Pembayar (bukti bayar) | langsung |
| Pembayaran lunas | Superadmin | ringkasan harian |
| Refund | Pembayar + superadmin | langsung |
| Laporan foto (1–2 laporan) | Pemilik acara / superadmin | ringkasan per jam / harian |
| Foto disembunyikan otomatis (3 laporan) | Pemilik acara + superadmin | langsung |
| Acara baru (bukan milik superadmin) | Superadmin | ringkasan harian |
| Acara perlu ditinjau | Superadmin | ringkasan per jam |
| Pengajuan pembuat acara | Superadmin | ringkasan per jam |
| Keputusan pengajuan | Pemohon | langsung |
| Permintaan hapus data | Superadmin | ringkasan per jam |
| Kapasitas: ditutup otomatis / dibatasi otomatis | Superadmin | langsung / per jam |

Ringkasan berisi satu email per penerima. Ringkasan per jam dikirim tiap jam, ringkasan harian
pukul 07.00 WIB. Bila hari itu sudah terkirim sebanyak **Batas email per hari**, ringkasan ditunda
ke hari berikutnya, sedangkan email langsung tetap terkirim.

1. Jalankan ulang `supabase/v2.sql`.
2. Resend: daftar, verifikasi domain pengirim (catatan DNS di Cloudflare), buat API key.
3. Supabase -> Edge Functions -> deploy `supabase/functions/send-email` (atau
   `npx supabase functions deploy send-email --no-verify-jwt`), lalu matikan **Verify JWT**.
4. Edge Functions -> Secrets: `RESEND_API_KEY`, `EMAIL_FROM` (mis. `TitipPotret <notifikasi@domain-anda.id>`),
   `APP_URL` (mis. `https://domain-anda.id`), dan `CRON_SECRET` (sama dengan purge-events).
5. SQL Editor: simpan URL fungsi dan `CRON_SECRET` di Vault, lalu pasang tiga jadwal email.
   Keduanya ada di bagian "Notifikasi email" pada `supabase/cron.sql`.
6. Dashboard -> Pengaturan -> **Notifikasi email**: nyalakan sakelarnya. Selama mati, tidak ada
   kabar yang diantrekan.
7. Uji: laporkan satu foto dari tiga akun, atau selesaikan satu pembayaran sandbox. Email langsung
   tiba dalam beberapa detik. Periksa antrean dan hasil pemanggilan:
   ```sql
   select id, kind, recipient, priority, sent_at, attempts, last_error from email_outbox order by id desc limit 20;
   select status_code, content from net._http_response order by created desc limit 5;
   ```
   Email yang gagal dicoba lagi (urgent tiap 5 menit, ringkasan pada jadwal berikutnya), paling banyak 5 kali.

## Uji di HP (daftar periksa)

- [ ] Login Google di Android (Chrome) dan iPhone (Safari).
- [ ] Link `?kode=` memasukkan peserta setelah layar persetujuan.
- [ ] Jendela bidik muncul; kamera depan/belakang bisa ditukar.
- [ ] Satu potretan: penghitung 30 -> 29, foto belum tampil di album.
- [ ] Mode pesawat saat memotret: foto terkirim sendiri setelah online, jatah hanya berkurang satu.
- [ ] Buat acara dengan jatah 3: setelah potretan ke-3 muncul "Film habis" dan foto tampil di HP lain.
- [ ] Flash: kamera belakang Android menyalakan lampu sesaat; kamera depan memutihkan layar. Di iPhone, tombol flash kamera belakang hanya muncul jika Safari mendukung `torch`.
- [ ] Balik kamera ke depan: jendela bidik dan hasil foto dicerminkan sesuai Pengaturan.
- [ ] Efek film berbeda per acara (mis. Hitam Putih Klasik menghasilkan foto monokrom).
- [ ] Resolusi: ubah di Dashboard, foto baru mengikuti (cek ukuran di tab Ringkasan).
- [ ] Unduh sebagai tamu: sisa kuota berkurang hanya untuk foto orang lain; foto sendiri gratis.
- [ ] Sembunyikan nama: tamu melihat "Tamu", pemilik acara tetap melihat nama.
- [ ] Sampul: tampil di layar "Masuk acara" dan di atas halaman acara.
- [ ] Link dibuka dari WhatsApp/Instagram: muncul peringatan "Buka di Chrome atau Safari dulu".
- [ ] Panel: tutup acara -> gulungan yang belum habis tampil.
- [ ] Panel: sembunyikan foto, blokir peserta, unduh ZIP, hapus acara.

## Naik ke P2 (nanti)

Ganti `src/storage.js` dengan versi R2 dan tambahkan `functions/api/` sesuai tab
"Langkah pengembangan P1 dan P2", langkah 7. Fungsi `uploadPhoto`, `getUrls`, dan
`removeFiles` harus tetap punya nama dan bentuk yang sama.
