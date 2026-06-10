import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context, Filter } from "@nats-trail/core";

const DATA_DIR = process.env.NATS_TRAIL_DATA ?? join(process.cwd(), "data");
const CONTEXTS_FILE = join(DATA_DIR, "contexts.json");
const PREFS_FILE = join(DATA_DIR, "preferences.json");
const FILTERS_FILE = join(DATA_DIR, "filters.json");
const AUDIT_FILE = join(DATA_DIR, "audit.json");
const MAX_AUDIT_ENTRIES = 500;

export interface Preferences {
  selectedContextId: string | null;
  lastSubject: string | null;
  recentSubjects: string[];
  favoriteSubjects: string[];
  recentStreams: string[];
  dlqSubjects: string[];
  messageViewerMode: "tree" | "raw";
}

export interface AuditEntry {
  timestamp: number;
  origin: AuditOrigin;
  tool: string;
  contextId: string | null;
  resultCount: number;
  errorCount: number;
}

export type AuditOrigin = "integration-api" | "cli" | "mcp" | "unknown";

const DEFAULT_PREFS: Preferences = {
  selectedContextId: null,
  lastSubject: null,
  recentSubjects: [],
  favoriteSubjects: [],
  recentStreams: [],
  dlqSubjects: [],
  messageViewerMode: "tree",
};

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDir();
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

export function loadContexts(): Context[] {
  return readJson<Context[]>(CONTEXTS_FILE, []);
}

export function saveContexts(contexts: Context[]): void {
  writeJson(CONTEXTS_FILE, contexts);
}

export function loadFilters(): Filter[] {
  return readJson<Filter[]>(FILTERS_FILE, []);
}

export function saveFilters(filters: Filter[]): void {
  writeJson(FILTERS_FILE, filters);
}

export function loadPreferences(): Preferences {
  return { ...DEFAULT_PREFS, ...readJson<Partial<Preferences>>(PREFS_FILE, {}) };
}

export function savePreferences(prefs: Preferences): void {
  writeJson(PREFS_FILE, prefs);
}

export function appendAuditEntry(entry: AuditEntry): void {
  const entries = readJson<AuditEntry[]>(AUDIT_FILE, []);
  writeJson(AUDIT_FILE, entries.concat(entry).slice(-MAX_AUDIT_ENTRIES));
}

export function loadAuditEntries(): AuditEntry[] {
  return readJson<AuditEntry[]>(AUDIT_FILE, []);
}
