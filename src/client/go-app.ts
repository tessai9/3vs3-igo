// アプリ全体。WebSocketでサーバーとつなぎ、受け取った状態を子コンポーネントに配る。
import "./go-board.js";
import "./team-panel.js";
import "./go-lobby.js";
import { hasOnlineApi, isInviteCode, type GoLobby, type OnlineConn } from "./go-lobby.js";
import { esc, type TeamPanel } from "./team-panel.js";
import type { GoBoard } from "./go-board.js";
import type { ClientMsg, RoomView, ServerMsg } from "../shared/protocol.js";
import { Room } from "../shared/room.js";
import { AI_LEVELS, NnCpu, type AiLevel, type AiStatus } from "./nn-cpu.js";

/** サーバーなし(GitHub Pages など)ではブラウザ内で部屋を動かし、CPUと対局する */
const params = new URLSearchParams(location.search);
const LOCAL_MODE = params.has("local") || location.protocol === "file:" || location.hostname.endsWith("github.io");

const seatLabel = (room: RoomView, seat: number) => {
  const s = room.seats[seat];
  return `${s.color === 1 ? "黒" : "白"}${s.index + 1} ${s.kind === "cpu" ? "CPU" : esc(s.name)}`;
};

function loadName(): string {
  try {
    const n = localStorage.getItem("go3v3.name");
    if (n) return n;
  } catch {}
  return `ゲスト${Math.floor(Math.random() * 90 + 10)}`;
}

function loadAiLevel(): AiLevel {
  const q = params.get("ai");
  if (q && q in AI_LEVELS) return q as AiLevel;
  try {
    const v = localStorage.getItem("go3v3.ai");
    if (v && v in AI_LEVELS) return v as AiLevel;
  } catch {}
  return "b10";
}

export class GoApp extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private ws: WebSocket | null = null;
  private localRoom: Room | null = null;
  private room: RoomView | null = null;
  private clockOffset = 0;
  private pinMode = false;
  private name = loadName();
  /** オンライン時の接続先。null はロビー表示中 */
  private conn: OnlineConn | null = null;
  /** 開いてから一度もつながらずに失敗した回数(部屋が無いときにロビーへ戻すため) */
  private failures = 0;
  private size = 9;
  private lastTurnSeat = -1;
  private ai: NnCpu | null = null;

  connectedCallback() {
    this.root.innerHTML = `
      <style>${CSS}</style>
      <header>
        <h1>3vs3 囲碁 <small>プロトタイプ</small></h1>
        <span id="roominfo"></span>
        <label>名前 <input id="name" maxlength="16" value="${esc(this.name)}"></label>
        ${
          LOCAL_MODE
            ? `<label>CPU <select id="ai">${Object.entries(AI_LEVELS)
                .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
                .join("")}</select></label><span id="aistat" class="conn ok"></span>`
            : ""
        }
        <span id="conn" class="conn">接続中…</span>
      </header>
      <go-lobby id="lobby" hidden></go-lobby>
      <div id="game" hidden>
      <section id="status"><div id="msg"></div><div class="timer"><i id="bar"></i></div><ol id="order"></ol></section>
      <main>
        <team-panel id="black"></team-panel>
        <div class="center">
          <go-board id="board"></go-board>
          <div id="controls"></div>
        </div>
        <team-panel id="white"></team-panel>
      </main>
      <section id="log"></section>
      </div>
      <div id="toast"></div>`;

    const nameInput = this.$("#name") as HTMLInputElement;
    nameInput.addEventListener("change", () => {
      this.name = nameInput.value.trim() || this.name;
      try {
        localStorage.setItem("go3v3.name", this.name);
      } catch {}
      this.send({ t: "hello", name: this.name });
    });
    this.root.addEventListener("send", (e) => this.send((e as CustomEvent).detail));
    this.root.addEventListener("board-tap", (e) => this.onTap((e as CustomEvent).detail));
    const lobby = this.$("#lobby") as GoLobby;
    lobby.getName = () => this.name;
    lobby.addEventListener("enter", (e) => this.enter((e as CustomEvent<OnlineConn>).detail));
    void this.boot();
    setInterval(() => this.tickTimer(), 200);
  }

  private $(sel: string) {
    return this.root.querySelector(sel)!;
  }

  /** URLから、ロビーを出すか・どの部屋に入るかを決める */
  private async boot() {
    if (LOCAL_MODE) {
      (this.$("#game") as HTMLElement).hidden = false;
      return this.startLocal();
    }
    const room = params.get("room");
    const match = params.get("match");
    if (match) {
      let token: string | null = null;
      try {
        token = sessionStorage.getItem(`go3v3.match.${match}`);
      } catch {}
      if (token) return this.enter({ kind: "match", roomId: match, token });
      if (await hasOnlineApi()) return this.showLobby("この対局には入れません(終了したか、別の端末で開かれています)");
    }
    if (room && isInviteCode(room.toUpperCase()) && (await hasOnlineApi())) return this.enter({ kind: "friend", code: room.toUpperCase() });
    if (room) return this.enter({ kind: "legacy", room });
    // ローカルの Node サーバー(npm start)にはロビーが無いので、従来どおり lobby 部屋に入る
    if (await hasOnlineApi()) this.showLobby();
    else this.enter({ kind: "legacy", room: "lobby" });
  }

  private showLobby(error = "") {
    this.closeWs();
    this.conn = null;
    this.room = null;
    history.replaceState(null, "", location.pathname);
    (this.$("#game") as HTMLElement).hidden = true;
    const lobby = this.$("#lobby") as GoLobby;
    lobby.hidden = false;
    lobby.showMenu(error);
    this.$("#roominfo").innerHTML = "";
    this.$("#conn").textContent = "";
  }

  private enter(conn: OnlineConn) {
    this.closeWs();
    this.conn = conn;
    this.room = null;
    this.failures = 0;
    const q = conn.kind === "match" ? `?match=${conn.roomId}` : `?room=${encodeURIComponent(conn.kind === "friend" ? conn.code : conn.room)}`;
    history.replaceState(null, "", location.pathname + q);
    (this.$("#lobby") as HTMLElement).hidden = true;
    (this.$("#game") as HTMLElement).hidden = false;
    this.renderRoomInfo();
    this.connect();
  }

  private renderRoomInfo() {
    const c = this.conn;
    const el = this.$("#roominfo");
    if (!c) return void (el.innerHTML = "");
    if (c.kind === "legacy") el.innerHTML = `<label>部屋 <b>${esc(c.room)}</b></label>`;
    else if (c.kind === "match") el.innerHTML = `<b>クイックマッチ</b>`;
    else {
      el.innerHTML = `<label>招待コード <b class="code">${c.code}</b></label> <button id="invite" class="small">招待リンクを送る</button>`;
      (el.querySelector("#invite") as HTMLElement).onclick = () => this.invite(c.code);
    }
  }

  private async invite(code: string) {
    const url = `${location.origin}${location.pathname}?room=${code}`;
    const data = { title: "3vs3 囲碁", text: `3vs3 囲碁で遊ぼう(招待コード ${code})`, url };
    try {
      if (navigator.share) return await navigator.share(data);
    } catch {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      this.toast("招待リンクをコピーしました");
    } catch {
      prompt("このリンクを送ってください", url);
    }
  }

  private closeWs() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  private wsUrl(c: OnlineConn) {
    const base = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    const name = encodeURIComponent(this.name);
    if (c.kind === "legacy") return `${base}/ws?room=${encodeURIComponent(c.room)}`;
    if (c.kind === "match") return `${base}/api/rooms/${c.roomId}/ws?token=${encodeURIComponent(c.token)}`;
    let token = "";
    try {
      token = localStorage.getItem(`go3v3.friend.${c.code}`) ?? "";
    } catch {}
    return `${base}/api/rooms/${c.code}/ws?name=${name}&token=${encodeURIComponent(token)}`;
  }

  private connect() {
    const conn = this.conn;
    if (!conn) return;
    const ws = new WebSocket(this.wsUrl(conn));
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.failures = 0;
      this.$("#conn").textContent = "接続済み";
      this.$("#conn").className = "conn ok";
      this.send({ t: "hello", name: this.name });
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4000) {
        this.$("#conn").textContent = "別のタブで開かれたので切断しました";
        this.$("#conn").className = "conn";
        return;
      }
      // 部屋が無い・合言葉が違うときは何度やっても入れないので、ロビーに戻す
      if (!opened && ++this.failures >= 4 && conn.kind !== "legacy") return this.showLobby("部屋が見つかりませんでした");
      this.$("#conn").textContent = "切断(再接続中…)";
      this.$("#conn").className = "conn";
      setTimeout(() => {
        if (this.conn === conn && !this.ws) this.connect();
      }, 1500);
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data));
  }

  /** 1人 + CPU5人で、ブラウザだけで対局する */
  private startLocal() {
    const ai = new NnCpu(loadAiLevel());
    this.ai = ai;
    const sel = this.$("#ai") as HTMLSelectElement;
    sel.value = ai.level;
    sel.addEventListener("change", () => {
      ai.level = sel.value as AiLevel;
      try {
        localStorage.setItem("go3v3.ai", ai.level);
      } catch {}
      ai.preload();
    });
    ai.onStatus = (st) => this.showAiStatus(st);
    ai.preload();
    const room = new Room("local", { cpu: ai.move, cpuDelayMs: 500 });
    this.localRoom = room;
    room.join("me", (m) => this.receive(m));
    this.$("#conn").textContent = "オフライン(CPU対戦)";
    this.$("#conn").className = "conn ok";
    room.handle("me", { t: "hello", name: this.name });
    room.handle("me", { t: "sit", seat: 0 });
  }

  private showAiStatus(st: AiStatus) {
    const el = this.$("#aistat") as HTMLElement;
    const last = this.ai?.last;
    el.className = st.state === "fallback" ? "conn" : "conn ok";
    el.textContent =
      st.state === "loading"
        ? "AIを読み込み中…"
        : st.state === "fallback"
          ? "AIを使えないので簡易CPUで代打ち中"
          : st.level !== "simple" && last
            ? `AI読み ${last.visits}局面 / ${(last.ms / 1000).toFixed(1)}秒 / 黒の勝率 ${Math.round(last.blackWinrate * 100)}%`
            : "";
  }

  private receive(m: ServerMsg | { t: "session"; token: string }) {
    if (this.ai) this.showAiStatus(this.ai.status);
    if (m.t === "session") {
      // フレンド部屋の合言葉。再接続やリロードで同じ席に戻るために覚えておく
      if (this.conn?.kind === "friend") {
        try {
          localStorage.setItem(`go3v3.friend.${this.conn.code}`, m.token);
        } catch {}
      }
      return;
    }
    if (m.t === "error") this.toast(m.message);
    else {
      this.clockOffset = m.room.serverNow - Date.now();
      this.room = m.room;
      this.render();
    }
  }

  private send(m: ClientMsg) {
    if (this.localRoom) this.localRoom.handle("me", m);
    else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private myTurn() {
    const r = this.room;
    return !!r && r.status === "playing" && r.you.seat !== null && r.turnSeat === r.you.seat;
  }

  private onTap({ point, pin }: { point: number; pin: boolean }) {
    const r = this.room;
    if (!r || r.status !== "playing" || r.you.seat === null) return;
    // 自分の番でなければ、タップはピン(相談)になる
    if (pin || this.pinMode || !this.myTurn()) this.send({ t: "pin", point });
    else this.send({ t: "move", point });
  }

  private toast(text: string) {
    const t = this.$("#toast") as HTMLElement;
    t.textContent = text;
    t.classList.add("show");
    clearTimeout((t as any)._h);
    (t as any)._h = setTimeout(() => t.classList.remove("show"), 2200);
  }

  private tickTimer() {
    const r = this.room;
    const bar = this.$("#bar") as HTMLElement;
    const active = !!r && !!r.deadline && r.status === "playing";
    (bar.parentElement as HTMLElement).style.visibility = active ? "visible" : "hidden";
    if (!active) return;
    const left = Math.max(0, r!.deadline! - (Date.now() + this.clockOffset));
    bar.style.width = `${(left / 30000) * 100}%`;
    bar.classList.toggle("hurry", left < 10000);
    bar.textContent = `${Math.ceil(left / 1000)}秒`;
  }

  private render() {
    const r = this.room!;
    const mine = this.myTurn();
    if (mine && this.lastTurnSeat !== r.moveCount) navigator.vibrate?.(80);
    this.lastTurnSeat = r.moveCount;
    if (!mine) this.pinMode = false;

    // 状況メッセージ
    let msg = "";
    if (r.status === "waiting") {
      msg =
        this.conn?.kind === "match"
          ? "みんなの接続を待っています。15秒たつと、そろっていなくても始まります。"
          : r.you.seat === null
            ? "好きな席に座ってください。空席はCPUが打ちます。"
            : "全員そろったら「対局開始」を押してください(空席はCPU)。";
    } else if (r.status === "playing") {
      msg = mine
        ? `<b class="you">あなたの番です</b>`
        : `${seatLabel(r, r.turnSeat)} の番` + (r.you.seat !== null ? `<span class="hint">盤をタップすると味方にピンで合図できます</span>` : "");
    } else if (r.result) {
      const w = r.result.winner === 1 ? "黒" : "白";
      msg =
        r.result.reason === "resign"
          ? `<b>${w}チームの中押し勝ち</b>`
          : `<b>${w}チームの勝ち</b> 黒 ${r.result.black} / 白 ${r.result.white}+${r.result.komi}`;
    }
    this.$("#msg").innerHTML = msg;

    // この先の打つ順番
    const order: string[] = [];
    if (r.status === "playing") {
      for (let k = 0; k < 6; k++) {
        const idx = r.moveCount + k;
        const color = idx % 2 === 0 ? 0 : 3;
        const seat = color + (Math.floor(idx / 2) % 3);
        order.push(`<li class="${seat === r.you.seat ? "me" : ""} c${color ? 2 : 1}">${seatLabel(r, seat)}</li>`);
      }
    }
    this.$("#order").innerHTML = order.join("");

    const locked = this.conn?.kind === "match";
    (this.$("#black") as TeamPanel).data = { room: r, color: 1, locked };
    (this.$("#white") as TeamPanel).data = { room: r, color: 2, locked };
    const myColor = r.you.seat === null ? null : r.seats[r.you.seat].color;
    (this.$("#board") as GoBoard).data = {
      size: r.size,
      board: r.board,
      lastPoint: r.lastMove?.point ?? null,
      pins: r.pins,
      ownership: r.result?.reason === "pass" ? r.result.ownership : null,
      hoverColor: mine && !this.pinMode ? myColor : null,
      pinHover: r.status === "playing" && r.you.seat !== null && (!mine || this.pinMode),
    };

    // 操作ボタン
    const c = this.$("#controls");
    const online = !!this.conn && this.conn.kind !== "legacy";
    const leave = online ? `<button id="leave">ロビーへ</button>` : "";
    if (r.status === "waiting" && this.conn?.kind === "match") {
      c.innerHTML = leave;
    } else if (r.status === "waiting") {
      c.innerHTML = `${leave}
        <select id="size"><option value="9">9路</option><option value="13">13路</option></select>
        <button id="start" class="primary" ${r.you.seat === null ? "disabled" : ""}>対局開始</button>`;
      const sel = c.querySelector("#size") as HTMLSelectElement;
      sel.value = String(this.size);
      sel.onchange = () => (this.size = Number(sel.value));
      (c.querySelector("#start") as HTMLElement).onclick = () => this.send({ t: "start", size: this.size });
    } else if (r.status === "playing" && r.you.seat !== null) {
      c.innerHTML = `
        <button id="pass" ${mine ? "" : "disabled"}>パス</button>
        <button id="pin" class="${this.pinMode ? "on" : ""}" ${mine ? "" : "disabled"}>📍 ピンを置く</button>
        <button id="resign" class="danger">投了</button>`;
      (c.querySelector("#pass") as HTMLElement).onclick = () => this.send({ t: "pass" });
      (c.querySelector("#pin") as HTMLElement).onclick = () => {
        this.pinMode = !this.pinMode;
        this.render();
      };
      (c.querySelector("#resign") as HTMLElement).onclick = () => {
        const b = c.querySelector("#resign") as HTMLElement;
        if (b.dataset.armed) this.send({ t: "resign" });
        else {
          b.dataset.armed = "1";
          b.textContent = "本当に投了?";
        }
      };
    } else if (r.status === "playing") {
      c.innerHTML = `<span class="sub">観戦中です。対局が終わると席に座れます。</span>${leave}`;
    } else if (this.conn?.kind === "match") {
      c.innerHTML = `${leave}<button id="again" class="primary">もう一度クイックマッチ</button>`;
      (c.querySelector("#again") as HTMLElement).onclick = () => {
        this.showLobby();
        (this.$("#lobby") as GoLobby).quickMatch();
      };
    } else {
      c.innerHTML = `${leave}<button id="again" class="primary">もう一局(席を選び直す)</button>`;
      (c.querySelector("#again") as HTMLElement).onclick = () => this.send({ t: "reset" });
    }
    const lb = c.querySelector("#leave") as HTMLElement | null;
    if (lb) lb.onclick = () => this.showLobby();

    this.$("#log").innerHTML = r.log.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join("");
  }
}

const CSS = `
:host { --bg:#f6f3ec; --fg:#222; --sub:#777; --panel:#fff; --line:#d8d2c4; --chip:#eee8db;
        --accent:#2f7d5b; --accent-bg:#e5f3ec; --danger:#c0392b;
        display:block; max-width:1100px; margin:0 auto; padding:12px 16px 40px; color:var(--fg);
        font: 14px/1.5 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
@media (prefers-color-scheme: dark) {
  :host { --bg:#1d1c1a; --fg:#eee; --sub:#9a968c; --panel:#2a2926; --line:#444; --chip:#3a3833;
          --accent:#4fb488; --accent-bg:#24382e; }
}
header { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; margin-bottom:10px; }
h1 { font-size:18px; margin:0; margin-right:auto; }
h1 small { font-size:11px; color:var(--sub); font-weight:normal; }
input, select { font:inherit; padding:4px 8px; border-radius:6px; border:1px solid var(--line); background:var(--panel); color:var(--fg); width:9em; }
select { width:auto; }
.conn { font-size:12px; color:var(--danger); } .conn.ok { color:var(--accent); }
#status { background:var(--panel); border-radius:10px; padding:10px 12px; margin-bottom:12px; }
#msg { min-height:22px; display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; }
#msg .you { color:var(--accent); font-size:17px; }
.hint { font-size:12px; color:var(--sub); }
.timer { height:16px; background:var(--chip); border-radius:8px; margin:8px 0; overflow:hidden; }
#bar { display:block; height:100%; background:var(--accent); color:#fff; font-size:11px; font-style:normal;
       text-align:right; padding-right:6px; box-sizing:border-box; transition:width .2s linear; white-space:nowrap; }
#bar.hurry { background:var(--danger); }
#order { list-style:none; display:flex; flex-wrap:wrap; gap:4px; margin:0; padding:0; font-size:12px; }
#order li { padding:2px 8px; border-radius:10px; background:var(--chip); }
#order li:first-child { outline:2px solid var(--accent); }
#order li.me { background:var(--accent); color:#fff; }
#order li + li::before { content:""; }
main { display:grid; grid-template-columns: 220px 1fr 220px; gap:14px; align-items:start; }
.center { display:flex; flex-direction:column; align-items:center; gap:12px; }
#controls { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; }
button { font:inherit; padding:8px 16px; border-radius:8px; border:1px solid var(--line); background:var(--panel);
         color:var(--fg); cursor:pointer; }
button:disabled { opacity:.4; cursor:default; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.on { background:#e8463c; border-color:#e8463c; color:#fff; }
button.danger { color:var(--danger); }
.sub { color:var(--sub); }
button.small { padding:4px 10px; font-size:12px; }
.code { letter-spacing:.12em; font-family:ui-monospace, monospace; }
#roominfo { display:flex; align-items:center; gap:8px; }
[hidden] { display:none !important; }
#log { margin-top:14px; font-size:12px; color:var(--sub); max-height:160px; overflow:auto; }
#toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(80px); background:#333; color:#fff;
         padding:8px 16px; border-radius:8px; opacity:0; transition:.2s; pointer-events:none; }
#toast.show { opacity:1; transform:translateX(-50%); }
@media (max-width: 760px) {
  :host { padding:8px 10px 30px; }
  main { grid-template-columns: 1fr 1fr; }
  .center { grid-column: 1 / -1; order:-1; }
}
`;

customElements.define("go-app", GoApp);
