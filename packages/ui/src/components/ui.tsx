import type { ReactNode } from "react";

// ── Phosphor icon helper ─────────────────────────────────────────────────────
type Weight = "regular" | "bold" | "fill" | "duotone";

export function Icon({
  name,
  weight = "regular",
  size,
  className,
}: {
  name: string;
  weight?: Weight;
  size?: number;
  className?: string;
}) {
  const w = weight !== "regular" ? `-${weight}` : "";
  const cls = [`ph${w}`, `ph-${name}`, className].filter(Boolean).join(" ");
  return <i className={cls} style={size ? { fontSize: size } : undefined} aria-hidden="true" />;
}

// ── Badge ─────────────────────────────────────────────────────────────────────
export function Badge({ variant, children }: { variant?: string; children: ReactNode }) {
  return <span className={"badge" + (variant ? ` badge--${variant}` : "")}>{children}</span>;
}

// ── formatters ────────────────────────────────────────────────────────────────
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + " " + u[i];
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export function fmtRelative(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

// Highlight query matches inside a string → array of React nodes.
export function highlight(str: string, q: string): ReactNode {
  if (!q) return str;
  const lower = str.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < str.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      out.push(str.slice(i));
      break;
    }
    if (idx > i) out.push(str.slice(i, idx));
    out.push(<mark key={k++}>{str.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
  }
  return out;
}
