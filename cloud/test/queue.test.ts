import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchQueue, inviteCode, isInviteCode, uniqueNames } from "../src/queue.ts";

let n = 0;
const q = () => new MatchQueue({ waitMs: 20_000, newId: () => `id${++n}` });

test("6人揃うと即マッチ、7人目は次に回る", () => {
  const m = q();
  for (let i = 0; i < 7; i++) m.enqueue(`p${i}`, `P${i}`, 1000);
  const r = m.take(1000);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].match.tickets.map((t) => t.seat).sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(m.size, 1);
});

test("待ち時間を過ぎたら少人数でもマッチし、黒白に分かれる", () => {
  const m = q();
  m.enqueue("a", "A", 0);
  m.enqueue("b", "B", 5000);
  assert.equal(m.take(19_999).length, 0);
  assert.equal(m.nextDeadline(), 20_000);
  const r = m.take(20_000);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].match.tickets.map((t) => t.seat), [0, 3]);
  assert.equal(m.nextDeadline(), null);
});

test("キャンセルした人は外れる", () => {
  const m = q();
  m.enqueue("a", "A", 0);
  m.remove("a");
  assert.equal(m.take(99_999).length, 0);
});

test("同名には番号が付く", () => {
  assert.deepEqual(uniqueNames(["たろう", "たろう", "", "ゲスト"]), ["たろう", "たろう2", "ゲスト", "ゲスト2"]);
});

test("招待コード", () => {
  for (let i = 0; i < 100; i++) assert.ok(isInviteCode(inviteCode()));
  assert.ok(!isInviteCode("ABC10O"));
});
