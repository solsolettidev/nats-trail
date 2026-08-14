import { useState } from "react";
import { api } from "../api.js";
import { Icon } from "./ui.js";
import { ErrorState } from "./states.js";

const RETENTIONS = ["limits", "interest", "workqueue"] as const;
const STORAGES = ["file", "memory"] as const;

/** Blank means "keep the server default on create, the current value on update". */
function optionalInt(value: string): number | undefined {
  const n = Number(value.trim());
  return value.trim() && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Create or update a stream.
 *
 * Fields left blank are omitted from the request, so an update never resets a
 * setting the user did not touch. JetStream refuses some changes on a live
 * stream (storage and retention among them) and that error is shown as-is.
 */
export function StreamForm({ existing, onDone, onCancel }: { existing?: string; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(existing ?? "");
  const [subjects, setSubjects] = useState("");
  const [retention, setRetention] = useState("");
  const [storage, setStorage] = useState("");
  const [replicas, setReplicas] = useState("");
  const [maxMessages, setMaxMessages] = useState("");
  const [maxBytes, setMaxBytes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedSubjects = subjects.split(",").map((s) => s.trim()).filter(Boolean);
  const armed = name.trim().length > 0 && parsedSubjects.length > 0;

  const submit = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await api.upsertStream(name.trim(), {
        subjects: parsedSubjects,
        retention: retention || undefined,
        storage: storage || undefined,
        replicas: optionalInt(replicas),
        maxMessages: optionalInt(maxMessages),
        maxBytes: optionalInt(maxBytes),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="confirm" role="dialog" aria-label={existing ? `Edit ${existing}` : "Create stream"}>
      <div className="confirm__box" style={{ borderColor: "var(--border-strong)", width: "min(560px, calc(100vw - 32px))" }}>
        <div className="confirm__head" style={{ color: "var(--text)" }}>
          <Icon name="stack" weight="duotone" />
          <b>{existing ? `Edit ${existing}` : "Create stream"}</b>
        </div>

        <input
          className="input mono"
          autoFocus={!existing}
          disabled={!!existing}
          placeholder="ORDER_EVENTS"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Stream name"
        />
        <input
          className="input mono"
          autoFocus={!!existing}
          placeholder="orders.>, payments.*  (comma separated)"
          value={subjects}
          onChange={(e) => setSubjects(e.target.value)}
          aria-label="Subjects"
        />

        <div className="publisher__row">
          <select className="select" value={retention} onChange={(e) => setRetention(e.target.value)} aria-label="Retention">
            <option value="">retention: default</option>
            {RETENTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select className="select" value={storage} onChange={(e) => setStorage(e.target.value)} aria-label="Storage">
            <option value="">storage: default</option>
            {STORAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="replicas"
            value={replicas}
            onChange={(e) => setReplicas(e.target.value)}
            aria-label="Replicas"
          />
        </div>

        <div className="publisher__row">
          <input
            className="input"
            placeholder="max messages (blank = unlimited)"
            value={maxMessages}
            onChange={(e) => setMaxMessages(e.target.value)}
            aria-label="Max messages"
          />
          <input
            className="input"
            placeholder="max bytes"
            value={maxBytes}
            onChange={(e) => setMaxBytes(e.target.value)}
            aria-label="Max bytes"
          />
        </div>

        {error && <ErrorState message={error} />}

        <div className="confirm__actions">
          <button className="btn btn--sm btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--sm" onClick={submit} disabled={busy || !armed}>
            <Icon name="check" /> {existing ? "Update" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Create or update a durable consumer on a stream. */
export function ConsumerForm({ stream, onDone, onCancel }: { stream: string; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [filterSubjects, setFilterSubjects] = useState("");
  const [ackPolicy, setAckPolicy] = useState("explicit");
  const [deliverPolicy, setDeliverPolicy] = useState("all");
  const [maxDeliver, setMaxDeliver] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = name.trim().length > 0;

  const submit = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await api.upsertConsumer(stream, name.trim(), {
        filterSubjects: filterSubjects.split(",").map((s) => s.trim()).filter(Boolean),
        ackPolicy,
        deliverPolicy,
        maxDeliver: optionalInt(maxDeliver),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="confirm" role="dialog" aria-label={`Create consumer on ${stream}`}>
      <div className="confirm__box" style={{ borderColor: "var(--border-strong)", width: "min(560px, calc(100vw - 32px))" }}>
        <div className="confirm__head" style={{ color: "var(--text)" }}>
          <Icon name="users-three" weight="duotone" />
          <b>New consumer</b>
          <span className="dim">· {stream}</span>
        </div>

        <input
          className="input mono"
          autoFocus
          placeholder="refresh-worker"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Consumer name"
        />
        <input
          className="input mono"
          placeholder="filter subjects (blank = whole stream)"
          value={filterSubjects}
          onChange={(e) => setFilterSubjects(e.target.value)}
          aria-label="Filter subjects"
        />

        <div className="publisher__row">
          <select className="select" value={ackPolicy} onChange={(e) => setAckPolicy(e.target.value)} aria-label="Ack policy">
            {["explicit", "all", "none"].map((p) => (
              <option key={p} value={p}>
                ack: {p}
              </option>
            ))}
          </select>
          <select className="select" value={deliverPolicy} onChange={(e) => setDeliverPolicy(e.target.value)} aria-label="Deliver policy">
            {["all", "last", "new"].map((p) => (
              <option key={p} value={p}>
                deliver: {p}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="max deliver"
            value={maxDeliver}
            onChange={(e) => setMaxDeliver(e.target.value)}
            aria-label="Max deliver"
          />
        </div>

        {error && <ErrorState message={error} />}

        <div className="confirm__actions">
          <button className="btn btn--sm btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--sm" onClick={submit} disabled={busy || !armed}>
            <Icon name="check" /> Create
          </button>
        </div>
      </div>
    </div>
  );
}
