# Migrasi domain: disposable-asiig.my.id → titippotret.my.id

Produk **belum rilis**, jadi migrasinya sederhana: belum ada QR cetak, tamu, antrean foto di HP orang
lain, atau email terkirim yang perlu dilindungi. Domain lama cukup diredirect seluruhnya ke domain baru.

Yang tetap bernama lama karena internal dan tidak terlihat pengguna:
- Worker `disposable-asiig`: harus sama dengan nama di dasbor, dan domain serta secret terikat padanya.
- Bucket R2 `disposable-asiig-photos`: bucket tidak bisa di-rename.
- Repo GitHub `persevrance/disposable-asiig`.

Ketiganya boleh dibiarkan selamanya.

---

## 1. Domain baru ✅

- [x] Beli `titippotret.my.id` (IDCloudHost, berlaku s.d. 13 Nov 2027).
- [x] Cloudflare → Connect a domain → paket Free → hapus record A parkir dari registrar.
- [x] IDCloudHost → Nameserver → `colette.ns.cloudflare.com`, `hans.ns.cloudflare.com`.
- [x] Zona aktif di Cloudflare.
- [x] Worker `disposable-asiig` → **Domains** → Add Domain → `titippotret.my.id`.
      SSL valid, `/api/r2/health` siap.
- [x] IDCloudHost → Keamanan → **kunci transfer** domain; nyalakan perpanjangan otomatis.

## 2. Kode ✅ (tinggal commit + push)

- [x] Domain di pesan HTTPS kamera (`src/camera.js`, `src/i18n-en.js`), proxy dev (`vite.config.js`),
      cadangan VAPID (`notify-album`), komentar Worker.
- [x] Nama internal browser: IndexedDB `titippotret` (`src/queue.js`), cache `titippotret-*`
      (`public/sw.js`, `src/storage.js`). Antrean dan cache uji di HP Anda sendiri akan kosong sekali.
- [x] Nama paket, judul README dan dokumen, bagian deploy README (Pages → Workers).
- [x] Commit + push ke `main` → deploy Worker selesai.
- [x] Deploy ulang notify-album tidak perlu: secret `VAPID_SUBJECT` sudah diisi, jadi cadangan di kode tidak terpakai.

## 3. Dasbor

### Supabase
- [x] Authentication → URL Configuration:
  - **Site URL** → `https://titippotret.my.id`
  - **Redirect URLs** → tambah `https://titippotret.my.id` dan `https://titippotret.my.id/**`;
    hapus `https://disposable-asiig.my.id`. `http://localhost:5173` tetap ada.
- [x] Edge Functions → Secrets → `VAPID_SUBJECT` → `mailto:halo@titippotret.my.id`
      (jangan ganti `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`).

### Midtrans (sandbox, dan produksi bila sudah ada)
- [x] Settings → Payment → **Payment Notification URL** → `https://titippotret.my.id/api/pay/webhook`.
- [x] Settings → Snap Preferences → redirect URL Finish/Unfinish/Error: kosongkan atau ganti ke domain baru.
- [x] Snap Preferences → nama tampilan "Jepretin" → **TitipPotret**.
- [x] Profil merchant → URL website → `https://titippotret.my.id`. Bila sedang/akan mengajukan
      aktivasi produksi, ajukan dengan domain baru.

### Google Cloud Console → OAuth consent screen (Branding)
- [x] Authorized domains → tambah `titippotret.my.id`, hapus `disposable-asiig.my.id`.
- [x] Home page `https://titippotret.my.id`, Privacy `https://titippotret.my.id/privacy.html`,
      Terms `https://titippotret.my.id/syarat.html`.
- [x] Nama aplikasi → **TitipPotret** (tampil di layar "Pilih akun" Google).
- [x] Bila Authorized JavaScript origins berisi domain lama, ganti ke domain baru.
      Redirect URI (`https://<ref>.supabase.co/auth/v1/callback`) tidak berubah.

## 4. Uji di `https://titippotret.my.id` (Android Chrome + iPhone Safari)

- [x] Login Google → kembali ke domain baru.
- [x] Layar Google menampilkan "TitipPotret" (setelah Branding diganti).
- [ ] Buat acara → Panel → salin link undangan → berawalan `https://titippotret.my.id`.
- [x] Buka link slug (`/wisuda-2026`) di HP lain → masuk acara.
- [ ] Buka link `?kode=` di HP lain → masuk acara.
- [ ] Potret → foto terkirim; mode pesawat → potret → online → terkirim sendiri.
- [ ] Album, thumbnail, dan unduh berfungsi.
- [x] Pembayaran sandbox → simulator → kembali ke Panel → acara aktif; Midtrans →
      Notification history → status 200 ke URL baru.
- [ ] Dashboard → Keuangan → URL webhook yang tertera = domain baru.

## 5. Redirect domain lama

Setelah langkah 4 lolos:
- [x] Cloudflare → zona `disposable-asiig.my.id` → **Rules** → **Redirect Rules** → Create rule:
  - When: Custom filter → Hostname **equals** `disposable-asiig.my.id`
  - Then: Dynamic → `concat("https://titippotret.my.id", http.request.uri.path)`,
    status **301**, **Preserve query string** dicentang.
- [x] Worker → Domains → domain lama **dibiarkan terpasang**. Redirect Rule berjalan sebelum Worker,
      dan record DNS-nya tetap dibutuhkan agar domain lama bisa diakses lalu diredirect.
- [x] Uji: `curl -I https://disposable-asiig.my.id/?kode=ABC` → `301`,
      `Location: https://titippotret.my.id/?kode=ABC`.
- [ ] Domain lama boleh dilepas saat masa berlakunya habis. Sebaiknya dipertahankan setahun bila
      linknya pernah dibagikan (uji coba, demo, Midtrans).

## 6. Email (kapan saja setelah langkah 3)

### Resend
- [x] Domains → Add → `titippotret.my.id`, region Tokyo → isi record DKIM/SPF/MX yang diberikan
      di DNS Cloudflare (**DNS only**; atau tombol Auto configure) → Verify.
- [x] DNS Cloudflare: TXT `_dmarc` → `v=DMARC1; p=none; rua=mailto:halo@titippotret.my.id`.
- [x] API Keys → Create (Sending access, domain `titippotret.my.id`).

### Alamat layanan pelanggan (opsional)
- [x] Cloudflare → Email Routing → **Onboard Domain** `titippotret.my.id` → Activate
      (3 MX + SPF + DKIM di domain utama; tidak bentrok dengan record Resend).
- [x] Tab **Destination addresses** → tambah Gmail tujuan → verifikasi lewat email.
- [x] Tab **Routing rules** → Create routing rule → `halo` → Send to an email → Gmail tujuan.
      Wizard Onboard Domain **tidak** membuat aturan ini; tanpa aturan, email ke `halo@` ditolak.
      Catch-all dibiarkan Disabled.
- [x] Ganti alamat Gmail di `public/syarat.html`, `public/privacy.html`,
      `public/pengembalian-dana.html` → `halo@titippotret.my.id`.

### Supabase
- [x] Deploy `send-email` (`npx supabase functions deploy send-email --no-verify-jwt`), Verify JWT mati.
- [x] Secrets:

  | Nama | Nilai |
  |---|---|
  | `RESEND_API_KEY` | `re_...` |
  | `EMAIL_FROM` | `TitipPotret <notifikasi@titippotret.my.id>` |
  | `APP_URL` | `https://titippotret.my.id` |
  | `CRON_SECRET` | sama dengan purge-events |

- [x] SQL Editor: `vault.create_secret(...)` untuk `email_fn_url` (dan `cron_secret` bila belum ada),
      lalu tiga jadwal email di `supabase/cron.sql`.
- [x] Dashboard → Pengaturan → nyalakan **Notifikasi email**.
- [x] Uji: pembayaran sandbox → email bukti bayar masuk **Inbox**; Gmail → Show original →
      SPF/DKIM/DMARC **PASS**; link di email membuka domain baru.
      `select kind, recipient, sent_at, last_error from email_outbox order by id desc limit 10;`

## Ringkasan nilai

| Hal | Nilai |
|---|---|
| Domain | `https://titippotret.my.id` |
| Webhook Midtrans | `https://titippotret.my.id/api/pay/webhook` |
| Pengirim email | `TitipPotret <notifikasi@titippotret.my.id>` |
| Layanan pelanggan | `halo@titippotret.my.id` |
| `APP_URL` | `https://titippotret.my.id` |
| `VAPID_SUBJECT` | `mailto:halo@titippotret.my.id` |
| Nameserver | `colette.ns.cloudflare.com`, `hans.ns.cloudflare.com` |
