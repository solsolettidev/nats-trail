import { useEffect, useState } from "react";
import { api, type ServerConnection, type ServerHealth } from "../api.js";
import { Loading, Empty, ErrorState } from "./states.js";
import { Badge, Icon, fmtBytes, fmtInt } from "./ui.js";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

export function ServerPanel({ connected }: { connected: boolean }) {
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [conns, setConns] = useState<ServerConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api.serverHealth().then(setHealth).catch((e) => setError(e.message));
    api.serverConnections().then(setConns).catch(() => setConns([]));
  };

  useEffect(() => {
    if (!connected) {
      setHealth(null);
      setConns(null);
      return;
    }
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [connected]);

  if (!connected) {
    return <Empty icon="pulse" label="Not connected" hint="Connect to read server health." />;
  }
  if (error) {
    return (
      <>
        <ErrorState message={error} />
        <Empty
          icon="pulse"
          label="Monitoring endpoint unreachable"
          hint="NATS publishes health on a separate HTTP port (8222 by default). Start the server with -m 8222, or set the context's monitorUrl."
        />
      </>
    );
  }
  if (!health) return <Loading label="Reading server health…" />;

  return (
    <>
      <div className="panel__head">
        <Icon name="pulse" weight="duotone" size={18} />
        <h3>Server</h3>
        <span className="dim">
          {health.serverName || health.serverId.slice(0, 8)} · v{health.version}
        </span>
        <span className="spacer" />
        {health.slowConsumers > 0 && <Badge variant="warn">{fmtInt(health.slowConsumers)} slow consumers</Badge>}
        <button className="btn btn--sm" onClick={load}>
          <Icon name="arrows-clockwise" /> Refresh
        </button>
      </div>

      <div className="stats">
        <Stat label="Uptime" value={health.uptime || "—"} hint={`${health.host}:${health.port}`} />
        <Stat label="Connections" value={fmtInt(health.connections)} hint={`${fmtInt(health.totalConnections)} total`} />
        <Stat label="Subscriptions" value={fmtInt(health.subscriptions)} />
        <Stat label="Messages in" value={fmtInt(health.inMsgs)} hint={fmtBytes(health.inBytes)} />
        <Stat label="Messages out" value={fmtInt(health.outMsgs)} hint={fmtBytes(health.outBytes)} />
        <Stat label="Memory" value={fmtBytes(health.memory)} hint={`${health.cpu.toFixed(1)}% cpu`} />
        <Stat label="Cluster" value={fmtInt(health.routes)} hint={`${fmtInt(health.leafNodes)} leaf nodes`} />
      </div>

      <div className="panel__head">
        <Icon name="stack" size={16} />
        <h3>JetStream</h3>
      </div>
      {health.jetstream === null ? (
        <Empty icon="stack" label="JetStream disabled" hint="This server reports no JetStream subsystem." />
      ) : (
        <div className="stats">
          <Stat label="Streams" value={fmtInt(health.jetstream.streams)} />
          <Stat label="Consumers" value={fmtInt(health.jetstream.consumers)} />
          <Stat label="Messages" value={fmtInt(health.jetstream.messages)} />
          <Stat label="Bytes" value={fmtBytes(health.jetstream.bytes)} />
          <Stat label="Memory store" value={fmtBytes(health.jetstream.memory)} />
          <Stat label="File store" value={fmtBytes(health.jetstream.storage)} />
        </div>
      )}

      <div className="panel__head">
        <Icon name="plugs-connected" size={16} />
        <h3>Connections</h3>
        {conns && <span className="count">{conns.length}</span>}
      </div>
      {!conns ? (
        <Loading />
      ) : conns.length === 0 ? (
        <Empty icon="plugs" label="No client connections" />
      ) : (
        <div className="tablewrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="num">CID</th>
                <th>Client</th>
                <th>Address</th>
                <th className="num">Subs</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th>RTT</th>
                <th>Idle</th>
              </tr>
            </thead>
            <tbody>
              {conns.map((c) => (
                <tr key={c.cid}>
                  <td className="num num--muted">{c.cid}</td>
                  <td>
                    <span className="name">{c.name || "—"}</span>
                    {c.language && (
                      <span className="dim">
                        {" "}
                        {c.language} {c.version}
                      </span>
                    )}
                  </td>
                  <td className="subjects">
                    {c.ip}:{c.port}
                  </td>
                  <td className="num num--muted">{fmtInt(c.subscriptions)}</td>
                  <td className="num num--muted">{fmtInt(c.inMsgs)}</td>
                  <td className="num num--muted">{fmtInt(c.outMsgs)}</td>
                  <td className="num--muted">{c.rtt || "—"}</td>
                  <td className="num--muted">{c.idle || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
