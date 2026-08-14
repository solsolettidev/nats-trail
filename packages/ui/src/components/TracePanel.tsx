import { useState } from "react";
import { api, type Flow, type FlowStep, type HealthFinding } from "../api.js";
import { Loading, Empty, ErrorState } from "./states.js";
import { Badge, Icon, fmtInt, fmtTime } from "./ui.js";

function fmtDelta(ms: number | null): string {
  if (ms === null) return "start";
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  return `+${Math.round(ms / 60_000)}m`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function StepIcon({ status }: { status: FlowStep["status"] }) {
  if (status === "dlq") return <Icon name="skull" weight="fill" />;
  if (status === "failed") return <Icon name="x-circle" weight="fill" />;
  return <Icon name="check-circle" weight="fill" />;
}

function Findings({ findings }: { findings: HealthFinding[] }) {
  if (findings.length === 0) {
    return <Empty icon="check-circle" label="Nothing looks broken" hint="No backlog, redeliveries, dead letters or slow consumers." />;
  }
  return (
    <div className="findings">
      {findings.map((f, i) => (
        <div key={`${f.code}-${f.target}-${i}`} className={`finding finding--${f.severity}`}>
          <Icon name={f.severity === "critical" ? "warning-octagon" : "warning"} weight="fill" />
          <div>
            <div className="finding__msg">{f.message}</div>
            <div className="finding__meta">
              {f.code} · {f.target}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TracePanel({ connected }: { connected: boolean }) {
  const [id, setId] = useState("");
  const [kind, setKind] = useState<"request" | "correlation">("request");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [findings, setFindings] = useState<HealthFinding[] | null>(null);
  const [loadingFindings, setLoadingFindings] = useState(false);

  const run = async () => {
    if (!id.trim()) return;
    setBusy(true);
    setError(null);
    setFlow(null);
    try {
      const result =
        kind === "request"
          ? await api.flowByRequestId(id.trim())
          : await api.flowByCorrelationId(id.trim());
      setFlow(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadFindings = async () => {
    setLoadingFindings(true);
    setError(null);
    try {
      setFindings(await api.healthSummary());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingFindings(false);
    }
  };

  if (!connected) {
    return <Empty icon="path" label="Not connected" hint="Connect to trace a flow across streams." />;
  }

  return (
    <>
      <div className="panel__head">
        <Icon name="path" weight="duotone" size={18} />
        <h3>Trace a flow</h3>
        <span className="spacer" />
        <button className="btn btn--sm btn--ghost" onClick={loadFindings} disabled={loadingFindings}>
          <Icon name="stethoscope" /> What is broken?
        </button>
      </div>

      <div className="filters" role="search">
        <div className="seg" role="tablist" aria-label="Correlation key">
          <button aria-pressed={kind === "request"} onClick={() => setKind("request")}>
            request_id
          </button>
          <button aria-pressed={kind === "correlation"} onClick={() => setKind("correlation")}>
            correlation_id
          </button>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <Icon name="magnifying-glass" />
          <input
            className="input"
            placeholder="req-8f21c"
            value={id}
            onChange={(e) => setId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
        </div>
        <button className="btn btn--sm" onClick={run} disabled={busy || !id.trim()}>
          <Icon name="play" /> Trace
        </button>
      </div>

      {error && <ErrorState message={error} />}

      {findings !== null && (
        <>
          <div className="panel__head">
            <Icon name="stethoscope" size={16} />
            <h3>Health</h3>
            <span className="count">{findings.length}</span>
            <span className="spacer" />
            <button className="btn btn--sm btn--ghost" onClick={() => setFindings(null)}>
              <Icon name="x" /> Close
            </button>
          </div>
          {loadingFindings ? <Loading /> : <Findings findings={findings} />}
        </>
      )}

      {busy && <Loading label="Sweeping streams…" />}

      {flow && flow.steps.length === 0 && (
        <Empty
          icon="magnifying-glass"
          label="No messages for that id"
          hint="Nothing in the scanned window carries this request_id or correlation_id. Older history may need a wider window."
        />
      )}

      {flow && flow.steps.length > 0 && (
        <>
          <div className="panel__head">
            <Icon name="git-fork" size={16} />
            <h3>{flow.value}</h3>
            {flow.failed ? <Badge variant="err">failed</Badge> : <Badge variant="json">ok</Badge>}
            <span className="dim">
              · {fmtInt(flow.steps.length)} steps · {fmtDuration(flow.durationMs)} ·{" "}
              {flow.streams.join(" → ")}
            </span>
          </div>

          {flow.failedAt && (
            <div className="banner banner--error" role="alert">
              <Icon name="warning-circle" weight="fill" />
              <span>
                Failed at <b>{flow.failedAt.subject}</b>
                {flow.failedAt.detail ? `: ${flow.failedAt.detail}` : ""}
              </span>
            </div>
          )}

          <div className="flow">
            {flow.steps.map((step, i) => (
              <div key={`${step.subject}-${step.timestamp}-${i}`} className={`flowstep flowstep--${step.status}`}>
                <div className="flowstep__rail">
                  <span className="flowstep__dot">
                    <StepIcon status={step.status} />
                  </span>
                  {i < flow.steps.length - 1 && <span className="flowstep__line" />}
                </div>
                <div className="flowstep__body">
                  <div className="flowstep__head">
                    <span className="flowstep__subject">{step.subject}</span>
                    <span className="flowstep__delta">{fmtDelta(step.deltaMs)}</span>
                  </div>
                  <div className="flowstep__meta">
                    {step.stream}
                    {step.seq != null && ` · seq ${fmtInt(step.seq)}`} · {fmtTime(step.timestamp)}
                  </div>
                  {step.detail && <div className="flowstep__detail">{step.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {!flow && !busy && findings === null && (
        <Empty
          icon="path"
          label="Trace a request across every stream"
          hint="Enter a request_id or correlation_id. NATS Trail sweeps each stream and reconstructs the causal chain, ending at the step that failed."
        />
      )}
    </>
  );
}
