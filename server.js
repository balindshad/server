const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// ── хранилище комнат ────────────────────────────────────────────────────────
const rooms    = new Map(); // roomCode → { host: ws, levelData: string, clients: Set<ws> }
const wsToRoom = new Map(); // ws → roomCode
const wsToName = new Map(); // ws → username

// ── утилиты ─────────────────────────────────────────────────────────────────
function generateRoomCode() {
    let code;
    do {
        code = String(Math.floor(1000 + Math.random() * 9000));
    } while (rooms.has(code));
    return code;
}

function send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function broadcastToRoom(roomCode, message, senderWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    for (const client of room.clients) {
        if (client !== senderWs) send(client, message);
    }
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
            console.log(`[Room ${roomCode}] Closed (host left or empty)`);
        } else {
            broadcastToRoom(roomCode, `CHAT|[Server] ${username} left.`);
            console.log(`[Room ${roomCode}] ${username} left (${room.clients.size} remaining)`);
        }
    }

    wsToRoom.delete(ws);
    wsToName.delete(ws);
}

// ── обработка подключений ────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
    const ip = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress;
    console.log(`[+] Connected: ${ip}`);

    ws.on("message", (raw) => {
        const data  = raw.toString();
        const first = data.indexOf("|");
        const cmd   = first === -1 ? data : data.substring(0, first);
        const rest  = first === -1 ? ""   : data.substring(first + 1);

        // ── HOST|username|levelData ────────────────────────────────────────
        if (cmd === "HOST") {
            const sep      = rest.indexOf("|");
            const username = sep === -1 ? rest  : rest.substring(0, sep);
            const levelData = sep === -1 ? ""   : rest.substring(sep + 1);

            const roomCode = generateRoomCode();
            wsToName.set(ws, username);
            wsToRoom.set(ws, roomCode);
            rooms.set(roomCode, { host: ws, levelData, clients: new Set([ws]) });

            send(ws, `HOST_OK|${roomCode}`);
            console.log(`[Room ${roomCode}] Created by ${username}`);
        }

        // ── JOIN|username|roomCode ─────────────────────────────────────────
        else if (cmd === "JOIN") {
            const parts    = rest.split("|");
            const username = parts[0] ?? "Guest";
            const roomCode = parts[1] ?? "";
            const room     = rooms.get(roomCode);

            if (!room) {
                send(ws, "ERROR|Room not found");
                return;
            }

            wsToName.set(ws, username);
            wsToRoom.set(ws, roomCode);
            room.clients.add(ws);

            send(ws, `JOIN_OK|${roomCode}|${room.levelData}`);
            broadcastToRoom(roomCode, `CHAT|[Server] ${username} joined!`, ws);
            console.log(`[Room ${roomCode}] ${username} joined (${room.clients.size} total)`);
        }

        // ── ACTION|... ────────────────────────────────────────────────────
        else if (cmd === "ACTION") {
            const roomCode = wsToRoom.get(ws);
            if (roomCode) broadcastToRoom(roomCode, `ACTION|${rest}`, ws);
        }

        // ── CHAT|message ──────────────────────────────────────────────────
        else if (cmd === "CHAT") {
            const roomCode = wsToRoom.get(ws);
            const username = wsToName.get(ws) ?? "Guest";
            if (roomCode) broadcastToRoom(roomCode, `CHAT|${username}: ${rest}`, ws);
        }
    });

    ws.on("close", () => {
        console.log(`[-] Disconnected: ${ip}`);
        leaveRoom(ws);
    });

    ws.on("error", (err) => {
        console.error(`[!] Error from ${ip}:`, err.message);
        leaveRoom(ws);
    });
});

// ── healthcheck для Railway ───────────────────────────────────────────────────
const http = require("http");
http.createServer((req, res) => {
    if (req.url === "/health") {
        const stats = {
            rooms:   rooms.size,
            clients: wsToRoom.size,
            uptime:  process.uptime(),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats));
    } else {
        res.writeHead(200);
        res.end("GD Editor Collab Relay — OK");
    }
}).listen(PORT + 1, () => {
    console.log(`HTTP healthcheck on port ${PORT + 1}`);
});

console.log(`WebSocket relay started on port ${PORT}`);
console.log(`Waiting for connections...`);
