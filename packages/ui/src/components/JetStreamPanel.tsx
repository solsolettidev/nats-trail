import { useEffect, useState } from "react";
import { api, type Stream, type Consumer } from "../api.js";
import { Loading, Empty, ErrorState } from "./states.js";

export function JetStreamPanel({ connected }: { connected: boolean }) {
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [consumers, setConsumers] = useState<Consumer[] | null>(null);
  const [consumersError, setConsumersError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    api
      .listStreams()
      .then(setStreams)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (connected) refresh();
    else {
      setStreams(null);
      setSelected(null);
      setConsumers(null);
    }
  }, [connected]);

  useEffect(() => {
    if (!selected) return;
    setConsumers(null);
    setConsumersError(null);
    api
      .listConsumers(selected)
      .then(setConsumers)
      .catch((e) => setConsumersError(e.message));
  }, [selected]);

  if (!connected) return <Empty label="Connect to inspect JetStream streams." />;

  return (
    <div className="js">
      <div className="js__head">
        <h3>Streams</h3>
        <button onClick={refresh}>Refresh</button>
      </div>

      {loading && <Loading />}
      {error && <ErrorState message={error} />}
      {streams && streams.length === 0 && <Empty label="No streams in this context." />}

      {streams && streams.length > 0 && (
        <table className="js__table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Subjects</th>
              <th>Messages</th>
              <th>Bytes</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {streams.map((s) => (
              <tr
                key={s.name}
                className={selected === s.name ? "js__row--active" : ""}
                onClick={() => setSelected(s.name)}
              >
                <td>{s.name}</td>
                <td className="js__subjects">{s.subjects.join(", ")}</td>
                <td>{s.messages}</td>
                <td>{s.bytes}</td>
                <td>{s.lastTs ? new Date(s.lastTs).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <div className="js__consumers">
          <h3>Consumers · {selected}</h3>
          {consumersError && <ErrorState message={consumersError} />}
          {!consumers && !consumersError && <Loading />}
          {consumers && consumers.length === 0 && <Empty label="No consumers on this stream." />}
          {consumers && consumers.length > 0 && (
            <table className="js__table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Durable</th>
                  <th>Kind</th>
                  <th>Pending</th>
                  <th>Ack pending</th>
                  <th>Redelivered</th>
                  <th>Last seq</th>
                </tr>
              </thead>
              <tbody>
                {consumers.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>{c.durableName ?? "—"}</td>
                    <td>{c.deliveryKind}</td>
                    <td>{c.pending}</td>
                    <td>{c.ackPending}</td>
                    <td>{c.redelivered}</td>
                    <td>{c.lastDelivered ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
