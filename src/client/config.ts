// 接続先の決め方。ブラウザでは配信元と同じオリジンの API を使う。
// Capacitor でラップしたネイティブアプリでは、ページは端末内(https://localhost / capacitor://localhost)から
// 読まれるので、API と招待リンクは公開中の Cloudflare Workers を指す。
declare const __GO3V3_API_ORIGIN__: string | undefined;

/** ネイティブアプリ(Capacitor)の中で動いているか。Capacitor が WebView に window.Capacitor を差し込む */
export const IS_NATIVE: boolean = !!(globalThis as any).Capacitor?.isNativePlatform?.();

/** ネイティブアプリが使う API の既定値。ビルド時に GO3V3_API_ORIGIN で差し替えられる */
const NATIVE_API_ORIGIN = (typeof __GO3V3_API_ORIGIN__ === "string" && __GO3V3_API_ORIGIN__) || "https://go3v3.shimeji9.workers.dev";

/** HTTP の API のオリジン(末尾スラッシュなし) */
export const API_ORIGIN: string = IS_NATIVE ? NATIVE_API_ORIGIN : location.origin;

/** WebSocket のオリジン */
export const WS_ORIGIN: string = API_ORIGIN.replace(/^http/, "ws");

/** 友達に送る招待リンク。アプリからでもブラウザで開けるよう、Web版のURLにする */
export const inviteUrl = (code: string): string =>
  IS_NATIVE ? `${API_ORIGIN}/?room=${code}` : `${location.origin}${location.pathname}?room=${code}`;
