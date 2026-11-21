// 対局ロジック。UI・通信から独立させ、後でアプリ版でもそのまま使えるようにする。

export type Color = 1 | 2; // 1 = 黒, 2 = 白
export type Cell = 0 | Color;

export const BLACK: Color = 1;
export const WHITE: Color = 2;
export const opponent = (c: Color): Color => (c === BLACK ? WHITE : BLACK);

export interface Move {
  color: Color;
  /** パスのときは null */
  point: number | null;
  captured: number[];
}

export type PlayResult =
  | { ok: true; move: Move }
  | { ok: false; reason: "occupied" | "suicide" | "ko" | "out_of_range" | "ended" };

export interface Score {
  black: number;
  white: number;
  komi: number;
  winner: Color;
  /** 各点の所属(0=どちらでもない) */
  ownership: Cell[];
}

export class Game {
  readonly size: number;
  readonly komi: number;
  board: Cell[];
  toPlay: Color = BLACK;
  moves: Move[] = [];
  captures: Record<Color, number> = { 1: 0, 2: 0 };
  ended = false;
  private prevBoard: string | null = null; // 単純コウ判定用(1手前の盤面)
  private neighborCache: number[][];

  constructor(size = 9, komi = 7) {
    this.size = size;
    this.komi = komi;
    this.board = new Array(size * size).fill(0);
    this.neighborCache = this.board.map((_, i) => this.computeNeighbors(i));
  }

  idx(x: number, y: number): number {
    return y * this.size + x;
  }

  xy(i: number): [number, number] {
    return [i % this.size, Math.floor(i / this.size)];
  }

  neighbors(i: number): number[] {
    return this.neighborCache[i];
  }

  private computeNeighbors(i: number): number[] {
    const [x, y] = this.xy(i);
    const n: number[] = [];
    if (x > 0) n.push(i - 1);
    if (x < this.size - 1) n.push(i + 1);
    if (y > 0) n.push(i - this.size);
    if (y < this.size - 1) n.push(i + this.size);
    return n;
  }

  /** 連(つながった石)とその呼吸点を返す */
  group(board: Cell[], i: number): { stones: number[]; liberties: Set<number> } {
    const color = board[i];
    const stones: number[] = [];
    const liberties = new Set<number>();
    const seen = new Set<number>([i]);
    const stack = [i];
    while (stack.length) {
      const p = stack.pop()!;
      stones.push(p);
      for (const n of this.neighbors(p)) {
        if (board[n] === 0) liberties.add(n);
        else if (board[n] === color && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return { stones, liberties };
  }

  /** 盤面を変えずに着手を試す */
  tryPlay(point: number, color: Color = this.toPlay): PlayResult & { board?: Cell[] } {
    if (this.ended) return { ok: false, reason: "ended" };
    if (point < 0 || point >= this.board.length) return { ok: false, reason: "out_of_range" };
    if (this.board[point] !== 0) return { ok: false, reason: "occupied" };
    const board = this.board.slice();
    board[point] = color;
    const captured: number[] = [];
    for (const n of this.neighbors(point)) {
      if (board[n] === opponent(color)) {
        const g = this.group(board, n);
        if (g.liberties.size === 0) {
          for (const s of g.stones) {
            board[s] = 0;
            captured.push(s);
          }
        }
      }
    }
    if (this.group(board, point).liberties.size === 0) return { ok: false, reason: "suicide" };
    if (this.prevBoard !== null && board.join("") === this.prevBoard) return { ok: false, reason: "ko" };
    return { ok: true, move: { color, point, captured }, board };
  }

  play(point: number): PlayResult {
    const r = this.tryPlay(point);
    if (!r.ok) return r;
    this.prevBoard = this.board.join("");
    this.board = r.board!;
    this.captures[r.move.color] += r.move.captured.length;
    this.moves.push(r.move);
    this.toPlay = opponent(this.toPlay);
    return { ok: true, move: r.move };
  }

  pass(): PlayResult {
    if (this.ended) return { ok: false, reason: "ended" };
    const move: Move = { color: this.toPlay, point: null, captured: [] };
    this.moves.push(move);
    this.prevBoard = this.board.join("");
    this.toPlay = opponent(this.toPlay);
    const n = this.moves.length;
    if (n >= 2 && this.moves[n - 1].point === null && this.moves[n - 2].point === null) {
      this.ended = true;
    }
    return { ok: true, move };
  }

  /** 面積計算(中国ルール): 盤上の石 + その色だけに囲まれた空点。死に石の判定はしない。 */
  score(): Score {
    const ownership: Cell[] = this.board.slice();
    const seen = new Set<number>();
    for (let i = 0; i < this.board.length; i++) {
      if (this.board[i] !== 0 || seen.has(i)) continue;
      const region: number[] = [];
      const borders = new Set<Cell>();
      const stack = [i];
      seen.add(i);
      while (stack.length) {
        const p = stack.pop()!;
        region.push(p);
        for (const n of this.neighbors(p)) {
          if (this.board[n] === 0) {
            if (!seen.has(n)) {
              seen.add(n);
              stack.push(n);
            }
          } else borders.add(this.board[n]);
        }
      }
      if (borders.size === 1) {
        const owner = [...borders][0];
        for (const p of region) ownership[p] = owner;
      }
    }
    const black = ownership.filter((c) => c === BLACK).length;
    const white = ownership.filter((c) => c === WHITE).length;
    return {
      black,
      white,
      komi: this.komi,
      winner: black > white + this.komi ? BLACK : WHITE,
      ownership,
    };
  }

  /** 自分の眼(四方が自分の石)かどうか。CPUが眼を潰さないために使う */
  isOwnEye(point: number, color: Color): boolean {
    return this.board[point] === 0 && this.neighbors(point).every((n) => this.board[n] === color);
  }
}
