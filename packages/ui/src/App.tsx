import { useEffect, useState } from "react";
import { api, type Context, type ConnectionState } from "./api.js";
import { ContextSelector } from "./components/ContextSelector.js";
import { ConnectionStatus } from "./components/ConnectionStatus.js";
import { CorePanel } from "./components/CorePanel.js";
import { JetStreamPanel } from "./components/JetStreamPanel.js";
import { DlqPanel } from "./components/DlqPanel.js";
import { Loading, ErrorState } from "./components/states.js";
import { Icon } from "./components/ui.js";

type Tab = "core" | "jetstream" | "dlq";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "core", label: "NATS Core", icon: "broadcast" },
  { id: "jetstream", label: "JetStream", icon: "stack" },
  { id: "dlq", label: "DLQ", icon: "skull" },
];

function BrandMark() {
  return (
    <svg
      className="app__logo"
      width={22}
      height={22}
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M15 79 L37 53 L59 64 L80 30"
        stroke="var(--accent)"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="15" cy="79" r="5" fill="var(--muted)" />
      <circle cx="37" cy="53" r="5" fill="var(--muted)" />
      <circle cx="59" cy="64" r="5" fill="var(--muted)" />
      <circle cx="80" cy="30" r="14.5" stroke="var(--accent)" strokeWidth="3.5" />
      <circle cx="80" cy="30" r="7" fill="var(--accent)" />
    </svg>
  );
}

const EMPTY_CONN: ConnectionState = {
  status: "disconnected",
  contextId: null,
  url: null,
  error: null,
  reconnects: 0,
};

export function App() {
  const [contexts, setContexts] = useState<Context[] | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(EMPTY_CONN);
  const [lastSubject, setLastSubject] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("core");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadContexts = () => api.listContexts().then(setContexts).catch((e) => setError(e.message));

  useEffect(() => {
    loadContexts();
    api.getConnection().then(setConnection).catch(() => {});
    api.getPreferences().then((p) => setLastSubject(p.lastSubject)).catch(() => {});
  }, []);

  // Poll connection state so reconnects/disconnects surface in the UI.
  useEffect(() => {
    const id = setInterval(() => {
      api.getConnection().then(setConnection).catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const connect = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setConnection(await api.connect(id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      setConnection(await api.disconnect());
    } finally {
      setBusy(false);
    }
  };

  const createContext = async (ctx: Partial<Context>) => {
    setError(null);
    try {
      await api.createContext(ctx);
      await loadContexts();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteContext = async (id: string) => {
    await api.deleteContext(id);
    await loadContexts();
  };

  const onSubjectChange = (subject: string) => {
    setLastSubject(subject);
    api.savePreferences({ lastSubject: subject }).catch(() => {});
  };

  const connected = connection.status === "connected";
  const connectedCtx = contexts?.find((c) => c.id === connection.contextId) ?? null;
  const env = connected && connectedCtx ? connectedCtx.environment : null;

  return (
    <div className="app" data-env={env ?? undefined}>
      <div className="app__envstrip" />
      <header className="app__header">
        <div className="app__brand">
          <BrandMark />
          <span>
            NATS <span className="app__brand-accent">Trail</span>
          </span>
          {connectedCtx && <span className="dim">/ {connectedCtx.name}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
          {env === "prod" && (
            <span className="prodflag">
              <Icon name="warning-octagon" weight="fill" /> PROD
            </span>
          )}
          <ConnectionStatus state={connection} />
        </div>
      </header>

      <div className="app__body">
        <aside className="app__sidebar">
          {contexts === null ? (
            <Loading label="Loading contexts…" />
          ) : (
            <ContextSelector
              contexts={contexts}
              connection={connection}
              busy={busy}
              onConnect={connect}
              onDisconnect={disconnect}
              onCreate={createContext}
              onDelete={deleteContext}
            />
          )}
        </aside>

        <main className="app__main">
          <nav className="tabs" role="tablist">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                role="tab"
                aria-selected={tab === tb.id}
                className={"tab" + (tab === tb.id ? " tab--active" : "")}
                onClick={() => setTab(tb.id)}
              >
                <Icon name={tb.icon} weight={tab === tb.id ? "fill" : "regular"} /> {tb.label}
              </button>
            ))}
          </nav>

          <div className="panel">
            {error && <ErrorState message={error} />}
            {tab === "core" && (
              <CorePanel
                connected={connected}
                initialSubject={lastSubject}
                onSubjectChange={onSubjectChange}
              />
            )}
            {tab === "jetstream" && <JetStreamPanel connected={connected} />}
            {tab === "dlq" && <DlqPanel connected={connected} />}
          </div>
        </main>
      </div>
    </div>
  );
}
