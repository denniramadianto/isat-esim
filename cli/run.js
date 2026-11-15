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
const HASIL_DIR = path.join(__dirname, 'hasil'); // hasil akhir order (txt + PNG eSIM)
const ESIM_VALID_DAYS = 45; // eSIM biasanya kedaluwarsa 45 hari setelah order
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

// ------------------------------------------------- hasil eSIM (folder hasil/)
const fmtWIB = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function fmtDateWIB(d) {
  if (!d) return '-';
  return fmtWIB.format(d).replace(/\./g, ':') + ' WIB';
}
function parseOrderDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + '+07:00');
  return Number.isNaN(d.getTime()) ? null : d;
}
function expiryDate(orderDate) {
  const d = parseOrderDate(orderDate);
  if (!d) return null;
  return new Date(d.getTime() + ESIM_VALID_DAYS * 24 * 60 * 60 * 1000);
}
// Simpan hasil eSIM ke folder hasil/ dengan NAMA FILE SAMA:
//   hasil/esim-<order_id>.png  (QR eSIM)
//   hasil/esim-<order_id>.txt  (data eSIM: nomor, paket, tanggal, expired, kode aktivasi)
function saveEsimResult({ orderId, orderNumber, packageName, orderDate, activationCode, qrCode }) {
  fs.mkdirSync(HASIL_DIR, { recursive: true });
  const base = `esim-${orderId}`;
  const pngFile = path.join(HASIL_DIR, `${base}.png`);
  fs.writeFileSync(pngFile, Buffer.from(qrCode, 'base64'));
  const made = parseOrderDate(orderDate);
  const exp = expiryDate(orderDate);
  const txt = [
    'eSIM IM3 — data aktivasi',
    '=========================',
    `Nomor          : ${orderNumber || '-'}`,
    `Paket          : ${packageName || '-'}`,
    `Order ID       : ${orderId}`,
    `Tanggal order  : ${made ? fmtDateWIB(made) : (orderDate || '-')}`,
    `Berlaku sampai : ${exp ? fmtDateWIB(exp) + ' (45 hari dari order)' : '±45 hari dari tanggal order'}`,
    '',
    `Activation code: ${activationCode}`,
    '',
    'Cara pakai: scan QR di file PNG-nya (namanya sama dengan file ini),',
    'atau masukkan activation code manual di HP (Tambah eSIM).',
    'Kode ini rahasia — jangan disebar.',
    '',
  ].join('\n');
  const txtFile = path.join(HASIL_DIR, `${base}.txt`);
  fs.writeFileSync(txtFile, txt);
  return { pngFile, txtFile };
}
function showEsimDates(orderDate) {
  const exp = expiryDate(orderDate);
  console.log(`   ${paint('bold', 'Tanggal order  :')} ${orderDate || '-'}`);
  console.log(`   ${paint('bold', 'Berlaku sampai :')} ${exp ? fmtDateWIB(exp) + ' (45 hari)' : '±45 hari dari tanggal order'}`);
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
  if (s === 21) return paint('red', 'QRIS kedaluwarsa');
  return paint('gray', `status=${s}`);
}
// Status bayar sebuah order tersimpan: pakai yang tersimpan di JSON bila
// ada (ditulis watchOrder saat PAID), kalau tidak cek langsung ke server.
async function resolveOrderStatus(o) {
  if (o.payment_status === 3) return 3;
  try {
    const res = await core.paycheck(o.order_id);
    return res.status;
  } catch {
    return o.payment_status || 0;
  }
}
// QRIS berlaku 10 menit dari tanggal order — lewat dari itu, order yang
// belum dibayar sudah kedaluwarsa dan tidak akan pernah punya QR eSIM.
// Server sendiri mengembalikan status 21 untuk order yang kedaluwarsa
// (teramati di Riwayat Pembayaran, 15 Nov 2026).
function isExpiredUnpaid(o, status) {
  if (status === 3) return false;
  if (status === 21) return true;
  const made = parseOrderDate(o.order_date);
  if (!made) return false;
  return Date.now() > made.getTime() + 10 * 60 * 1000;
}
// Catat status PAID ke file order-*.json supaya menu lain tidak perlu
// cek server terus untuk order yang sama.
function markOrderPaid(orderId) {
  try {
    const jf = path.join(OUT_DIR, `order-${orderId}.json`);
    if (!fs.existsSync(jf)) return;
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    j.payment_status = 3;
    j.paid_at = new Date().toISOString();
    fs.writeFileSync(jf, JSON.stringify(j, null, 2) + '\n');
  } catch { /* abaikan — status tetap bisa dicek live */ }
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

async function watchOrder(orderId, orderCode, meta = {}) {
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
      if (meta.orderNumber) console.log(`   ${paint('bold', 'Nomor           :')} ${meta.orderNumber} — ${meta.packageName || ''}`);
      showEsimDates(meta.orderDate);
      console.log(`   ${paint('bold', 'Activation code :')} ${esim.activation_code}`);
      const saved = saveEsimResult({
        orderId, orderNumber: meta.orderNumber, packageName: meta.packageName,
        orderDate: meta.orderDate, activationCode: esim.activation_code, qrCode: esim.qrCode,
      });
      console.log(`   ${paint('bold', 'Hasil tersimpan :')} ${saved.txtFile}`);
      console.log(`                     ${saved.pngFile}`);
      console.log(paint('yellow', '   (kode ini rahasia — jangan disebar)'));
      markOrderPaid(orderId);
      return { paid: true, qr_png: file, activation_code: esim.activation_code, ...saved };
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

// ---------------------------------------------------------------- Quick Order
const QUICK_MAX = 10; // maks eSIM sekali jalan (jaga-jaga: jangan spam create order)
const CREATE_DELAY_MS = 6500; // jeda antar create order (batas server: ~1 order / 6 dtk)

// Ambil satu nomor acak yang tersedia: 1 batch per kategori, acak urutan,
// cek satu-satu sampai ketemu yang available (maks 8 cek per batch).
async function pickRandomNumber(pkg) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const all = [];
    for (const c of ['reg', 'platinum', 'gold', 'silver']) {
      all.push(...await core.listNumbers(pkg.id, c, ''));
    }
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    for (const cand of all.slice(0, 8)) {
      try {
        const r = await core.checkNumber(cand.id);
        if (r && r.available !== false) return cand;
      } catch { /* lanjut ke kandidat berikut */ }
    }
  }
  return null;
}

// Polling SEMUA order quick order secara paralel (per ronde): tiap order
// dicek statusnya; yang sudah PAID langsung diambil QR eSIM-nya, yang
// kedaluwarsa (status 21 / lewat 10 menit) ditutup. Berhenti bila semua
// order sudah beres atau batas 10 menit lewat.
async function watchQuickOrders(orders) {
  section('Cek Pembayaran');
  console.log(paint('gray', `Mengecek ${orders.length} order tiap ${POLL_SECONDS} detik sampai semuanya paid / QRIS kedaluwarsa (maks ~10 menit).`));
  const state = orders.map((o) => ({ ...o, status: 2, done: false }));
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    for (const o of state) {
      if (o.done) continue;
      try {
        const res = await core.paycheck(o.order_id);
        o.status = res.status;
      } catch { /* gagal cek — tetap pending, coba lagi ronde berikut */ }
      const now = new Date().toLocaleTimeString('id-ID');
      if (o.status === 3) {
        console.log(paint('green', `\n[${now}] PAID — ${o.order_number} (Order ${o.order_id}). Mengambil QR eSIM...`));
        try {
          const esim = await fetchEsimWithRetry(o.order_code);
          const file = saveB64Png(esim.qrCode, `esim-${Date.now()}.png`);
          console.log(ok(`QR eSIM didapat: ${o.order_number}`));
          printQR(esim.activation_code, `QR eSIM — ${o.order_number}`);
          console.log(`   ${paint('bold', 'QR PNG          :')} ${file}`);
          showEsimDates(o.order_date);
          console.log(`   ${paint('bold', 'Activation code :')} ${esim.activation_code}`);
          const saved = saveEsimResult({
            orderId: o.order_id, orderNumber: o.order_number, packageName: o.package_name,
            orderDate: o.order_date, activationCode: esim.activation_code, qrCode: esim.qrCode,
          });
          console.log(`   ${paint('bold', 'Hasil tersimpan :')} ${saved.txtFile}`);
          markOrderPaid(o.order_id);
        } catch (e) {
          console.log(err(`QR eSIM ${o.order_number} gagal diambil: ${(e.message || e).split('\n')[0]} — ambil lagi lewat menu "Ambil QR eSIM".`));
        }
        o.done = true;
      } else if (o.status === 21 || isExpiredUnpaid(o, o.status)) {
        console.log(paint('red', `\n[${now}] QRIS kedaluwarsa — ${o.order_number} (Order ${o.order_id}).`));
        o.done = true;
      }
      await sleep(300);
    }
    if (state.every((o) => o.done)) break;
    if (Date.now() > deadline) {
      for (const o of state.filter((x) => !x.done)) {
        console.log(warn(`Waktu habis — ${o.order_number} (Order ${o.order_id}) belum terbayar.`));
      }
      break;
    }
    const now = new Date().toLocaleTimeString('id-ID');
    console.log(paint('gray', `[${now}] masih menunggu: ${state.filter((o) => !o.done).map((o) => o.order_number).join(', ')}`));
    await sleep(POLL_SECONDS * 1000);
  }
  section('Ringkasan Quick Order');
  for (const o of state) {
    const st = o.status === 3 ? paint('green', 'PAID ✅') : paint('red', 'tidak terbayar / kedaluwarsa');
    console.log(`  ${paint('bold', o.order_number)} — ${o.package_name} | Order ${o.order_id} → ${st}`);
  }
}

// Menu 1 — Quick Order: sekali jalan, N eSIM sekaligus, semuanya otomatis
// (nomor acak, nama + email random). QRIS tiap order langsung tampil di
// terminal, lalu semua order dipolling bareng sampai paid / kedaluwarsa.
// Perhatian: mengetik jumlah di sini = konfirmasi membuat order NYATA
// (Rp1 per eSIM paket default) — tidak ada konfirmasi kedua, sesuai
// permintaan "sekali klik langsung otomatis semua".
async function quickOrder() {
  section('⚡ Quick Order');
  const pkgs = await core.listPackages();
  const pkg = pkgs.find((p) => p.id === 4324) || pkgs[0]; // default: Perdana eSIM 5GB Rp1
  const nRaw = await ask(`Berapa eSIM yang mau dibuat sekaligus? [1-${QUICK_MAX}, Enter = 1]: `);
  const n = Math.min(Math.max(Number(nRaw || 1) || 1, 1), QUICK_MAX);
  console.log(`\n${paint('bold', 'Rencana:')} ${n}x ${paint('bold', pkg.name)} — ${paint('green', rupiah(pkg.price))} (total ${paint('green', rupiah(pkg.price * n))})`);
  console.log(paint('gray', 'Nomor, nama, dan email dipilih otomatis (random). QRIS tiap order tampil langsung di sini, lalu dicek pembayarannya bareng-bareng.'));
  console.log(paint('yellow', 'Order NYATA langsung dibuat — tidak ada konfirmasi kedua.'));
  // ---- fase 1: buat semua order ----
  const orders = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      console.log(paint('gray', `\nJeda ${CREATE_DELAY_MS / 1000} dtk sebelum order berikut (batas server: ~1 order / 6 dtk)...`));
      await sleep(CREATE_DELAY_MS);
    }
    console.log(paint('cyan', `\n── Order ${i + 1}/${n} ──`));
    const chosen = await pickRandomNumber(pkg);
    if (!chosen) { console.log(err(`Order ${i + 1}: tidak dapat nomor — lewati.`)); continue; }
    const name = randomName();
    const email = randomEmail(name);
    console.log(`Nomor: ${paint('bold', chosen.number)} [${chosen.label}] | Nama: ${name} | Email: ${email}`);
    const created = await core.createOrder({
      numberId: chosen.id, name, phone: '', email, packageId: pkg.id,
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
    console.log(ok(`Order ${i + 1} dibuat: ${result.order_number} — Order ${result.order_id} — ${rupiah(result.total_price)}`));
    const qrShown = printQR(result.qris_raw, `QRIS ${i + 1}/${n} — ${result.order_number} (berlaku ${result.expire_minutes} menit)`);
    if (!qrShown) console.log(paint('bold', `   Scan file PNG-nya: ${result.qris_png}`));
    orders.push(result);
  }
  if (!orders.length) { console.log(err('Tidak ada order yang berhasil dibuat.')); return; }
  // ---- fase 2: cek pembayaran semua order bareng-bareng ----
  await watchQuickOrders(orders);
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
  const goWatch = await askChoice('\nSudah bayar? Lanjut polling status sampai paid? (ya/tidak, Enter = ya): ', ['ya', 'tidak', '']);
  if (goWatch === 'ya' || goWatch === '') {
    await watchOrder(result.order_id, result.order_code, {
      orderNumber: result.order_number, packageName: result.package_name, orderDate: result.order_date,
    });
  }
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
  const orders = readHistory();
  let orderCode = '';
  let meta = {};
  if (orders.length) {
    // Hanya order yang SUDAH DIBAYAR yang bisa diambil QR eSIM-nya.
    // Order yang belum dibayar / QRIS-nya kedaluwarsa tidak punya QR eSIM,
    // jadi ditampilkan terpisah dan tidak bisa dipilih.
    console.log(paint('gray', 'Mengecek status bayar tiap order...'));
    const paid = [];
    const unpaid = [];
    for (const o of orders) {
      const st = await resolveOrderStatus(o);
      (st === 3 ? paid : unpaid).push({ ...o, _status: st });
      await sleep(300);
    }
    if (paid.length) {
      console.log(paint('bold', '\nSudah dibayar — bisa diambil QR eSIM-nya:'));
      paid.forEach((o, i) => {
        console.log(`  ${paint('cyan', String(i + 1) + '.')} ${paint('bold', o.order_number)} — ${o.package_name} | Order ${o.order_id} | ${o.order_date || ''}`);
      });
    } else {
      console.log(warn('Belum ada order yang sudah dibayar.'));
    }
    if (unpaid.length) {
      console.log(paint('gray', '\nBelum bisa diambil QR-nya (tidak bisa dipilih):'));
      unpaid.forEach((o) => {
        const note = isExpiredUnpaid(o, o._status) ? 'QRIS kedaluwarsa' : 'menunggu bayar';
        console.log(paint('gray', `  • ${o.order_number} — ${o.package_name} | Order ${o.order_id} | ${o.order_date || ''} (${note})`));
      });
    }
    if (!paid.length) return;
    const sel = await ask('\nPilih nomor [1-..], atau ketik order code langsung, [Enter] kembali: ');
    if (!sel) return;
    const picked = paid[Number(sel) - 1];
    if (picked) {
      orderCode = picked.order_code;
      meta = { orderId: picked.order_id, orderNumber: picked.order_number, packageName: picked.package_name, orderDate: picked.order_date };
    } else {
      orderCode = sel; // dianggap order code yang diketik manual
    }
  } else {
    console.log(info('Belum ada order tersimpan di ./out/.'));
    orderCode = await ask('Order code (dari hasil order, diawali huruf acak): ');
    if (!orderCode) return;
  }
  console.log(info('Mengambil QR eSIM (retry otomatis bila masih In-Progress)...'));
  const esim = await fetchEsimWithRetry(orderCode);
  if (!meta.orderId) {
    // order tidak ada di riwayat: coba ambil datanya dari server
    try {
      const d = await core.orderDetail(orderCode);
      meta = { orderId: d.order_code, orderNumber: d.order_number, packageName: d.package_name, orderDate: d.order_date };
    } catch { /* abaikan — tanggal & nomor tetap kosong */ }
  }
  const orderId = meta.orderId || String(Date.now());
  const file = saveB64Png(esim.qrCode, `esim-${Date.now()}.png`);
  console.log('\n' + ok('QR eSIM didapat:'));
  printQR(esim.activation_code, 'QR eSIM');
  console.log(`   ${paint('bold', 'QR PNG          :')} ${file}`);
  if (meta.orderNumber) console.log(`   ${paint('bold', 'Nomor           :')} ${meta.orderNumber} — ${meta.packageName || ''}`);
  showEsimDates(meta.orderDate);
  console.log(`   ${paint('bold', 'Activation code :')} ${esim.activation_code}`);
  const saved = saveEsimResult({
    orderId, orderNumber: meta.orderNumber, packageName: meta.packageName,
    orderDate: meta.orderDate, activationCode: esim.activation_code, qrCode: esim.qrCode,
  });
  console.log(`   ${paint('bold', 'Hasil tersimpan :')} ${saved.txtFile}`);
  console.log(`                     ${saved.pngFile}`);
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
    await watchOrder(o.order_id, o.order_code, {
      orderNumber: o.order_number, packageName: o.package_name, orderDate: o.order_date,
    });
  } else if (act === '3') {
    const esim = await fetchEsimWithRetry(o.order_code);
    const file = saveB64Png(esim.qrCode, `esim-${Date.now()}.png`);
    console.log('\n' + ok('QR eSIM didapat:'));
    printQR(esim.activation_code, 'QR eSIM');
    console.log(`   ${paint('bold', 'QR PNG          :')} ${file}`);
    console.log(`   ${paint('bold', 'Nomor           :')} ${o.order_number} — ${o.package_name}`);
    showEsimDates(o.order_date);
    console.log(`   ${paint('bold', 'Activation code :')} ${esim.activation_code}`);
    const saved = saveEsimResult({
      orderId: o.order_id, orderNumber: o.order_number, packageName: o.package_name,
      orderDate: o.order_date, activationCode: esim.activation_code, qrCode: esim.qrCode,
    });
    console.log(`   ${paint('bold', 'Hasil tersimpan :')} ${saved.txtFile}`);
    console.log(`                     ${saved.pngFile}`);
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

// ---------------------------------------------------------------- database nomor cantik
async function dbMenu() {
  section('💎 Database Nomor Cantik');
  const sum = core.summarizeDb(core.loadDb());
  console.log(`Total tersimpan: ${paint('bold', String(sum.total))} nomor ` +
    `(${(sum.byDigits['10'] || 0)}x 10 digit, ${(sum.byDigits['11'] || 0)}x 11 digit, ` +
    `${(sum.byDigits['12'] || 0)}x 12 digit; ` +
    `${(sum.byPattern.triple || 0)} triple, ${(sum.byPattern.quartet || 0)} quartet)`);
  console.log(paint('gray', 'Nomor di sini hanya ID yang pernah terlihat — sebelum order, ketersediaan dicek ulang ke server.'));
  const act = await askChoice('Pilih: [1] harvest sekarang, [2] lihat nomor, [3] order nomor dari database, [0] kembali: ', ['1', '2', '3', '0']);
  if (act === '1') {
    const roundsRaw = await ask('Berapa putaran sapuan? [1 putaran ≈ 40 panggilan, Enter = 1, ketik "loop" = jalan terus sampai Ctrl+C]: ');
    const loop = roundsRaw.toLowerCase() === 'loop';
    const rounds = loop ? 1 : Math.max(Number(roundsRaw || 1) || 1, 1);
    console.log(paint('gray', loop
      ? 'Mode LOOP — putaran berulang tiap 5 menit sampai Ctrl+C. Database tersimpan tiap putaran.'
      : `Menyapu ${rounds} putaran...`));
    await core.harvestNumbers({
      rounds, loop, intervalSec: 300, delayMs: 500,
      onProgress: (p) => {
        if (p.roundDone) {
          process.stdout.write(`\n   putaran ${p.round} selesai — baru: ${p.newFound} nomor, total dicek: ${p.checked}`);
          return;
        }
        if (p.rateLimited) {
          process.stdout.write('\n   ⚠️ kena throttle (429) — menunggu, lalu coba lagi...');
          return;
        }
        process.stdout.write(`\r   putaran ${p.round} — kata kunci "${p.term}" — dicek ${p.checked}, baru ${p.newFound}...`);
      },
    });
    const s2 = core.summarizeDb(core.loadDb());
    console.log(`\n${ok(`Database sekarang: ${s2.total} nomor ` +
      `(${(s2.byDigits['10'] || 0)}x 10 digit, ${(s2.byDigits['11'] || 0)}x 11 digit, ` +
      `${(s2.byDigits['12'] || 0)}x 12 digit; ` +
      `${(s2.byPattern.triple || 0)} triple, ${(s2.byPattern.quartet || 0)} quartet).`)}`);
  } else if (act === '2') {
    const digitsRaw = await ask('Filter digit (10, 11, 12 — Enter = semua): ');
    const pattern = (await ask('Filter pola (triple / quartet — Enter = semua): ')).toLowerCase();
    const digits = new Set(digitsRaw.split(',').map((s) => Number(s.trim())).filter((n) => n > 0));
    const list = core.queryDb(core.loadDb(), {
      digits, pattern: pattern === 'triple' || pattern === 'quartet' ? pattern : null, limit: 50,
    });
    if (!list.length) { console.log(info('Tidak ada nomor yang cocok — harvest dulu.')); return; }
    console.log(paint('gray', `Menampilkan ${list.length} nomor (maks 50):`));
    list.forEach((e, i) => {
      const avail = e.available === true ? paint('green', 'tersedia')
        : e.available === false ? paint('red', 'tidak tersedia') : paint('gray', 'belum dicek');
      console.log(`  ${paint('cyan', String(i + 1) + '.')} ${paint('bold', e.number)} (${e.digits} digit, ${e.pattern}: ${e.runs.join(',')}) [${e.category}] id=${e.id} — ${avail}`);
    });
  } else if (act === '3') {
    const list = core.queryDb(core.loadDb(), { limit: 50 });
    if (!list.length) { console.log(info('Database kosong — harvest dulu (pilihan 1).')); return; }
    list.forEach((e, i) => {
      console.log(`  ${paint('cyan', String(i + 1) + '.')} ${paint('bold', e.number)} (${e.digits} digit, ${e.pattern}: ${e.runs.join(',')}) [${e.category}] id=${e.id}`);
    });
    const sel = await ask('\nPilih nomor [1-..], [Enter] kembali: ');
    if (!sel) return;
    const picked = list[Number(sel) - 1];
    if (!picked) { console.log(err('Pilihan tidak ada.')); return; }
    console.log(paint('gray', 'Mengecek ketersediaan nomor ke server...'));
    const avail = await core.checkNumber(picked.id);
    if (avail && avail.available === false) {
      console.log(err(`Nomor ${picked.number} sudah tidak tersedia — dihapus dari database.`));
      const db = core.loadDb();
      db.numbers = db.numbers.filter((e) => e.number !== picked.number);
      core.saveDb(db);
      return;
    }
    console.log(ok(`Nomor ${picked.number} masih tersedia — lanjut order.`));
    const pkgs = await core.listPackages();
    const pkg = pkgs.find((p) => p.id === picked.package_id) || pkgs[0];
    await orderFlow({ pkg, chosen: { id: picked.id, number: picked.number, label: picked.category } });
  }
}

// ---------------------------------------------------------------- main
async function mainMenu() {
  banner();
  for (;;) {
    console.log(`
${paint('bold', 'MENU UTAMA')}
  ${paint('cyan', '1.')} ⚡  Quick Order (otomatis, bisa banyak)
  ${paint('cyan', '2.')} 🛒  Order eSIM Baru
  ${paint('cyan', '3.')} 🎯  Hunt Nomor Cantik
  ${paint('cyan', '4.')} 📦  Lihat Paket eSIM
  ${paint('cyan', '5.')} 🔍  Cek Status Order
  ${paint('cyan', '6.')} 📱  Ambil QR eSIM (order sudah paid)
  ${paint('cyan', '7.')} 📋  Riwayat Pesanan
  ${paint('cyan', '8.')} 💰  Riwayat Pembayaran
  ${paint('cyan', '9.')} 💎  Database Nomor Cantik
  ${paint('cyan', '0.')} 🚪  Keluar
`);
    const choice = await askChoice(paint('bold', 'Pilih [0-9]: '), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    try {
      if (choice === '0') {
        console.log(paint('green', '\nSampai jumpa! 👋'));
        break;
      }
      if (choice === '1') await quickOrder();
      else if (choice === '2') await orderFlow();
      else if (choice === '3') {
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
      else if (choice === '4') await packagesMenu();
      else if (choice === '5') await statusMenu();
      else if (choice === '6') await esimMenu();
      else if (choice === '7') await historyMenu();
      else if (choice === '8') await paymentHistoryMenu();
      else if (choice === '9') await dbMenu();
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

module.exports = { mainMenu, randomName, randomEmail, printQR, qrLines, brailleLines, saveEsimResult, expiryDate, parseOrderDate };
