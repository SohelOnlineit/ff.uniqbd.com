const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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

const pages = {
  '/': 'index.html',
  '/admin': 'admin.html',
  '/docs': 'docs.html',
  '/user': 'user.html',
  '/user/login': 'user.html',
  '/user/dashboard': 'user.html',
};

const types = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
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
  const balance = money(body.balance, null);
  const low = money(body.low_balance_threshold, null);
  const status = body.status === 'paused' ? 'paused' : 'active';
  if (balance === null || low === null) return { ok: false };
  const saved = pg(`UPDATE unipin_loaded_accounts
      SET balance = ${balance}, low_balance_threshold = ${low}, status = ${sqlString(status)}
      WHERE id = ${id}
      RETURNING id`);
  return { ok: saved === String(id) };
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

function signToken(username) {
  const body = Buffer.from(JSON.stringify({
    u: username,
    exp: Date.now() + 12 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
  return body + '.' + sig;
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
    if (!payload.u || !payload.exp || payload.exp < Date.now()) return null;
    return payload.u;
  } catch {
    return null;
  }
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function seenOnline(ts) {
  const n = Number(ts || 0);
  if (!n) return false;
  const ms = n > 1e12 ? n : n * 1000;
  return Date.now() - ms < 120000;
}

function dashboard() {
  const stats = pgOne(`
    SELECT COUNT(*) AS total_orders,
           SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_orders,
           SUM(CASE WHEN status NOT IN ('COMPLETED', 'CANCELLED') THEN 1 ELSE 0 END) AS processing_orders
    FROM fulfillment_orders
  `) || {};
  const tokens = pgOne("SELECT COUNT(*) AS n FROM unipin_vouchers WHERE lower(status) = 'available'") || {};
  const balance = pgOne('SELECT COALESCE(SUM(balance), 0) AS n FROM unipin_loaded_accounts') || {};
  const ext = pgOne('SELECT last_seen_at FROM extension_status LIMIT 1') || {};
  const reseller = pgOne(`
    SELECT extension_key, allowed_ips,
           (telegram_chat_id IS NOT NULL AND length(telegram_chat_id) > 0) AS telegram_connected
    FROM resellers
    ORDER BY id
    LIMIT 1
  `) || {};
  const packages = pgJson(`
    SELECT p.id, p.package_code, p.arora_service_id, p.name, p.diamonds,
           p.unipin_uc_cost, p.low_stock_threshold, p.is_active,
           (SELECT COUNT(*) FROM unipin_vouchers v
             WHERE v.package_code = p.package_code AND lower(v.status) = 'available') AS available_tokens,
           (SELECT COUNT(*) FROM unipin_vouchers v
             WHERE v.package_code = p.package_code AND lower(v.status) <> 'available') AS used_tokens
    FROM ff_packages p
    ORDER BY p.id
  `);
  const accounts = pgJson(`
    SELECT id, label, masked_email, balance, low_balance_threshold, status,
           (security_pin_encrypted IS NOT NULL AND length(security_pin_encrypted) > 0) AS has_security_pin
    FROM unipin_loaded_accounts
    ORDER BY id
  `);
  const orders = pgJson(`
    SELECT id, arora_order_utr, player_uid, package_code, package_name, quantity,
           method_used, status, status_reason, receipt_note
    FROM fulfillment_orders
    ORDER BY id DESC
  `);
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
      extension_key: reseller.extension_key || '',
      encryption: 'AES-256',
      auth_scheme: 'Bearer',
      allowed_ips: reseller.allowed_ips || '127.0.0.1',
      telegram_connected: Boolean(reseller.telegram_connected),
    },
  };
}

function applyAdminReset() {
  const password = String(process.env.RESET_ADMIN_PASSWORD || '').trim();
  if (!password) return;
  const hash = hashPassword(password);
  pg("UPDATE admins SET password_hash = " + sqlString(hash) + " WHERE username = 'aroraadmin'");
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
  const url = new URL(req.url, 'http://127.0.0.1');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  if (pathname === '/health') {
    return sendJson(res, 200, { ok: true, host: 'ff.uniqbd.com' });
  }

  if (pathname === '/admin-api/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const username = String(body.username || '').trim();
      const password = String(body.password || '').trim();
      if (!username || !password || !authSecret) return sendJson(res, 401, { ok: false });
      const row = pgOne('SELECT username, password_hash FROM admins WHERE username = ' + sqlString(username));
      if (!row || !verifyPassword(password, row.password_hash)) return sendJson(res, 401, { ok: false });
      return sendJson(res, 200, { ok: true, token: signToken(row.username) });
    } catch (err) {
      console.error('login failed:', dbError(err));
      return sendJson(res, 401, { ok: false });
    }
  }

  if (pathname === '/admin-api/me') {
    const username = readToken(req);
    if (!username) return sendJson(res, 401, { ok: false });
    return sendJson(res, 200, { ok: true, username });
  }

  if (pathname === '/admin-api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true });
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
        return sendJson(res, result.ok ? 200 : 404, result);
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

  if (pathname === '/admin-api/vouchers') {
    if (!readToken(req)) return sendJson(res, 401, { ok: false });
    try {
      return sendJson(res, 200, {
        ok: true,
        vouchers: pgJson('SELECT id, package_code, masked_code, status, used_order_utr FROM unipin_vouchers ORDER BY id DESC'),
      });
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

  const rel = pages[pathname] || pathname.replace(/^\/+/, '');
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  res.writeHead(200, {
    'Content-Type': types[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': path.extname(full).toLowerCase() === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(full).pipe(res);
});

server.listen(port, host, () => {
  console.log('ff.uniqbd.com listening on http://' + host + ':' + port);
});
