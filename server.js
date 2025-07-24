const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// پورت سرور ما. هم HTTP و هم WebSocket از این پورت استفاده خواهند کرد.
const port = process.env.PORT || 8080;

// --- ۱. ساخت وب‌سرور HTTP ---
// این سرور به درخواست‌های صفحات وب پاسخ می‌دهد.
const server = http.createServer((req, res) => {
    // ما فقط می‌خواهیم فایل index.html را سرویس دهیم.
    // هر درخواستی به سرور این فایل را دریافت خواهد کرد.
    const filePath = path.join(__dirname, 'index.html');

    fs.readFile(filePath, (err, content) => {
        if (err) {
            // اگر خطایی رخ دهد (مثلاً فایل پیدا نشود)، خطای 500 ارسال می‌شود.
            console.error('Error reading index.html:', err);
            res.writeHead(500);
            res.end('Server Error: Could not load index.html');
            return;
        }

        // اگر فایل با موفقیت خوانده شد، آن را به مرورگر ارسال می‌کنیم.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
    });
});

// --- ۲. ساخت سرور WebSocket ---
// ما سرور WebSocket را به سرور HTTP موجود خود متصل می‌کنیم.
// این کار به آن‌ها اجازه می‌دهد از یک آدرس IP و پورت مشترک استفاده کنند.
const wss = new WebSocket.Server({ server });

let clients = {};

// منطق WebSocket دقیقاً مانند قبل باقی می‌ماند.
wss.on('connection', function connection(ws) {
    let userId = null;

    ws.on('message', function incoming(message) {
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
        } else if (data.type === 'unregister' && data.id) {
            if (clients[data.id]) {
                delete clients[data.id];
                console.log(`Client unregistered with ID: ${data.id}`);
            }
            // اگر کاربر خودش را unregister کرد، userId را هم null کن
            if (userId === data.id) {
                userId = null;
            }
        } else if (data.type === 'signal' && data.to && clients[data.to]) {
            // سیگنال را به کلاینت صحیح ارسال می‌کند
            clients[data.to].send(JSON.stringify({ ...data, from: userId }));
        }
    });

    ws.on('close', function() {
        if (userId && clients[userId]) {
            // کلاینت را هنگام قطع اتصال حذف می‌کند
            delete clients[userId];
            console.log(`Client with ID: ${userId} disconnected.`);
        }
    });

    ws.on('error', function(error) {
        console.error('WebSocket error:', error);
    });
});


// --- ۳. شروع به کار سرور ---
// این دستور سرور HTTP را راه‌اندازی می‌کند و از آنجایی که سرور WebSocket به آن متصل است،
// آن هم شروع به گوش دادن به اتصالات می‌کند.
server.listen(port, () => {
    console.log(`HTTP server is running on http://localhost:${port}`);
    console.log('DelPlayer is ready. Users can now connect via a URL.');
});
