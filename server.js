const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const cut = trimmed.indexOf('=');
    const key = trimmed.slice(0, cut).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(cut + 1).trim();
  }
}

const root = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 3010);
const host = process.env.HOST || '127.0.0.1';
const authSecret = process.env.AUTH_SECRET || '';
const psqlBin = process.env.PSQL_BIN || 'psql';

function publicFile(pathname) {
  if (pathname === '/' || pathname === '/index.html') return 'index.html';
  if (pathname === '/favicon.webp') return 'favicon.webp';
  if (pathname === '/logo.webp') return 'logo.webp';
  if (pathname === '/arorashop-ff-extension.zip') return 'arorashop-ff-extension.zip';
  return '';
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20000) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function dbError(err) {
  const detail = err && err.stderr ? String(err.stderr).trim() : '';
  return detail.split('\n').find((line) => line.trim()) || 'database command failed';
}

function maskEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.indexOf('@');
  if (at < 1) return '***';
  return value.slice(0, Math.min(2, at)) + '***' + value.slice(at);
}

function encryptSecret(plain) {
  const key = crypto.scryptSync(authSecret, 'ff-account-v1', 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['aes256gcm', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('$');
}

function money(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 100) / 100;
}

function saveAccount(body) {
  const label = String(body.label || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(body.password_or_pin || '');
  const pin = String(body.security_pin || '').trim();
  const balance = money(body.balance, 0);
  const low = money(body.low_balance_threshold, 200);
  if (!label || !email.includes('@') || !password || password.length > 200 || !/^\d{6}$/.test(pin)) {
    return { ok: false, error: 'Check email, password, and 6-digit PIN.' };
  }
  pg(`INSERT INTO unipin_loaded_accounts
      (label, email_encrypted, credentials_encrypted, masked_email, balance, low_balance_threshold, status, security_pin_encrypted, initial_balance)
      VALUES (
        ${sqlString(label)},
        ${sqlString(encryptSecret(email))},
        ${sqlString(encryptSecret(password))},
        ${sqlString(maskEmail(email))},
        ${balance},
        ${low},
        'active',
        ${sqlString(encryptSecret(pin))},
        ${balance}
      )`);
  return { ok: true };
}

function editAccount(id, body) {
  const existing = pgOne(`SELECT id FROM unipin_loaded_accounts WHERE id = ${id} LIMIT 1`);
  if (!existing) return { ok: false, error: 'Account not found' };
  const sets = [];
  if (body.label !== undefined) {
    const label = String(body.label || '').trim().slice(0, 80);
    if (!label) return { ok: false, error: 'Account name is required.' };
    sets.push(`label = ${sqlString(label)}`);
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (email) {
    if (!email.includes('@') || email.length > 200) return { ok: false, error: 'Check the email.' };
    sets.push(`email_encrypted = ${sqlString(encryptSecret(email))}`);
    sets.push(`masked_email = ${sqlString(maskEmail(email))}`);
  }
  const password = String(body.password_or_pin || '');
  if (password) {
    if (password.length > 200) return { ok: false, error: 'Password is too long.' };
    sets.push(`credentials_encrypted = ${sqlString(encryptSecret(password))}`);
  }
  const pin = String(body.security_pin || '').trim();
  if (pin) {
    if (!/^\d{6}$/.test(pin)) return { ok: false, error: 'PIN must be 6 digits.' };
    sets.push(`security_pin_encrypted = ${sqlString(encryptSecret(pin))}`);
  }
  const balance = money(body.balance, null);
  const low = money(body.low_balance_threshold, null);
  if (balance === null || low === null) return { ok: false, error: 'Balance is required.' };
  const status = body.status === 'paused' ? 'paused' : 'active';
  sets.push(`balance = ${balance}`, `low_balance_threshold = ${low}`, `status = ${sqlString(status)}`);
  const saved = pg(`UPDATE unipin_loaded_accounts
      SET ${sets.join(', ')}
      WHERE id = ${id}
      RETURNING id`);
  return saved === String(id) ? { ok: true } : { ok: false, error: 'Account not found' };
}

function pg(sql) {
  const out = execFileSync(psqlBin, [
    '-h', process.env.PGHOST || '127.0.0.1',
    '-p', process.env.PGPORT || '5432',
    '-U', process.env.PGUSER || 'ffapp',
    '-d', process.env.PGDATABASE || 'ff_uniqbd',
    '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-c', sql,
  ], {
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const lines = out.split(/\r?\n/).filter((line) => line.length);
  if (lines.length && /^(INSERT|UPDATE|DELETE)\s/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

function pgJson(sql) {
  const wrapped = "SELECT COALESCE(json_agg(t), '[]'::json) FROM (" + sql + ') t';
  const text = pg(wrapped);
  return JSON.parse(text || '[]');
}

function pgOne(sql) {
  return pgJson(sql)[0] || null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$16384$8$1$' + salt.toString('base64url') + '$' + hash.toString('base64url');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
  });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function changeAdminPassword(username, body) {
  const current = String(body.current_password || '').trim();
  const nextName = String(body.username || username).trim();
  const next = String(body.new_password || '').trim();
  const confirm = String(body.confirm_password || '').trim();
  const changingPass = next.length > 0 || confirm.length > 0;
  if (!current) return { status: 400, body: { ok: false, error: 'Enter the current password.' } };
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(nextName)) {
    return { status: 400, body: { ok: false, error: 'Admin ID must be 3 to 32 letters, numbers, dots, dashes, or underscores.' } };
  }
  if (changingPass) {
    if (next.length < 8 || next.length > 128) return { status: 400, body: { ok: false, error: 'New password must be 8 to 128 characters.' } };
    if (next !== confirm) return { status: 400, body: { ok: false, error: 'New passwords do not match.' } };
    if (next === current) return { status: 400, body: { ok: false, error: 'Choose a different password.' } };
  }
  if (nextName === username && !changingPass) {
    return { status: 400, body: { ok: false, error: 'Change the admin ID or the password.' } };
  }
  const row = pgOne(`SELECT username, password_hash FROM admins WHERE username = ${sqlString(username)} LIMIT 1`);
  if (!row || !verifyPassword(current, row.password_hash)) {
    return { status: 400, body: { ok: false, error: 'Current password is wrong.' } };
  }
  if (nextName !== username) {
    const taken = pgOne(`SELECT username FROM admins WHERE username = ${sqlString(nextName)} LIMIT 1`);
    if (taken) return { status: 400, body: { ok: false, error: 'That admin ID is already used.' } };
  }
  const sets = [];
  if (nextName !== username) sets.push(`username = ${sqlString(nextName)}`);
  if (changingPass) sets.push(`password_hash = ${sqlString(hashPassword(next))}`);
  pg(`UPDATE admins SET ${sets.join(', ')} WHERE username = ${sqlString(username)}`);
  const saved = pgOne(`SELECT username, password_hash FROM admins WHERE username = ${sqlString(nextName)} LIMIT 1`);
  const message = nextName !== username && changingPass
    ? 'Admin ID and password updated.'
    : nextName !== username
      ? 'Admin ID updated.'
      : 'Password updated.';
  return { status: 200, body: { ok: true, username: nextName, token: signToken(saved.username, saved.password_hash), message } };
}

const ADMIN_NAME = /^[A-Za-z0-9._-]{3,32}$/;
const ADMIN_LIMIT = 20;

function listAdmins(currentUsername) {
  const rows = pgJson('SELECT username, created_at FROM admins ORDER BY id');
  return {
    ok: true,
    admins: rows.map((row) => ({
      username: row.username,
      created_at: row.created_at || '',
      current: row.username === currentUsername,
    })),
  };
}

function addAdmin(actor, body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const confirm = String(body.confirm_password || '');
  if (!ADMIN_NAME.test(username)) {
    return { status: 400, body: { ok: false, error: 'Admin ID must be 3 to 32 letters, numbers, dots, dashes, or underscores.' } };
  }
  if (password.length < 8 || password.length > 128) {
    return { status: 400, body: { ok: false, error: 'Password must be 8 to 128 characters.' } };
  }
  if (password !== confirm) return { status: 400, body: { ok: false, error: 'Passwords do not match.' } };
  const count = pgOne('SELECT COUNT(*)::int AS n FROM admins') || {};
  if (num(count.n) >= ADMIN_LIMIT) return { status: 400, body: { ok: false, error: 'The admin list is full.' } };
  const taken = pgOne(`SELECT username FROM admins WHERE username = ${sqlString(username)} LIMIT 1`);
  if (taken) return { status: 400, body: { ok: false, error: 'That admin ID is already used.' } };
  pg(`INSERT INTO admins (username, password_hash) VALUES (${sqlString(username)}, ${sqlString(hashPassword(password))})`);
  return { status: 200, body: { ...listAdmins(actor), message: 'Admin added.' } };
}

function removeAdmin(actor, username) {
  const name = String(username || '').trim();
  if (!ADMIN_NAME.test(name)) return { status: 400, body: { ok: false, error: 'Admin not found.' } };
  if (name === actor) return { status: 400, body: { ok: false, error: 'You cannot remove the login you are using.' } };
  const count = pgOne('SELECT COUNT(*)::int AS n FROM admins') || {};
  if (num(count.n) <= 1) return { status: 400, body: { ok: false, error: 'Keep at least one admin.' } };
  const removed = pg(`DELETE FROM admins WHERE username = ${sqlString(name)} RETURNING username`);
  if (removed !== name) return { status: 404, body: { ok: false, error: 'Admin not found.' } };
  return { status: 200, body: { ...listAdmins(actor), message: 'Admin removed.' } };
}

function tokenStamp(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash || '')).digest('base64url').slice(0, 16);
}

const SESSION_MS = 5 * 365 * 24 * 60 * 60 * 1000;

function signToken(username, passwordHash) {
  const body = Buffer.from(JSON.stringify({
    u: username,
    s: tokenStamp(passwordHash),
    exp: Date.now() + SESSION_MS,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
  return body + '.' + sig;
}

const loginFails = new Map();

function loginBlocked(ip) {
  const row = loginFails.get(ip);
  if (!row) return false;
  if (row.until > Date.now()) return true;
  if (row.until) loginFails.delete(ip);
  return false;
}

function noteLoginFail(ip) {
  const row = loginFails.get(ip) || { n: 0, until: 0 };
  row.n += 1;
  if (row.n >= 8) {
    row.until = Date.now() + 15 * 60 * 1000;
    row.n = 0;
  }
  loginFails.set(ip, row);
}

function readToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const cut = token.indexOf('.');
  if (cut < 1 || !authSecret) return null;
  const body = token.slice(0, cut);
  const sig = token.slice(cut + 1);
  const expected = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.u || !payload.s || !payload.exp || payload.exp < Date.now()) return null;
    const row = pgOne(`SELECT username, password_hash FROM admins WHERE username = ${sqlString(payload.u)} LIMIT 1`);
    if (!row || payload.s !== tokenStamp(row.password_hash)) return null;
    return row.username;
  } catch {
    return null;
  }
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

const DEFAULT_ALLOWED_IPS = [
  '103.114.38.186',
  '103.114.38.210',
  '103.114.38.211',
  '103.114.38.212',
  '103.114.38.213',
  '103.114.38.214',
  '103.114.38.215',
  '103.114.38.216',
  '103.114.38.217',
  '103.114.38.218',
  '103.114.38.219',
  '103.114.38.220',
  '103.114.38.221',
  '103.114.38.222',
];

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

function validIpv4(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part);
}

function clientIp(req) {
  const peer = normalizeIp(req.socket && req.socket.remoteAddress);
  if (isLoopback(peer)) {
    const real = normalizeIp(req.headers['x-real-ip'] || '');
    if (validIpv4(real) || isLoopback(real)) return real.slice(0, 80);
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((item) => normalizeIp(item))
      .filter((item) => validIpv4(item) || isLoopback(item));
    if (forwarded.length) return forwarded[forwarded.length - 1].slice(0, 80);
  }
  return peer.slice(0, 80);
}

function ensureIpWhitelist() {
  pg(`CREATE TABLE IF NOT EXISTS ip_whitelist (
    id SERIAL PRIMARY KEY,
    ip TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  const count = pgOne('SELECT COUNT(*)::int AS n FROM ip_whitelist') || {};
  if (num(count.n) > 0) return;
  for (const ip of DEFAULT_ALLOWED_IPS) {
    pg(`INSERT INTO ip_whitelist (ip) VALUES (${sqlString(ip)}) ON CONFLICT (ip) DO NOTHING`);
  }
}

function ipAllowed(req) {
  const ip = clientIp(req);
  if (isLoopback(ip)) return true;
  try {
    return Boolean(pgOne(`SELECT id FROM ip_whitelist WHERE ip = ${sqlString(ip)} LIMIT 1`));
  } catch (err) {
    console.error('ip check:', dbError(err));
    return false;
  }
}

function listWhitelist(currentIp) {
  const ips = pgJson('SELECT id, ip FROM ip_whitelist ORDER BY id');
  return { ok: true, current_ip: currentIp, ips };
}

function addWhitelistIp(ip) {
  const clean = normalizeIp(ip);
  if (!validIpv4(clean) || isLoopback(clean)) return { ok: false, error: 'Enter a valid IP address.' };
  const count = pgOne('SELECT COUNT(*)::int AS n FROM ip_whitelist') || {};
  if (num(count.n) >= 100) return { ok: false, error: 'The whitelist is full.' };
  const existing = pgOne(`SELECT id FROM ip_whitelist WHERE ip = ${sqlString(clean)} LIMIT 1`);
  if (existing) return { ok: false, error: 'This IP is already on the list.' };
  pg(`INSERT INTO ip_whitelist (ip) VALUES (${sqlString(clean)})`);
  return { ok: true };
}

function removeWhitelistIp(id, currentIp) {
  const row = pgOne(`SELECT id, ip FROM ip_whitelist WHERE id = ${Number(id)} LIMIT 1`);
  if (!row) return { ok: false, error: 'IP not found.' };
  if (row.ip === currentIp) return { ok: false, error: 'You are using this IP. It stays on the list.' };
  const count = pgOne('SELECT COUNT(*)::int AS n FROM ip_whitelist') || {};
  if (num(count.n) <= 1) return { ok: false, error: 'Keep at least one IP on the list.' };
  pg(`DELETE FROM ip_whitelist WHERE id = ${Number(id)}`);
  return { ok: true };
}

function extensionMatches(req) {
  const given = String(req.headers['x-extension-key'] || '').trim();
  if (!given || given.length > 200) return false;
  const row = pgOne('SELECT extension_key FROM resellers ORDER BY id LIMIT 1');
  const saved = row && row.extension_key ? String(row.extension_key) : '';
  const left = Buffer.from(given);
  const right = Buffer.from(saved);
  if (!saved || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''));
  const right = Buffer.from(String(rightValue || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function decryptSecret(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'aes256gcm' || !authSecret) return null;
  try {
    const key = crypto.scryptSync(authSecret, 'ff-account-v1', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function maskCode(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (text.length <= 4) return '****';
  return text.slice(0, 4) + '*'.repeat(Math.max(4, text.length - 6)) + text.slice(-2);
}

function resellerRow() {
  return pgOne(`SELECT id, api_key, api_secret, is_active, webhook_url
    FROM resellers ORDER BY id LIMIT 1`);
}

function validChatId(value) {
  return /^-?\d{5,20}$/.test(String(value || '').trim());
}

function validBotToken(value) {
  return /^\d{6,15}:[A-Za-z0-9_-]{30,120}$/.test(String(value || '').trim());
}

async function sendTelegramMessage(token, chatId, text) {
  const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text).slice(0, 3500),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(8000),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok || !data.ok) {
    const desc = String((data && data.description) || 'Telegram did not accept the message.')
      .replace(/bot\d+:[A-Za-z0-9_-]+/gi, 'bot')
      .slice(0, 160);
    throw new Error(desc);
  }
}

const TELEGRAM_STATUSES = ['QUEUED_EXT', 'IN_PROGRESS_EXT', 'PROCESSING', 'COMPLETED', 'PAUSED', 'CANCELLED'];
const TELEGRAM_ALERT_DEFAULTS = {
  QUEUED_EXT: true,
  IN_PROGRESS_EXT: false,
  PROCESSING: false,
  COMPLETED: true,
  PAUSED: false,
  CANCELLED: false,
};
const TELEGRAM_STATUS_LABEL = {
  QUEUED_EXT: 'Queued',
  IN_PROGRESS_EXT: 'In progress',
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  PAUSED: 'Paused',
  CANCELLED: 'Cancelled',
};

function ensureDeskColumns() {
  const statements = [
    'ALTER TABLE resellers ADD COLUMN IF NOT EXISTS telegram_bot_token_encrypted TEXT',
    'ALTER TABLE resellers ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT',
    'ALTER TABLE resellers ADD COLUMN IF NOT EXISTS telegram_alerts TEXT',
    'ALTER TABLE resellers ADD COLUMN IF NOT EXISTS wallet_balance DOUBLE PRECISION DEFAULT 0',
    'ALTER TABLE resellers ADD COLUMN IF NOT EXISTS ext_last_seen_at BIGINT',
    'ALTER TABLE resellers ADD COLUMN IF NOT EXISTS ext_last_ip TEXT',
    'ALTER TABLE resellers ADD COLUMN IF NOT EXISTS allowed_ips TEXT',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS status_reason TEXT',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS receipt_note TEXT',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS method_used TEXT',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS webhook_status TEXT',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS arora_order_utr TEXT',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS shop_order_number TEXT',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER DEFAULT 0',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP',
    'ALTER TABLE fulfillment_orders ADD COLUMN IF NOT EXISTS retry_at TIMESTAMP',
    'ALTER TABLE unipin_vouchers ADD COLUMN IF NOT EXISTS token_hash TEXT',
    'ALTER TABLE unipin_loaded_accounts ADD COLUMN IF NOT EXISTS security_pin_encrypted TEXT',
    'ALTER TABLE unipin_loaded_accounts ADD COLUMN IF NOT EXISTS masked_email TEXT',
    'ALTER TABLE unipin_loaded_accounts ADD COLUMN IF NOT EXISTS low_balance_threshold DOUBLE PRECISION DEFAULT 0',
    'ALTER TABLE unipin_loaded_accounts ADD COLUMN IF NOT EXISTS label TEXT',
    `CREATE TABLE IF NOT EXISTS extension_status (
      key_id TEXT PRIMARY KEY,
      last_seen_at BIGINT,
      last_ip TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS reseller_prices (
      id SERIAL PRIMARY KEY,
      reseller_id INTEGER,
      package_code TEXT,
      price_bdt DOUBLE PRECISION,
      updated_at TIMESTAMP,
      is_active INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS dismissed_orders (
      reseller_id INTEGER NOT NULL,
      reseller_order_id TEXT NOT NULL,
      shop_order_number TEXT,
      dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (reseller_id, reseller_order_id)
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS admins_username_key ON admins (username)',
  ];
  try {
    ensureIpWhitelist();
  } catch (err) {
    console.error('ip whitelist:', dbError(err));
  }
  for (const sql of statements) {
    try {
      pg(sql);
    } catch (err) {
      console.error('schema update:', dbError(err));
    }
  }
}

function telegramAlertMap(raw) {
  let saved = {};
  if (raw && typeof raw === 'object') saved = raw;
  else {
    try { saved = JSON.parse(raw || '{}'); } catch { saved = {}; }
  }
  const out = {};
  for (const key of TELEGRAM_STATUSES) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) {
      out[key] = saved[key] === true || saved[key] === 'true' || saved[key] === 1 || saved[key] === '1';
    } else {
      out[key] = TELEGRAM_ALERT_DEFAULTS[key];
    }
  }
  return out;
}

function notifyTelegram(text) {
  let row;
  try {
    row = pgOne(`SELECT telegram_bot_token_encrypted, telegram_chat_id FROM resellers ORDER BY id LIMIT 1`);
  } catch {
    return;
  }
  if (!row || !row.telegram_chat_id || !row.telegram_bot_token_encrypted) return;
  const token = decryptSecret(row.telegram_bot_token_encrypted);
  if (!token) return;
  sendTelegramMessage(token, row.telegram_chat_id, text).catch((err) => {
    console.error('telegram notify failed:', String((err && err.message) || 'send failed').slice(0, 160));
  });
}

function notifyOrderStatus(order, status, note) {
  if (!order || !TELEGRAM_STATUSES.includes(status)) return;
  let raw = '';
  try {
    const row = pgOne('SELECT telegram_alerts FROM resellers ORDER BY id LIMIT 1');
    raw = row && row.telegram_alerts;
  } catch {
    return;
  }
  if (!telegramAlertMap(raw)[status]) return;
  const lines = [
    'FF.UniQbd · ' + TELEGRAM_STATUS_LABEL[status],
    order.shop_order_number || order.arora_order_utr || '',
    order.package_name || '',
    order.player_uid ? 'UID ' + order.player_uid : '',
  ];
  const extra = String(note || '').trim();
  if (extra && status !== 'COMPLETED' && status !== 'QUEUED_EXT') lines.push(extra.slice(0, 180));
  notifyTelegram(lines.filter(Boolean).join('\n'));
}

function saveTelegram(body) {
  const row = pgOne(`SELECT id, telegram_bot_token_encrypted FROM resellers ORDER BY id LIMIT 1`);
  if (!row) return { status: 400, body: { ok: false, error: 'No shop connection is set up.' } };
  if (body.disconnect) {
    pg(`UPDATE resellers SET telegram_bot_token_encrypted = NULL, telegram_chat_id = NULL WHERE id = ${Number(row.id)}`);
    return { status: 200, body: { ok: true, message: 'Telegram disconnected.' } };
  }
  if (body.alerts_only) {
    if (!body.alerts || typeof body.alerts !== 'object') {
      return { status: 400, body: { ok: false, error: 'Choose which order statuses should send a message.' } };
    }
    const alerts = telegramAlertMap(body.alerts);
    pg(`UPDATE resellers SET telegram_alerts = ${sqlString(JSON.stringify(alerts))} WHERE id = ${Number(row.id)}`);
    return { status: 200, body: { ok: true, message: 'Telegram alerts updated.', alerts } };
  }
  const chatId = String(body.chat_id || '').trim();
  const token = String(body.bot_token || '').trim();
  if (!validChatId(chatId)) {
    return { status: 400, body: { ok: false, error: 'Chat ID should be the number from Telegram.' } };
  }
  const saved = String(row.telegram_bot_token_encrypted || '').startsWith('aes256gcm$');
  if (!token && !saved) return { status: 400, body: { ok: false, error: 'Bot token is required.' } };
  if (token && !validBotToken(token)) return { status: 400, body: { ok: false, error: 'That bot token does not look right.' } };
  const sets = [`telegram_chat_id = ${sqlString(chatId)}`];
  if (token) sets.push(`telegram_bot_token_encrypted = ${sqlString(encryptSecret(token))}`);
  if (body.alerts && typeof body.alerts === 'object') {
    sets.push(`telegram_alerts = ${sqlString(JSON.stringify(telegramAlertMap(body.alerts)))}`);
  }
  pg(`UPDATE resellers SET ${sets.join(', ')} WHERE id = ${Number(row.id)}`);
  return { status: 200, body: { ok: true, message: 'Telegram bot saved.' } };
}

async function testTelegram() {
  const row = pgOne(`SELECT telegram_bot_token_encrypted, telegram_chat_id FROM resellers ORDER BY id LIMIT 1`);
  if (!row || !row.telegram_chat_id || !row.telegram_bot_token_encrypted) {
    return { status: 400, body: { ok: false, error: 'Save the bot token and chat ID first.' } };
  }
  const token = decryptSecret(row.telegram_bot_token_encrypted);
  if (!token) return { status: 400, body: { ok: false, error: 'Saved bot token could not be read. Paste it again.' } };
  try {
    await sendTelegramMessage(token, row.telegram_chat_id, 'FF.UniQbd test alert. Telegram is connected.');
    return { status: 200, body: { ok: true, message: 'Test alert sent.' } };
  } catch (err) {
    return { status: 400, body: { ok: false, error: String((err && err.message) || 'Telegram test failed.') } };
  }
}

function resellerAuth(req) {
  const row = resellerRow();
  if (!row || !Number(row.is_active)) return null;
  if (!safeEqual(req.headers['x-api-key'], row.api_key) || !safeEqual(req.headers['x-api-secret'], row.api_secret)) {
    return null;
  }
  return row;
}

function matchPackage(input) {
  const packages = pgJson('SELECT package_code, name, diamonds, is_active, unipin_uc_cost FROM ff_packages ORDER BY id');
  const code = String(input.package_code || '').trim().toUpperCase();
  const label = String(input.package_name || input.name || '').trim().toLowerCase();
  let found = code ? packages.find((row) => String(row.package_code).toUpperCase() === code) : null;
  if (!found && /weekly/.test(label)) found = packages.find((row) => row.package_code === 'FF_WEEKLY');
  if (!found && /monthly/.test(label)) found = packages.find((row) => row.package_code === 'FF_MONTHLY');
  if (!found) {
    const named = label.match(/(\d+)/);
    const diamonds = Number(input.diamonds || (named ? named[1] : 0));
    if (diamonds) {
      found = packages.find((row) => Number(row.diamonds) === diamonds && row.package_code !== 'FF_WEEKLY' && row.package_code !== 'FF_MONTHLY');
    }
  }
  if (!found || !Number(found.is_active)) return null;
  return found;
}

function shortOrderUtr(resellerOrderId) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digest = crypto.createHash('sha256').update('ff-utr-v1:' + String(resellerOrderId)).digest();
  let code = 'UQ-';
  for (let i = 0; i < 8; i += 1) code += alphabet[digest[i] % alphabet.length];
  const taken = pgOne(`SELECT reseller_order_id FROM fulfillment_orders WHERE arora_order_utr = ${sqlString(code)} LIMIT 1`);
  if (!taken || String(taken.reseller_order_id || '') === String(resellerOrderId)) return code;
  for (let n = 0; n < 8; n += 1) {
    const alt = code + alphabet[digest[8 + n] % alphabet.length];
    const row = pgOne(`SELECT id FROM fulfillment_orders WHERE arora_order_utr = ${sqlString(alt)} LIMIT 1`);
    if (!row) return alt;
  }
  return code + alphabet[crypto.randomBytes(1)[0] % alphabet.length];
}

function assignVisibleCode(shopOrderNumber, resellerOrderId) {
  const shop = String(shopOrderNumber || '').trim();
  if (!shop) return shortOrderUtr(resellerOrderId);
  const candidates = [shop];
  for (let n = 2; n <= 20; n += 1) candidates.push(shop + '-' + n);
  for (const code of candidates) {
    const taken = pgOne(`SELECT reseller_order_id FROM fulfillment_orders WHERE arora_order_utr = ${sqlString(code)} LIMIT 1`);
    if (!taken || String(taken.reseller_order_id || '') === String(resellerOrderId || '')) return code;
  }
  return shortOrderUtr(resellerOrderId);
}

function applyShopOrderCode(row, shopOrderNumber, resellerOrderId) {
  const shop = String(shopOrderNumber || (row && row.shop_order_number) || '').trim();
  const current = String((row && row.arora_order_utr) || '');
  const owner = String(resellerOrderId || (row && row.reseller_order_id) || '');
  if (!row || !row.id || !shop || !current.startsWith('UQ-') || row.status === 'IN_PROGRESS_EXT') return current;
  const next = assignVisibleCode(shop, owner);
  if (!next || next === current) return current;
  pg(`UPDATE unipin_vouchers SET used_order_utr = ${sqlString(next)} WHERE used_order_utr = ${sqlString(current)}`);
  pg(`UPDATE fulfillment_orders SET arora_order_utr = ${sqlString(next)} WHERE id = ${Number(row.id)} AND arora_order_utr = ${sqlString(current)}`);
  row.arora_order_utr = next;
  return next;
}

function showShopOrderNumbers() {
  let rows = [];
  try {
    rows = pgJson(`SELECT id, arora_order_utr, shop_order_number, reseller_order_id, status
      FROM fulfillment_orders
      WHERE COALESCE(shop_order_number, '') <> ''
        AND arora_order_utr LIKE 'UQ-%'
        AND status IS DISTINCT FROM 'IN_PROGRESS_EXT'
      ORDER BY id`);
  } catch (err) {
    console.error('shop order code:', dbError(err));
    return;
  }
  rows.forEach((row) => {
    try {
      applyShopOrderCode(row, row.shop_order_number, row.reseller_order_id);
    } catch (err) {
      console.error('shop order code:', dbError(err));
    }
  });
}

function shortenStoredOrderIds() {
  const rows = pgJson(`SELECT id, arora_order_utr, reseller_order_id FROM fulfillment_orders WHERE char_length(arora_order_utr) > 16`);
  for (const row of rows) {
    const next = shortOrderUtr(row.reseller_order_id || row.arora_order_utr);
    if (!next || next === row.arora_order_utr) continue;
    pg(`UPDATE unipin_vouchers SET used_order_utr = ${sqlString(next)} WHERE used_order_utr = ${sqlString(row.arora_order_utr)}`);
    pg(`UPDATE fulfillment_orders SET arora_order_utr = ${sqlString(next)} WHERE id = ${Number(row.id)} AND arora_order_utr = ${sqlString(row.arora_order_utr)}`);
  }
}

function rememberDismissedOrders(whereSql) {
  try {
    pg(`INSERT INTO dismissed_orders (reseller_id, reseller_order_id, shop_order_number)
      SELECT reseller_id, reseller_order_id, COALESCE(shop_order_number, '')
      FROM fulfillment_orders
      WHERE ${whereSql}
        AND reseller_id IS NOT NULL
        AND COALESCE(reseller_order_id, '') <> ''
      ON CONFLICT (reseller_id, reseller_order_id) DO NOTHING`);
  } catch (err) {
    console.error('dismiss order:', dbError(err));
  }
}

function orderWasDismissed(resellerId, resellerOrderId) {
  try {
    return Boolean(pgOne(`SELECT reseller_order_id FROM dismissed_orders
      WHERE reseller_id = ${Number(resellerId)} AND reseller_order_id = ${sqlString(resellerOrderId)}
      LIMIT 1`));
  } catch (err) {
    console.error('dismissed lookup:', dbError(err));
    return false;
  }
}

function readShopOrderNumber(body) {
  const raw = [body.order_number, body.orderNumber, body.shop_order_number, body.uniqbd_order_number]
    .map((value) => String(value || '').trim().replace(/^#/, ''))
    .find((value) => value) || '';
  if (/^\d{1,12}$/.test(raw)) return raw;
  const digits = raw.match(/\b(\d{3,8})\b/);
  if (digits) return digits[1];
  return /^[A-Za-z0-9-]{1,32}$/.test(raw) ? raw : '';
}

const SHOP_STOP_REASON = 'Stopped because this order is not paid on uniqbd.com.';

function stopResellerOrder(reseller, body) {
  const orderId = String(body.order_id || '').trim().slice(0, 80);
  if (!orderId) return { status: 400, body: { ok: false, error: 'order_id is required' } };
  let rows = [];
  try {
    rows = pgJson(`SELECT id, arora_order_utr, shop_order_number, player_uid, package_name, status
      FROM fulfillment_orders
      WHERE reseller_id = ${Number(reseller.id)} AND reseller_order_id = ${sqlString(orderId)}`);
  } catch (err) {
    console.error('stop order:', dbError(err));
    return { status: 500, body: { ok: false } };
  }
  rows.forEach((row) => {
    if (row.status === 'COMPLETED' || row.status === 'CANCELLED') return;
    try {
      pg(`UPDATE unipin_vouchers SET status = 'available', used_order_utr = NULL, used_at = NULL
        WHERE used_order_utr = ${sqlString(row.arora_order_utr)}`);
    } catch (err) {
      console.error('stop order voucher:', dbError(err));
    }
    pg(`UPDATE fulfillment_orders
      SET status = 'CANCELLED', status_reason = ${sqlString(SHOP_STOP_REASON)},
          method_used = 'none', voucher_ids = NULL, account_id = NULL
      WHERE id = ${Number(row.id)} AND status <> 'COMPLETED' AND status <> 'CANCELLED'`);
    notifyOrderStatus(row, 'CANCELLED', SHOP_STOP_REASON);
  });
  return { status: 200, body: { ok: true } };
}

function placeResellerOrder(reseller, body, ip) {
  const orderId = String(body.order_id || '').trim().slice(0, 80);
  const shopOrderNumber = readShopOrderNumber(body);
  const playerUid = String(body.player_uid || '').trim();
  const quantity = Math.min(20, Math.max(1, Math.round(Number(body.quantity) || 1)));
  if (!orderId || !/^\d{5,20}$/.test(playerUid)) {
    return { status: 400, body: { ok: false, error: 'order_id and a numeric player UID are required' } };
  }
  const pack = matchPackage(body);
  if (!pack) return { status: 400, body: { ok: false, error: 'Unknown Free Fire package' } };
  const priceRow = pgOne(`SELECT price_bdt FROM reseller_prices
    WHERE reseller_id = ${Number(reseller.id)} AND package_code = ${sqlString(pack.package_code)} LIMIT 1`);
  const unitPrice = num(priceRow && priceRow.price_bdt);
  const created = [];
  for (let index = 1; index <= quantity; index += 1) {
    const resellerOrderId = quantity === 1 ? orderId : orderId + '#' + index;
    let existing = null;
    try {
      existing = pgOne(`SELECT id, arora_order_utr, shop_order_number, reseller_order_id, status, status_reason, package_code, package_name
        FROM fulfillment_orders
        WHERE reseller_id = ${Number(reseller.id)} AND reseller_order_id = ${sqlString(resellerOrderId)}
        LIMIT 1`);
    } catch (err) {
      console.error('reseller order lookup:', dbError(err));
      existing = pgOne(`SELECT id, arora_order_utr, reseller_order_id, status, package_code, package_name
        FROM fulfillment_orders
        WHERE reseller_id = ${Number(reseller.id)} AND reseller_order_id = ${sqlString(resellerOrderId)}
        LIMIT 1`);
    }
    if (existing) {
      if (existing.status === 'CANCELLED' && existing.status_reason === SHOP_STOP_REASON) {
        pg(`UPDATE fulfillment_orders
          SET status = 'QUEUED_EXT', method_used = 'none', account_id = NULL, voucher_ids = NULL,
              status_reason = '', receipt_note = '', delivery_attempts = 0
          WHERE id = ${Number(existing.id)} AND status = 'CANCELLED'`);
        existing.status = 'QUEUED_EXT';
        notifyOrderStatus(existing, 'QUEUED_EXT', '');
      }
      if (shopOrderNumber && !String(existing.shop_order_number || '').trim()) {
        try {
          pg(`UPDATE fulfillment_orders SET shop_order_number = ${sqlString(shopOrderNumber)} WHERE id = ${Number(existing.id)}`);
          existing.shop_order_number = shopOrderNumber;
        } catch (err) {
          console.error('reseller order number:', dbError(err));
        }
      }
      try {
        applyShopOrderCode(existing, shopOrderNumber, resellerOrderId);
      } catch (err) {
        console.error('shop order code:', dbError(err));
      }
      created.push(existing);
      continue;
    }
    if (orderWasDismissed(reseller.id, resellerOrderId)) {
      created.push({
        arora_order_utr: '',
        shop_order_number: shopOrderNumber,
        status: 'CANCELLED',
        package_code: pack.package_code,
        package_name: pack.name,
        dismissed: true,
      });
      continue;
    }
    const utr = assignVisibleCode(shopOrderNumber, resellerOrderId);
    const tail = `${sqlString(playerUid)}, ${sqlString(pack.package_code)}, ${sqlString(pack.name)},
        1, 'none', 'QUEUED_EXT', ${Number(reseller.id)}, ${sqlString(resellerOrderId)}, ${unitPrice}, ${sqlString(ip)}`;
    try {
      pg(`INSERT INTO fulfillment_orders
        (arora_order_utr, shop_order_number, player_uid, package_code, package_name, quantity, method_used, status, reseller_id, reseller_order_id, order_price_bdt, ip_address)
        VALUES (${sqlString(utr)}, ${sqlString(shopOrderNumber)}, ${tail})`);
    } catch (err) {
      console.error('reseller order insert:', dbError(err));
      pg(`INSERT INTO fulfillment_orders
        (arora_order_utr, player_uid, package_code, package_name, quantity, method_used, status, reseller_id, reseller_order_id, order_price_bdt, ip_address)
        VALUES (${sqlString(utr)}, ${tail})`);
    }
    created.push({ arora_order_utr: utr, shop_order_number: shopOrderNumber, status: 'QUEUED_EXT', package_code: pack.package_code, package_name: pack.name });
    notifyOrderStatus({ arora_order_utr: utr, shop_order_number: shopOrderNumber, package_name: pack.name, player_uid: playerUid }, 'QUEUED_EXT', '');
  }
  const first = created[0];
  return {
    status: 200,
    body: {
      ok: true,
      order_id: orderId,
      order_utr: first.arora_order_utr,
      player_uid: playerUid,
      package_code: pack.package_code,
      package_name: pack.name,
      diamonds: Number(pack.diamonds),
      quantity,
      order_price_bdt: Math.round(unitPrice * quantity * 100) / 100,
      status: first.status,
      message: created.every((row) => row.dismissed)
        ? 'This order was cleared and will not be queued again.'
        : 'Order queued for the matching Free Fire package.',
    },
  };
}

function splitVoucher(plain) {
  const parts = String(plain || '').trim().split(/[\s|,]+/).filter(Boolean);
  if (parts.length >= 2) return { serial: parts[0], pin: parts.slice(1).join('') };
  return { serial: parts[0] || '', pin: '' };
}

function voucherChannel(serial) {
  const prefix = String(serial || '').toUpperCase().startsWith('UPBD') ? 'UPBD' : 'BDMB';
  return {
    prefix,
    channel_name: prefix === 'UPBD' ? 'UP Gift Card' : 'UniPin Voucher',
  };
}

const DELIVERY_TRY_LIMIT = 2;
const DELIVERY_STOP_REASON = 'Delivery failed after 2 tries. The extension will not try this order again.';

function cipherIsCurrent(column) {
  return `substring(${column} from 1 for 10) = 'aes256gcm$'`;
}

function markOrderInProgress(orderId, sets) {
  const moving = `status = 'IN_PROGRESS_EXT', claimed_at = CURRENT_TIMESTAMP, ${sets}`;
  try {
    pg(`UPDATE fulfillment_orders SET ${moving}, delivery_attempts = COALESCE(delivery_attempts, 0) + 1 WHERE id = ${Number(orderId)}`);
  } catch (err) {
    console.error('claim progress:', dbError(err));
    try {
      pg(`UPDATE fulfillment_orders SET ${moving} WHERE id = ${Number(orderId)}`);
    } catch (err2) {
      console.error('claim progress:', dbError(err2));
      pg(`UPDATE fulfillment_orders SET status = 'IN_PROGRESS_EXT', ${sets} WHERE id = ${Number(orderId)}`);
    }
  }
}

function stopOverTriedOrders() {
  let rows = [];
  try {
    rows = pgJson(`SELECT id, arora_order_utr, shop_order_number, player_uid, package_name, status
      FROM fulfillment_orders
      WHERE status = 'QUEUED_EXT' AND COALESCE(delivery_attempts, 0) >= ${DELIVERY_TRY_LIMIT}`);
  } catch (err) {
    console.error('stop over-tried:', dbError(err));
    return;
  }
  rows.forEach((row) => {
    pg(`UPDATE fulfillment_orders
      SET status = 'CANCELLED', status_reason = ${sqlString(DELIVERY_STOP_REASON)}, method_used = 'none', voucher_ids = NULL, account_id = NULL
      WHERE id = ${Number(row.id)} AND status = 'QUEUED_EXT'`);
    notifyOrderStatus(row, 'CANCELLED', DELIVERY_STOP_REASON);
  });
}

function claimNextTask() {
  cancelStuckProcessingOrders();
  stopOverTriedOrders();
  let orders = [];
  try {
    orders = pgJson(`SELECT id, arora_order_utr, shop_order_number, player_uid, package_code, package_name, account_id
      FROM fulfillment_orders
      WHERE status = 'QUEUED_EXT' AND COALESCE(delivery_attempts, 0) < ${DELIVERY_TRY_LIMIT}
      ORDER BY retry_at DESC NULLS LAST, id
      LIMIT 20`);
  } catch (err) {
    console.error('claim order:', dbError(err));
    try {
      orders = pgJson(`SELECT id, arora_order_utr, player_uid, package_code, package_name, account_id
        FROM fulfillment_orders
        WHERE status = 'QUEUED_EXT'
        ORDER BY id
        LIMIT 20`);
    } catch (err2) {
      console.error('claim order:', dbError(err2));
      return null;
    }
  }
  for (const order of orders) {
    const task = claimQueuedOrder(order);
    if (task) return task;
  }
  return null;
}

function claimQueuedOrder(order) {
  let voucher = null;
  try {
    voucher = pgOne(`SELECT id, code_encrypted FROM unipin_vouchers
      WHERE package_code = ${sqlString(order.package_code)} AND lower(status) = 'available' AND ${cipherIsCurrent('code_encrypted')}
      ORDER BY id LIMIT 1`);
  } catch (err) {
    console.error('claim token:', dbError(err));
  }
  if (voucher) {
    const plain = decryptSecret(voucher.code_encrypted);
    const parts = splitVoucher(plain);
    if (plain && parts.serial && parts.pin) {
      pg(`UPDATE unipin_vouchers SET status = 'used', used_order_utr = ${sqlString(order.arora_order_utr)}, used_at = CURRENT_TIMESTAMP WHERE id = ${Number(voucher.id)}`);
      markOrderInProgress(order.id, `method_used = 'unipin_voucher', voucher_ids = ${sqlString(String(voucher.id))}`);
      notifyOrderStatus(order, 'IN_PROGRESS_EXT', '');
      const channel = voucherChannel(parts.serial);
      return {
        order_utr: order.arora_order_utr,
        shop_order_number: order.shop_order_number || '',
        player_uid: order.player_uid,
        package_name: order.package_name,
        denom_label: order.package_name,
        mode: 'unipin_voucher',
        voucher: {
          serial: parts.serial,
          pin: parts.pin,
          pin_formatted: parts.pin,
          prefix: channel.prefix,
          channel_name: channel.channel_name,
        },
      };
    }
  }
  let pack = {};
  let account = null;
  try {
    pack = pgOne(`SELECT unipin_uc_cost FROM ff_packages WHERE package_code = ${sqlString(order.package_code)} LIMIT 1`) || {};
    account = pgOne(`SELECT id, label, email_encrypted, credentials_encrypted, security_pin_encrypted, balance
      FROM unipin_loaded_accounts
      WHERE lower(status) = 'active' AND balance >= ${num(pack.unipin_uc_cost)} AND ${cipherIsCurrent('credentials_encrypted')}
      ORDER BY id LIMIT 1`);
  } catch (err) {
    console.error('claim account:', dbError(err));
    return null;
  }
  if (!account) return null;
  const email = decryptSecret(account.email_encrypted);
  const password = decryptSecret(account.credentials_encrypted);
  const pin = decryptSecret(account.security_pin_encrypted);
  if (!email || !password || !pin) return null;
  markOrderInProgress(order.id, `method_used = 'loaded_account', account_id = ${Number(account.id)}`);
  notifyOrderStatus(order, 'IN_PROGRESS_EXT', '');
  return {
    order_utr: order.arora_order_utr,
    shop_order_number: order.shop_order_number || '',
    player_uid: order.player_uid,
    package_name: order.package_name,
    denom_label: order.package_name,
    mode: 'loaded_account',
    account: { label: account.label, email, password, security_pin: pin },
  };
}

function packageReady(packageCode) {
  const code = sqlString(packageCode || '');
  try {
    const voucher = pgOne(`SELECT id FROM unipin_vouchers
      WHERE package_code = ${code} AND lower(status) = 'available' AND ${cipherIsCurrent('code_encrypted')}
      LIMIT 1`);
    if (voucher) return true;
  } catch (err) {
    console.error('retry token:', dbError(err));
  }
  try {
    const pack = pgOne(`SELECT unipin_uc_cost FROM ff_packages WHERE package_code = ${code} LIMIT 1`) || {};
    const account = pgOne(`SELECT id FROM unipin_loaded_accounts
      WHERE lower(status) = 'active' AND balance >= ${num(pack.unipin_uc_cost)} AND ${cipherIsCurrent('credentials_encrypted')}
      LIMIT 1`);
    return Boolean(account);
  } catch (err) {
    console.error('retry account:', dbError(err));
    return false;
  }
}

function requeueOrder(id) {
  let row = null;
  try {
    row = pgOne(`SELECT id, arora_order_utr, shop_order_number, player_uid, package_code, package_name, status FROM fulfillment_orders WHERE id = ${id} LIMIT 1`);
  } catch (err) {
    console.error('retry lookup:', dbError(err));
    row = pgOne(`SELECT id, arora_order_utr, player_uid, package_code, package_name, status FROM fulfillment_orders WHERE id = ${id} LIMIT 1`);
  }
  if (!row) return { status: 404, body: { ok: false, error: 'Order not found' } };
  if (row.status === 'COMPLETED') return { status: 400, body: { ok: false, error: 'Completed orders stay completed' } };
  try {
    pg(`UPDATE unipin_vouchers SET status = 'available', used_order_utr = NULL, used_at = NULL
      WHERE used_order_utr = ${sqlString(row.arora_order_utr)}`);
  } catch (err) {
    console.error('retry token:', dbError(err));
  }
  const ready = packageReady(row.package_code);
  const reason = ready ? '' : 'No token or account is ready for this package.';
  const queued = `status = 'QUEUED_EXT', method_used = 'retry', account_id = NULL, voucher_ids = NULL,
        status_reason = ${sqlString(reason)}, receipt_note = ''`;
  try {
    pg(`UPDATE fulfillment_orders
      SET ${queued}, delivery_attempts = 0, claimed_at = NULL, retry_at = CURRENT_TIMESTAMP
      WHERE id = ${id}`);
  } catch (err) {
    console.error('retry queue:', dbError(err));
    try {
      pg(`UPDATE fulfillment_orders SET ${queued} WHERE id = ${id}`);
    } catch (err2) {
      console.error('retry queue:', dbError(err2));
      return { status: 500, body: { ok: false, error: 'Could not queue this order.' } };
    }
  }
  if (row.status !== 'QUEUED_EXT') notifyOrderStatus(row, 'QUEUED_EXT', reason);
  const ext = pgOne('SELECT last_seen_at FROM extension_status LIMIT 1') || {};
  let message = 'Order sent to the extension.';
  if (!ready) message = 'No token or account is ready for this package.';
  else if (!seenOnline(ext.last_seen_at)) message = 'Order queued. The extension is offline.';
  return { status: 200, body: { ok: true, message } };
}

function orderActionResult(id, action, body) {
  if (action === 'retry') return requeueOrder(id);
  if (action === 'toggle-pause') {
    const row = pgOne(`SELECT id, arora_order_utr, shop_order_number, player_uid, package_name, status FROM fulfillment_orders WHERE id = ${id} LIMIT 1`);
    if (!row) return { status: 404, body: { ok: false, error: 'Order not found' } };
    const next = row.status === 'PAUSED' ? 'QUEUED_EXT' : 'PAUSED';
    pg(`UPDATE fulfillment_orders SET status = ${sqlString(next)} WHERE id = ${id}`);
    if (row.status !== next) notifyOrderStatus(row, next, '');
    return { status: 200, body: { ok: true, message: next === 'PAUSED' ? 'Order paused.' : 'Order queued for the extension.' } };
  }
  if (action === 'delete') {
    const row = pgOne(`SELECT arora_order_utr FROM fulfillment_orders WHERE id = ${id} LIMIT 1`);
    if (!row) return { status: 404, body: { ok: false, error: 'Order not found' } };
    pg(`UPDATE unipin_vouchers SET status = 'available', used_order_utr = NULL, used_at = NULL
      WHERE used_order_utr = ${sqlString(row.arora_order_utr)}`);
    rememberDismissedOrders(`id = ${id}`);
    pg(`DELETE FROM fulfillment_orders WHERE id = ${id}`);
    return { status: 200, body: { ok: true } };
  }
  const row = pgOne(`SELECT arora_order_utr FROM fulfillment_orders WHERE id = ${id} LIMIT 1`);
  if (!row) return { status: 404, body: { ok: false, error: 'Order not found' } };
  finishExtensionOrder({
    order_utr: row.arora_order_utr,
    status: 'COMPLETED',
    receipt_note: String(body.receipt_note || 'Delivered manually').slice(0, 500),
  });
  return { status: 200, body: { ok: true } };
}

function loginFailureText(text) {
  return /could not log in|login failed|invalid player|player id not found|player not found|wrong player|wrong free fire/i.test(String(text || ''));
}

function cancelUndeliveredOrder(order, reason, receipt, nextStatus) {
  const loginFailed = nextStatus === 'LOGIN_FAILED' || loginFailureText(reason);
  const next = loginFailed ? 'LOGIN_FAILED' : 'CANCELLED';
  const why = String(reason || (loginFailed
    ? 'Login Failed. The extension could not log in to this Free Fire ID.'
    : 'The extension could not deliver the diamonds. This order is cancelled.')).slice(0, 500);
  const note = String(receipt || '').slice(0, 500);
  const utr = sqlString(order.arora_order_utr);
  try {
    pg(`UPDATE fulfillment_orders
      SET status = ${sqlString(next)}, status_reason = ${sqlString(why)}, receipt_note = ${sqlString(note)},
          voucher_ids = NULL, method_used = 'none', account_id = NULL
      WHERE arora_order_utr = ${utr} AND status <> 'COMPLETED'`);
  } catch (err) {
    console.error('cancel order:', dbError(err));
    pg(`UPDATE fulfillment_orders
      SET status = ${sqlString(next)}, status_reason = ${sqlString(why)}
      WHERE arora_order_utr = ${utr} AND status <> 'COMPLETED'`);
  }
  try {
    pg(`UPDATE unipin_vouchers SET status = 'available', used_order_utr = NULL, used_at = NULL
      WHERE used_order_utr = ${utr}`);
  } catch (err) {
    console.error('return token:', dbError(err));
  }
  if (order.status !== next) notifyOrderStatus(order, 'CANCELLED', why);
}

function cancelStuckProcessingOrders() {
  let rows = [];
  try {
    rows = pgJson(`SELECT status, arora_order_utr, shop_order_number, player_uid, package_name, status_reason, receipt_note
      FROM fulfillment_orders
      WHERE status = 'PROCESSING'
         OR (status = 'IN_PROGRESS_EXT' AND (claimed_at IS NULL OR claimed_at < CURRENT_TIMESTAMP - INTERVAL '4 minutes'))`);
  } catch (err) {
    console.error('cancel stuck orders:', dbError(err));
    try {
      rows = pgJson(`SELECT status, arora_order_utr, shop_order_number, player_uid, package_name, status_reason, receipt_note
        FROM fulfillment_orders WHERE status = 'PROCESSING'`);
    } catch (err2) {
      console.error('cancel stuck orders:', dbError(err2));
    }
  }
  rows.forEach((row) => {
    try {
      cancelUndeliveredOrder(row, row.status_reason, row.receipt_note);
    } catch (err) {
      console.error('cancel stuck orders:', dbError(err));
    }
  });
  restoreUnusedTokens();
}

function restoreUnusedTokens() {
  const release = `UPDATE unipin_vouchers SET status = 'available', used_order_utr = NULL, used_at = NULL
    WHERE lower(status) <> 'available'
      AND COALESCE(used_order_utr, '') <> ''
      AND used_order_utr NOT IN (
        SELECT arora_order_utr FROM fulfillment_orders
        WHERE status = 'COMPLETED' AND arora_order_utr IS NOT NULL
      )`;
  const keepFresh = ` AND used_order_utr NOT IN (
        SELECT arora_order_utr FROM fulfillment_orders
        WHERE status = 'IN_PROGRESS_EXT' AND claimed_at IS NOT NULL
          AND claimed_at >= CURRENT_TIMESTAMP - INTERVAL '4 minutes'
          AND arora_order_utr IS NOT NULL
      )`;
  try {
    pg(release + keepFresh);
  } catch (err) {
    console.error('restore tokens:', dbError(err));
    try {
      pg(release);
    } catch (err2) {
      console.error('restore tokens:', dbError(err2));
    }
  }
}

function finishExtensionOrder(body) {
  const utr = String(body.order_utr || '').trim().slice(0, 80);
  const allowed = ['COMPLETED', 'PROCESSING', 'PAUSED', 'CANCELLED', 'LOGIN_FAILED', 'QUEUED_EXT', 'IN_PROGRESS_EXT'];
  const status = allowed.includes(body.status) ? body.status : 'CANCELLED';
  const reason = String(body.error_message || body.receipt_note || '').slice(0, 500);
  const receipt = String(body.receipt_note || '').slice(0, 500);
  if (!utr) return;
  let order = null;
  try {
    order = pgOne(`SELECT status, arora_order_utr, shop_order_number, player_uid, package_code, package_name, quantity, reseller_order_id, account_id, order_price_bdt
      FROM fulfillment_orders WHERE arora_order_utr = ${sqlString(utr)} LIMIT 1`);
  } catch (err) {
    console.error('order result lookup:', dbError(err));
    order = pgOne(`SELECT status, arora_order_utr, player_uid, package_code, package_name, quantity, reseller_order_id, account_id
      FROM fulfillment_orders WHERE arora_order_utr = ${sqlString(utr)} LIMIT 1`);
  }
  if (!order || order.status === 'COMPLETED') return;
  if (order.status !== 'IN_PROGRESS_EXT' && order.status !== 'PROCESSING') return;
  if (status !== 'COMPLETED') {
    const loginFailed = status === 'LOGIN_FAILED' || loginFailureText(reason);
    cancelUndeliveredOrder(order, reason, receipt, loginFailed ? 'LOGIN_FAILED' : 'CANCELLED');
    return;
  }
  pg(`UPDATE fulfillment_orders
    SET status = 'COMPLETED', status_reason = ${sqlString(reason)}, receipt_note = ${sqlString(receipt)}, completed_at = CURRENT_TIMESTAMP
    WHERE arora_order_utr = ${sqlString(utr)}`);
  if (order.status !== 'COMPLETED') notifyOrderStatus(order, 'COMPLETED', reason);
  if (order.account_id) {
    const pack = pgOne(`SELECT unipin_uc_cost FROM ff_packages WHERE package_code = ${sqlString(order.package_code)} LIMIT 1`) || {};
    pg(`UPDATE unipin_loaded_accounts SET balance = balance - ${num(pack.unipin_uc_cost)} WHERE id = ${Number(order.account_id)}`);
  }
  const reseller = resellerRow();
  if (!reseller || !reseller.webhook_url) return;
  const uniqbdOrderId = String(order.reseller_order_id || '').split('#')[0].split(':')[0];
  const payload = JSON.stringify({
    event: 'order.completed',
    order_id: order.reseller_order_id,
    uniqbd_order_id: uniqbdOrderId,
    status: 'COMPLETED',
    player_uid: order.player_uid,
    package_code: order.package_code,
    package_name: order.package_name,
    quantity: Number(order.quantity) || 1,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', reseller.api_secret).update(timestamp + '.' + payload).digest('hex');
  fetch(reseller.webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Arora-Event': 'order.completed',
      'X-Arora-Timestamp': timestamp,
      'X-Arora-Signature': signature,
    },
    body: payload,
  }).then((response) => {
    pg(`UPDATE fulfillment_orders SET webhook_status = ${sqlString(String(response.status))} WHERE arora_order_utr = ${sqlString(utr)}`);
  }).catch(() => {
    pg(`UPDATE fulfillment_orders SET webhook_status = 'failed' WHERE arora_order_utr = ${sqlString(utr)}`);
  });
}

function saveVoucherBatch(body) {
  const pack = matchPackage({ package_code: body.package_code });
  if (!pack) return { ok: false, error: 'Unknown package' };
  const lines = String(body.tokens_text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 200);
  let added = 0;
  let duplicates = 0;
  const duplicateMasks = [];
  const seen = new Set();
  for (const line of lines) {
    const hash = crypto.createHash('sha256').update(pack.package_code + '\n' + line).digest('hex');
    const tokenHash = crypto.createHash('sha256').update('ff-token\n' + line).digest('hex');
    if (seen.has(tokenHash)) {
      duplicates += 1;
      if (duplicateMasks.length < 5) duplicateMasks.push(maskCode(line));
      continue;
    }
    seen.add(tokenHash);
    let exists = null;
    try {
      exists = pgOne(`SELECT id FROM unipin_vouchers WHERE code_hash = ${sqlString(hash)} OR token_hash = ${sqlString(tokenHash)} LIMIT 1`);
    } catch (err) {
      console.error('token duplicate check:', dbError(err));
      exists = pgOne('SELECT id FROM unipin_vouchers WHERE code_hash = ' + sqlString(hash));
    }
    if (exists) {
      duplicates += 1;
      if (duplicateMasks.length < 5) duplicateMasks.push(maskCode(line));
      continue;
    }
    try {
      pg(`INSERT INTO unipin_vouchers (package_code, code_hash, token_hash, code_encrypted, masked_code, status)
        VALUES (${sqlString(pack.package_code)}, ${sqlString(hash)}, ${sqlString(tokenHash)}, ${sqlString(encryptSecret(line))}, ${sqlString(maskCode(line))}, 'available')`);
    } catch (err) {
      console.error('token save:', dbError(err));
      pg(`INSERT INTO unipin_vouchers (package_code, code_hash, code_encrypted, masked_code, status)
        VALUES (${sqlString(pack.package_code)}, ${sqlString(hash)}, ${sqlString(encryptSecret(line))}, ${sqlString(maskCode(line))}, 'available')`);
    }
    added += 1;
  }
  const total = pgOne(`SELECT COUNT(*) AS n FROM unipin_vouchers WHERE package_code = ${sqlString(pack.package_code)} AND lower(status) = 'available'`) || {};
  return { ok: true, added, duplicates, duplicate_masks: duplicateMasks, total_available: num(total.n) };
}

function touchExtension(ip) {
  const now = Date.now();
  try {
    const saved = pg(`UPDATE extension_status SET last_seen_at = ${now}, last_ip = ${sqlString(ip)} RETURNING key_id`);
    if (!saved) {
      pg(`INSERT INTO extension_status (key_id, last_seen_at, last_ip) VALUES ('root', ${now}, ${sqlString(ip)})`);
    }
  } catch (err) {
    console.error('extension seen:', dbError(err));
  }
  try {
    pg(`UPDATE resellers SET ext_last_seen_at = ${now}, ext_last_ip = ${sqlString(ip)}`);
  } catch (err) {
    console.error('extension seen:', dbError(err));
  }
}

function seenOnline(ts) {
  const n = Number(ts || 0);
  if (!n) return false;
  const ms = n > 1e12 ? n : n * 1000;
  return Date.now() - ms < 120000;
}

function flagOn(value) {
  return value === true || value === 't' || value === 'true' || Number(value) === 1;
}

function uniqbdLink() {
  const expectedWebhook = 'https://uniqbd.com/api/ff-webhook';
  const reseller = pgOne(`
    SELECT is_active, webhook_url,
           (api_key IS NOT NULL AND length(api_key) > 10) AS api_key_saved,
           (api_secret IS NOT NULL AND length(api_secret) > 10) AS api_secret_saved
    FROM resellers
    ORDER BY id
    LIMIT 1
  `) || {};
  const packages = pgJson(`
    SELECT p.package_code, p.name, p.diamonds, p.unipin_uc_cost, p.is_active,
           (SELECT COUNT(*) FROM unipin_vouchers v
             WHERE v.package_code = p.package_code AND lower(v.status) = 'available'
               AND v.code_encrypted LIKE 'aes256gcm$%') AS ready_tokens,
           (SELECT COUNT(*) FROM unipin_loaded_accounts a
             WHERE lower(a.status) = 'active'
               AND a.credentials_encrypted LIKE 'aes256gcm$%'
               AND a.balance >= p.unipin_uc_cost) AS ready_accounts
    FROM ff_packages p
    ORDER BY p.id
  `);
  const oldAccounts = pgOne("SELECT COUNT(*) AS n FROM unipin_loaded_accounts WHERE credentials_encrypted NOT LIKE 'aes256gcm$%'") || {};
  const orders = pgJson(`
    SELECT reseller_order_id, player_uid, package_code, package_name, status, webhook_status, method_used, created_at
    FROM fulfillment_orders
    WHERE reseller_order_id IS NOT NULL AND length(reseller_order_id) > 0
    ORDER BY id DESC
    LIMIT 15
  `);
  const webhookUrl = String(reseller.webhook_url || '');
  const apiReady = flagOn(reseller.api_key_saved) && flagOn(reseller.api_secret_saved) && flagOn(reseller.is_active);
  const webhookReady = webhookUrl === expectedWebhook;
  return {
    shop: 'uniqbd.com',
    api_url: 'https://ff.uniqbd.com/api/reseller/v1/order',
    webhook_url: webhookUrl,
    webhook_expected: expectedWebhook,
    api_key_saved: flagOn(reseller.api_key_saved),
    api_secret_saved: flagOn(reseller.api_secret_saved),
    reseller_active: flagOn(reseller.is_active),
    api_ready: apiReady,
    webhook_ready: webhookReady,
    connected: apiReady && webhookReady,
    old_accounts: num(oldAccounts.n),
    packages: packages.map((row) => ({
      package_code: row.package_code,
      name: row.name,
      diamonds: num(row.diamonds),
      uniqbd_name: row.package_code === 'FF_WEEKLY'
        ? 'Weekly Membership'
        : row.package_code === 'FF_MONTHLY'
          ? 'Monthly Membership'
          : num(row.diamonds) + ' Diamond',
      ready_tokens: num(row.ready_tokens),
      ready_accounts: num(row.ready_accounts),
      active: flagOn(row.is_active),
      ready: flagOn(row.is_active) && (num(row.ready_tokens) > 0 || num(row.ready_accounts) > 0),
    })),
    orders: orders.map((row) => ({
      reseller_order_id: row.reseller_order_id,
      uniqbd_order_id: String(row.reseller_order_id || '').split('#')[0].split(':')[0],
      player_uid: row.player_uid,
      package_code: row.package_code,
      package_name: row.package_name,
      status: row.status,
      webhook_status: row.webhook_status || '',
      method_used: row.method_used || '',
      created_at: row.created_at || '',
    })),
  };
}

async function probeUniqbdWebhook() {
  const link = uniqbdLink();
  if (!link.webhook_ready) {
    return { ok: false, error: 'Webhook is not set to https://uniqbd.com/api/ff-webhook' };
  }
  try {
    const response = await fetch(link.webhook_expected, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'X-Arora-Event': 'order.completed',
        'X-Arora-Timestamp': '0',
        'X-Arora-Signature': '00',
      },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    let rejected = false;
    try {
      const parsed = await response.json();
      rejected = Boolean(parsed && parsed.ok === false);
    } catch {
      rejected = false;
    }
    const answered = response.status === 200 || response.status === 201;
    return {
      ok: true,
      http_status: response.status,
      route_live: answered && rejected,
    };
  } catch {
    return { ok: false, error: 'UniQbd did not answer' };
  }
}

function loadDeskOrders() {
  const columns = `id, arora_order_utr, player_uid, package_code, package_name, quantity,
           method_used, status, status_reason, receipt_note, webhook_status, created_at`;
  try {
    return pgJson(`SELECT ${columns}, shop_order_number FROM fulfillment_orders ORDER BY id DESC`);
  } catch (err) {
    console.error('dashboard orders:', dbError(err));
  }
  try {
    return pgJson(`SELECT ${columns}, '' AS shop_order_number FROM fulfillment_orders ORDER BY id DESC`);
  } catch (err) {
    console.error('dashboard orders:', dbError(err));
    return [];
  }
}

function dashQuery(label, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    console.error('dashboard ' + label + ':', dbError(err));
    return fallback;
  }
}

function dashboard() {
  cancelStuckProcessingOrders();
  const stats = dashQuery('stats', () => pgOne(`
    SELECT COUNT(*) AS total_orders,
           SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_orders,
           SUM(CASE WHEN status NOT IN ('COMPLETED', 'CANCELLED', 'LOGIN_FAILED') THEN 1 ELSE 0 END) AS processing_orders
    FROM fulfillment_orders
  `), {}) || {};
  const tokens = dashQuery('tokens', () => pgOne("SELECT COUNT(*) AS n FROM unipin_vouchers WHERE lower(status) = 'available'"), {}) || {};
  const balance = dashQuery('balance', () => pgOne('SELECT COALESCE(SUM(balance), 0) AS n FROM unipin_loaded_accounts'), {}) || {};
  const ext = dashQuery('extension', () => pgOne('SELECT last_seen_at FROM extension_status LIMIT 1'), {}) || {};
  const keyRow = dashQuery('extension-key', () => pgOne('SELECT extension_key FROM resellers ORDER BY id LIMIT 1'), {}) || {};
  const reseller = dashQuery('reseller', () => pgOne(`
    SELECT allowed_ips, telegram_chat_id, telegram_alerts,
           (telegram_bot_token_encrypted IS NOT NULL AND position('aes256gcm' in telegram_bot_token_encrypted) = 1) AS telegram_has_token,
           (telegram_bot_token_encrypted IS NOT NULL AND position('aes256gcm' in telegram_bot_token_encrypted) = 1
             AND telegram_chat_id IS NOT NULL AND length(telegram_chat_id) > 0) AS telegram_connected
    FROM resellers
    ORDER BY id
    LIMIT 1
  `), {}) || {};
  const packages = dashQuery('packages', () => pgJson(`
    SELECT p.id, p.package_code, p.arora_service_id, p.name, p.diamonds,
           p.unipin_uc_cost, p.low_stock_threshold, p.is_active,
           (SELECT COUNT(*) FROM unipin_vouchers v
             WHERE v.package_code = p.package_code AND lower(v.status) = 'available') AS available_tokens,
           (SELECT COUNT(*) FROM unipin_vouchers v
             WHERE v.package_code = p.package_code AND lower(v.status) <> 'available') AS used_tokens,
           (SELECT COUNT(*) FROM fulfillment_orders o WHERE o.package_code = p.package_code) AS order_count,
           (SELECT price_bdt FROM reseller_prices r WHERE r.package_code = p.package_code ORDER BY r.reseller_id LIMIT 1) AS price_bdt
    FROM ff_packages p
    ORDER BY p.id
  `), []);
  const accounts = dashQuery('accounts', () => pgJson(`
    SELECT id, label, masked_email, balance, low_balance_threshold, status,
           (security_pin_encrypted IS NOT NULL AND length(security_pin_encrypted) > 0) AS has_security_pin
    FROM unipin_loaded_accounts
    ORDER BY id
  `), []);
  const orders = loadDeskOrders();
  return {
    ok: true,
    extension_status: { online: seenOnline(ext.last_seen_at), last_seen_at: ext.last_seen_at || null },
    stats: {
      total_orders: num(stats.total_orders),
      completed_orders: num(stats.completed_orders),
      processing_orders: num(stats.processing_orders),
      total_available_tokens: num(tokens.n),
      total_account_balance: num(balance.n),
    },
    packages,
    accounts,
    orders,
    security_info: {
      extension_key: keyRow.extension_key || '',
      encryption: 'AES-256',
      auth_scheme: 'Bearer',
      allowed_ips: reseller.allowed_ips || '127.0.0.1',
      telegram_connected: flagOn(reseller.telegram_connected),
      telegram_has_token: flagOn(reseller.telegram_has_token),
      telegram_chat_id: reseller.telegram_chat_id || '',
      telegram_alerts: telegramAlertMap(reseller.telegram_alerts),
    },
    uniqbd: dashQuery('uniqbd', () => uniqbdLink(), {}),
  };
}

function pgDumpBin() {
  if (process.env.PG_DUMP_BIN) return process.env.PG_DUMP_BIN;
  if (psqlBin && psqlBin !== 'psql') {
    return path.join(path.dirname(psqlBin), process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
  }
  return 'pg_dump';
}

const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const BACKUP_KEEP = 30;
const BACKUP_NAME = /^ff-uniqbd-\d{8}\.sql$/;

function dhakaNow(date = new Date()) {
  return new Date(date.getTime() + 6 * 60 * 60 * 1000);
}

function backupStamp(date = new Date()) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return 'ff-uniqbd-'
    + now.getUTCFullYear()
    + pad(now.getUTCMonth() + 1)
    + pad(now.getUTCDate())
    + '-'
    + pad(now.getUTCHours())
    + pad(now.getUTCMinutes())
    + pad(now.getUTCSeconds())
    + '.sql';
}

function dailyBackupName(date = new Date()) {
  const wall = dhakaNow(date);
  const pad = (n) => String(n).padStart(2, '0');
  return 'ff-uniqbd-'
    + wall.getUTCFullYear()
    + pad(wall.getUTCMonth() + 1)
    + pad(wall.getUTCDate())
    + '.sql';
}

function msUntilNextFiveAm(date = new Date()) {
  const wall = dhakaNow(date);
  const next = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 5, 0, 0, 0));
  if (wall.getTime() >= next.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - wall.getTime();
}

let backupBusy = false;

function dumpDatabase(file) {
  return new Promise((resolve) => {
    const dump = spawn(pgDumpBin(), [
      '-h', process.env.PGHOST || '127.0.0.1',
      '-p', String(process.env.PGPORT || '5432'),
      '-U', process.env.PGUSER || 'ffapp',
      '-d', process.env.PGDATABASE || 'ff_uniqbd',
      '--no-owner',
      '--no-acl',
      '--format=p',
      '-f', file,
    ], {
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' },
      windowsHide: true,
    });
    dump.stderr.resume();
    let settled = false;
    const timer = setTimeout(() => dump.kill(), 120000);
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    dump.once('error', () => done({ ok: false, error: 'tool' }));
    dump.once('close', (code) => {
      if (code !== 0) return done({ ok: false, error: 'dump' });
      try {
        const size = fs.statSync(file).size;
        if (!size) return done({ ok: false, error: 'dump' });
        done({ ok: true, size });
      } catch {
        done({ ok: false, error: 'dump' });
      }
    });
  });
}

function sendBackupFile(res, file, downloadName, onDone) {
  const size = fs.statSync(file).size;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (onDone) onDone();
  };
  res.writeHead(200, {
    'Content-Type': 'application/sql; charset=utf-8',
    'Content-Length': size,
    'Content-Disposition': 'attachment; filename="' + downloadName + '"',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    finish();
    if (!res.writableEnded) res.destroy();
  });
  stream.on('close', finish);
  res.on('close', finish);
  stream.pipe(res);
}

function sendBackup(res) {
  if (backupBusy) return sendJson(res, 429, { ok: false, error: 'A backup is already running.' });
  backupBusy = true;
  const file = path.join(os.tmpdir(), 'ff-uniqbd-' + crypto.randomBytes(16).toString('hex') + '.sql');
  const release = () => {
    backupBusy = false;
    fs.unlink(file, () => {});
  };
  dumpDatabase(file).then((result) => {
    if (!result.ok || res.destroyed) {
      release();
      if (!result.ok && !res.headersSent) {
        const error = result.error === 'tool' ? 'Backup tool is not available.' : 'Could not create the backup.';
        sendJson(res, 500, { ok: false, error });
      }
      return;
    }
    try {
      sendBackupFile(res, file, backupStamp(), release);
    } catch {
      release();
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Could not create the backup.' });
    }
  });
}

function savedBackupPath(name) {
  if (!BACKUP_NAME.test(name)) return '';
  const root = path.resolve(BACKUP_DIR);
  const full = path.resolve(root, name);
  if (!full.startsWith(root + path.sep)) return '';
  return full;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: stat.size, created: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function pruneBackups() {
  const names = listBackups().map((row) => row.name).sort();
  while (names.length > BACKUP_KEEP) {
    const old = names.shift();
    fs.unlink(path.join(BACKUP_DIR, old), () => {});
  }
}

async function saveDailyBackup(attempt = 0) {
  const name = dailyBackupName();
  const dest = path.join(BACKUP_DIR, name);
  if (fs.existsSync(dest)) return;
  if (backupBusy) {
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 30000));
      return saveDailyBackup(attempt + 1);
    }
    console.error('daily backup skipped');
    return;
  }
  backupBusy = true;
  const tmp = dest + '.tmp';
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const result = await dumpDatabase(tmp);
    if (!result.ok) {
      fs.unlink(tmp, () => {});
      console.error('daily backup failed');
      return;
    }
    fs.renameSync(tmp, dest);
    pruneBackups();
    console.log('daily backup saved');
  } catch (err) {
    fs.unlink(tmp, () => {});
    console.error('daily backup failed');
  } finally {
    backupBusy = false;
  }
}

function scheduleDailyBackup() {
  const arm = () => {
    setTimeout(() => {
      saveDailyBackup().finally(arm);
    }, msUntilNextFiveAm());
  };
  const wall = dhakaNow();
  const pastFive = wall.getUTCHours() > 5 || (wall.getUTCHours() === 5 && wall.getUTCMinutes() >= 0);
  const today = path.join(BACKUP_DIR, dailyBackupName());
  if (pastFive && !fs.existsSync(today)) saveDailyBackup().finally(arm);
  else arm();
}

function applyAdminReset() {
  const password = String(process.env.RESET_ADMIN_PASSWORD || '').trim();
  if (!password) return;
  const hash = hashPassword(password);
  const target = pgOne("SELECT username FROM admins WHERE username = 'aroraadmin' LIMIT 1")
    || pgOne('SELECT username FROM admins ORDER BY username LIMIT 1');
  if (target) pg(`UPDATE admins SET password_hash = ${sqlString(hash)} WHERE username = ${sqlString(target.username)}`);
  if (fs.existsSync(envFile)) {
    const raw = fs.readFileSync(envFile, 'utf8');
    const lines = raw.split(/\r?\n/);
    const kept = lines.filter((line) => !line.startsWith('RESET_ADMIN_PASSWORD='));
    if (kept.length !== lines.length) {
      fs.writeFileSync(envFile, kept.join('\n').replace(/\n*$/, '\n'));
    }
  }
  console.log('admin password reset applied');
}

if (process.argv[2] === '--hash') {
  const password = process.argv[3] || '';
  if (!password) process.exit(1);
  process.stdout.write(hashPassword(password));
  process.exit(0);
}

try {
  applyAdminReset();
} catch (err) {
  console.error('admin password reset failed:', dbError(err));
}

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  let requestUrl = null;
  try {
    requestUrl = new URL(req.url, 'http://127.0.0.1');
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return send(res, 400, 'Bad request', 'text/plain; charset=utf-8');
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  if (!ipAllowed(req)) {
    return send(res, 403, 'This IP is not allowed.', 'text/plain; charset=utf-8');
  }

  if (pathname === '/health') {
    return sendJson(res, 200, { ok: true, host: 'ff.uniqbd.com' });
  }

  if (pathname === '/admin-api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return sendJson(res, 429, { ok: false, error: 'Too many tries. Wait 15 minutes.' });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const username = String(body.username || '').trim();
      const password = String(body.password || '').trim();
      if (!username || !password || !authSecret) {
        noteLoginFail(ip);
        return sendJson(res, 401, { ok: false });
      }
      const row = pgOne('SELECT username, password_hash FROM admins WHERE username = ' + sqlString(username));
      if (!row || !verifyPassword(password, row.password_hash)) {
        noteLoginFail(ip);
        return sendJson(res, 401, { ok: false });
      }
      loginFails.delete(ip);
      return sendJson(res, 200, { ok: true, token: signToken(row.username, row.password_hash) });
    } catch (err) {
      console.error('login failed:', dbError(err));
      return sendJson(res, 401, { ok: false });
    }
  }

  if (pathname === '/admin-api/me') {
    const username = readToken(req);
    if (!username) return sendJson(res, 401, { ok: false });
    const row = pgOne(`SELECT username, password_hash FROM admins WHERE username = ${sqlString(username)} LIMIT 1`);
    if (!row) return sendJson(res, 401, { ok: false });
    return sendJson(res, 200, { ok: true, username: row.username, token: signToken(row.username, row.password_hash) });
  }

  if (pathname === '/admin-api/admins' && req.method === 'GET') {
    const username = readToken(req);
    if (!username) return sendJson(res, 401, { ok: false });
    try {
      return sendJson(res, 200, listAdmins(username));
    } catch (err) {
      console.error('admin list failed:', dbError(err));
      return sendJson(res, 500, { ok: false });
    }
  }

  if (pathname === '/admin-api/admins' && req.method === 'POST') {
    const username = readToken(req);
    if (!username) return sendJson(res, 401, { ok: false });
    try {
      const result = addAdmin(username, JSON.parse(await readBody(req) || '{}'));
      return sendJson(res, result.status, result.body);
    } catch (err) {
      console.error('admin add failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Could not add this admin.' });
    }
  }

  const adminRemove = pathname.match(/^\/admin-api\/admins\/([A-Za-z0-9._-]{3,32})$/);
  if (adminRemove && req.method === 'DELETE') {
    const username = readToken(req);
    if (!username) return sendJson(res, 401, { ok: false });
    try {
      const result = removeAdmin(username, decodeURIComponent(adminRemove[1]));
      return sendJson(res, result.status, result.body);
    } catch (err) {
      console.error('admin remove failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Could not remove this admin.' });
    }
  }

  if (pathname === '/admin-api/password' && req.method === 'POST') {
    const username = readToken(req);
    if (!username) return sendJson(res, 401, { ok: false });
    try {
      const result = changeAdminPassword(username, JSON.parse(await readBody(req) || '{}'));
      return sendJson(res, result.status, result.body);
    } catch (err) {
      console.error('password change failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Could not update the password.' });
    }
  }

  if (pathname === '/admin-api/backup' && req.method === 'GET') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    return sendBackup(res);
  }

  if (pathname === '/admin-api/backups' && req.method === 'GET') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    return sendJson(res, 200, {
      ok: true,
      schedule: 'Every day at 5:00 AM, Bangladesh time',
      backups: listBackups(),
    });
  }

  const savedBackup = pathname.match(/^\/admin-api\/backups\/(ff-uniqbd-\d{8}\.sql)$/);
  if (savedBackup && req.method === 'GET') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    const full = savedBackupPath(savedBackup[1]);
    if (!full || !fs.existsSync(full)) return sendJson(res, 404, { ok: false, error: 'Backup not found.' });
    try {
      return sendBackupFile(res, full, savedBackup[1]);
    } catch {
      return sendJson(res, 500, { ok: false, error: 'Could not open the backup.' });
    }
  }

  if (pathname === '/admin-api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/admin-api/telegram' && req.method === 'POST') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      const result = saveTelegram(JSON.parse(await readBody(req) || '{}'));
      return sendJson(res, result.status, result.body);
    } catch (err) {
      console.error('telegram save failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Could not save the Telegram bot.' });
    }
  }

  if (pathname === '/admin-api/telegram/test' && req.method === 'POST') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      const result = await testTelegram();
      return sendJson(res, result.status, result.body);
    } catch (err) {
      console.error('telegram test failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Telegram test failed.' });
    }
  }

  if (pathname === '/admin-api/dashboard') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      return sendJson(res, 200, dashboard());
    } catch (err) {
      console.error('dashboard failed:', dbError(err));
      return sendJson(res, 500, { ok: false });
    }
  }

  const accountMatch = pathname.match(/^\/admin-api\/accounts(?:\/(\d+))?$/);
  if (accountMatch) {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    const id = accountMatch[1] ? Number(accountMatch[1]) : 0;
    try {
      if (req.method === 'POST' && !id) {
        const result = saveAccount(JSON.parse(await readBody(req) || '{}'));
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'PUT' && id) {
        const result = editAccount(id, JSON.parse(await readBody(req) || '{}'));
        const code = result.ok ? 200 : result.error === 'Account not found' ? 404 : 400;
        return sendJson(res, code, result);
      }
      if (req.method === 'DELETE' && id) {
        const removed = pg('DELETE FROM unipin_loaded_accounts WHERE id = ' + id + ' RETURNING id');
        return sendJson(res, removed === String(id) ? 200 : 404, { ok: removed === String(id) });
      }
      return sendJson(res, 405, { ok: false });
    } catch (err) {
      console.error('account action failed:', dbError(err));
      return sendJson(res, 500, { ok: false });
    }
  }

  if (pathname === '/ext-api/ping' && req.method === 'GET') {
    try {
      if (!extensionMatches(req)) return sendJson(res, 401, { ok: false, error: 'Invalid extension key' });
      touchExtension(clientIp(req));
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error('extension ping failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Extension API failed' });
    }
  }

  if (pathname === '/ext-api/order-open' && req.method === 'GET') {
    try {
      if (!extensionMatches(req)) return sendJson(res, 401, { ok: false, error: 'Invalid extension key' });
      const utr = String(requestUrl.searchParams.get('utr') || '').trim().slice(0, 80);
      if (!utr) return sendJson(res, 400, { ok: false });
      let row = null;
      try {
        row = pgOne(`SELECT status, method_used, retry_at, claimed_at FROM fulfillment_orders WHERE arora_order_utr = ${sqlString(utr)} LIMIT 1`);
      } catch (err) {
        console.error('order open:', dbError(err));
        row = pgOne(`SELECT status, method_used FROM fulfillment_orders WHERE arora_order_utr = ${sqlString(utr)} LIMIT 1`);
      }
      const freshRetry = Boolean(row && row.status === 'QUEUED_EXT' && (row.method_used === 'retry' || (row.retry_at && !row.claimed_at)));
      const open = Boolean(row) && !freshRetry && (row.status === 'QUEUED_EXT' || row.status === 'IN_PROGRESS_EXT' || row.status === 'PROCESSING');
      return sendJson(res, 200, { ok: true, open });
    } catch (err) {
      console.error('order open failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Extension API failed' });
    }
  }

  if (pathname === '/ext-api/next-order' && req.method === 'GET') {
    try {
      if (!extensionMatches(req)) return sendJson(res, 401, { ok: false, error: 'Invalid extension key' });
      touchExtension(clientIp(req));
      return sendJson(res, 200, { ok: true, task: claimNextTask() });
    } catch (err) {
      console.error('extension poll failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Extension API failed' });
    }
  }

  if (pathname === '/ext-api/order-result' && req.method === 'POST') {
    try {
      if (!extensionMatches(req)) return sendJson(res, 401, { ok: false, error: 'Invalid extension key' });
      touchExtension(clientIp(req));
      finishExtensionOrder(JSON.parse(await readBody(req) || '{}'));
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error('extension result failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Extension API failed' });
    }
  }

  if (pathname === '/api/reseller/v1/order/cancel' && req.method === 'POST') {
    try {
      const reseller = resellerAuth(req);
      if (!reseller) return sendJson(res, 401, { ok: false, error: 'Invalid API key' });
      const result = stopResellerOrder(reseller, JSON.parse(await readBody(req) || '{}'));
      return sendJson(res, result.status, result.body);
    } catch (err) {
      console.error('reseller cancel failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Order API failed' });
    }
  }

  if (pathname === '/api/reseller/v1/order' && req.method === 'POST') {
    try {
      const reseller = resellerAuth(req);
      if (!reseller) return sendJson(res, 401, { ok: false, error: 'Invalid API key' });
      const result = placeResellerOrder(reseller, JSON.parse(await readBody(req) || '{}'), clientIp(req));
      return sendJson(res, result.status, result.body);
    } catch (err) {
      console.error('reseller order failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'Order API failed' });
    }
  }

  if (pathname === '/admin-api/uniqbd-check' && req.method === 'POST') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      return sendJson(res, 200, await probeUniqbdWebhook());
    } catch (err) {
      console.error('uniqbd check failed:', dbError(err));
      return sendJson(res, 500, { ok: false, error: 'UniQbd check failed' });
    }
  }

  if (pathname === '/admin-api/vouchers/bulk' && req.method === 'POST') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      return sendJson(res, 200, saveVoucherBatch(JSON.parse(await readBody(req) || '{}')));
    } catch (err) {
      console.error('voucher save failed:', dbError(err));
      return sendJson(res, 500, { ok: false });
    }
  }

  const voucherMatch = pathname.match(/^\/admin-api\/vouchers\/(\d+)$/);
  if (voucherMatch && req.method === 'GET') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      const row = pgOne(`SELECT code_encrypted FROM unipin_vouchers WHERE id = ${Number(voucherMatch[1])} LIMIT 1`);
      if (!row) return sendJson(res, 404, { ok: false, error: 'Token not found' });
      const code = decryptSecret(row.code_encrypted);
      if (!code) return sendJson(res, 400, { ok: false, error: 'This token cannot be shown.' });
      return sendJson(res, 200, { ok: true, code });
    } catch (err) {
      console.error('show token failed:', dbError(err));
      return sendJson(res, 500, { ok: false });
    }
  }
  if (voucherMatch && req.method === 'DELETE') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    const removed = pg('DELETE FROM unipin_vouchers WHERE id = ' + Number(voucherMatch[1]) + " AND lower(status) = 'available' RETURNING id");
    return sendJson(res, removed ? 200 : 404, { ok: Boolean(removed) });
  }

  if (pathname === '/admin-api/vouchers') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      let vouchers;
      try {
        vouchers = pgJson(`SELECT v.id, v.package_code, v.masked_code, v.status, v.used_order_utr, o.shop_order_number
          FROM unipin_vouchers v
          LEFT JOIN fulfillment_orders o ON o.arora_order_utr = v.used_order_utr
          ORDER BY v.id DESC`);
      } catch (err) {
        console.error('voucher orders:', dbError(err));
        vouchers = pgJson('SELECT id, package_code, masked_code, status, used_order_utr FROM unipin_vouchers ORDER BY id DESC');
      }
      return sendJson(res, 200, { ok: true, vouchers });
    } catch {
      return sendJson(res, 500, { ok: false });
    }
  }

  if (req.method === 'POST' && pathname === '/admin-api/orders/clear-pending') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      pg(`UPDATE unipin_vouchers SET status = 'available', used_order_utr = NULL, used_at = NULL
        WHERE used_order_utr IN (SELECT arora_order_utr FROM fulfillment_orders WHERE status <> 'COMPLETED')`);
      rememberDismissedOrders(`status <> 'COMPLETED'`);
      pg(`DELETE FROM fulfillment_orders WHERE status <> 'COMPLETED'`);
      return sendJson(res, 200, { ok: true, message: 'Pending orders cleared.' });
    } catch {
      return sendJson(res, 500, { ok: false });
    }
  }

  if (pathname === '/admin-api/ip-whitelist' && req.method === 'GET') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      return sendJson(res, 200, listWhitelist(clientIp(req)));
    } catch (err) {
      console.error('ip list failed:', dbError(err));
      return sendJson(res, 500, { ok: false });
    }
  }

  if (pathname === '/admin-api/ip-whitelist' && req.method === 'POST') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      const result = addWhitelistIp(JSON.parse(await readBody(req) || '{}').ip);
      return sendJson(res, result.ok ? 200 : 400, result.ok ? listWhitelist(clientIp(req)) : result);
    } catch (err) {
      console.error('ip add failed:', dbError(err));
      return sendJson(res, 500, { ok: false });
    }
  }

  const ipRemove = pathname.match(/^\/admin-api\/ip-whitelist\/(\d+)$/);
  if (ipRemove && req.method === 'DELETE') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      const result = removeWhitelistIp(Number(ipRemove[1]), clientIp(req));
      return sendJson(res, result.ok ? 200 : 400, result.ok ? listWhitelist(clientIp(req)) : result);
    } catch (err) {
      console.error('ip remove failed:', dbError(err));
      return sendJson(res, 500, { ok: false });
    }
  }

  const orderAction = pathname.match(/^\/admin-api\/orders\/(\d+)\/(retry|complete|delete|toggle-pause)$/);
  if (req.method === 'POST' && orderAction) {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      const result = orderActionResult(Number(orderAction[1]), orderAction[2], JSON.parse(await readBody(req) || '{}'));
      return sendJson(res, result.status, result.body);
    } catch {
      return sendJson(res, 500, { ok: false });
    }
  }

  if (
    pathname.startsWith('/admin-api') ||
    pathname.startsWith('/user-api') ||
    pathname.startsWith('/super-api') ||
    pathname.startsWith('/api')
  ) {
    return sendJson(res, 503, { ok: false, error: 'This action is not available yet.' });
  }

  const rel = publicFile(pathname);
  const full = rel ? path.join(root, rel) : '';
  if (!full || !full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  res.writeHead(200, {
    'Content-Type': types[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': ['.html', '.zip'].includes(path.extname(full).toLowerCase()) ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(full).pipe(res);
});

try {
  ensureDeskColumns();
} catch (err) {
  console.error('telegram alerts column:', dbError(err));
}

server.listen(port, host, () => {
  try {
    shortenStoredOrderIds();
  } catch (err) {
    console.error('Could not shorten old order ids');
  }
  try {
    showShopOrderNumbers();
  } catch (err) {
    console.error('shop order code:', dbError(err));
  }
  try {
    cancelStuckProcessingOrders();
  } catch (err) {
    console.error('cancel stuck orders:', dbError(err));
  }
  console.log('ff.uniqbd.com listening on http://' + host + ':' + port);
  scheduleDailyBackup();
});
