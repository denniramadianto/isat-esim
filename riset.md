# Riset: Otomasi Order eSIM IM3 via API Web

Dokumen ini mencatat **seluruh tahapan riset** yang dilakukan pada 15 November
2026 untuk memetakan cara kerja pemesanan eSIM prabayar di
`im3shop.ioh.co.id`, sampai akhirnya menjadi CLI di repo ini.

> **Catatan privasi:** semua data pribadi dari capture (nama, email, nomor
> HP yang dipesan, Order ID, string QRIS, kode aktivasi eSIM) **disamarkan**
> di dokumen ini. Nilai asli hanya ada di file HAR lokal penulis dan tidak
> ikut di-commit ke repo ini.

## Ringkasan eksekutif

| Item | Hasil |
|---|---|
| Tujuan | Otomasi order eSIM IM3 lewat terminal, lalu dihubungkan ke bot Telegram toko |
| Metode | Pemetaan UI situs + capture traffic HTTP (file HAR) dari browser |
| Capture | 4 file HAR (Lemur Browser, Android), total ±600 entri |
| Hasil | **Peta endpoint lengkap**: paket, nomor, validasi, create order + QRIS, cek status, QR eSIM pasca-bayar |
| Verifikasi | Pembayaran nyata Rp1 (paket 5GB) — status paid terkonfirmasi, QR eSIM + kode aktivasi berhasil diambil via API |
| Batasan | Rate limit create order terkonfirmasi via header; endpoint nomor tidak menunjukkan batas |

---

## Tahap 0 — Tujuan & scope (13:32 WIB)

Tujuan awal: mengotomasi order eSIM IM3 dari `im3shop.ioh.co.id` lewat
terminal, lalu dihubungkan ke bot Telegram toko (Node.js).

Kebutuhan yang dirumuskan:

1. **Nomor Terpilih** — ambil nomor cantik 10 atau 11 digit, dengan fitur
   random search.
2. **Paket Terpilih** — biarkan default (Perdana eSIM 5GB, Rp1).
3. **Nama Lengkap, Email, Konfirmasi Email, Nomor WhatsApp (opsional).**
4. **Tombol Lanjutkan** — submit form.

Scope yang ditambahkan kemudian: lanjut sampai pembayaran dan mendapatkan
data QR QRIS (pembayaran dilakukan manual oleh pembeli). QR ditampilkan di
terminal dan chatbot Telegram, ada auto-check status pembayaran, dan setelah
terbayar QR eSIM + datanya dikirim ke pembeli dalam bentuk gambar QR dan
data juga.

Keputusan metode: **capture endpoint API dulu** (bukan Playwright/browser
otomasi langsung), supaya otomasi nantinya berupa panggilan API murni —
lebih ringan dan cocok untuk bot Telegram.

---

## Tahap 1 — Pemetaan situs via browser (13:37–13:41 WIB)

Dilakukan dengan browser cloud, mengamati alur situs secara manual.

### URL

- URL yang pertama dicoba, `https://im3shop.ioh.co.id/esim/order/`,
  sudah **404**.
- Alur prabayar yang benar:
  `https://im3shop.ioh.co.id/esim/order/prepaid` (Langkah 1 dari 2)
  → `/esim/order/prepaid/number`
  → `/esim/order/prepaid/summary`
  → `/payment` → `/payment-qris`.
- Alur pascabayar (`/esim/order/postpaid`) berbeda dan bukan target.

### Paket

- Paket default: **Perdana eSIM 5GB — Rp1** (coret Rp30.000).
- Total 9 paket teramati di UI: 3GB Rp35.000, 5GB Rp1, 7GB Rp42.000,
  10GB Rp50.000, 25GB Rp80.000, 50GB Rp100.000, 80GB Rp125.000,
  120GB Rp150.000, 150GB Rp200.000.

### Nomor

- Nomor awalnya di-assign acak saat halaman dimuat.
- Pencarian minimal 3 digit.
- **Tidak ada filter 10/11 digit** di UI, dan tidak ada tombol berlabel
  random — yang ada tombol **"Nomor Lainnya"** (shuffle) per kategori.
- Kategori di UI: Regular gratis, Kembar gratis, Premium Rp25.000
  (dicoret, gratis), Spesial 11.11 gratis.
- UI menampilkan 6 nomor per kategori.

### Validasi form

- Nama minimal 2 karakter, email harus format valid, konfirmasi email
  harus sama, WhatsApp opsional (minimal 10 karakter bila diisi).
- Tombol LANJUTKAN nonaktif sampai field wajib valid.

### Temuan penting

- **Ganti paket me-reset nomor terpilih** → urutan otomasi harus paket
  dulu, nomor terakhir.
- Tanpa login, tanpa CAPTCHA/OTP sampai Langkah 2. Pembayaran setelah
  checkbox Syarat & Ketentuan di halaman summary.
- Menurut teks situs, informasi aktivasi eSIM dikirim ke email dan aplikasi
  myIM3 mode guest setelah pembelian selesai (bukan ditampilkan langsung
  di web — klaim ini kemudian terbukti tidak lengkap: QR eSIM ternyata
  juga bisa diambil lewat API, lihat Tahap 8).

---

## Tahap 2 — Percobaan capture via browser cloud (13:43–13:49 WIB)

**Hasil: gagal.** DevTools/Console tidak bisa dibuka di browser cloud itu
(Ctrl+Shift+I/J, Inspect, view-source semua gagal), jadi tidak ada endpoint
yang terverifikasi dari jalur ini.

Yang berhasil dari sesi ini hanyalah pengamatan tampilan sampai halaman
QRIS — dan satu order dummy yang tidak sengaja terbuat:

- Order ID `9500020092xx`, nomor `0855••••2262`, paket 5GB Rp1,
  email dummy `tes@example.com`.
- QRIS kedaluwarsa ~13:57 WIB dan **tidak dibayar** — kalau dibayar,
  aktivasi eSIM akan terkirim ke email dummy.
- Temuan tampilan: metode yang terlihat QRIS, ShopeePay/SPayLater, GoPay;
  QRIS berupa gambar PNG base64 inline 256×256; timer 10 menit; tombol
  "Cek status pembayaran" manual, tidak ada polling otomatis yang terlihat.
  (Daftar metode ini kemudian dikoreksi oleh HAR — API mengembalikan VA juga.)

**Pelajaran:** jangan menebak endpoint. Capture harus dilakukan di browser
yang DevTools-nya bisa dibuka.

---

## Tahap 3 — Capture di Android dengan Lemur Browser (13:55 WIB)

Lemur Browser (Android) adalah Chromium — punya DevTools bawaan dan bisa
memasang ekstensi Chrome. Rencana capture dipindah ke sana.

Sebagai fallback, dibuat userscript Tampermonkey
(`im3-api-logger.user.js`, tidak ikut di repo ini) yang me-log semua
fetch/XHR di `im3shop.ioh.co.id` (method, URL, body, response terpotong)
+ tombol download log JSON di halaman. Pada akhirnya HAR dari DevTools
yang dipakai, userscript tidak jadi dibutuhkan.

Detail teknis yang dicatat saat itu: label "Preserve log" di DevTools
Network Lemur/Chromium baru bernama **"Keep log"** — centang Keep log
dan Disable cache sebelum clear log dan reload halaman.

---

## Tahap 4 — HAR ke-1 (14:01 WIB)

File: `im3shop.ioh.co.id_0_09zj.har` — 1,4 MB, **47 entri**,
rentang 13:58:36–14:00:42 WIB.

### Yang terkonfirmasi

**`GET /api/v2/number/pre/{reg,platinum,gold,silver}/4324`**
- Query opsional `?search=<digit>`; tiap kategori 8 nomor, format
  `{id, number, price, old_price}`.
- Mapping label: `reg` = Regular, `platinum` = Kembar, `gold` = Premium
  (`old_price: 25000, price: 0`), `silver` = Spesial 11.11.
- Contoh: search `1236133` → nomor `0855••••6133` (id `xxxxxxx`)
  di Regular; kategori lain kosong.
- Search dilakukan server-side per kategori, bukan filter client-side.

**`POST /api/number/status/{id}`** — body `{}` → `{"available":true}`.

**`POST /api/payment/method/ESIMPRE`** — QRIS key `117`, E-Wallet,
**dan VA** (ATM Bersama, BCA, Mandiri, BNI, BRI). Ini mengoreksi
pengamatan UI Tahap 2 yang hanya melihat 3 metode.

**Tidak ada cookie auth / `Authorization` di HAR.** Hanya ada
`session_id` client-generated.

### Kekurangan

- Entri pertama baru 13:59:53 padahal halaman dibuka 13:58:36 (load awal
  tidak terekam).
- Berhenti di halaman pilih metode bayar. Masih hilang: daftar paket,
  create order, generate QRIS, cek status, ambil QR eSIM.
- Arti angka `4324` belum terkonfirmasi; dugaan: pool nomor terikat paket 5GB.

---

## Tahap 5 — HAR ke-2 (14:09 WIB)

File: `_2_im3shop.ioh.co.id_1_syao.har` — 689 KB, **21 entri**, hanya
14:09:23–14:09:31 WIB (8 detik), hanya load awal. **Tidak ada endpoint baru.**

Temuan: angka `4324` tetap sama di sesi berbeda (session_id baru) →
bukan session-specific.

Dugaan penyebab kepotong: file di-export terlalu cepat setelah reload;
filter Network masih Fetch/XHR (HAR tidak memuat Doc/JS/CSS sama sekali).

Perbaikan untuk capture berikutnya: filter Network = **All** (bukan
Fetch/XHR saja), DevTools dibuka sebelum reload, jalankan seluruh alur
sampai halaman QRIS + klik "Cek status pembayaran" 1x, baru export.
Cek ukuran file: kalau di bawah ~1 MB dan durasinya belasan detik,
kemungkinan export-nya kepotong.

---

## Tahap 6 — HAR ke-3: lengkap sampai QRIS (14:19–14:21 WIB)

File: `_3_im3shop.ioh.co.id_2_3q1w.har` — 4,1 MB, **144 entri**,
rentang 14:19:23–14:21:34 WIB, filter All. **Lengkap untuk scope sampai QRIS.**

### Mapping paket terkonfirmasi

Dari urutan ganti paket + traffic analytics: angka di URL nomor adalah
**subs_package_id paket terpilih**.

| package_id (string) | subs_package_id |
|---|---|
| `perdana_esim_5gb` | 4324 |
| `perdana_esim_3gb_50gb_5g` | 4230 |
| `perdana_esim_7gb_50gb_5g` | 4325 |

### `POST /api/order/esim/prepaid/create` ⭐ (endpoint utama)

Header: `Content-Type: application/json; charset=UTF-8`,
`Origin: https://im3shop.ioh.co.id`, `Referer: .../payment`,
`X-Requested-With: XMLHttpRequest`. Tanpa cookie/auth.

```json
{
  "number": <id nomor>,
  "name": "<nama>",
  "phone": "",
  "email": "<email>",
  "package": 4324,
  "sof": "117",
  "sof_msisdn": "",
  "agent_key": "utm_campaign:none,utm_medium:mobile,utm_source:direct,utm_term:none,utm_content:none",
  "session_id": "<random client-side, ~20 karakter alnum>",
  "bonus_id": 0,
  "language": "ID"
}
```

Field penting: `number` = **id nomor** (integer, bukan string nomor),
`package` = subs_package_id (integer), `sof` = `"117"` (key QRIS),
`phone` = nomor WhatsApp (boleh `""`).

Response:

```json
{
  "order_date": "2026-11-15 14:20:37",
  "order_code": "<URL-encoded, decode dulu sebelum dipakai>",
  "package": 1,
  "total_amout": 1,
  "link": "000201... [string QRIS mentah]",
  "qr_link": "iVBORw0KGgo... [base64 PNG, tanpa prefix data:]",
  "expire": 10
}
```

`link` = string QRIS mentah (diawali `000201...`). `qr_link` = base64 PNG
yang bisa langsung disimpan sebagai `.png`. `expire` = 10 (menit).
`order_code` di response dalam bentuk URL-encoded.

### `POST /api/order/detail`

Body: `{"order_code": "<order_code ter-decode>"}` → Order ID numerik,
`order_number`, `package_name`, `payment_method: "QRIS"`,
`total_price`, `subs_package_id`, `payment_status: 2`, `esim: true`,
`sof_id: "117"`.

Dipanggil saat halaman `/payment-qris` dimuat — dipakai untuk mengubah
`order_code` (token) menjadi Order ID numerik untuk paycheck.

### `GET /api/order/paycheck/{order_id_numerik}` ⭐ (cek status)

Response saat belum dibayar: `{"code":"9500020093xx","status":2}`.
Dipanggil 2x di HAR ini (selang ~52 detik) dari klik manual — **tidak ada
polling otomatis**, jadi bot harus polling sendiri (tiap 15–30 detik).

### `GET /api/bonus/package/{subs_package_id}`

Response: `{"avail":[],"not_avail":[]}` — cek bonus, bukan daftar paket.

### Order di HAR ini (nyata, sudah kedaluwarsa)

Nomor `0855••••6134`, Order ID `9500020093xx`, dibuat 14:20:37 WIB,
QRIS Rp1 kedaluwarsa ~14:30 WIB. **Tidak dibayar** — order ini kemudian
terhapus saat pengguna mencoba membuat order baru (Tahap 7).

### Yang masih belum diketahui setelah HAR ke-3

- Kode `status` paycheck saat sudah dibayar.
- Endpoint/cara mengambil QR eSIM + data aktivasi pasca-bayar.
- Endpoint daftar paket (kemungkinan hardcoded di JS frontend).

---

## Tahap 7 — Keputusan bayar & order baru (14:25–14:27 WIB)

Keputusan pengguna: bayar dulu QRIS order HAR ke-3, baru lanjut bangun CLI.

Kenyataannya: order lama itu **terhapus** sebelum sempat dibayar
(QRIS-nya juga hampir kedaluwarsa, ~14:30 WIB). Pengguna membuat order
baru dari awal. Pelajaran yang dicatat: jangan tutup tab sebelum selesai
bayar + klik Cek status; QRIS hanya berlaku 10 menit.

---

## Tahap 8 — HAR ke-4: TERBAYAR, peta lengkap (14:29–14:31 WIB)

File: `_4_im3shop.ioh.co.id_3_ptlr.har` — 5,7 MB, **195 entri**,
rentang 14:29:13–14:31:56 WIB.

Order baru di sesi ini: nomor `0857••••6104` (id `xxxxxxx`, cari `123633`
lalu `1666`), paket 5GB, Order ID `9500020093xx`, dibuat 14:31:07 WIB,
dibayar Rp1.

### Pembayaran terkonfirmasi

`GET /api/order/paycheck/9500020093xx` → `status: 2` (14:31:18, belum
dibayar) → **`status: 3` (14:31:46, sudah dibayar)**. `payment_status` di
`/api/order/detail` ikut berubah 2 → 3 di saat yang sama.

**Jadi: paycheck `2` = menunggu bayar, `3` = paid.**

### Daftar paket — akhirnya ketemu ⭐

**`GET /api/v3/number/packages/esim`** — response
`{"packages":[...9 paket...],"count":9}`. Tiap paket: `id`
(subs_package_id), `name`, `value` (harga bayar), `old_value`, `quota`,
plus `metadata` (JSON string berisi features, `price`, `period`).

| id | Nama | Harga bayar | Harga coret |
|---|---|---|---|
| 4324 | Perdana eSIM 5GB | Rp1 | Rp30.000 |
| 4230 | Perdana eSIM 3GB+50GB(5G) | Rp35.000 | — |
| 4325 | Perdana eSIM 7GB+50GB(5G) | Rp42.000 | — |
| 4354 | Perdana eSIM 10GB+50GB(5G) | Rp50.000 | — |
| 4321 | Perdana eSIM 25GB+50GB(5G) | Rp80.000 | — |
| 4316 | Perdana eSIM Istimewa 50GB+50GB(5G) | Rp100.000 | — |
| 4314 | Perdana eSIM Istimewa 80GB+50GB(5G) | Rp125.000 | — |
| 4311 | Perdana eSIM Istimewa 120GB+120GB(5G) | Rp150.000 | — |
| 4312 | Perdana eSIM Istimewa 150GB+150GB(5G) | Rp200.000 | — |

### QR eSIM pasca-bayar ⭐

Setelah paid, UI memanggil (14:31:56, ~10 detik setelah status 3):

**`GET /api/order/esim/status/{order_code}`**
(order_code dalam bentuk URL-encoded, sama seperti di response create)

```json
{
  "status": 2,
  "qrCode": "<base64 PNG 250x250>",
  "msg": "Success",
  "activation_code": "LPA:1$<SM-DP+ address>$<matching ID>"
}
```

- `status: 2` di endpoint ini artinya **Success / QR tersedia** — jangan
  disamakan dengan paycheck (di paycheck 2 = belum bayar, di sini 2 = sukses).
- `qrCode` = base64 PNG 250×250 (tanpa prefix `data:`) — simpan langsung
  sebagai `.png`.
- `activation_code` = string `LPA:1$...$...` — kode aktivasi eSIM.
  **Bersifat rahasia seperti password: siapa pun yang punya kode ini bisa
  install eSIM nomor itu.**

Alur pasca-bayar lengkap untuk otomasi: polling `paycheck` sampai
`status == 3` → panggil `esim/status/{order_code}` → kirim `qrCode`
sebagai gambar + `activation_code` sebagai teks ke pembeli.

### Status akhir peta endpoint (setelah HAR ke-4)

| Kebutuhan | Status |
|---|---|
| Daftar paket | ✅ `GET /api/v3/number/packages/esim` |
| Daftar + cari nomor | ✅ |
| Validasi nomor | ✅ |
| Daftar metode bayar | ✅ |
| Create order + QRIS | ✅ |
| Order detail | ✅ |
| Cek status pembayaran (2 = belum, 3 = paid) | ✅ |
| Ambil QR eSIM + activation code | ✅ `GET /api/order/esim/status/{order_code}` |
| Belum teruji | Kode status lain (expired/cancel), perilaku saat QRIS kedaluwarsa |

---

## Tahap 9 — Analisis pool nomor (14:37 WIB)

Dari 356 nomor yang terekam di HAR 1–4:

**Panjang digit:** 11 digit = 39 nomor (~11%), 12 digit = 317 (~89%),
**10 digit = 0**. Pool saat ini tidak berisi nomor 10 digit.

**Prefix (4 digit pertama):** `0857` ~42%, `0815` ~35%, `0855` ~13%,
`0856`, `0858`, `0816` sisanya.

Implikasi untuk fitur hunt: kriteria 10 digit hampir pasti tidak akan
ketemu (dikonfirmasi juga oleh hunt live: 0 dari 94 nomor yang dicek);
prefix `0815` dan `0855` keduanya tersedia.

---

## Tahap 10 — Analisis rate limit (14:40 WIB)

Dicek dari 4 file HAR (259 panggilan API):

- **Semua 259 panggilan = HTTP 200**, tanpa satu pun 429.
- **Tidak ada header rate-limit** di response endpoint nomor.
- Header rate-limit hanya muncul di **2 response create order**:
  `x-rate-limit-limit: 0.17`, `x-rate-limit-duration: 1` — kemungkinan
  ~1 order per ~6 detik (0,17/detik). Jangan spam create order.

Kesimpulan: endpoint nomor tidak menunjukkan batas yang teramati, tapi
itu bukan jaminan tidak ada batas (batas bisa diberlakukan diam-diam di
gateway/WAF). CLI dibuat defensif: jeda antar percobaan, batas percobaan,
dan backoff + berhenti otomatis setelah 3x HTTP 429 berturut-turut.

---

## Tahap 11 — Pembangunan CLI (14:35 WIB)

Dibangun `cli/im3-esim.js` — Node.js tanpa dependensi (Node ≥ 18),
satu file, berdasarkan endpoint terverifikasi di atas:

- Wizard interaktif `run`: paket → nomor → form → konfirmasi → order →
  polling → QR eSIM.
- Subcommand: `packages`, `numbers`, `order`, `status`, `esim`, `watch`,
  semua dengan flag `--json` untuk integrasi bot Telegram.
- Guard: `order` butuh `--confirm` (atau "ya" di wizard) — tanpa itu
  tidak ada order nyata yang dibuat.

**Pengujian live (14:35 WIB):**

| Uji | Hasil |
|---|---|
| `packages` | 9 paket, harga benar |
| `numbers --search 1666` | 8 nomor Regular |
| `status --order-id 9500020093xx` | PAID (status=3) |
| `esim --order-code ...` | QR eSIM PNG 250×250 + activation code, sama seperti HAR ke-4 |
| `order` tanpa `--confirm` | Ditolak, tidak ada order dibuat |

Belum diuji end-to-end dari nol (wizard `run` sampai paid) karena itu
membuat order QRIS nyata — uji pertama disarankan dengan paket 5GB Rp1
dan email sendiri.

---

## Tahap 12 — Fitur auto hunt nomor cantik (14:37 WIB)

Permintaan pengguna: menu auto get nomor cantik dengan auto loop sampai
ketemu, dengan pilihan loop 10/11 digit dan prefix tertentu (misal `0815`,
`0855`).

Implementasi: subcommand `hunt` + menu [2] di wizard. Kriteria:
`--digits`, `--prefix`, `--contains`, `--ends`, `--max-attempts`,
`--delay`. Satu percobaan = 1 batch per kategori, diambil paralel
(~32 nomor).

**Optimasi strategi (diuji live):** percobaan pertama mengirim prefix
sebagai search ke server — hasilnya lambat dan cepat mengulang nomor yang
sama (pool per term kecil; ~7 nomor baru per percobaan, ~2 detik per
percobaan secara sekuensial). Strategi diubah: prefix dan jumlah digit
difilter client-side dari batch acak paralel; hanya `--contains` ≥ 3 digit
yang dikirim sebagai search server.

**Pengujian live hunt:**

| Uji | Hasil |
|---|---|
| `--digits 11 --prefix 0815` | Ketemu `0815••••225` (Premium) setelah 2 percobaan / 64 nomor, ~3 detik |
| `--contains 1234` | 8 nomor ketemu dalam 1 percobaan |
| `--digits 10` | Tidak ketemu setelah 94 nomor (sesuai data Tahap 9) |
| `--contains 7777` | 0 nomor — pool saat ini tidak punya nomor mengandung 7777 |
| `--digits 11 --prefix 0855` | Tidak ketemu dalam 3 percobaan / 93 nomor (peluang gabungan ~1,4%/nomor, jadi wajar) |

---

## Endpoint pendukung (tercatat, tidak wajib untuk otomasi inti)

- `GET /api/settings/oa.api.maintenance.toast` — info maintenance.
- `GET /api/settings/oa.fwa.ui.enable` — flag UI.
- `POST /api/order/promo/utm` — cek promo UTM → `{"status":"not_eligible"}`.
- `GET /api/common/available-device/{model}` — cek kompatibilitas eSIM
  perangkat (contoh: `SM-S918B` → Galaxy S23 Ultra).
- `POST /api/traffic` dan `POST /api/traffic/im3/create` — analytics/
  telemetri, bukan API bisnis. Payload memuat `session_id`, utm, dan di
  `/im3/create` ada `package_id`, `package_price`, `selected_number`,
  `funnel_step`.

---

## Cara mereproduksi capture ini

1. Di Lemur Browser (Android), buka DevTools **dulu**, tab Network,
   filter **All**, centang **Keep log** + **Disable cache**, clear log.
2. Buka `https://im3shop.ioh.co.id/esim/order/prepaid`.
3. Jalankan alur lengkap: pilih nomor (cari + shuffle) → ganti paket
   (untuk melihat `subs_package_id` berubah) → isi form → Lanjutkan →
   summary → centang S&K → Lanjut ke Pembayaran → pilih QRIS → tunggu
   halaman QRIS → klik **Cek status pembayaran**.
4. Untuk bagian pasca-bayar: bayar QRIS-nya, klik Cek status sampai paid,
   lalu biarkan halaman memuat QR eSIM.
5. Export HAR, lalu parse entri `im3shop.ioh.co.id/api/*`.

**Jangan bagikan file HAR ke publik** — file itu berisi nama, email, dan
nomor yang dipesan.
