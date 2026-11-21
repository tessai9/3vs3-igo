import { test } from "node:test";
import assert from "node:assert/strict";
import { BLACK, WHITE, Game } from "../src/shared/game.ts";
import { cpuMove } from "../src/shared/cpu.ts";
import { Room } from "../src/shared/room.ts";
import type { RoomView, ServerMsg } from "../src/shared/protocol.ts";

/** "x,y" 形式で黒白交互に打つ。"pass" も可 */
function playSeq(g: Game, seq: string[]) {
  for (const s of seq) {
    if (s === "pass") g.pass();
    else {
      const [x, y] = s.split(",").map(Number);
      const r = g.play(g.idx(x, y));
      assert.ok(r.ok, `${s}: ${!r.ok && r.reason}`);
    }
  }
}

test("石を囲むと取れる", () => {
  const g = new Game(9);
  // 黒が(1,1)の白を4方向から囲む
  playSeq(g, ["1,0", "1,1", "0,1", "8,8", "2,1", "8,7", "1,2"]);
  assert.equal(g.board[g.idx(1, 1)], 0);
  assert.equal(g.captures[BLACK], 1);
});

test("自殺手は打てない", () => {
  const g = new Game(9);
  playSeq(g, ["1,0", "8,8", "0,1", "8,7"]);
  const r = g.play(g.idx(0, 0) + 0); // 黒番: (0,0)は黒に囲まれているので黒は打てる
  assert.ok(r.ok);
  g.pass(); // 白番を流す
  const g2 = new Game(9);
  playSeq(g2, ["1,0", "pass", "0,1"]);
  const r2 = g2.play(g2.idx(0, 0)); // 白番: 自殺
  assert.deepEqual(r2, { ok: false, reason: "suicide" });
});

test("コウはすぐに取り返せない", () => {
  const g = new Game(9);
  // 典型的なコウの形
  playSeq(g, ["1,0", "2,0", "0,1", "3,1", "1,2", "2,2", "2,1", "1,1"]);
  // 白(1,1)が黒(2,1)を取った
  assert.equal(g.board[g.idx(2, 1)], 0);
  const r = g.play(g.idx(2, 1));
  assert.deepEqual(r, { ok: false, reason: "ko" });
});

test("連続パスで終局し、面積計算できる", () => {
  const g = new Game(9);
  // 黒が x=4 の縦線、白が x=5 の縦線
  const seq: string[] = [];
  for (let y = 0; y < 9; y++) seq.push(`4,${y}`, `5,${y}`);
  playSeq(g, seq);
  g.pass();
  g.pass();
  assert.ok(g.ended);
  const s = g.score();
  assert.equal(s.black, 45);
  assert.equal(s.white, 36);
  assert.equal(s.winner, BLACK); // 45 > 36 + 7
});

test("CPU同士で終局まで打ち切れる", () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const g = new Game(9);
  for (let i = 0; i < 400 && !g.ended; i++) {
    const p = cpuMove(g, rand);
    if (p === null) g.pass();
    else assert.ok(g.play(p).ok);
  }
  assert.ok(g.ended, "400手以内に終局する");
});

test("部屋: 黒1→白1→黒2→白2→黒3→白3 の順で回る", () => {
  const r = new Room("t");
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => r.turnSeat(i)), [0, 3, 1, 4, 2, 5, 0, 3]);
});

test("部屋: 手番でない人は打てず、ピンは自チームにだけ見える", () => {
  const r = new Room("t", { cpuDelayMs: 1_000_000 });
  const last: Record<string, RoomView> = {};
  const errors: Record<string, string[]> = { a: [], b: [], c: [] };
  for (const id of ["a", "b", "c"]) {
    r.join(id, (m: ServerMsg) => (m.t === "state" ? (last[id] = m.room) : errors[id].push(m.message)));
  }
  r.handle("a", { t: "sit", seat: 0 }); // 黒1
  r.handle("b", { t: "sit", seat: 1 }); // 黒2
  r.handle("c", { t: "sit", seat: 3 }); // 白1
  r.handle("a", { t: "start", size: 9 });
  r.handle("b", { t: "move", point: 40 });
  assert.equal(errors.b.at(-1), "あなたの手番ではありません");
  r.handle("b", { t: "pin", point: 40 });
  assert.deepEqual(last.a.pins, [{ point: 40, by: "ゲスト" }]);
  assert.deepEqual(last.c.pins, []);
  r.handle("a", { t: "move", point: 40 });
  assert.equal(last.c.board[40], BLACK);
  assert.deepEqual(last.a.pins, [], "着手でピンは消える");
  assert.equal(last.c.turnSeat, 3);
  r.handle("c", { t: "move", point: 41 });
  assert.equal(last.a.board[41], WHITE);
  assert.equal(last.a.turnSeat, 1);
  r.dispose();
});
