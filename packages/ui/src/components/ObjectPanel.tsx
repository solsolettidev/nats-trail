import { useEffect, useMemo, useState } from "react";
import { api, type ObjectBucket, type ObjectEntry } from "../api.js";
import { Loading, Empty, ErrorState } from "./states.js";
import { Badge, Icon, fmtBytes, fmtInt, fmtRelative } from "./ui.js";

/** Bucket TTL is reported in nanoseconds; 0 means unset. */
function fmtTtl(ns: number): string {
  if (!ns) return "—";
  const s = ns / 1e9;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function ObjectPanel({ connected }: { connected: boolean }) {
  const [buckets, setBuckets] = useState<ObjectBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [objects, setObjects] = useState<ObjectEntry[] | null>(null);
  const [query, setQuery] = useState("");

  const load = () => {
    setError(null);
    api.listObjectBuckets().then(setBuckets).catch((e) => setError(e.message));
  };

  useEffect(() => {
    if (!connected) {
      setBuckets(null);
      setSelected(null);
      setObjects(null);
      return;
    }
    load();
  }, [connected]);

  const openBucket = (bucket: string) => {
    setSelected(bucket);
    setObjects(null);
    api.listObjects(bucket).then(setObjects).catch((e) => setError(e.message));
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !objects) return objects ?? [];
    return objects.filter((o) => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q));
  }, [objects, query]);

  if (!connected) {
    return <Empty icon="archive" label="Not connected" hint="Connect to browse Object Store buckets." />;
  }
  if (error) return <ErrorState message={error} />;
  if (!buckets) return <Loading label="Loading buckets…" />;

  return (
    <>
      <div className="panel__head">
        <Icon name="archive" weight="duotone" size={18} />
        <h3>Object buckets</h3>
        <span className="count">{buckets.length}</span>
        <span className="spacer" />
        <button className="btn btn--sm" onClick={load}>
          <Icon name="arrows-clockwise" /> Refresh
        </button>
      </div>

      {buckets.length === 0 ? (
        <Empty icon="archive" label="No object buckets" hint="This context has no Object Store buckets." />
      ) : (
        <div className="tablewrap" style={{ flex: "0 0 auto", maxHeight: "34%" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Bucket</th>
                <th className="num">Objects</th>
                <th className="num">Size</th>
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
                      <Icon name="archive" /> {b.name}
                    </span>
                    {b.description && <span className="dim"> · {b.description}</span>}
                  </td>
                  <td className="num">{fmtInt(b.objects)}</td>
                  <td className="num num--muted">{fmtBytes(b.bytes)}</td>
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
                      <Icon name="arrow-line-up-right" /> Objects
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
            <Icon name="files" size={16} />
            <h3>Objects</h3>
            <span className="dim">· {selected}</span>
            {objects && <span className="count">{fmtInt(filtered.length)}</span>}
            <span className="spacer" />
            <div className="field" style={{ maxWidth: 260 }}>
              <Icon name="magnifying-glass" />
              <input
                className="input"
                type="search"
                placeholder="Filter objects…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          {!objects ? (
            <Loading label="Loading objects…" />
          ) : filtered.length === 0 ? (
            <Empty icon="archive" label="No objects" hint={query ? "No object matches the filter." : "This bucket is empty."} />
          ) : (
            <div className="tablewrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th className="num">Size</th>
                    <th className="num">Chunks</th>
                    <th>Updated</th>
                    <th>Digest</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((o) => (
                    <tr key={o.name}>
                      <td>
                        <span className="name">{o.name}</span>
                        {o.deleted && (
                          <>
                            {" "}
                            <Badge variant="err">deleted</Badge>
                          </>
                        )}
                        {o.description && <div className="dim">{o.description}</div>}
                      </td>
                      <td className="num">{fmtBytes(o.size)}</td>
                      <td className="num num--muted">{fmtInt(o.chunks)}</td>
                      <td className="num--muted">{o.timestamp ? fmtRelative(o.timestamp) : "—"}</td>
                      <td className="subjects" title={o.digest}>
                        <span className="kv-value">{o.digest.slice(0, 24)}…</span>
                      </td>
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
