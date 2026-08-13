#!/usr/bin/env node
import { startServer } from "./app.js";

const { url, hasUi } = await startServer();
console.log(`[nats-trail] ${hasUi ? "UI + API" : "API bridge"} listening on ${url}`);
