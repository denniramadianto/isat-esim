# CLI Order eSIM IM3 — `im3-esim.js`

CLI Node.js **tanpa dependensi** (Node ≥ 18, pakai `fetch` bawaan) untuk order eSIM
prabayar dari `im3shop.ioh.co.id`, dari pilih paket sampai QR eSIM pasca-bayar.
Endpoint terverifikasi dari HAR 1–4 (15 Nov 2026) — lihat
`../api-endpoints-from-har.md`.

## Cara pakai

```bash
cd esim-order-on-tg/cli
node im3-esim.js run        # wizard interaktif — ini yang paling gampang
```

Wizard: pilih paket → cari digit nomor → pilih nomor → isi nama/email/WA →
konfirmasi → order QRIS dibuat → bayar → CLI polling otomatis sampai paid →
QR eSIM + kode aktivasi disimpan.

### Perintah satu-satu (untuk skrip / bot Telegram)

```bash
node im3-esim.js packages [--json]
node im3-esim.js numbers --package 4324 [--search 123] [--category reg] [--json]
node im3-esim.js hunt --package 4324 --digits 11 --prefix 0815,0855 \
  [--contains 6666] [--ends 123] [--max-attempts 50] [--delay 800] [--json]
node im3-esim.js order --package 4324 --number-id <id nomor> \
  --name "Nama Pembeli" --email "a@b.id" [--phone 08..] --confirm [--json]
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
- `hunt --digits 11 --prefix 0815` → ketemu `08155275225` (Premium) setelah
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
