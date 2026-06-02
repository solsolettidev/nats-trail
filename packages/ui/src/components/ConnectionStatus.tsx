import type { ConnectionState } from "../api.js";
import { Icon } from "./ui.js";

const LABELS: Record<ConnectionState["status"], string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Error",
};

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  return (
    <div className={`conn conn--${state.status}`}>
      <span className="conn__dot" />
      <span className="conn__label">{LABELS[state.status]}</span>
      {state.url && <span className="conn__url">{state.url}</span>}
      {state.reconnects > 0 && (
        <span className="conn__reconnects" title="reconnect attempts">
          <Icon name="arrows-clockwise" /> {state.reconnects}
        </span>
      )}
      {state.error && <span className="conn__error">· {state.error}</span>}
    </div>
  );
}
