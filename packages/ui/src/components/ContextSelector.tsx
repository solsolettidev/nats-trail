import { useState } from "react";
import type { Context, ConnectionState } from "../api.js";
import { Icon } from "./ui.js";

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
  const [confirmCtx, setConfirmCtx] = useState<Context | null>(null);
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
    if (c.environment === "prod" || c.environment === "staging") {
      setConfirmCtx(c);
      return;
    }
    onConnect(c.id);
  };

  return (
    <div className="contexts">
      <div className="contexts__head">
        <h2>Contexts</h2>
        <button className="btn btn--sm" onClick={() => setAdding((v) => !v)}>
          <Icon name={adding ? "x" : "plus"} /> {adding ? "Cancel" : "New"}
        </button>
      </div>

      {adding && (
        <div className="contexts__form">
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="row">
            <select className="select" value={environment} onChange={(e) => setEnvironment(e.target.value as Env)}>
              {ENVS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <select className="select" value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
              <option value="none">No auth</option>
              <option value="userpass">User / password</option>
              <option value="token">Token</option>
              <option value="creds">.creds file</option>
            </select>
          </div>
          <input
            className="input mono"
            placeholder="nats://host:4222"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />

          {authType === "userpass" && (
            <div className="row">
              <input
                className="input"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                className="input"
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          {authType === "token" && (
            <input
              className="input"
              type="password"
              placeholder="Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          )}
          {authType === "creds" && (
            <input
              className="input mono"
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
            <div className="row">
              <input
                className="input"
                placeholder="CA file path (optional)"
                value={caPath}
                onChange={(e) => setCaPath(e.target.value)}
              />
              <input
                className="input"
                placeholder="Server name (optional)"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
              />
            </div>
          )}

          {environment === "prod" && (
            <p className="contexts__warn">
              <Icon name="warning" weight="fill" /> Production context — connecting will require confirmation.
            </p>
          )}
          <button className="btn btn--primary btn--sm" disabled={!name || !url} onClick={submit}>
            <Icon name="check" /> Save context
          </button>
        </div>
      )}

      <ul className="contexts__list">
        {contexts.map((c) => {
          const active = connection.contextId === c.id;
          const connected = active && connection.status === "connected";
          return (
            <li
              key={c.id}
              className={
                "ctx ctx--" +
                c.environment +
                (active ? " ctx--active" : "") +
                (connected ? " ctx--connected" : "")
              }
              onClick={() => !connected && !busy && guardedConnect(c)}
            >
              <div className="ctx__top">
                <span className={`env env--${c.environment}`}>{c.environment}</span>
                <span className="ctx__name">{c.name}</span>
                {connected && (
                  <span className="ctx__live">
                    <Icon name="circle" weight="fill" size={7} /> live
                  </span>
                )}
              </div>
              <span className="ctx__url" title={c.url}>
                {c.url}
              </span>
              <div className="ctx__actions" onClick={(e) => e.stopPropagation()}>
                {connected ? (
                  <button className="btn btn--sm btn--danger" disabled={busy} onClick={onDisconnect}>
                    <Icon name="plug" /> Disconnect
                  </button>
                ) : (
                  <button
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    onClick={() => guardedConnect(c)}
                  >
                    <Icon name="lightning" weight="fill" /> Connect
                  </button>
                )}
                <button
                  className="btn btn--sm btn--icon ctx__del"
                  title="Delete context"
                  disabled={busy}
                  onClick={() => onDelete(c.id)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {confirmCtx && (
        <ProdConfirm
          context={confirmCtx}
          onCancel={() => setConfirmCtx(null)}
          onConfirm={() => {
            onConnect(confirmCtx.id);
            setConfirmCtx(null);
          }}
        />
      )}
    </div>
  );
}

function ProdConfirm({
  context,
  onCancel,
  onConfirm,
}: {
  context: Context;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const prod = context.environment === "prod";
  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div
        className={"confirm__card" + (prod ? " is-prod" : "")}
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm connection"
      >
        <div className="confirm__icon">
          <Icon name="warning-octagon" weight="fill" />
        </div>
        <div className="confirm__title">Connect to {prod ? "PRODUCTION" : "this context"}?</div>
        <div className="confirm__body">
          You are about to open a live connection to <b>{context.name}</b>.{" "}
          {prod && "Messages here are real customer traffic — act carefully."}
          <span className="confirm__url">{context.url}</span>
        </div>
        <div className="confirm__actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={"btn " + (prod ? "btn--danger" : "btn--primary")} onClick={onConfirm} autoFocus>
            <Icon name="lightning" weight="fill" /> {prod ? "Connect to prod" : "Connect"}
          </button>
        </div>
      </div>
    </>
  );
}
