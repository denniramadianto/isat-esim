#!/usr/bin/env node
/**
 * im3-esim.js — CLI order eSIM IM3 (im3shop.ioh.co.id) tanpa dependensi.
 *
 * Endpoint terverifikasi dari HAR 1-4 (15 Nov 2026), lihat
 * ../api-endpoints-from-har.md. Tanpa login, tanpa cookie/auth.
 *
 * Alur: paket -> cari nomor -> validasi nomor -> create order (QRIS)
 *   -> polling paycheck sampai status 3 (paid) -> ambil QR eSIM.
 *
 * Pemakaian:
 *   node im3-esim.js run                      # wizard interaktif
 *   node im3-esim.js packages [--json]
 *   node im3-esim.js numbers --package 4324 [--search 123] [--category reg] [--json]
 *   node im3-esim.js hunt --package 4324 --digits 11 --prefix 0815,0855
 *       [--contains 6666] [--ends 123] [--max-attempts 50] [--json]
 *   node im3-esim.js order --package 4324 --number-id 6556262 \
 *       --name "Indira" --email "a@b.id" [--phone 08...] --confirm [--json]
 *   node im3-esim.js status --order-id 950002009xxx [--json]
 *   node im3-esim.js esim --order-code "<order_code dari create>" [--json]
 *   node im3-esim.js watch --order-id 950002009xxx --order-code "<...>" [--json]
 *
 * PERINGATAN: `order` membuat order QRIS NYATA (Rp1 untuk paket 5GB).
 * File out/order-*.json memuat activation_code eSIM — JANGAN disebar.
 * Butuh Node >= 18 (fetch bawaan). Tidak ada `npm install`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const BASE = 'https://im3shop.ioh.co.id';
const OUT_DIR = path.join(__dirname, 'out');
const UTM = 'utm_campaign=none&utm_medium=mobile&utm_source=direct&utm_term=none&utm_content=';
const AGENT_KEY = 'utm_campaign:none,utm_medium:mobile,utm_source:direct,utm_term:none,utm_content:none';
const SOF_QRIS = '117'; // key QRIS dari POST /api/payment/method/ESIMPRE
const CATEGORIES = [
  { key: 'reg', label: 'Regular' },
  { key: 'platinum', label: 'Kembar' },
  { key: 'gold', label: 'Premium' },
  { key: 'silver', label: 'Spesial 11.11' },
];
const POLL_SECONDS = 20;

// ---------------------------------------------------------------- helpers
function genSessionId() {
  // client-side, ~20 karakter alnum (contoh HAR: "1a7wg293v0g961424850207").
  return (
    Math.random().toString(36).slice(2, 12) +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 6)
  );
}

function headers(referer) {
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/json; charset=UTF-8',
    Origin: BASE,
    Referer: referer || `${BASE}/esim/order/prepaid`,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  };
}

async function api(method, url, body, referer) {
  const res = await fetch(url, {
    method,
    headers: headers(referer),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${method} ${url}\n${text.slice(0, 500)}`);
    err.status = res.status;
    // Server mengirim Retry-After (detik) saat 429; kalau tidak ada, pakai 10.
    err.retryAfterSec = Number(res.headers.get('retry-after') || 10) || 10;
    throw err;
  }
  return json === null ? text : json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function rupiah(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// ------------------------------------------------------------ API calls
async function listPackages() {
  const data = await api('GET', `${BASE}/api/v3/number/packages/esim?${UTM}`);
  return data.packages.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.value,
    old_price: p.old_value,
    quota: (() => { try { return JSON.parse(p.metadata).quota; } catch { return null; } })(),
  }));
}

async function listNumbers(packageId, category, search) {
  const q = new URLSearchParams();
  if (search) q.set('search', search);
  q.set('utm_campaign', 'none');
  q.set('utm_medium', 'mobile');
  q.set('utm_source', 'direct');
  q.set('utm_term', 'none');
  q.set('utm_content', '');
  const data = await api(
    'GET',
    `${BASE}/api/v2/number/pre/${category}/${packageId}?${q.toString()}`,
    undefined,
    `${BASE}/esim/order/prepaid/number`,
  );
  return (data.numbers || []).map((n) => ({
    id: n.id, number: n.number, price: n.price, old_price: n.old_price,
    category, label: data.label_id || category,
  }));
}

// ------------------------------------------------------------ hunt cantik
// Kriteria nomor cantik. Semua filter client-side setelah batch diambil,
// kecuali `search` yang diserahkan ke server (server memfilter substring).
function matchNumber(n, crit) {
  const num = n.number;
  if (crit.digits.size && !crit.digits.has(num.length)) return false;
  if (crit.prefixes.length && !crit.prefixes.some((p) => num.startsWith(p))) return false;
  if (crit.contains && !num.includes(crit.contains)) return false;
  if (crit.ends && !num.endsWith(crit.ends)) return false;
  return true;
}

function describeCrit(crit) {
  const parts = [];
  if (crit.digits.size) parts.push(`digit: ${[...crit.digits].sort().join('/')}`);
  if (crit.prefixes.length) parts.push(`prefix: ${crit.prefixes.join(', ')}`);
  if (crit.contains) parts.push(`mengandung: ${crit.contains}`);
  if (crit.ends) parts.push(`berakhir: ${crit.ends}`);
  return parts.join(' | ') || 'apa saja';
}

/**
 * Loop otomatis sampai ketemu nomor yang cocok dengan kriteria.
 * Satu percobaan = 1 batch per kategori, diambil PARALEL
 * (default 4 kategori = ~32 nomor).
 *
 * Strategi search (diuji live 15 Nov 2026): hasil search server untuk
 * satu term (misal "0815") cepat mengulang nomor yang sama — pool-nya
 * kecil. Jadi prefix/digit HANYA difilter client-side dari batch acak
 * (prefix 0815 muncul di ~35% nomor acak, 11 digit di ~11%).
 * Yang dikirim sebagai search server HANYA `contains` >= 3 digit
 * (misal 6666), karena pola tengah seperti itu hampir tidak muncul
 * di batch acak.
 */
async function huntNumbers({ packageId, categories, crit, maxAttempts = 50, delayMs = 800, onProgress }) {
  const search = crit.contains && crit.contains.length >= 3 ? crit.contains : '';
  const seen = new Set();
  let checked = 0;
  let rateLimited = false;
  let rateLimitStrikes = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let batch = [];
    try {
      const results = await Promise.all(
        categories.map((c) => listNumbers(packageId, c, search)),
      );
      rateLimitStrikes = 0;
      for (const list of results) {
        for (const n of list) {
          if (seen.has(n.id)) continue;
          seen.add(n.id);
          checked++;
          batch.push(n);
        }
      }
    } catch (err) {
      if (err && err.status === 429) {
        // Di-throttle: jangan gas terus. Tunggu sesuai Retry-After
        // (atau 10 detik), coba lagi; 3x kena 429 berturut-turut = berhenti.
        rateLimitStrikes++;
        rateLimited = true;
        if (onProgress) {
          onProgress({ attempt, checked, batch: 0, hits: 0, rateLimited: true });
        }
        if (rateLimitStrikes >= 3) {
          return { hits: [], attempts: attempt, checked, rateLimited: true };
        }
        await sleep(Math.max(err.retryAfterSec || 10, 5) * 1000);
        continue;
      }
      throw err;
    }
    const hits = batch.filter((n) => matchNumber(n, crit));
    if (onProgress) onProgress({ attempt, checked, batch: batch.length, hits: hits.length });
    if (hits.length) return { hits, attempts: attempt, checked };
    if (attempt < maxAttempts && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return { hits: [], attempts: maxAttempts, checked, rateLimited };
}

function parseCrit(args) {
  const crit = {
    digits: new Set(
      (args.digits || '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0),
    ),
    prefixes: (args.prefix || '').split(',').map((s) => s.trim()).filter(Boolean),
    contains: (args.contains || '').trim() || '',
    ends: (args.ends || '').trim() || '',
  };
  return crit;
}

async function checkNumber(numberId) {
  return api('POST', `${BASE}/api/number/status/${numberId}`, {},
    `${BASE}/esim/order/prepaid/number`);
}

async function createOrder({ numberId, name, phone, email, packageId }) {
  const body = {
    number: Number(numberId),
    name,
    phone: phone || '',
    email,
    package: Number(packageId),
    sof: SOF_QRIS,
    sof_msisdn: '',
    agent_key: AGENT_KEY,
    session_id: genSessionId(),
    bonus_id: 0,
    language: 'ID',
  };
  const res = await api('POST', `${BASE}/api/order/esim/prepaid/create`, body,
    `${BASE}/payment`);
  // order_code di response masih URL-encoded — decode untuk endpoint berikut.
  return { ...res, order_code_decoded: decodeURIComponent(res.order_code) };
}

async function orderDetail(orderCode) {
  // Frontend memanggil ini dengan order_code ter-decode maupun ter-encode;
  // keduanya teramati berhasil di HAR. Pakai yang ter-decode.
  return api('POST', `${BASE}/api/order/detail`, { order_code: orderCode },
    `${BASE}/payment-qris`);
}

async function paycheck(orderId) {
  return api('GET', `${BASE}/api/order/paycheck/${orderId}`, undefined,
    `${BASE}/payment-qris`);
}

async function esimStatus(orderCode) {
  // order_code HARUS URL-encoded di path ini.
  return api('GET',
    `${BASE}/api/order/esim/status/${encodeURIComponent(orderCode)}`,
    undefined, `${BASE}/payment-qris`);
}

// ------------------------------------------------------------ subcommands
async function cmdPackages(args) {
  const pkgs = await listPackages();
  if (args.json) return console.log(JSON.stringify(pkgs, null, 2));
  console.log('\nPaket eSIM IM3:');
  pkgs.forEach((p, i) => {
    const disc = p.old_price ? ` (coret ${rupiah(p.old_price)})` : '';
    console.log(`  ${i + 1}. [${p.id}] ${p.name} — ${rupiah(p.price)}${disc}`);
  });
  return pkgs;
}

async function cmdNumbers(args) {
  const packageId = args.package || 4324;
  const search = args.search || '';
  if (search && search.length < 3) throw new Error('search minimal 3 digit.');
  const cats = args.category ? [args.category] : CATEGORIES.map((c) => c.key);
  let all = [];
  for (const c of cats) {
    const list = await listNumbers(packageId, c, search);
    all = all.concat(list);
  }
  if (args.json) return console.log(JSON.stringify(all, null, 2));
  console.log(`\nNomor (paket ${packageId}${search ? `, cari "${search}"` : ''}):`);
  all.forEach((n, i) => {
    const price = n.price ? ` — ${rupiah(n.price)}` : '';
    console.log(`  ${i + 1}. ${n.number}  [${n.label}] id=${n.id}${price}`);
  });
  if (!all.length) console.log('  (tidak ada nomor — coba digit lain / shuffle)');
  return all;
}

async function cmdHunt(args) {
  const packageId = args.package || 4324;
  const crit = parseCrit(args);
  const maxAttempts = Number(args['max-attempts'] || 50);
  const delayMs = Number(args.delay || 800);
  const categories = args.category ? [args.category] : CATEGORIES.map((c) => c.key);
  if (!maxAttempts || maxAttempts < 1) throw new Error('--max-attempts minimal 1.');

  if (!args.json) {
    console.log(`\n🎯 Auto hunt nomor cantik (paket ${packageId})`);
    console.log(`   Kriteria: ${describeCrit(crit)}`);
    console.log(`   Kategori: ${categories.join(', ')} | Maks ${maxAttempts} percobaan | jeda ${delayMs}ms`);
    console.log('   (satu percobaan = 1 batch per kategori, ~32 nomor)');
  }
  const res = await huntNumbers({
    packageId, categories, crit, maxAttempts, delayMs,
    onProgress: args.json ? undefined : ({ attempt, checked, hits, rateLimited: rl }) => {
      if (hits) return;
      if (rl) {
        process.stdout.write(`\n   ⚠️ percobaan ${attempt}: kena throttle (429) — menunggu, lalu coba lagi...`);
        return;
      }
      process.stdout.write(`\r   percobaan ${attempt}/${maxAttempts} — sudah cek ${checked} nomor, belum ketemu...`);
    },
  });
  if (!args.json) process.stdout.write('\n');
  if (!res.hits.length) {
    if (res.rateLimited) {
      const msg = `Berhenti karena server me-throttle (429) setelah ${res.attempts} percobaan ` +
        `(${res.checked} nomor dicek). Tunggu beberapa menit, lalu jalankan lagi — jangan naikkan kecepatan.`;
      if (args.json) {
        console.log(JSON.stringify({ found: false, ...res, criteria: describeCrit(crit) }, null, 2));
        return res;
      }
      console.log('⚠️ ' + msg);
      return res;
    }
    const msg = `Tidak ketemu setelah ${res.attempts} percobaan (${res.checked} nomor dicek). ` +
      'Coba longgarkan kriteria (misal digit 11/12 saja, atau prefix saja).';
    if (args.json) {
      console.log(JSON.stringify({ found: false, ...res, criteria: describeCrit(crit) }, null, 2));
      return res;
    }
    console.log('❌ ' + msg);
    return res;
  }
  if (args.json) {
    console.log(JSON.stringify({ found: true, ...res, criteria: describeCrit(crit) }, null, 2));
    return res;
  }
  console.log(`\n✅ Ketemu setelah ${res.attempts} percobaan (${res.checked} nomor dicek):`);
  res.hits.forEach((n, i) => {
    console.log(`  ${i + 1}. ${n.number}  [${n.label}] id=${n.id} (${n.number.length} digit)`);
  });
  return res;
}

async function cmdOrder(args) {
  const { package: packageId, 'number-id': numberId, name, email, phone } = args;
  if (!packageId || !numberId || !name || !email) {
    throw new Error('butuh --package, --number-id, --name, --email. Lihat --help.');
  }
  if (name.length < 2) throw new Error('nama minimal 2 karakter.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email tidak valid.');
  if (phone && phone.length < 10) throw new Error('WhatsApp minimal 10 karakter bila diisi.');
  if (!args.confirm) {
    throw new Error(
      'ORDER NYATA: tambahkan --confirm untuk benar-benar membuat order QRIS. ' +
      'Tanpa itu, tidak ada yang dibuat.',
    );
  }
  const avail = await checkNumber(numberId);
  if (avail && avail.available === false) throw new Error(`nomor id ${numberId} sudah tidak tersedia.`);

  const created = await createOrder({ numberId, name, phone, email, packageId });
  const detail = await orderDetail(created.order_code_decoded);
  const result = {
    order_id: detail.order_code,
    order_number: detail.order_number,
    package_name: detail.package_name,
    total_price: detail.total_price,
    order_code: created.order_code_decoded,
    order_date: created.order_date,
    expire_minutes: created.expire,
    qris_raw: created.link,
  };
  const qrisPng = saveB64Png(created.qr_link, `qris-${result.order_id}.png`);
  result.qris_png = qrisPng;
  saveJson(result, `order-${result.order_id}.json`);

  if (args.json) return console.log(JSON.stringify(result, null, 2));
  console.log('\n✅ Order dibuat (QRIS):');
  console.log(`   Order ID : ${result.order_id}`);
  console.log(`   Nomor    : ${result.order_number} — ${result.package_name}`);
  console.log(`   Total    : ${rupiah(result.total_price)} — QRIS berlaku ${result.expire_minutes} menit`);
  console.log(`   QR PNG   : ${qrisPng}`);
  console.log(`   QRIS raw : ${result.qris_raw}`);
  console.log('\nBayar QRIS-nya, lalu jalankan:');
  console.log(`   node im3-esim.js watch --order-id ${result.order_id} --order-code "${result.order_code}"`);
  return result;
}

async function cmdStatus(args) {
  if (!args['order-id']) throw new Error('butuh --order-id.');
  const res = await paycheck(args['order-id']);
  const label = res.status === 3 ? 'PAID' : res.status === 2 ? 'menunggu bayar' : `status=${res.status}`;
  if (args.json) return console.log(JSON.stringify(res, null, 2));
  console.log(`Order ${res.code}: ${label} (status=${res.status})`);
  return res;
}

// Status esim/status (terverifikasi live 15 Nov 2026):
//   1 = "In-Progress" (sudah paid, QR eSIM masih disiapkan server — coba lagi)
//   2 = "Success" (qrCode + activation_code tersedia)
const ESIM_MAX_TRIES = 12; // ~2 menit dengan jeda 10 detik
const ESIM_RETRY_SECONDS = 10;

async function cmdEsim(args) {
  if (!args['order-code']) throw new Error('butuh --order-code (dari create order).');
  let res = null;
  for (let i = 1; i <= ESIM_MAX_TRIES; i++) {
    res = await esimStatus(args['order-code']);
    if (res.status === 2 && res.qrCode) break;
    if (res.status === 1) {
      if (!args.json) {
        console.log(`   QR eSIM masih disiapkan server (In-Progress), coba lagi ${i}/${ESIM_MAX_TRIES}...`);
      }
      if (i < ESIM_MAX_TRIES) await sleep(ESIM_RETRY_SECONDS * 1000);
      continue;
    }
    break;
  }
  if (!res || res.status !== 2 || !res.qrCode) {
    throw new Error(`QR eSIM belum tersedia: ${JSON.stringify(res).slice(0, 300)}`);
  }
  const file = saveB64Png(res.qrCode, `esim-${Date.now()}.png`);
  const out = { qr_png: file, activation_code: res.activation_code, msg: res.msg };
  if (args.json) return console.log(JSON.stringify(out, null, 2));
  console.log('\n✅ QR eSIM didapat:');
  console.log(`   QR PNG          : ${file}`);
  console.log(`   Activation code : ${res.activation_code}`);
  console.log('   (kode ini rahasia — jangan disebar)');
  return out;
}

async function cmdWatch(args, jsonMode) {
  if (!args['order-id'] || !args['order-code']) {
    throw new Error('butuh --order-id dan --order-code.');
  }
  const deadline = Date.now() + 10 * 60 * 1000; // QRIS 10 menit
  console.log(`Polling status order ${args['order-id']} tiap ${POLL_SECONDS} detik (maks ~10 menit)...`);
  for (;;) {
    const res = await paycheck(args['order-id']);
    const now = new Date().toLocaleTimeString('id-ID');
    if (res.status === 3) {
      console.log(`[${now}] PAID. Mengambil QR eSIM...`);
      const esim = await cmdEsim({ 'order-code': args['order-code'], json: false });
      if (jsonMode) console.log(JSON.stringify({ paid: true, ...esim }, null, 2));
      return esim;
    }
    console.log(`[${now}] status=${res.status} (menunggu bayar)...`);
    if (Date.now() > deadline) {
      throw new Error('QRIS kedaluwarsa (10 menit) dan belum dibayar. Buat order baru.');
    }
    await sleep(POLL_SECONDS * 1000);
  }
}

// ------------------------------------------------------------ wizard
async function cmdRun() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n=== Order eSIM IM3 — wizard ===');
    const pkgs = await cmdPackages({});
    const pick = await ask(rl, '\nPilih paket [1-9, default 1]: ');
    const pkg = pkgs[Number(pick || 1) - 1] || pkgs[0];
    console.log(`Paket: ${pkg.name} — ${rupiah(pkg.price)}`);

    let chosen = null;
    const mode = await ask(rl, 'Cari nomor: [1] manual, [2] auto hunt nomor cantik (default 1): ');
    if (mode === '2') {
      const digits = await ask(rl, 'Jumlah digit yang dicari (misal 11, atau 10,11,12 — Enter = apa saja): ');
      const prefix = await ask(rl, 'Prefix (misal 0815,0855 — Enter = apa saja): ');
      const contains = await ask(rl, 'Harus mengandung digit (misal 6666 — Enter = tidak ada): ');
      const ends = await ask(rl, 'Harus berakhir dengan (misal 123 — Enter = tidak ada): ');
      const maxA = await ask(rl, 'Maksimal percobaan [default 50]: ');
      const res = await cmdHunt({
        package: pkg.id,
        digits, prefix, contains, ends,
        'max-attempts': maxA || 50,
      });
      if (!res.hits.length) {
        console.log('Hunt gagal — kembali ke mode manual.');
      } else if (res.hits.length === 1) {
        chosen = res.hits[0];
      } else {
        const sel = await ask(rl, `Pilih nomor [1-${res.hits.length}]: `);
        chosen = res.hits[Number(sel) - 1] || res.hits[0];
      }
    }
    for (; !chosen;) {
      const search = await ask(rl, 'Cari digit nomor (min 3, Enter = acak): ');
      if (search && search.length < 3) { console.log('Minimal 3 digit.'); continue; }
      const all = await cmdNumbers({ package: pkg.id, search });
      if (!all.length) continue;
      const sel = await ask(rl, 'Pilih nomor [1-..], "r" acak lagi, "s" cari lagi: ');
      if (sel.toLowerCase() === 'r' || sel.toLowerCase() === 's') continue;
      chosen = all[Number(sel) - 1];
      if (!chosen) { console.log('Pilihan tidak ada.'); continue; }
      break;
    }
    console.log(`Nomor terpilih: ${chosen.number} [${chosen.label}]`);

    const name = await ask(rl, 'Nama lengkap: ');
    const email = await ask(rl, 'Email: ');
    const email2 = await ask(rl, 'Konfirmasi email: ');
    const phone = await ask(rl, 'Nomor WhatsApp (opsional, Enter = kosong): ');
    if (name.length < 2) throw new Error('nama minimal 2 karakter.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email tidak valid.');
    if (email !== email2) throw new Error('konfirmasi email tidak sama.');
    if (phone && phone.length < 10) throw new Error('WhatsApp minimal 10 karakter bila diisi.');

    console.log(`\nRingkasan: ${chosen.number} | ${pkg.name} ${rupiah(pkg.price)} | ${name} | ${email}`);
    const ok = await ask(rl, 'Buat order QRIS nyata? (ya/tidak): ');
    if (ok.toLowerCase() !== 'ya') { console.log('Dibatalkan, tidak ada order yang dibuat.'); return; }

    const order = await cmdOrder({
      package: pkg.id, 'number-id': chosen.id, name, email, phone, confirm: true,
    });
    await cmdWatch({ 'order-id': order.order_id, 'order-code': order.order_code });
    console.log('\nSelesai. File tersimpan di ./out/');
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- main
function help() {
  console.log(`
im3-esim.js — CLI order eSIM IM3 (tanpa dependensi, Node >= 18)

  node im3-esim.js                         menu interaktif (run.js) — tanpa argumen
  node im3-esim.js run                      wizard interaktif (mode lama)
  node im3-esim.js packages [--json]        daftar 9 paket + harga
  node im3-esim.js numbers --package 4324 [--search 123] [--category reg] [--json]
  node im3-esim.js hunt --package 4324 --digits 11 --prefix 0815,0855
                       [--contains 6666] [--ends 123] [--max-attempts 50] [--json]
  node im3-esim.js order --package 4324 --number-id <id> --name "X" --email "a@b.id"
                       [--phone 08..] --confirm [--json]
  node im3-esim.js status --order-id <id> [--json]
  node im3-esim.js esim --order-code "<order_code>" [--json]
  node im3-esim.js watch --order-id <id> --order-code "<order_code>" [--json]

Catatan:
  - create order = order QRIS NYATA dan butuh --confirm (atau "ya" di wizard).
  - polling paycheck: 2 = menunggu bayar, 3 = paid. QRIS berlaku 10 menit.
  - setelah paid, esim/status mengembalikan qrCode (PNG) + activation_code (LPA).
  - file hasil: ./out/qris-<order>.png, ./out/esim-*.png, ./out/order-<id>.json
  - activation_code bersifat rahasia — jangan kirim file order-*.json ke orang lain.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  // Tanpa argumen -> buka menu interaktif (run.js). UI-nya tinggal di sana;
  // file ini tetap jadi core engine (API + subcommand) untuk bot Telegram.
  if (!cmd) {
    const ui = require('./run.js');
    return ui.mainMenu();
  }
  if (cmd === 'help' || args.help) return help();
  try {
    switch (cmd) {
      case 'packages': await cmdPackages(args); break;
      case 'numbers': await cmdNumbers(args); break;
      case 'hunt': await cmdHunt(args); break;
      case 'order': await cmdOrder(args); break;
      case 'status': await cmdStatus(args); break;
      case 'esim': await cmdEsim(args); break;
      case 'watch': await cmdWatch(args, !!args.json); break;
      case 'run': await cmdRun(); break;
      default: console.error(`Perintah tidak dikenal: ${cmd}`); help(); process.exitCode = 1;
    }
  } catch (err) {
    console.error('\n❌ ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { listPackages, listNumbers, checkNumber, createOrder, orderDetail, paycheck, esimStatus, huntNumbers, matchNumber };
