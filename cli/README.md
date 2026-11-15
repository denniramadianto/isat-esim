# CLI Order eSIM IM3 — `im3-esim.js` + `run.js`

CLI Node.js **tanpa dependensi** (Node ≥ 18, pakai `fetch` bawaan) untuk order eSIM
prabayar dari `im3shop.ioh.co.id`, dari pilih paket sampai QR eSIM pasca-bayar.
Endpoint terverifikasi dari HAR 1–4 (15 Nov 2026) — lihat
`../api-endpoints-from-har.md`.

## Arsitektur (2 file, 1 core)

```
im3-esim.js   CORE ENGINE — API IM3 + subcommand. Dipakai bot Telegram.
run.js        UI TERMINAL — menu interaktif berwarna, riwayat, nama/email random.
telegram.js   BOT TELEGRAM — memakai core, bukan file UI.
```

`run.js` hanya tampilan dan input; semua panggilan ke IM3 lewat
`require('./im3-esim.js')`. Logika API tidak diduplikasi. File core
sengaja dijaga stabil supaya bot Telegram bisa memakainya apa adanya.
`telegram.js` juga begitu: tanpa dependensi, Bot API Telegram dipanggil
langsung dengan `fetch` (long polling), token hanya dari env
`TELEGRAM_BOT_TOKEN`. Jalankan: `TELEGRAM_BOT_TOKEN=&lt;token&gt; node telegram.js`.
Perintah bot: `/start /order /hunt /paket /status /esim /cancel`.
Order & QR eSIM hanya di chat privat — kode aktivasi itu rahasia.

## Cara pakai

```bash
cd esim-order-on-tg/cli
node im3-esim.js            # buka menu interaktif (run.js) — paling gampang
node run.js                 # sama
node im3-esim.js run        # wizard interaktif mode lama
```

### Menu utama (`run.js`)

```
1. ⚡  Quick Order (otomatis, bisa banyak)
2. 🛒  Order eSIM Baru
3. 🎯  Hunt Nomor Cantik
4. 📦  Lihat Paket eSIM
5. 🔍  Cek Status Order
6. 📱  Ambil QR eSIM (order sudah paid)
7. 📋  Riwayat Pesanan
8. 💰  Riwayat Pembayaran
9. 💎  Database Nomor Cantik
0. 🚪  Keluar
```

- **Order eSIM Baru (menu 2):** pilih paket → pilih nomor (manual / auto hunt) →
  **konfirmasi nomor terpilih** (Enter = pakai, ketik `lagi` = cari nomor
  lain) → nama (ketik manual / random nama Indonesia) → email (ketik
  manual / random dari nama tanpa spasi + `@sir.my.id`) → WhatsApp
  opsional → konfirmasi → order QRIS → polling sampai paid → QR eSIM.
  Nomor hasil hunt tidak langsung di-order tanpa ditanya dulu.
- **Hunt Nomor Cantik (menu 3):** setelah ketemu nomor, ada pilihan
  `[1] order dengan nomor ini, [2] hunt lagi, [0] kembali ke menu` —
  nomor hasil hunt tidak hilang begitu saja.
- **Folder `hasil/`:** setiap QR eSIM yang didapat (lewat order, polling,
  menu 6, atau riwayat) otomatis tersimpan di `hasil/` dengan **nama file
  sama** untuk txt dan PNG-nya: `hasil/esim-<order_id>.txt` +
  `hasil/esim-<order_id>.png`. Isi txt: nomor, paket, Order ID, tanggal
  order, **berlaku sampai (+45 hari dari order)**, dan activation code.
  Folder ini berisi data sensitif — sudah masuk `.gitignore`, jangan
  di-commit.
- **Quick Order (menu 1):** sekali jalan, N eSIM sekaligus, semuanya
  otomatis — nomor acak (dicek ketersediaannya), nama + email random,
  paket default Perdana eSIM 5GB Rp1. Masukkan jumlah (1–10), lalu
  order NYATA langsung dibuat satu per satu (jeda ~6,5 dtk antar
  order, mengikuti batas server ~1 order / 6 dtk); QRIS tiap order
  langsung tampil di terminal + tersimpan sebagai `out/qris-<id>.png`.
  Setelah semua order dibuat, semuanya dipolling bareng tiap 20 dtk
  sampai masing-masing paid / QRIS kedaluwarsa (maks ~10 menit): yang
  paid langsung diambil QR eSIM-nya + tersimpan di `hasil/`, yang
  kedaluwarsa ditutup. Di akhir tampil ringkasan per order.
  **Perhatian: mengetik jumlah di menu ini = konfirmasi membuat order
  nyata — tidak ada konfirmasi kedua.**
- **Ambil QR eSIM (menu 6):** tidak perlu ketik order code lagi — tampil
  daftar nomor dari riwayat pesanan, pilih nomornya, lalu tampil QR eSIM
  + data eSIM (nomor, paket, tanggal order, berlaku sampai +45 hari,
  activation code) + file `hasil/` tersimpan. Kalau order belum ada di
  riwayat, tetap bisa ketik order code manual.
  **Hanya order yang sudah dibayar (PAID) yang tampil sebagai pilihan.**
  Order yang belum dibayar / QRIS-nya kedaluwarsa ditampilkan terpisah
  dengan keterangan (`menunggu bayar` / `QRIS kedaluwarsa`) dan tidak
  bisa dipilih — order seperti itu memang tidak punya QR eSIM.
  Status bayar dicek ke server per order (`paycheck`); begitu order
  terkonfirmasi PAID, statusnya dicatat di `out/order-<id>.json`
  (`payment_status: 3`) supaya tidak dicek ulang terus.
- **Kode status `paycheck`:** `2` = menunggu bayar, `3` = PAID,
  `21` = QRIS kedaluwarsa (order tidak dibayar dalam 10 menit).
  Untuk `esim/status` beda arti: `1` = In-Progress, `2` = Success.
- **Database Nomor Cantik (menu 9 + subcommand `harvest` / `db`):**
  nomor cantik disapu dari pool dan disimpan ID-nya saja — **tanpa
  order** — ke `db/nomorcantik.json` (file lokal, di-gitignore).
  Kriteria: **10/11 digit cukup triple (`xxx`) atau quartet
  (`xxxx`); 12 digit minimal quartet** (triple saja tidak cukup).
  Sekali jalan:
  `node im3-esim.js harvest [--rounds 1] [--delay 500]`, atau jalan
  terus: `node im3-esim.js harvest --loop [--interval-sec 300]`
  (putaran berulang sampai Ctrl+C, database tersimpan tiap putaran).
  Satu putaran = sapuan 10 kata kunci (`000, 111, ..., 999`) × 4
  kategori = 40 panggilan; nomor baru dicek ketersediaannya dulu
  sebelum disimpan. Lihat isi database: `node im3-esim.js db
  [--digits 10,11] [--pattern triple|quartet] [--search 111]
  [--check]` (`--check` = validasi ulang ketersediaan). Dari menu 9,
  nomor tersimpan bisa langsung di-order (ketersediaan dicek ulang
  ke server dulu; kalau sudah tidak tersedia, nomor itu dihapus dari
  database). **Catatan jujur dari uji live 15 Nov 2026:** dengan
  kriteria awal (hanya 10/11 digit), 6 putaran (240 panggilan, 372
  nomor dicek) menghasilkan **0 nomor** — pool saat ini didominasi
  nomor 12 digit. Setelah kriteria diperluas (12 digit minimal
  quartet), 3 putaran langsung menemukan **5 nomor quartet 12 digit**
  (semuanya `4444`). Nomor 10/11 digit bertriple tetap sangat jarang
  — database terisi terutama dari quartet 12 digit, dan makin
  banyak kalau `--loop` jalan terus saat pool berputar. Pool tiap
  paket bisa berbeda; default paket 4324 (5GB Rp1).
- **Enter = ya:** di prompt "Sudah bayar? Lanjut polling... (ya/tidak)",
  tekan Enter saja sudah dihitung `ya`.
- **Nama & email random:** nama diambil dari daftar nama Indonesia
  (misal `Sari Laksmana` → `sarilaksmana@sir.my.id`). **Konfirmasi email
  tidak ditanyakan** — otomatis diisi sama dengan email yang dipakai.
- **QR tampil di terminal:** setelah order dibuat, kode **QRIS tampil
  sebagai gambar QR di terminal** (bukan cuma string raw) — tinggal scan
  pakai aplikasi pembayaran. Setelah paid, **QR eSIM juga tampil di
  terminal** (dari activation code). String raw tetap ditampilkan kecil
  di bawahnya sebagai cadangan. Render memakai teknik half-block
  (1 karakter = 2 modul vertikal) dengan latar putih + modul hitam,
  dan **border putih (quiet zone) yang besar bila muat di layar**.
  Encoder QR: `qrcode.js` (vendored, MIT,
  kazuhikoarase/qrcode-generator, tanpa `npm install`).
  Terverifikasi: QR hasil render di-decode kembali (jsQR) dan isinya
  sama persis dengan string QRIS / LPA aslinya.
- **QR adaptif — tidak pernah tampil rusak:** lebar QRIS (285 karakter)
  butuh 73 kolom (border besar) / 69 kolom (normal). Bila terminal
  lebih sempit, ukuran diturunkan bertahap: EC level L (modul lebih
  sedikit) → border minimal → **braille** (1 karakter = 2x4 modul,
  QRIS cuma 33 kolom). Bila semua varian tetap tidak muat, QR **tidak
  ditampilkan sama sekali** (QR yang ter-wrap kelihatan seperti QR tapi
  tidak bisa di-scan — itu yang terjadi di Termux 56 kolom sebelum
  perbaikan ini) dan user diarahkan scan file PNG di `./out/` atau
  putar HP ke landscape. Semua varian (termasuk braille) terverifikasi
  bisa di-decode kembali.
- **Riwayat Pesanan:** membaca `out/order-*.json` — daftar order yang
  pernah dibuat dari CLI ini, lengkap dengan detail dan aksi (cek status /
  lanjut polling / ambil QR eSIM).
- **Riwayat Pembayaran:** mengecek status tiap order tersimpan ke server
  (`paycheck`) — PAID / menunggu bayar / QRIS kedaluwarsa.

Wizard: pilih paket → cari digit nomor → pilih nomor → isi nama/email/WA →
konfirmasi → order QRIS dibuat → bayar → CLI polling otomatis sampai paid →
QR eSIM + kode aktivasi disimpan.

### Perintah satu-satu (untuk skrip / bot Telegram)

```bash
node im3-esim.js packages [--json]
node im3-esim.js numbers --package 4324 [--search 123] [--category reg] [--json]
node im3-esim.js hunt --package 4324 --digits 11 --prefix 0815,0855 \
  [--contains 6666] [--ends 123] [--max-attempts 50] [--delay 800] [--json]
node im3-esim.js order --package 4324 --number-id 6556262 \
  --name "Indira" --email "a@b.id" [--phone 08..] --confirm [--json]
node im3-esim.js status --order-id 950002009xxx [--json]
node im3-esim.js esim --order-code "<order_code>" [--json]
node im3-esim.js watch --order-id 950002009xxx --order-code "<order_code>" [--json]
```

Flag `--json` mencetak JSON murni — untuk dipakai bot Telegram
(`telegram-store-bot-v1`) sebagai child process / `execFile`.

## Auto hunt nomor cantik

Di wizard (`run`), setelah pilih paket, pilih mode **[2] auto hunt**.
Atau langsung:

```bash
node im3-esim.js hunt --package 4324 --digits 11 --prefix 0815,0855 --max-attempts 50
node im3-esim.js hunt --package 4324 --contains 1234 --max-attempts 10
node im3-esim.js hunt --package 4324 --digits 12 --ends 777 --max-attempts 30
```

Kriteria yang bisa digabung: `--digits 10,11,12`, `--prefix 0815,0855`
(nomor harus diawali salah satunya), `--contains <digit>`, `--ends <digit>`.
Satu percobaan = 1 batch per kategori, diambil paralel (~32 nomor).
Loop berhenti begitu ketemu; kalau sampai `--max-attempts` tidak ketemu,
CLI melaporkan berapa nomor yang sudah dicek dan menyarankan melonggarkan
kriteria — nomor tidak pernah dibuat tanpa konfirmasi.

Cara kerja (diuji live): prefix dan jumlah digit **difilter client-side
dari batch acak** — search server untuk satu term cepat mengulang nomor
yang sama (pool-nya kecil). Yang dikirim sebagai search server hanya
`--contains` ≥ 3 digit, karena pola tengah seperti itu hampir tidak
muncul di batch acak.

Fakta dari data (356 nomor di HAR 1–4 + cek live):
- **10 digit: tidak pernah terlihat** (0 dari 356 nomor HAR, 0 dari 94 nomor
  saat hunt live). Opsi `--digits 10` tetap didukung, tapi kemungkinan
  besar akan habis di `--max-attempts` tanpa hasil — pool IM3 saat ini
  isinya 11 digit (~11%) dan 12 digit (~89%).
- Prefix yang ada: `0857` (~42%), `0815` (~35%), `0855` (~13%),
  `0856`, `0858`, `0816`. Prefix `0815` dan `0855` yang kamu sebut
  keduanya tersedia.

## Batasan API (rate limit) — apakah hunt boleh jalan terus?

Jawaban jujur: **untuk endpoint nomor, tidak ada batas yang teramati** —
259 panggilan API di 4 file HAR semuanya HTTP 200, tanpa satu pun 429,
dan tidak ada header rate-limit di response endpoint nomor. Hunt live
puluhan batch (4 request paralel per percobaan) juga lolos tanpa throttle.

Tapi itu **bukan jaminan tidak ada batas**. Batas bisa diberlakukan
diam-diam di gateway/WAF (balasan 429/403) kalau traffic dianggap abuse,
dan ambang pastinya tidak diketahui dari data yang ada.

Yang **terkonfirmasi ada batasnya** justru endpoint create order:
response-nya membawa header `x-rate-limit-limit: 0.17` +
`x-rate-limit-duration: 1` — kemungkinan ~1 order per ~6 detik
(0,17/detik). Jangan spam create order.

Karena itu CLI ini dibuat defensif:

- **Jeda antar percobaan** (`--delay`, default 800ms). Jangan diisi 0.
- **Maksimal percobaan** (`--max-attempts`, default 50). Loop tidak
  jalan tanpa batas secara default.
- **Kalau kena 429**, hunt menunggu sesuai `Retry-After` (atau 10 detik)
  lalu mencoba lagi; kena 429 tiga kali berturut-turut = berhenti sendiri
  dengan pesan jelas, bukan crash dan bukan gas terus.
- Loop tanpa henti juga **tidak efektif untuk kriteria langka**: pool nomor
  untuk satu pola itu kecil dan berulang — kalau 10 digit atau `7777`
  tidak ada di stok saat ini, muter 1000x pun tetap tidak ada. Lebih baik
  berhenti dan coba lagi lain waktu saat stok berubah.

## Yang diuji langsung (15 Nov 2026, 14:35 WIB)

- `packages` → 9 paket tampil, harga benar (5GB Rp1 s.d. 150GB Rp200.000).
- `numbers --search 1666` → 8 nomor Regular, id benar.
- `status --order-id 950002009xxx` → PAID (status=3), sesuai HAR ke-4.
- `esim --order-code ...` → QR eSIM PNG 250×250 + activation code, sama dengan HAR ke-4.
- `order` tanpa `--confirm` → ditolak, tidak ada order dibuat.
- Uji end-to-end dari nol di Termux (15 Nov 2026, 15:38–15:42 WIB):
  order `950002009xxx`, nomor `0858••••3330`, 5GB Rp1, email `<nama>@sir.my.id`
  → polling `paycheck` status 2 → PAID (status 3) → ambil QR eSIM.
  **Temuan baru:** sesaat setelah paid, `esim/status` mengembalikan
  `{"status":1,"qrCode":"","msg":"In-Progress"}` — QR eSIM belum siap.
  Dicoba lagi ~40 detik kemudian → `status: 2` + QR + activation code.
  Karena itu `esim` dan `watch` sekarang retry otomatis (maks 12x, jeda
  10 detik) saat status 1, dan hanya gagal kalau QR tetap tidak siap.
- `run.js`: menu tampil + daftar paket tampil benar; `node im3-esim.js`
  tanpa argumen membuka menu; nama random → email `@sir.my.id` teruji.
- `hunt --digits 11 --prefix 0815` → ketemu `0815•••••••` (Premium) setelah
  2 percobaan / 64 nomor, dalam ~3 detik.
- `hunt --contains 1234` → 8 nomor ketemu dalam 1 percobaan.
- `hunt --digits 10` → tidak ketemu setelah 94 nomor (sesuai data HAR).
- `hunt --contains 7777` → 0 nomor (pool saat ini tidak punya nomor
  mengandung 7777) — dilaporkan jujur, bukan error.

**Belum diuji end-to-end dari nol** (wizard `run` sampai paid) karena itu membuat
order QRIS nyata. Uji pertama sebaiknya dengan paket 5GB Rp1 dan email sendiri.

## File hasil

Semua tersimpan di `cli/out/`:

| File | Isi |
|---|---|
| `qris-<order>.png` | QR QRIS untuk dibayar |
| `order-<order>.json` | Ringkasan order + string QRIS mentah (`qris_raw`) |
| `esim-*.png` | QR eSIM (setelah paid) |

## Yang perlu diingat

- **Create order = order QRIS nyata.** Tanpa `--confirm` (atau "ya" di wizard),
  tidak ada yang dibuat. Ganti paket me-reset nomor — urutan wizard sudah
  benar (paket dulu, nomor terakhir).
- Polling `paycheck`: `2` = menunggu bayar, `3` = paid. QRIS berlaku 10 menit;
  `watch` berhenti sendiri kalau kedaluwarsa.
- `order-*.json` memuat string QRIS dan (setelah paid) `activation_code`.
  **Jangan kirim file itu ke orang lain** — siapa pun yang punya
  `activation_code` bisa memasang eSIM nomor itu.
- QR di terminal: CLI ini menyimpan QR sebagai PNG (untuk Telegram / dibuka
  di HP), bukan menggambar QR ASCII di terminal. String QRIS mentah juga
  dicetak di `qris_raw` kalau mau di-render sendiri.
