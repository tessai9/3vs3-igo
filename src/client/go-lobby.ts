// オンライン版のロビー。クイックマッチ / フレンド部屋の作成 / 招待コードで参加 を選ぶ。
// どれかが決まると "enter" イベント(detail: OnlineConn)を出す。
import { esc } from "./team-panel.js";

export type OnlineConn =
  | { kind: "legacy"; room: string }
  | { kind: "friend"; code: string }
  | { kind: "match"; roomId: string; token: string };

export const isInviteCode = (s: string) => /^[A-HJKMNP-Z2-9]{6}$/.test(s);

/** Cloudflare 版のAPIがあるか(ローカルの Node サーバーには無い) */
export async function hasOnlineApi(): Promise<boolean> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    return r.ok && (await r.json()).ok === true;
  } catch {
    return false;
  }
}

type QueueMsg =
  | { t: "queued"; position: number; waitMs: number }
  | { t: "matched"; roomId: string; token: string; seat: number; name: string; humans: number };

export class GoLobby extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private queueWs: WebSocket | null = null;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  /** 名前は go-app が持っているので、問い合わせ用の関数をもらう */
  getName: () => string = () => "ゲスト";

  connectedCallback() {
    this.showMenu();
  }

  disconnectedCallback() {
    this.cancelQueue();
  }

  showMenu(error = "") {
    this.cancelQueue();
    this.root.innerHTML = `
      <style>${CSS}</style>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <div class="cards">
        <section>
          <h2>クイックマッチ</h2>
          <p>知らない人と3対3。20秒たって6人そろわなければ、空いた席はCPUが打ちます。</p>
          <button id="quick" class="primary">さがす</button>
        </section>
        <section>
          <h2>友達と遊ぶ</h2>
          <p>部屋を作って、招待リンクを送ります。席は自分たちで選べます。</p>
          <button id="create" class="primary">部屋を作る</button>
          <form id="join">
            <input id="code" maxlength="6" placeholder="招待コード" autocapitalize="characters" autocomplete="off">
            <button>入る</button>
          </form>
        </section>
        <section>
          <h2>ひとりで練習</h2>
          <p>あなた + CPU5人。通信なしでブラウザだけで動きます。</p>
          <a class="button" href="?local">CPUと打つ</a>
        </section>
      </div>`;
    this.$("#quick").addEventListener("click", () => this.quickMatch());
    this.$("#create").addEventListener("click", () => this.createRoom());
    this.$("#join").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = (this.$("#code") as HTMLInputElement).value.trim().toUpperCase();
      if (!isInviteCode(code)) return this.showMenu("招待コードは6文字の英数字です");
      this.enter({ kind: "friend", code });
    });
  }

  /** クイックマッチの待ち行列に並ぶ */
  quickMatch() {
    this.cancelQueue();
    const started = Date.now();
    let waitMs = 20_000;
    let count = 1;
    this.root.innerHTML = `
      <style>${CSS}</style>
      <div class="waiting">
        <div class="spinner"></div>
        <p id="qmsg">相手をさがしています…</p>
        <p class="sub" id="qsub"></p>
        <button id="cancel">やめる</button>
      </div>`;
    this.$("#cancel").addEventListener("click", () => this.showMenu());
    const update = () => {
      const left = Math.max(0, Math.ceil((waitMs - (Date.now() - started)) / 1000));
      this.$("#qmsg").textContent = `相手をさがしています…(${count}/6人)`;
      this.$("#qsub").textContent = left > 0 ? `あと${left}秒でそろわなければCPUが入ります` : "まもなく開始します";
    };
    this.queueTimer = setInterval(update, 250);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/queue?name=${encodeURIComponent(this.getName())}`);
    this.queueWs = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as QueueMsg;
      if (m.t === "queued") {
        waitMs = m.waitMs;
        count = m.position;
        update();
      } else if (m.t === "matched") {
        this.queueWs = null;
        try {
          sessionStorage.setItem(`go3v3.match.${m.roomId}`, m.token);
        } catch {}
        this.enter({ kind: "match", roomId: m.roomId, token: m.token });
      }
    };
    ws.onclose = () => {
      if (this.queueWs === ws) this.showMenu("接続が切れました。もう一度さがしてください");
    };
  }

  private async createRoom() {
    (this.$("#create") as HTMLButtonElement).disabled = true;
    try {
      const r = await fetch("/api/rooms", { method: "POST" });
      const { code } = (await r.json()) as { code: string };
      this.enter({ kind: "friend", code });
    } catch {
      this.showMenu("部屋を作れませんでした。時間をおいて試してください");
    }
  }

  private cancelQueue() {
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    const ws = this.queueWs;
    this.queueWs = null;
    ws?.close();
  }

  private enter(conn: OnlineConn) {
    this.cancelQueue();
    this.dispatchEvent(new CustomEvent("enter", { detail: conn, bubbles: true, composed: true }));
  }

  private $(sel: string) {
    return this.root.querySelector(sel)!;
  }
}

const CSS = `
:host { display:block; }
.cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:14px; }
section { background:var(--panel); border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:10px; }
h2 { margin:0; font-size:17px; }
p { margin:0; color:var(--sub); font-size:13px; }
.err { color:var(--danger); margin-bottom:12px; font-size:14px; }
form { display:flex; gap:8px; }
input { font:inherit; padding:8px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg);
        flex:1; min-width:0; text-transform:uppercase; letter-spacing:.1em; }
button, .button { font:inherit; padding:10px 16px; border-radius:8px; border:1px solid var(--line); background:var(--panel);
                  color:var(--fg); cursor:pointer; text-align:center; text-decoration:none; }
button:disabled { opacity:.5; }
.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.waiting { background:var(--panel); border-radius:12px; padding:32px 16px; display:flex; flex-direction:column; align-items:center; gap:12px; }
.waiting p { font-size:15px; color:var(--fg); } .waiting p.sub { font-size:13px; color:var(--sub); }
.spinner { width:36px; height:36px; border-radius:50%; border:4px solid var(--chip); border-top-color:var(--accent);
           animation:spin 1s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
`;

customElements.define("go-lobby", GoLobby);
