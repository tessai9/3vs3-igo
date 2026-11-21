// Cloudflare Workers の入口。
//   GET  /api/queue?name=..        (WebSocket) クイックマッチの待ち行列に並ぶ
//   POST /api/rooms                フレンド部屋を作り、招待コードを返す
//   GET  /api/rooms/:id/ws?name=&token=   (WebSocket) 対局部屋に入る
//   GET  /ws?room=..               (WebSocket) 既存クライアント用の互換ルート
// 対局の中身は既存の src/server/room.ts をそのまま Durable Object の中で動かす。
import { inviteCode, isInviteCode } from "./queue.js";
export { MatchmakerDO } from "./matchmaker-do.js";
export { GameRoomDO } from "./room-do.js";

export interface Env {
  MATCHMAKER: DurableObjectNamespace;
  ROOM: DurableObjectNamespace;
  /** 待ち時間(ms)。テストでは短くする */
  QUEUE_WAIT_MS?: string;
  CPU_DELAY_MS?: string;
  MOVE_SECONDS?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/queue") {
      // 待ち行列は1つの Durable Object にまとめる(カジュアル規模なら1つで足りる)
      return env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global")).fetch(req);
    }
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      const code = inviteCode();
      const stub = env.ROOM.get(env.ROOM.idFromName(`friend:${code}`));
      await stub.fetch("https://room/init", { method: "POST", body: JSON.stringify({ mode: "friend", roomId: code }) });
      return json({ code });
    }
    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9-]{6,64})\/ws$/);
    if (m) {
      const id = m[1];
      const name = isInviteCode(id.toUpperCase()) ? `friend:${id.toUpperCase()}` : `match:${id}`;
      return env.ROOM.get(env.ROOM.idFromName(name)).fetch(req);
    }
    if (url.pathname === "/ws") {
      // 既存クライアント(public/)をそのまま繋ぐための互換ルート: ?room=名前 ごとに自由部屋
      const room = (url.searchParams.get("room") || "lobby").slice(0, 32);
      return env.ROOM.get(env.ROOM.idFromName(`legacy:${room}`)).fetch(req);
    }
    if (url.pathname === "/api/health") return json({ ok: true });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
