import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { Room } from "../shared/room.js";
import type { ClientMsg } from "../shared/protocol.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = join(import.meta.dirname, "../../public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  if (path === "/" || !extname(path)) path = "/index.html";
  try {
    const body = await readFile(join(PUBLIC, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const rooms = new Map<string, Room>();
const wss = new WebSocketServer({ server: http, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://x");
  const roomId = (url.searchParams.get("room") || "lobby").slice(0, 32);
  let room = rooms.get(roomId);
  if (!room) rooms.set(roomId, (room = new Room(roomId, { cpuDelayMs: Number(process.env.CPU_DELAY_MS ?? 700) })));
  const id = randomUUID();
  room.join(id, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));

  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    room.handle(id, msg);
  });
  ws.on("close", () => {
    room.leave(id);
    if (room.playerCount === 0) {
      room.dispose();
      rooms.delete(roomId);
    }
  });
});

http.listen(PORT, () => {
  console.log(`\n  3vs3 囲碁プロトタイプ`);
  console.log(`  このPC:      http://localhost:${PORT}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) console.log(`  同じWi-Fi:   http://${a.address}:${PORT}`);
    }
  }
  console.log(`  部屋を分けるには末尾に ?room=好きな名前 を付けてください\n`);
});
