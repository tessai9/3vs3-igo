// 1つの対局部屋。通信手段には依存せず、send 関数を受け取るだけにしてある。
import { BLACK, WHITE, Game, type Color } from "./game.js";
import { cpuMove } from "./cpu.js";
import { cleanName } from "./names.js";
import { MOVE_SECONDS, TEAM_SIZE, type ClientMsg, type Pin, type RoomView, type ServerMsg } from "./protocol.js";

interface Player {
  id: string;
  /** 再接続で同じ席に戻るための合言葉(サーバーが発行した token)。無ければ名前で戻す */
  key: string | null;
  name: string;
  seat: number | null;
  send: (m: ServerMsg) => void;
}

interface Seat {
  playerId: string | null;
  name: string;
  /** 座った人の key。対局中に切断した席に戻れるのは同じ key の人だけ */
  key: string | null;
}

/** 部屋の状態を保存・復元するための形(ピンと秒読みは保存しない) */
export interface RoomSnapshot {
  v: 1;
  size: number;
  /** null はパス */
  moves: (number | null)[];
  status: RoomView["status"];
  result: RoomView["result"];
  log: string[];
  seats: { name: string; key: string | null }[];
}

/** 空席のCPU。null はパス。非同期でもよい(ブラウザのAIなど) */
export type CpuPlayer = (game: Game) => number | null | Promise<number | null>;

export interface RoomOptions {
  moveSeconds?: number;
  /** CPUが打つまでの最低待ち時間 */
  cpuDelayMs?: number;
  cpu?: CpuPlayer;
  /** 盤面・席・状態が変わるたびに呼ばれる(保存用) */
  onChange?: () => void;
}

const SEAT_COUNT = TEAM_SIZE * 2;
const emptySeat = (): Seat => ({ playerId: null, name: "", key: null });
const seatColor = (seat: number): Color => (seat < TEAM_SIZE ? BLACK : WHITE);
const colorName = (c: Color) => (c === BLACK ? "黒" : "白");

export class Room {
  readonly id: string;
  private players = new Map<string, Player>();
  private seats: Seat[] = Array.from({ length: SEAT_COUNT }, () => emptySeat());
  private game = new Game(9);
  private status: RoomView["status"] = "waiting";
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cpuTimer: ReturnType<typeof setTimeout> | null = null;
  private pins: Record<Color, Map<string, Pin>> = { 1: new Map(), 2: new Map() };
  private result: RoomView["result"] = null;
  private log: string[] = [];
  private readonly moveMs: number;
  private readonly cpuDelayMs: number;
  private readonly cpu: CpuPlayer;
  private readonly onChange: (() => void) | undefined;

  constructor(id: string, opts: RoomOptions = {}) {
    this.id = id;
    this.moveMs = (opts.moveSeconds ?? MOVE_SECONDS) * 1000;
    this.cpuDelayMs = opts.cpuDelayMs ?? 700;
    this.cpu = opts.cpu ?? ((g) => cpuMove(g));
    this.onChange = opts.onChange;
  }

  get playerCount() {
    return this.players.size;
  }

  /** 何手目かから、打つ席を決める(黒1→白1→黒2→白2→黒3→白3→…) */
  turnSeat(moveIndex = this.game.moves.length): number {
    const color: Color = moveIndex % 2 === 0 ? BLACK : WHITE;
    const order = Math.floor(moveIndex / 2) % TEAM_SIZE;
    return (color === BLACK ? 0 : TEAM_SIZE) + order;
  }

  join(id: string, send: (m: ServerMsg) => void, key: string | null = null) {
    this.players.set(id, { id, key, name: "ゲスト", seat: null, send });
  }

  leave(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.seat !== null) {
      const seat = this.seats[p.seat];
      seat.playerId = null;
      if (this.status === "waiting") this.seats[p.seat] = emptySeat();
      else this.addLog(`${seat.name} さんが切断しました(CPUが代打ちします)`);
    }
    this.afterChange();
  }

  handle(id: string, msg: ClientMsg) {
    const p = this.players.get(id);
    if (!p) return;
    const err = (message: string) => p.send({ t: "error", message });

    switch (msg.t) {
      case "hello": {
        p.name = cleanName(msg.name);
        // 対局中に切断した人が戻ってきたら席に戻す。key があれば key で、無ければ(ローカル版)名前で照合する
        if (this.status !== "waiting" && p.seat === null) {
          const i = this.seats.findIndex((s) => s.playerId === null && !!s.name && (p.key ? s.key === p.key : s.key === null && s.name === p.name));
          if (i >= 0) {
            this.seats[i].playerId = id;
            p.seat = i;
            this.addLog(`${this.seats[i].name} さんが戻りました`);
          }
        }
        break;
      }
      case "sit": {
        if (this.status !== "waiting") return err("対局中は席を移れません");
        if (!(msg.seat >= 0 && msg.seat < SEAT_COUNT)) return err("その席はありません");
        if (this.seats[msg.seat].playerId) return err("その席は埋まっています");
        this.vacate(p);
        this.seats[msg.seat] = { playerId: id, name: p.name, key: p.key };
        p.seat = msg.seat;
        break;
      }
      case "stand": {
        if (this.status !== "waiting") return err("対局中は席を立てません");
        this.vacate(p);
        break;
      }
      case "start": {
        if (this.status === "playing") return err("すでに対局中です");
        if (p.seat === null) return err("席に座ってから開始してください");
        this.startGame(msg.size === 13 ? 13 : 9);
        break;
      }
      case "move":
      case "pass": {
        if (this.status !== "playing") return err("対局中ではありません");
        if (p.seat !== this.turnSeat()) return err("あなたの手番ではありません");
        if (msg.t === "pass") this.doPass(p.seat, false);
        else {
          const r = this.doMove(p.seat, msg.point);
          if (r) return err(r);
        }
        break;
      }
      case "resign": {
        if (this.status !== "playing" || p.seat === null) return;
        const c = seatColor(p.seat);
        this.addLog(`${p.name} さんが投了しました`);
        this.finish("resign", c === BLACK ? WHITE : BLACK);
        break;
      }
      case "pin": {
        if (p.seat === null) return err("席に座るとピンを置けます");
        if (this.status !== "playing") return;
        const team = this.pins[seatColor(p.seat)];
        const mine = team.get(id);
        if (mine && mine.point === msg.point) team.delete(id);
        else team.set(id, { point: msg.point, by: p.name });
        break;
      }
      case "reset": {
        this.stopTimers();
        this.status = "waiting";
        this.result = null;
        this.deadline = null;
        this.game = new Game(this.game.size);
        this.clearPins();
        // 切断済みの席は空ける
        this.seats = this.seats.map((s) => (s.playerId ? s : emptySeat()));
        this.addLog(`${p.name} さんが部屋をリセットしました`);
        break;
      }
    }
    this.afterChange();
  }

  private vacate(p: Player) {
    if (p.seat !== null) this.seats[p.seat] = emptySeat();
    p.seat = null;
  }

  private startGame(size: number) {
    this.stopTimers();
    this.game = new Game(size);
    this.status = "playing";
    this.result = null;
    this.clearPins();
    this.log = [];
    this.addLog(`${size}路で対局開始(コミ${this.game.komi}目、一手${this.moveMs / 1000}秒)`);
  }

  private seatName(seat: number) {
    return this.seats[seat].name || `CPU`;
  }

  /** エラーがあれば文言を返す */
  private doMove(seat: number, point: number): string | null {
    const r = this.game.play(point);
    if (!r.ok) {
      return { occupied: "そこには石があります", suicide: "自殺手は打てません", ko: "コウなのですぐには取り返せません", out_of_range: "盤の外です", ended: "終局しています" }[r.reason];
    }
    this.clearPins();
    if (r.move.captured.length) this.addLog(`${this.seatName(seat)}(${colorName(seatColor(seat))})が${r.move.captured.length}子取りました`);
    return null;
  }

  private doPass(seat: number, timeout: boolean) {
    this.game.pass();
    this.clearPins();
    this.addLog(`${this.seatName(seat)}(${colorName(seatColor(seat))})が${timeout ? "時間切れで" : ""}パス`);
    if (this.game.ended) this.finish("pass");
  }

  private finish(reason: "pass" | "resign", winner?: Color) {
    const s = this.game.score();
    this.game.ended = true;
    this.status = "ended";
    this.result = { black: s.black, white: s.white, komi: s.komi, winner: winner ?? s.winner, ownership: s.ownership, reason };
    const w = colorName(this.result.winner);
    this.addLog(reason === "pass" ? `終局: 黒${s.black} / 白${s.white}+${s.komi} で${w}チームの勝ち` : `${w}チームの中押し勝ち`);
    this.stopTimers();
    this.deadline = null;
  }

  /** 状態が変わるたびに呼ぶ: タイマー・CPUを進めて全員に配信 */
  private afterChange() {
    if (this.status === "playing") {
      if (this.players.size > 0) this.scheduleTurn();
      else {
        // 誰も見ていない部屋でCPU同士が打ち続けないよう止めておく(誰かが戻ったら再開)
        this.stopTimers();
        this.lastScheduled = "";
        this.deadline = null;
      }
    }
    this.broadcast();
    this.onChange?.();
  }

  /** 保存用の状態。DO が入れ替わっても対局を続けられるようにする */
  snapshot(): RoomSnapshot {
    return {
      v: 1,
      size: this.game.size,
      moves: this.game.moves.map((m) => m.point),
      status: this.status,
      result: this.result,
      log: this.log.slice(),
      seats: this.seats.map((s) => ({ name: s.name, key: s.key })),
    };
  }

  /** snapshot() から復元する。誰も接続していない状態に戻るので、人の席は戻ってくるまでCPUが打つ */
  restore(snap: RoomSnapshot) {
    if (snap.v !== 1) return;
    this.stopTimers();
    const game = new Game(snap.size === 13 ? 13 : 9);
    for (const pt of snap.moves) {
      const r = pt === null ? game.pass() : game.play(pt);
      if (!r.ok) break;
    }
    this.game = game;
    this.status = snap.status;
    this.result = snap.result;
    if (snap.status === "ended") game.ended = true;
    this.log = snap.log.slice(-50);
    this.seats = Array.from({ length: SEAT_COUNT }, (_, i) => ({ playerId: null, name: snap.seats[i]?.name ?? "", key: snap.seats[i]?.key ?? null }));
    // 待機中は席を空けておく(戻ってきた人が座り直す)
    if (this.status === "waiting") this.seats = this.seats.map(() => emptySeat());
    for (const p of this.players.values()) p.seat = null;
    this.clearPins();
    this.deadline = null;
    this.lastScheduled = "";
  }

  private lastScheduled = "";

  private scheduleTurn() {
    const moveIndex = this.game.moves.length;
    const seat = this.turnSeat();
    const human = !!this.seats[seat].playerId;
    // 同じ手番を二重に予約しない(打ち手が人⇔CPUで入れ替わったときは予約し直す)
    const key = `${moveIndex}:${human}`;
    if (this.lastScheduled === key) return;
    this.lastScheduled = key;
    this.stopTimers();
    if (human) {
      this.deadline = Date.now() + this.moveMs;
      this.timer = setTimeout(() => {
        if (this.status !== "playing" || this.game.moves.length !== moveIndex) return;
        this.doPass(seat, true);
        this.afterChange();
      }, this.moveMs);
    } else {
      this.deadline = null;
      const game = this.game;
      const stillMyTurn = () =>
        this.status === "playing" && this.game === game && game.moves.length === moveIndex && !this.seats[seat].playerId;
      // 考え始めるのはすぐ。打つのは最低 cpuDelayMs 待ってから(速すぎると人が追えないので)
      const started = Date.now();
      this.cpuTimer = setTimeout(async () => {
        if (!stillMyTurn()) return;
        let p: number | null;
        try {
          p = await this.cpu(game.clone());
        } catch {
          p = cpuMove(game);
        }
        const rest = this.cpuDelayMs - (Date.now() - started);
        if (rest > 0) await new Promise((r) => setTimeout(r, rest));
        // 考えている間に状況が変わっていたら捨てる
        if (!stillMyTurn()) return;
        if (p !== null && !game.tryPlay(p).ok) p = cpuMove(game);
        if (p === null) this.doPass(seat, false);
        else this.doMove(seat, p);
        this.afterChange();
      }, 0);
    }
  }

  private stopTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.cpuTimer) clearTimeout(this.cpuTimer);
    this.timer = this.cpuTimer = null;
    if (this.status !== "playing") this.lastScheduled = "";
  }

  /** 部屋を閉じるときに呼ぶ */
  dispose() {
    this.status = "waiting";
    this.stopTimers();
  }

  private clearPins() {
    this.pins[BLACK].clear();
    this.pins[WHITE].clear();
  }

  private addLog(s: string) {
    this.log.push(s);
    if (this.log.length > 50) this.log.shift();
  }

  view(forId: string): RoomView {
    const p = this.players.get(forId);
    const seat = p?.seat ?? null;
    const last = this.game.moves.at(-1);
    return {
      roomId: this.id,
      status: this.status,
      size: this.game.size,
      board: this.game.board.slice(),
      seats: this.seats.map((s, i) => ({
        color: seatColor(i),
        index: i % TEAM_SIZE,
        name: s.name || "CPU",
        kind: s.name ? "human" : "cpu",
        online: !!s.playerId,
      })),
      turnSeat: this.turnSeat(),
      deadline: this.deadline,
      serverNow: Date.now(),
      lastMove: last ? { point: last.point, color: last.color, seat: this.turnSeat(this.game.moves.length - 1) } : null,
      moveCount: this.game.moves.length,
      captures: { black: this.game.captures[BLACK], white: this.game.captures[WHITE] },
      pins: seat === null ? [] : [...this.pins[seatColor(seat)].values()],
      you: { name: p?.name ?? "", seat },
      result: this.result,
      log: this.log.slice(-12),
    };
  }

  private broadcast() {
    for (const p of this.players.values()) p.send({ t: "state", room: this.view(p.id) });
  }
}
