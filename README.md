# Disposable Asiig

Kamera sekali pakai berbasis web dengan album bersama. Opsi B1, paket P1:
Supabase (login Google, database, penyimpanan foto) + Cloudflare Pages
(tampilan) di `disposable-asiig.my.id`.

- 30 jepretan per akun (bisa diatur per acara), dijaga di server dengan kunci baris.
- Tanpa hapus, tanpa ulang. Foto peserta tampil di album setelah jatahnya habis,
  saat acara ditutup, atau pada waktu "cuci film".
- Foto disimpan dulu di HP (IndexedDB) lalu dikirim; sinyal putus tidak memotong jatah dua kali.

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
  album.js         tab Album
  owner.js         tab Panel (pemilik)
  storage.js       SATU-SATUNYA file yang berbeda antara P1 dan P2
supabase/schema.sql  seluruh tabel, fungsi, aturan akses, bucket
```

## Pemasangan

### 1. Database (sekali)

1. Supabase -> SQL Editor -> New query -> tempel isi `supabase/schema.sql` -> Run.
   Hasil: "Success. No rows returned", 6 tabel di Table Editor, bucket `photos` di Storage.
2. Daftarkan email Anda sebagai pembuat acara:
   ```sql
   insert into event_creators (email) values ('email-anda@gmail.com');
   ```

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
- [ ] Jendela bidik muncul; kamera depan/belakang bisa ditukar.
- [ ] Satu jepretan: penghitung 30 -> 29, foto belum tampil di album.
- [ ] Mode pesawat saat memotret: foto terkirim sendiri setelah online, jatah hanya berkurang satu.
- [ ] Buat acara dengan jatah 3: setelah jepretan ke-3 muncul "Film habis" dan foto tampil di HP lain.
- [ ] Panel: tutup acara -> gulungan yang belum habis tampil.
- [ ] Panel: sembunyikan foto, blokir peserta, unduh ZIP, hapus acara.

## Naik ke P2 (nanti)

Ganti `src/storage.js` dengan versi R2 dan tambahkan `functions/api/` sesuai tab
"Langkah pengembangan P1 dan P2", langkah 7. Fungsi `uploadPhoto`, `getUrls`, dan
`removeFiles` harus tetap punya nama dan bentuk yang sama.
