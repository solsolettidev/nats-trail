export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="state state--loading">{label}</div>;
}

export function Empty({ label }: { label: string }) {
  return <div className="state state--empty">{label}</div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="state state--error">⚠ {message}</div>;
}
