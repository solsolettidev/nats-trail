import type { DLQEvent, Message } from "./types.js";

/** Heuristic, vendor-agnostic guess at whether a stream subject carries dead-letter messages. */
export function isDlqSubject(subject: string): boolean {
  const s = subject.toLowerCase();
  return s.includes("dlq") || s.includes("dead");
}

// Common payload keys seen across DLQ conventions; checked in order, first hit wins.
const SUBJECT_KEYS = ["original_subject", "originalSubject", "orig_subject", "subject"];
const REASON_KEYS = ["reason", "error", "error_message", "errorMessage", "message", "cause"];

/** Best-effort extraction of DLQ metadata from a message payload; fields are null when absent. */
export function parseDlqEvent(message: Message): DLQEvent {
  const obj =
    message.isJson && message.json && typeof message.json === "object"
      ? (message.json as Record<string, unknown>)
      : null;
  const pick = (keys: string[]): string | null => {
    if (!obj) return null;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number") return String(v);
    }
    return null;
  };
  return { message, originalSubject: pick(SUBJECT_KEYS), reason: pick(REASON_KEYS) };
}
