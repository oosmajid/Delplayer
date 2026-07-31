const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');

const port = process.env.PORT || 8080;

// پشت nginx، remoteAddress برای همهٔ کاربران 127.0.0.1 است و محدودیت
// «اتصال به‌ازای IP» عملاً کل سایت را قفل می‌کند. اگر nginx در کار نبود
// با TRUST_PROXY=0 می‌شود این رفتار را خاموش کرد.
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';

// --- ۱. تنظیمات امنیتی ---
const MAX_CONNECTIONS_PER_IP = 8;
const MAX_MESSAGES_PER_SECOND = 15;   // پیام‌های معمولی (چت، دست‌دادن اولیه…)
const MAX_SYNC_PER_SECOND = 25;       // همگام‌سازی و ping/pong: سهمیهٔ جدا، ولی بی‌حساب نه
const MAX_MESSAGE_LENGTH = 4096;
const ID_LENGTH = 7;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const ipConnections = new Map();
const clients = new Map();   // id -> ws
const partners = new Map();  // id -> شناسهٔ طرف مقابلِ تأییدشده

function clientIp(req) {
    if (TRUST_PROXY) {
        const xff = req.headers['x-forwarded-for'];
        if (xff) return String(xff).split(',')[0].trim();
        const real = req.headers['x-real-ip'];
        if (real) return String(real).trim();
    }
    return req.socket.remoteAddress;
}

function makeId() {
    const bytes = crypto.randomBytes(ID_LENGTH);
    let out = '';
    for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
}

function uniqueId() {
    for (let i = 0; i < 50; i++) {
        const id = makeId();
        if (!clients.has(id)) return id;
    }
    return makeId() + makeId().slice(0, 2);
}

// --- ۲. فایل‌های ثابت ---
const ROOT = __dirname;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.txt', '.xml', '.svg']);

// فقط این مسیرها سرو می‌شوند؛ هر چیز دیگری ۴۰۴ است.
const ROUTES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.css': 'app.css',
    '/app.js': 'app.js',
    '/mkv-subs.worker.js': 'mkv-subs.worker.js',
    '/robots.txt': 'robots.txt',
    '/sitemap.xml': 'sitemap.xml',
    '/fonts/Vazirmatn-Regular.woff2': 'fonts/Vazirmatn-Regular.woff2',
    '/fonts/Vazirmatn-Medium.woff2': 'fonts/Vazirmatn-Medium.woff2',
    '/fonts/Vazirmatn-Bold.woff2': 'fonts/Vazirmatn-Bold.woff2'
};

// هر فایل یک‌بار خوانده، فشرده و در حافظه نگه داشته می‌شود
const cache = new Map();

function loadAsset(rel) {
    const raw = fs.readFileSync(path.join(ROOT, rel));
    const ext = path.extname(rel);
    const entry = {
        body: raw,
        gzip: COMPRESSIBLE.has(ext) ? zlib.gzipSync(raw, { level: 9 }) : null,
        type: MIME[ext] || 'application/octet-stream',
        etag: '"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 22) + '"',
        immutable: ext === '.woff2'
    };
    cache.set(rel, entry);
    return entry;
}

function getAsset(rel) {
    if (cache.has(rel)) return cache.get(rel);
    try { return loadAsset(rel); } catch (e) { return null; }
}

// در حالت توسعه تغییر فایل‌ها بدون ری‌استارت دیده شود
if (process.env.NODE_ENV !== 'production') {
    try {
        fs.watch(ROOT, (_e, filename) => { if (filename) cache.delete(filename); });
        fs.watch(path.join(ROOT, 'fonts'), (_e, f) => { if (f) cache.delete('fonts/' + f); });
    } catch (e) {}
}

const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const rel = ROUTES[url];

    if (!rel) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>۴۰۴</title>' +
                '<h1>۴۰۴، صفحه پیدا نشد</h1><p><a href="/">بازگشت به دل‌پلیر</a></p>');
        return;
    }

    const asset = getAsset(rel);
    if (!asset) {
        console.error('Missing asset: ' + rel);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server Error');
        return;
    }

    const headers = {
        'Content-Type': asset.type,
        'ETag': asset.etag,
        'Cache-Control': asset.immutable
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
    };

    if (req.headers['if-none-match'] === asset.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
    }

    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = (asset.gzip && acceptsGzip) ? asset.gzip : asset.body;
    if (asset.gzip && acceptsGzip) {
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
});

// --- ۳. سرور WebSocket ---
const wss = new WebSocket.Server({ server });

function noop() {}
function heartbeat() { this.isAlive = true; }

function breakPair(id) {
    const other = partners.get(id);
    if (!other) return;
    partners.delete(id);
    if (partners.get(other) === id) partners.delete(other);
    const otherWs = clients.get(other);
    if (otherWs && otherWs.readyState === WebSocket.OPEN) {
        otherWs.send(JSON.stringify({ type: 'peer_gone', id: id }));
    }
}

wss.on('connection', function connection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    const ip = clientIp(req);
    const count = ipConnections.get(ip) || 0;
    if (count >= MAX_CONNECTIONS_PER_IP) {
        console.warn('Connection rejected from ' + ip + ': too many connections.');
        ws.close(1013, 'too many connections');
        return;
    }
    ipConnections.set(ip, count + 1);

    let userId = null;
    const normalTimes = [];
    const syncTimes = [];

    ws.on('message', function incoming(raw) {
        const text = raw.toString();
        if (text.length > MAX_MESSAGE_LENGTH) return;

        let data;
        try { data = JSON.parse(text); } catch (e) { return; }
        if (!data || typeof data !== 'object') return;

        const inner = data.data;
        const isSyncish = data.type === 'signal' && inner && typeof inner === 'object' &&
            (inner.type === 'tick' || inner.type === 'control' || inner.type === 'ping' || inner.type === 'pong');
        const bucket = isSyncish ? syncTimes : normalTimes;
        const limit = isSyncish ? MAX_SYNC_PER_SECOND : MAX_MESSAGES_PER_SECOND;
        const now = Date.now();
        while (bucket.length && bucket[0] < now - 1000) bucket.shift();
        if (bucket.length >= limit) {
            console.warn('Rate limit exceeded for ' + (userId || ip));
            ws.close(1008, 'rate limit');
            return;
        }
        bucket.push(now);

        // ---- شناسه را سرور می‌دهد تا دو نفر هم‌زمان یک شناسه نگیرند ----
        if (data.type === 'hello') {
            if (userId) return;
            const wanted = typeof data.id === 'string' ? data.id.toLowerCase() : null;
            const valid = !!wanted && wanted.length === ID_LENGTH &&
                wanted.split('').every((c) => ID_ALPHABET.indexOf(c) !== -1);
            userId = (valid && !clients.has(wanted)) ? wanted : uniqueId();
            clients.set(userId, ws);
            ws.send(JSON.stringify({ type: 'welcome', id: userId }));
            console.log('Client connected: ' + userId + ' (' + ip + ')');
            return;
        }

        if (!userId) return;

        if (data.type === 'signal' && typeof data.to === 'string' && inner && typeof inner === 'object') {
            const to = data.to.toLowerCase();
            if (to === userId) return;

            const kind = inner.type;
            // دعوت و پاسخ‌های آن به هر شناسه‌ای مجاز است؛ باقی پیام‌ها فقط به
            // طرف مقابلِ تأییدشده می‌روند تا کسی نتواند در جلسهٔ دیگران پیام بفرستد.
            const isHandshake = kind === 'connect_request' || kind === 'connect_confirm' ||
                kind === 'busy' || kind === 'reconnect_request' || kind === 'reconnect_confirm';
            if (!isHandshake && partners.get(userId) !== to) return;

            const target = clients.get(to);
            if (!target || target.readyState !== WebSocket.OPEN) {
                if (kind === 'connect_request') {
                    ws.send(JSON.stringify({ type: 'signal', from: to, data: { type: 'no_such_peer' } }));
                }
                return;
            }

            // جفت‌شدن با تأیید گیرندهٔ دعوت قطعی می‌شود. پس از رفرش، سوکت قبلی
            // بسته شده و جفت از بین رفته است، پس reconnect_confirm هم باید
            // دوباره جفت را برقرار کند وگرنه پیام‌های همگام‌سازی رد می‌شوند.
            if (kind === 'connect_confirm' || kind === 'reconnect_confirm') {
                if (partners.get(userId) !== to) { breakPair(userId); breakPair(to); }
                partners.set(userId, to);
                partners.set(to, userId);
            } else if (kind === 'disconnect') {
                breakPair(userId);
            }

            target.send(JSON.stringify({ type: 'signal', from: userId, data: inner }));
        }
    });

    ws.on('close', function () {
        const current = ipConnections.get(ip) || 0;
        if (current <= 1) ipConnections.delete(ip);
        else ipConnections.set(ip, current - 1);

        if (userId && clients.get(userId) === ws) {
            breakPair(userId);
            clients.delete(userId);
            console.log('Client disconnected: ' + userId);
        }
    });

    ws.on('error', function (error) {
        console.error('WebSocket error:', error.message);
    });
});

const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(noop);
    });
}, 30000);

wss.on('close', function close() { clearInterval(interval); });

server.listen(port, () => {
    console.log('HTTP server is running on http://localhost:' + port);
    console.log('TRUST_PROXY=' + (TRUST_PROXY ? 'on' : 'off') + '. DelPlayer is ready.');
});
