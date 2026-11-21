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

# E2E: 待ち時間を短くした設定で起動してから実行
npm run dev:test     # 別ターミナル
npm run e2e
```

## API

| | |
| --- | --- |
| `GET /api/queue?name=..` (WebSocket) | クイックマッチに並ぶ。`{t:"queued"}` の後、成立すると `{t:"matched", roomId, token, seat}` |
| `POST /api/rooms` | フレンド部屋を作る。`{code}` を返す |
| `GET /api/rooms/:roomIdか招待コード/ws?token=&name=` (WebSocket) | 部屋に入る。最初に `{t:"session", token}`、以降は既存の `state` / `error` |
| `GET /ws?room=..` (WebSocket) | 既存クライアント用の互換ルート |

環境変数(`wrangler.jsonc` の `vars`): `QUEUE_WAIT_MS`(既定20000)、`CPU_DELAY_MS`(700)、`MOVE_SECONDS`(30)

## デプロイ

`CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を設定して `npm run deploy`。
