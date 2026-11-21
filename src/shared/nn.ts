// KataGo のネットワーク(ONNX化したもの)を使うCPU。推論そのものは呼び出し側が渡す(ブラウザでは onnxruntime-web)。
// ここには「盤面→入力特徴」「出力→着手」「軽いMCTS」だけを置き、UI・通信・ランタイムに依存しないようにしている。
import { Game, WHITE, opponent, type Color } from "./game.js";

export const NUM_SPATIAL = 22;
export const NUM_GLOBAL = 19;

/** onnxruntime などで1局面を推論する関数。入力は KataGo V7 形式(NCHW) */
export type RawNet = (bin: Float32Array, global: Float32Array, size: number) => Promise<RawOutput>;

export interface RawOutput {
  /** 着手ロジット(size*size + パス) */
  policy: Float32Array;
  /** 勝ち/負け/無勝負 のロジット(手番側から) */
  value: Float32Array;
  /** 手番側から見た所有(-1〜1) */
  ownership: Float32Array;
}

export interface NetOutput {
  /** 合法手に正規化した着手確率(size*size + パス)。非合法手は0 */
  policy: Float32Array;
  /** 手番側の勝率(0〜1) */
  winrate: number;
  /** 手番側から見た所有(-1〜1) */
  ownership: Float32Array;
}

// ---- 入力特徴 ----

/** KataGo の fillRowV7 に合わせた入力を作る。シチョウ(14-17)と1眼の確定地(18,19)は省略 */
export function encode(game: Game): { bin: Float32Array; global: Float32Array } {
  const n = game.size;
  const area = n * n;
  const bin = new Float32Array(NUM_SPATIAL * area);
  const global = new Float32Array(NUM_GLOBAL);
  const pla = game.toPlay;
  const opp = opponent(pla);
  const set = (f: number, p: number) => (bin[f * area + p] = 1);

  const libsSeen = new Map<number, number>();
  for (let p = 0; p < area; p++) {
    set(0, p);
    const c = game.board[p];
    if (c === 0) continue;
    set(c === pla ? 1 : 2, p);
    let libs = libsSeen.get(p);
    if (libs === undefined) {
      const g = game.group(game.board, p);
      libs = g.liberties.size;
      for (const s of g.stones) libsSeen.set(s, libs);
    }
    if (libs >= 1 && libs <= 3) set(2 + libs, p);
  }

  // コウで打てない点
  if (!game.ended) {
    for (let p = 0; p < area; p++) {
      if (game.board[p] !== 0) continue;
      const r = game.tryPlay(p);
      if (!r.ok && r.reason === "ko") set(6, p);
    }
  }

  // 直近5手(相手→自分→相手…の順)
  const ms = game.moves;
  for (let k = 1; k <= 5 && k <= ms.length; k++) {
    const m = ms[ms.length - k];
    if (m.color !== (k % 2 === 1 ? opp : pla)) break;
    if (m.point === null) global[k - 1] = 1;
    else set(8 + k, m.point);
  }

  // コミ。このゲームは同点なら白勝ちなので、ネットには +0.5 して渡す
  const komi = Number.isInteger(game.komi) ? game.komi + 0.5 : game.komi;
  const selfKomi = pla === WHITE ? komi : -komi;
  global[5] = selfKomi / 20;
  // 単純コウ・自殺手禁止・面積計算・税なし → 6〜13 は0
  // 直前がパスなら、パスで終局する
  if (ms.length > 0 && ms[ms.length - 1].point === null) global[14] = 1;
  // コミの偶奇の波(KataGo と同じ式)
  const drawableEven = area % 2 === 0;
  const floor = drawableEven ? Math.floor(selfKomi / 2) * 2 : Math.floor((selfKomi - 1) / 2) * 2 + 1;
  const delta = Math.min(2, Math.max(0, selfKomi - floor));
  global[18] = delta < 0.5 ? delta : delta < 1.5 ? 1 - delta : delta - 2;
  return { bin, global };
}

// ---- 対称変換(8通り)。推論ごとにランダムに回して、癖を散らす ----

function symIndex(sym: number, n: number, p: number): number {
  let x = p % n;
  let y = Math.floor(p / n);
  if (sym & 1) x = n - 1 - x;
  if (sym & 2) y = n - 1 - y;
  if (sym & 4) [x, y] = [y, x];
  return y * n + x;
}

function transformBin(bin: Float32Array, n: number, sym: number): Float32Array {
  if (sym === 0) return bin;
  const area = n * n;
  const out = new Float32Array(bin.length);
  for (let f = 0; f < NUM_SPATIAL; f++) {
    const o = f * area;
    for (let p = 0; p < area; p++) out[o + symIndex(sym, n, p)] = bin[o + p];
  }
  return out;
}

/** 合法手マスク(パス含む) */
function legalMask(game: Game): Uint8Array {
  const area = game.size * game.size;
  const mask = new Uint8Array(area + 1);
  for (let p = 0; p < area; p++) if (game.board[p] === 0 && game.tryPlay(p).ok) mask[p] = 1;
  mask[area] = 1;
  return mask;
}

/** RawNet をくるんで、対称変換・softmax・合法手マスクをかけた評価関数にする */
export function makeEvaluator(raw: RawNet, rand: () => number = Math.random) {
  return async (game: Game): Promise<NetOutput> => {
    const n = game.size;
    const area = n * n;
    const sym = Math.floor(rand() * 8);
    const { bin, global } = encode(game);
    const out = await raw(transformBin(bin, n, sym), global, n);
    const mask = legalMask(game);
    const logits = new Float32Array(area + 1);
    const ownership = new Float32Array(area);
    for (let p = 0; p < area; p++) {
      const q = symIndex(sym, n, p);
      logits[p] = out.policy[q];
      ownership[p] = out.ownership[q];
    }
    logits[area] = out.policy[area];
    let max = -Infinity;
    for (let i = 0; i <= area; i++) if (mask[i] && logits[i] > max) max = logits[i];
    const policy = new Float32Array(area + 1);
    let sum = 0;
    for (let i = 0; i <= area; i++) if (mask[i]) sum += policy[i] = Math.exp(logits[i] - max);
    for (let i = 0; i <= area; i++) policy[i] /= sum;
    const v = out.value;
    const vm = Math.max(v[0], v[1], v[2]);
    const [ew, el, en] = [Math.exp(v[0] - vm), Math.exp(v[1] - vm), Math.exp(v[2] - vm)];
    const winrate = (ew + 0.5 * en) / (ew + el + en);
    return { policy, winrate, ownership };
  };
}

export type Evaluator = ReturnType<typeof makeEvaluator>;

// ---- 軽いMCTS(PUCT) ----

interface Node {
  /** この局面で手番の人から見た価値の合計(勝率 0〜1) */
  w: number;
  n: number;
  moves: number[]; // -1 = パス
  priors: number[];
  children: (Node | null)[];
  /** 終局していれば、手番側から見た結果(1/0) */
  terminal?: number;
}

export interface SearchOptions {
  /** 最大の評価回数(1ならポリシーだけで打つ) */
  maxVisits?: number;
  /** 考える時間の上限(ミリ秒) */
  timeMs?: number;
  rand?: () => number;
}

export interface SearchResult {
  /** null はパス */
  move: number | null;
  visits: number;
  /** 手番側の勝率の見込み */
  winrate: number;
}

const CPUCT = 1.1;
const PRIOR_CUTOFF = 0.001;

function makeNode(game: Game, ev: NetOutput): Node {
  const area = game.size * game.size;
  const moves: number[] = [];
  const priors: number[] = [];
  for (let i = 0; i <= area; i++) {
    if (ev.policy[i] < PRIOR_CUTOFF && i !== area) continue;
    moves.push(i === area ? -1 : i);
    priors.push(ev.policy[i]);
  }
  return { w: ev.winrate, n: 1, moves, priors, children: moves.map(() => null) };
}

function terminalValue(game: Game): number {
  const s = game.score();
  return s.winner === game.toPlay ? 1 : 0;
}

function play(game: Game, m: number) {
  if (m < 0) game.pass();
  else game.play(m);
}

function selectChild(node: Node): number {
  const sqrtN = Math.sqrt(node.n);
  const parentQ = node.w / node.n;
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < node.moves.length; i++) {
    const c = node.children[i];
    // 子の価値は相手目線なので反転。未訪問は親より少し悪いと見なす(FPU)
    const q = c ? 1 - c.w / c.n : parentQ - 0.2;
    const u = CPUCT * node.priors[i] * sqrtN / (1 + (c ? c.n : 0));
    if (q + u > bestScore) {
      bestScore = q + u;
      best = i;
    }
  }
  return best;
}

/** パスしても損をしないか。面積計算で死に石を抜かないルールなので、ネットの読みと盤面の数え方が合うまではパスしない */
export function safeToPass(game: Game, ownership: Float32Array): boolean {
  const pla = game.toPlay;
  const tt = game.score().ownership;
  for (let p = 0; p < tt.length; p++) {
    const own = ownership[p]; // 手番側から見た所有
    const nnOwner: Color | 0 = own > 0.6 ? pla : own < -0.6 ? opponent(pla) : 0;
    if (nnOwner !== 0 && tt[p] !== nnOwner) return false;
  }
  return true;
}

export async function search(game: Game, evaluate: Evaluator, opts: SearchOptions = {}): Promise<SearchResult> {
  const maxVisits = opts.maxVisits ?? 200;
  const deadline = performance.now() + (opts.timeMs ?? 800);
  const rand = opts.rand ?? Math.random;
  const rootEval = await evaluate(game);
  const root = makeNode(game, rootEval);
  const passIdx = root.moves.indexOf(-1);
  const passOk = safeToPass(game, rootEval.ownership);
  if (!passOk && root.moves.length > 1) {
    // パスを候補から外す
    root.moves.splice(passIdx, 1);
    root.priors.splice(passIdx, 1);
    root.children.splice(passIdx, 1);
    const s = root.priors.reduce((a, b) => a + b, 0);
    root.priors = root.priors.map((p) => p / s);
  }

  let visits = 1;
  while (visits < maxVisits && performance.now() < deadline) {
    const g = game.clone();
    const path: Node[] = [root];
    let node = root;
    let leafValue: number; // 葉の局面で、手番側から見た価値
    for (;;) {
      if (node.terminal !== undefined) {
        leafValue = node.terminal;
        break;
      }
      const i = selectChild(node);
      play(g, node.moves[i]);
      const child = node.children[i];
      if (child) {
        node = child;
        path.push(node);
        continue;
      }
      let created: Node;
      if (g.ended) {
        const t = terminalValue(g);
        created = { w: t, n: 1, moves: [], priors: [], children: [], terminal: t };
      } else {
        created = makeNode(g, await evaluate(g));
      }
      node.children[i] = created;
      path.push(created);
      leafValue = created.w;
      break;
    }
    // 逆伝播(葉自身は作成時に n=1 を数えてある)
    let v = leafValue;
    for (let k = path.length - 2; k >= 0; k--) {
      v = 1 - v;
      path[k].n += 1;
      path[k].w += v;
    }
    visits++;
  }

  // 一番多く訪問した手。同数なら事前確率の高い方。序盤は少しばらつかせる
  let bestI = 0;
  if (game.moves.length < 4) {
    bestI = sampleByPrior(root, 1.0, rand);
  } else {
    let bestKey = -Infinity;
    for (let i = 0; i < root.moves.length; i++) {
      const key = (root.children[i]?.n ?? 0) + root.priors[i] * 0.5;
      if (key > bestKey) {
        bestKey = key;
        bestI = i;
      }
    }
  }
  const m = root.moves[bestI];
  return { move: m < 0 ? null : m, visits, winrate: root.w / root.n };
}

/** 事前確率から温度つきで選ぶ(確率の小さい手は除外) */
function sampleByPrior(root: Node, temperature: number, rand: () => number): number {
  const top = Math.max(...root.priors);
  const ws = root.priors.map((p) => (p >= top * 0.25 ? Math.pow(p, 1 / temperature) : 0));
  let r = rand() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ws.length; i++) {
    r -= ws[i];
    if (r <= 0) return i;
  }
  return ws.indexOf(Math.max(...ws));
}
