// 対局部屋の Durable Object。既存の Room クラス(src/shared/room.ts)を包むだけ。
// 1部屋 = 1インスタンスなので、手番・30秒タイマーの判定はここが唯一の正になる。
//
// 守り:
// - 部屋の状態(盤面・席・結果)を変化のたびにストレージへ保存し、デプロイやインスタンスの入れ替えで
//   消えても、次に誰かが繋いだときに復元して続きから打てる
// - 対局中の席には、座ったときの token を持つ人しか戻れない(同名での乗っ取りを防ぐ)
// - 1部屋の接続数・1接続のメッセージ量と大きさに上限を設ける
// - 最後の変化から ROOM_TTL_MS たったら、アラームで部屋の保存データを消す
import { DurableObject } from "cloudflare:workers";
import { Room, type RoomSnapshot } from "../../src/shared/room.js";
import { cleanName } from "../../src/shared/names.js";
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
/** 最後に状態が変わってから、保存データを消すまで */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** 1部屋に同時に繋げる数(6席 + 観戦・二重タブの余裕) */
export const MAX_SOCKETS = 16;
/** 1接続あたり: この時間窓でこの数を超えたら切断 */
export const MSG_WINDOW_MS = 10_000;
export const MSG_LIMIT = 60;
/** 1メッセージの最大バイト数(正規の操作は100バイト未満) */
export const MSG_MAX_BYTES = 1024;

export class GameRoomDO extends DurableObject<Env> {
  private room: Room | null = null;
  private init: Init | null = null;
  /** token → いま接続中の playerId */
  private online = new Map<string, string>();
  private sockets = new Map<string, WebSocket>();
  private autostart: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private lastSaved = "";
  private alarmSetAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // インスタンスが入れ替わっていたら、保存しておいた部屋を復元してから接続を受け付ける
    ctx.blockConcurrencyWhile(async () => {
      const init = await ctx.storage.get<Init>("init");
      if (!init) return;
      this.init = init;
      this.room = this.newRoom(init.roomId);
      const snap = await ctx.storage.get<string>("snap");
      if (snap) {
        this.lastSaved = snap;
        this.room.restore(JSON.parse(snap) as RoomSnapshot);
        this.started = this.room.snapshot().status !== "waiting";
      }
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/init" && req.method === "POST") {
      // 招待コードが既存の部屋とたまたま重なったら、上書きせずに断る(呼び出し側で作り直す)
      if (this.init) return new Response("exists", { status: 409 });
      this.init = (await req.json()) as Init;
      await this.ctx.storage.put("init", this.init);
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      this.room = this.newRoom(this.init.roomId);
      if (this.init.mode === "match") this.autostart = setTimeout(() => this.start(), AUTOSTART_MS);
      return new Response("ok");
    }
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (!this.room || !this.init) return new Response("room not found", { status: 404 });
    if (this.sockets.size >= MAX_SOCKETS) return new Response("room is full", { status: 429 });

    const room = this.room;
    const init = this.init;
    let token = (url.searchParams.get("token") ?? "").slice(0, 64);
    let name = cleanName(url.searchParams.get("name"));
    let seat: number | null = null;
    if (init.mode === "match") {
      const t = init.tickets?.find((x) => x.token === token);
      if (!t) return new Response("invalid token", { status: 403 });
      name = t.name;
      seat = t.seat;
      // インスタンスが入れ替わって自動開始の予約が消えていたら、張り直す
      if (!this.started && !this.autostart) this.autostart = setTimeout(() => this.start(), AUTOSTART_MS);
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
    ws.send(JSON.stringify({ t: "session", token, name }));
    // token を key にして入る: 対局中に切断した席へは、同じ token でしか戻れない
    room.join(
      id,
      (m) => {
        try {
          ws.send(JSON.stringify(m));
        } catch {}
      },
      token,
    );
    room.handle(id, { t: "hello", name });
    if (seat !== null) room.handle(id, { t: "sit", seat });
    if (init.mode === "match" && init.tickets && this.online.size >= init.tickets.length) this.start();

    let windowStart = Date.now();
    let count = 0;
    ws.addEventListener("message", (e) => {
      const now = Date.now();
      if (now - windowStart > MSG_WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      if (++count > MSG_LIMIT) return ws.close(1008, "too many messages");
      const data = typeof e.data === "string" ? e.data : "";
      if (!data || data.length > MSG_MAX_BYTES) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || typeof (msg as { t?: unknown }).t !== "string") return;
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

  /** 最後の変化から ROOM_TTL_MS たった部屋は消す(まだ誰か繋いでいれば延長) */
  async alarm() {
    if (this.sockets.size > 0) return void (await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS));
    this.room?.dispose();
    this.room = null;
    this.init = null;
    await this.ctx.storage.deleteAll();
  }

  private newRoom(roomId: string) {
    return new Room(roomId, {
      cpuDelayMs: Number(this.env.CPU_DELAY_MS ?? 700),
      moveSeconds: Number(this.env.MOVE_SECONDS ?? 30),
      onChange: () => this.save(),
    });
  }

  /** 盤面・席・結果が変わったときだけ書く(ピンや秒読みだけの変化では書かない) */
  private save() {
    if (!this.room) return;
    const s = JSON.stringify(this.room.snapshot());
    if (s === this.lastSaved) return;
    this.lastSaved = s;
    void this.ctx.storage.put("snap", s);
    // アラームの張り直しも書き込みに数えられるので、1時間に1回まで(無料枠の節約)
    const now = Date.now();
    if (now - this.alarmSetAt > 60 * 60 * 1000) {
      this.alarmSetAt = now;
      void this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    }
  }

  private drop(id: string) {
    if (!this.sockets.has(id)) return;
    this.sockets.delete(id);
    this.room?.leave(id);
  }

  private start() {
    if (this.started || !this.room) return;
    this.started = true;
    if (this.autostart) clearTimeout(this.autostart);
    this.autostart = null;
    // Room の start は席に座っている人の操作として受け付けるので、誰か1人の名義で呼ぶ
    const anyone = [...this.online.values()][0];
    if (anyone) this.room.handle(anyone, { t: "start", size: 9 });
    else this.started = false; // 誰もいなければ、最初の人が来たときに開始する
  }
}
