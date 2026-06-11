import { Router, type Request, type Response, type NextFunction } from "express";
import {
  createQueryEnvelope,
  normalizeError,
  sanitizeContext,
  validateContext,
  type Context,
  type Filter,
} from "@nats-trail/core";
import { executeMcpTool, mcpTools } from "@nats-trail/mcp";
import { connectionPool } from "./connection.js";
import { authEnabled, authenticate } from "./auth.js";
import {
  loadContexts,
  appendAuditEntry,
  type AuditOrigin,
  loadAuditEntries,
  loadFilters,
  saveContexts,
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

router.post("/integration/enrich/sentry", async (req, res) => {
  const input = req.body as Record<string, unknown>;
  const envelope = await executeIntegrationTool("natstrail.enrich_sentry", input);
  appendAuditEntry({
    timestamp: Date.now(),
    origin: readAuditOrigin(req.header("x-nats-trail-origin")),
    identity: (res.locals.identity as string | null) ?? null,
    tool: "sentry.enrich",
    contextId: typeof input.contextId === "string" ? input.contextId : null,
    resultCount: envelope.summary.returned,
    errorCount: envelope.errors.length,
  });
  res.json(envelope);
});

// ---- Saved filters ---------------------------------------------------------

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
  });
}

function readAuditOrigin(value: string | undefined): AuditOrigin {
  if (value === "cli" || value === "mcp" || value === "integration-api") return value;
  return value ? "unknown" : "integration-api";
}
