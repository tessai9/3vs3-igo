// ブラウザでKataGoのネットを動かすCPU。onnxruntime-web(WASM)は使うときに初めて読み込む。
// 読み込みや推論に失敗したら、従来の簡易CPUに戻す。
import type * as Ort from "onnxruntime-web";
import { BLACK, type Game } from "../shared/game.js";
import { cpuMove } from "../shared/cpu.js";
import { makeEvaluator, search, NUM_GLOBAL, NUM_SPATIAL, type Evaluator, type RawNet } from "../shared/nn.js";

export type AiLevel = "simple" | "b6" | "b10";

export const AI_LEVELS: Record<AiLevel, { label: string; model?: string; maxVisits: number; timeMs: number }> = {
  simple: { label: "簡易CPU", maxVisits: 0, timeMs: 0 },
  b6: { label: "AI 軽量 (4MB)", model: "models/b6c96.onnx", maxVisits: 64, timeMs: 700 },
  b10: { label: "AI 標準 (12MB)", model: "models/b10c128.onnx", maxVisits: 64, timeMs: 900 },
};

let ortPromise: Promise<typeof Ort> | null = null;
function loadOrt(): Promise<typeof Ort> {
  ortPromise ??= (async () => {
    const base = new URL("./ort/", import.meta.url).href;
    const ort: typeof Ort = await import(/* @vite-ignore */ base + "ort.wasm.min.mjs");
    ort.env.wasm.wasmPaths = base;
    // GitHub Pages は cross-origin isolation が無いのでシングルスレッド。推論は Worker に逃がして画面を止めない
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = true;
    return ort;
  })();
  return ortPromise;
}

const evaluators = new Map<string, Promise<Evaluator>>();
function loadEvaluator(model: string): Promise<Evaluator> {
  let p = evaluators.get(model);
  if (!p) {
    p = (async () => {
      const ort = await loadOrt();
      const session = await ort.InferenceSession.create(new URL(`./${model}`, import.meta.url).href, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      const raw: RawNet = async (bin, global, n) => {
        const r = await session.run({
          bin: new ort.Tensor("float32", bin, [1, NUM_SPATIAL, n, n]),
          global: new ort.Tensor("float32", global, [1, NUM_GLOBAL]),
        });
        return {
          policy: r.policy.data as Float32Array,
          value: r.value.data as Float32Array,
          ownership: r.ownership.data as Float32Array,
        };
      };
      return makeEvaluator(raw);
    })();
    // 失敗したら次回また試せるようにする
    p.catch(() => evaluators.delete(model));
    evaluators.set(model, p);
  }
  return p;
}

export interface AiStatus {
  level: AiLevel;
  state: "idle" | "loading" | "ready" | "fallback";
  detail?: string;
}

/** Room に渡すCPU。level は後から切り替えられる */
export class NnCpu {
  level: AiLevel;
  status: AiStatus;
  onStatus: (s: AiStatus) => void = () => {};
  /** 直近の一手の情報(表示用) */
  last: { visits: number; ms: number; blackWinrate: number } | null = null;

  constructor(level: AiLevel) {
    this.level = level;
    this.status = { level, state: "idle" };
  }

  private setStatus(s: AiStatus) {
    this.status = s;
    this.onStatus(s);
  }

  /** 先にモデルを読み込んでおく */
  async preload() {
    const conf = AI_LEVELS[this.level];
    if (!conf.model) return this.setStatus({ level: this.level, state: "ready" });
    const level = this.level;
    this.setStatus({ level, state: "loading" });
    try {
      await loadEvaluator(conf.model);
      if (this.level === level) this.setStatus({ level, state: "ready" });
    } catch (e) {
      console.warn("AIモデルを読み込めませんでした。簡易CPUで打ちます", e);
      if (this.level === level) this.setStatus({ level, state: "fallback", detail: String(e) });
    }
  }

  move = async (game: Game): Promise<number | null> => {
    const conf = AI_LEVELS[this.level];
    if (!conf.model || this.status.state === "fallback") return cpuMove(game);
    try {
      const ev = await loadEvaluator(conf.model);
      const t = performance.now();
      const r = await search(game.clone(), ev, { maxVisits: conf.maxVisits, timeMs: conf.timeMs });
      const blackWinrate = game.toPlay === BLACK ? r.winrate : 1 - r.winrate;
      this.last = { visits: r.visits, ms: Math.round(performance.now() - t), blackWinrate };
      return r.move;
    } catch (e) {
      console.warn("AIの推論に失敗しました。簡易CPUで打ちます", e);
      this.setStatus({ level: this.level, state: "fallback", detail: String(e) });
      return cpuMove(game);
    }
  };
}
