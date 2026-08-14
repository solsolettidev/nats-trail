import { useState } from "react";
import { api, type Message } from "../api.js";
import { Icon } from "./ui.js";
import { ErrorState } from "./states.js";

/**
 * Publish and request/reply, for humans only.
 *
 * Non-local contexts require typing the environment name back, so publishing to
 * prod is never one stray click. There is no agent path to this component: it
 * calls `/api/mutate`, which the MCP runtime cannot reach.
 */
export function Publisher({
  environment,
  initialSubject,
}: {
  environment: string | null;
  initialSubject?: string;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(initialSubject ?? "");
  const [payload, setPayload] = useState("{}");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<Message | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const guarded = environment !== null && environment !== "local";
  const armed = subject.trim().length > 0 && (!guarded || confirm === environment);

  const reset = () => {
    setError(null);
    setReply(null);
    setSent(null);
  };

  const send = async (mode: "publish" | "request") => {
    if (!armed) return;
    setBusy(true);
    reset();
    try {
      if (mode === "publish") {
        await api.publish(subject.trim(), payload);
        setSent(`published to ${subject.trim()}`);
      } else {
        setReply(await api.request(subject.trim(), payload));
      }
      setConfirm("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn--sm btn--ghost" onClick={() => setOpen(true)}>
        <Icon name="paper-plane-tilt" /> Publish
      </button>
    );
  }

  return (
    <div className="publisher">
      <div className="publisher__head">
        <Icon name="paper-plane-tilt" weight="duotone" />
        <b>Publish</b>
        {guarded && (
          <span className="publisher__warn">
            <Icon name="warning" weight="fill" /> {environment} — type “{environment}” to arm
          </span>
        )}
        <span className="spacer" />
        <button className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>
          <Icon name="x" /> Close
        </button>
      </div>

      <div className="publisher__row">
        <div className="field" style={{ flex: 1 }}>
          <Icon name="broadcast" />
          <input
            className="input"
            placeholder="orders.created"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        {guarded && (
          <input
            className="input input--sm"
            placeholder={environment ?? ""}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-label="Confirm environment"
            style={{ maxWidth: 120 }}
          />
        )}
      </div>

      <textarea
        className="input publisher__payload"
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        spellCheck={false}
        aria-label="Payload"
      />

      <div className="publisher__row">
        <button className="btn btn--sm" onClick={() => send("publish")} disabled={busy || !armed}>
          <Icon name="paper-plane-tilt" /> Publish
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => send("request")} disabled={busy || !armed}>
          <Icon name="arrows-left-right" /> Request
        </button>
        {sent && <span className="publisher__ok">{sent}</span>}
      </div>

      {error && <ErrorState message={error} />}
      {reply && (
        <pre className="publisher__reply">
          {reply.isJson ? JSON.stringify(reply.json, null, 2) : reply.data}
        </pre>
      )}
    </div>
  );
}
