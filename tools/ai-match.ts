// ネットCPUの強さ・速さをざっくり測る: npx tsx tools/ai-match.ts [games] [size]
// 例) npx tsx tools/ai-match.ts 10 9
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { Game, BLACK, type Color } from "../src/shared/game.js";
import { cpuMove } from "../src/shared/cpu.js";
import { makeEvaluator, search, NUM_GLOBAL, NUM_SPATIAL, type RawNet } from "../src/shared/nn.js";

ort.env.wasm.numThreads = 1;

async function loadNet(file: string): Promise<RawNet> {
  const s = await ort.InferenceSession.create(readFileSync(file), { executionProviders: ["wasm"] });
  return async (bin, global, n) => {
    const r = await s.run({
      bin: new ort.Tensor("float32", bin, [1, NUM_SPATIAL, n, n]),
      global: new ort.Tensor("float32", global, [1, NUM_GLOBAL]),
    });
    return { policy: r.policy.data as Float32Array, value: r.value.data as Float32Array, ownership: r.ownership.data as Float32Array };
  };
}

type Player = { name: string; move: (g: Game) => Promise<number | null> };

const games = Number(process.argv[2] ?? 6);
const size = Number(process.argv[3] ?? 9);
const b6 = makeEvaluator(await loadNet("public/models/b6c96.onnx"));
const b10 = makeEvaluator(await loadNet("public/models/b10c128.onnx"));

let evals = 0;
let evalMs = 0;
const timed = (ev: typeof b6): typeof b6 => async (g) => {
  const t = performance.now();
  const r = await ev(g);
  evals++;
  evalMs += performance.now() - t;
  return r;
};

const players: Record<string, Player> = {
  heuristic: { name: "簡易CPU", move: async (g) => cpuMove(g) },
  b6p: { name: "b6 ポリシーのみ", move: async (g) => (await search(g, timed(b6), { maxVisits: 1 })).move },
  b10p: { name: "b10 ポリシーのみ", move: async (g) => (await search(g, timed(b10), { maxVisits: 1 })).move },
  b10m32: { name: "b10 32探索", move: async (g) => (await search(g, timed(b10), { maxVisits: 32, timeMs: 1e9 })).move },
};

async function playGame(black: Player, white: Player): Promise<{ winner: Color; moves: number; margin: number }> {
  const g = new Game(size, 7);
  while (!g.ended && g.moves.length < size * size * 3) {
    const p = await (g.toPlay === BLACK ? black : white).move(g);
    if (p === null) g.pass();
    else if (!g.play(p).ok) g.pass();
  }
  const s = g.score();
  return { winner: s.winner, moves: g.moves.length, margin: s.black - s.white - s.komi };
}

async function match(a: string, b: string) {
  let aWins = 0;
  const margins: number[] = [];
  const lens: number[] = [];
  for (let i = 0; i < games; i++) {
    const aBlack = i % 2 === 0;
    const r = await playGame(aBlack ? players[a] : players[b], aBlack ? players[b] : players[a]);
    if ((r.winner === BLACK) === aBlack) aWins++;
    margins.push(aBlack ? r.margin : -r.margin);
    lens.push(r.moves);
  }
  console.log(`${players[a].name} vs ${players[b].name}: ${aWins}-${games - aWins}  (${players[a].name}側から見た差: ${margins.map((m) => m.toFixed(0)).join(",")}) 手数: ${lens.join(",")}`);
}

const pairs = (process.env.PAIRS ?? "b6p:heuristic,b10p:heuristic,b10p:b6p,b10m32:b10p").split(",");
for (const pr of pairs) {
  const [a, b] = pr.split(":");
  await match(a, b);
}
console.log(`推論 ${evals}回, 平均 ${(evalMs / Math.max(1, evals)).toFixed(1)}ms/回 (特徴量作成・後処理込み)`);

