import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "./api.js";
import type { WsStatus } from "./useLiveMessages.js";

const MAX_BUFFER = 500;

/** Replay + live messages for a JetStream stream, over the API bridge WebSocket. */
export function useJetStreamMessages() {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WsStatus>("idle");
  const [stream, setStream] = useState<string | null>(null);
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
      if (data.type === "js_message") {
        setMessages((prev) => [data.message, ...prev].slice(0, MAX_BUFFER));
      } else if (data.type === "error") {
        setError(data.error?.message ?? "stream error");
      }
    };
    return () => ws.close();
  }, []);

  const subscribe = useCallback(
    (next: string, filterSubjects: string[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== ws.OPEN) return;
      if (stream) ws.send(JSON.stringify({ action: "js_unsubscribe", stream }));
      setMessages([]);
      setError(null);
      setStream(next);
      ws.send(JSON.stringify({ action: "js_subscribe", stream: next, filterSubjects }));
    },
    [stream],
  );

  const unsubscribe = useCallback(() => {
    const ws = wsRef.current;
    if (ws && stream && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ action: "js_unsubscribe", stream }));
    }
    setStream(null);
  }, [stream]);

  const clear = useCallback(() => setMessages([]), []);

  return { status, stream, messages, error, subscribe, unsubscribe, clear };
}
