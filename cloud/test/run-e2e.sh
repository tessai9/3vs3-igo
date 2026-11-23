#!/bin/sh
# wrangler dev を立ち上げて E2E を流し、途中で再起動して「対局の保存・復元」も確かめる。
# 使い方: (リポジトリ直下で npm run build 済み) cd cloud && sh test/run-e2e.sh
set -eu
cd "$(dirname "$0")/.."
PORT=${PORT:-8787}
export BASE="http://127.0.0.1:$PORT"
LOG=${LOG:-.wrangler/e2e.log}
mkdir -p .wrangler

start() {
  npx wrangler dev --var QUEUE_WAIT_MS:3000 --var CPU_DELAY_MS:200 --port "$PORT" >>"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 60); do
    curl -fsS "$BASE/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "wrangler dev が起動しませんでした"; cat "$LOG"; exit 1
}
stop() {
  kill "$PID" 2>/dev/null || true
  # workerd の子プロセスも止まるまで待つ
  for _ in $(seq 1 20); do curl -fsS "$BASE/api/health" >/dev/null 2>&1 || return 0; sleep 0.5; done
}
trap 'stop' EXIT

start
node test/e2e.mjs
OUT=$(node test/e2e-restart.mjs before)
stop
start
ROOM=$(echo "$OUT" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).ROOM)') \
TOKEN=$(echo "$OUT" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).TOKEN)') \
  node test/e2e-restart.mjs after
