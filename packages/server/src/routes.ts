import { Router } from "express";
import {
  normalizeError,
  sanitizeContext,
  validateContext,
  type Context,
} from "@nats-trail/core";
import { connectionManager } from "./connection.js";
import {
  loadContexts,
  saveContexts,
  loadPreferences,
  savePreferences,
} from "./storage.js";

export const router: Router = Router();

router.get("/health", (_req, res) => {
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
