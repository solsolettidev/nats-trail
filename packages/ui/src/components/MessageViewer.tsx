import { useEffect, useState } from "react";
import { api, formatPayload, type Message } from "../api.js";
import { Badge, Icon, fmtBytes, fmtInt, fmtTime, highlight } from "./ui.js";
import { Empty } from "./states.js";

export function MessageViewer({
  message,
  fullscreenable,
}: {
  message: Message | null;
  fullscreenable?: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [mode, setMode] = useState<"tree" | "raw">("tree");
  const [full, setFull] = useState(false);
  const [query, setQuery] = useState("");

  const text = message ? formatPayload(message) : "";

  useEffect(() => {
    api.getPreferences().then((p) => setMode(p.messageViewerMode ?? "tree")).catch(() => {});
  }, []);

  const copy = (value: string, label: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1200);
    });
  };

  const toggleMode = () => {
    const next = mode === "tree" ? "raw" : "tree";
    setMode(next);
    api.savePreferences({ messageViewerMode: next }).catch(() => {});
  };

  if (!message)
    return (
      <div className="viewer">
        <Empty
          icon="cursor-click"
          label="No message selected"
          hint="Pick a message from the list to inspect its payload, headers, and metadata."
        />
      </div>
    );

  const showTree = mode === "tree" && message.isJson;
  const q = query.trim().toLowerCase();

  return (
    <div className={"viewer" + (full ? " viewer--full" : "")}>
      <div className="viewer__head">
        <div className="viewer__meta">
          <span className="viewer__subject" title={message.subject}>
            {message.subject}
          </span>
          <span className="viewer__badges">
            <Badge variant={message.isJson ? "json" : "text"}>{message.isJson ? "JSON" : "TEXT"}</Badge>
            <Badge>{fmtBytes(message.size)}</Badge>
            {message.seq != null && <Badge variant="seq">seq {fmtInt(message.seq)}</Badge>}
            <Badge>{fmtTime(message.timestamp)}</Badge>
          </span>
        </div>
        <div className="viewer__actions">
          {message.isJson && (
            <div className="seg" role="tablist" aria-label="View mode">
              <button aria-pressed={mode === "tree"} onClick={() => mode !== "tree" && toggleMode()}>
                <Icon name="tree-view" /> Tree
              </button>
              <button aria-pressed={mode === "raw"} onClick={() => mode !== "raw" && toggleMode()}>
                <Icon name="code" /> Raw
              </button>
            </div>
          )}
          {fullscreenable && (
            <button
              className="btn btn--sm btn--icon"
              title={full ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => setFull((f) => !f)}
            >
              <Icon name={full ? "corners-in" : "corners-out"} />
            </button>
          )}
          <button className="btn btn--sm" onClick={() => copy(text, "all")}>
            <Icon name={copied === "all" ? "check" : "copy"} /> {copied === "all" ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="viewer__toolbar">
        <div className="field">
          <Icon name="magnifying-glass" />
          <input
            className="input"
            type="search"
            placeholder={showTree ? "Filter keys & values…" : "Search lines…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {showTree && <span className="viewer__matchcount">click a key to copy its path</span>}
      </div>

      <div className="viewer__body">
        {showTree ? (
          <JsonTree value={message.json} query={q} onCopy={copy} copied={copied} />
        ) : (
          <Raw text={text} query={q} />
        )}
      </div>
    </div>
  );
}

function Raw({ text, query }: { text: string; query: string }) {
  if (!query) return <pre className="viewer__raw">{text}</pre>;
  const lines = text.split("\n").filter((l) => l.toLowerCase().includes(query));
  if (!lines.length) return <div className="raw__empty">No lines match “{query}”.</div>;
  return (
    <pre className="viewer__raw">
      {lines.map((l, i) => (
        <div key={i}>{highlight(l, query)}</div>
      ))}
    </pre>
  );
}

interface NodeProps {
  k: string;
  value: unknown;
  path: string;
  query: string;
  onCopy: (value: string, label: string) => void;
  copied: string | null;
  depth: number;
}

/** Recursively render JSON; nodes hidden when they (and descendants) don't match the query. */
function JsonNode({ k, value, path, query, onCopy, copied, depth }: NodeProps) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === "object";

  if (query && !matches(k, value, query)) return null;

  const copyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCopy(path, `path:${path}`);
  };

  const indent = (
    <span className="jt__indent">
      {Array.from({ length: depth }).map((_, i) => (
        <span key={i} className="jt__guide" />
      ))}
    </span>
  );
  const copiedHere = copied === `path:${path}` && (
    <span className="jt__copied">
      <Icon name="check" /> copied
    </span>
  );

  if (!isObj) {
    return (
      <div className="jt__row">
        {indent}
        <span className="jt__toggle" />
        <span className="jt__key" title={`Copy path · ${path}`} onClick={copyPath}>
          {highlight(k, query)}
        </span>
        <span className="jt__colon">:</span>
        <span className={`jt__val jt__val--${valKind(value)}`}>{highlight(format(value), query)}</span>
        {copiedHere}
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const open2 = query ? true : open;

  return (
    <div>
      <div className="jt__row jt__row--branch" onClick={() => setOpen((o) => !o)}>
        {indent}
        <span className="jt__toggle">
          <Icon name={open2 ? "caret-down" : "caret-right"} weight="bold" />
        </span>
        <span className="jt__key" title={`Copy path · ${path}`} onClick={copyPath}>
          {highlight(k, query)}
        </span>
        <span className="jt__meta">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
        {copiedHere}
      </div>
      {open2 &&
        entries.map(([ck, cv]) => (
          <JsonNode
            key={ck}
            k={ck}
            value={cv}
            path={path ? `${path}.${ck}` : ck}
            query={query}
            onCopy={onCopy}
            copied={copied}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

function JsonTree({
  value,
  query,
  onCopy,
  copied,
}: {
  value: unknown;
  query: string;
  onCopy: (value: string, label: string) => void;
  copied: string | null;
}) {
  if (value === null || typeof value !== "object") {
    return <span className={`jt__val jt__val--${valKind(value)}`}>{format(value)}</span>;
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const visible = entries.filter(([k, v]) => !query || matches(k, v, query));
  if (query && visible.length === 0) return <div className="jt__empty">No matches.</div>;
  return (
    <div className="jt">
      {visible.map(([k, v]) => (
        <JsonNode key={k} k={k} value={v} path={k} query={query} onCopy={onCopy} copied={copied} depth={0} />
      ))}
    </div>
  );
}

function format(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  return String(value);
}

function valKind(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}

/** True when the key, a primitive value, or any nested key/value contains the query. */
function matches(key: string, value: unknown, query: string): boolean {
  if (key.toLowerCase().includes(query)) return true;
  if (value === null || typeof value !== "object") {
    return String(value).toLowerCase().includes(query);
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return entries.some(([k, v]) => matches(k, v, query));
}
