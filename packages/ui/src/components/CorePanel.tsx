import { useEffect, useMemo, useState } from "react";
import { api, type Message } from "../api.js";
import { useLiveMessages } from "../useLiveMessages.js";
import { MessageViewer } from "./MessageViewer.js";
import { MessageFilters, applyFilters, emptyFilters, type FilterState } from "./MessageFilters.js";
import { Empty, ErrorState } from "./states.js";

const MAX_RECENT = 8;

interface Props {
  connected: boolean;
  initialSubject: string | null;
  onSubjectChange: (subject: string) => void;
}

export function CorePanel({ connected, initialSubject, onSubjectChange }: Props) {
  const live = useLiveMessages();
  const [input, setInput] = useState(initialSubject ?? "");
  const [selected, setSelected] = useState<Message | null>(null);
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const filtered = useMemo(() => applyFilters(live.messages, filters), [live.messages, filters]);
  const [recent, setRecent] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    if (initialSubject) setInput(initialSubject);
  }, [initialSubject]);

  useEffect(() => {
    api
      .getPreferences()
      .then((p) => {
        setRecent(p.recentSubjects ?? []);
        setFavorites(p.favoriteSubjects ?? []);
      })
      .catch(() => {});
  }, []);

  const subscribe = (subject: string) => {
    const s = subject.trim();
    if (!s) return;
    setInput(s);
    live.subscribe(s);
    onSubjectChange(s);
    const next = [s, ...recent.filter((r) => r !== s)].slice(0, MAX_RECENT);
    setRecent(next);
    api.savePreferences({ recentSubjects: next }).catch(() => {});
  };

  const toggleFavorite = (subject: string) => {
    const next = favorites.includes(subject)
      ? favorites.filter((f) => f !== subject)
      : [subject, ...favorites].slice(0, MAX_RECENT);
    setFavorites(next);
    api.savePreferences({ favoriteSubjects: next }).catch(() => {});
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    subscribe(input);
  };

  if (!connected) return <Empty label="Connect to a context to subscribe to subjects." />;

  return (
    <div className="core">
      <form className="core__bar" onSubmit={submit}>
        <input
          placeholder="subject pattern e.g. orders.* or project.>"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit">Subscribe</button>
        {live.subject && (
          <button type="button" onClick={live.unsubscribe}>
            Stop
          </button>
        )}
        {live.messages.length > 0 && (
          <button type="button" onClick={live.clear}>
            Clear
          </button>
        )}
        <span className={`core__ws core__ws--${live.status}`}>
          {live.subject ? `live: ${live.subject}` : "not subscribed"}
        </span>
      </form>

      {(favorites.length > 0 || recent.length > 0) && (
        <div className="chips">
          {[...favorites, ...recent.filter((r) => !favorites.includes(r))].map((s) => {
            const fav = favorites.includes(s);
            return (
              <span key={s} className={`chip ${fav ? "chip--fav" : ""}`}>
                <button className="chip__star" title="Favorite" onClick={() => toggleFavorite(s)}>
                  {fav ? "★" : "☆"}
                </button>
                <button className="chip__subject" onClick={() => subscribe(s)}>
                  {s}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {live.error && <ErrorState message={live.error} />}

      {live.messages.length > 0 && (
        <MessageFilters messages={live.messages} value={filters} onChange={setFilters} />
      )}

      <div className="core__split">
        <div className="core__list">
          {live.messages.length === 0 ? (
            <Empty label={live.subject ? "Waiting for messages…" : "Subscribe to a subject."} />
          ) : filtered.length === 0 ? (
            <Empty label="No messages match the filters." />
          ) : (
            <ul>
              {filtered.map((m) => (
                <li
                  key={m.id}
                  className={`msg ${selected?.id === m.id ? "msg--active" : ""}`}
                  onClick={() => setSelected(m)}
                >
                  <span className="msg__time">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  <span className="msg__subject">{m.subject}</span>
                  <span className="msg__preview">{m.data.slice(0, 80)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="core__viewer">
          <MessageViewer message={selected} />
        </div>
      </div>
    </div>
  );
}
