# オンライン対戦サーバー(Cloudflare Workers + Durable Objects)

設計の背景は [docs/online-matchmaking.md](../docs/online-matchmaking.md)。

## 動かし方(アカウント不要)

```sh
# リポジトリ直下でクライアントをビルド(public/app.js を作る)
npm install && npm run build

cd cloud
npm install
npm run dev          # http://localhost:8787 で今のUIがそのまま遊べる(?room=名前)
```

## テスト

```sh
npm test             # 待ち行列ロジックの単体テスト
npm run typecheck

# E2E: wrangler dev を立ち上げて E2E を流し、再起動後に対局が復元されることも確かめる(CI でも実行)
npm run e2e:all

# 手で起動して E2E だけ流す場合
npm run dev:test     # 別ターミナル
npm run e2e
```

## API

| | |
| --- | --- |
| `GET /api/queue?name=..` (WebSocket) | クイックマッチに並ぶ。`{t:"queued"}` の後、成立すると `{t:"matched", roomId, token, seat}` |
| `POST /api/rooms` | フレンド部屋を作る。`{code}` を返す |
| `GET /api/rooms/:roomIdか招待コード/ws?token=&name=` (WebSocket) | 部屋に入る。最初に `{t:"session", token}`、以降は既存の `state` / `error` |

守り: 部屋の状態は Durable Object のストレージに保存(24時間変化が無ければ削除)、IPごとのレート制限(`ratelimits`: 部屋作成10回/分・接続120回/分)、1部屋16接続、1接続10秒60メッセージ・1KBまで、対局中の席は token でしか戻れない。

環境変数(`wrangler.jsonc` の `vars`): `QUEUE_WAIT_MS`(既定20000)、`CPU_DELAY_MS`(700)、`MOVE_SECONDS`(30)

## デプロイ

`CLOUDFLARE_API_TOKEN`(Workers 編集テンプレートのトークン)と `CLOUDFLARE_ACCOUNT_ID` を環境変数で設定して、`cloud/` で `npm run deploy`。
クライアントのビルド(`public/app.js`)もこのコマンドの中で行う。公開先は `https://go3v3.<アカウントのサブドメイン>.workers.dev`。

トークンとアカウントIDはリポジトリに書かないこと。

GitHub の Settings → Secrets and variables → Actions に同じ2つを登録すると、main への push で自動デプロイされる(`.github/workflows/deploy-cloud.yml`)。未登録のあいだは何もしない。

## 画面

トップ(`/`)はロビー。クイックマッチ / 部屋を作る / 招待コードで入る / CPUと練習(`?local`)を選ぶ。

- フレンド部屋は `?room=招待コード` で開ける。合言葉(token)を localStorage に覚えるので、リロードしても同じ席に戻る
- クイックマッチは `?match=部屋ID`。token は sessionStorage に入るので、そのタブでのリロードなら戻れる
- `?room=` に招待コード以外の名前を入れるとロビーに戻る(自由部屋の `/ws` 互換ルートは乱用対策で廃止。ローカルの `npm start` では使える)
- ローカルの Node サーバー(リポジトリ直下の `npm start`)には `/api` が無いので、ロビーは出ずに従来の画面になる

## 無料枠について

Workers Free + SQLite 版 Durable Objects で動く(カード登録不要)。WebSocket をつないでいる間は DO が起きたままなので、
1日あたりの DO 実行時間の無料枠を超えると、その日はエラーになる(課金はされない)。人が増えたら WebSocket Hibernation に移す。
