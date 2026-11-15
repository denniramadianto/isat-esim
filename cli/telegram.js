#!/usr/bin/env node
/**
 * telegram.js — Bot Telegram order eSIM IM3 (im3shop.ioh.co.id).
 *
 * Arsitektur yang dipakai di repo ini:
 *   im3-esim.js  = CORE ENGINE (API IM3 + subcommand). Dipakai file ini.
 *   run.js       = UI TERMINAL (menu, warna, nama/email random).
 *   telegram.js  = BOT TELEGRAM (file ini). Juga memakai core, bukan file UI.
 *
 * File ini TIDAK menduplikasi logika API: semua panggilan ke IM3 lewat
 * `require('./im3-esim.js')`, dan nama/email random lewat `run.js`.
 * Tanpa dependensi, Node >= 18 — Bot API Telegram dipanggil langsung
 * dengan fetch bawaan (long polling getUpdates, bukan webhook).
 *
 * Cara pakai:
 *   1. Buat bot di @BotFather, salin tokennya.
 *   2. TELEGRAM_BOT_TOKEN=<token> node telegram.js
 *
 * Perintah bot:
 *   /start  — menu utama        /order  — order eSIM baru
 *   /hunt   — auto hunt nomor cantik
 *   /paket  — daftar paket      /status — cek status order
 *   /esim   — ambil QR eSIM (order sudah paid)
 *   /cancel — batalkan alur yang sedang berjalan
 *
 * Alur order (sama seperti wizard terminal): pilih paket -> pilih nomor
 * (manual / auto hunt) -> nama -> email -> konfirmasi -> order QRIS dibuat
 * -> QRIS dikirim sebagai FOTO -> bot polling otomatis tiap 20 detik
 * sampai paid (maks 10 menit, umur QRIS) -> QR eSIM + kode aktivasi
 * dikirim sebagai FOTO + teks.
 *
 * Keamanan:
 *   - Token HANYA dari env TELEGRAM_BOT_TOKEN, tidak pernah ditulis di file.
 *   - Order & QR eSIM HANYA di chat privat (chat.type === 'private').
 *     Di grup, bot menolak alur order — kode aktivasi eSIM itu rahasia.
 *   - Order nyata selalu lewat konfirmasi eksplisit (tombol "Ya, buat order").
 *   - File out/order-*.json memuat activation_code — JANGAN disebar.
 *
 * Integrasi ke telegram-store-bot-v1 (Telegraf) nanti: fungsi-fungsi di
 * file ini (alurnya, bukan long polling-nya) bisa dipindah apa adanya —
 * core-nya framework-free, jadi handler Telegraf tinggal memanggil
 * core.listPackages / listNumbers / huntNumbers / createOrder /
 * paycheck / esimStatus yang sama.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./im3-esim.js');
const { randomName, randomEmail } = require('./run.js');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : '';
const OUT_DIR = path.join(__dirname, 'out');
const CATEGORIES = ['reg', 'platinum', 'gold', 'silver'];
const POLL_SECONDS = 20;
const ESIM_MAX_TRIES = 12; // ~2 menit, jeda 10 detik
const ESIM_RETRY_SECONDS = 10;

function rupiah(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
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

// ------------------------------------------------------------ Telegram API
async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || res.status}`);
  return json.result;
}
async function sendMessage(chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg('sendMessage', body);
}
async function sendPhoto(chatId, pngBuffer, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([pngBuffer], { type: 'image/png' }), 'qr.png');
  if (caption) form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  const res = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram sendPhoto: ${json.description || res.status}`);
  return json.result;
}
const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

// ------------------------------------------------------------ sesi per chat
// step: idle | pkg | numMode | numSearch | numPick | huntDigits | huntPrefix
//       | huntContains | huntEnds | huntPick | name | email | phone | confirm
//       | statusAsk | esimAsk
const sessions = new Map();
function session(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { step: 'idle' });
  return sessions.get(chatId);
}
function resetSession(chatId) {
  sessions.set(chatId, { step: 'idle' });
}

const MAIN_MENU =
  '📱 <b>Order eSIM IM3</b>\n\n' +
  'Pilih layanan:\n' +
  '🛒 /order — Order eSIM baru\n' +
  '🎯 /hunt — Auto hunt nomor cantik\n' +
  '📦 /paket — Lihat paket eSIM\n' +
  '🔍 /status — Cek status order\n' +
  '📱 /esim — Ambil QR eSIM (order sudah paid)';
const MAIN_KB = kb([
  [btn('🛒 Order eSIM Baru', 'menu:order'), btn('🎯 Hunt Nomor', 'menu:hunt')],
  [btn('📦 Paket', 'menu:paket'), btn('🔍 Cek Status', 'menu:status')],
]);

function privateOnly(chat) {
  return chat.type === 'private';
}
async function needPrivate(chatId, chat) {
  if (privateOnly(chat)) return true;
  await sendMessage(
    chatId,
    '🔒 Order eSIM hanya bisa lewat <b>chat privat</b> dengan bot ini — kode aktivasi eSIM itu rahasia. Silakan chat bot ini secara langsung.',
  );
  return false;
}

// ------------------------------------------------------------ alur: paket & nomor
async function startOrder(chatId) {
  const s = session(chatId);
  let pkgs;
  try {
    pkgs = await core.listPackages();
  } catch (e) {
    return sendMessage(chatId, `❌ Gagal ambil daftar paket: ${e.message}`);
  }
  s.pkgs = pkgs;
  s.step = 'pkg';
  const rows = pkgs.map((p, i) => [
    btn(`${i + 1}. ${p.name} — ${rupiah(p.price)}`, `pkg:${p.id}`),
  ]);
  await sendMessage(chatId, '📦 <b>Pilih paket eSIM:</b>', kb(rows));
}

async function askNumberMode(chatId) {
  const s = session(chatId);
  s.step = 'numMode';
  await sendMessage(
    chatId,
    `Paket: <b>${s.pkg.name}</b> — ${rupiah(s.pkg.price)}\n\nCari nomor bagaimana?`,
    kb([
      [btn('🔢 Pilih manual (ketik digit)', 'mode:manual')],
      [btn('🎯 Auto hunt nomor cantik', 'mode:hunt')],
    ]),
  );
}

async function showNumbers(chatId, list) {
  const s = session(chatId);
  s.numbers = list;
  s.step = 'numPick';
  const lines = list.map((n, i) => `${i + 1}. <code>${n.number}</code>  [${n.label}]`).join('\n');
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [btn(String(i + 1), `n:${i}`)];
    if (list[i + 1]) row.push(btn(String(i + 2), `n:${i + 1}`));
    rows.push(row);
  }
  rows.push([btn('🔄 Acak lagi', 'n:reshuffle'), btn('🔍 Cari digit lain', 'n:research')]);
  await sendMessage(chatId, `Nomor tersedia (paket ${s.pkg.name}):\n\n${lines}\n\nPilih nomor:`, kb(rows));
}

async function fetchNumbers(chatId, search) {
  const s = session(chatId);
  const all = [];
  for (const c of CATEGORIES) all.push(...await core.listNumbers(s.pkg.id, c, search));
  return all;
}

async function askName(chatId) {
  const s = session(chatId);
  s.step = 'name';
  await sendMessage(
    chatId,
    `Nomor terpilih: <code>${s.chosen.number}</code> [${s.chosen.label}]\n\nKetik <b>nama lengkap</b> (min. 2 karakter), atau pakai nama random:`,
    kb([[btn('🎲 Nama random', 'name:random')]]),
  );
}

async function askEmail(chatId) {
  const s = session(chatId);
  s.step = 'email';
  await sendMessage(
    chatId,
    `Nama: <b>${s.name}</b>\n\nKetik <b>email</b>, atau pakai email random dari nama itu:`,
    kb([[btn('🎲 Email random', 'email:random')]]),
  );
}

async function askPhone(chatId) {
  const s = session(chatId);
  s.step = 'phone';
  await sendMessage(
    chatId,
    `Email: <b>${s.email}</b>\n\nKetik <b>nomor WhatsApp</b> (opsional, min. 10 karakter), atau lewati:`,
    kb([[btn('⏭️ Lewati (tanpa WA)', 'phone:skip')]]),
  );
}

async function askConfirm(chatId) {
  const s = session(chatId);
  s.step = 'confirm';
  await sendMessage(
    chatId,
    '📋 <b>Ringkasan order:</b>\n\n' +
      `Nomor: <code>${s.chosen.number}</code> [${s.chosen.label}]\n` +
      `Paket: ${s.pkg.name} — ${rupiah(s.pkg.price)}\n` +
      `Nama: ${s.name}\nEmail: ${s.email}\n` +
      (s.phone ? `WA: ${s.phone}\n` : '') +
      '\nBuat order QRIS nyata sekarang?',
    kb([
      [btn('✅ Ya, buat order', 'confirm:yes')],
      [btn('❌ Batal', 'confirm:no')],
    ]),
  );
}

// ------------------------------------------------------------ hunt
function parseHuntCrit(digits, prefix, contains, ends) {
  return {
    digits: new Set(
      String(digits || '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0),
    ),
    prefixes: String(prefix || '').split(',').map((x) => x.trim()).filter(Boolean),
    contains: String(contains || '').trim(),
    ends: String(ends || '').trim(),
  };
}
function describeCrit(crit) {
  const parts = [];
  if (crit.digits.size) parts.push(`digit: ${[...crit.digits].sort().join('/')}`);
  if (crit.prefixes.length) parts.push(`prefix: ${crit.prefixes.join(', ')}`);
  if (crit.contains) parts.push(`mengandung: ${crit.contains}`);
  if (crit.ends) parts.push(`berakhir: ${crit.ends}`);
  return parts.join(' | ') || 'apa saja';
}

async function runHunt(chatId) {
  const s = session(chatId);
  const crit = parseHuntCrit(s.huntDigits, s.huntPrefix, s.huntContains, s.huntEnds);
  await sendMessage(
    chatId,
    `🎯 <b>Auto hunt nomor cantik</b> (paket ${s.pkg.name})\nKriteria: ${describeCrit(crit)}\n\nMencari... (maks 50 percobaan, ~32 nomor/percobaan)`,
  );
  let res;
  try {
    res = await core.huntNumbers({
      packageId: s.pkg.id,
      categories: CATEGORIES,
      crit,
      maxAttempts: 50,
      delayMs: 800,
    });
  } catch (e) {
    return sendMessage(chatId, `❌ Hunt gagal: ${e.message}`);
  }
  if (!res.hits.length) {
    s.step = 'idle';
    return sendMessage(
      chatId,
      res.rateLimited
        ? '⚠️ Berhenti karena server me-throttle (429). Tunggu beberapa menit, lalu /hunt lagi — jangan naikkan kecepatan.'
        : `❌ Tidak ketemu setelah ${res.attempts} percobaan (${res.checked} nomor dicek). Coba longgarkan kriteria, lalu /hunt lagi.`,
      MAIN_KB,
    );
  }
  s.hits = res.hits;
  s.step = 'huntPick';
  const lines = res.hits.map((n, i) => `${i + 1}. <code>${n.number}</code>  [${n.label}]`).join('\n');
  const rows = [];
  for (let i = 0; i < res.hits.length; i += 2) {
    const row = [btn(String(i + 1), `h:${i}`)];
    if (res.hits[i + 1]) row.push(btn(String(i + 2), `h:${i + 1}`));
    rows.push(row);
  }
  await sendMessage(
    chatId,
    `✅ Ketemu setelah ${res.attempts} percobaan (${res.checked} nomor dicek):\n\n${lines}\n\nPilih nomor untuk di-order:`,
    kb(rows),
  );
}

// ------------------------------------------------------------ order & pantau bayar
async function fetchEsimWithRetry(orderCode) {
  for (let i = 1; i <= ESIM_MAX_TRIES; i++) {
    const res = await core.esimStatus(orderCode);
    if (res.status === 2 && res.qrCode) return res;
    if (res.status === 1) {
      if (i < ESIM_MAX_TRIES) await sleep(ESIM_RETRY_SECONDS * 1000);
      continue;
    }
    throw new Error(`QR eSIM belum tersedia: ${JSON.stringify(res).slice(0, 300)}`);
  }
  throw new Error('QR eSIM belum tersedia setelah menunggu ~2 menit. Coba lagi lewat /esim.');
}

async function watchOrder(chatId, orderId, orderCode) {
  const s = session(chatId);
  const deadline = Date.now() + 10 * 60 * 1000; // QRIS 10 menit
  for (;;) {
    if (s.cancelWatch) return;
    let res;
    try {
      res = await core.paycheck(orderId);
    } catch (e) {
      await sendMessage(chatId, `⚠️ Gagal cek status: ${e.message} — polling lanjut...`);
      await sleep(POLL_SECONDS * 1000);
      continue;
    }
    if (res.status === 3) {
      await sendMessage(chatId, '✅ <b>PAID.</b> Mengambil QR eSIM...');
      let esim;
      try {
        esim = await fetchEsimWithRetry(orderCode);
      } catch (e) {
        return sendMessage(chatId, `⚠️ Sudah terbayar, tapi ${e.message}`);
      }
      const file = saveB64Png(esim.qrCode, `esim-${Date.now()}.png`);
      await sendPhoto(
        chatId,
        Buffer.from(esim.qrCode, 'base64'),
        `📱 <b>QR eSIM kamu</b>\nNomor: <code>${s.chosen ? s.chosen.number : ''}</code>\nOrder ID: <code>${orderId}</code>`,
      );
      await sendMessage(
        chatId,
        '🔑 <b>Kode aktivasi (LPA):</b>\n' +
          `<code>${esim.activation_code}</code>\n\n` +
          'Cara pasang: Settings → tambah eSIM → scan QR di atas, atau masukkan kode manual.\n' +
          `iPhone: https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(esim.activation_code)}\n\n` +
          `⚠️ <b>Kode ini rahasia</b> — jangan diteruskan ke siapa pun.\nFile tersimpan: <code>${file}</code>`,
      );
      resetSession(chatId);
      return;
    }
    if (Date.now() > deadline) {
      resetSession(chatId);
      return sendMessage(chatId, '⌛ QRIS kedaluwarsa (10 menit) dan belum dibayar. Buat order baru dengan /order.');
    }
    await sleep(POLL_SECONDS * 1000);
  }
}

async function doCreateOrder(chatId) {
  const s = session(chatId);
  let avail;
  try {
    avail = await core.checkNumber(s.chosen.id);
  } catch (e) {
    return sendMessage(chatId, `❌ Gagal validasi nomor: ${e.message}`);
  }
  if (avail && avail.available === false) {
    s.step = 'idle';
    return sendMessage(
      chatId,
      `❌ Nomor <code>${s.chosen.number}</code> sudah diambil orang lain. Jalankan /order lagi untuk cari nomor lain.`,
      MAIN_KB,
    );
  }
  let created;
  try {
    created = await core.createOrder({
      numberId: s.chosen.id,
      name: s.name,
      phone: s.phone || '',
      email: s.email,
      packageId: s.pkg.id,
    });
  } catch (e) {
    return sendMessage(chatId, `❌ Gagal membuat order: ${e.message}`);
  }
  const detail = await core.orderDetail(created.order_code_decoded);
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
  s.orderId = result.order_id;
  s.orderCode = result.order_code;
  s.cancelWatch = false;
  s.step = 'watching';
  await sendPhoto(
    chatId,
    Buffer.from(created.qr_link, 'base64'),
    `🧾 <b>QRIS — bayar ${rupiah(result.total_price)}</b>\n` +
      `Order ID: <code>${result.order_id}</code>\nNomor: <code>${result.order_number}</code> — ${result.package_name}\n` +
      `Berlaku ${result.expire_minutes} menit. Scan pakai aplikasi pembayaran apa saja.`,
  );
  await sendMessage(
    chatId,
    '⏳ Saya pantau pembayarannya otomatis tiap 20 detik. Begitu terbayar, QR eSIM langsung saya kirim ke sini.',
  );
  watchOrder(chatId, result.order_id, result.order_code).catch((e) =>
    sendMessage(chatId, `⚠️ Polling berhenti: ${e.message}`),
  );
}

// ------------------------------------------------------------ perintah
async function cmdStatus(chatId, orderId) {
  let res;
  try {
    res = await core.paycheck(orderId);
  } catch (e) {
    return sendMessage(chatId, `❌ Gagal cek status: ${e.message}`);
  }
  const label = res.status === 3 ? 'PAID ✅' : res.status === 2 ? 'menunggu bayar ⏳' : `status=${res.status}`;
  await sendMessage(chatId, `Order <code>${res.code}</code>: <b>${label}</b>`, MAIN_KB);
}

async function cmdEsim(chatId, orderCode) {
  await sendMessage(chatId, '📱 Mengambil QR eSIM...');
  let esim;
  try {
    esim = await fetchEsimWithRetry(orderCode);
  } catch (e) {
    return sendMessage(chatId, `❌ ${e.message}`);
  }
  const file = saveB64Png(esim.qrCode, `esim-${Date.now()}.png`);
  await sendPhoto(chatId, Buffer.from(esim.qrCode, 'base64'), '📱 <b>QR eSIM kamu</b>');
  await sendMessage(
    chatId,
    `🔑 <b>Kode aktivasi (LPA):</b>\n<code>${esim.activation_code}</code>\n\n⚠️ <b>Kode ini rahasia</b> — jangan diteruskan ke siapa pun.\nFile tersimpan: <code>${file}</code>`,
  );
}

// ------------------------------------------------------------ update handler
async function handleMessage(msg) {
  const chat = msg.chat;
  const chatId = chat.id;
  const text = (msg.text || '').trim();
  const s = session(chatId);
  if (!text) return;

  if (text === '/start') {
    resetSession(chatId);
    return sendMessage(chatId, `Halo! ${MAIN_MENU}`, MAIN_KB);
  }
  if (text === '/cancel') {
    if (s) s.cancelWatch = true;
    resetSession(chatId);
    return sendMessage(chatId, '🚫 Alur dibatalkan.', MAIN_KB);
  }
  if (text === '/paket') {
    try {
      const pkgs = await core.listPackages();
      const lines = pkgs.map((p, i) => `${i + 1}. [${p.id}] ${p.name} — ${rupiah(p.price)}`).join('\n');
      return sendMessage(chatId, `📦 <b>Paket eSIM IM3:</b>\n\n${lines}`, MAIN_KB);
    } catch (e) {
      return sendMessage(chatId, `❌ Gagal ambil daftar paket: ${e.message}`);
    }
  }
  if (text === '/order') {
    if (!(await needPrivate(chatId, chat))) return;
    return startOrder(chatId);
  }
  if (text === '/hunt') {
    if (!(await needPrivate(chatId, chat))) return;
    // Hunt butuh paket dulu — pakai paket default 5GB (4324) bila belum pilih.
    s.pkg = { id: 4324, name: 'Perdana eSIM 5GB', price: 1 };
    s.step = 'huntDigits';
    return sendMessage(
      chatId,
      '🎯 <b>Auto hunt nomor cantik</b> (paket 5GB Rp1)\n\nJumlah digit yang dicari? Ketik misal <code>11</code>, atau <code>11,12</code> — ketik <code>-</code> untuk apa saja.',
    );
  }
  if (text === '/status') {
    s.step = 'statusAsk';
    return sendMessage(chatId, '🔍 Ketik <b>Order ID</b> yang mau dicek (misal <code>950002009xxx</code>):');
  }
  if (text === '/esim') {
    if (!(await needPrivate(chatId, chat))) return;
    s.step = 'esimAsk';
    return sendMessage(chatId, '📱 Ketik <b>order_code</b> dari order yang sudah paid:');
  }

  // ---- langkah-langkah alur (teks bebas)
  switch (s.step) {
    case 'numSearch': {
      if (text.length < 3 && text !== '-') {
        return sendMessage(chatId, 'Minimal 3 digit. Coba lagi, atau ketik <code>-</code> untuk acak.');
      }
      await sendMessage(chatId, '🔍 Mencari nomor...');
      try {
        const all = await fetchNumbers(chatId, text === '-' ? '' : text);
        if (!all.length) {
          return sendMessage(chatId, 'Tidak ada nomor — coba digit lain.');
        }
        return showNumbers(chatId, all);
      } catch (e) {
        return sendMessage(chatId, `❌ Gagal cari nomor: ${e.message}`);
      }
    }
    case 'huntDigits':
      s.huntDigits = text === '-' ? '' : text;
      s.step = 'huntPrefix';
      return sendMessage(chatId, 'Prefix? Ketik misal <code>0815,0855</code> — ketik <code>-</code> untuk apa saja.');
    case 'huntPrefix':
      s.huntPrefix = text === '-' ? '' : text;
      s.step = 'huntContains';
      return sendMessage(chatId, 'Harus mengandung digit? Ketik misal <code>6666</code> — ketik <code>-</code> kalau tidak ada.');
    case 'huntContains':
      s.huntContains = text === '-' ? '' : text;
      s.step = 'huntEnds';
      return sendMessage(chatId, 'Harus berakhir dengan? Ketik misal <code>123</code> — ketik <code>-</code> kalau tidak ada.');
    case 'huntEnds':
      s.huntEnds = text === '-' ? '' : text;
      return runHunt(chatId);
    case 'name': {
      if (text.length < 2) return sendMessage(chatId, 'Nama minimal 2 karakter. Coba lagi.');
      s.name = text;
      return askEmail(chatId);
    }
    case 'email': {
      if (!validEmail(text)) return sendMessage(chatId, 'Email tidak valid. Coba lagi.');
      s.email = text;
      return askPhone(chatId);
    }
    case 'phone': {
      if (text && text.length < 10) return sendMessage(chatId, 'WhatsApp minimal 10 karakter bila diisi. Coba lagi, atau lewati lewat tombol.');
      s.phone = text;
      return askConfirm(chatId);
    }
    case 'statusAsk':
      s.step = 'idle';
      return cmdStatus(chatId, text);
    case 'esimAsk':
      s.step = 'idle';
      return cmdEsim(chatId, text);
    default:
      return sendMessage(chatId, 'Perintah tidak dikenal. Ketik /start untuk menu.', MAIN_KB);
  }
}

async function handleCallback(query) {
  const chat = query.message.chat;
  const chatId = chat.id;
  const data = query.data || '';
  const s = session(chatId);
  const [kind, val] = data.split(':');

  // Jawab callback supaya tombol tidak loading terus.
  try {
    await tg('answerCallbackQuery', { callback_query_id: query.id });
  } catch { /* abaikan */ }

  if (kind === 'menu') {
    if (val === 'order') {
      if (!(await needPrivate(chatId, chat))) return;
      return startOrder(chatId);
    }
    if (val === 'hunt') {
      if (!(await needPrivate(chatId, chat))) return;
      s.pkg = { id: 4324, name: 'Perdana eSIM 5GB', price: 1 };
      s.step = 'huntDigits';
      return sendMessage(chatId, '🎯 <b>Auto hunt nomor cantik</b> (paket 5GB Rp1)\n\nJumlah digit yang dicari? Ketik misal <code>11</code> — ketik <code>-</code> untuk apa saja.');
    }
    if (val === 'paket') {
      try {
        const pkgs = await core.listPackages();
        const lines = pkgs.map((p, i) => `${i + 1}. [${p.id}] ${p.name} — ${rupiah(p.price)}`).join('\n');
        return sendMessage(chatId, `📦 <b>Paket eSIM IM3:</b>\n\n${lines}`, MAIN_KB);
      } catch (e) {
        return sendMessage(chatId, `❌ Gagal ambil daftar paket: ${e.message}`);
      }
    }
    if (val === 'status') {
      s.step = 'statusAsk';
      return sendMessage(chatId, '🔍 Ketik <b>Order ID</b> yang mau dicek:');
    }
    return;
  }
  if (kind === 'pkg') {
    const pkg = (s.pkgs || []).find((p) => String(p.id) === val);
    if (!pkg) return sendMessage(chatId, 'Paket tidak ditemukan. Jalankan /order lagi.');
    s.pkg = pkg;
    return askNumberMode(chatId);
  }
  if (kind === 'mode') {
    if (val === 'manual') {
      s.step = 'numSearch';
      return sendMessage(chatId, '🔢 Ketik digit yang dicari (min 3, misal <code>1122</code>), atau <code>-</code> untuk nomor acak:');
    }
    s.step = 'huntDigits';
    return sendMessage(chatId, '🎯 <b>Auto hunt nomor cantik</b>\n\nJumlah digit yang dicari? Ketik misal <code>11</code>, atau <code>11,12</code> — ketik <code>-</code> untuk apa saja.');
  }
  if (kind === 'n') {
    if (val === 'reshuffle') {
      await sendMessage(chatId, '🔄 Mengacak nomor baru...');
      try {
        const all = await fetchNumbers(chatId, '');
        if (!all.length) return sendMessage(chatId, 'Tidak ada nomor. Coba lagi.');
        return showNumbers(chatId, all);
      } catch (e) {
        return sendMessage(chatId, `❌ Gagal cari nomor: ${e.message}`);
      }
    }
    if (val === 'research') {
      s.step = 'numSearch';
      return sendMessage(chatId, '🔢 Ketik digit yang dicari (min 3), atau <code>-</code> untuk acak:');
    }
    const chosen = (s.numbers || [])[Number(val)];
    if (!chosen) return sendMessage(chatId, 'Pilihan tidak ada. Jalankan /order lagi.');
    s.chosen = chosen;
    return askName(chatId);
  }
  if (kind === 'h') {
    const chosen = (s.hits || [])[Number(val)];
    if (!chosen) return sendMessage(chatId, 'Pilihan tidak ada. Jalankan /hunt lagi.');
    s.chosen = chosen;
    return askName(chatId);
  }
  if (kind === 'name' && val === 'random') {
    s.name = randomName();
    return askEmail(chatId);
  }
  if (kind === 'email' && val === 'random') {
    s.email = randomEmail(s.name || 'user');
    return askPhone(chatId);
  }
  if (kind === 'phone' && val === 'skip') {
    s.phone = '';
    return askConfirm(chatId);
  }
  if (kind === 'confirm') {
    if (val === 'yes') {
      await sendMessage(chatId, '⏳ Membuat order QRIS...');
      return doCreateOrder(chatId);
    }
    resetSession(chatId);
    return sendMessage(chatId, '🚫 Order dibatalkan, tidak ada yang dibuat.', MAIN_KB);
  }
}

// ------------------------------------------------------------ main loop
async function main() {
  if (!TOKEN) {
    console.error(
      '❌ TELEGRAM_BOT_TOKEN belum diisi.\n' +
        '   Buat bot di @BotFather, lalu jalankan:\n' +
        '   TELEGRAM_BOT_TOKEN=<token> node telegram.js',
    );
    process.exitCode = 1;
    return;
  }
  const me = await tg('getMe', {});
  console.log(`🤖 Bot jalan: @${me.username} (${me.first_name}) — long polling...`);
  console.log('   Perintah: /start /order /hunt /paket /status /esim /cancel');
  let offset = 0;
  for (;;) {
    let updates;
    try {
      const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.description || 'getUpdates gagal');
      updates = json.result || [];
    } catch (e) {
      console.error('⚠️ getUpdates gagal, coba lagi 5 detik:', e.message);
      await sleep(5000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try {
        if (u.message) await handleMessage(u.message);
        else if (u.callback_query) await handleCallback(u.callback_query);
      } catch (e) {
        console.error('⚠️ Gagal proses update:', e.message);
        try {
          const cid = (u.message && u.message.chat.id) || (u.callback_query && u.callback_query.message.chat.id);
          if (cid) await sendMessage(cid, '⚠️ Terjadi kesalahan, coba lagi atau ketik /cancel lalu /start.');
        } catch { /* abaikan */ }
      }
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

module.exports = { parseHuntCrit, describeCrit, validEmail, rupiah };
