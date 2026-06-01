import { useEffect, useState } from "react";
import { isDlqSubject, parseDlqEvent } from "@nats-trail/core";
import { api, type Stream, type Message } from "../api.js";
import { useJetStreamMessages } from "../useJetStreamMessages.js";
import { MessageViewer } from "./MessageViewer.js";
import { Loading, Empty, ErrorState } from "./states.js";

export function DlqPanel({ connected }: { connected: boolean }) {
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<Message | null>(null);
  const [manual, setManual] = useState("");
  const live = useJetStreamMessages();

  useEffect(() => {
    api.getPreferences().then((p) => setManual((p.dlqSubjects ?? []).join("\n"))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!connected) {
      setStreams(null);
      setSelected(null);
      live.unsubscribe();
      return;
    }
    setError(null);
    api.listStreams().then(setStreams).catch((e) => setError(e.message));
  }, [connected]);

  const sources = (streams ?? [])
    .map((s) => ({ stream: s.name, subjects: mergeSubjects(s.subjects.filter(isDlqSubject), manualSubjects(manual)) }))
    .filter((s) => s.subjects.length > 0);

  const saveManual = () => {
    api.savePreferences({ dlqSubjects: manualSubjects(manual) }).catch(() => {});
  };

  const open = (stream: string, subjects: string[]) => {
    setSelected(stream);
    setSelectedMsg(null);
    live.subscribe(stream, subjects);
  };

  if (!connected) return <Empty label="Connect to inspect dead-letter messages." />;
  if (error) return <ErrorState message={error} />;
  if (!streams) return <Loading />;

  return (
    <div className="dlq">
      <div className="filters">
        <textarea
          placeholder="Optional DLQ subjects, one per line e.g. errors.> or ORDERS.dlq"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onBlur={saveManual}
        />
        <button onClick={saveManual}>Save DLQ subjects</button>
      </div>
      {sources.length === 0 && <Empty label="No dead-letter subjects detected. Add DLQ subjects above if needed." />}
      <div className="dlq__sources">
        <h3>Dead-letter sources</h3>
        <ul>
          {sources.map((s) => (
            <li
              key={s.stream}
              className={`dlq__src ${selected === s.stream ? "dlq__src--active" : ""}`}
              onClick={() => open(s.stream, s.subjects)}
            >
              <span className="dlq__stream">{s.stream}</span>
              <span className="dlq__subjects">{s.subjects.join(", ")}</span>
            </li>
          ))}
        </ul>
      </div>

      {selected && (
        <div className="dlq__messages">
          <div className="dlq__head">
            <h3>{selected}</h3>
            <span className={`core__ws core__ws--${live.status}`}>
              {live.messages.length} msg
            </span>
            {live.messages.length > 0 && <button onClick={live.clear}>Clear</button>}
          </div>
          {live.error && <ErrorState message={live.error} />}
          <div className="core__split">
            <div className="core__list">
              {live.messages.length === 0 ? (
                <Empty label="No dead-letter messages." />
              ) : (
                <ul>
                  {live.messages.map((m) => {
                    const dlq = parseDlqEvent(m);
                    return (
                      <li
                        key={m.id}
                        className={`msg ${selectedMsg?.id === m.id ? "msg--active" : ""}`}
                        onClick={() => setSelectedMsg(m)}
                      >
                        <span className="msg__time">
                          {new Date(m.timestamp).toLocaleTimeString()}
                        </span>
                        <span className="msg__subject">
                          {dlq.originalSubject ?? m.subject}
                        </span>
                        <span className="msg__preview">{dlq.reason ?? m.data.slice(0, 80)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="core__viewer">
              <MessageViewer message={selectedMsg} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function manualSubjects(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergeSubjects(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}
