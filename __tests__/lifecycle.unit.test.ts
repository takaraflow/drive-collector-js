import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { resetMockData } from './mocks/redis-on-workers.js';

describe("lifecycle: waitUntil compliance", () => {
  beforeEach(() => {
    resetMockData();
  });

  it("should finish all background tasks registered via waitUntil", async () => {
    const ctx = createExecutionContext();

    const req = new Request("https://example.com/health");
    const res = await worker.fetch(req, env as any, ctx);

    expect(res.status).toBeGreaterThanOrEqual(200);

    await waitOnExecutionContext(ctx);
  });

  it("should handle health check with empty instances", async () => {
    const ctx = createExecutionContext();

    const req = new Request("https://example.com/health");
    const res = await worker.fetch(req, env as any, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.activeInstances).toBe(0);

    await waitOnExecutionContext(ctx);
  });
});
