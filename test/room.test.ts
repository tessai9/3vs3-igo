import { test } from "node:test";
import assert from "node:assert/strict";
import { Room } from "../src/shared/room.ts";
import { cleanName, isNgName } from "../src/shared/names.ts";
import type { RoomView, ServerMsg } from "../src/shared/protocol.ts";

/** CPU は打たない(手番が回っても何もしない)部屋 */
function quietRoom(onChange?: () => void) {
  return new Room("t", { cpuDelayMs: 60_000, moveSeconds: 600, onChange });
}

function connect(room: Room, id: string, name: string, key: string | null = null) {
  let last: RoomView | null = null;
  const errors: string[] = [];
  room.join(id, (m: ServerMsg) => (m.t === "state" ? (last = m.room) : errors.push(m.message)), key);
  room.handle(id, { t: "hello", name });
  return { view: () => last!, errors };
}

test("対局中に切断した席には、同じ key の人だけが戻れる(同名の他人は戻れない)", () => {
  const room = quietRoom();
  connect(room, "a", "たろう", "key-a");
  room.handle("a", { t: "sit", seat: 0 });
  room.handle("a", { t: "start", size: 9 });
  room.leave("a");
  const thief = connect(room, "x", "たろう", "key-x");
  assert.equal(thief.view().you.seat, null, "同名でも key が違えば席は取れない");
  const back = connect(room, "a2", "たろう", "key-a");
  assert.equal(back.view().you.seat, 0);
  room.dispose();
});

test("key が無い(ローカル版)ときは従来どおり名前で戻れる。ただし key 付きの席には戻れない", () => {
  const room = quietRoom();
  connect(room, "a", "はなこ");
  connect(room, "b", "じろう", "key-b");
  room.handle("a", { t: "sit", seat: 0 });
  room.handle("b", { t: "sit", seat: 3 });
  room.handle("a", { t: "start", size: 9 });
  room.leave("a");
  room.leave("b");
  assert.equal(connect(room, "a2", "はなこ").view().you.seat, 0);
  assert.equal(connect(room, "b2", "じろう").view().you.seat, null);
  room.dispose();
});

test("snapshot から復元すると盤面・手番・席が戻り、人の席は key で取り戻せる", () => {
  let saved = 0;
  const room = quietRoom(() => saved++);
  connect(room, "a", "黒の人", "ka");
  connect(room, "b", "白の人", "kb");
  room.handle("a", { t: "sit", seat: 0 });
  room.handle("b", { t: "sit", seat: 3 });
  room.handle("a", { t: "start", size: 9 });
  room.handle("a", { t: "move", point: 40 });
  room.handle("b", { t: "move", point: 41 });
  assert.ok(saved > 0, "変化のたびに onChange が呼ばれる");
  const snap = JSON.parse(JSON.stringify(room.snapshot()));
  room.dispose();

  const r2 = quietRoom();
  r2.restore(snap);
  const b = connect(r2, "b2", "白の人", "kb");
  const v = b.view();
  assert.equal(v.status, "playing");
  assert.equal(v.moveCount, 2);
  assert.equal(v.board[40], 1);
  assert.equal(v.board[41], 2);
  assert.equal(v.you.seat, 3);
  assert.equal(v.seats[0].name, "黒の人");
  assert.equal(v.seats[0].online, false);
  r2.dispose();
});

test("終局後の snapshot も結果ごと戻る", () => {
  const room = quietRoom();
  connect(room, "a", "あ", "ka");
  room.handle("a", { t: "sit", seat: 0 });
  room.handle("a", { t: "start", size: 9 });
  room.handle("a", { t: "resign" });
  const r2 = quietRoom();
  r2.restore(room.snapshot());
  const v = connect(r2, "z", "見る人").view();
  assert.equal(v.status, "ended");
  assert.equal(v.result?.reason, "resign");
  room.dispose();
  r2.dispose();
});

test("名前: 制御文字や改行を除き、16文字に切り、NG語はゲストにする", () => {
  assert.equal(cleanName("  たろう\n​  "), "たろう");
  assert.equal(cleanName("あ".repeat(30)), "あ".repeat(16));
  assert.equal(cleanName(""), "ゲスト");
  assert.equal(cleanName(123), "ゲスト");
  assert.equal(cleanName("F.u.c.k"), "ゲスト");
  assert.equal(cleanName("シネ"), "ゲスト");
  assert.equal(cleanName("運営スタッフ"), "ゲスト");
  // 短い語は単独のときだけ弾く
  assert.equal(isNgName("ちょんまげ"), false);
  assert.equal(isNgName("がいじん"), false);
  assert.equal(isNgName("しねま"), false);
  assert.equal(isNgName("サセックス"), false);
});

test("hello の名前もフィルタされる", () => {
  const room = quietRoom();
  const c = connect(room, "a", "ちんこ");
  assert.equal(c.view().you.name, "ゲスト");
  room.dispose();
});

test("全員が抜けた部屋ではCPUが打ち続けず、誰かが戻ると再開する", async () => {
  const room = new Room("t", { cpuDelayMs: 0, moveSeconds: 600 });
  connect(room, "a", "あ", "ka");
  room.handle("a", { t: "sit", seat: 0 });
  room.handle("a", { t: "start", size: 9 });
  room.handle("a", { t: "move", point: 40 });
  room.leave("a");
  await new Promise((r) => setTimeout(r, 50));
  const v = connect(room, "a2", "あ", "ka");
  assert.equal(v.view().moveCount, 1, "誰もいない間は進まない");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(v.view().moveCount >= 2, "戻ったらCPUの手番が進む");
  room.dispose();
});
