const http = require('http');
const fs = require('fs');
const path = require('path');

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
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  if (pathname === '/health') {
    return send(res, 200, JSON.stringify({ ok: true, host: 'ff.uniqbd.com' }), 'application/json; charset=utf-8');
  }

  if (
    pathname.startsWith('/admin-api') ||
    pathname.startsWith('/user-api') ||
    pathname.startsWith('/super-api') ||
    pathname.startsWith('/api')
  ) {
    return send(res, 503, JSON.stringify({
      ok: false,
      error: 'The fulfillment API is not running on this host yet.',
    }), 'application/json; charset=utf-8');
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
