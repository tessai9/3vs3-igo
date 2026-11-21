// 空席を埋める簡易CPU。強さは求めず、「それっぽく」打って終局まで進められることだけが目的。
import { Game, opponent } from "./game.js";

/** 次の一手を返す。null ならパス */
export function cpuMove(game: Game, rand: () => number = Math.random): number | null {
  const color = game.toPlay;
  const opp = opponent(color);
  let best: number[] = [];
  let bestScore = -Infinity;

  for (let p = 0; p < game.board.length; p++) {
    if (game.board[p] !== 0 || game.isOwnEye(p, color)) continue;
    const r = game.tryPlay(p, color);
    if (!r.ok) continue;
    const after = r.board!;
    let s = rand() * 2; // 同点のばらつき

    // 取れるなら取る
    s += r.move.captured.length * 10;
    // 自分の連がアタリになる手は避ける
    const libs = game.group(after, p).liberties.size;
    if (libs === 1) s -= 8;
    else s += Math.min(libs, 4);
    // アタリの味方を助ける / 相手をアタリにする
    for (const n of game.neighbors(p)) {
      if (game.board[n] === color && game.group(game.board, n).liberties.size === 1) s += 6;
      if (after[n] === opp && game.group(after, n).liberties.size === 1) s += 3;
    }
    // 序盤は1線を避ける
    const [x, y] = game.xy(p);
    const edge = Math.min(x, y, game.size - 1 - x, game.size - 1 - y);
    if (edge === 0 && game.moves.length < game.size * 2) s -= 3;

    if (s > bestScore) {
      bestScore = s;
      best = [p];
    } else if (s === bestScore) best.push(p);
  }
  // 自殺に近い手しか無いときはパス
  if (best.length === 0 || bestScore < -5) return null;
  return best[Math.floor(rand() * best.length)];
}
