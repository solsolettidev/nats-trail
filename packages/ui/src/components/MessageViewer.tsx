import { useState } from "react";
import { formatPayload, type Message } from "../api.js";

export function MessageViewer({ message }: { message: Message | null }) {
  const [copied, setCopied] = useState(false);
  if (!message) return <div className="state state--empty">Select a message</div>;

  const text = formatPayload(message);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="viewer">
      <div className="viewer__head">
        <div className="viewer__meta">
          <span className="viewer__subject">{message.subject}</span>
          <span className="viewer__badges">
            <span className={`tag tag--${message.isJson ? "json" : "text"}`}>
              {message.isJson ? "JSON" : "text"}
            </span>
            <span className="tag">{message.size} B</span>
            {message.seq != null && <span className="tag">seq {message.seq}</span>}
          </span>
        </div>
        <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre className="viewer__body">{text}</pre>
    </div>
  );
}
