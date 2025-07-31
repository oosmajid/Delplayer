const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const port = process.env.PORT || 8080;

// --- ۱. تنظیمات امنیتی ---
const MAX_CONNECTIONS_PER_IP = 5;
const MAX_MESSAGES_PER_SECOND = 10;
const MAX_MESSAGE_LENGTH = 1024; // 1KB

const ipConnections = new Map();
const messageTimestamps = new WeakMap();

// --- ۲. ساخت وب‌سرور HTTP ---
const server = http.createServer((req, res) => {
    // --- SEO & Routing Changes (START) ---
    let filePath;
    let contentType = 'text/html; charset=utf-8';

    if (req.url === '/') {
        filePath = path.join(__dirname, 'index.html');
    } else if (req.url === '/robots.txt') {
        filePath = path.join(__dirname, 'robots.txt');
        contentType = 'text/plain';
    } else if (req.url === '/sitemap.xml') {
        filePath = path.join(__dirname, 'sitemap.xml');
        contentType = 'application/xml';
    } else {
        // For any other URL, send a 404 Not Found error
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 - صفحه مورد نظر یافت نشد</h1>');
        return;
    }
    // --- SEO & Routing Changes (END) ---

    fs.readFile(filePath, (err, content) => {
        if (err) {
            // If even the requested file (like index.html) is not found, send a 500 error
            console.error(`Error reading ${filePath}:`, err);
            res.writeHead(500);
            res.end(`Server Error: Could not load ${path.basename(filePath)}`);
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
});


// --- ۳. ساخت سرور WebSocket ---
const wss = new WebSocket.Server({ server });

let clients = {};

wss.on('connection', function connection(ws, req) {
    const ip = req.socket.remoteAddress;
    const connectionCount = ipConnections.get(ip) || 0;

    if (connectionCount >= MAX_CONNECTIONS_PER_IP) {
        console.warn(`Connection rejected from ${ip}: Too many connections.`);
        ws.close();
        return;
    }
    ipConnections.set(ip, connectionCount + 1);
    console.log(`New connection from ${ip}. Total connections from this IP: ${connectionCount + 1}`);

    let userId = null;
    messageTimestamps.set(ws, []);

    ws.on('message', function incoming(message) {
        let data = {};
        try {
            const messageString = message.toString();
            if (messageString.length > MAX_MESSAGE_LENGTH) {
                console.warn(`Message from ${userId} rejected: Too long.`);
                return;
            }
            data = JSON.parse(messageString);
        } catch (e) {
            console.log('Invalid JSON received:', message);
            return;
        }
        
        const isSyncMessage = data.type === 'signal' && data.data && data.data.type === 'sync';

        if (!isSyncMessage) {
            const now = Date.now();
            const timestamps = messageTimestamps.get(ws) || [];
            while (timestamps.length > 0 && timestamps[0] < now - 1000) {
                timestamps.shift();
            }
            if (timestamps.length >= MAX_MESSAGES_PER_SECOND) {
                console.warn(`Connection closed for user ${userId}: Message rate limit exceeded for non-sync message.`);
                ws.close();
                return;
            }
            timestamps.push(now);
            messageTimestamps.set(ws, timestamps);
        }

        if (data.type === 'signal' && data.data && data.data.type === 'chat' && data.data.message) {
            data.data.message = data.data.message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
            if (userId === data.id) {
                userId = null;
            }
        } else if (data.type === 'signal' && data.to && clients[data.to]) {
            clients[data.to].send(JSON.stringify({ ...data, from: userId }));
        }
    });

    ws.on('close', function() {
        const currentCount = ipConnections.get(ip) || 0;
        if (currentCount <= 1) {
            ipConnections.delete(ip);
            console.log(`Connection from ${ip} closed. IP entry removed.`);
        } else {
            ipConnections.set(ip, currentCount - 1);
            console.log(`Connection from ${ip} closed. Remaining connections: ${currentCount - 1}`);
        }

        if (userId && clients[userId]) {
            delete clients[userId];
            console.log(`Client with ID: ${userId} disconnected.`);
        }
    });

    ws.on('error', function(error) {
        console.error('WebSocket error:', error);
    });
});


// --- شروع به کار سرور ---
server.listen(port, () => {
    console.log(`HTTP server is running on http://localhost:${port}`);
    console.log('DelPlayer is ready. Users can now connect via a URL.');
});
