import type { ReactNode } from "react";
import type { Message } from "../api.js";
import { fmtTime, fmtInt } from "./ui.js";

interface ListProps {
  messages: Message[];
  selectedId?: string | null;
  onSelect: (m: Message) => void;
  showSeq?: boolean;
  extract?: (m: Message) => { subject: string; preview: string };
}

/** Shared message list. Rows are keyboard-navigable (arrow up/down). */
export function MessageList({ messages, selectedId, onSelect, showSeq, extract }: ListProps) {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const idx = messages.findIndex((m) => m.id === selectedId);
    const next = e.key === "ArrowDown" ? Math.min(messages.length - 1, idx + 1) : Math.max(0, idx - 1);
    if (messages[next]) onSelect(messages[next]);
  };
  return (
    <div className="list">
      <div className="list__head">
        <span>Time</span>
        <span>Subject</span>
        <span>{showSeq ? "Seq" : ""}</span>
      </div>
      <ul role="listbox" aria-label="Messages" onKeyDown={onKey}>
        {messages.map((m) => {
          const ex = extract ? extract(m) : { subject: m.subject, preview: m.data };
          const active = selectedId === m.id;
          return (
            <li
              key={m.id}
              className={"msg" + (active ? " msg--active" : "")}
              role="option"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(m)}
            >
              <span className="msg__time">{fmtTime(m.timestamp)}</span>
              <span className="msg__subject" title={ex.subject}>
                {ex.subject}
              </span>
              <span className="msg__right">
                {showSeq && m.seq != null && <span className="msg__seq">#{fmtInt(m.seq)}</span>}
                <span
                  className={"msg__type" + (m.isJson ? " msg__type--json" : "")}
                  title={m.isJson ? "JSON" : "text"}
                />
              </span>
              <span className="msg__preview">{ex.preview ? ex.preview.slice(0, 120) : "—"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Split workspace shell honoring orientation (side | stack | drawer). */
export function SplitWorkspace({
  split = "side",
  list,
  viewer,
  viewerEmpty,
}: {
  split?: "side" | "stack" | "drawer";
  list: ReactNode;
  viewer: ReactNode;
  viewerEmpty?: boolean;
}) {
  return (
    <div className="split" data-split={split}>
      <div className="split__list">{list}</div>
      <div className={"split__viewer" + (split === "drawer" && viewerEmpty ? " is-empty" : "")}>
        {viewer}
      </div>
    </div>
  );
}
