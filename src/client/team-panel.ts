// 片方のチーム(3席)の表示。待機中は席に座るボタンを出す。
import type { RoomView } from "../shared/protocol.js";

export class TeamPanel extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });

  set data(d: { room: RoomView; color: 1 | 2; locked?: boolean }) {
    const { room, color } = d;
    const base = color === 1 ? 0 : 3;
    // クイックマッチでは席はサーバーが決めるので、座る・立つボタンは出さない
    const waiting = room.status === "waiting" && !d.locked;
    const playing = room.status === "playing";
    const cap = color === 1 ? room.captures.black : room.captures.white;
    const seats = room.seats.slice(base, base + 3).map((s, i) => {
      const seat = base + i;
      const isTurn = playing && room.turnSeat === seat;
      const isYou = room.you.seat === seat;
      const label = s.kind === "cpu" ? "CPU" : esc(s.name) + (s.online ? "" : " (切断中)");
      const sit = waiting && !isYou && s.kind === "cpu" ? `<button data-seat="${seat}">ここに座る</button>` : "";
      const stand = waiting && isYou ? `<button data-stand>立つ</button>` : "";
      return `<li class="${isTurn ? "turn" : ""} ${isYou ? "you" : ""} ${s.kind}">
        <span class="no">${i + 1}</span>
        <span class="name">${label}${isYou ? '<em>あなた</em>' : ""}</span>
        ${sit}${stand}
      </li>`;
    });

    this.root.innerHTML = `
      <style>
        :host { display: block; background: var(--panel); border-radius: 10px; padding: 10px 12px; }
        h2 { margin: 0 0 6px; font-size: 15px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; white-space: nowrap; }
        .stone { width: 16px; height: 16px; border-radius: 50%; border: 1px solid #888;
                 background: ${color === 1 ? "#111" : "#f4f1ea"}; }
        .cap { margin-left: auto; font-weight: normal; font-size: 12px; color: var(--sub); }
        ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
        li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
             border: 2px solid transparent; min-height: 30px; }
        li.turn { border-color: var(--accent); background: var(--accent-bg); }
        li.cpu .name { color: var(--sub); }
        .no { width: 20px; height: 20px; border-radius: 50%; background: var(--chip); font-size: 12px;
              display: grid; place-items: center; flex: none; }
        .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        em { font-style: normal; font-size: 11px; background: var(--accent); color: #fff; border-radius: 4px;
             padding: 1px 5px; margin-left: 6px; }
        button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line);
                 background: var(--bg); color: var(--fg); cursor: pointer; }
      </style>
      <h2><span class="stone"></span>${color === 1 ? "黒" : "白"}チーム<span class="cap">アゲハマ ${cap}</span></h2>
      <ul>${seats.join("")}</ul>`;

    this.root.querySelectorAll<HTMLButtonElement>("button[data-seat]").forEach((b) =>
      b.addEventListener("click", () => this.fire({ t: "sit", seat: Number(b.dataset.seat) })),
    );
    this.root.querySelector("button[data-stand]")?.addEventListener("click", () => this.fire({ t: "stand" }));
  }

  private fire(msg: unknown) {
    this.dispatchEvent(new CustomEvent("send", { detail: msg, bubbles: true, composed: true }));
  }
}

export function esc(s: string) {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

customElements.define("team-panel", TeamPanel);
