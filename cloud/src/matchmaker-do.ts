// クイックマッチ用 Durable Object。並んでいる人のWebSocketを持ち、成立したら部屋と席を通知する。
import { DurableObject } from "cloudflare:workers";
import { MatchQueue } from "./queue.js";
import { cleanName } from "../../src/shared/names.js";
import type { Env } from "./worker.js";

export type QueueServerMsg =
  | { t: "queued"; position: number; waitMs: number }
  | { t: "matched"; roomId: string; token: string; seat: number; name: string; humans: number };

/** 待ち行列に同時に並べる上限(カジュアル規模の想定の十分上) */
const MAX_QUEUE = 300;

export class MatchmakerDO extends DurableObject<Env> {
  private queue: MatchQueue;
  private sockets = new Map<string, WebSocket>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly waitMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.waitMs = Number(env.QUEUE_WAIT_MS ?? 20_000);
    this.queue = new MatchQueue({ waitMs: this.waitMs, newId: () => crypto.randomUUID() });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (this.sockets.size >= MAX_QUEUE) return new Response("queue is full", { status: 503 });
    const name = cleanName(new URL(req.url).searchParams.get("name"));
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    const id = crypto.randomUUID();
    this.sockets.set(id, ws);
    this.queue.enqueue(id, name, Date.now());
    const drop = () => {
      this.sockets.delete(id);
      this.queue.remove(id);
      this.broadcast();
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
    this.broadcast();
    await this.tick();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private send(ws: WebSocket, m: QueueServerMsg) {
    try {
      ws.send(JSON.stringify(m));
    } catch {}
  }

  /** 並んでいる全員に、いま何人待っているかを知らせる */
  private broadcast() {
    const n = this.queue.size;
    for (const ws of this.sockets.values()) this.send(ws, { t: "queued", position: n, waitMs: this.waitMs });
  }

  private async tick() {
    for (const { match, byId } of this.queue.take(Date.now())) {
      // 先に部屋へ「誰がどの席か」を登録してから、各自に通知する
      const room = this.env.ROOM.get(this.env.ROOM.idFromName(`match:${match.roomId}`));
      await room.fetch("https://room/init", { method: "POST", body: JSON.stringify({ mode: "match", roomId: match.roomId, tickets: match.tickets }) });
      for (const [qid, t] of byId) {
        const ws = this.sockets.get(qid);
        if (!ws) continue;
        this.send(ws, { t: "matched", roomId: match.roomId, token: t.token, seat: t.seat, name: t.name, humans: match.tickets.length });
        this.sockets.delete(qid);
        ws.close(1000, "matched");
      }
    }
    this.broadcast();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const d = this.queue.nextDeadline();
    if (d !== null) this.timer = setTimeout(() => void this.tick(), Math.max(0, d - Date.now()) + 10);
  }
}
