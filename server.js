const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = parseInt(process.env.PORT || "8080", 10);

// ── хранилище комнат ─────────────────────────────────────────────────────────
const rooms    = new Map();
const wsToRoom = new Map();
const wsToName = new Map();

function generateRoomCode() {
    let code;
    do { code = String(Math.floor(1000 + Math.random() * 9000)); }
    while (rooms.has(code));
    return code;
}

function send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function broadcastToRoom(roomCode, message, senderWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    for (const client of room.clients)
        if (client !== senderWs) send(client, message);
}

function leaveRoom(ws) {
    const roomCode = wsToRoom.get(ws);
    const username = wsToName.get(ws) ?? "Unknown";
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (room) {
        room.clients.delete(ws);
        if (room.host === ws || room.clients.size === 0) {
            broadcastToRoom(roomCode, "CHAT|[Server] Host left, room closed.");
            rooms.delete(roomCode);
            console.log(`[Room ${roomCode}] Closed`);
        } else {
            broadcastToRoom(roomCode, `CHAT|[Server] ${username} left.`);
        }
    }
    wsToRoom.delete(ws);
    wsToName.delete(ws);
}

// ── HTTP + WebSocket на одном порту ──────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    const stats = { rooms: rooms.size, clients: wsToRoom.size, uptime: Math.floor(process.uptime()) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
    const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress;
    console.log(`[+] ${ip}`);

    ws.on("message", (raw) => {
        const data  = raw.toString();
        const first = data.indexOf("|");
        const cmd   = first === -1 ? data : data.substring(0, first);
        const rest  = first === -1 ? ""   : data.substring(first + 1);

        if (cmd === "HOST") {
            const sep       = rest.indexOf("|");
            const username  = sep === -1 ? rest : rest.substring(0, sep);
            const levelData = sep === -1 ? ""   : rest.substring(sep + 1);
            const roomCode  = generateRoomCode();

            wsToName.set(ws, username);
            wsToRoom.set(ws, roomCode);
            rooms.set(roomCode, { host: ws, levelData, clients: new Set([ws]) });

            send(ws, `HOST_OK|${roomCode}`);
            console.log(`[Room ${roomCode}] Created by ${username}`);
        }
        else if (cmd === "JOIN") {
            const parts    = rest.split("|");
            const username = parts[0] ?? "Guest";
            const roomCode = parts[1] ?? "";
            const room     = rooms.get(roomCode);

            if (!room) { send(ws, "ERROR|Room not found"); return; }

            wsToName.set(ws, username);
            wsToRoom.set(ws, roomCode);
            room.clients.add(ws);

            send(ws, `JOIN_OK|${roomCode}|${room.levelData}`);
            broadcastToRoom(roomCode, `CHAT|[Server] ${username} joined!`, ws);
            console.log(`[Room ${roomCode}] ${username} joined (${room.clients.size} total)`);
        }
        else if (cmd === "ACTION") {
            const roomCode = wsToRoom.get(ws);
            if (roomCode) broadcastToRoom(roomCode, `ACTION|${rest}`, ws);
        }
        else if (cmd === "CHAT") {
            const roomCode = wsToRoom.get(ws);
            const username = wsToName.get(ws) ?? "Guest";
            if (roomCode) broadcastToRoom(roomCode, `CHAT|${username}: ${rest}`, ws);
        }
    });

    ws.on("close", () => { console.log(`[-] ${ip}`); leaveRoom(ws); });
    ws.on("error", (e) => { console.error(`[!] ${e.message}`); leaveRoom(ws); });
});

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`GD Collab Relay on port ${PORT}`);
});
