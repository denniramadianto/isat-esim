#!/usr/bin/env node
/**
 * run.js — UI interaktif (menu + warna) untuk im3-esim-cli.
 *
 * Arsitektur yang dipakai di repo ini:
 *   im3-esim.js  = CORE ENGINE (API IM3 + subcommand). Dipakai bot Telegram.
 *   run.js       = UI TERMINAL (file ini). Menu, warna, input, riwayat.
 *   telegram.js  = (rencana) bot Telegram, juga memakai core — bukan file ini.
 *
 * File ini TIDAK menduplikasi logika API: semua panggilan ke IM3 lewat
 * `require('./im3-esim.js')`. Yang ada di sini hanya tampilan, input,
 * generator nama/email random, dan pembacaan riwayat dari ./out/.
 *
 * Cara pakai:
 *   node run.js            # buka menu
 *   node im3-esim.js       # sama — tanpa argumen langsung buka menu ini
 *
 * Tanpa dependensi, Node >= 18.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const core = require('./im3-esim.js');
// Encoder QR (vendored, MIT — kazuhikoarase/qrcode-generator).
// Tanpa npm install: file ini ikut di-commit di repo.
const qrcode = require('./qrcode.js');

const OUT_DIR = path.join(__dirname, 'out');
const POLL_SECONDS = 20;
const ESIM_MAX_TRIES = 12;
const ESIM_RETRY_SECONDS = 10;

// ---------------------------------------------------------------- warna
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
const paint = (color, s) => C[color] + s + C.reset;
const ok = (s) => paint('green', '✅ ' + s);
const err = (s) => paint('red', '❌ ' + s);
const warn = (s) => paint('yellow', '⚠️  ' + s);
const info = (s) => paint('cyan', 'ℹ️  ' + s);

function line(char = '═', n = 52) {
  console.log(paint('cyan', char.repeat(n)));
}
function banner() {
  console.clear();
  line();
  console.log(paint('bold', paint('cyan', '   📱  ISAT eSIM  —  Order eSIM IM3 via Terminal')));
  console.log(paint('gray', '   Paket • Nomor Cantik • QRIS • QR eSIM'));
  line();
}
function section(title) {
  console.log('\n' + paint('bold', paint('magenta', `── ${title} `)) + paint('magenta', '─'.repeat(Math.max(0, 44 - title.length))));
}
function rupiah(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

// ---------------------------------------------------------------- QR terminal
// Render string jadi QR yang bisa di-scan langsung dari layar terminal.
// Teknik half-block: 1 karakter = 2 modul vertikal (▀/▄/█), latar putih +
// modul hitam, jadi modul tetap persegi dan terbaca kamera HP.
// Terverifikasi: QRIS 65 modul & LPA 37 modul hasil encode di sini
// berhasil di-decode kembali (jsQR) dengan isi yang sama persis.
function qrLines(text, ecLevel = 'M', quiet = 2) {
  const qr = qrcode(0, ecLevel); // 0 = pilih versi otomatis
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const total = n + quiet * 2;
  const dark = (r, c) => {
    const rr = r - quiet, cc = c - quiet;
    return rr >= 0 && rr < n && cc >= 0 && cc < n && qr.isDark(rr, cc);
  };
  const rows = [];
  for (let r = 0; r < total; r += 2) {
    let line = '';
    for (let c = 0; c < total; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    rows.push(line);
  }
  return { lines: rows, width: total };
}
// Render QR sebagai pola braille (1 karakter = 2x4 modul) — jauh lebih
// sempit dari half-block, untuk terminal HP yang sempit. Titik braille
// berjarak sama secara horizontal & vertikal, jadi modul tetap persegi.
function brailleLines(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const total = n + quiet * 2;
  const dark = (r, c) => {
    const rr = r - quiet, cc = c - quiet;
    return rr >= 0 && rr < n && cc >= 0 && cc < n && qr.isDark(rr, cc);
  };
  // bit tiap titik braille: (kolom, baris) -> bit
  const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
  const rows = [];
  for (let r = 0; r < total; r += 4) {
    let line = '';
    for (let c = 0; c < total; c += 2) {
      let code = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (dark(r + dy, c + dx)) code |= BIT[dy][dx];
        }
      }
      line += String.fromCharCode(0x2800 + code);
    }
    rows.push(line);
  }
  return { lines: rows, width: Math.ceil(total / 2) };
}
// Tampilkan QR di terminal. Mengembalikan true bila QR tampil, false bila
// terminal terlalu sempit — QR yang terpotong/ter-wrap TIDAK ditampilkan
// karena kelihatan seperti QR tapi tidak bisa di-scan (itu yang terjadi
// di Termux 56 kolom: QR 69 kolom ikut ter-wrap jadi rusak).
// Tangga adaptif: border putih besar (quiet 4) -> normal (2) -> hemat
// (EC level L, modul lebih sedikit) -> border minimal (1) -> braille
// (super ringkas, 1 karakter = 2x4 modul). Isi QR-nya tetap sama persis
// di semua varian, hanya ketahanan koreksi error & ukuran tampil beda.
function printQR(text, label) {
  const cols = process.stdout.columns || 80;
  const variants = [
    { ec: 'M', quiet: 4, note: '' },
    { ec: 'M', quiet: 2, note: '' },
    { ec: 'L', quiet: 2, note: ' (mode ringkas, EC level L, supaya muat di layar)' },
    { ec: 'L', quiet: 1, note: ' (mode ringkas, EC level L, border minimal)' },
  ];
  for (const v of variants) {
    const { lines, width } = qrLines(text, v.ec, v.quiet);
    if (width <= cols) {
      console.log('\n' + paint('bold', `📷 ${label} — scan dari layar ini:${v.note}`));
      for (const line of lines) {
        console.log('\x1b[47m\x1b[30m' + line + '\x1b[0m');
      }
      return true;
    }
  }
  const b = brailleLines(text);
  if (b.width <= cols) {
    console.log('\n' + paint('bold', `📷 ${label} — scan dari layar ini: (mode super ringkas, braille — kalau gagal scan, buka file PNG di ./out/)`));
    for (const line of b.lines) {
      console.log('\x1b[47m\x1b[30m' + line + '\x1b[0m');
    }
    return true;
  }
  console.log('\n' + warn(`Terminal terlalu sempit (${cols} kolom) untuk menampilkan QR ini — QR tidak ditampilkan supaya tidak rusak.`));
  console.log(paint('gray', '   Putar HP ke landscape / kecilkan font, atau scan file PNG-nya yang tersimpan di ./out/.'));
  return false;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- input
// Pembaca baris berbasis antrean: event 'line' disimpan dulu, jadi tidak
// ada jawaban yang hilang walau input (pipe/file/pty) datang lebih cepat
// dari prompt berikutnya. (Bug lama: flag stdinClosed dari event 'close'
// membuat semua ask() sesudah baris pertama langsung mengembalikan '',
// sehingga kriteria hunt jadi "apa saja".)
let rl = null;
let lineQueue = [];
let lineWaiters = [];
let stdinEnded = false;
function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      if (lineWaiters.length) lineWaiters.shift()(line);
      else lineQueue.push(line);
    });
    rl.on('close', () => {
      stdinEnded = true;
      while (lineWaiters.length) lineWaiters.shift()('');
    });
  }
  return rl;
}
function ask(q) {
  getRl();
  process.stdout.write(q);
  return new Promise((resolve) => {
    if (lineQueue.length) return resolve(lineQueue.shift().trim());
    if (stdinEnded) return resolve('');
    lineWaiters.push((line) => resolve(line.trim()));
  });
}
async function askChoice(q, valid) {
  for (;;) {
    if (stdinEnded && !lineQueue.length) return '0'; // input habis -> keluar
    const a = (await ask(q)).toLowerCase();
    if (!valid || valid.includes(a)) return a;
    console.log(err(`Pilihan tidak valid. Pilih: ${valid.join(', ')}`));
  }
}

// ------------------------------------------------- nama & email random
const NAMA_DEPAN = [
  'Agus', 'Budi', 'Siti', 'Dewi', 'Rudi', 'Ahmad', 'Putri', 'Andi', 'Rina',
  'Joko', 'Maya', 'Eko', 'Fitri', 'Hendra', 'Lestari', 'Rizky', 'Nina',
  'Fajar', 'Intan', 'Dedi', 'Wulan', 'Yoga', 'Ratna', 'Ilham', 'Sari',
  'Bagas', 'Tania', 'Rian', 'Kirana', 'Dimas', 'Ayu', 'Fikri', 'Nadia',
  'Galih', 'Citra', 'Raka', 'Laras', 'Bima', 'Anisa', 'Rangga', 'Dian',
];
const NAMA_BELAKANG = [
  'Santoso', 'Wijaya', 'Pratama', 'Kusuma', 'Saputra', 'Hidayat', 'Nugroho',
  'Setiawan', 'Gunawan', 'Ramadhan', 'Puspita', 'Anggraini', 'Firmansyah',
  'Maulana', 'Utama', 'Laksmana', 'Siregar', 'Halim', 'Wibowo', 'Maharani',
  'Pangestu', 'Rahmawati', 'Hakim', 'Salsabila', 'Permana', 'Utami',
  'Chandra', 'Nugraha', 'Fauzi', 'Hartono',
];
function randomName() {
  const depan = NAMA_DEPAN[Math.floor(Math.random() * NAMA_DEPAN.length)];
  const belakang = NAMA_BELAKANG[Math.floor(Math.random() * NAMA_BELAKANG.length)];
  return `${depan} ${belakang}`;
}
function randomEmail(name) {
  // awalan email = nama tanpa spasi, huruf kecil + @sir.my.id
  const prefix = name.toLowerCase().replace(/[^a-z]/g, '');
  return `${prefix}@sir.my.id`;
}

// ---------------------------------------------------------------- util
function saveB64Png(b64, filename) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, filename);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}
function saveJson(obj, filename) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, filename);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  return file;
}
function readHistory() {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs.readdirSync(OUT_DIR)
    .filter((f) => f.startsWith('order-') && f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));
}
function statusLabel(s) {
  if (s === 3) return paint('green', 'PAID');
  if (s === 2) return paint('yellow', 'Menunggu bayar');
  return paint('gray', `status=${s}`);
}
async function fetchEsimWithRetry(orderCode) {
  // esim/status: 1 = In-Progress (sudah paid, QR masih disiapkan),
  // 2 = Success. Coba lagi sampai QR siap (maks ~2 menit).
  for (let i = 1; i <= ESIM_MAX_TRIES; i++) {
    const res = await core.esimStatus(orderCode);
    if (res.status === 2 && res.qrCode) return res;
    if (res.status === 1) {
      console.log(paint('yellow', `   QR eSIM masih disiapkan server (In-Progress), coba lagi ${i}/${ESIM_MAX_TRIES}...`));
      if (i < ESIM_MAX_TRIES) await sleep(ESIM_RETRY_SECONDS * 1000);
      continue;
    }
    throw new Error(`QR eSIM belum tersedia: ${JSON.stringify(res).slice(0, 300)}`);
  }
  throw new Error('QR eSIM belum tersedia setelah menunggu ~2 menit. Coba lagi lewat menu "Ambil QR eSIM".');
}

async function watchOrder(orderId, orderCode) {
  const deadline = Date.now() + 10 * 60 * 1000; // QRIS 10 menit
  console.log(paint('cyan', `\nPolling status order ${orderId} tiap ${POLL_SECONDS} detik (maks ~10 menit)...`));
  for (;;) {
    const res = await core.paycheck(orderId);
    const now = new Date().toLocaleTimeString('id-ID');
    if (res.status === 3) {
      console.log(paint('green', `[${now}] PAID. Mengambil QR eSIM...`));
      const esim = await fetchEsimWithRetry(orderCode);
      const file = saveB64Png(esim.qrCode, `esim-${Date.now()}.png`);
      console.log('\n' + ok('QR eSIM didapat:'));
      printQR(esim.activation_code, 'QR eSIM');
      console.log(`   ${paint('bold', 'QR PNG          :')} ${file}`);
      console.log(`   ${paint('bold', 'Activation code :')} ${esim.activation_code}`);
      console.log(paint('yellow', '   (kode ini rahasia — jangan disebar)'));
      return { paid: true, qr_png: file, activation_code: esim.activation_code };
    }
    console.log(`[${now}] status=${res.status} (menunggu bayar)...`);
    if (Date.now() > deadline) {
      throw new Error('QRIS kedaluwarsa (10 menit) dan belum dibayar. Buat order baru.');
    }
    await sleep(POLL_SECONDS * 1000);
  }
}

// ---------------------------------------------------------------- menu
async function pickPackage() {
  section('Pilih Paket');
  const pkgs = await core.listPackages();
  pkgs.forEach((p, i) => {
    const disc = p.old_price ? paint('gray', ` (coret ${rupiah(p.old_price)})`) : '';
    console.log(`  ${paint('cyan', String(i + 1) + '.')} [${p.id}] ${paint('bold', p.name)} — ${paint('green', rupiah(p.price))}${disc}`);
  });
  const pick = await ask('\nPilih paket [1-9, default 1]: ');
  return pkgs[Number(pick || 1) - 1] || pkgs[0];
}

// Cari nomor manual: tampilkan daftar, pilih satu. null = batal.
async function manualPick(pkg) {
  for (;;) {
    const search = await ask('Cari digit nomor (min 3, Enter = acak): ');
    if (search && search.length < 3) { console.log(err('Minimal 3 digit.')); continue; }
    const all = [];
    for (const c of ['reg', 'platinum', 'gold', 'silver']) {
      all.push(...await core.listNumbers(pkg.id, c, search));
    }
    if (!all.length) { console.log(warn('Tidak ada nomor — coba digit lain.')); continue; }
    all.forEach((n, i) => {
      console.log(`  ${paint('cyan', String(i + 1) + '.')} ${paint('bold', n.number)}  [${n.label}] id=${n.id}`);
    });
    const sel = await ask('Pilih nomor [1-..], "r" acak lagi, "s" cari lagi, "batal" kembali: ');
    if (sel.toLowerCase() === 'batal') return null;
    if (sel.toLowerCase() === 'r' || sel.toLowerCase() === 's') continue;
    const chosen = all[Number(sel) - 1];
    if (!chosen) { console.log(err('Pilihan tidak ada.')); continue; }
    return chosen;
  }
}

// Pilih nomor (manual / hunt) + KONFIRMASI sebelum lanjut order.
// Mengembalikan nomor terpilih, atau null bila batal.
async function pickNumber(pkg) {
  section('Pilih Nomor');
  console.log(`Paket: ${paint('bold', pkg.name)} — ${paint('green', rupiah(pkg.price))}`);
  let mode = await askChoice('Cari nomor: [1] manual, [2] auto hunt nomor cantik: ', ['1', '2', '']);
  for (;;) {
    let chosen = null;
    if (mode === '2') chosen = await huntFlow(pkg);
    else chosen = await manualPick(pkg);
    if (!chosen) {
      const next = await askChoice('Nomor belum dipilih. [1] cari manual, [2] auto hunt, [0] batal kembali: ', ['1', '2', '0']);
      if (next === '0') return null;
      mode = next;
      continue;
    }
    console.log(`\nNomor terpilih: ${paint('bold', paint('green', chosen.number))} [${chosen.label}] id=${chosen.id}`);
    const conf = await ask('Pakai nomor ini? [Enter = ya, ketik "lagi" = cari nomor lain]: ');
    if (conf === '') return chosen;
    const next = await askChoice('Cari lagi: [1] manual, [2] auto hunt, [0] batal: ', ['1', '2', '0']);
    if (next === '0') return null;
    mode = next;
  }
}

async function huntFlow(pkg) {
  section('Auto Hunt Nomor Cantik');
  const digits = await ask('Jumlah digit (misal 11, atau 10,11,12 — Enter = apa saja): ');
  const prefix = await ask('Prefix (misal 0815,0855 — Enter = apa saja): ');
  const contains = await ask('Harus mengandung digit (misal 6666 — Enter = tidak ada): ');
  const ends = await ask('Harus berakhir dengan (misal 123 — Enter = tidak ada): ');
  const maxA = await ask('Maksimal percobaan [default 50]: ');
  const crit = {
    digits: new Set(digits.split(',').map((s) => Number(s.trim())).filter((n) => n > 0)),
    prefixes: prefix.split(',').map((s) => s.trim()).filter(Boolean),
    contains: contains.trim(),
    ends: ends.trim(),
  };
  const label = [
    crit.digits.size ? `digit: ${[...crit.digits].sort().join('/')}` : '',
    crit.prefixes.length ? `prefix: ${crit.prefixes.join(', ')}` : '',
    crit.contains ? `mengandung: ${crit.contains}` : '',
    crit.ends ? `berakhir: ${crit.ends}` : '',
  ].filter(Boolean).join(' | ') || 'apa saja';
  console.log(paint('cyan', `\n🎯 Kriteria: ${label}`));
  const res = await core.huntNumbers({
    packageId: pkg.id,
    categories: ['reg', 'platinum', 'gold', 'silver'],
    crit,
    maxAttempts: Number(maxA || 50),
    delayMs: 800,
    onProgress: ({ attempt, checked, hits, rateLimited: rl }) => {
      if (hits) return;
      if (rl) { process.stdout.write('\n' + warn('Kena throttle (429) — menunggu, lalu coba lagi...')); return; }
      process.stdout.write(`\r   percobaan ${attempt} — sudah cek ${checked} nomor, belum ketemu...`);
    },
  });
  process.stdout.write('\n');
  if (!res.hits.length) {
    console.log(err(res.rateLimited
      ? 'Berhenti karena server me-throttle (429). Tunggu beberapa menit, lalu coba lagi.'
      : `Tidak ketemu setelah ${res.attempts} percobaan (${res.checked} nomor dicek).`));
    return null;
  }
  console.log(ok(`Ketemu setelah ${res.attempts} percobaan (${res.checked} nomor dicek):`));
  res.hits.forEach((n, i) => {
    console.log(`  ${paint('cyan', String(i + 1) + '.')} ${paint('bold', n.number)}  [${n.label}] id=${n.id} (${n.number.length} digit)`);
  });
  if (res.hits.length === 1) return res.hits[0];
  const sel = await ask(`Pilih nomor [1-${res.hits.length}]: `);
  return res.hits[Number(sel) - 1] || res.hits[0];
}

async function inputNameEmail() {
  section('Data Pembeli');
  // --- Nama: manual atau random ---
  let name = '';
  const nameMode = await askChoice('Nama lengkap: [1] ketik manual, [2] random (nama Indonesia): ', ['1', '2', '']);
  if (nameMode === '2') {
    for (;;) {
      name = randomName();
      const use = await ask(`Nama random: ${paint('bold', name)} — pakai ini? [Enter = ya, "g" = ganti, ketik nama lain]: `);
      if (!use) break;
      if (use.toLowerCase() === 'g') continue;
      name = use;
      break;
    }
  } else {
    name = await ask('Nama lengkap: ');
  }
  if (name.length < 2) throw new Error('nama minimal 2 karakter.');
  // --- Email: manual atau random (tanpa konfirmasi email) ---
  let email = '';
  const emailMode = await askChoice('Email: [1] ketik manual, [2] random (nama tanpa spasi @sir.my.id): ', ['1', '2', '']);
  if (emailMode === '2') {
    email = randomEmail(name);
    console.log(`Email random: ${paint('bold', email)} (konfirmasi email otomatis diisi sama)`);
  } else {
    email = await ask('Email: ');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email tidak valid.');
  const phone = await ask('Nomor WhatsApp (opsional, Enter = kosong): ');
  if (phone && phone.length < 10) throw new Error('WhatsApp minimal 10 karakter bila diisi.');
  return { name, email, phone };
}

async function orderFlow(preselected) {
  let pkg, chosen;
  if (preselected) {
    // dari menu Hunt (nomor sudah dipilih + dikonfirmasi di sana)
    ({ pkg, chosen } = preselected);
    section('Order eSIM Baru');
    console.log(`Paket: ${paint('bold', pkg.name)} — ${paint('green', rupiah(pkg.price))}`);
    console.log(`Nomor: ${paint('bold', paint('green', chosen.number))} [${chosen.label}]`);
  } else {
    pkg = await pickPackage();
    chosen = await pickNumber(pkg);
    if (!chosen) {
      console.log(info('Dibatalkan — kembali ke menu utama.'));
      return;
    }
  }
  const { name, email, phone } = await inputNameEmail();
  console.log(`\n${paint('bold', 'Ringkasan:')} ${chosen.number} | ${pkg.name} ${rupiah(pkg.price)} | ${name} | ${email}`);
  const okCreate = await askChoice('Buat order QRIS nyata? (ya/tidak): ', ['ya', 'tidak']);
  if (okCreate !== 'ya') { console.log(info('Dibatalkan, tidak ada order yang dibuat.')); return; }

  const avail = await core.checkNumber(chosen.id);
  if (avail && avail.available === false) throw new Error(`nomor id ${chosen.id} sudah tidak tersedia.`);
  const created = await core.createOrder({
    numberId: chosen.id, name, phone, email, packageId: pkg.id,
  });
  const detail = await core.orderDetail(decodeURIComponent(created.order_code));
  const result = {
    order_id: detail.order_code,
    order_number: detail.order_number,
    package_name: detail.package_name,
    total_price: detail.total_price,
    order_code: decodeURIComponent(created.order_code),
    order_date: created.order_date,
    expire_minutes: created.expire,
    qris_raw: created.link,
  };
  result.qris_png = saveB64Png(created.qr_link, `qris-${result.order_id}.png`);
  saveJson(result, `order-${result.order_id}.json`);

  console.log('\n' + ok('Order dibuat (QRIS):'));
  console.log(`   ${paint('bold', 'Order ID :')} ${result.order_id}`);
  console.log(`   ${paint('bold', 'Nomor    :')} ${result.order_number} — ${result.package_name}`);
  console.log(`   ${paint('bold', 'Total    :')} ${paint('green', rupiah(result.total_price))} — QRIS berlaku ${result.expire_minutes} menit`);
  console.log(`   ${paint('bold', 'QR PNG   :')} ${result.qris_png}`);
  const qrShown = printQR(result.qris_raw, 'QRIS — scan pakai aplikasi pembayaran apa saja');
  if (!qrShown) {
    console.log(paint('bold', `   Scan file PNG-nya saja: ${result.qris_png}`));
  }
  console.log(paint('gray', `   QRIS raw: ${result.qris_raw}`));
  const goWatch = await askChoice('\nSudah bayar? Lanjut polling status sampai paid? (ya/tidak): ', ['ya', 'tidak']);
  if (goWatch === 'ya') await watchOrder(result.order_id, result.order_code);
  else {
    console.log(info('Nanti bisa lanjut dari menu "Riwayat Pesanan" atau jalankan:'));
    console.log(paint('gray', `   node im3-esim.js watch --order-id ${result.order_id} --order-code "${result.order_code}"`));
  }
}

async function packagesMenu() {
  section('Paket eSIM IM3');
  const pkgs = await core.listPackages();
  pkgs.forEach((p, i) => {
    const disc = p.old_price ? paint('gray', ` (coret ${rupiah(p.old_price)})`) : '';
    console.log(`  ${paint('cyan', String(i + 1) + '.')} [${p.id}] ${paint('bold', p.name)} — ${paint('green', rupiah(p.price))}${disc}`);
  });
}

async function statusMenu() {
  section('Cek Status Order');
  const orderId = await ask('Order ID (misal 950002009xxx): ');
  if (!orderId) return;
  const res = await core.paycheck(orderId);
  console.log(`\nOrder ${res.code}: ${statusLabel(res.status)} (status=${res.status})`);
}

async function esimMenu() {
  section('Ambil QR eSIM');
  const orderCode = await ask('Order code (dari hasil order, diawali huruf acak): ');
  if (!orderCode) return;
  console.log(info('Mengambil QR eSIM (retry otomatis bila masih In-Progress)...'));
  const esim = await fetchEsimWithRetry(orderCode);
  const file = saveB64Png(esim.qrCode, `esim-${Date.now()}.png`);
  console.log('\n' + ok('QR eSIM didapat:'));
  printQR(esim.activation_code, 'QR eSIM');
  console.log(`   ${paint('bold', 'QR PNG          :')} ${file}`);
  console.log(`   ${paint('bold', 'Activation code :')} ${esim.activation_code}`);
  console.log(paint('yellow', '   (kode ini rahasia — jangan disebar)'));
}

async function historyMenu() {
  section('Riwayat Pesanan');
  const orders = readHistory();
  if (!orders.length) {
    console.log(info('Belum ada order tersimpan di ./out/. Order yang dibuat lewat menu ini akan tercatat di sini.'));
    return;
  }
  orders.forEach((o, i) => {
    console.log(`  ${paint('cyan', String(i + 1) + '.')} ${paint('bold', o.order_id)} — ${o.order_number} | ${o.package_name} | ${paint('green', rupiah(o.total_price))} | ${o.order_date || ''}`);
  });
  const sel = await ask('\nPilih order untuk detail [Enter = kembali]: ');
  if (!sel) return;
  const o = orders[Number(sel) - 1];
  if (!o) { console.log(err('Pilihan tidak ada.')); return; }
  console.log(`\n${paint('bold', 'Order ID')}   : ${o.order_id}`);
  console.log(`${paint('bold', 'Nomor')}      : ${o.order_number} — ${o.package_name}`);
  console.log(`${paint('bold', 'Total')}      : ${rupiah(o.total_price)} | dibuat ${o.order_date || '-'}`);
  console.log(`${paint('bold', 'QR QRIS')}    : ${o.qris_png || '-'}`);
  const act = await askChoice('Aksi: [1] cek status, [2] lanjut polling sampai paid, [3] ambil QR eSIM, [Enter] kembali: ', ['1', '2', '3', '']);
  if (act === '1') {
    const res = await core.paycheck(o.order_id);
    console.log(`\nOrder ${res.code}: ${statusLabel(res.status)} (status=${res.status})`);
  } else if (act === '2') {
    await watchOrder(o.order_id, o.order_code);
  } else if (act === '3') {
    const esim = await fetchEsimWithRetry(o.order_code);
    const file = saveB64Png(esim.qrCode, `esim-${Date.now()}.png`);
    console.log('\n' + ok('QR eSIM didapat:'));
    printQR(esim.activation_code, 'QR eSIM');
    console.log(`   ${paint('bold', 'QR PNG          :')} ${file}`);
    console.log(`   ${paint('bold', 'Activation code :')} ${esim.activation_code}`);
  }
}

async function paymentHistoryMenu() {
  section('Riwayat Pembayaran');
  const orders = readHistory();
  if (!orders.length) {
    console.log(info('Belum ada order tersimpan di ./out/.'));
    return;
  }
  console.log(paint('gray', 'Mengecek status tiap order ke server...'));
  for (const o of orders) {
    try {
      const res = await core.paycheck(o.order_id);
      let note = '';
      if (res.status !== 3 && o.order_date) {
        const made = new Date(o.order_date.replace(' ', 'T') + '+07:00').getTime();
        if (!Number.isNaN(made) && Date.now() > made + 10 * 60 * 1000) {
          note = paint('red', ' (QRIS kedaluwarsa)');
        }
      }
      console.log(`  ${paint('bold', o.order_id)} — ${o.order_number} | ${o.package_name} | ${paint('green', rupiah(o.total_price))} → ${statusLabel(res.status)}${note}`);
    } catch (e) {
      console.log(`  ${paint('bold', o.order_id)} — ${err('gagal cek: ' + (e.message || e).split('\n')[0])}`);
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------- main
async function mainMenu() {
  banner();
  for (;;) {
    console.log(`
${paint('bold', 'MENU UTAMA')}
  ${paint('cyan', '1.')} 🛒  Order eSIM Baru
  ${paint('cyan', '2.')} 🎯  Hunt Nomor Cantik
  ${paint('cyan', '3.')} 📦  Lihat Paket eSIM
  ${paint('cyan', '4.')} 🔍  Cek Status Order
  ${paint('cyan', '5.')} 📱  Ambil QR eSIM (order sudah paid)
  ${paint('cyan', '6.')} 📋  Riwayat Pesanan
  ${paint('cyan', '7.')} 💰  Riwayat Pembayaran
  ${paint('cyan', '0.')} 🚪  Keluar
`);
    const choice = await askChoice(paint('bold', 'Pilih [0-7]: '), ['0', '1', '2', '3', '4', '5', '6', '7']);
    try {
      if (choice === '0') {
        console.log(paint('green', '\nSampai jumpa! 👋'));
        break;
      }
      if (choice === '1') await orderFlow();
      else if (choice === '2') {
        const pkg = await pickPackage();
        for (;;) {
          const hit = await huntFlow(pkg);
          if (!hit) { console.log(info('Tidak ketemu — kembali ke menu utama.')); break; }
          console.log(`\nNomor ketemu: ${paint('bold', paint('green', hit.number))} [${hit.label}] id=${hit.id} (${hit.number.length} digit)`);
          const act = await askChoice('Lanjut: [1] order dengan nomor ini, [2] hunt lagi, [0] kembali ke menu: ', ['1', '2', '0']);
          if (act === '1') { await orderFlow({ pkg, chosen: hit }); break; }
          if (act === '0') break;
          // '2' -> hunt lagi dengan kriteria baru
        }
      }
      else if (choice === '3') await packagesMenu();
      else if (choice === '4') await statusMenu();
      else if (choice === '5') await esimMenu();
      else if (choice === '6') await historyMenu();
      else if (choice === '7') await paymentHistoryMenu();
    } catch (e) {
      console.log('\n' + err(e && e.message ? e.message.split('\n')[0] : String(e)));
    }
    if (choice !== '0') {
      await ask(paint('gray', '\nTekan Enter untuk kembali ke menu...'));
      banner();
    }
  }
  if (rl) rl.close();
}

if (require.main === module) {
  mainMenu().catch((e) => {
    console.error('\n' + err(e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

module.exports = { mainMenu, randomName, randomEmail, printQR, qrLines, brailleLines };
