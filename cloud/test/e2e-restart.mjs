// Worker を再起動(=Durable Object のメモリが消える)しても、対局が続きから打てることを確かめる。
//   node test/e2e-restart.mjs before  → 対局を作って1手打ち、部屋の情報を表示
//   (wrangler dev を再起動)
//   ROOM=... TOKEN=... node test/e2e-restart.mjs after
import WebSocket from "ws";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const next = (ws, pred) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), 8000);
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (pred(m)) (clearTimeout(t), res(m));
    });
  });

if (process.argv[2] === "before") {
  const { code } = await (await fetch(`${BASE}/api/rooms`, { method: "POST" })).json();
  const ws = new WebSocket(`${WS}/api/rooms/${code}/ws?name=保存テスト`);
  const { token } = await next(ws, (m) => m.t === "session");
  ws.send(JSON.stringify({ t: "sit", seat: 0 }));
  ws.send(JSON.stringify({ t: "start", size: 9 }));
  await next(ws, (m) => m.t === "state" && m.room.status === "playing");
  ws.send(JSON.stringify({ t: "move", point: 40 }));
  await next(ws, (m) => m.t === "state" && m.room.moveCount >= 1);
  console.log(JSON.stringify({ ROOM: code, TOKEN: token }));
  process.exit(0);
} else {
  const ws = new WebSocket(`${WS}/api/rooms/${process.env.ROOM}/ws?name=保存テスト&token=${process.env.TOKEN}`);
  const st = (await next(ws, (m) => m.t === "state" && m.room.you.seat === 0)).room;
  assert.equal(st.status, "playing");
  assert.equal(st.board[40], 1, "再起動前の1手が残っている");
  assert.ok(st.moveCount >= 1);
  console.log("ok - 再起動後も対局が続いている", st.moveCount, "手目");
  process.exit(0);
}
