// クライアント⇔サーバーのメッセージ定義
import type { Cell, Color } from "./game.js";

export const TEAM_SIZE = 3;
export const MOVE_SECONDS = 30;

export interface SeatView {
  color: Color;
  index: number; // チーム内の順番 0..2
  name: string;
  kind: "human" | "cpu";
  online: boolean;
}

export interface Pin {
  point: number;
  by: string;
}

export interface RoomView {
  roomId: string;
  status: "waiting" | "playing" | "ended";
  size: number;
  board: Cell[];
  seats: SeatView[]; // 黒0,黒1,黒2,白0,白1,白2
  /** 次に打つ席 (seats の添字) */
  turnSeat: number;
  /** 秒読みの締切(サーバー時刻ms) */
  deadline: number | null;
  serverNow: number;
  lastMove: { point: number | null; color: Color; seat: number } | null;
  moveCount: number;
  captures: { black: number; white: number };
  /** 自分のチームのピンだけが届く */
  pins: Pin[];
  you: { name: string; seat: number | null };
  result: null | {
    black: number;
    white: number;
    komi: number;
    winner: Color;
    ownership: Cell[];
    reason: "pass" | "resign";
  };
  log: string[];
}

export type ClientMsg =
  | { t: "hello"; name: string }
  | { t: "sit"; seat: number }
  | { t: "stand" }
  | { t: "start"; size: number }
  | { t: "move"; point: number }
  | { t: "pass" }
  | { t: "resign" }
  | { t: "pin"; point: number }
  | { t: "reset" };

export type ServerMsg = { t: "state"; room: RoomView } | { t: "error"; message: string };
