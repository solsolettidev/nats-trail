import { useState } from "react";
import type { Context, ConnectionState } from "../api.js";

type Env = Context["environment"];
type AuthType = Context["auth"]["type"];
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
  const [authType, setAuthType] = useState<AuthType>("none");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [credsPath, setCredsPath] = useState("");
  const [tlsEnabled, setTlsEnabled] = useState(false);
  const [caPath, setCaPath] = useState("");
  const [serverName, setServerName] = useState("");

  const reset = () => {
    setAdding(false);
    setName("");
    setUrl("nats://127.0.0.1:4222");
    setEnvironment("local");
    setAuthType("none");
    setUsername("");
    setPassword("");
    setToken("");
    setCredsPath("");
    setTlsEnabled(false);
    setCaPath("");
    setServerName("");
  };

  const submit = () => {
    const auth: Context["auth"] =
      authType === "userpass"
        ? { type: "userpass", username, password }
        : authType === "token"
          ? { type: "token", token }
          : authType === "creds"
            ? { type: "creds", credsPath }
          : { type: "none" };
    const tls: Context["tls"] = tlsEnabled
      ? { enabled: true, caPath: caPath || undefined, serverName: serverName || undefined }
      : { enabled: false };
    onCreate({ name, environment, url, auth, tls });
    reset();
  };

  const guardedConnect = (c: Context) => {
    if (
      c.environment === "prod" &&
      !window.confirm(`Connect to PRODUCTION context "${c.name}"?\n${c.url}`)
    )
      return;
    onConnect(c.id);
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

          <select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
            <option value="none">No auth</option>
            <option value="userpass">User / password</option>
            <option value="token">Token</option>
            <option value="creds">.creds file</option>
          </select>
          {authType === "userpass" && (
            <>
              <input
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          )}
          {authType === "token" && (
            <input
              type="password"
              placeholder="Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          )}
          {authType === "creds" && (
            <input
              placeholder="/path/to/user.creds"
              value={credsPath}
              onChange={(e) => setCredsPath(e.target.value)}
            />
          )}

          <label className="contexts__check">
            <input
              type="checkbox"
              checked={tlsEnabled}
              onChange={(e) => setTlsEnabled(e.target.checked)}
            />
            TLS
          </label>
          {tlsEnabled && (
            <>
              <input
                placeholder="CA file path (optional)"
                value={caPath}
                onChange={(e) => setCaPath(e.target.value)}
              />
              <input
                placeholder="Server name (optional)"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
              />
            </>
          )}

          {environment === "prod" && (
            <p className="contexts__warn">⚠ Production context — connections will require confirmation.</p>
          )}
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
                  <button disabled={busy} onClick={() => guardedConnect(c)}>
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
