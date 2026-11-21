import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/shared/game.ts";
import { encode, makeEvaluator, search, NUM_SPATIAL, type RawNet } from "../src/shared/nn.ts";

// モデル無しで探索の配線を確かめるための、ほぼ一様なダミーネット
const fakeNet: RawNet = async (_bin, _global, n) => ({
  policy: new Float32Array(n * n + 1),
  value: new Float32Array([0, 0, -10]),
  ownership: new Float32Array(n * n),
});

test("入力特徴: 手番側の石・呼吸点・直前の手", () => {
  const g = new Game(9);
  g.play(g.idx(4, 4)); // 黒
  const { bin, global } = encode(g); // 白番
  const a = 81;
  assert.equal(bin.length, NUM_SPATIAL * a);
  const p = g.idx(4, 4);
  assert.equal(bin[0 * a + p], 1); // 盤上
  assert.equal(bin[2 * a + p], 1); // 相手(黒)の石
  assert.equal(bin[1 * a + p], 0);
  assert.equal(bin[9 * a + p], 1); // 直前の相手の手
  assert.equal(bin[3 * a + p] + bin[4 * a + p] + bin[5 * a + p], 0); // 呼吸点4なので 1〜3 の印は無し
  assert.ok(global[5] > 0); // 白から見たコミはプラス
});

test("探索は合法手かパスを返す", async () => {
  const g = new Game(9);
  const ev = makeEvaluator(fakeNet, () => 0.3);
  for (let i = 0; i < 6; i++) {
    const r = await search(g, ev, { maxVisits: 20, timeMs: 1000, rand: () => 0.3 });
    if (r.move === null) g.pass();
    else assert.ok(g.play(r.move).ok);
  }
});
