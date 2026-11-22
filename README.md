# 3vs3 囲碁 プロトタイプ

3人対3人のチーム戦で遊ぶ囲碁の、方向性を探るためのプロトタイプです。

## 動かし方

```sh
npm install
npm start
```

表示されたURL(`http://localhost:3000`)をブラウザで開きます。同じWi-Fiのスマホからは、表示される「同じWi-Fi」のURLで参加できます。
部屋を分けたいときは `?room=好きな名前` をURLの末尾に付けます(同じ部屋名の人が同じ盤で対局します)。

一人で試すときは、ブラウザのタブ(またはシークレットウィンドウ)を複数開いて別々の席に座ると、味方へのピンや手番の回り方を確認できます。

## オンラインで遊ぶ(Cloudflare Workers)

Cloudflare Workers + Durable Objects にデプロイしてあり、URLを開くとロビーからクイックマッチ・友達との部屋・CPU練習を選べます。
デプロイ手順や構成は [cloud/README.md](cloud/README.md)。

## スマホでさっと試す(GitHub Pages)

https://tessai9.github.io/3vs3-igo/ を開くと、サーバーなしでブラウザだけで動く「あなた + CPU5人」の対局になります。
main に push すると GitHub Actions で自動デプロイされます。ローカルでも `?local` を付けると同じモードになります。

## CPU を KataGo のネットにする(実験)

オフラインモード(GitHub Pages / `?local`)では、ヘッダーの「CPU」で空席CPUの中身を選べます。

| 選択肢 | 中身 | ダウンロード |
| --- | --- | --- |
| 簡易CPU | 従来のルールベース(`src/shared/cpu.ts`) | なし |
| AI 軽量 | KataGo g170 b6c96 + 軽いMCTS(最大64局面/0.7秒) | 約4MB + WASM |
| AI 標準(既定) | KataGo g170e b10c128 + 軽いMCTS(最大64局面/0.9秒) | 約12MB + WASM |

- ネットは [KataGo](https://github.com/lightvector/KataGo) のリポジトリにテスト用として同梱されている g170 世代のもの(MIT ライセンス)
- `tools/katago2onnx.py` で KataGo の `.bin.gz` を ONNX に変換し、[onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) の WASM 版で推論します(Worker 内・シングルスレッド)
- モデルや WASM が読めない・推論に失敗したときは、簡易CPUに自動で戻ります
- 面積計算で死に石を抜かないルールなので、ネットの形勢判断と盤面の数え方が食い違う間はパスしないようにしてあります
- URL に `?ai=b6` / `?ai=b10` / `?ai=simple` を付けても切り替えられます

ローカルで試すとき:

```sh
pip install onnx numpy
npm run models   # KataGo のネットを取ってきて public/models/ に ONNX を作る
npm start        # http://localhost:3000/?local
npm run ai-match -- 6 9   # ネット同士・簡易CPUとの対戦で強さと速さを測る
```

## ルール(プロトタイプ時点)

- 黒チーム3人・白チーム3人。打つ順番は 黒1→白1→黒2→白2→黒3→白3→黒1… のリレー方式
- チーム内の相談は「ピン」だけ。自分の番でないときに盤をタップすると、味方にだけ見えるピンが立ちます(誰かが打つと消える)。自分の番のときは「ピンを置く」ボタンで切り替え。PCでは右クリックでもピン
- 一手30秒。時間切れは自動でパス
- 9路(開始前に13路も選べる)。両チームが続けてパスすると終局、面積計算(コミ7目)で自動判定
- 死に石の判定はしないので、終局前に取り切る必要があります
- 空席はCPUが打ちます。対局中に切断した席もCPUが代わりに打ち、同じ名前で戻ると席に戻れます

## 構成

| 場所 | 内容 |
| --- | --- |
| `src/shared/game.ts` | 対局ロジック(石取り・自殺手・コウ・終局・面積計算)。UIや通信に依存しない |
| `src/shared/cpu.ts` | 空席用の簡易CPU |
| `src/shared/nn.ts` | KataGo ネット用の入力特徴・軽いMCTS(推論ランタイムには依存しない) |
| `src/client/nn-cpu.ts` | onnxruntime-web でネットを動かすCPU(失敗時は簡易CPU) |
| `tools/katago2onnx.py` | KataGo の `.bin.gz` → ONNX 変換 |
| `src/shared/protocol.ts` | クライアント⇔サーバーのメッセージ型 |
| `src/shared/room.ts` | 部屋・席・手番・秒読み・ピンの管理(サーバーとオフラインモードで共用) |
| `src/server/server.ts` | 静的ファイル配信 + WebSocket(`ws`) |
| `src/client/*.ts` | Web Components(`<go-app>` `<go-board>` `<team-panel>`)。フレームワークなし |

- `npm test` でロジックのテスト、`npm run typecheck` で型チェック
- `npm run dev` で変更を監視して自動再ビルド
- 環境変数: `PORT`(既定3000)、`CPU_DELAY_MS`(CPUの考慮時間、既定700)

## オンライン対戦(検討中)

Cloudflare Workers + Durable Objects でのマッチングの設計とスパイクは [docs/online-matchmaking.md](docs/online-matchmaking.md) と [cloud/](cloud/) を参照。
