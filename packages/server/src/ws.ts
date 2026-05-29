import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Subscription } from "nats";
import { parseMessage, normalizeError } from "@nats-trail/core";
import { connectionManager } from "./connection.js";

const decoder = new TextDecoder();

interface ClientMsg {
  action: "subscribe" | "unsubscribe";
  subject?: string;
}

/** Attach the live-subscription WebSocket server at /ws. */
export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    const subs = new Map<string, Subscription>();

    const send = (payload: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send({ type: "error", error: { code: "bad_request", message: "invalid json" } });
      }

      if (msg.action === "subscribe" && msg.subject) {
        subscribe(msg.subject);
      } else if (msg.action === "unsubscribe" && msg.subject) {
        unsubscribe(msg.subject);
      }
    });

    ws.on("close", () => {
      for (const sub of subs.values()) sub.unsubscribe();
      subs.clear();
    });

    function subscribe(subject: string) {
      const nc = connectionManager.getConnection();
      if (!nc) {
        return send({ type: "error", error: { code: "not_connected", message: "Not connected to NATS" } });
      }
      if (subs.has(subject)) return;
      try {
        const sub = nc.subscribe(subject, {
          callback: (err, m) => {
            if (err) {
              send({ type: "error", error: normalizeError(err) });
              return;
            }
            const message = parseMessage({
              subject: m.subject,
              data: decoder.decode(m.data),
              timestamp: Date.now(),
              size: m.data.length,
              reply: m.reply,
            });
            send({ type: "message", subject, message });
          },
        });
        subs.set(subject, sub);
        send({ type: "subscribed", subject });
      } catch (err) {
        send({ type: "error", error: normalizeError(err) });
      }
    }

    function unsubscribe(subject: string) {
      const sub = subs.get(subject);
      if (sub) {
        sub.unsubscribe();
        subs.delete(subject);
        send({ type: "unsubscribed", subject });
      }
    }
  });
}
