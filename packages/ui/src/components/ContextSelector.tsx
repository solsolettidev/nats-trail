import { useState } from "react";
import type { Context, ConnectionState } from "../api.js";

type Env = Context["environment"];
const ENVS: Env[] = ["local", "dev", "staging", "prod", "custom"];

interface Props {
  contexts: Context[];
  connection: ConnectionState;
  busy: boolean;
  onConnect: (id: string) => void;
  onDisconnect: () => void;
  onCreate: (ctx: Partial<Context>) => void;
  onDelete: (id: string) => void;
}

export function ContextSelector({
  contexts,
  connection,
  busy,
  onConnect,
  onDisconnect,
  onCreate,
  onDelete,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState<Env>("local");
  const [url, setUrl] = useState("nats://127.0.0.1:4222");

  const submit = () => {
    onCreate({ name, environment, url, auth: { type: "none" }, tls: { enabled: false } });
    setAdding(false);
    setName("");
    setUrl("nats://127.0.0.1:4222");
  };

  return (
    <div className="contexts">
      <div className="contexts__head">
        <h2>Contexts</h2>
        <button onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ New"}</button>
      </div>

      {adding && (
        <div className="contexts__form">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={environment} onChange={(e) => setEnvironment(e.target.value as Env)}>
            {ENVS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <input placeholder="nats://host:4222" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button disabled={!name || !url} onClick={submit}>
            Save
          </button>
        </div>
      )}

      <ul className="contexts__list">
        {contexts.map((c) => {
          const active = connection.contextId === c.id;
          const connected = active && connection.status === "connected";
          return (
            <li key={c.id} className={`ctx ctx--${c.environment} ${active ? "ctx--active" : ""}`}>
              <div className="ctx__main">
                <span className={`ctx__env ctx__env--${c.environment}`}>{c.environment}</span>
                <span className="ctx__name">{c.name}</span>
                <span className="ctx__url">{c.url}</span>
              </div>
              <div className="ctx__actions">
                {connected ? (
                  <button disabled={busy} onClick={onDisconnect}>
                    Disconnect
                  </button>
                ) : (
                  <button disabled={busy} onClick={() => onConnect(c.id)}>
                    Connect
                  </button>
                )}
                <button className="ctx__del" disabled={busy} onClick={() => onDelete(c.id)}>
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
