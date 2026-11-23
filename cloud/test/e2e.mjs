// wrangler dev で立ち上げた Worker に対して、6人分のクライアントを模擬するE2E。
//   npm run dev:test  (別ターミナル)  →  npm run e2e
import WebSocket from "ws";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(url) {
  const ws = new WebSocket(url);
  const c = { ws, msgs: [], state: null, session: null };
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    c.msgs.push(m);
    if (m.t === "state") c.state = m.room;
    if (m.t === "session") c.session = m;
  });
  c.open = new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
  c.closed = new Promise((res) => ws.on("close", res));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.waitFor = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = c.msgs.find(pred) ?? (c.state && pred({ t: "state", room: c.state }) ? { t: "state", room: c.state } : null);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error("timeout waiting: " + JSON.stringify(c.msgs.at(-1)));
  };
  return c;
}

async function quickMatch(names) {
  // 並ぶ順で席が決まるので、1人ずつ順に並ぶ
  const qs = [];
  for (const n of names) {
    const q = client(`${WS}/api/queue?name=${encodeURIComponent(n)}`);
    await q.open;
    qs.push(q);
  }
  return Promise.all(qs.map((q) => q.waitFor((m) => m.t === "matched")));
}

// 1) 6人揃ったら即マッチ → 全員そろって対局開始
{
  const t0 = Date.now();
  const matched = await quickMatch(["あ", "い", "う", "え", "お", "あ"]);
  assert.ok(Date.now() - t0 < 2000, "6人なら待たずにマッチ");
  assert.equal(new Set(matched.map((m) => m.roomId)).size, 1);
  assert.deepEqual(matched.map((m) => m.seat).sort(), [0, 1, 2, 3, 4, 5]);
  assert.ok(matched.some((m) => m.name === "あ2"), "同名は区別される");
  const players = matched.map((m) => client(`${WS}/api/rooms/${m.roomId}/ws?token=${m.token}`));
  await Promise.all(players.map((p) => p.open));
  const st = (await players[0].waitFor((m) => m.t === "state" && m.room.status === "playing")).room;
  assert.equal(st.seats.filter((s) => s.kind === "human").length, 6);
  // 偽のトークンは入れない
  const bad = new WebSocket(`${WS}/api/rooms/${matched[0].roomId}/ws?token=nope`);
  await new Promise((r) => bad.on("error", r).on("unexpected-response", r));
  players.forEach((p) => p.ws.close());
  console.log("ok 1 - 6人マッチ");
}

// 2) 2人だけ → 待ち時間後にCPU4人で開始、手番の人が切断→CPU代打ち→再接続で席に戻る
{
  const matched = await quickMatch(["黒の人", "白の人"]);
  assert.deepEqual(matched.map((m) => m.seat), [0, 3]);
  assert.equal(matched[0].humans, 2);
  const [b, w] = matched.map((m) => client(`${WS}/api/rooms/${m.roomId}/ws?token=${m.token}`));
  await Promise.all([b.open, w.open]);
  let st = (await b.waitFor((m) => m.t === "state" && m.room.status === "playing")).room;
  assert.equal(st.seats.filter((s) => s.kind === "cpu").length, 4);
  assert.equal(st.turnSeat, 0);
  b.send({ t: "move", point: 40 });
  await w.waitFor((m) => m.t === "state" && m.room.moveCount === 1);
  // 白の人(seat 3)が切断 → 白番はCPUが打つ
  w.ws.close();
  await w.closed;
  await b.waitFor((m) => m.t === "state" && m.room.moveCount >= 2);
  st = b.state;
  assert.equal(st.seats[3].online, false);
  // 同じトークンで再接続すると席に戻る
  const w2 = client(`${WS}/api/rooms/${matched[1].roomId}/ws?token=${matched[1].token}`);
  await w2.open;
  const back = (await w2.waitFor((m) => m.t === "state" && m.room.you.seat === 3)).room;
  assert.equal(back.seats[3].online, true);
  b.ws.close();
  w2.ws.close();
  console.log("ok 2 - 2人+CPU、切断と再接続");
}

// 3) フレンド部屋: 招待コードで入り、席を選んで開始
{
  const { code } = await (await fetch(`${BASE}/api/rooms`, { method: "POST" })).json();
  assert.match(code, /^[A-Z2-9]{6}$/);
  const host = client(`${WS}/api/rooms/${code}/ws?name=ホスト`);
  const guest = client(`${WS}/api/rooms/${code.toLowerCase()}/ws?name=ゲスト`);
  await Promise.all([host.open, guest.open]);
  await host.waitFor((m) => m.t === "session");
  host.send({ t: "sit", seat: 0 });
  guest.send({ t: "sit", seat: 3 });
  await host.waitFor((m) => m.t === "state" && m.room.seats[3].kind === "human");
  host.send({ t: "start", size: 13 });
  const st = (await guest.waitFor((m) => m.t === "state" && m.room.status === "playing")).room;
  assert.equal(st.size, 13);
  host.ws.close();
  guest.ws.close();
  console.log("ok 3 - フレンド部屋");
}
// 4) 旧UI向けの自由部屋ルート /ws は廃止(誰でも部屋を量産できたため)
{
  const old = new WebSocket(`${WS}/ws?room=e2e`);
  const status = await new Promise((r) => old.on("unexpected-response", (_req, res) => r(res.statusCode)).on("open", () => r(101)));
  assert.notEqual(status, 101, "WebSocket としてはつながらない");
  console.log("ok 4 - 自由部屋ルートは無い");
}

// 5) フレンド部屋: 対局中に切断した人の席は、同じ名前の他人には取れず、本人の token でだけ戻れる
{
  const { code } = await (await fetch(`${BASE}/api/rooms`, { method: "POST" })).json();
  const a = client(`${WS}/api/rooms/${code}/ws?name=たろう`);
  await a.open;
  const { token } = await a.waitFor((m) => m.t === "session");
  a.send({ t: "sit", seat: 0 });
  a.send({ t: "start", size: 9 });
  await a.waitFor((m) => m.t === "state" && m.room.status === "playing");
  a.ws.close();
  await a.closed;
  await sleep(200);
  const thief = client(`${WS}/api/rooms/${code}/ws?name=たろう`);
  await thief.open;
  const st = (await thief.waitFor((m) => m.t === "state")).room;
  assert.equal(st.you.seat, null, "同名の他人は席に戻れない");
  const back = client(`${WS}/api/rooms/${code}/ws?name=たろう&token=${token}`);
  await back.open;
  await back.waitFor((m) => m.t === "state" && m.room.you.seat === 0);
  thief.ws.close();
  back.ws.close();
  console.log("ok 5 - 席の乗っ取り防止");
}

// 6) 大きすぎるメッセージは無視、送りすぎると切断。名前はフィルタされる
{
  const { code } = await (await fetch(`${BASE}/api/rooms`, { method: "POST" })).json();
  const c = client(`${WS}/api/rooms/${code}/ws?name=${encodeURIComponent("ちんこ")}`);
  await c.open;
  const s = await c.waitFor((m) => m.t === "session");
  assert.equal(s.name, "ゲスト");
  c.send({ t: "hello", name: "x".repeat(5000) });
  await sleep(200);
  assert.equal(c.state.you.name, "ゲスト", "大きすぎるメッセージは無視");
  for (let i = 0; i < 80; i++) c.send({ t: "pin", point: 0 });
  const code1008 = await new Promise((r) => c.ws.on("close", (code) => r(code)));
  assert.equal(code1008, 1008);
  console.log("ok 6 - メッセージ制限と名前フィルタ");
}
process.exit(0);
