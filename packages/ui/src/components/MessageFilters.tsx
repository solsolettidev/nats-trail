import { useMemo } from "react";
import { getPath } from "@nats-trail/core";
import type { Message } from "../api.js";

export interface FilterState {
  subject: string;
  text: string;
  from: string;
  to: string;
  eventType: string;
}

export const emptyFilters: FilterState = { subject: "", text: "", from: "", to: "", eventType: "" };

/** Apply the UI filter state to a message buffer. */
export function applyFilters(messages: Message[], f: FilterState): Message[] {
  const q = f.text.trim().toLowerCase();
  const from = f.from ? Date.parse(f.from) : null;
  const to = f.to ? Date.parse(f.to) : null;
  const et = f.eventType.trim();
  const [etPath, etValue] = et.includes("=") ? splitOnce(et, "=") : ["type", et];

  return messages.filter((m) => {
    if (f.subject && m.subject !== f.subject) return false;
    if (from != null && m.timestamp < from) return false;
    if (to != null && m.timestamp > to) return false;
    if (q && !m.subject.toLowerCase().includes(q) && !m.data.toLowerCase().includes(q)) return false;
    if (et) {
      if (!m.isJson) return false;
      if (String(getPath(m.json, etPath)) !== etValue) return false;
    }
    return true;
  });
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

interface Props {
  messages: Message[];
  value: FilterState;
  onChange: (next: FilterState) => void;
}

export function MessageFilters({ messages, value, onChange }: Props) {
  const subjects = useMemo(
    () => [...new Set(messages.map((m) => m.subject))].sort(),
    [messages],
  );
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });
  const dirty = value.subject || value.text || value.from || value.to || value.eventType;

  return (
    <div className="filters">
      <select value={value.subject} onChange={(e) => set({ subject: e.target.value })}>
        <option value="">All subjects ({subjects.length})</option>
        {subjects.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <input
        type="search"
        placeholder="Search subject or payload…"
        value={value.text}
        onChange={(e) => set({ text: e.target.value })}
      />
      <input
        type="text"
        placeholder="Event type e.g. type=order.created"
        value={value.eventType}
        onChange={(e) => set({ eventType: e.target.value })}
      />
      <label>
        From
        <input type="datetime-local" value={value.from} onChange={(e) => set({ from: e.target.value })} />
      </label>
      <label>
        To
        <input type="datetime-local" value={value.to} onChange={(e) => set({ to: e.target.value })} />
      </label>
      {dirty && <button onClick={() => onChange(emptyFilters)}>Reset</button>}
    </div>
  );
}
