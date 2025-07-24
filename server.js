const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// پورت سرور ما. هم HTTP و هم WebSocket از این پورت استفاده خواهند کرد.
const port = process.env.PORT || 8080;

// --- ۱. ساخت وب‌سرور HTTP ---
const server = http.createServer((req, res) => {
    const filePath = path.join(__dirname, 'index.html');

    fs.readFile(filePath, (err, content) => {
        if (err) {
            console.error('Error reading index.html:', err);
            res.writeHead(500);
            res.end('Server Error: Could not load index.html');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
    });
});

// --- ۲. ساخت سرور WebSocket ---
const wss = new WebSocket.Server({ server });

// --- منطق Rate Limiter ---
const ipRequestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 1000; // بازه زمانی: ۱ ثانیه
const RATE_LIMIT_MAX_REQUESTS = 10; // حداکثر درخواست در بازه زمانی

// --- شروع تغییر: پاکسازی دوره‌ای برای جلوگیری از نشت حافظه ---
const CLEANUP_INTERVAL_MS = 60 * 1000; // هر ۱ دقیقه

setInterval(() => {
    const now = Date.now();
    console.log(`Running cleanup for rate limiter map. Current size: ${ipRequestCounts.size}`);
    for (const [ip, data] of ipRequestCounts.entries()) {
        // اگر آخرین درخواست از یک IP بیش از ۱ دقیقه پیش بوده، آن را حذف می‌کنیم
        if (now - data.startTime > CLEANUP_INTERVAL_MS) {
            ipRequestCounts.delete(ip);
        }
    }
    console.log(`Cleanup finished. Map size is now: ${ipRequestCounts.size}`);
}, CLEANUP_INTERVAL_MS);
// --- پایان تغییر ---

let clients = {};

// برای دسترسی به IP، باید پارامتر 'req' را به این تابع اضافه کنیم
wss.on('connection', function connection(ws, req) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    let userId = null;

    ws.on('message', function incoming(message) {
        const now = Date.now();
        const clientData = ipRequestCounts.get(ip) || { count: 0, startTime: now };

        if (now - clientData.startTime > RATE_LIMIT_WINDOW_MS) {
            clientData.count = 1;
            clientData.startTime = now;
        } else {
            clientData.count++;
        }

        ipRequestCounts.set(ip, clientData);

        if (clientData.count > RATE_LIMIT_MAX_REQUESTS) {
            console.warn(`Rate limit exceeded for IP: ${ip}. Closing connection.`);
            ws.close();
            return;
        }

        let data = {};
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.log('Invalid JSON received:', message);
            return;
        }

        if (data.type === 'register' && data.id) {
            userId = data.id;
            clients[userId] = ws;
            console.log(`Client registered with ID: ${userId}`);
        } else if (data.type === 'signal' && data.to && clients[data.to]) {
            clients[data.to].send(JSON.stringify({ ...data, from: userId }));
        }
    });

    ws.on('close', function() {
        if (userId && clients[userId]) {
            delete clients[userId];
            console.log(`Client with ID: ${userId} disconnected.`);
        }
    });

    ws.on('error', function(error) {
        console.error('WebSocket error:', error);
    });
});


// --- ۳. شروع به کار سرور ---
server.listen(port, () => {
    console.log(`HTTP server is running on http://localhost:${port}`);
    console.log('DelPlayer is ready. Users can now connect via a URL.');
});
