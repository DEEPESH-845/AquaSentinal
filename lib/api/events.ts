/**
 * /ws/events client: versioned envelopes, heartbeat, exponential reconnect, and replay of anything missed while
 * disconnected (the server keeps a short history keyed by seq). Malformed frames are dropped, never thrown.
 */
import { BACKEND_URL } from "./client";
import type { EventEnvelope } from "./types";

export type SocketState = "CONNECTING" | "OPEN" | "CLOSED";

export function connectEvents(onEvent: (e: EventEnvelope) => void, onState: (s: SocketState) => void): () => void {
  const url = BACKEND_URL.replace(/^http/, "ws") + "/ws/events";
  let ws: WebSocket | null = null;
  let lastSeq = 0;
  let delay = 1000;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const open = () => {
    if (disposed) return;
    onState("CONNECTING");
    ws = new WebSocket(`${url}?since=${lastSeq}`);
    ws.onopen = () => {
      delay = 1000;
      onState("OPEN");
      ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 15_000);
    };
    ws.onmessage = (m) => {
      let env: EventEnvelope;
      try {
        env = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (!env || env.v !== 1 || typeof env.type !== "string") return;
      if (typeof env.seq === "number") lastSeq = Math.max(lastSeq, env.seq);
      onEvent(env);
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      onState("CLOSED");
      if (disposed) return;
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    disposed = true;
    if (retry) clearTimeout(retry);
    if (ping) clearInterval(ping);
    ws?.close();
  };
}
