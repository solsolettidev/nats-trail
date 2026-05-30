import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { DeliverPolicy, AckPolicy } from "nats";
import type { Subscription, ConsumerMessages, ConsumerConfig } from "nats";
import { parseMessage, normalizeError } from "@nats-trail/core";
import { connectionManager } from "./connection.js";

const decoder = new TextDecoder();

interface ClientMsg {
  action: "subscribe" | "unsubscribe" | "js_subscribe" | "js_unsubscribe";
  subject?: string;
  stream?: string;
  filterSubjects?: string[];
}

/** Attach the live-subscription WebSocket server at /ws. */
export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    const subs = new Map<string, Subscription>();
    const jsSubs = new Map<string, JsTail>();

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
      } else if (msg.action === "js_subscribe" && msg.stream) {
        jsSubscribe(msg.stream, msg.filterSubjects ?? []);
      } else if (msg.action === "js_unsubscribe" && msg.stream) {
        jsUnsubscribe(msg.stream);
      }
    });

    ws.on("close", () => {
      for (const sub of subs.values()) sub.unsubscribe();
      subs.clear();
      for (const tail of jsSubs.values()) stopTail(tail);
      jsSubs.clear();
    });

    function deleteConsumer(stream: string, name: string | null): void {
      if (!name) return;
      const nc = connectionManager.getConnection();
      nc?.jetstreamManager()
        .then((jsm) => jsm.consumers.delete(stream, name))
        .catch(() => {});
    }

    function stopTail(tail: JsTail): void {
      tail.stopped = true;
      tail.iter?.stop();
      deleteConsumer(tail.stream, tail.consumerName);
    }

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

    // Replay history + tail live via our own ephemeral pull consumer (ack-none),
    // filtered server-side by the real consumer's subjects. These streams use
    // Limits retention, so an overlapping ephemeral consumer is allowed and
    // never disturbs the real durable consumer's state. DeliverPolicy.All
    // replays everything stored, then the same iterator continues live.
    //
    // We create the consumer explicitly (instead of an ordered consumer) because
    // nats.js ordered consumers don't work against this server: consume() never
    // resolves and delivers nothing. A plain ephemeral consumer pulled by name works.
    async function jsSubscribe(stream: string, filterSubjects: string[]) {
      const nc = connectionManager.getConnection();
      if (!nc) {
        return send({ type: "error", error: { code: "not_connected", message: "Not connected to NATS" } });
      }
      if (jsSubs.has(stream)) return;

      const tail: JsTail = { stopped: false, iter: null, stream, consumerName: null };
      jsSubs.set(stream, tail);
      send({ type: "js_subscribed", stream });

      try {
        const jsm = await nc.jetstreamManager();
        const js = nc.jetstream();
        const cfg: Partial<ConsumerConfig> = {
          deliver_policy: DeliverPolicy.All,
          ack_policy: AckPolicy.None,
          inactive_threshold: 5 * 60 * 1_000_000_000, // 5 min in ns; teardown also deletes it
        };
        if (filterSubjects.length === 1) cfg.filter_subject = filterSubjects[0];
        else if (filterSubjects.length > 1) cfg.filter_subjects = filterSubjects;
        console.log(`[js_subscribe] stream=${stream} filters=${JSON.stringify(filterSubjects)}`);

        const ci = await jsm.consumers.add(stream, cfg);
        tail.consumerName = ci.name;
        const consumer = await js.consumers.get(stream, ci.name);
        const iter = await consumer.consume();
        if (tail.stopped) {
          iter.stop();
          deleteConsumer(stream, ci.name);
          return;
        }
        tail.iter = iter;

        let count = 0;
        (async () => {
          for await (const m of iter) {
            if (tail.stopped) break;
            count++;
            if (count === 1 || count % 200 === 0) {
              console.log(`[js_subscribe] ${stream} delivered=${count} seq=${m.seq} subject=${m.subject}`);
            }
            send({
              type: "js_message",
              stream,
              message: parseMessage({
                subject: m.subject,
                data: decoder.decode(m.data),
                timestamp: m.info?.timestampNanos ? Math.round(m.info.timestampNanos / 1e6) : Date.now(),
                size: m.data.length,
                seq: m.seq,
              }),
            });
          }
          console.log(`[js_subscribe] ${stream} iterator ended, total delivered=${count}`);
        })().catch((err) => {
          console.error(`[js_subscribe] ${stream} consume error:`, err);
          send({ type: "error", error: normalizeError(err) });
        });
      } catch (err) {
        console.error(`[js_subscribe] ${stream} setup error:`, err);
        deleteConsumer(stream, tail.consumerName);
        jsSubs.delete(stream);
        send({ type: "error", error: normalizeError(err) });
      }
    }

    function jsUnsubscribe(stream: string) {
      const tail = jsSubs.get(stream);
      if (tail) {
        stopTail(tail);
        jsSubs.delete(stream);
        send({ type: "js_unsubscribed", stream });
      }
    }
  });
}

interface JsTail {
  stopped: boolean;
  iter: ConsumerMessages | null;
  stream: string;
  consumerName: string | null;
}
