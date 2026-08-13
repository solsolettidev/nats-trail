import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { router } from "./routes.js";
import { attachWebSocket } from "./ws.js";

const PORT = Number(process.env.NATS_TRAIL_PORT ?? 4000);
// Bind to loopback by default: the local API is unauthenticated and holds NATS
// credentials. Set NATS_TRAIL_HOST=0.0.0.0 to expose it on purpose.
const HOST = process.env.NATS_TRAIL_HOST ?? "127.0.0.1";

// Built UI, resolved the same way from src (tsx) and from dist (node).
const UI_DIST = fileURLToPath(new URL("../../ui/dist", import.meta.url));
const hasUi = existsSync(join(UI_DIST, "index.html"));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api", router);

if (hasUi) {
  app.use(express.static(UI_DIST));
  // SPA fallback for anything that is not an API route.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(join(UI_DIST, "index.html"));
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

const server = createServer(app);
attachWebSocket(server);

server.listen(PORT, HOST, () => {
  console.log(`[nats-trail] ${hasUi ? "UI + API" : "API bridge"} listening on http://${HOST}:${PORT}`);
});
