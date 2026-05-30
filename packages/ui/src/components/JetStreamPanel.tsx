import { useEffect, useMemo, useState } from "react";
import { api, type Stream, type Consumer, type Message } from "../api.js";
import { useJetStreamMessages } from "../useJetStreamMessages.js";
import { MessageViewer } from "./MessageViewer.js";
import { Loading, Empty, ErrorState } from "./states.js";

export function JetStreamPanel({ connected }: { connected: boolean }) {
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [consumers, setConsumers] = useState<Consumer[] | null>(null);
  const [consumersError, setConsumersError] = useState<string | null>(null);
  const [activeConsumer, setActiveConsumer] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<Message | null>(null);
  const live = useJetStreamMessages();

  const [fSubject, setFSubject] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fText, setFText] = useState("");

  const subjects = useMemo(
    () => [...new Set(live.messages.map((m) => m.subject))].sort(),
    [live.messages],
  );

  const filtered = useMemo(() => {
    const q = fText.trim().toLowerCase();
    const from = fFrom ? Date.parse(fFrom) : null;
    const to = fTo ? Date.parse(fTo) : null;
    return live.messages.filter((m) => {
      if (fSubject && m.subject !== fSubject) return false;
      if (from != null && m.timestamp < from) return false;
      if (to != null && m.timestamp > to) return false;
      if (q && !m.subject.toLowerCase().includes(q) && !m.data.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [live.messages, fSubject, fFrom, fTo, fText]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    api
      .listStreams()
      .then(setStreams)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (connected) refresh();
    else {
      setStreams(null);
      setSelected(null);
      setConsumers(null);
      setActiveConsumer(null);
      live.unsubscribe();
    }
  }, [connected]);

  useEffect(() => {
    if (!selected) return;
    setConsumers(null);
    setConsumersError(null);
    setActiveConsumer(null);
    live.unsubscribe();
    api
      .listConsumers(selected)
      .then(setConsumers)
      .catch((e) => setConsumersError(e.message));
  }, [selected]);

  const inspect = (c: Consumer) => {
    setActiveConsumer(c.name);
    setSelectedMsg(null);
    live.subscribe(c.stream, c.filterSubjects);
  };

  const closeMessages = () => {
    setActiveConsumer(null);
    setSelectedMsg(null);
    live.unsubscribe();
  };

  if (!connected) return <Empty label="Connect to inspect JetStream streams." />;

  return (
    <div className="js">
      <div className="js__head">
        <h3>Streams</h3>
        <button onClick={refresh}>Refresh</button>
      </div>

      {loading && <Loading />}
      {error && <ErrorState message={error} />}
      {streams && streams.length === 0 && <Empty label="No streams in this context." />}

      {streams && streams.length > 0 && (
        <table className="js__table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Subjects</th>
              <th>Messages</th>
              <th>Bytes</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {streams.map((s) => (
              <tr
                key={s.name}
                className={selected === s.name ? "js__row--active" : ""}
                onClick={() => setSelected(s.name)}
              >
                <td>{s.name}</td>
                <td className="js__subjects">{s.subjects.join(", ")}</td>
                <td>{s.messages}</td>
                <td>{s.bytes}</td>
                <td>{s.lastTs ? new Date(s.lastTs).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <div className="js__consumers">
          <h3>Consumers · {selected}</h3>
          {consumersError && <ErrorState message={consumersError} />}
          {!consumers && !consumersError && <Loading />}
          {consumers && consumers.length === 0 && <Empty label="No consumers on this stream." />}
          {consumers && consumers.length > 0 && (
            <table className="js__table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Durable</th>
                  <th>Kind</th>
                  <th>Pending</th>
                  <th>Ack pending</th>
                  <th>Redelivered</th>
                  <th>Last seq</th>
                </tr>
              </thead>
              <tbody>
                {consumers.map((c) => (
                  <tr
                    key={c.name}
                    className={activeConsumer === c.name ? "js__row--active" : ""}
                    onClick={() => inspect(c)}
                  >
                    <td>{c.name}</td>
                    <td>{c.durableName ?? "—"}</td>
                    <td>{c.deliveryKind}</td>
                    <td>{c.pending}</td>
                    <td>{c.ackPending}</td>
                    <td>{c.redelivered}</td>
                    <td>{c.lastDelivered ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeConsumer && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="overlay__head">
            <div className="overlay__title">
              <h3>{activeConsumer}</h3>
              <span className="overlay__sub">{selected}</span>
              <span className={`core__ws core__ws--${live.status}`}>
                {live.stream ? "live" : "stopped"} · {filtered.length}/{live.messages.length} msg
              </span>
            </div>
            <div className="overlay__actions">
              {live.messages.length > 0 && <button onClick={live.clear}>Clear</button>}
              <button className="overlay__close" onClick={closeMessages}>
                ✕ Close
              </button>
            </div>
          </div>
          {live.error && <ErrorState message={live.error} />}
          <div className="overlay__filters">
            <select value={fSubject} onChange={(e) => setFSubject(e.target.value)}>
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
              value={fText}
              onChange={(e) => setFText(e.target.value)}
            />
            <label>
              From
              <input
                type="datetime-local"
                value={fFrom}
                onChange={(e) => setFFrom(e.target.value)}
              />
            </label>
            <label>
              To
              <input type="datetime-local" value={fTo} onChange={(e) => setFTo(e.target.value)} />
            </label>
            {(fSubject || fText || fFrom || fTo) && (
              <button
                onClick={() => {
                  setFSubject("");
                  setFText("");
                  setFFrom("");
                  setFTo("");
                }}
              >
                Reset
              </button>
            )}
          </div>
          <div className="overlay__body">
            <div className="overlay__list">
              {filtered.length === 0 ? (
                <Empty
                  label={live.messages.length ? "No messages match the filters." : "No stored messages yet…"}
                />
              ) : (
                <ul>
                  {filtered.map((m) => (
                    <li
                      key={m.id}
                      className={`msg ${selectedMsg?.id === m.id ? "msg--active" : ""}`}
                      onClick={() => setSelectedMsg(m)}
                    >
                      <span className="msg__time">{new Date(m.timestamp).toLocaleTimeString()}</span>
                      {m.seq != null && <span className="msg__seq">#{m.seq}</span>}
                      <span className="msg__subject">{m.subject}</span>
                      <span className="msg__preview">{m.data.slice(0, 80)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="overlay__viewer">
              <MessageViewer message={selectedMsg} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
