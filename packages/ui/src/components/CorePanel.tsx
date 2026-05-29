import { useEffect, useState } from "react";
import type { Message } from "../api.js";
import { useLiveMessages } from "../useLiveMessages.js";
import { MessageViewer } from "./MessageViewer.js";
import { Empty, ErrorState } from "./states.js";

interface Props {
  connected: boolean;
  initialSubject: string | null;
  onSubjectChange: (subject: string) => void;
}

export function CorePanel({ connected, initialSubject, onSubjectChange }: Props) {
  const live = useLiveMessages();
  const [input, setInput] = useState(initialSubject ?? "");
  const [selected, setSelected] = useState<Message | null>(null);

  useEffect(() => {
    if (initialSubject) setInput(initialSubject);
  }, [initialSubject]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    live.subscribe(input.trim());
    onSubjectChange(input.trim());
  };

  if (!connected) return <Empty label="Connect to a context to subscribe to subjects." />;

  return (
    <div className="core">
      <form className="core__bar" onSubmit={submit}>
        <input
          placeholder="subject pattern e.g. orders.* or project.>"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit">Subscribe</button>
        {live.subject && (
          <button type="button" onClick={live.unsubscribe}>
            Stop
          </button>
        )}
        {live.messages.length > 0 && (
          <button type="button" onClick={live.clear}>
            Clear
          </button>
        )}
        <span className={`core__ws core__ws--${live.status}`}>
          {live.subject ? `live: ${live.subject}` : "not subscribed"}
        </span>
      </form>

      {live.error && <ErrorState message={live.error} />}

      <div className="core__split">
        <div className="core__list">
          {live.messages.length === 0 ? (
            <Empty label={live.subject ? "Waiting for messages…" : "Subscribe to a subject."} />
          ) : (
            <ul>
              {live.messages.map((m) => (
                <li
                  key={m.id}
                  className={`msg ${selected?.id === m.id ? "msg--active" : ""}`}
                  onClick={() => setSelected(m)}
                >
                  <span className="msg__time">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  <span className="msg__subject">{m.subject}</span>
                  <span className="msg__preview">{m.data.slice(0, 80)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="core__viewer">
          <MessageViewer message={selected} />
        </div>
      </div>
    </div>
  );
}
