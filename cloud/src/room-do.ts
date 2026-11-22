// 対局部屋の Durable Object。既存の Room クラス(src/server/room.ts)を包むだけ。
// 1部屋 = 1インスタンスなので、手番・30秒タイマーの判定はここが唯一の正になる。
import { DurableObject } from "cloudflare:workers";
import { Room } from "../../src/shared/room.js";
import type { ClientMsg } from "../../src/shared/protocol.js";
import type { Ticket } from "./queue.js";
import type { Env } from "./worker.js";

interface Init {
  mode: "match" | "friend";
  roomId: string;
  tickets?: Ticket[];
}

/** マッチ成立から、全員が揃わなくても開始するまでの猶予 */
const AUTOSTART_MS = 15_000;

export class GameRoomDO extends DurableObject<Env> {
  private room: Room | null = null;
  private init: Init | null = null;
  /** token → いま接続中の playerId */
  private online = new Map<string, string>();
  private sockets = new Map<string, WebSocket>();
  private autostart: ReturnType<typeof setTimeout> | null = null;

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/init" && req.method === "POST") {
      this.init = (await req.json()) as Init;
      // 誰も繋いでいない間にインスタンスが破棄されても部屋に入れるよう、部屋の設定だけ保存しておく
      await this.ctx.storage.put("init", this.init);
      this.room = this.newRoom(this.init.roomId);
      if (this.init.mode === "match") this.autostart = setTimeout(() => this.start(), AUTOSTART_MS);
      return new Response("ok");
    }
    if (!this.init) {
      const saved = await this.ctx.storage.get<Init>("init");
      if (saved) {
        this.init = saved;
        this.room = this.newRoom(saved.roomId);
      }
    }
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const legacy = url.pathname === "/ws";
    if (legacy && !this.room) {
      const roomId = (url.searchParams.get("room") || "lobby").slice(0, 32);
      this.init = { mode: "friend", roomId };
      this.room = this.newRoom(roomId);
    }
    if (!this.room || !this.init) return new Response("room not found", { status: 404 });

    const room = this.room;
    const init = this.init;
    let token = url.searchParams.get("token") ?? "";
    let name = (url.searchParams.get("name") ?? "ゲスト").slice(0, 16);
    let seat: number | null = null;
    if (init.mode === "match") {
      const t = init.tickets?.find((x) => x.token === token);
      if (!t) return new Response("invalid token", { status: 403 });
      name = t.name;
      seat = t.seat;
    } else if (!token) {
      token = crypto.randomUUID();
    }

    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();

    // 同じ token の古い接続が残っていたら閉じる(スマホのWi-Fi⇔4G切替など)
    const prev = this.online.get(token);
    if (prev) {
      this.sockets.get(prev)?.close(4000, "replaced");
      this.drop(prev);
    }

    const id = crypto.randomUUID();
    this.online.set(token, id);
    this.sockets.set(id, ws);
    // 既存クライアントは state/error 以外を知らないので session は送らない(名前は hello で届く)
    if (!legacy) ws.send(JSON.stringify({ t: "session", token, name }));
    room.join(id, (m) => {
      try {
        ws.send(JSON.stringify(m));
      } catch {}
    });
    // hello で名前を設定。対局中なら同名の空き席に戻る(既存の再接続ロジック)
    if (!legacy) room.handle(id, { t: "hello", name });
    if (seat !== null) room.handle(id, { t: "sit", seat });
    if (init.mode === "match" && init.tickets && [...this.online.keys()].length >= init.tickets.length) this.start();

    ws.addEventListener("message", (e) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      // クイックマッチでは席の移動・リセットはさせない
      if (init.mode === "match" && (msg.t === "sit" || msg.t === "stand" || msg.t === "reset" || msg.t === "start")) return;
      room.handle(id, msg);
    });
    const close = () => {
      if (this.online.get(token) === id) this.online.delete(token);
      this.drop(id);
    };
    ws.addEventListener("close", close);
    ws.addEventListener("error", close);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private newRoom(roomId: string) {
    return new Room(roomId, { cpuDelayMs: Number(this.env.CPU_DELAY_MS ?? 700), moveSeconds: Number(this.env.MOVE_SECONDS ?? 30) });
  }

  private drop(id: string) {
    if (!this.sockets.has(id)) return;
    this.sockets.delete(id);
    this.room?.leave(id);
  }

  private started = false;
  private start() {
    if (this.started || !this.room) return;
    this.started = true;
    if (this.autostart) clearTimeout(this.autostart);
    // Room の start は席に座っている人の操作として受け付けるので、誰か1人の名義で呼ぶ
    const anyone = [...this.online.values()][0];
    if (anyone) this.room.handle(anyone, { t: "start", size: 9 });
    else this.started = false; // 誰もいなければ、最初の人が来たときに開始する
  }
}
