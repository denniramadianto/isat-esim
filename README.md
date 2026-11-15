# im3-esim-cli

CLI Node.js **tanpa dependensi** untuk memesan eSIM prabayar IM3 dari
[im3shop.ioh.co.id](https://im3shop.ioh.co.id) lewat terminal — dari pilih
paket dan berburu nomor cantik, sampai QRIS, cek status pembayaran otomatis,
dan QR eSIM pasca-bayar.

> **Proyek tidak resmi.** Tidak berafiliasi dengan Indosat Ooredoo Hutchison.
> Tool ini memakai endpoint web publik yang sama dengan yang dipakai situs
> resminya di browser. Endpoint bisa berubah sewaktu-waktu tanpa pemberitahuan.
> Gunakan atas risiko sendiri dan patuhi syarat layanan IM3.

Riset lengkap di balik tool ini (pemetaan situs, 4x capture HAR, sampai
verifikasi pembayaran nyata) ada di **[riset.md](riset.md)**.

## Fitur

- **Daftar paket live** — 9 paket eSIM diambil dari API, bukan hardcode harga.
- **Cari nomor** — per kategori Regular, Kembar, Premium, Spesial 11.11;
  cari berdasarkan digit (min. 3 digit) atau ambil batch acak (shuffle).
- **Auto hunt nomor cantik** — loop otomatis sampai ketemu kombinasi yang
  diinginkan: jumlah digit (10/11/12), prefix (misal `0815`, `0855`),
  harus mengandung digit tertentu, atau harus berakhir dengan digit tertentu.
- **Validasi nomor** sebelum order dibuat.
- **Order QRIS** — membuat order nyata dan menyimpan QR QRIS sebagai PNG
  plus string QRIS mentah.
- **Auto check pembayaran** — polling status tiap 20 detik sampai paid
  (QRIS berlaku 10 menit).
- **QR eSIM pasca-bayar** — setelah paid, otomatis mengambil QR eSIM
  (PNG) + kode aktivasi `LPA:...` untuk dikirim ke pembeli.
- **Mode `--json`** di semua subcommand — siap dipakai sebagai child process
  dari bot Telegram atau layanan lain.
- **Defensif terhadap rate limit** — jeda antar percobaan, batas percobaan,
  dan backoff + berhenti otomatis saat kena HTTP 429.
- **Guard order nyata** — order tidak akan dibuat tanpa `--confirm`
  (atau jawaban "ya" di wizard).

## Syarat

- Node.js **18 atau lebih baru** (memakai `fetch` bawaan). Tidak perlu
  `npm install`, tidak ada dependensi.
- Koneksi internet ke `im3shop.ioh.co.id`.
- Pembayaran dilakukan **manual** oleh pembeli (scan QRIS). CLI hanya
  membuat order, menampilkan QR, lalu menunggu status paid.

## Mulai cepat

```bash
git clone https://github.com/<username>/im3-esim-cli.git
cd im3-esim-cli/cli
node im3-esim.js run
```

Wizard interaktif akan memandu:

1. Pilih paket (default: Perdana eSIM 5GB, Rp1).
2. Cari nomor — manual, atau auto hunt nomor cantik.
3. Isi nama lengkap, email (+ konfirmasi), nomor WhatsApp (opsional).
4. Konfirmasi — order QRIS **nyata** dibuat.
5. Bayar QRIS (scan `cli/out/qris-<order>.png`).
6. CLI polling otomatis sampai paid, lalu menyimpan QR eSIM
   (`cli/out/esim-*.png`) dan menampilkan kode aktivasinya.

## Perintah

| Perintah | Kegunaan |
|---|---|
| `node im3-esim.js run` | Wizard interaktif (disarankan) |
| `node im3-esim.js packages [--json]` | Daftar 9 paket + harga |
| `node im3-esim.js numbers --package 4324 [--search 123] [--category reg] [--json]` | Cari / ambil batch nomor |
| `node im3-esim.js hunt --package 4324 --digits 11 --prefix 0815,0855 [--contains 6666] [--ends 123] [--max-attempts 50] [--delay 800] [--json]` | Auto hunt nomor cantik |
| `node im3-esim.js order --package 4324 --number-id <id> --name "Nama" --email "a@b.id" [--phone 08..] --confirm [--json]` | Buat order QRIS |
| `node im3-esim.js status --order-id <id> [--json]` | Cek status pembayaran sekali |
| `node im3-esim.js esim --order-code "<order_code>" [--json]` | Ambil QR eSIM + activation code |
| `node im3-esim.js watch --order-id <id> --order-code "<order_code>" [--json]` | Polling sampai paid, lalu ambil QR eSIM |

### Contoh

```bash
# Lihat paket
node im3-esim.js packages

# Cari nomor mengandung 1234
node im3-esim.js numbers --package 4324 --search 1234

# Hunt nomor 11 digit prefix 0815 atau 0855, maks 50 percobaan
node im3-esim.js hunt --package 4324 --digits 11 --prefix 0815,0855 --max-attempts 50

# Buat order (butuh --confirm, kalau tidak ditolak)
node im3-esim.js order --package 4324 --number-id <id nomor> \
  --name "Nama Pembeli" --email "nama@example.id" --confirm

# Lanjutkan polling order yang sudah dibuat (misal terminal tertutup)
node im3-esim.js watch --order-id 950002009xxx --order-code "<order_code>"
```

### Kategori nomor

| Key | Label di situs |
|---|---|
| `reg` | Regular |
| `platinum` | Kembar |
| `gold` | Premium (harga coret Rp25.000, saat ini gratis) |
| `silver` | Spesial 11.11 |

Tiap kategori mengembalikan 8 nomor per batch. "Nomor Lainnya" di situs =
panggil ulang endpoint kategori itu (shuffle).

## Auto hunt nomor cantik

```bash
node im3-esim.js hunt --package 4324 --digits 11 --prefix 0815,0855 --max-attempts 50
node im3-esim.js hunt --package 4324 --contains 1234 --max-attempts 10
node im3-esim.js hunt --package 4324 --digits 12 --ends 777 --max-attempts 30
```

Kriteria bisa digabung:

- `--digits 10,11,12` — jumlah digit nomor.
- `--prefix 0815,0855` — nomor harus diawali salah satu prefix.
- `--contains <digit>` — nomor harus mengandung digit tersebut.
- `--ends <digit>` — nomor harus berakhir dengan digit tersebut.
- `--max-attempts <n>` — batas percobaan (default 50).
- `--delay <ms>` — jeda antar percobaan (default 800).
- `--category reg` — batasi ke satu kategori (default: semua).

Satu percobaan = 1 batch per kategori, diambil paralel (~32 nomor).
Loop berhenti begitu ketemu. Kalau sampai batas percobaan tidak ketemu,
CLI melaporkan berapa nomor yang sudah dicek.

**Cara kerja:** prefix dan jumlah digit difilter client-side dari batch
acak — hasil search server untuk satu term cepat mengulang nomor yang sama
(pool-nya kecil). Yang dikirim sebagai search ke server hanya `--contains`
≥ 3 digit, karena pola tengah seperti itu hampir tidak muncul di batch acak.

**Fakta pool nomor** (356 nomor dari capture + cek live, 15 Nov 2026):

- **10 digit: tidak pernah terlihat** (0 dari 356). Pool saat ini isinya
  11 digit (~11%) dan 12 digit (~89%). Opsi `--digits 10` tetap didukung,
  tapi kemungkinan besar akan habis di batas percobaan tanpa hasil.
- Prefix yang ada: `0857` (~42%), `0815` (~35%), `0855` (~13%),
  `0856`, `0858`, `0816`.

## Alur order

```
paket (GET /api/v3/number/packages/esim)
  → nomor (GET /api/v2/number/pre/{kategori}/{packageId}?search=...)
  → validasi (POST /api/number/status/{id})
  → create order (POST /api/order/esim/prepaid/create)
      → QRIS: string mentah (link) + PNG base64 (qr_link), berlaku 10 menit
  → order detail (POST /api/order/detail) → Order ID numerik
  → polling (GET /api/order/paycheck/{orderId}) — 2 = menunggu bayar, 3 = paid
  → QR eSIM (GET /api/order/esim/status/{order_code})
      → qrCode (PNG base64) + activation_code (LPA:1$...$...)
```

Peta endpoint lengkap + contoh request/response ada di [riset.md](riset.md)
dan [cli/README.md](cli/README.md).

### File hasil

Semua tersimpan di `cli/out/`:

| File | Isi |
|---|---|
| `qris-<order>.png` | QR QRIS untuk dibayar |
| `order-<order>.json` | Ringkasan order + string QRIS mentah (`qris_raw`) |
| `esim-*.png` | QR eSIM (setelah paid) |

## Batasan API (rate limit)

- **Endpoint nomor: tidak ada batas yang teramati.** 259 panggilan API di
  4 file capture semuanya HTTP 200, tanpa satu pun 429, dan tidak ada header
  rate-limit di response endpoint nomor. Hunt puluhan batch (4 request
  paralel per percobaan) juga lolos.
- **Bukan jaminan tidak ada batas.** Batas bisa diberlakukan diam-diam di
  gateway/WAF (balasan 429/403) kalau traffic dianggap abuse; ambang
  pastinya tidak diketahui.
- **Create order terkonfirmasi ada batasnya:** response-nya membawa header
  `x-rate-limit-limit: 0.17` + `x-rate-limit-duration: 1` — kemungkinan
  ~1 order per ~6 detik. Jangan spam create order.
- Loop tanpa henti juga **tidak efektif untuk kriteria langka**: kalau
  pola yang dicari memang tidak ada di stok saat ini, muter 1000x pun
  tetap tidak ada. Lebih baik berhenti dan coba lagi lain waktu.

Karena itu CLI ini defensif: jeda antar percobaan, batas percobaan, dan
kalau kena 429, hunt menunggu sesuai `Retry-After` (atau 10 detik) lalu
mencoba lagi; kena 429 tiga kali berturut-turut = berhenti sendiri.

## Keamanan & privasi

- **Jangan commit file hasil order.** `cli/out/`, `*.har`, `*.png`,
  dan `order-*.json` sudah ada di `.gitignore` — dan memang harus begitu.
  File `order-*.json` memuat string QRIS dan (setelah paid) kode aktivasi
  eSIM. **Siapa pun yang punya `activation_code` bisa memasang eSIM nomor
  itu di HP-nya.**
- Jangan bagikan file HAR (berisi email/nama asli), QR QRIS yang belum
  dibayar, QR eSIM, atau kode aktivasi ke orang lain / ke publik.
- CLI ini tidak memakai login, cookie, atau token apa pun. `session_id`
  dibuat client-side secara acak di tiap order.
- Order yang dibuat adalah **order nyata dengan pembayaran nyata**.
  Paket 5GB harganya Rp1 (promo), paket lain Rp35.000–Rp200.000.
  Selalu cek nominal dan nama merchant (PT Indosat Tbk) di aplikasi
  pembayaran sebelum konfirmasi.

## Integrasi bot Telegram

Semua subcommand mendukung `--json` (mencetak JSON murni ke stdout),
sehingga bisa dipanggil dari bot (misal Node.js `child_process.execFile`):

```js
// contoh: ambil daftar paket dari bot
const { execFile } = require('node:child_process');
execFile('node', ['cli/im3-esim.js', 'packages', '--json'], (err, stdout) => {
  const packages = JSON.parse(stdout);
  // ...tampilkan sebagai tombol inline
});
```

Alur yang disarankan di bot: `packages` → `hunt`/`numbers` → minta
nama/email/WA dari pembeli → `order --confirm` → kirim `qris-*.png` →
`watch` di background → setelah paid kirim `esim-*.png` + activation code
**hanya ke pembeli yang bersangkutan, lewat chat privat**.

## Troubleshooting

| Gejala | Kemungkinan penyebab |
|---|---|
| `packages` gagal / HTTP error | Situs IM3 berubah atau sedang maintenance. Cek `https://im3shop.ioh.co.id/esim/order/prepaid` di browser dulu. |
| Hunt tidak ketemu-ketemu | Kriteria terlalu langka atau stok sedang tidak ada polanya. Longgarkan kriteria atau coba lagi nanti. |
| `order` ditolak tanpa `--confirm` | Sengaja — tambahkan `--confirm` untuk membuat order nyata. |
| `watch` berhenti: "QRIS kedaluwarsa" | 10 menit habis dan belum dibayar. Buat order baru. |
| Kena throttle (429) | Tunggu beberapa menit, lalu jalankan lagi. Jangan naikkan kecepatan. |
| `esim` gagal: "QR eSIM belum tersedia" | Order belum paid, atau `order_code` salah. Cek `status` dulu. |

## Lisensi

MIT — lihat [LICENSE](LICENSE).
