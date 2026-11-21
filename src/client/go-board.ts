// 碁盤。状態を受け取って描くだけで、クリックは board-tap イベントで外に知らせる。
import type { Cell } from "../shared/game.js";
import type { Pin } from "../shared/protocol.js";

export interface BoardProps {
  size: number;
  board: Cell[];
  lastPoint: number | null;
  pins: Pin[];
  ownership: Cell[] | null;
  /** カーソル位置に出す石の色(打てないときは null) */
  hoverColor: Cell | null;
  pinHover: boolean;
}

const STAR: Record<number, number[]> = { 9: [2, 4, 6], 13: [3, 6, 9], 19: [3, 9, 15] };
const NS = "http://www.w3.org/2000/svg";

export class GoBoard extends HTMLElement {
  private svg: SVGSVGElement;
  private props: BoardProps | null = null;
  private hover: number | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; aspect-ratio: 1; width: 100%; max-width: min(92vw, 640px); touch-action: manipulation; }
        svg { width: 100%; height: 100%; display: block; border-radius: 6px;
              box-shadow: 0 6px 20px rgba(0,0,0,.25); cursor: pointer; user-select: none; }
        .pin text { font: bold 0.42px system-ui, sans-serif; }
      </style>`;
    this.svg = document.createElementNS(NS, "svg");
    root.append(this.svg);
    this.svg.addEventListener("pointermove", (e) => this.setHover(this.pointAt(e)));
    this.svg.addEventListener("pointerleave", () => this.setHover(null));
    this.svg.addEventListener("click", (e) => this.emit(e, false));
    this.svg.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.emit(e, true);
    });
  }

  set data(p: BoardProps) {
    this.props = p;
    this.render();
  }

  private emit(e: MouseEvent, pin: boolean) {
    const point = this.pointAt(e);
    if (point !== null) this.dispatchEvent(new CustomEvent("board-tap", { detail: { point, pin }, bubbles: true, composed: true }));
  }

  private pointAt(e: MouseEvent): number | null {
    if (!this.props) return null;
    const n = this.props.size;
    const r = this.svg.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * (n + 1) - 1);
    const y = Math.round(((e.clientY - r.top) / r.height) * (n + 1) - 1);
    return x >= 0 && y >= 0 && x < n && y < n ? y * n + x : null;
  }

  private setHover(p: number | null) {
    if (p === this.hover) return;
    this.hover = p;
    this.render();
  }

  private render() {
    const p = this.props;
    if (!p) return;
    const n = p.size;
    const parts: string[] = [];
    const xy = (i: number) => [(i % n) + 1, Math.floor(i / n) + 1];
    this.svg.setAttribute("viewBox", `0 0 ${n + 1} ${n + 1}`);

    parts.push(`<defs>
      <radialGradient id="b" cx=".35" cy=".3" r=".7"><stop offset="0" stop-color="#666"/><stop offset="1" stop-color="#111"/></radialGradient>
      <radialGradient id="w" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cfcac0"/></radialGradient>
    </defs>`);
    parts.push(`<rect width="${n + 1}" height="${n + 1}" fill="#dcb46c"/>`);
    for (let i = 1; i <= n; i++) {
      parts.push(`<line x1="1" y1="${i}" x2="${n}" y2="${i}" stroke="#5a3e1b" stroke-width=".03"/>`);
      parts.push(`<line x1="${i}" y1="1" x2="${i}" y2="${n}" stroke="#5a3e1b" stroke-width=".03"/>`);
    }
    for (const sx of STAR[n] ?? []) for (const sy of STAR[n] ?? []) {
      if (n === 9 && (sx === 4) !== (sy === 4)) continue; // 9路は四隅+天元
      parts.push(`<circle cx="${sx + 1}" cy="${sy + 1}" r=".09" fill="#5a3e1b"/>`);
    }

    p.board.forEach((c, i) => {
      if (!c) return;
      const [x, y] = xy(i);
      parts.push(`<circle cx="${x}" cy="${y}" r=".47" fill="url(#${c === 1 ? "b" : "w"})" stroke="${c === 1 ? "#000" : "#999"}" stroke-width=".02"/>`);
    });

    if (p.lastPoint !== null) {
      const [x, y] = xy(p.lastPoint);
      const c = p.board[p.lastPoint];
      parts.push(`<circle cx="${x}" cy="${y}" r=".18" fill="none" stroke="${c === 1 ? "#fff" : "#000"}" stroke-width=".06"/>`);
    }

    if (p.ownership) {
      p.ownership.forEach((o, i) => {
        if (!o || p.board[i] === o) return;
        const [x, y] = xy(i);
        parts.push(`<rect x="${x - 0.17}" y="${y - 0.17}" width=".34" height=".34" fill="${o === 1 ? "#111" : "#fff"}" opacity=".8"/>`);
      });
    }

    for (const pin of p.pins) {
      const [x, y] = xy(pin.point);
      parts.push(`<g class="pin" transform="translate(${x} ${y})">
        <circle r=".36" fill="#e8463c" fill-opacity=".85" stroke="#fff" stroke-width=".05"/>
        <text y=".15" text-anchor="middle" fill="#fff">${escapeXml([...pin.by][0] ?? "?")}</text>
      </g>`);
    }

    if (this.hover !== null && !p.board[this.hover]) {
      const [x, y] = xy(this.hover);
      if (p.pinHover) parts.push(`<circle cx="${x}" cy="${y}" r=".3" fill="#e8463c" opacity=".45"/>`);
      else if (p.hoverColor) parts.push(`<circle cx="${x}" cy="${y}" r=".47" fill="${p.hoverColor === 1 ? "#000" : "#fff"}" opacity=".45"/>`);
    }

    this.svg.innerHTML = parts.join("");
  }
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

customElements.define("go-board", GoBoard);
