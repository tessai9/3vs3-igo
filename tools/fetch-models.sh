#!/bin/sh
# KataGo 公式リポジトリ(MIT)のテスト用に同梱されている g170 世代の小さいネットを取ってきて ONNX にする。
# 必要: curl, python3 (pip install onnx numpy)
set -eu
cd "$(dirname "$0")/.."
BASE=https://raw.githubusercontent.com/lightvector/KataGo/master/cpp/tests/models
TMP=$(mktemp -d)
mkdir -p public/models
fetch() { # <KataGoのファイル名> <出力名>
  [ -f "public/models/$2.onnx" ] && return
  curl -fsSL -o "$TMP/$1" "$BASE/$1"
  python3 tools/katago2onnx.py "$TMP/$1" "public/models/$2.onnx"
}
fetch g170-b6c96-s175395328-d26788732.bin.gz b6c96
fetch g170e-b10c128-s1141046784-d204142634.bin.gz b10c128
rm -rf "$TMP"
