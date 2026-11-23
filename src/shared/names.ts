// プレイヤー名の正規化と、ほかの人に見せたくない名前のフィルタ。
// 完璧な検閲ではなく、よくある卑語・差別語・なりすましを弾く最低限のもの。

export const NAME_MAX = 16;
export const DEFAULT_NAME = "ゲスト";

// 比較用に正規化した形(NFKC・小文字・カタカナ→ひらがな・記号と空白を除去)で部分一致させる
const NG_WORDS = [
  // 運営・なりすまし
  "運営", "うんえい", "管理人", "かんりにん", "admin", "official", "公式", "こうしき", "moderator",
  // 英語の卑語・差別語
  "fuck", "shit", "bitch", "cunt", "dick", "pussy", "nigger", "nigga", "faggot", "retard", "porn", "sex",
  // 日本語の卑語・差別語・暴言
  "ちんこ", "ちんぽ", "まんこ", "おまんこ", "せっくす", "ふぇら", "れいぷ", "強姦", "ごうかん", "ぶっかけ",
  "しね", "死ね", "ころす", "殺す", "きちがい", "気違い", "池沼", "ちしょう", "がいじ", "害児",
  "かたわ", "めくら", "つんぼ", "えた", "ひにん", "非人", "ちょん", "しなじん", "支那人", "ちゃんころ",
];

const kataToHira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** 比較用の正規化 */
export const foldForMatch = (s: string): string =>
  kataToHira(s.normalize("NFKC").toLowerCase())
    .replace(/[\s\p{P}\p{S}_]/gu, "")
    // よくある置き換え(0→o, 1→i, 3→e, 4→a, 5→s, @→a)
    .replace(/[0134５5@]/g, (c) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "５": "s", "@": "a" })[c] ?? c);

const NG_FOLDED = NG_WORDS.map(foldForMatch);
// 「えた」「ちょん」「がいじ」などの短い語は、単独のときだけ弾く(「ちょんまげ」「がいじん」は通す)
const EXACT_ONLY = new Set(["せっくす", "えた", "ひにん", "ちょん", "sex", "dick", "しね", "ちしょう", "がいじ", "かたわ", "めくら"].map(foldForMatch));

export function isNgName(name: string): boolean {
  const f = foldForMatch(name);
  if (!f) return false;
  return NG_FOLDED.some((w) => (EXACT_ONLY.has(w) ? f === w : f.includes(w)));
}

/**
 * 表示用の名前に整える。制御文字・改行・ゼロ幅文字を除き、空白を詰めて最大16文字。
 * 空になったり NG 語を含んだりすれば fallback(既定は「ゲスト」)。
 */
export function cleanName(raw: unknown, fallback = DEFAULT_NAME): string {
  let s = typeof raw === "string" ? raw : "";
  s = s
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  s = [...s].slice(0, NAME_MAX).join("").trim();
  if (!s || isNgName(s)) return fallback;
  return s;
}
