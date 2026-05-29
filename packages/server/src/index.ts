import { createServer } from "node:http";
import express from "express";
import { router } from "./routes.js";
import { attachWebSocket } from "./ws.js";

const PORT = Number(process.env.NATS_TRAIL_PORT ?? 4000);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api", router);

const server = createServer(app);
attachWebSocket(server);

server.listen(PORT, () => {
  console.log(`[nats-trail] API bridge listening on http://localhost:${PORT}`);
});
