import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "./api.js";

const MAX_BUFFER = 500;

export type WsStatus = "idle" | "open" | "closed";

/** Live subject subscription over the API bridge WebSocket. */
export function useLiveMessages() {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WsStatus>("idle");
  const [subject, setSubject] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => setStatus("open");
    ws.onclose = () => setStatus("closed");
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "message") {
        setMessages((prev) => [data.message, ...prev].slice(0, MAX_BUFFER));
      } else if (data.type === "error") {
        setError(data.error?.message ?? "subscription error");
      }
    };
    return () => ws.close();
  }, []);

  const subscribe = useCallback(
    (next: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== ws.OPEN) return;
      if (subject) ws.send(JSON.stringify({ action: "unsubscribe", subject }));
      setMessages([]);
      setError(null);
      setSubject(next);
      ws.send(JSON.stringify({ action: "subscribe", subject: next }));
    },
    [subject],
  );

  const unsubscribe = useCallback(() => {
    const ws = wsRef.current;
    if (ws && subject && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ action: "unsubscribe", subject }));
    }
    setSubject(null);
  }, [subject]);

  const clear = useCallback(() => setMessages([]), []);

  return { status, subject, messages, error, subscribe, unsubscribe, clear };
}
