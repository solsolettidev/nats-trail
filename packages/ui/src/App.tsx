import { useEffect, useState } from "react";
import { api, type Context, type ConnectionState } from "./api.js";
import { ContextSelector } from "./components/ContextSelector.js";
import { ConnectionStatus } from "./components/ConnectionStatus.js";
import { CorePanel } from "./components/CorePanel.js";
import { JetStreamPanel } from "./components/JetStreamPanel.js";
import { Loading, ErrorState } from "./components/states.js";

type Tab = "core" | "jetstream";

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

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__logo">⟿</span>
          <span>NATS Trail</span>
        </div>
        <ConnectionStatus state={connection} />
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
          {error && <ErrorState message={error} />}
          <nav className="tabs">
            <button className={tab === "core" ? "tabs--active" : ""} onClick={() => setTab("core")}>
              NATS Core
            </button>
            <button
              className={tab === "jetstream" ? "tabs--active" : ""}
              onClick={() => setTab("jetstream")}
            >
              JetStream
            </button>
          </nav>

          {tab === "core" ? (
            <CorePanel
              connected={connected}
              initialSubject={lastSubject}
              onSubjectChange={onSubjectChange}
            />
          ) : (
            <JetStreamPanel connected={connected} />
          )}
        </main>
      </div>
    </div>
  );
}
