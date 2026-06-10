import { Router } from "express";
import {
  createQueryEnvelope,
  normalizeError,
  sanitizeContext,
  validateContext,
  type Context,
  type Filter,
} from "@nats-trail/core";
import { executeMcpTool, mcpTools } from "@nats-trail/mcp";
import { connectionManager } from "./connection.js";
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
  res.json(connectionManager.getState());
});

router.post("/connect", async (req, res) => {
  const { contextId } = req.body as { contextId?: string };
  const ctx = loadContexts().find((c) => c.id === contextId);
  if (!ctx) return res.status(404).json({ error: normalizeError("context not found") });
  const state = await connectionManager.connectTo(ctx);
  const prefs = loadPreferences();
  savePreferences({ ...prefs, selectedContextId: ctx.id });
  res.json(state);
});

router.post("/disconnect", async (_req, res) => {
  await connectionManager.disconnect();
  res.json(connectionManager.getState());
});

// ---- JetStream ------------------------------------------------------------

router.get("/streams", async (_req, res) => {
  try {
    res.json(await connectionManager.listStreams());
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

router.get("/streams/:name/consumers", async (req, res) => {
  try {
    res.json(await connectionManager.listConsumers(req.params.name));
  } catch (err) {
    res.status(409).json({ error: normalizeError(err) });
  }
});

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "context"
  );
}

function executeIntegrationTool(name: string, input: Record<string, unknown>) {
  const state = connectionManager.getState();
  return executeMcpTool(name, input, {
    contexts: loadContexts(),
    filters: loadFilters(),
    auditEntries: loadAuditEntries(),
    connectionState: state,
    activeContextId: state.contextId,
    listStreams: () => connectionManager.listStreams(),
    listConsumers: (stream) => connectionManager.listConsumers(stream),
    getStreamMessage: (stream, seq) => connectionManager.getStreamMessage(stream, seq),
    searchStreamMessages: (toolInput) => connectionManager.searchStreamMessages(toolInput),
  });
}

function readAuditOrigin(value: string | undefined): AuditOrigin {
  if (value === "cli" || value === "mcp" || value === "integration-api") return value;
  return value ? "unknown" : "integration-api";
}
