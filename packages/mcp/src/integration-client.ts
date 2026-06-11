import { normalizeError, type QueryEnvelope } from "@nats-trail/core";

export async function callIntegrationTool(baseUrl: string, name: string, input: Record<string, unknown>, origin = "mcp"): Promise<QueryEnvelope<unknown>> {
  try {
    const token = process.env.NATS_TRAIL_TOKEN;
    const res = await fetch(`${trimSlash(baseUrl)}/api/integration/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nats-trail-origin": origin,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    const body = await res.json() as QueryEnvelope<unknown>;
    if (res.ok) return body;
    return {
      query: { tool: name, limit: Number(input.limit) || 50 },
      summary: { returned: 0, limit: Number(input.limit) || 50, truncated: false },
      results: [],
      nextCursor: null,
      warnings: [],
      errors: body.errors?.length ? body.errors : [normalizeError(`Integration API returned ${res.status}`)],
    };
  } catch (err) {
    return {
      query: { tool: name, limit: Number(input.limit) || 50 },
      summary: { returned: 0, limit: Number(input.limit) || 50, truncated: false },
      results: [],
      nextCursor: null,
      warnings: [],
      errors: [normalizeError(err)],
    };
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
