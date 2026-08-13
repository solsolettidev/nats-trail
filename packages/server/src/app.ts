import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { router } from "./routes.js";
import { attachWebSocket } from "./ws.js";

export interface ServeOptions {
  port?: number;
  host?: string;
}

export interface ServeResult {
  server: Server;
  url: string;
  hasUi: boolean;
}

/**
 * Locate the built UI. In the monorepo it sits next to this package; once
 * published, `@nats-trail/ui` resolves through node_modules instead.
 */
function resolveUiDist(): string | null {
  const candidates = [fileURLToPath(new URL("../../ui/dist", import.meta.url))];
  try {
    const require = createRequire(import.meta.url);
    candidates.push(dirname(require.resolve("@nats-trail/ui/package.json")) + "/dist");
  } catch {
    // Not installed as a dependency; the monorepo path above is the only option.
  }
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

export function createApp(): { app: express.Express; uiDist: string | null } {
  const uiDist = resolveUiDist();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", router);

  if (uiDist) {
    app.use(express.static(uiDist));
    // SPA fallback for anything that is not an API route.
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(join(uiDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.json({
        name: "nats-trail-api",
        ok: true,
        ui: "http://localhost:5173",
        hint: "run npm run build to serve the UI from this server",
        health: "/api/health",
        integrationTools: "/api/integration/tools",
      });
    });
  }

  return { app, uiDist };
}

/**
 * Start the API bridge, serving the built UI when it is available.
 *
 * Binds to loopback by default: the local API is unauthenticated and reads the
 * stored NATS credentials. Pass a host (or set `NATS_TRAIL_HOST`) to expose it.
 */
export function startServer(options: ServeOptions = {}): Promise<ServeResult> {
  const port = options.port ?? Number(process.env.NATS_TRAIL_PORT ?? 4000);
  const host = options.host ?? process.env.NATS_TRAIL_HOST ?? "127.0.0.1";
  const { app, uiDist } = createApp();

  const server = createServer(app);
  attachWebSocket(server);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve({ server, url: `http://${host}:${port}`, hasUi: uiDist !== null });
    });
  });
}
