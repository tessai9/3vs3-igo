// クイックマッチの待ち行列。通信やDurable Objectには依存しない純粋なロジック。
import { TEAM_SIZE } from "../../src/shared/protocol.js";

export const SEAT_COUNT = TEAM_SIZE * 2;

export interface Ticket {
  /** 部屋に入るときの合言葉。再接続にも使う */
  token: string;
  name: string;
  /** 0..5 (黒0,黒1,黒2,白0,白1,白2) */
  seat: number;
}

export interface Match {
  roomId: string;
  tickets: Ticket[];
}

interface Waiting {
  id: string;
  name: string;
  since: number;
}

export interface QueueOptions {
  /** 最初の人が並んでから、この時間で人が揃わなければCPUで埋めて開始 */
  waitMs: number;
  newId: () => string;
}

/** 黒0,白0,黒1,白1,黒2,白2 の順に詰めて、少人数でも両チームに人が分かれるようにする */
const FILL_ORDER = [0, 3, 1, 4, 2, 5];

export class MatchQueue {
  private waiting: Waiting[] = [];
  constructor(private opts: QueueOptions) {}

  get size() {
    return this.waiting.length;
  }

  enqueue(id: string, name: string, now: number) {
    if (this.waiting.some((w) => w.id === id)) return;
    this.waiting.push({ id, name, since: now });
  }

  remove(id: string) {
    this.waiting = this.waiting.filter((w) => w.id !== id);
  }

  /** 次に締め切りを判定すべき時刻(誰もいなければ null) */
  nextDeadline(): number | null {
    return this.waiting.length ? this.waiting[0].since + this.opts.waitMs : null;
  }

  /**
   * 成立した対局を取り出す。6人揃ったら即、そうでなければ先頭の人の待ち時間が
   * 過ぎた時点で、いる人だけで(残りはCPU)成立させる。
   * 返り値の Map は 待ち行列ID → チケット。
   */
  take(now: number): { match: Match; byId: Map<string, Ticket> }[] {
    const out: { match: Match; byId: Map<string, Ticket> }[] = [];
    while (this.waiting.length >= SEAT_COUNT || (this.waiting.length > 0 && now >= this.waiting[0].since + this.opts.waitMs)) {
      const group = this.waiting.splice(0, SEAT_COUNT);
      const names = uniqueNames(group.map((g) => g.name));
      const byId = new Map<string, Ticket>();
      const tickets = group.map((g, i) => {
        const t: Ticket = { token: this.opts.newId(), name: names[i], seat: FILL_ORDER[i] };
        byId.set(g.id, t);
        return t;
      });
      out.push({ match: { roomId: this.opts.newId(), tickets }, byId });
    }
    return out;
  }
}

/** 同じ名前がいると再接続時に席を取り違えるので、後ろに番号を付けて区別する */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const n = (raw || "ゲスト").slice(0, 14);
    const c = (seen.get(n) ?? 0) + 1;
    seen.set(n, c);
    return c === 1 ? n : `${n}${c}`;
  });
}

/** 招待コード: 読み間違えやすい文字(0/O, 1/I/L)を除いた6文字 */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function inviteCode(rand: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[rand(CODE_CHARS.length)];
  return s;
}
export const isInviteCode = (s: string) => /^[A-HJKMNP-Z2-9]{6}$/.test(s);
