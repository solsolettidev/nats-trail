import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Filter } from "@nats-trail/core";

const DATA_DIR = process.env.NATS_TRAIL_DATA ?? join(process.cwd(), "data");
const CONTEXTS_FILE = join(DATA_DIR, "contexts.json");
const FILTERS_FILE = join(DATA_DIR, "filters.json");

export function loadLocalContexts(): Context[] {
  return readJson<Context[]>(CONTEXTS_FILE, []);
}

export function loadLocalFilters(): Filter[] {
  return readJson<Filter[]>(FILTERS_FILE, []);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
