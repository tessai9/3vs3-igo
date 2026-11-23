// Cloudflare Workers の入口。
//   GET  /api/queue?name=..        (WebSocket) クイックマッチの待ち行列に並ぶ
//   POST /api/rooms                フレンド部屋を作り、招待コードを返す
//   GET  /api/rooms/:id/ws?name=&token=   (WebSocket) 対局部屋に入る
// どの入口も、IPごとのレート制限(Workers Rate Limiting、無料プランで使える)をかける。
// 旧UI向けの自由部屋ルート /ws?room= は、誰でも部屋をいくらでも作れてしまうので廃止した。
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
  /** 部屋を作る回数の制限(IPごと) */
  CREATE_LIMITER?: RateLimit;
  /** WebSocket 接続の回数の制限(IPごと) */
  CONNECT_LIMITER?: RateLimit;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

const tooMany = () => json({ error: "too many requests" }, 429);

/** 制限に引っかかったら true。バインディングが無い環境(テストなど)では制限しない */
async function limited(limiter: RateLimit | undefined, req: Request): Promise<boolean> {
  if (!limiter) return false;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: ip });
  return !success;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isWs = req.headers.get("upgrade") === "websocket";
    if (isWs && (await limited(env.CONNECT_LIMITER, req))) return tooMany();
    if (url.pathname === "/api/queue") {
      // 待ち行列は1つの Durable Object にまとめる(カジュアル規模なら1つで足りる)
      return env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global")).fetch(req);
    }
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      if (await limited(env.CREATE_LIMITER, req)) return tooMany();
      for (let i = 0; i < 3; i++) {
        const code = inviteCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(`friend:${code}`));
        const r = await stub.fetch("https://room/init", { method: "POST", body: JSON.stringify({ mode: "friend", roomId: code }) });
        if (r.ok) return json({ code });
      }
      return json({ error: "could not create a room" }, 503);
    }
    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9-]{6,64})\/ws$/);
    if (m) {
      const id = m[1];
      const name = isInviteCode(id.toUpperCase()) ? `friend:${id.toUpperCase()}` : `match:${id}`;
      return env.ROOM.get(env.ROOM.idFromName(name)).fetch(req);
    }
    if (url.pathname === "/api/health") return json({ ok: true });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
