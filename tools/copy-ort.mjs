// onnxruntime-web の WASM 版を public/ort/ にコピーする(実行時に動的 import する)
import { copyFileSync, mkdirSync } from "node:fs";
const src = "node_modules/onnxruntime-web/dist/";
const dst = "public/ort/";
mkdirSync(dst, { recursive: true });
for (const f of ["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) copyFileSync(src + f, dst + f);
