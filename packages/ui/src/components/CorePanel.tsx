import { useEffect, useMemo, useState } from "react";
import { api, type Message } from "../api.js";
import { useLiveMessages } from "../useLiveMessages.js";
import { MessageViewer } from "./MessageViewer.js";
import { MessageFilters, applyFilters, emptyFilters, type FilterState } from "./MessageFilters.js";
import { MessageList, SplitWorkspace } from "./MessageList.js";
import { Empty, ErrorState } from "./states.js";
import { Icon } from "./ui.js";

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

  if (!connected)
    return (
      <Empty
        icon="plugs"
        label="Not connected"
        hint="Connect to a context in the sidebar to subscribe to subjects."
      />
    );

  const chips = [...favorites, ...recent.filter((r) => !favorites.includes(r))];

  return (
    <>
      <form className="subbar" onSubmit={submit}>
        <div className="field">
          <Icon name="broadcast" />
          <input
            className="input mono"
            placeholder="subject pattern  e.g.  orders.*  or  project.>"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn--primary">
          <Icon name="play" weight="fill" /> Subscribe
        </button>
        {live.subject && (
          <button type="button" className="btn" onClick={live.unsubscribe}>
            <Icon name="stop" /> Stop
          </button>
        )}
        {live.messages.length > 0 && (
          <button type="button" className="btn btn--ghost" onClick={live.clear}>
            <Icon name="eraser" /> Clear
          </button>
        )}
        <span className={"ws-state" + (live.subject ? " is-open" : "")}>
          <span className="dot" />
          {live.subject ? `live · ${live.subject}` : "not subscribed"}
        </span>
      </form>

      {chips.length > 0 && (
        <div className="chips">
          <span className="chips__label">Subjects</span>
          {chips.map((s) => {
            const fav = favorites.includes(s);
            return (
              <span key={s} className={"chip" + (fav ? " chip--fav" : "")}>
                <button className="chip__star" title="Favorite" onClick={() => toggleFavorite(s)}>
                  <Icon name="star" weight={fav ? "fill" : "regular"} />
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

      <SplitWorkspace
        viewerEmpty={!selected}
        list={
          live.messages.length === 0 ? (
            <Empty
              icon="broadcast"
              label={live.subject ? "Waiting for messages…" : "No subscription"}
              hint={
                live.subject
                  ? `Live on ${live.subject}`
                  : "Subscribe to a subject pattern to stream messages."
              }
            />
          ) : filtered.length === 0 ? (
            <Empty icon="funnel" label="No matches" hint="No messages match the current filters." />
          ) : (
            <MessageList messages={filtered} selectedId={selected?.id} onSelect={setSelected} />
          )
        }
        viewer={<MessageViewer message={selected} fullscreenable />}
      />
    </>
  );
}
