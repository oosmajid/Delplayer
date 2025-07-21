require('dotenv').config();
const port = process.env.WS_PORT || 8080;
const host = process.env.WS_HOST || '0.0.0.0';

const WebSocket = require('ws');
const wss = new WebSocket.Server({ port, host });

let clients = {};

wss.on('connection', function connection(ws) {
    let userId = null;

    ws.on('message', function incoming(message) {
        let data = {};
        try { data = JSON.parse(message); } catch {}
        if (data.type === 'register') {
            userId = data.id;
            clients[userId] = ws;
            ws.send(JSON.stringify({ type: 'registered', id: userId }));
        } else if (data.type === 'signal' && data.to && clients[data.to]) {
            clients[data.to].send(JSON.stringify({ ...data, from: userId }));
        }
    });

    ws.on('close', function() {
        if (userId && clients[userId]) delete clients[userId];
    });
});

console.log('WebSocket server running on ws://localhost:8080');