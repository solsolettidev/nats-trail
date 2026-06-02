import { useEffect, useMemo, useState } from "react";
import { api, type Stream, type Consumer, type Message } from "../api.js";
import { useJetStreamMessages } from "../useJetStreamMessages.js";
import { MessageViewer } from "./MessageViewer.js";
import { MessageFilters, applyFilters, emptyFilters, type FilterState } from "./MessageFilters.js";
import { MessageList, SplitWorkspace } from "./MessageList.js";
import { Loading, Empty, ErrorState } from "./states.js";
import { Badge, Icon, fmtBytes, fmtInt } from "./ui.js";

function ConsumerHealth({ c }: { c: Consumer }) {
  if (c.redelivered > 0)
    return (
      <Badge variant="warn">
        <Icon name="warning" /> {fmtInt(c.redelivered)} redelivered
      </Badge>
    );
  if (c.pending > 200) return <Badge variant="warn">{fmtInt(c.pending)} pending</Badge>;
  return (
    <Badge variant="json">
      <Icon name="check" /> healthy
    </Badge>
  );
}

export function JetStreamPanel({ connected }: { connected: boolean }) {
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [consumers, setConsumers] = useState<Consumer[] | null>(null);
  const [consumersError, setConsumersError] = useState<string | null>(null);
  const [activeConsumer, setActiveConsumer] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<Message | null>(null);
  const live = useJetStreamMessages();

  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const filtered = useMemo(() => applyFilters(live.messages, filters), [live.messages, filters]);
  const [recentStreams, setRecentStreams] = useState<string[]>([]);

  useEffect(() => {
    api.getPreferences().then((p) => setRecentStreams(p.recentStreams ?? [])).catch(() => {});
  }, []);

  const select = (stream: string) => {
    setSelected(stream);
    const next = [stream, ...recentStreams.filter((s) => s !== stream)].slice(0, 8);
    setRecentStreams(next);
    api.savePreferences({ recentStreams: next }).catch(() => {});
  };

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
      setActiveSource(null);
      live.unsubscribe();
    }
  }, [connected]);

  useEffect(() => {
    if (!selected) return;
    setConsumers(null);
    setConsumersError(null);
    setActiveConsumer(null);
    setActiveSource(null);
    live.unsubscribe();
    api
      .listConsumers(selected)
      .then(setConsumers)
      .catch((e) => setConsumersError(e.message));
  }, [selected]);

  useEffect(() => {
    if (!activeSource) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMessages();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSource]);

  const inspect = (c: Consumer) => {
    setActiveConsumer(c.name);
    setActiveSource(c.name);
    setSelectedMsg(null);
    live.subscribe(c.stream, c.filterSubjects);
  };

  const inspectStream = (s: Stream) => {
    select(s.name);
    setActiveConsumer(null);
    setActiveSource(s.name);
    setSelectedMsg(null);
    live.subscribe(s.name, s.subjects);
  };

  const closeMessages = () => {
    setActiveConsumer(null);
    setActiveSource(null);
    setSelectedMsg(null);
    live.unsubscribe();
  };

  if (!connected)
    return (
      <Empty icon="stack" label="Not connected" hint="Connect to inspect JetStream streams and consumers." />
    );

  return (
    <>
      <div className="panel__head">
        <Icon name="stack" weight="duotone" size={18} />
        <h3>Streams</h3>
        {streams && <span className="count">{streams.length}</span>}
        <span className="spacer" />
        <button className="btn btn--sm" onClick={refresh}>
          <Icon name="arrows-clockwise" /> Refresh
        </button>
      </div>

      {recentStreams.length > 0 && (
        <div className="chips">
          <span className="chips__label">Recent</span>
          {recentStreams.map((s) => (
            <span key={s} className="chip">
              <button className="chip__subject" onClick={() => select(s)}>
                {s}
              </button>
            </span>
          ))}
        </div>
      )}

      {loading && <Loading />}
      {error && <ErrorState message={error} />}
      {streams && streams.length === 0 && (
        <Empty icon="stack" label="No streams" hint="No JetStream streams exist in this context." />
      )}

      {streams && streams.length > 0 && (
        <div className="tablewrap" style={{ flex: "0 0 auto", maxHeight: "38%" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Subjects</th>
                <th className="num">Messages</th>
                <th className="num">Size</th>
                <th className="num">Last seq</th>
                <th>Config</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {streams.map((s) => (
                <tr
                  key={s.name}
                  className={selected === s.name ? "is-active" : ""}
                  onClick={() => select(s.name)}
                >
                  <td>
                    <span className="stream-name name">
                      <Icon name="stack-simple" /> {s.name}
                    </span>
                  </td>
                  <td className="subjects" title={s.subjects.join(", ")}>
                    {s.subjects.join(", ")}
                  </td>
                  <td className="num">{fmtInt(s.messages)}</td>
                  <td className="num num--muted">{fmtBytes(s.bytes)}</td>
                  <td className="num num--muted">{fmtInt(s.lastSeq)}</td>
                  <td className="subjects">
                    {s.retention} · {s.storage} · r{s.replicas} · {formatLimit(s.maxMessages)} msgs ·{" "}
                    {formatLimit(s.maxBytes)} B
                  </td>
                  <td>
                    <button
                      className="btn btn--sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        inspectStream(s);
                      }}
                    >
                      <Icon name="arrow-line-up-right" /> Messages
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <>
          <div className="panel__head" style={{ marginTop: "var(--sp-1)" }}>
            <Icon name="users-three" weight="duotone" size={17} />
            <h3>Consumers</h3>
            <span className="count">· {selected}</span>
          </div>
          {consumersError && <ErrorState message={consumersError} />}
          {!consumers && !consumersError && <Loading />}
          {consumers && consumers.length === 0 && (
            <Empty icon="users-three" label="No consumers" hint={`No consumers are bound to ${selected}.`} />
          )}
          {consumers && consumers.length > 0 && (
            <div className="tablewrap" style={{ flex: 1 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Consumer</th>
                    <th>Durable</th>
                    <th>Kind</th>
                    <th className="num">Pending</th>
                    <th className="num">Ack pending</th>
                    <th className="num">Redelivered</th>
                    <th>Health</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {consumers.map((c) => (
                    <tr
                      key={c.name}
                      className={activeConsumer === c.name ? "is-active" : ""}
                      onClick={() => inspect(c)}
                    >
                      <td>
                        <span className="name mono" style={{ fontSize: "var(--fs-sm)" }}>
                          {c.name}
                        </span>
                        {!c.durableName && <Badge>ephemeral</Badge>}
                      </td>
                      <td className="num--muted">{c.durableName ?? "—"}</td>
                      <td>
                        <Badge>{c.deliveryKind}</Badge>
                      </td>
                      <td className="num">{fmtInt(c.pending)}</td>
                      <td className={"num" + (c.ackPending > 0 ? " num--warn" : " num--muted")}>
                        {fmtInt(c.ackPending)}
                      </td>
                      <td className={"num" + (c.redelivered > 0 ? " num--warn" : " num--muted")}>
                        {fmtInt(c.redelivered)}
                      </td>
                      <td>
                        <ConsumerHealth c={c} />
                      </td>
                      <td>
                        <button
                          className="btn btn--sm btn--icon"
                          title="Inspect messages"
                          onClick={(e) => {
                            e.stopPropagation();
                            inspect(c);
                          }}
                        >
                          <Icon name="arrow-line-up-right" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {activeSource && (
        <>
          <div className="scrim" onClick={closeMessages} />
          <div className="overlay" role="dialog" aria-modal="true" aria-label={`Source ${activeSource}`}>
            <div className="overlay__head">
              <div className="overlay__title">
                <h3>{activeSource}</h3>
                {selected && (
                  <span className="overlay__breadcrumb">
                    <Icon name="stack-simple" /> {selected}
                  </span>
                )}
              </div>
              <span className={"overlay__live" + (live.stream ? " is-open" : "")}>
                <span className="dot" />
                {live.stream ? "live" : "stopped"} · {fmtInt(filtered.length)}/{fmtInt(live.messages.length)} msg
              </span>
              <div className="overlay__actions">
                {live.messages.length > 0 && (
                  <button className="btn btn--sm btn--ghost" onClick={live.clear}>
                    <Icon name="eraser" /> Clear
                  </button>
                )}
                <button className="btn btn--sm btn--danger" onClick={closeMessages}>
                  <Icon name="x" /> Close
                </button>
              </div>
            </div>
            {live.error && <ErrorState message={live.error} />}
            <div className="overlay__filters">
              <MessageFilters messages={live.messages} value={filters} onChange={setFilters} />
            </div>
            <div className="overlay__body">
              <SplitWorkspace
                viewerEmpty={!selectedMsg}
                list={
                  filtered.length === 0 ? (
                    <Empty
                      icon="tray"
                      label={live.messages.length ? "No matches" : "No stored messages"}
                      hint={
                        live.messages.length
                          ? "No messages match the filters."
                          : "This source has no buffered messages yet."
                      }
                    />
                  ) : (
                    <MessageList
                      messages={filtered}
                      selectedId={selectedMsg?.id}
                      onSelect={setSelectedMsg}
                      showSeq
                    />
                  )
                }
                viewer={<MessageViewer message={selectedMsg} fullscreenable />}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}

function formatLimit(n: number): string {
  return n < 0 ? "∞" : String(n);
}
