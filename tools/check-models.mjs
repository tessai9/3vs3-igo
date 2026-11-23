// デプロイ前の確認: KataGo のネット(ONNX)が public/models/ に無いと、公開版の「CPUと打つ」が
// 簡易CPUにしかならないので、無ければ止める。作り方: pip install onnx numpy && npm run models
import { existsSync, statSync } from "node:fs";
const dir = new URL("../public/models/", import.meta.url);
const missing = ["b6c96.onnx", "b10c128.onnx"].filter((f) => {
  const p = new URL(f, dir);
  return !existsSync(p) || statSync(p).size < 1_000_000;
});
if (missing.length) {
  console.error(`public/models/ に ${missing.join(", ")} がありません。リポジトリ直下で npm run models を実行してください(要 pip install onnx numpy)`);
  process.exit(1);
}
