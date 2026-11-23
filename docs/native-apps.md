# ネイティブアプリ(Android / iOS)

Web版(`public/`)を [Capacitor](https://capacitorjs.com/) 8 でそのまま包んでいます。フレームワークは増やしていません(Web Components のまま)。

- アプリID: `io.github.tessai9.go3v3`(ストアに出した後は変えられないので、変えるなら公開前に `capacitor.config.json` で)
- ページは端末内から読み込み、オンライン対戦の API と WebSocket は `https://go3v3.shimeji9.workers.dev` に繋ぐ(`src/client/config.ts`)
- KataGo のネットも同梱するので、「ひとりで練習」は通信なしでAI相手に遊べる
- 招待リンクは Web 版の URL(アプリを持っていない友達もブラウザで入れる)

## CI(GitHub Actions: `.github/workflows/native.yml`)

PR と main への push で次を実行し、成果物(Artifacts)に置きます。費用はかかりません(公開リポジトリなら macOS ランナーも無料)。

| ジョブ | 内容 | 成果物 |
| --- | --- | --- |
| Test & build web | 型チェック・テスト(本体と `cloud/`)、モデル変換、`npm run build` | `web` |
| Android | `cap sync` → `gradlew assembleDebug` | `go3v3-android-debug-apk`(署名はデバッグ鍵) |
| iOS | `cap sync` → `xcodebuild -sdk iphonesimulator`(署名なし) | `go3v3-ios-simulator-app`(シミュレータ専用) |

### 試し方

- **Android**: Actions の実行結果から `go3v3-android-debug-apk` をダウンロードし、zip の中の `app-debug.apk` を端末に入れる(「提供元不明のアプリ」を許可)
- **iOS シミュレータ**(Mac): zip を展開して `xcrun simctl install booted App.app` → `xcrun simctl launch booted io.github.tessai9.go3v3`
- **iPhone 実機**: 署名が必要。無料の Apple ID でも、Mac の Xcode で `npm run app:open:ios` → 自分の端末に入れられる(7日で失効)

### ローカルで

```sh
npm run app:sync      # Web をビルドして android/ ios/ にコピー
npm run app:android   # デバッグAPK(Android SDK + JDK 21 が必要)
npm run app:open:ios  # Xcode で開く(Mac のみ)
```

## ストアに出すときに本人の手が必要なもの

| | 費用 | 本人がやること |
| --- | --- | --- |
| Google Play | 登録料 25米ドル(1回だけ) | Play Console でデベロッパー登録(本人確認あり)。個人アカウントは**製品版の前に12人以上で14日間のクローズドテスト**が必要。アップロード鍵を作って GitHub Secrets に登録 |
| App Store | Apple Developer Program 年 99米ドル(日本では年 12,800円前後) | 登録(本人確認)。配布証明書とプロビジョニングプロファイル、または App Store Connect API キーを GitHub Secrets に登録 |
| 共通 | 0円 | プライバシーポリシーのURL(GitHub Pages に置ける)、アイコン・スクリーンショット、年齢区分・データ収集の申告 |

署名鍵やAPIキーをもらえれば、署名付きビルドとストアへのアップロード(Play の内部テスト / TestFlight)も CI に足せます。

## 本番公開に耐えるか(2026-11-23 時点の評価)

**結論: ストアに一般公開するにはまだ早い。友達や Play のクローズドテストで遊んでもらう段階には十分。**

公開前に直したいもの(優先順):

1. ~~対局状態が Durable Object のメモリにしか無い~~ → 2026-11-23 対応。盤面・席・結果を変化のたびに保存し、再起動後に復元する(24時間変化が無ければ削除)
2. ~~乱用への備えが無い~~ → 対応。IPごとのレート制限(部屋作成 10回/分、接続 120回/分)、1部屋16接続まで、1接続あたり10秒60メッセージ・1KBまで、待ち行列300人まで。自由部屋ルート `/ws` は廃止
3. ~~同名で入り直すと空いた席を取れる~~ → 対応。対局中の席には座ったときの token を持つ人しか戻れない
4. **ストア審査(ユーザー生成コンテンツ)**: 名前に最低限のNG語フィルタを入れた(`src/shared/names.ts`)。Apple のガイドライン 1.2 は通報・ブロックと連絡先も求めるので、ストア申請前に「この人を通報」と問い合わせ先を足す
5. **プライバシーポリシーと申告**が無い(集めているのは名前だけで、広告・トラッキングは無し)
6. **アイコン・スプラッシュが Capacitor の既定のまま**、見出しに「プロトタイプ」と出ている
7. ~~再接続がバックオフなし~~ → 対応。1.5秒から倍々で最大30秒、アプリが前面に戻ったら即再接続。アプリが裏にいる間に30秒過ぎると CPU が代打ちする(戻れば席に戻る)
8. ~~E2E が CI で回っていない~~ → 対応。CI で wrangler dev を立てて E2E と再起動後の復元テストを流す

残っている設計上の注意: 全員が抜けた部屋は対局を止めておき、誰かが戻ると再開する。WebSocket Hibernation は未使用(接続中は DO が起きたままなので、無料枠の「DO の稼働時間」を使う)。

良い点: 盤面・手番・時間の判定はサーバー(DO)が唯一の正で、クライアントからの不正な手は通らない。表示する名前はエスケープ済み。クイックマッチの席は推測できない token で守られている。
