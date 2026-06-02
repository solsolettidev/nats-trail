import { useEffect, useState } from "react";
import { isDlqSubject, parseDlqEvent } from "@nats-trail/core";
import { api, type Stream, type Message } from "../api.js";
import { useJetStreamMessages } from "../useJetStreamMessages.js";
import { MessageViewer } from "./MessageViewer.js";
import { MessageList, SplitWorkspace } from "./MessageList.js";
import { Loading, Empty, ErrorState } from "./states.js";
import { Icon, fmtInt } from "./ui.js";

function parseDlq(m: Message): { subject: string; preview: string } {
  const dlq = parseDlqEvent(m);
  return { subject: dlq.originalSubject ?? m.subject, preview: dlq.reason ?? m.data };
}

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

  if (!connected)
    return <Empty icon="skull" label="Not connected" hint="Connect to inspect dead-letter messages." />;
  if (error) return <ErrorState message={error} />;
  if (!streams) return <Loading />;

  return (
    <>
      <div className="panel__head">
        <Icon name="skull" weight="duotone" size={18} />
        <h3>Dead-letter sources</h3>
        <span className="count">{sources.length}</span>
        <span className="spacer" />
        {selected && live.messages.length > 0 && (
          <button className="btn btn--sm btn--ghost" onClick={live.clear}>
            <Icon name="eraser" /> Clear
          </button>
        )}
      </div>

      <div className="contexts__form" style={{ margin: 0 }}>
        <span className="flabel">Optional DLQ subjects (one per line)</span>
        <textarea
          className="input"
          style={{ height: "auto", minHeight: 56, paddingTop: 6, paddingBottom: 6, fontFamily: "var(--font-mono)" }}
          placeholder="errors.>  or  ORDERS.dlq"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onBlur={saveManual}
        />
        <button className="btn btn--sm" onClick={saveManual}>
          <Icon name="check" /> Save DLQ subjects
        </button>
      </div>

      {sources.length > 0 && (
        <div className="chips">
          {sources.map((s) => (
            <button
              key={s.stream}
              className="chip"
              style={{ paddingRight: 6 }}
              onClick={() => open(s.stream, s.subjects)}
            >
              <span
                className="chip__subject"
                style={{ color: selected === s.stream ? "var(--accent)" : "var(--text)" }}
              >
                {s.stream}
              </span>
              <span className="badge">{fmtInt(s.subjects.length)}</span>
            </button>
          ))}
        </div>
      )}

      {sources.length === 0 && (
        <Empty
          icon="check-circle"
          label="No dead-letter sources"
          hint="No dead-letter subjects detected. Add DLQ subjects above if needed."
        />
      )}

      {selected && live.error && <ErrorState message={live.error} />}

      {selected && (
        <SplitWorkspace
          viewerEmpty={!selectedMsg}
          list={
            live.messages.length === 0 ? (
              <Empty icon="check-circle" label="Empty" hint="No dead-letter messages on this source." />
            ) : (
              <MessageList
                messages={live.messages}
                selectedId={selectedMsg?.id}
                onSelect={setSelectedMsg}
                extract={parseDlq}
              />
            )
          }
          viewer={<MessageViewer message={selectedMsg} fullscreenable />}
        />
      )}
    </>
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
