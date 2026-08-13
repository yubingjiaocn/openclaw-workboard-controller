import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { describe, expect, it } from "vitest";
import { assertCompatibleOpenClawVersion, normalizeControllerConfig, SUPPORTED_OPENCLAW_VERSION } from "./config.js";
import { WorkboardController } from "./controller.js";
import { createGatewayMethodClient } from "./gateway-method-client.js";
import type { ControllerState, StateStore } from "./state.js";
import { emptyState } from "./state.js";

class MemoryStateStore implements StateStore {
  path = "memory://state.json";
  state: ControllerState = emptyState();
  async load() {
    return structuredClone(this.state);
  }
  async save(state: ControllerState) {
    this.state = structuredClone(state);
  }
}

function makeRuntimeAgent() {
  const wakeRuns: Record<string, unknown>[] = [];
  return {
    wakeRuns,
    runtimeAgent: {
      resolveAgentWorkspaceDir: () => "/tmp/workspace",
      resolveAgentTimeoutMs: () => 120_000,
      runEmbeddedAgent: async (params: Record<string, unknown>) => {
        wakeRuns.push(params);
        return { ok: true };
      },
    },
  };
}

type CapturedRequest = {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

async function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  await once(req, "end");
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function withToolInvokeServer<T>(handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void | Promise<void>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      await handler(req, res, body);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { type: "TEST_ERROR", message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("config", () => {
  it("defaults to the pinned OpenClaw version", () => {
    const config = normalizeControllerConfig({});
    expect(config.compatibleOpenClawVersions).toEqual([SUPPORTED_OPENCLAW_VERSION]);
    expect(() => assertCompatibleOpenClawVersion(config, SUPPORTED_OPENCLAW_VERSION)).not.toThrow();
    expect(() => assertCompatibleOpenClawVersion(config, "2026.8.1")).toThrow(/version-gated/);
  });
});

describe("WorkboardController", () => {
  it("dispatches after completed notification and advances after durable processing", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "workboard.notifications.subscribe") return { subscription: { id: "sub-1" } };
          if (method === "workboard.notifications.events") {
            return { events: [{ id: "evt-1", kind: "completed", createdAt: 1, message: "done" }] };
          }
          if (method === "workboard.cards.dispatch") return { started: [{ id: "card-2", title: "next" }] };
          return {};
        },
      },
    });

    await controller.runOnce("test");

    expect(calls.map((call) => call.method)).toEqual([
      "workboard.notifications.subscribe",
      "workboard.notifications.events",
      "workboard.notifications.advance",
      "workboard.cards.dispatch",
    ]);
    expect(store.state.processedEventIds).toEqual(["evt-1"]);
    expect(store.state.counters.dispatches).toBe(1);
    expect(wakeRuns).toHaveLength(0);
  });

  it("wakes once for repeated failed notification ids", async () => {
    const store = new MemoryStateStore();
    const calls: string[] = [];
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, wakeFallbackSessionKey: "main" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: {
        async request(method) {
          calls.push(method);
          if (method === "workboard.notifications.subscribe") return { subscription: { id: "sub-1" } };
          if (method === "workboard.notifications.events") {
            return { events: [{ id: "evt-failed", kind: "failed", createdAt: 1, message: "failed", sessionKey: "main" }] };
          }
          if (method === "workboard.cards.dispatch") return {};
          return {};
        },
      },
    });

    await controller.runOnce("first");
    await controller.runOnce("second");

    expect(wakeRuns).toHaveLength(1);
    expect(calls.filter((method) => method === "workboard.cards.dispatch")).toHaveLength(1);
    expect(calls.filter((method) => method === "workboard.notifications.advance")).toHaveLength(2);
    expect(store.state.notifiedProblemIds).toEqual(["failed:evt-failed"]);
    expect(store.state.processedEventIds).toEqual(["evt-failed"]);
  });
});


describe("GatewayMethodClient", () => {
  it("documents the old SDK dispatch failure outside authenticated route scope", async () => {
    await expect(dispatchGatewayMethod("workboard.cards.dispatch", {})).rejects.toThrow(/reserved for plugin HTTP routes/);
  });

  it("invokes Workboard tools over /tools/invoke with gateway auth and parses result.details", async () => {
    const captured: CapturedRequest[] = [];

    await withToolInvokeServer(
      (req, res, body) => {
        captured.push({ method: req.method, url: req.url, headers: req.headers, body });
        const tool = body.tool;
        const details =
          tool === "workboard_notify_subscribe"
            ? { subscription: { id: "sub-http" } }
            : tool === "workboard_notify_events"
              ? { subscription: { id: "sub-http" }, events: [{ id: "evt-http", kind: "completed", createdAt: 1, message: "done" }] }
              : tool === "workboard_notify_advance"
                ? { subscription: { id: "sub-http", lastEventId: "evt-http" }, events: [{ id: "evt-http", kind: "completed", createdAt: 1, message: "done" }] }
                : tool === "workboard_dispatch"
                  ? { promoted: [], reclaimed: [], blocked: [], orchestrated: [], count: 0 }
                  : { unexpectedTool: tool };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { content: [{ type: "text", text: JSON.stringify(details) }], details } }));
      },
      async (baseUrl) => {
        const client = createGatewayMethodClient({
          config: { gateway: { auth: { mode: "token", token: "config-token" } } },
          env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
          baseUrl,
        });

        await expect(client.request("workboard.notifications.subscribe", { boardId: "default", target: "controller" })).resolves.toEqual({ subscription: { id: "sub-http" } });
        await expect(client.request("workboard.notifications.events", { subscriptionId: "sub-http", limit: 10 })).resolves.toEqual({
          subscription: { id: "sub-http" },
          events: [{ id: "evt-http", kind: "completed", createdAt: 1, message: "done" }],
        });
        await expect(client.request("workboard.notifications.advance", { subscriptionId: "sub-http", limit: 1 })).resolves.toEqual({
          subscription: { id: "sub-http", lastEventId: "evt-http" },
          events: [{ id: "evt-http", kind: "completed", createdAt: 1, message: "done" }],
        });
        await expect(client.request("workboard.cards.dispatch", { boardId: "default" }, { timeoutMs: 1_000 })).resolves.toEqual({
          promoted: [],
          reclaimed: [],
          blocked: [],
          orchestrated: [],
          count: 0,
        });
      },
    );

    expect(captured.map((request) => request.url)).toEqual(["/tools/invoke", "/tools/invoke", "/tools/invoke", "/tools/invoke"]);
    expect(captured.map((request) => request.headers.authorization)).toEqual(["Bearer env-token", "Bearer env-token", "Bearer env-token", "Bearer env-token"]);
    expect(captured.map((request) => request.body.tool)).toEqual(["workboard_notify_subscribe", "workboard_notify_events", "workboard_notify_advance", "workboard_dispatch"]);
    expect(captured[0].body).toMatchObject({
      args: { boardId: "default", target: "controller" },
      sessionKey: "main",
    });
    expect(captured[3].body).toMatchObject({ args: { boardId: "default" } });
  });

  it("parses JSON text content when tool result details are absent", async () => {
    await withToolInvokeServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { content: [{ type: "text", text: '{"events":[]}' }] } }));
      },
      async (baseUrl) => {
        const client = createGatewayMethodClient({
          config: { gateway: { auth: { mode: "none" } } },
          env: {},
          baseUrl,
          sessionKey: "agent:main",
        });
        await expect(client.request("workboard.notifications.events", {})).resolves.toEqual({ events: [] });
      },
    );
  });
});
