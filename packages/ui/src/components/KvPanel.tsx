import { useEffect, useMemo, useState } from "react";
import { api, type KvBucket, type KvEntry } from "../api.js";
import { Loading, Empty, ErrorState } from "./states.js";
import { Badge, Icon, fmtBytes, fmtInt, fmtRelative } from "./ui.js";

/** Per-key TTL is reported in nanoseconds; 0 means unset. */
function fmtTtl(ns: number): string {
  if (!ns) return "—";
  const s = ns / 1e9;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function OperationBadge({ operation }: { operation: KvEntry["operation"] }) {
  if (operation === "PUT") return <Badge>put</Badge>;
  return <Badge variant="err">{operation.toLowerCase()}</Badge>;
}

function EntryValue({ entry }: { entry: KvEntry }) {
  if (entry.operation !== "PUT") return <span className="dim">— deleted —</span>;
  const text = entry.isJson ? JSON.stringify(entry.json) : entry.value;
  return (
    <span className="kv-value">
      {text}
      {entry.truncated && <span className="dim"> …truncated</span>}
    </span>
  );
}

export function KvPanel({ connected }: { connected: boolean }) {
  const [buckets, setBuckets] = useState<KvBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<KvEntry[] | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [history, setHistory] = useState<KvEntry[] | null>(null);
  const [query, setQuery] = useState("");

  const load = () => {
    setError(null);
    api.listKvBuckets().then(setBuckets).catch((e) => setError(e.message));
  };

  useEffect(() => {
    if (!connected) {
      setBuckets(null);
      setSelected(null);
      setEntries(null);
      setHistoryKey(null);
      return;
    }
    load();
  }, [connected]);

  const openBucket = (bucket: string) => {
    setSelected(bucket);
    setEntries(null);
    setHistoryKey(null);
    setHistory(null);
    api.listKvKeys(bucket).then(setEntries).catch((e) => setError(e.message));
  };

  const openHistory = (key: string) => {
    if (!selected) return;
    setHistoryKey(key);
    setHistory(null);
    api.kvHistory(selected, key).then(setHistory).catch((e) => setError(e.message));
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !entries) return entries ?? [];
    return entries.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
  }, [entries, query]);

  if (!connected) {
    return <Empty icon="key" label="Not connected" hint="Connect to browse Key/Value buckets." />;
  }
  if (error) return <ErrorState message={error} />;
  if (!buckets) return <Loading label="Loading buckets…" />;

  return (
    <>
      <div className="panel__head">
        <Icon name="key" weight="duotone" size={18} />
        <h3>KV buckets</h3>
        <span className="count">{buckets.length}</span>
        <span className="spacer" />
        <button className="btn btn--sm" onClick={load}>
          <Icon name="arrows-clockwise" /> Refresh
        </button>
      </div>

      {buckets.length === 0 ? (
        <Empty icon="key" label="No KV buckets" hint="This context has no Key/Value buckets." />
      ) : (
        <div className="tablewrap" style={{ flex: "0 0 auto", maxHeight: "34%" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Bucket</th>
                <th className="num">Values</th>
                <th className="num">Size</th>
                <th className="num">History</th>
                <th className="num">TTL</th>
                <th>Config</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr
                  key={b.name}
                  className={selected === b.name ? "is-active" : ""}
                  onClick={() => openBucket(b.name)}
                >
                  <td>
                    <span className="stream-name name">
                      <Icon name="key" /> {b.name}
                    </span>
                  </td>
                  <td className="num">{fmtInt(b.values)}</td>
                  <td className="num num--muted">{fmtBytes(b.bytes)}</td>
                  <td className="num num--muted">{fmtInt(b.history)}</td>
                  <td className="num num--muted">{fmtTtl(b.ttl)}</td>
                  <td className="subjects">
                    {b.storage} · r{b.replicas} · {b.stream}
                  </td>
                  <td>
                    <button
                      className="btn btn--sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        openBucket(b.name);
                      }}
                    >
                      <Icon name="arrow-line-up-right" /> Keys
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
          <div className="panel__head">
            <Icon name="list-magnifying-glass" size={16} />
            <h3>Keys</h3>
            <span className="dim">· {selected}</span>
            {entries && <span className="count">{fmtInt(filtered.length)}</span>}
            <span className="spacer" />
            <div className="field" style={{ maxWidth: 260 }}>
              <Icon name="magnifying-glass" />
              <input
                className="input"
                type="search"
                placeholder="Filter keys & values…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          {!entries ? (
            <Loading label="Loading keys…" />
          ) : filtered.length === 0 ? (
            <Empty icon="key" label="No keys" hint={query ? "No key matches the filter." : "This bucket has no live keys."} />
          ) : (
            <div className="tablewrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                    <th className="num">Rev</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.key} className={historyKey === e.key ? "is-active" : ""}>
                      <td>
                        <span className="name">{e.key}</span>
                      </td>
                      <td className="subjects">
                        <EntryValue entry={e} />
                      </td>
                      <td className="num num--muted">{e.revision}</td>
                      <td className="num--muted">{fmtRelative(e.timestamp)}</td>
                      <td>
                        <button
                          className="btn btn--sm btn--ghost"
                          title="Revision history"
                          onClick={() => openHistory(e.key)}
                        >
                          <Icon name="clock-counter-clockwise" /> History
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

      {historyKey && (
        <>
          <div className="panel__head">
            <Icon name="clock-counter-clockwise" size={16} />
            <h3>History</h3>
            <span className="dim">· {historyKey}</span>
            {history && <span className="count">{history.length}</span>}
            <span className="spacer" />
            <button className="btn btn--sm btn--ghost" onClick={() => setHistoryKey(null)}>
              <Icon name="x" /> Close
            </button>
          </div>
          {!history ? (
            <Loading label="Loading history…" />
          ) : (
            <div className="tablewrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="num">Rev</th>
                    <th>Op</th>
                    <th>Value</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((e) => (
                    <tr key={e.revision}>
                      <td className="num">{e.revision}</td>
                      <td>
                        <OperationBadge operation={e.operation} />
                      </td>
                      <td className="subjects">
                        <EntryValue entry={e} />
                      </td>
                      <td className="num--muted">{fmtRelative(e.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
