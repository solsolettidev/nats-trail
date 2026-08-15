import { Router, type Request, type Response, type NextFunction } from "express";
import {
  createQueryEnvelope,
  normalizeError,
  sanitizeContext,
  validateContext,
  type ConsumerSpec,
  resolveCorrelationKeys,
  validateCorrelationKeys,
  type Context,
  type CorrelationKey,
  type Filter,
  type IncidentContext,
  type StreamSpec,
} from "@nats-trail/core";
import { executeMcpTool, mcpTools } from "@nats-trail/mcp";
import { connectionPool } from "./connection.js";
import { fetchServerConnections, fetchServerHealth } from "./monitoring.js";
import { authEnabled, authenticate, canWrite } from "./auth.js";
import {
  loadContexts,
  appendAuditEntry,
  type AuditOrigin,
  loadAuditEntries,
  loadCorrelationKeys,
  loadFilters,
  saveContexts,
  saveCorrelationKeys,
  saveFilters,
  loadPreferences,
  savePreferences,
} from "./storage.js";

export const router: Router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ---- Integration API -------------------------------------------------------

// Bearer auth: enforced when at least one token is configured. The matched
// token name becomes the audit identity, replacing trust in the origin header.
function integrationAuth(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header("authorization") ?? (typeof req.query.token === "string" ? req.query.token : undefined);
  const identity = authenticate(raw);
  if (!identity && authEnabled()) {
    res.status(401).json({ error: normalizeError("missing or invalid bearer token") });
    return;
  }
  res.locals.identity = identity?.name ?? null;
  next();
}

router.use("/integration", integrationAuth);

router.get("/integration/tools", (req, res) => {
  res.json(createQueryEnvelope({ query: { route: req.path }, results: mcpTools, limit: Number(req.query.limit) || 50 }));
});

router.get("/integration/audit", (req, res) => {
  res.json(createQueryEnvelope({ query: { route: req.path }, results: loadAuditEntries(), limit: Number(req.query.limit) || 50 }));
});

router.post("/integration/tools/:name", async (req, res) => {
  const input = req.body as Record<string, unknown>;
  const envelope = await executeIntegrationTool(req.params.name, input);
  appendAuditEntry({
    timestamp: Date.now(),
    origin: readAuditOrigin(req.header("x-nats-trail-origin")),
    identity: (res.locals.identity as string | null) ?? null,
    tool: req.params.name,
    contextId: typeof input.contextId === "string" ? input.contextId : null,
    resultCount: envelope.summary.returned,
    errorCount: envelope.errors.length,
  });
  res.json(envelope);
});


/**
 * Enrichment adapters.
 *
 * One read tool builds the context (`natstrail.enrich_incident`); each route
 * below only reshapes it for a destination's annotation format. Adding a
 * destination means adding a shaper, never another query.
 */
async function incidentContext(req: Request): Promise<{ context: IncidentContext | null; errors: unknown[]; returned: number }> {
  const input = req.body as Record<string, unknown>;
  const envelope = await executeIntegrationTool("natstrail.enrich_incident", {
    ...input,
    contextId: typeof input.contextId === "string" ? input.contextId : requestContextId(req),
    limit: Number(input.limit) || 100,
  });
  return {
    context: (envelope.results[0] as IncidentContext | undefined) ?? null,
    errors: envelope.errors,
    returned: envelope.summary.returned,
  };
}

function auditEnrichment(req: Request, res: Response, tool: string, returned: number, errorCount: number): void {
  appendAuditEntry({
    timestamp: Date.now(),
    origin: readAuditOrigin(req.header("x-nats-trail-origin")),
    identity: (res.locals.identity as string | null) ?? null,
    tool,
    contextId: typeof (req.body as Record<string, unknown>)?.contextId === "string" ? ((req.body as Record<string, unknown>).contextId as string) : null,
    resultCount: returned,
    errorCount,
  });
}

router.post("/integration/enrich/incident", async (req, res) => {
  const { context, errors, returned } = await incidentContext(req);
  auditEnrichment(req, res, "enrich.incident", returned, errors.length);
  if (!context) return res.status(409).json({ errors });
  res.json(context);
});

/** Grafana annotation: a dashboard marker with tags and an HTML-ish body. */
router.post("/integration/enrich/grafana", async (req, res) => {
  const { context, errors, returned } = await incidentContext(req);
  auditEnrichment(req, res, "enrich.grafana", returned, errors.length);
  if (!context) return res.status(409).json({ errors });

  const first = context.flow?.steps[0];
  const last = context.flow?.steps[context.flow.steps.length - 1];
  res.json({
    time: first?.timestamp ?? Date.now(),
    timeEnd: last?.timestamp ?? undefined,
    tags: [
      "nats-trail",
      context.key,
      context.flow?.failed ? "failed" : "ok",
      ...(context.flow?.streams ?? []).map((stream) => `stream:${stream}`),
    ],
    text: context.traceUrl ? `${context.summary} <a href="${context.traceUrl}">Open trace</a>` : context.summary,
  });
});

/** Datadog event: title, markdown text, alert type and tags. */
router.post("/integration/enrich/datadog", async (req, res) => {
  const { context, errors, returned } = await incidentContext(req);
  auditEnrichment(req, res, "enrich.datadog", returned, errors.length);
  if (!context) return res.status(409).json({ errors });

  const steps = (context.flow?.steps ?? [])
    .map((step) => `- \`${step.subject}\` (${step.stream}) ${step.status}${step.detail ? ` — ${step.detail}` : ""}`)
    .join("\n");

  res.json({
    title: `NATS Trail: ${context.value}`,
    text: [
      `%%%`,
      context.summary,
      "",
      steps ? `**Flow**\n${steps}` : "No flow reconstructed.",
      context.traceUrl ? `\n[Open trace](${context.traceUrl})` : "",
      `%%%`,
    ].join("\n"),
    alert_type: context.flow?.failed ? "error" : "info",
    source_type_name: "nats-trail",
    aggregation_key: context.value,
    tags: ["nats-trail", `${context.key}:${context.value}`, ...(context.flow?.streams ?? []).map((s) => `stream:${s}`)],
  });
});

/**
 * PagerDuty Events API v2 payload.
 *
 * `dedup_key` is the correlation value, so repeated enrichment for the same
 * incident updates one alert instead of paging twice.
 */
router.post("/integration/enrich/pagerduty", async (req, res) => {
  const { context, errors, returned } = await incidentContext(req);
  auditEnrichment(req, res, "enrich.pagerduty", returned, errors.length);
  if (!context) return res.status(409).json({ errors });

  const failed = context.flow?.failed ?? false;
  res.json({
    // routing_key is intentionally absent: it is the caller's integration
    // secret, and the bridge has no business holding it.
    event_action: failed ? "trigger" : "resolve",
    dedup_key: `nats-trail/${context.key}/${context.value}`,
    payload: {
      summary: context.summary.slice(0, 1024),
      source: context.flow?.failedAt?.stream ?? "nats-trail",
      severity: failed ? "error" : "info",
      component: context.flow?.failedAt?.subject ?? null,
      group: context.flow?.streams.join(", ") || null,
      class: context.key,
      custom_details: {
        [context.key]: context.value,
        failed_at: context.flow?.failedAt?.subject ?? null,
        failure_reason: context.flow?.failedAt?.detail ?? null,
        steps: context.flow?.steps.length ?? 0,
        duration_ms: context.flow?.durationMs ?? null,
        streams: context.flow?.streams ?? [],
        dead_letters: context.dlq.length,
        findings: context.findings.map((f) => `[${f.severity}] ${f.message}`),
      },
    },
    links: context.traceUrl ? [{ href: context.traceUrl, text: "Open trace in NATS Trail" }] : [],
  });
});

// Kept for compatibility: the original Sentry shape, now built from the same
// context rather than a bundle of nested envelopes.
router.post("/integration/enrich/sentry", async (req, res) => {
  const { context, errors, returned } = await incidentContext(req);
  auditEnrichment(req, res, "sentry.enrich", returned, errors.length);
  if (!context) return res.status(409).json({ errors });

  res.json({
    message: context.summary,
    level: context.flow?.failed ? "error" : "info",
    fingerprint: [context.key, context.value],
    contexts: {
      "nats-trail": {
        [context.key]: context.value,
        failed_at: context.flow?.failedAt?.subject ?? null,
        failure_reason: context.flow?.failedAt?.detail ?? null,
        streams: context.flow?.streams ?? [],
        steps: context.flow?.steps.length ?? 0,
        duration_ms: context.flow?.durationMs ?? null,
        dead_letters: context.dlq.length,
        trace_url: context.traceUrl,
      },
    },
    extra: { flow: context.flow?.steps ?? [], findings: context.findings },
  });
});

// ---- Saved filters ---------------------------------------------------------

// ---- Correlation keys ------------------------------------------------------

router.get("/correlation-keys", (req, res) => {
  const contextId = requestContextId(req);
  const context = loadContexts().find((item) => item.id === contextId);
  const global = loadCorrelationKeys();
  res.json({
    // What actually applies to this context, and where it came from, so the
    // caller does not have to reimplement the precedence rule.
    effective: resolveCorrelationKeys(context?.correlationKeys, global),
    source: context?.correlationKeys?.length ? "context" : global.length ? "global" : "default",
    global,
    context: context?.correlationKeys ?? null,
  });
});

router.put("/correlation-keys", (req, res) => {
  const keys = (req.body as { keys?: unknown })?.keys;
  const errors = validateCorrelationKeys(keys);
  if (errors.length) return res.status(400).json({ errors: errors.map((message) => normalizeError(message)) });
  saveCorrelationKeys(keys as CorrelationKey[]);
  res.json({ ok: true, keys });
});

router.get("/filters", (_req, res) => {
  res.json(loadFilters());
});

router.post("/filters", (req, res) => {
  const body = req.body as Partial<Filter>;
  if (!body.name?.trim()) return res.status(400).json({ error: normalizeError("filter name is required") });
  const filters = loadFilters();
  const id = body.id?.trim() || slug(body.name);
  const filter: Filter = {
    id,
    name: body.name.trim(),
    subject: body.subject?.trim() || undefined,
    stream: body.stream?.trim() || undefined,
    text: body.text?.trim() || undefined,
    fromTs: body.fromTs,
    toTs: body.toTs,
    eventType: body.eventType?.trim() || undefined,
  };
  saveFilters(filters.filter((item) => item.id !== id).concat(filter));
  res.status(201).json(filter);
});

router.delete("/filters/:id", (req, res) => {
  saveFilters(loadFilters().filter((filter) => filter.id !== req.params.id));
  res.json({ ok: true });
});

// ---- Contexts -------------------------------------------------------------

router.get("/contexts", (_req, res) => {
  res.json(loadContexts().map(sanitizeContext));
});

router.post("/contexts", (req, res) => {
  const body = req.body as Partial<Context>;
  const errors = validateContext(body);
  if (errors.length) return res.status(400).json({ errors });

  const contexts = loadContexts();
  const id = body.id?.trim() || slug(body.name ?? "context");
  const ctx: Context = {
    id,
    name: body.name!.trim(),
    environment: body.environment ?? "custom",
    url: body.url!.trim(),
    monitorUrl: body.monitorUrl?.trim() || undefined,
    correlationKeys: body.correlationKeys?.length ? body.correlationKeys : undefined,
    auth: body.auth ?? { type: "none" },
    tls: body.tls ?? { enabled: false },
  };
  const next = contexts.filter((c) => c.id !== id).concat(ctx);
  saveContexts(next);
  res.status(201).json(sanitizeContext(ctx));
});

router.delete("/contexts/:id", (req, res) => {
  const next = loadContexts().filter((c) => c.id !== req.params.id);
  saveContexts(next);
  res.json({ ok: true });
});

// ---- Preferences ----------------------------------------------------------

router.get("/preferences", (_req, res) => {
  res.json(loadPreferences());
});

router.put("/preferences", (req, res) => {
  const prefs = loadPreferences();
  savePreferences({ ...prefs, ...req.body });
  res.json(loadPreferences());
});

// ---- Connection -----------------------------------------------------------

router.get("/connection", (_req, res) => {
  res.json(connectionPool.getState(selectedContextId()));
});

router.get("/connections", (_req, res) => {
  res.json(connectionPool.getStates());
});

router.post("/connect", async (req, res) => {
  const { contextId, select } = req.body as { contextId?: string; select?: boolean };
  const ctx = loadContexts().find((c) => c.id === contextId);
  if (!ctx) return res.status(404).json({ error: normalizeError("context not found") });
  const state = await connectionPool.connect(ctx);
  // Only explicit callers (the UI) move the selected context; agent/CLI
  // auto-connects must never steal the selection from another caller.
  if (select === true) {
    const prefs = loadPreferences();
    savePreferences({ ...prefs, selectedContextId: ctx.id });
  }
  res.json(state);
});

router.post("/disconnect", async (req, res) => {
  const { contextId } = (req.body ?? {}) as { contextId?: string };
  const target = contextId ?? selectedContextId();
  if (target) await connectionPool.disconnect(target);
  res.json(connectionPool.getState(target));
});

// ---- JetStream ------------------------------------------------------------

router.get("/streams", async (req, res) => {
  try {
    res.json(await connectionPool.listStreams(requestContextId(req)));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/streams/:name/consumers", async (req, res) => {
  try {
    res.json(await connectionPool.listConsumers(requestContextId(req), req.params.name));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/kv", async (req, res) => {
  try {
    res.json(await connectionPool.listKvBuckets(requestContextId(req)));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/kv/:bucket/keys", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 200;
    res.json(await connectionPool.listKvEntries(requestContextId(req), req.params.bucket, limit));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/kv/:bucket/keys/:key/history", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    res.json(await connectionPool.kvHistory(requestContextId(req), req.params.bucket, req.params.key, limit));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/obj", async (req, res) => {
  try {
    res.json(await connectionPool.listObjectBuckets(requestContextId(req)));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/obj/:bucket/objects", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 200;
    res.json(await connectionPool.listObjects(requestContextId(req), req.params.bucket, limit));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/flow", async (req, res) => {
  const requestId = typeof req.query.requestId === "string" ? req.query.requestId : undefined;
  const correlationId = typeof req.query.correlationId === "string" ? req.query.correlationId : undefined;
  if (!requestId && !correlationId) {
    return res.status(400).json({ error: normalizeError("requestId or correlationId is required") });
  }
  const envelope = await executeIntegrationTool("natstrail.reconstruct_flow", {
    contextId: requestContextId(req),
    requestId,
    correlationId,
    limit: Number(req.query.limit) || 100,
  });
  if (envelope.errors.length) return res.status(409).json({ error: envelope.errors[0] });
  res.json(envelope.results[0] ?? null);
});

router.get("/health-summary", async (req, res) => {
  const envelope = await executeIntegrationTool("natstrail.get_health_summary", {
    contextId: requestContextId(req),
    limit: Number(req.query.limit) || 50,
  });
  if (envelope.errors.length) return res.status(409).json({ error: envelope.errors[0] });
  res.json(envelope.results);
});

router.get("/server/health", async (req, res) => {
  try {
    res.json(await fetchServerHealth(requireContext(requestContextId(req))));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/server/connections", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    res.json(await fetchServerConnections(requireContext(requestContextId(req)), limit));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

/** Look up a stored context by id, for endpoints that read its monitoring URL. */
function requireContext(contextId: string): Context {
  const ctx = loadContexts().find((item) => item.id === contextId);
  if (!ctx) throw new Error(`Unknown context: ${contextId || "no context"}`);
  return ctx;
}

// ---- Mutations -------------------------------------------------------------
//
// Every route below changes state on the NATS server. They are mounted under
// /api/mutate, gated by `mutationAuth`, and audited with their arguments.
//
// None of this is reachable from the MCP runtime: `executeIntegrationTool`
// hands it an object with read functions only, so an agent has no write path to
// call rather than a disabled one.

const mutations = Router();

/**
 * Local human sessions are allowed (the bridge binds to loopback and the UI has
 * no login). Once bearer tokens are configured, a mutation additionally requires
 * a token carrying the `write` scope — `read` tokens are refused here.
 */
function mutationAuth(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header("authorization") ?? (typeof req.query.token === "string" ? req.query.token : undefined);
  const identity = authenticate(raw);
  if (authEnabled()) {
    if (!identity) {
      res.status(401).json({ error: normalizeError("missing or invalid bearer token") });
      return;
    }
    if (!canWrite(identity)) {
      res.status(403).json({ error: normalizeError(`token "${identity.name}" is read-only; mutations need the write scope`) });
      return;
    }
  }
  res.locals.identity = identity?.name ?? null;
  next();
}

mutations.use(mutationAuth);

/** Record a mutation with its arguments so it can be reconstructed later. */
function auditMutation(req: Request, res: Response, action: string, target: string, args: Record<string, unknown>, errorCount = 0): void {
  appendAuditEntry({
    timestamp: Date.now(),
    origin: readAuditOrigin(req.header("x-nats-trail-origin")),
    identity: (res.locals.identity as string | null) ?? null,
    tool: action,
    contextId: requestContextId(req) || null,
    resultCount: errorCount ? 0 : 1,
    errorCount,
    mutation: { action, target, args },
  });
}

mutations.post("/publish", async (req, res) => {
  const { subject, payload, headers } = req.body as { subject?: string; payload?: string; headers?: Record<string, string> };
  if (!subject?.trim()) return res.status(400).json({ error: normalizeError("subject is required") });
  try {
    await connectionPool.publish(requestContextId(req), subject.trim(), payload ?? "", headers);
    auditMutation(req, res, "publish", subject.trim(), { bytes: (payload ?? "").length, headers: headers ? Object.keys(headers) : [] });
    res.json({ ok: true, subject: subject.trim() });
  } catch (err) {
    auditMutation(req, res, "publish", subject.trim(), {}, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.post("/request", async (req, res) => {
  const { subject, payload, timeoutMs } = req.body as { subject?: string; payload?: string; timeoutMs?: number };
  if (!subject?.trim()) return res.status(400).json({ error: normalizeError("subject is required") });
  const timeout = Math.min(Math.max(Number(timeoutMs) || 5000, 100), 30_000);
  try {
    const reply = await connectionPool.request(requestContextId(req), subject.trim(), payload ?? "", timeout);
    auditMutation(req, res, "request", subject.trim(), { timeoutMs: timeout });
    res.json(reply);
  } catch (err) {
    auditMutation(req, res, "request", subject.trim(), { timeoutMs: timeout }, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.put("/streams/:name", async (req, res) => {
  const body = req.body as Partial<StreamSpec>;
  const subjects = (body.subjects ?? []).map((s) => s.trim()).filter(Boolean);
  if (subjects.length === 0) {
    return res.status(400).json({ error: normalizeError("at least one subject is required") });
  }
  try {
    const stream = await connectionPool.upsertStream(requestContextId(req), { ...body, name: req.params.name, subjects });
    auditMutation(req, res, "stream.upsert", req.params.name, { subjects, retention: body.retention, storage: body.storage, replicas: body.replicas });
    res.json(stream);
  } catch (err) {
    auditMutation(req, res, "stream.upsert", req.params.name, { subjects }, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.put("/streams/:name/consumers/:consumer", async (req, res) => {
  const body = req.body as Partial<ConsumerSpec>;
  const target = `${req.params.name}/${req.params.consumer}`;
  try {
    const consumer = await connectionPool.upsertConsumer(requestContextId(req), req.params.name, {
      ...body,
      name: req.params.consumer,
    });
    auditMutation(req, res, "consumer.upsert", target, { filterSubjects: body.filterSubjects, ackPolicy: body.ackPolicy, deliverPolicy: body.deliverPolicy });
    res.json(consumer);
  } catch (err) {
    auditMutation(req, res, "consumer.upsert", target, {}, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.put("/obj/:bucket/objects/:name", async (req, res) => {
  const { value, description } = req.body as { value?: string; description?: string };
  if (typeof value !== "string") return res.status(400).json({ error: normalizeError("value must be a string") });
  const target = `${req.params.bucket}/${req.params.name}`;
  try {
    const object = await connectionPool.objectPut(requestContextId(req), req.params.bucket, req.params.name, value, description);
    auditMutation(req, res, "object.put", target, { bytes: value.length, description });
    res.json(object);
  } catch (err) {
    auditMutation(req, res, "object.put", target, {}, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.delete("/obj/:bucket/objects/:name", async (req, res) => {
  const target = `${req.params.bucket}/${req.params.name}`;
  try {
    await connectionPool.objectDelete(requestContextId(req), req.params.bucket, req.params.name);
    auditMutation(req, res, "object.delete", target, {});
    res.json({ ok: true });
  } catch (err) {
    auditMutation(req, res, "object.delete", target, {}, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.put("/kv/:bucket/keys/:key", async (req, res) => {
  const { value, expectedRevision } = req.body as { value?: string; expectedRevision?: number };
  if (typeof value !== "string") return res.status(400).json({ error: normalizeError("value must be a string") });
  const target = `${req.params.bucket}/${req.params.key}`;
  try {
    const revision = await connectionPool.kvPut(
      requestContextId(req),
      req.params.bucket,
      req.params.key,
      value,
      Number.isFinite(Number(expectedRevision)) ? Number(expectedRevision) : undefined,
    );
    auditMutation(req, res, "kv.put", target, { bytes: value.length, expectedRevision, revision });
    res.json({ ok: true, revision });
  } catch (err) {
    auditMutation(req, res, "kv.put", target, { expectedRevision }, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.delete("/kv/:bucket/keys/:key", async (req, res) => {
  // `purge` discards the key's history; `delete` leaves a readable tombstone.
  const purge = req.query.purge === "true";
  const target = `${req.params.bucket}/${req.params.key}`;
  try {
    if (purge) await connectionPool.kvPurge(requestContextId(req), req.params.bucket, req.params.key);
    else await connectionPool.kvDelete(requestContextId(req), req.params.bucket, req.params.key);
    auditMutation(req, res, purge ? "kv.purge" : "kv.delete", target, { purge });
    res.json({ ok: true });
  } catch (err) {
    auditMutation(req, res, purge ? "kv.purge" : "kv.delete", target, { purge }, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.post("/streams/:name/purge", async (req, res) => {
  const { subject, keep } = req.body as { subject?: string; keep?: number };
  try {
    const purged = await connectionPool.purgeStream(requestContextId(req), req.params.name, {
      subject: subject?.trim() || undefined,
      keep: Number.isFinite(Number(keep)) && Number(keep) > 0 ? Number(keep) : undefined,
    });
    auditMutation(req, res, "stream.purge", req.params.name, { subject, keep, purged });
    res.json({ ok: true, purged });
  } catch (err) {
    auditMutation(req, res, "stream.purge", req.params.name, { subject, keep }, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.delete("/streams/:name/messages/:seq", async (req, res) => {
  const seq = Number(req.params.seq);
  if (!Number.isFinite(seq) || seq <= 0) return res.status(400).json({ error: normalizeError("seq must be a positive integer") });
  try {
    const deleted = await connectionPool.deleteMessage(requestContextId(req), req.params.name, seq);
    auditMutation(req, res, "message.delete", `${req.params.name}#${seq}`, { seq });
    res.json({ ok: deleted });
  } catch (err) {
    auditMutation(req, res, "message.delete", `${req.params.name}#${seq}`, { seq }, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.delete("/streams/:name/consumers/:consumer", async (req, res) => {
  try {
    const deleted = await connectionPool.deleteConsumer(requestContextId(req), req.params.name, req.params.consumer);
    auditMutation(req, res, "consumer.delete", `${req.params.name}/${req.params.consumer}`, {});
    res.json({ ok: deleted });
  } catch (err) {
    auditMutation(req, res, "consumer.delete", `${req.params.name}/${req.params.consumer}`, {}, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

mutations.delete("/streams/:name", async (req, res) => {
  // Deleting a stream destroys its messages, so the caller must name it back.
  if (req.body?.confirm !== req.params.name) {
    return res.status(400).json({ error: normalizeError(`confirm must equal the stream name to delete it: "${req.params.name}"`) });
  }
  try {
    const deleted = await connectionPool.deleteStream(requestContextId(req), req.params.name);
    auditMutation(req, res, "stream.delete", req.params.name, {});
    res.json({ ok: deleted });
  } catch (err) {
    auditMutation(req, res, "stream.delete", req.params.name, {}, 1);
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.use("/mutate", mutations);

function selectedContextId(): string | null {
  return loadPreferences().selectedContextId;
}

function requestContextId(req: Request): string {
  const fromQuery = typeof req.query.contextId === "string" ? req.query.contextId : null;
  return fromQuery ?? selectedContextId() ?? "";
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "context"
  );
}

function executeIntegrationTool(name: string, input: Record<string, unknown>) {
  const requested = typeof input.contextId === "string" && input.contextId ? input.contextId : null;
  const target = requested ?? selectedContextId() ?? "";
  return executeMcpTool(name, input, {
    contexts: loadContexts(),
    filters: loadFilters(),
    auditEntries: loadAuditEntries(),
    connectionState: connectionPool.getState(target || null),
    connectionStates: connectionPool.getStates(),
    activeContextId: requested && connectionPool.isConnected(requested) ? requested : null,
    listStreams: () => connectionPool.listStreams(target),
    listConsumers: (stream) => connectionPool.listConsumers(target, stream),
    getStreamMessage: (stream, seq) => connectionPool.getStreamMessage(target, stream, seq),
    queryStreamMessages: (query) => connectionPool.queryStreamMessages(target, query),
    listKvBuckets: () => connectionPool.listKvBuckets(target),
    listKvEntries: (bucket, limit) => connectionPool.listKvEntries(target, bucket, limit),
    kvHistory: (bucket, key, limit) => connectionPool.kvHistory(target, bucket, key, limit),
    listObjectBuckets: () => connectionPool.listObjectBuckets(target),
    listObjects: (bucket, limit) => connectionPool.listObjects(target, bucket, limit),
    streamSubjects: (stream) => connectionPool.streamSubjects(target, stream),
    correlationKeys: resolveCorrelationKeys(
      loadContexts().find((item) => item.id === target)?.correlationKeys,
      loadCorrelationKeys(),
    ),
    serverHealth: () => fetchServerHealth(requireContext(target)),
    serverConnections: (max) => fetchServerConnections(requireContext(target), max),
  });
}

function readAuditOrigin(value: string | undefined): AuditOrigin {
  if (value === "cli" || value === "mcp" || value === "integration-api") return value;
  return value ? "unknown" : "integration-api";
}
