import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@nats-trail/core";

const DATA_DIR = process.env.NATS_TRAIL_DATA ?? join(process.cwd(), "data");
const CONTEXTS_FILE = join(DATA_DIR, "contexts.json");
const PREFS_FILE = join(DATA_DIR, "preferences.json");

export interface Preferences {
  selectedContextId: string | null;
  lastSubject: string | null;
  recentSubjects: string[];
  favoriteSubjects: string[];
  recentStreams: string[];
}

const DEFAULT_PREFS: Preferences = {
  selectedContextId: null,
  lastSubject: null,
  recentSubjects: [],
  favoriteSubjects: [],
  recentStreams: [],
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

export function loadPreferences(): Preferences {
  return { ...DEFAULT_PREFS, ...readJson<Partial<Preferences>>(PREFS_FILE, {}) };
}

export function savePreferences(prefs: Preferences): void {
  writeJson(PREFS_FILE, prefs);
}
