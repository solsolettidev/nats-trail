import { useState } from "react";
import { formatPayload, type Message } from "../api.js";

export function MessageViewer({ message }: { message: Message | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [mode, setMode] = useState<"tree" | "raw">("tree");
  const [full, setFull] = useState(false);
  const [query, setQuery] = useState("");

  const text = message ? formatPayload(message) : "";

  const copy = (value: string, label: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1200);
    });
  };

  if (!message) return <div className="state state--empty">Select a message</div>;

  const showTree = mode === "tree" && message.isJson;

  return (
    <div className={`viewer ${full ? "viewer--full" : ""}`}>
      <div className="viewer__head">
        <div className="viewer__meta">
          <span className="viewer__subject">{message.subject}</span>
          <span className="viewer__badges">
            <span className={`tag tag--${message.isJson ? "json" : "text"}`}>
              {message.isJson ? "JSON" : "text"}
            </span>
            <span className="tag">{message.size} B</span>
            {message.seq != null && <span className="tag">seq {message.seq}</span>}
          </span>
        </div>
        <div className="viewer__actions">
          {message.isJson && (
            <button onClick={() => setMode((m) => (m === "tree" ? "raw" : "tree"))}>
              {mode === "tree" ? "Raw" : "Tree"}
            </button>
          )}
          <button onClick={() => setFull((f) => !f)}>{full ? "Exit" : "Fullscreen"}</button>
          <button onClick={() => copy(text, "all")}>{copied === "all" ? "Copied" : "Copy"}</button>
        </div>
      </div>

      <input
        className="viewer__search"
        type="search"
        placeholder="Search in payload…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="viewer__body">
        {showTree ? (
          <JsonTree value={message.json} query={query.trim().toLowerCase()} onCopy={copy} copied={copied} />
        ) : (
          <Raw text={text} query={query.trim().toLowerCase()} />
        )}
      </div>
    </div>
  );
}

function Raw({ text, query }: { text: string; query: string }) {
  if (!query) return <pre className="viewer__raw">{text}</pre>;
  const lines = text.split("\n").filter((l) => l.toLowerCase().includes(query));
  return <pre className="viewer__raw">{lines.length ? lines.join("\n") : "No matches."}</pre>;
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

  if (!isObj) {
    return (
      <div className="jt__row" style={{ paddingLeft: depth * 14 }}>
        <span className="jt__key" title={`Copy path: ${path}`} onClick={copyPath}>
          {k}
        </span>
        <span className="jt__colon">:</span>
        <span className={`jt__val jt__val--${typeof value}`}>{format(value)}</span>
        {copied === `path:${path}` && <span className="jt__copied">path copied</span>}
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const open2 = query ? true : open;

  return (
    <div>
      <div className="jt__row" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen((o) => !o)}>
        <span className="jt__toggle">{open2 ? "▾" : "▸"}</span>
        <span className="jt__key" title={`Copy path: ${path}`} onClick={copyPath}>
          {k}
        </span>
        <span className="jt__meta">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
        {copied === `path:${path}` && <span className="jt__copied">path copied</span>}
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
    return <span className="jt__val">{format(value)}</span>;
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
  return String(value);
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
