#!/usr/bin/env node
/**
 * shop.js — Bot Telegram JUALAN eSIM IM3 (publik, untuk semua orang).
 *
 * Beda dengan telegram.js (bot pribadi, tanpa akun/koin): bot ini toko.
 *   im3-esim.js  = CORE ENGINE (API IM3). Dipakai file ini.
 *   run.js       = UI TERMINAL (nama/email random). Dipakai file ini.
 *   shop.js      = BOT TOKO (file ini). Pembeli + coin + admin.
 *
 * Model bisnis:
 *   - 1 coin = 1 QR eSIM siap pakai. Harga coin default Rp400
 *     (bisa diubah admin). Coin dibeli lewat Top Up.
 *   - Pembeli order eSIM -> bayar QRIS IM3 (harga paket, misal Rp1
 *     untuk 5GB) -> QR eSIM siap, tapi DITAHAN -> pembeli tebus
 *     pakai 1 coin -> QR + kode aktivasi dikirim. Kalau coin kurang,
 *     eSIM masuk riwayat "sudah bayar, belum ditebus" dan bisa
 *     ditebus nanti setelah top up.
 *   - Top Up: bayar MANUAL (transfer / QRIS statis penjual, diisi
 *     admin di config) -> tekan "Saya sudah bayar" -> admin approve
 *     -> coin masuk. QRIS IM3 TIDAK bisa dipakai untuk top up
 *     (uang QRIS IM3 masuk ke IM3, bukan ke penjual).
 *
 * Data toko (lokal, JANGAN di-commit — sudah di .gitignore):
 *   ./db/shop.json          — user, order, topup, config
 *   ./db/esim-qr/<id>.png   — backup QR eSIM (untuk admin)
 * File ini tanpa dependensi, Node >= 18, long polling getUpdates.
 *
 * Cara pakai:
 *   1. Buat bot BARU di @BotFather (pisah dari bot pribadi), salin token.
 *   2. Cari user ID Telegram kamu (chat @userinfobot) — itu ADMIN.
 *   3. TELEGRAM_BOT_TOKEN=<token> TELEGRAM_ADMIN_IDS=<id kamu> \
 *        [TELEGRAM_ADMIN_USERNAME=<username kamu tanpa @>] node shop.js
 *
 * Perintah: /start (menu pembeli) — /admin (menu admin, khusus admin).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./im3-esim.js');
const { randomName, randomEmail } = require('./run.js');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : '';
const ADMIN_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const ADMIN_USERNAME = (process.env.TELEGRAM_ADMIN_USERNAME || '').replace(/^@/, '');
const SHOP_DIR = path.join(__dirname, 'db');
const SHOP_FILE = path.join(SHOP_DIR, 'shop.json');
const ESIM_QR_DIR = path.join(SHOP_DIR, 'esim-qr');
const OUT_DIR = path.join(__dirname, 'out');
const CATEGORIES = ['reg', 'platinum', 'gold', 'silver'];
const POLL_SECONDS = 20;
const ESIM_MAX_TRIES = 12; // ~2 menit, jeda 10 detik
const ESIM_RETRY_SECONDS = 10;
const CREATE_DELAY_MS = 6500; // jeda antar create order (~1 order / 6 dtk)
const QUICK_MAX = 10; // maks eSIM sekali Quick Order
const MAX_ACTIVE_ORDERS = 10; // anti-spam: maks order aktif per pembeli
const TOPUP_EXPIRE_HOURS = 24; // top-up pending kedaluwarsa setelah 24 jam

function rupiah(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// ---------------------------------------------------------------- database toko
function defaultShop() {
  return {
    version: 1,
    config: {
      coin_price: 400, // Rp per coin, bisa diubah admin
      payment_info: '', // teks cara bayar top up (transfer/QRIS statis), diisi admin
    },
    users: {}, // id -> {id, username, first_name, coins, banned, created_at}
    orders: [], // {order_id, order_code, number, number_id, package_id, package_name,
    //  total_price, owner_id, owner_username, status, created_at, paid_at,
    //  redeemed_at, qr_file, activation_code}
    // status order: waiting_payment | paid_unredeemed | redeemed | expired | canceled
    topups: [], // {id, user_id, username, coins, amount_rp, status, created_at,
    //  decided_at, decided_by} — status: pending | approved | rejected | expired
    seq: { topup: 0 },
  };
}
function loadShop() {
  try {
    const raw = JSON.parse(fs.readFileSync(SHOP_FILE, 'utf8'));
    if (raw && raw.users && Array.isArray(raw.orders)) {
      if (!raw.config) raw.config = defaultShop().config;
      if (!raw.topups) raw.topups = [];
      if (!raw.seq) raw.seq = { topup: 0 };
      return raw;
    }
  } catch { /* belum ada / rusak -> mulai kosong */ }
  return defaultShop();
}
function saveShop(db) {
  fs.mkdirSync(SHOP_DIR, { recursive: true });
  const tmp = SHOP_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  fs.renameSync(tmp, SHOP_FILE);
}
// Satu-satunya akses database dari luar modul ini (dipakai harness/tes).
let SHOP = loadShop();
function getDb() { return SHOP; }
function reloadDb() { SHOP = loadShop(); return SHOP; }

function getUser(tgUser) {
  const id = String(tgUser.id);
  if (!SHOP.users[id]) {
    SHOP.users[id] = {
      id,
      username: tgUser.username || '',
      first_name: tgUser.first_name || '',
      coins: 0,
      banned: false,
      created_at: new Date().toISOString(),
    };
    saveShop(SHOP);
  } else {
    // Perbarui username/nama bila berubah.
    const u = SHOP.users[id];
    if (tgUser.username && u.username !== tgUser.username) u.username = tgUser.username;
    if (tgUser.first_name && u.first_name !== tgUser.first_name) u.first_name = tgUser.first_name;
  }
  return SHOP.users[id];
}
function isAdmin(tgUserId) {
  return ADMIN_IDS.has(String(tgUserId));
}
function coinPrice() {
  return Number(SHOP.config.coin_price) || 400;
}
function userOrders(userId) {
  return SHOP.orders.filter((o) => String(o.owner_id) === String(userId));
}
function activeOrders(userId) {
  return userOrders(userId).filter((o) => o.status === 'waiting_payment' || o.status === 'paid_unredeemed');
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
async function answerCallback(queryId, text) {
  try {
    await tg('answerCallbackQuery', { callback_query_id: queryId, text: text || '' });
  } catch { /* abaikan */ }
}
const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });

// ------------------------------------------------------------ sesi per chat
const sessions = new Map();
function session(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { step: 'idle' });
  return sessions.get(chatId);
}
function resetSession(chatId) {
  sessions.set(chatId, { step: 'idle' });
}
function privateOnly(chat) {
  return chat.type === 'private';
}
async function needPrivate(chatId, chat) {
  if (privateOnly(chat)) return true;
  await sendMessage(
    chatId,
    '🔒 Layanan toko hanya bisa lewat <b>chat privat</b> dengan bot ini — kode aktivasi eSIM itu rahasia. Silakan chat bot ini secara langsung.',
  );
  return false;
}
async function needNotBanned(chatId, user) {
  if (!user.banned) return true;
  await sendMessage(chatId, '🚫 Akun kamu diblokir oleh admin. Hubungi admin bila ada pertanyaan.');
  return false;
}

// ------------------------------------------------------------ eSIM: ambil, tebus, kirim
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
  throw new Error('QR eSIM belum tersedia setelah menunggu ~2 menit.');
}

function saveEsimQr(orderId, qrCodeB64) {
  fs.mkdirSync(ESIM_QR_DIR, { recursive: true });
  const file = path.join(ESIM_QR_DIR, `esim-${orderId}.png`);
  fs.writeFileSync(file, Buffer.from(qrCodeB64, 'base64'));
  return file;
}

// Kirim QR eSIM + kode aktivasi ke pembeli (dipakai saat tebus berhasil
// dan saat "kirim ulang" dari riwayat). QR juga tersimpan di db/esim-qr/
// sebagai backup admin.
async function deliverEsim(order) {
  const buf = fs.readFileSync(order.qr_file);
  await sendPhoto(
    order.owner_id,
    buf,
    `📱 <b>QR eSIM kamu</b>\nNomor: <code>${esc(order.number)}</code> — ${esc(order.package_name)}\nOrder ID: <code>${order.order_id}</code>`,
  );
  await sendMessage(
    order.owner_id,
    '🔑 <b>Kode aktivasi (LPA):</b>\n' +
      `<code>${esc(order.activation_code)}</code>\n\n` +
      'Cara pasang: Settings → tambah eSIM → scan QR di atas, atau masukkan kode manual.\n' +
      `iPhone: https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(order.activation_code)}\n\n` +
      '⚠️ <b>Kode ini rahasia</b> — jangan diteruskan ke siapa pun.',
  );
}

// Tebus 1 eSIM yang sudah paid dengan 1 coin. Mengembalikan true bila
// berhasil ditebus (coin dipotong + QR dikirim), false bila coin kurang.
async function tryRedeem(order, { silent = false } = {}) {
  const user = SHOP.users[String(order.owner_id)];
  if (!user) return false;
  if (user.coins < 1) {
    if (!silent) {
      await sendMessage(
        order.owner_id,
        `🪙 <b>eSIM sudah dibayar, belum ditebus.</b>\n\nNomor: <code>${esc(order.number)}</code> — ${esc(order.package_name)}\n` +
          `Saldo coin kamu: <b>${user.coins}</b> (butuh 1 coin untuk menebus QR eSIM ini).\n\n` +
          'Top up coin dulu, lalu tebus dari menu 📋 Riwayat.',
        kb([
          [btn('🪙 Top Up Coin', 'tu:menu')],
          [btn('📋 Lihat Riwayat', 'h:menu')],
        ]),
      );
    }
    return false;
  }
  user.coins -= 1;
  order.status = 'redeemed';
  order.redeemed_at = new Date().toISOString();
  saveShop(SHOP);
  await deliverEsim(order);
  await sendMessage(
    order.owner_id,
    `✅ 1 coin dipotong. Sisa saldo: <b>${user.coins} coin</b>.`,
  );
  return true;
}

// ------------------------------------------------------------ background poller
// Dijalankan tiap POLL_SECONDS detik, terpisah dari handler pesan — jadi
// bot tetap responsif walau ada banyak order yang dipantau. Mengecek:
//   - order waiting_payment: paycheck -> paid -> ambil QR eSIM -> tebus
//     (atau tahan sebagai paid_unredeemed bila coin kurang); lewat
//     10 menit tanpa bayar -> expired.
//   - top-up pending yang lebih tua dari 24 jam -> expired.
let polling = false;
async function pollOrdersOnce() {
  if (polling) return;
  polling = true;
  try {
    const now = Date.now();
    for (const order of SHOP.orders) {
      if (order.status !== 'waiting_payment') continue;
      let res;
      try {
        res = await core.paycheck(order.order_id);
      } catch (e) {
        console.error(`⚠️ paycheck ${order.order_id} gagal:`, e.message);
        continue;
      }
      if (res.status === 3) {
        order.status = 'paid_unredeemed';
        order.paid_at = new Date().toISOString();
        saveShop(SHOP);
        let esim;
        try {
          esim = await fetchEsimWithRetry(order.order_code);
        } catch (e) {
          await sendMessage(
            order.owner_id,
            `✅ Pembayaran QRIS untuk <code>${esc(order.number)}</code> sudah masuk, tapi QR eSIM-nya belum siap: ${esc(e.message)}\n\n` +
              'Coba ambil lagi dari menu 📋 Riwayat → "Sudah bayar, belum ditebus".',
          );
          continue;
        }
        order.qr_file = saveEsimQr(order.order_id, esim.qrCode);
        order.activation_code = esim.activation_code;
        saveShop(SHOP);
        await tryRedeem(order);
      } else if (res.status === 21 || now > new Date(order.created_at).getTime() + 10 * 60 * 1000) {
        order.status = 'expired';
        saveShop(SHOP);
        await sendMessage(
          order.owner_id,
          `⌛ QRIS untuk <code>${esc(order.number)}</code> (Order <code>${order.order_id}</code>) kedaluwarsa dan belum dibayar. Order dibatalkan — buat order baru bila masih mau.`,
        );
      }
      await sleep(300);
    }
    // Top-up pending yang sudah lewat 24 jam -> expired.
    for (const t of SHOP.topups) {
      if (t.status === 'pending' && now > new Date(t.created_at).getTime() + TOPUP_EXPIRE_HOURS * 60 * 60 * 1000) {
        t.status = 'expired';
        saveShop(SHOP);
        try {
          await sendMessage(
            t.user_id,
            `⌛ Top up ${t.coins} coin (${rupiah(t.amount_rp)}) kedaluwarsa karena tidak ada konfirmasi dalam 24 jam. Buat top up baru bila masih mau.`,
          );
        } catch { /* abaikan */ }
      }
    }
  } finally {
    polling = false;
  }
}
function startPoller() {
  setInterval(() => {
    pollOrdersOnce().catch((e) => console.error('⚠️ Poller error:', e.message));
  }, POLL_SECONDS * 1000);
}

// ------------------------------------------------------------ menu pembeli
function buyerMenuText(user) {
  return (
    `🛍️ <b>Toko eSIM IM3</b>\n\n` +
    `Halo, ${esc(user.first_name || user.username || 'pembeli')}!\n` +
    `🪙 Saldo coin: <b>${user.coins} coin</b> (1 coin = 1 QR eSIM)\n` +
    `💰 Harga coin: <b>${rupiah(coinPrice())}/coin</b>\n\n` +
    `⚡ <b>Quick Order</b> — langsung dapat QRIS, bisa borong banyak eSIM sekaligus.\n` +
    `🛒 <b>Manual Order</b> — pilih paket, cari nomor sendiri.\n` +
    `📋 <b>Riwayat</b> — order yang sudah diterima, yang sudah bayar tapi belum ditebus, dan yang batal/kedaluwarsa.\n` +
    `🪙 <b>Top Up Coin</b> — isi saldo coin untuk menebus QR eSIM.`
  );
}
function buyerMenuKb() {
  return kb([
    [btn('⚡ Quick Order', 'q:menu'), btn('🛒 Manual Order', 'm:menu')],
    [btn('📋 Riwayat Order', 'h:menu'), btn('🪙 Top Up Coin', 'tu:menu')],
    [btn('❓ Bantuan', 'help:menu')],
  ]);
}
async function showBuyerMenu(chatId, user) {
  resetSession(chatId);
  await sendMessage(chatId, buyerMenuText(user), buyerMenuKb());
}

// ------------------------------------------------------------ Quick Order (pembeli)
// Pilih jumlah -> (cek coin, beri peringatan bila kurang) -> buat N order
// berurutan (nomor + nama + email otomatis, paket default 5GB Rp1) ->
// tiap order langsung dikirim QRIS-nya sebagai foto -> poller memantau
// pembayaran, dan menebus otomatis bila coin cukup.
async function pickRandomNumber(packageId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const all = [];
    for (const c of CATEGORIES) all.push(...await core.listNumbers(packageId, c, ''));
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

async function startQuickOrder(chatId, count) {
  const user = SHOP.users[String(chatId)];
  const pkg = { id: 4324, name: 'Perdana eSIM 5GB', price: 1 };
  let made = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) await sleep(CREATE_DELAY_MS);
    try {
      const chosen = await pickRandomNumber(pkg.id);
      if (!chosen) {
        await sendMessage(chatId, `⚠️ Order ${i + 1}/${count}: tidak dapat nomor — lewati.`);
        continue;
      }
      const name = randomName();
      const email = randomEmail(name);
      const created = await core.createOrder({
        numberId: chosen.id, name, phone: '', email, packageId: pkg.id,
      });
      const detail = await core.orderDetail(created.order_code_decoded);
      const order = {
        order_id: detail.order_code,
        order_code: created.order_code_decoded,
        number: detail.order_number,
        number_id: chosen.id,
        package_id: pkg.id,
        package_name: detail.package_name,
        total_price: detail.total_price,
        owner_id: String(chatId),
        owner_username: user ? user.username : '',
        status: 'waiting_payment',
        created_at: new Date().toISOString(),
        paid_at: null,
        redeemed_at: null,
        qr_file: null,
        activation_code: null,
      };
      SHOP.orders.push(order);
      saveShop(SHOP);
      made++;
      await sendPhoto(
        chatId,
        Buffer.from(created.qr_link, 'base64'),
        `🧾 <b>QRIS ${i + 1}/${count} — bayar ${rupiah(order.total_price)}</b>\n` +
          `Order ID: <code>${order.order_id}</code>\nNomor: <code>${order.number}</code> — ${order.package_name}\n` +
          `Berlaku 10 menit. Scan pakai aplikasi pembayaran apa saja.`,
      );
    } catch (e) {
      await sendMessage(chatId, `❌ Order ${i + 1}/${count} gagal dibuat: ${esc(e.message.split('\n')[0])}`);
    }
  }
  if (made > 0) {
    await sendMessage(
      chatId,
      `✅ ${made} QRIS terkirim. Bayar masing-masing sebelum 10 menit.\n\n` +
        `Begitu terbayar, QR eSIM otomatis ditebus (1 coin per eSIM, saldo kamu sekarang: <b>${SHOP.users[String(chatId)] ? SHOP.users[String(chatId)].coins : 0} coin</b>) — atau masuk riwayat "belum ditebus" kalau coin kurang.`,
      buyerMenuKb(),
    );
  } else {
    await sendMessage(chatId, '❌ Tidak ada order yang berhasil dibuat. Coba lagi nanti.', buyerMenuKb());
  }
  resetSession(chatId);
}

async function askQuickCount(chatId) {
  const s = session(chatId);
  s.step = 'qcount';
  await sendMessage(
    chatId,
    '⚡ <b>Quick Order</b>\n\nBerapa eSIM yang mau diborong sekaligus? Ketik jumlah [1-10]:\n\n' +
      'Nomor, nama, dan email dipilih otomatis. Paket: Perdana eSIM 5GB Rp1.\n' +
      'Tiap eSIM butuh 1 coin untuk menebus QR-nya setelah QRIS dibayar.',
  );
}

async function confirmQuick(chatId, count) {
  const user = SHOP.users[String(chatId)];
  const s = session(chatId);
  s.quickCount = count;
  if (user.coins < count) {
    s.step = 'idle';
    await sendMessage(
      chatId,
      `⚠️ <b>Saldo coin kurang.</b>\n\nKamu mau borong <b>${count} eSIM</b> (butuh ${count} coin untuk menebus semuanya), tapi saldo kamu cuma <b>${user.coins} coin</b>.\n\n` +
        'Kamu bisa tetap lanjut — QRIS dibuat dulu, dan eSIM yang sudah dibayar bisa ditebus nanti setelah top up. Atau top up sekarang.',
      kb([
        [btn('🪙 Top Up Dulu', 'q:topup')],
        [btn('➡️ Lanjut Tanpa Coin', 'q:go')],
        [btn('❌ Batal', 'q:cancel')],
      ]),
    );
    return;
  }
  s.step = 'qconfirm';
  await sendMessage(
    chatId,
    `📋 <b>Quick Order — ${count}x Perdana eSIM 5GB Rp1</b>\n\nTotal QRIS: ${rupiah(count * 1)} (${count} QRIS @ Rp1)\n` +
      `Coin yang akan dipotong saat tebus: ${count} coin (saldo kamu: ${user.coins} coin)\n\nBuat ${count} order sekarang?`,
    kb([
      [btn('✅ Ya, buat order', 'q:go')],
      [btn('❌ Batal', 'q:cancel')],
    ]),
  );
}

// ------------------------------------------------------------ Manual Order (pembeli)
async function startManualOrder(chatId) {
  const s = session(chatId);
  let pkgs;
  try {
    pkgs = await core.listPackages();
  } catch (e) {
    return sendMessage(chatId, `❌ Gagal ambil daftar paket: ${e.message}`);
  }
  s.pkgs = pkgs;
  s.step = 'pkg';
  const rows = pkgs.map((p) => [btn(`${p.name} — ${rupiah(p.price)}`, `pkg:${p.id}`)]);
  await sendMessage(chatId, '📦 <b>Pilih paket eSIM:</b>', kb(rows));
}

async function askNumberMode(chatId) {
  const s = session(chatId);
  s.step = 'numMode';
  await sendMessage(
    chatId,
    `Paket: <b>${esc(s.pkg.name)}</b> — ${rupiah(s.pkg.price)}\n\nCari nomor bagaimana?`,
    kb([
      [btn('🔢 Pilih manual (ketik digit)', 'mode:manual')],
      [btn('🎯 Auto hunt nomor cantik', 'mode:hunt')],
    ]),
  );
}

async function fetchNumbers(chatId, search) {
  const s = session(chatId);
  const all = [];
  for (const c of CATEGORIES) all.push(...await core.listNumbers(s.pkg.id, c, search));
  return all;
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
  await sendMessage(chatId, `Nomor tersedia (paket ${esc(s.pkg.name)}):\n\n${lines}\n\nPilih nomor:`, kb(rows));
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
    `Nama: <b>${esc(s.name)}</b>\n\nKetik <b>email</b>, atau pakai email random dari nama itu:`,
    kb([[btn('🎲 Email random', 'email:random')]]),
  );
}

async function askPhone(chatId) {
  const s = session(chatId);
  s.step = 'phone';
  await sendMessage(
    chatId,
    `Email: <b>${esc(s.email)}</b>\n\nKetik <b>nomor WhatsApp</b> (opsional, min. 10 karakter), atau lewati:`,
    kb([[btn('⏭️ Lewati (tanpa WA)', 'phone:skip')]]),
  );
}

async function askConfirm(chatId) {
  const s = session(chatId);
  const user = SHOP.users[String(chatId)];
  s.step = 'confirm';
  await sendMessage(
    chatId,
    '📋 <b>Ringkasan order:</b>\n\n' +
      `Nomor: <code>${s.chosen.number}</code> [${s.chosen.label}]\n` +
      `Paket: ${esc(s.pkg.name)} — ${rupiah(s.pkg.price)}\n` +
      `Nama: ${esc(s.name)}\nEmail: ${esc(s.email)}\n` +
      (s.phone ? `WA: ${esc(s.phone)}\n` : '') +
      `\nSetelah QRIS dibayar, QR eSIM ditebus pakai 1 coin (saldo kamu: ${user ? user.coins : 0} coin).\n\nBuat order QRIS nyata sekarang?`,
    kb([
      [btn('✅ Ya, buat order', 'confirm:yes')],
      [btn('❌ Batal', 'confirm:no')],
    ]),
  );
}

function parseHuntCrit(digits, prefix, contains, ends) {
  return {
    digits: new Set(String(digits || '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0)),
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
    `🎯 <b>Auto hunt nomor cantik</b> (paket ${esc(s.pkg.name)})\nKriteria: ${esc(describeCrit(crit))}\n\nMencari... (maks 50 percobaan, ~32 nomor/percobaan)`,
  );
  let res;
  try {
    res = await core.huntNumbers({
      packageId: s.pkg.id, categories: CATEGORIES, crit, maxAttempts: 50, delayMs: 800,
    });
  } catch (e) {
    return sendMessage(chatId, `❌ Hunt gagal: ${esc(e.message)}`);
  }
  if (!res.hits.length) {
    s.step = 'idle';
    return sendMessage(
      chatId,
      res.rateLimited
        ? '⚠️ Berhenti karena server me-throttle (429). Tunggu beberapa menit, lalu coba lagi.'
        : `❌ Tidak ketemu setelah ${res.attempts} percobaan (${res.checked} nomor dicek). Coba longgarkan kriteria.`,
      buyerMenuKb(),
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

async function doCreateManualOrder(chatId) {
  const s = session(chatId);
  const user = SHOP.users[String(chatId)];
  let avail;
  try {
    avail = await core.checkNumber(s.chosen.id);
  } catch (e) {
    return sendMessage(chatId, `❌ Gagal validasi nomor: ${esc(e.message)}`);
  }
  if (avail && avail.available === false) {
    s.step = 'idle';
    return sendMessage(
      chatId,
      `❌ Nomor <code>${s.chosen.number}</code> sudah diambil orang lain. Jalankan Manual Order lagi untuk cari nomor lain.`,
      buyerMenuKb(),
    );
  }
  let created;
  try {
    created = await core.createOrder({
      numberId: s.chosen.id, name: s.name, phone: s.phone || '', email: s.email, packageId: s.pkg.id,
    });
  } catch (e) {
    return sendMessage(chatId, `❌ Gagal membuat order: ${esc(e.message)}`);
  }
  const detail = await core.orderDetail(created.order_code_decoded);
  const order = {
    order_id: detail.order_code,
    order_code: created.order_code_decoded,
    number: detail.order_number,
    number_id: s.chosen.id,
    package_id: s.pkg.id,
    package_name: detail.package_name,
    total_price: detail.total_price,
    owner_id: String(chatId),
    owner_username: user ? user.username : '',
    status: 'waiting_payment',
    created_at: new Date().toISOString(),
    paid_at: null,
    redeemed_at: null,
    qr_file: null,
    activation_code: null,
  };
  SHOP.orders.push(order);
  saveShop(SHOP);
  s.step = 'idle';
  await sendPhoto(
    chatId,
    Buffer.from(created.qr_link, 'base64'),
    `🧾 <b>QRIS — bayar ${rupiah(order.total_price)}</b>\n` +
      `Order ID: <code>${order.order_id}</code>\nNomor: <code>${order.number}</code> — ${esc(order.package_name)}\n` +
      `Berlaku 10 menit. Scan pakai aplikasi pembayaran apa saja.`,
  );
  await sendMessage(
    chatId,
    '⏳ Saya pantau pembayarannya otomatis. Begitu terbayar, QR eSIM ditebus pakai 1 coin ' +
      `(saldo kamu: <b>${user ? user.coins : 0} coin</b>) — atau masuk riwayat "belum ditebus" kalau coin kurang.`,
    buyerMenuKb(),
  );
}

// ------------------------------------------------------------ Riwayat (pembeli)
async function showHistory(chatId) {
  const orders = userOrders(chatId).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const redeemed = orders.filter((o) => o.status === 'redeemed').slice(0, 10);
  const unredeemed = orders.filter((o) => o.status === 'paid_unredeemed').slice(0, 10);
  const dead = orders.filter((o) => o.status === 'expired' || o.status === 'canceled').slice(0, 10);
  const waiting = orders.filter((o) => o.status === 'waiting_payment').slice(0, 10);
  let text = '📋 <b>Riwayat Order Kamu</b>\n';
  const rows = [];
  if (waiting.length) {
    text += '\n⏳ <b>Menunggu bayar QRIS:</b>\n';
    waiting.forEach((o) => { text += `• <code>${esc(o.number)}</code> — ${esc(o.package_name)} | Order <code>${o.order_id}</code>\n`; });
  }
  if (redeemed.length) {
    text += '\n✅ <b>Sudah diterima (QR eSIM sudah dikirim):</b>\n';
    redeemed.forEach((o, i) => {
      text += `${i + 1}. <code>${esc(o.number)}</code> — ${esc(o.package_name)} | Order <code>${o.order_id}</code>\n`;
      rows.push([btn(`📱 Kirim ulang QR ${o.number}`, `h:resend:${o.order_id}`)]);
    });
  }
  if (unredeemed.length) {
    text += '\n🪙 <b>Sudah bayar QRIS, belum ditebus pakai coin:</b>\n';
    unredeemed.forEach((o) => {
      text += `• <code>${esc(o.number)}</code> — ${esc(o.package_name)} | Order <code>${o.order_id}</code>\n`;
      rows.push([btn(`🔓 Tebus 1 coin — ${o.number}`, `h:redeem:${o.order_id}`)]);
    });
  }
  if (dead.length) {
    text += '\n❌ <b>Batal / kedaluwarsa:</b>\n';
    dead.forEach((o) => { text += `• <code>${esc(o.number)}</code> — ${esc(o.package_name)} | Order <code>${o.order_id}</code> (${o.status === 'expired' ? 'QRIS kedaluwarsa' : 'dibatalkan'})\n`; });
  }
  if (!orders.length) text += '\nBelum ada order. Yuk order eSIM pertama kamu! 🎉';
  rows.push([btn('🔙 Kembali ke Menu', 'menu:main')]);
  await sendMessage(chatId, text, kb(rows));
}

// ------------------------------------------------------------ Top Up Coin (pembeli)
async function showTopupMenu(chatId) {
  const user = SHOP.users[String(chatId)];
  const s = session(chatId);
  s.step = 'idle';
  await sendMessage(
    chatId,
    `🪙 <b>Top Up Coin</b>\n\nSaldo kamu: <b>${user.coins} coin</b>\nHarga: <b>${rupiah(coinPrice())} / coin</b>\n\nPilih jumlah coin:`,
    kb([
      [btn('1 coin', 'tu:pick:1'), btn('5 coin', 'tu:pick:5')],
      [btn('10 coin', 'tu:pick:10'), btn('25 coin', 'tu:pick:25')],
      [btn('50 coin', 'tu:pick:50'), btn('✏️ Jumlah lain', 'tu:custom')],
      [btn('🔙 Kembali ke Menu', 'menu:main')],
    ]),
  );
}

async function askTopupConfirm(chatId, coins) {
  const s = session(chatId);
  s.tuCoins = coins;
  const total = coins * coinPrice();
  const payInfo = SHOP.config.payment_info
    ? `\n\n💳 <b>Cara bayar:</b>\n${esc(SHOP.config.payment_info)}`
    : '\n\n💳 <b>Cara bayar:</b> hubungi admin untuk info pembayaran (transfer / QRIS).';
  await sendMessage(
    chatId,
    `🪙 <b>Top Up ${coins} coin — total ${rupiah(total)}</b>${payInfo}\n\n` +
      'Setelah bayar, tekan tombol di bawah. Admin akan memeriksa dan coin masuk ke saldo kamu (maks. 24 jam, hubungi admin bila lebih dari itu).',
    kb([
      [btn('✅ Saya Sudah Bayar', 'tu:paid')],
      [btn('❌ Batal', 'tu:cancel')],
    ]),
  );
}

async function submitTopup(chatId) {
  const s = session(chatId);
  const user = SHOP.users[String(chatId)];
  const coins = s.tuCoins;
  if (!coins || coins < 1) return showTopupMenu(chatId);
  SHOP.seq.topup += 1;
  const t = {
    id: `T${SHOP.seq.topup}`,
    user_id: String(chatId),
    username: user.username || '',
    coins,
    amount_rp: coins * coinPrice(),
    status: 'pending',
    created_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
  };
  SHOP.topups.push(t);
  saveShop(SHOP);
  resetSession(chatId);
  await sendMessage(
    chatId,
    `✅ Top up <b>${coins} coin (${rupiah(t.amount_rp)})</b> dicatat (ID: <code>${t.id}</code>).\n\nMenunggu admin memeriksa pembayaran kamu. Coin masuk begitu admin approve.`,
    buyerMenuKb(),
  );
  // Beri tahu semua admin.
  for (const adminId of ADMIN_IDS) {
    try {
      await sendMessage(
        adminId,
        `🔔 <b>Top up baru menunggu approve</b>\n\nID: <code>${t.id}</code>\nPembeli: ${esc(user.first_name || '')} (@${esc(user.username || '-')}, <code>${t.user_id}</code>)\n` +
          `Jumlah: <b>${coins} coin</b> — ${rupiah(t.amount_rp)}\nWaktu: ${t.created_at}`,
        kb([
          [btn(`✅ Approve ${t.id}`, `tu:ok:${t.id}`), btn(`❌ Tolak ${t.id}`, `tu:no:${t.id}`)],
        ]),
      );
    } catch { /* admin tidak bisa dihubungi — abaikan */ }
  }
}

// ------------------------------------------------------------ Bantuan (pembeli)
async function showHelp(chatId) {
  const rows = [];
  if (ADMIN_USERNAME) rows.push([urlBtn('💬 Chat Admin', `https://t.me/${ADMIN_USERNAME}`)]);
  rows.push([btn('🔙 Kembali ke Menu', 'menu:main')]);
  await sendMessage(
    chatId,
    '❓ <b>Bantuan</b>\n\n' +
      '• <b>Quick Order</b>: borong eSIM langsung, QRIS tampil, tebus pakai 1 coin per eSIM.\n' +
      '• <b>Manual Order</b>: pilih paket + nomor sendiri.\n' +
      '• <b>Riwayat</b>: lihat order yang sudah diterima, yang sudah bayar tapi belum ditebus, dan yang batal.\n' +
      '• <b>Top Up</b>: 1 coin = 1 QR eSIM. Bayar manual, admin approve, coin masuk.\n' +
      '• QR eSIM + kode aktivasi bersifat rahasia — jangan diteruskan ke siapa pun.\n\n' +
      (ADMIN_USERNAME ? 'Ada masalah? Chat admin lewat tombol di bawah.' : 'Ada masalah? Hubungi admin toko.'),
    kb(rows),
  );
}

// ------------------------------------------------------------ menu admin
function adminMenuKb() {
  return kb([
    [btn('👥 Pembeli', 'adm:users'), btn('🪙 Coin & Top Up', 'adm:tu')],
    [btn('📦 QR eSIM', 'adm:esim'), btn('📊 Statistik', 'adm:stats')],
    [btn('💰 Harga Coin', 'adm:price'), btn('💳 Info Bayar Top Up', 'adm:payinfo')],
    [btn('📣 Broadcast', 'adm:broadcast')],
    [btn('🛍️ Menu Pembeli', 'menu:main')],
  ]);
}
async function showAdminMenu(chatId) {
  resetSession(chatId);
  await sendMessage(
    chatId,
    `🛠️ <b>Menu Admin</b>\n\nHarga coin saat ini: <b>${rupiah(coinPrice())}/coin</b>\n` +
      `Top up menunggu approve: <b>${SHOP.topups.filter((t) => t.status === 'pending').length}</b>\n` +
      `Total pembeli: <b>${Object.keys(SHOP.users).length}</b>`,
    adminMenuKb(),
  );
}

async function showBuyers(chatId) {
  const users = Object.values(SHOP.users)
    .sort((a, b) => (b.coins - a.coins) || String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 20);
  if (!users.length) return sendMessage(chatId, 'Belum ada pembeli.', adminMenuKb());
  const lines = users.map((u, i) =>
    `${i + 1}. ${esc(u.first_name || '-')} (@${esc(u.username || '-')}) — <b>${u.coins} coin</b>${u.banned ? ' 🚫' : ''} | <code>${u.id}</code>`,
  ).join('\n');
  const rows = users.map((u) => [btn(`👤 ${u.first_name || u.username || u.id} (${u.coins}🪙)`, `adm:u:${u.id}`)]);
  rows.push([btn('🔙 Menu Admin', 'adm:menu')]);
  await sendMessage(chatId, `👥 <b>Pembeli (20 teratas, urut coin):</b>\n\n${lines}\n\nPilih pembeli untuk detail:`, kb(rows));
}

async function showBuyerDetail(chatId, userId) {
  const u = SHOP.users[String(userId)];
  if (!u) return sendMessage(chatId, 'Pembeli tidak ditemukan.', adminMenuKb());
  const orders = userOrders(userId);
  const counts = {
    waiting: orders.filter((o) => o.status === 'waiting_payment').length,
    unredeemed: orders.filter((o) => o.status === 'paid_unredeemed').length,
    redeemed: orders.filter((o) => o.status === 'redeemed').length,
    dead: orders.filter((o) => o.status === 'expired' || o.status === 'canceled').length,
  };
  await sendMessage(
    chatId,
    `👤 <b>${esc(u.first_name || '-')}</b> (@${esc(u.username || '-')})\n` +
      `ID: <code>${u.id}</code> | Sejak: ${u.created_at.slice(0, 10)}\n` +
      `🪙 Saldo: <b>${u.coins} coin</b> ${u.banned ? '| 🚫 <b>DIBLOKIR</b>' : ''}\n\n` +
      `📋 Order: menunggu bayar ${counts.waiting} | belum ditebus ${counts.unredeemed} | diterima ${counts.redeemed} | batal/kedaluwarsa ${counts.dead}`,
    kb([
      [btn('+1 🪙', `adm:coin:${u.id}:1`), btn('+5 🪙', `adm:coin:${u.id}:5`), btn('−1 🪙', `adm:coin:${u.id}:-1`)],
      [btn(u.banned ? '✅ Unban' : '🚫 Ban', `adm:ban:${u.id}`), btn('📋 Order pembeli ini', `adm:uo:${u.id}`)],
      [btn('🔙 Daftar Pembeli', 'adm:users'), btn('🔙 Menu Admin', 'adm:menu')],
    ]),
  );
}

async function showUserOrdersAdmin(chatId, userId) {
  const u = SHOP.users[String(userId)];
  const orders = userOrders(userId).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 10);
  if (!u) return sendMessage(chatId, 'Pembeli tidak ditemukan.', adminMenuKb());
  let text = `📋 <b>Order ${esc(u.first_name || u.username || userId)}</b>\n`;
  const rows = [];
  if (!orders.length) text += '\nBelum ada order.';
  orders.forEach((o) => {
    const label = { waiting_payment: 'menunggu bayar', paid_unredeemed: 'sudah bayar, belum ditebus', redeemed: 'diterima', expired: 'kedaluwarsa', canceled: 'dibatalkan' }[o.status] || o.status;
    text += `\n• <code>${esc(o.number)}</code> — ${esc(o.package_name)} | ${label} | Order <code>${o.order_id}</code>`;
    if (o.status === 'redeemed' || o.status === 'paid_unredeemed') rows.push([btn(`📱 QR ${o.number}`, `adm:e:${o.order_id}`)]);
  });
  rows.push([btn('🔙 Detail Pembeli', `adm:u:${userId}`), btn('🔙 Menu Admin', 'adm:menu')]);
  await sendMessage(chatId, text, kb(rows));
}

async function showPendingTopups(chatId) {
  const pending = SHOP.topups.filter((t) => t.status === 'pending')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  let text = `🪙 <b>Coin & Top Up</b>\n\nHarga coin: <b>${rupiah(coinPrice())}/coin</b>\n` +
    `Info bayar: ${SHOP.config.payment_info ? esc(SHOP.config.payment_info) : '(belum diisi — atur lewat tombol "Info Bayar Top Up")'}\n`;
  const rows = [];
  if (!pending.length) text += '\nTidak ada top up yang menunggu approve.';
  else {
    text += `\n🔔 <b>Menunggu approve (${pending.length}):</b>\n`;
    pending.forEach((t) => {
      text += `• <code>${t.id}</code> — ${t.coins} coin (${rupiah(t.amount_rp)}) | ${esc(t.username || t.user_id)} | ${t.created_at.slice(0, 16).replace('T', ' ')}\n`;
      rows.push([btn(`✅ Approve ${t.id}`, `tu:ok:${t.id}`), btn(`❌ Tolak ${t.id}`, `tu:no:${t.id}`)]);
    });
  }
  rows.push([btn('💰 Ubah Harga Coin', 'adm:price'), btn('🔙 Menu Admin', 'adm:menu')]);
  await sendMessage(chatId, text, kb(rows));
}

async function decideTopup(adminId, topupId, approve) {
  const t = SHOP.topups.find((x) => x.id === topupId);
  if (!t) return;
  if (t.status !== 'pending') return;
  t.status = approve ? 'approved' : 'rejected';
  t.decided_at = new Date().toISOString();
  t.decided_by = String(adminId);
  if (approve) {
    const u = SHOP.users[String(t.user_id)];
    if (u && !u.banned) u.coins += t.coins;
  }
  saveShop(SHOP);
  const u = SHOP.users[String(t.user_id)];
  try {
    await sendMessage(
      t.user_id,
      approve
        ? `✅ <b>Top up ${t.coins} coin (${rupiah(t.amount_rp)}) di-approve!</b>\n\nSaldo kamu sekarang: <b>${u ? u.coins : '?'} coin</b>. Selamat belanja! 🛍️`
        : `❌ Top up ${t.coins} coin (${rupiah(t.amount_rp)}) <b>ditolak</b> oleh admin.\n\nBila kamu sudah membayar, hubungi admin lewat menu ❓ Bantuan.`,
      buyerMenuKb(),
    );
  } catch { /* pembeli tidak bisa dihubungi */ }
}

async function showEsimAdmin(chatId) {
  const orders = SHOP.orders
    .filter((o) => o.status === 'redeemed' || o.status === 'paid_unredeemed')
    .slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 20);
  let text = '📦 <b>QR eSIM (backup admin)</b>\n';
  const rows = [];
  if (!orders.length) text += '\nBelum ada eSIM yang terbayar.';
  orders.forEach((o) => {
    const owner = SHOP.users[String(o.owner_id)];
    const label = o.status === 'redeemed' ? 'diterima' : 'belum ditebus';
    text += `\n• <code>${esc(o.number)}</code> — ${esc(o.package_name)} | ${label} | pemilik: ${esc(owner ? (owner.first_name || owner.username || o.owner_id) : o.owner_id)} (@${esc(owner && owner.username ? owner.username : '-')}) | Order <code>${o.order_id}</code>`;
    rows.push([btn(`📱 QR ${o.number}`, `adm:e:${o.order_id}`)]);
  });
  rows.push([btn('🔙 Menu Admin', 'adm:menu')]);
  await sendMessage(chatId, text, kb(rows));
}

async function showEsimDetailAdmin(chatId, orderId) {
  const o = SHOP.orders.find((x) => String(x.order_id) === String(orderId));
  if (!o) return sendMessage(chatId, 'Order tidak ditemukan.', adminMenuKb());
  const owner = SHOP.users[String(o.owner_id)];
  const label = { waiting_payment: 'menunggu bayar', paid_unredeemed: 'sudah bayar, belum ditebus', redeemed: 'diterima', expired: 'kedaluwarsa', canceled: 'dibatalkan' }[o.status] || o.status;
  if (o.qr_file && fs.existsSync(o.qr_file)) {
    await sendPhoto(
      chatId,
      fs.readFileSync(o.qr_file),
      `📱 <b>QR eSIM (backup admin)</b>\nNomor: <code>${esc(o.number)}</code> — ${esc(o.package_name)}\n` +
        `Order ID: <code>${o.order_id}</code> | Status: ${label}\n` +
        `Pemilik: ${esc(owner ? (owner.first_name || '-') : '-')} (@${esc(owner && owner.username ? owner.username : '-')}, <code>${o.owner_id}</code>)`,
    );
  }
  await sendMessage(
    chatId,
    `🔑 <b>Kode aktivasi (LPA):</b>\n<code>${esc(o.activation_code || '(belum tersedia)')}</code>\n\n` +
      `Order: <code>${o.order_id}</code> | Dibuat: ${String(o.created_at).slice(0, 16).replace('T', ' ')}` +
      (o.paid_at ? ` | Dibayar: ${String(o.paid_at).slice(0, 16).replace('T', ' ')}` : '') +
      (o.redeemed_at ? ` | Ditebus: ${String(o.redeemed_at).slice(0, 16).replace('T', ' ')}` : ''),
    adminMenuKb(),
  );
}

async function showStats(chatId) {
  const users = Object.values(SHOP.users);
  const orders = SHOP.orders;
  const approved = SHOP.topups.filter((t) => t.status === 'approved');
  const revenue = approved.reduce((s, t) => s + Number(t.amount_rp || 0), 0);
  const coinsOut = orders.filter((o) => o.status === 'redeemed').length;
  const coinsHeld = users.reduce((s, u) => s + Number(u.coins || 0), 0);
  await sendMessage(
    chatId,
    '📊 <b>Statistik Toko</b>\n\n' +
      `👥 Pembeli terdaftar: <b>${users.length}</b> (${users.filter((u) => u.banned).length} diblokir)\n` +
      `🪙 Coin beredar di saldo pembeli: <b>${coinsHeld} coin</b>\n` +
      `📱 eSIM terkirim (ditebus): <b>${coinsOut}</b>\n` +
      `⏳ Sudah bayar, belum ditebus: <b>${orders.filter((o) => o.status === 'paid_unredeemed').length}</b>\n` +
      `⌛ Menunggu bayar QRIS: <b>${orders.filter((o) => o.status === 'waiting_payment').length}</b>\n` +
      `❌ Batal/kedaluwarsa: <b>${orders.filter((o) => o.status === 'expired' || o.status === 'canceled').length}</b>\n` +
      `💰 Top up di-approve: <b>${approved.length}x — ${rupiah(revenue)}</b>\n` +
      `🔔 Top up menunggu approve: <b>${SHOP.topups.filter((t) => t.status === 'pending').length}</b>`,
    adminMenuKb(),
  );
}

// ------------------------------------------------------------ update handler
async function handleMessage(msg) {
  const chat = msg.chat;
  const chatId = chat.id;
  const text = (msg.text || '').trim();
  const user = getUser(msg.from);
  const s = session(chatId);
  if (!text) return;
  if (!(await needPrivate(chatId, chat))) return;
  if (!(await needNotBanned(chatId, user))) return;

  if (text === '/start') return showBuyerMenu(chatId, user);
  if (text === '/admin') {
    if (!isAdmin(msg.from.id)) return sendMessage(chatId, '🚫 Perintah ini hanya untuk admin toko.');
    return showAdminMenu(chatId);
  }
  if (text === '/cancel') {
    resetSession(chatId);
    return showBuyerMenu(chatId, user);
  }

  switch (s.step) {
    case 'qcount': {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1 || n > QUICK_MAX) {
        return sendMessage(chatId, `Ketik jumlah 1–${QUICK_MAX}. Coba lagi, atau /cancel untuk batal.`);
      }
      if (activeOrders(chatId).length + n > MAX_ACTIVE_ORDERS) {
        resetSession(chatId);
        return sendMessage(
          chatId,
          `⚠️ Kamu sudah punya ${activeOrders(chatId).length} order aktif (maks ${MAX_ACTIVE_ORDERS}). Selesaikan / tunggu order yang ada dulu, baru borong lagi.`,
          buyerMenuKb(),
        );
      }
      s.step = 'idle';
      return confirmQuick(chatId, n);
    }
    case 'numSearch': {
      if (text.length < 3 && text !== '-') {
        return sendMessage(chatId, 'Minimal 3 digit. Coba lagi, atau ketik <code>-</code> untuk acak.');
      }
      await sendMessage(chatId, '🔍 Mencari nomor...');
      try {
        const all = await fetchNumbers(chatId, text === '-' ? '' : text);
        if (!all.length) return sendMessage(chatId, 'Tidak ada nomor — coba digit lain.');
        return showNumbers(chatId, all);
      } catch (e) {
        return sendMessage(chatId, `❌ Gagal cari nomor: ${esc(e.message)}`);
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
    case 'tucustom': {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        return sendMessage(chatId, 'Ketik jumlah coin 1–1000. Coba lagi, atau /cancel untuk batal.');
      }
      s.step = 'idle';
      return askTopupConfirm(chatId, n);
    }
    case 'adm_price': {
      const n = Number(text.replace(/[^0-9]/g, ''));
      if (!n || n < 1) return sendMessage(chatId, 'Harga tidak valid. Ketik angka rupiah per coin, misal <code>400</code>.');
      SHOP.config.coin_price = n;
      saveShop(SHOP);
      s.step = 'idle';
      return sendMessage(chatId, `✅ Harga coin diubah jadi <b>${rupiah(n)}/coin</b>.`, adminMenuKb());
    }
    case 'adm_payinfo': {
      SHOP.config.payment_info = text;
      saveShop(SHOP);
      s.step = 'idle';
      return sendMessage(chatId, '✅ Info bayar top up disimpan. Pembeli akan melihat teks ini saat top up.', adminMenuKb());
    }
    case 'adm_broadcast': {
      s.broadcastText = text;
      s.step = 'idle';
      return sendMessage(
        chatId,
        `📣 <b>Broadcast ke ${Object.values(SHOP.users).filter((u) => !u.banned).length} pembeli:</b>\n\n${esc(text)}\n\nKirim sekarang?`,
        kb([
          [btn('✅ Ya, kirim', 'adm:bc:yes')],
          [btn('❌ Batal', 'adm:bc:no')],
        ]),
      );
    }
    default:
      return showBuyerMenu(chatId, user);
  }
}

async function handleCallback(query) {
  const chat = query.message.chat;
  const chatId = chat.id;
  const data = query.data || '';
  const user = getUser(query.from);
  const s = session(chatId);
  await answerCallback(query.id);
  if (!(await needPrivate(chatId, chat))) return;
  if (!(await needNotBanned(chatId, user))) return;
  const [kind, a, b, c] = data.split(':');

  if (kind === 'menu') {
    if (a === 'main') return showBuyerMenu(chatId, user);
    return;
  }
  // ---- Quick Order
  if (kind === 'q') {
    if (a === 'menu') return askQuickCount(chatId);
    if (a === 'go') {
      const n = s.quickCount || 1;
      resetSession(chatId);
      await sendMessage(chatId, `⏳ Membuat ${n} order... QRIS dikirim satu per satu di bawah.`);
      startQuickOrder(chatId, n).catch((e) => sendMessage(chatId, `⚠️ Quick Order berhenti: ${esc(e.message)}`));
      return;
    }
    if (a === 'topup') return showTopupMenu(chatId);
    if (a === 'cancel') {
      resetSession(chatId);
      return showBuyerMenu(chatId, user);
    }
    return;
  }
  // ---- Manual Order
  if (kind === 'm') {
    if (a === 'menu') return startManualOrder(chatId);
    return;
  }
  if (kind === 'pkg') {
    const pkg = (s.pkgs || []).find((p) => String(p.id) === a);
    if (!pkg) return sendMessage(chatId, 'Paket tidak ditemukan. Mulai lagi dari menu.');
    s.pkg = pkg;
    return askNumberMode(chatId);
  }
  if (kind === 'mode') {
    if (a === 'manual') {
      s.step = 'numSearch';
      return sendMessage(chatId, '🔢 Ketik digit yang dicari (min 3, misal <code>1122</code>), atau <code>-</code> untuk nomor acak:');
    }
    s.step = 'huntDigits';
    return sendMessage(chatId, '🎯 <b>Auto hunt nomor cantik</b>\n\nJumlah digit yang dicari? Ketik misal <code>11</code>, atau <code>11,12</code> — ketik <code>-</code> untuk apa saja.');
  }
  if (kind === 'n') {
    if (a === 'reshuffle') {
      await sendMessage(chatId, '🔄 Mengacak nomor baru...');
      try {
        const all = await fetchNumbers(chatId, '');
        if (!all.length) return sendMessage(chatId, 'Tidak ada nomor. Coba lagi.');
        return showNumbers(chatId, all);
      } catch (e) {
        return sendMessage(chatId, `❌ Gagal cari nomor: ${esc(e.message)}`);
      }
    }
    if (a === 'research') {
      s.step = 'numSearch';
      return sendMessage(chatId, '🔢 Ketik digit yang dicari (min 3), atau <code>-</code> untuk acak:');
    }
    const chosen = (s.numbers || [])[Number(a)];
    if (!chosen) return sendMessage(chatId, 'Pilihan tidak ada. Mulai lagi dari menu.');
    s.chosen = chosen;
    return askName(chatId);
  }
  if (kind === 'h') {
    if (a === 'menu') return showHistory(chatId);
    if (a === 'resend') {
      const o = SHOP.orders.find((x) => String(x.order_id) === String(b));
      if (!o || String(o.owner_id) !== String(chatId)) return sendMessage(chatId, 'Order tidak ditemukan.');
      if (o.status !== 'redeemed' || !o.qr_file) return sendMessage(chatId, 'QR eSIM order ini belum tersedia.');
      await deliverEsim(o);
      return;
    }
    if (a === 'redeem') {
      const o = SHOP.orders.find((x) => String(x.order_id) === String(b));
      if (!o || String(o.owner_id) !== String(chatId)) return sendMessage(chatId, 'Order tidak ditemukan.');
      if (o.status !== 'paid_unredeemed') return sendMessage(chatId, 'Order ini tidak bisa ditebus (bukan status sudah-bayar-belum-ditebus).');
      const ok = await tryRedeem(o);
      if (ok) await showHistory(chatId);
      return;
    }
    // h:<index> — pilih nomor hasil hunt
    const chosen = (s.hits || [])[Number(a)];
    if (!chosen) return sendMessage(chatId, 'Pilihan tidak ada. Mulai lagi dari menu.');
    s.chosen = chosen;
    return askName(chatId);
  }
  if (kind === 'name' && a === 'random') {
    s.name = randomName();
    return askEmail(chatId);
  }
  if (kind === 'email' && a === 'random') {
    s.email = randomEmail(s.name || 'user');
    return askPhone(chatId);
  }
  if (kind === 'phone' && a === 'skip') {
    s.phone = '';
    return askConfirm(chatId);
  }
  if (kind === 'confirm') {
    if (a === 'yes') {
      await sendMessage(chatId, '⏳ Membuat order QRIS...');
      return doCreateManualOrder(chatId);
    }
    resetSession(chatId);
    return showBuyerMenu(chatId, user);
  }
  // ---- Top Up
  if (kind === 'tu') {
    if (a === 'menu') return showTopupMenu(chatId);
    if (a === 'pick') return askTopupConfirm(chatId, Number(b));
    if (a === 'custom') {
      s.step = 'tucustom';
      return sendMessage(chatId, '✏️ Ketik jumlah coin yang mau dibeli (1–1000):');
    }
    if (a === 'paid') return submitTopup(chatId);
    if (a === 'cancel') {
      resetSession(chatId);
      return showBuyerMenu(chatId, user);
    }
    if (a === 'ok' || a === 'no') {
      if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Hanya admin yang bisa memutuskan top up.');
      const t = SHOP.topups.find((x) => x.id === b);
      if (!t) return sendMessage(chatId, 'Top up tidak ditemukan.');
      if (t.status !== 'pending') return sendMessage(chatId, `Top up ${t.id} sudah diputuskan (${t.status}).`);
      await decideTopup(query.from.id, b, a === 'ok');
      return sendMessage(chatId, `✅ Top up ${t.id} (${t.coins} coin) sudah ${a === 'ok' ? 'di-approve' : 'ditolak'}.`, adminMenuKb());
    }
    return;
  }
  if (kind === 'help') return showHelp(chatId);
  // ---- Admin
  if (kind === 'adm') {
    if (!isAdmin(query.from.id)) return sendMessage(chatId, '🚫 Menu ini hanya untuk admin toko.');
    if (a === 'menu') return showAdminMenu(chatId);
    if (a === 'users') return showBuyers(chatId);
    if (a === 'u') return showBuyerDetail(chatId, b);
    if (a === 'uo') return showUserOrdersAdmin(chatId, b);
    if (a === 'coin') {
      const uid = b;
      const d = Number(c);
      const u = SHOP.users[String(uid)];
      if (!u) return sendMessage(chatId, 'Pembeli tidak ditemukan.');
      if (u.coins + d < 0) return sendMessage(chatId, 'Saldo tidak bisa kurang dari 0.');
      u.coins += d;
      saveShop(SHOP);
      await sendMessage(chatId, `✅ Saldo ${esc(u.first_name || u.username || uid)} diubah ${d > 0 ? '+' : ''}${d} coin → sekarang <b>${u.coins} coin</b>.`);
      try {
        await sendMessage(uid, `🪙 Admin mengubah saldo coin kamu ${d > 0 ? '+' : ''}${d} coin. Saldo sekarang: <b>${u.coins} coin</b>.`);
      } catch { /* abaikan */ }
      return showBuyerDetail(chatId, uid);
    }
    if (a === 'ban') {
      const u = SHOP.users[String(b)];
      if (!u) return sendMessage(chatId, 'Pembeli tidak ditemukan.');
      u.banned = !u.banned;
      saveShop(SHOP);
      await sendMessage(chatId, u.banned ? `🚫 ${esc(u.first_name || u.username || b)} diblokir.` : `✅ Blokir ${esc(u.first_name || u.username || b)} dicabut.`);
      return showBuyerDetail(chatId, b);
    }
    if (a === 'tu') return showPendingTopups(chatId);
    if (a === 'price') {
      s.step = 'adm_price';
      return sendMessage(chatId, `💰 Harga coin saat ini: <b>${rupiah(coinPrice())}/coin</b>\n\nKetik harga baru per coin (angka rupiah, misal <code>500</code>):`);
    }
    if (a === 'payinfo') {
      s.step = 'adm_payinfo';
      return sendMessage(chatId, '💳 Ketik teks cara bayar top up yang akan dilihat pembeli (misal: "Transfer BCA 1234567890 a.n. Toko, lalu tekan Saya Sudah Bayar"). Kirim teks baru untuk mengganti:');
    }
    if (a === 'esim') return showEsimAdmin(chatId);
    if (a === 'e') return showEsimDetailAdmin(chatId, b);
    if (a === 'stats') return showStats(chatId);
    if (a === 'broadcast') {
      s.step = 'adm_broadcast';
      return sendMessage(chatId, '📣 Ketik pesan broadcast yang akan dikirim ke semua pembeli (yang tidak diblokir):');
    }
    if (a === 'bc') {
      if (b === 'no') {
        resetSession(chatId);
        return showAdminMenu(chatId);
      }
      const text = s.broadcastText || '';
      resetSession(chatId);
      if (!text) return showAdminMenu(chatId);
      await sendMessage(chatId, '📣 Broadcast mulai dikirim...');
      const targets = Object.values(SHOP.users).filter((u) => !u.banned);
      let ok = 0;
      for (const u of targets) {
        try { await sendMessage(u.id, text); ok++; } catch { /* abaikan */ }
        await sleep(100);
      }
      return sendMessage(chatId, `✅ Broadcast terkirim ke ${ok} dari ${targets.length} pembeli.`, adminMenuKb());
    }
    return;
  }
}

async function handleUpdate(u) {
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

// ------------------------------------------------------------ main loop
async function main() {
  if (!TOKEN) {
    console.error(
      '❌ TELEGRAM_BOT_TOKEN belum diisi.\n' +
        '   Buat bot di @BotFather, lalu jalankan:\n' +
        '   TELEGRAM_BOT_TOKEN=<token> TELEGRAM_ADMIN_IDS=<id kamu> node shop.js',
    );
    process.exitCode = 1;
    return;
  }
  if (!ADMIN_IDS.size) {
    console.error(
      '⚠️ TELEGRAM_ADMIN_IDS belum diisi — tidak ada yang bisa buka menu admin.\n' +
        '   Cari user ID kamu lewat @userinfobot, lalu jalankan dengan TELEGRAM_ADMIN_IDS=<id>.',
    );
  }
  const me = await tg('getMe', {});
  console.log(`🛍️ Bot toko jalan: @${me.username} (${me.first_name}) — long polling...`);
  console.log(`   Admin: ${[...ADMIN_IDS].join(', ') || '(belum diatur)'} | Harga coin: ${rupiah(coinPrice())}/coin`);
  startPoller();
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
      await handleUpdate(u);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

module.exports = { handleUpdate, handleMessage, handleCallback, getDb, reloadDb, pollOrdersOnce, coinPrice };
