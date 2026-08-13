import { useEffect, useState } from "react";
import { api, type Filter } from "../api.js";
import { Icon } from "./ui.js";
import { emptyFilters, type FilterState } from "./MessageFilters.js";

/** `datetime-local` value -> epoch ms. */
function toTs(value: string): number | undefined {
  if (!value) return undefined;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : undefined;
}

/** epoch ms -> `datetime-local` value in local time. */
function toLocalInput(ts: number | undefined): string {
  if (ts == null) return "";
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export function toFilter(name: string, stream: string, state: FilterState): Partial<Filter> {
  return {
    name,
    stream: stream.trim() || undefined,
    subject: state.subject.trim() || undefined,
    text: state.text.trim() || undefined,
    eventType: state.eventType.trim() || undefined,
    fromTs: toTs(state.from),
    toTs: toTs(state.to),
  };
}

export function toFilterState(filter: Filter): FilterState {
  return {
    ...emptyFilters,
    subject: filter.subject ?? "",
    text: filter.text ?? "",
    eventType: filter.eventType ?? "",
    from: toLocalInput(filter.fromTs),
    to: toLocalInput(filter.toTs),
  };
}

interface Props {
  /** Current panel filter state, saved as-is when the user names a filter. */
  value: FilterState;
  onApply: (next: FilterState) => void;
  /** Stream the filter runs against. Required for `nats-ui filter run`. */
  stream?: string;
}

/**
 * Saved filters shared with the CLI and MCP tools: the UI writes them to
 * `/api/filters`, `nats-ui filter run --filter <id>` reads them back.
 */
export function SavedFilters({ value, onApply, stream = "" }: Props) {
  const [filters, setFilters] = useState<Filter[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [streamName, setStreamName] = useState(stream);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listFilters().then(setFilters).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setStreamName(stream);
  }, [stream]);

  const save = async () => {
    if (!name.trim()) return;
    setError(null);
    try {
      await api.saveFilter(toFilter(name.trim(), streamName, value));
      setName("");
      setNaming(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    await api.deleteFilter(id);
    await load();
  };

  return (
    <div className="chips saved">
      <span className="chips__label">saved</span>
      {filters?.map((f) => (
        <span key={f.id} className="chip" title={f.stream ? `stream: ${f.stream}` : "no stream — nats-ui filter run needs one"}>
          <button className="chip__subject" onClick={() => onApply(toFilterState(f))}>
            {f.name}
          </button>
          <button className="chip__star saved__del" onClick={() => remove(f.id)} aria-label={`Delete ${f.name}`}>
            <Icon name="x" />
          </button>
        </span>
      ))}
      {filters?.length === 0 && !naming && <span className="dim">none yet</span>}

      {naming ? (
        <>
          <input
            className="input input--sm"
            autoFocus
            placeholder="Filter name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          <input
            className="input input--sm"
            placeholder="Stream (for CLI)"
            value={streamName}
            onChange={(e) => setStreamName(e.target.value)}
          />
          <button className="btn btn--sm" onClick={save} disabled={!name.trim()}>
            Save
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setNaming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button className="btn btn--ghost btn--sm" onClick={() => setNaming(true)}>
          <Icon name="plus" /> Save current
        </button>
      )}
      {error && <span className="saved__error">{error}</span>}
    </div>
  );
}
