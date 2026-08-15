import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractCorrelations, type CorrelationKey, type Message } from "@nats-trail/core";

/**
 * A local index of correlation values, so tracing a request does not mean
 * scanning every stream.
 *
 * Opt-in and per stream: building one reads a whole stream once, which is
 * exactly the cost the index exists to avoid paying repeatedly. Nothing is
 * indexed until somebody asks for it.
 *
 * Coverage is recorded and reported. An index that quietly covered only part of
 * a stream would turn "no results" into a lie, so every answer says what range
 * it was able to look at.
 */

const DATA_DIR = process.env.NATS_TRAIL_DATA ?? join(process.cwd(), "data");
const DB_FILE = join(DATA_DIR, "correlation-index.db");

export interface IndexedLocation {
  stream: string;
  seq: number;
  subject: string;
  timestamp: number;
}

export interface StreamCoverage {
  contextId: string;
  stream: string;
  /** Lowest and highest stream sequence examined. */
  fromSeq: number;
  toSeq: number;
  /** Entries stored for this stream. */
  entries: number;
  /** Distinct correlation keys seen. */
  keys: string[];
  updatedAt: number;
}

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  // WAL keeps a long build from blocking reads of an already-usable index.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      context TEXT NOT NULL,
      stream  TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT NOT NULL,
      seq     INTEGER NOT NULL,
      subject TEXT NOT NULL,
      ts      INTEGER NOT NULL,
      PRIMARY KEY (context, stream, seq, key)
    );
    CREATE INDEX IF NOT EXISTS entries_lookup ON entries (context, key, value);
    CREATE TABLE IF NOT EXISTS coverage (
      context    TEXT NOT NULL,
      stream     TEXT NOT NULL,
      from_seq   INTEGER NOT NULL,
      to_seq     INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (context, stream)
    );
  `);
  return db;
}

/** Close the handle, mainly so tests can delete the file. */
export function closeIndex(): void {
  db?.close();
  db = null;
}

/**
 * Record one message's correlation values.
 *
 * A message with no configured key present stores nothing — the index holds
 * identifiers, not a copy of the stream.
 */
export function indexMessage(
  contextId: string,
  stream: string,
  message: Message,
  keys: CorrelationKey[],
): number {
  const correlations = extractCorrelations(message, keys);
  const names = Object.keys(correlations);
  if (names.length === 0 || message.seq == null) return 0;

  const insert = open().prepare(
    `INSERT OR REPLACE INTO entries (context, stream, key, value, seq, subject, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const name of names) {
    insert.run(contextId, stream, name, correlations[name], message.seq, message.subject, message.timestamp);
  }
  return names.length;
}

/** Insert many messages in one transaction; a build is otherwise dominated by fsync. */
export function indexBatch(
  contextId: string,
  stream: string,
  messages: Message[],
  keys: CorrelationKey[],
): number {
  const handle = open();
  handle.exec("BEGIN");
  let stored = 0;
  try {
    for (const message of messages) stored += indexMessage(contextId, stream, message, keys);
    handle.exec("COMMIT");
  } catch (err) {
    handle.exec("ROLLBACK");
    throw err;
  }
  return stored;
}

/** Record what range of a stream has been examined. */
export function recordCoverage(contextId: string, stream: string, fromSeq: number, toSeq: number): void {
  open()
    .prepare(
      `INSERT INTO coverage (context, stream, from_seq, to_seq, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (context, stream) DO UPDATE SET
         from_seq = MIN(from_seq, excluded.from_seq),
         to_seq = MAX(to_seq, excluded.to_seq),
         updated_at = excluded.updated_at`,
    )
    .run(contextId, stream, fromSeq, toSeq, Date.now());
}

/** Coverage for a context, or for one stream. */
export function getCoverage(contextId: string, stream?: string): StreamCoverage[] {
  const handle = open();
  const rows = stream
    ? handle.prepare("SELECT * FROM coverage WHERE context = ? AND stream = ?").all(contextId, stream)
    : handle.prepare("SELECT * FROM coverage WHERE context = ? ORDER BY stream").all(contextId);

  return (rows as Record<string, unknown>[]).map((row) => {
    const name = String(row.stream);
    const stats = handle
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE context = ? AND stream = ?")
      .get(contextId, name) as { n: number };
    const keys = handle
      .prepare("SELECT DISTINCT key FROM entries WHERE context = ? AND stream = ? ORDER BY key")
      .all(contextId, name) as { key: string }[];
    return {
      contextId,
      stream: name,
      fromSeq: Number(row.from_seq),
      toSeq: Number(row.to_seq),
      entries: Number(stats.n),
      keys: keys.map((k) => k.key),
      updatedAt: Number(row.updated_at),
    };
  });
}

/** Look up every location carrying a value, oldest first. */
export function lookup(contextId: string, key: string, value: string, limit: number): IndexedLocation[] {
  const rows = open()
    .prepare(
      `SELECT stream, seq, subject, ts FROM entries
       WHERE context = ? AND key = ? AND value = ?
       ORDER BY ts, seq LIMIT ?`,
    )
    .all(contextId, key, value, limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    stream: String(row.stream),
    seq: Number(row.seq),
    subject: String(row.subject),
    timestamp: Number(row.ts),
  }));
}

/** Drop a stream's index, or a context's entirely. */
export function dropIndex(contextId: string, stream?: string): void {
  const handle = open();
  if (stream) {
    handle.prepare("DELETE FROM entries WHERE context = ? AND stream = ?").run(contextId, stream);
    handle.prepare("DELETE FROM coverage WHERE context = ? AND stream = ?").run(contextId, stream);
  } else {
    handle.prepare("DELETE FROM entries WHERE context = ?").run(contextId);
    handle.prepare("DELETE FROM coverage WHERE context = ?").run(contextId);
  }
}
