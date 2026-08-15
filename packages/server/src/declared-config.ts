import { readFileSync, existsSync } from "node:fs";
import {
  validateContext,
  validateCorrelationKeys,
  type Context,
  type CorrelationKey,
} from "@nats-trail/core";

/**
 * Configuration declared by whoever operates the deployment, rather than
 * clicked into the UI.
 *
 * A team running this in their own cluster wants the instance to come up
 * already knowing its contexts — from a ConfigMap, a mounted file, a systemd
 * EnvironmentFile — not to have someone log in and set it up by hand. Declared
 * entries are read-only: the API refuses to edit or delete them, so the file
 * stays the source of truth and a redeploy cannot be silently diverged from.
 */

export interface DeclaredConfig {
  contexts: Context[];
  correlationKeys: CorrelationKey[];
  /** Problems found while loading, surfaced rather than swallowed. */
  errors: string[];
}

const EMPTY: DeclaredConfig = { contexts: [], correlationKeys: [], errors: [] };

/**
 * Resolve `${VAR}` against the environment.
 *
 * This is what keeps credentials out of the config file: the structure lives in
 * a ConfigMap, the passwords in a Secret, and the two meet here. An unset
 * variable is an error rather than an empty string, because silently connecting
 * with no password is worse than failing to start.
 */
function interpolate(value: unknown, path: string, errors: string[]): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = process.env[name];
      if (resolved === undefined) {
        errors.push(`${path}: environment variable ${name} is not set`);
        return "";
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((item, i) => interpolate(item, `${path}[${i}]`, errors));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(child, `${path}.${key}`, errors);
    }
    return out;
  }
  return value;
}

/**
 * Load declared configuration from `NATS_TRAIL_CONFIG`.
 *
 * Absent is fine and means "nothing declared". Present but broken is not: a
 * deployment that starts with half its configuration is harder to diagnose than
 * one that reports what is wrong.
 */
export function loadDeclaredConfig(path = process.env.NATS_TRAIL_CONFIG): DeclaredConfig {
  if (!path) return EMPTY;
  if (!existsSync(path)) {
    return { ...EMPTY, errors: [`NATS_TRAIL_CONFIG points at ${path}, which does not exist`] };
  }

  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ...EMPTY, errors: [`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const resolved = interpolate(parsed, "config", errors) as {
    contexts?: Partial<Context>[];
    correlationKeys?: CorrelationKey[];
  };

  const contexts: Context[] = [];
  for (const [index, raw] of (resolved.contexts ?? []).entries()) {
    const where = `contexts[${index}]`;
    const problems = validateContext(raw);
    if (problems.length) {
      errors.push(...problems.map((problem) => `${where}: ${problem.message}`));
      continue;
    }
    if (!raw.id?.trim()) {
      errors.push(`${where}: id is required for a declared context`);
      continue;
    }
    contexts.push({
      id: raw.id.trim(),
      name: raw.name!.trim(),
      environment: raw.environment ?? "custom",
      url: raw.url!.trim(),
      monitorUrl: raw.monitorUrl?.trim() || undefined,
      correlationKeys: raw.correlationKeys,
      auth: raw.auth ?? { type: "none" },
      tls: raw.tls ?? { enabled: false },
    });
  }

  const keyProblems = resolved.correlationKeys ? validateCorrelationKeys(resolved.correlationKeys) : [];
  errors.push(...keyProblems.map((problem) => `correlationKeys: ${problem}`));

  return {
    contexts,
    correlationKeys: keyProblems.length ? [] : (resolved.correlationKeys ?? []),
    errors,
  };
}

/** Ids of declared contexts, which the API must not let anyone edit or delete. */
export function declaredContextIds(config: DeclaredConfig): Set<string> {
  return new Set(config.contexts.map((context) => context.id));
}

/**
 * Declared contexts take precedence over stored ones with the same id, so a
 * redeploy always reasserts the file.
 */
export function mergeContexts(declared: Context[], stored: Context[]): Context[] {
  const ids = new Set(declared.map((context) => context.id));
  return [...declared, ...stored.filter((context) => !ids.has(context.id))];
}
