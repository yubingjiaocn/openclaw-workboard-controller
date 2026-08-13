import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import plugin from "./index.js";
import { describe, expect, it } from "vitest";
import { assertCompatibleOpenClawVersion, normalizeControllerConfig, SUPPORTED_OPENCLAW_VERSION } from "./config.js";
import { WorkboardController } from "./controller.js";
import { createGatewayMethodClient } from "./gateway-method-client.js";
import { createWorkboardDispatchRouteHandler } from "./workboard-dispatch-route.js";
import { normalizeWorkboardDispatchRequestBody, WORKBOARD_DISPATCH_ROUTE_PATH } from "./workboard-dispatch-shared.js";
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

async function withHttpServer<T>(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res);
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

describe("plugin entry", () => {
  it("registers a Gateway-authenticated exact self-route for dispatch", () => {
    const routes: Array<Record<string, unknown>> = [];
    (plugin.register as (api: Record<string, unknown>) => void)({
      registrationMode: "tool-discovery",
      pluginConfig: {},
      runtime: { version: SUPPORTED_OPENCLAW_VERSION, agent: {} },
      registerTool() {},
      registerHttpRoute(route: Record<string, unknown>) {
        routes.push(route);
      },
      registerService() {
        throw new Error("service should not register in tool-discovery mode");
      },
    });

    const route = routes.find((entry) => entry.path === WORKBOARD_DISPATCH_ROUTE_PATH);
    expect(route).toMatchObject({ path: WORKBOARD_DISPATCH_ROUTE_PATH, auth: "gateway", match: "exact" });
    expect(route?.handler).toEqual(expect.any(Function));
  });
});

describe("Workboard dispatch self-route", () => {
  it("whitelists only boardId input", () => {
    expect(normalizeWorkboardDispatchRequestBody({ boardId: " default " })).toEqual({ boardId: "default" });
    expect(() => normalizeWorkboardDispatchRequestBody({ boardId: "default", method: "status" })).toThrow(/unsupported request field: method/);
    expect(() => normalizeWorkboardDispatchRequestBody({ boardId: "" })).toThrow(/boardId must be a non-empty string/);
  });

  it("dispatches the fixed workboard.cards.dispatch method and returns started/startFailures payload", async () => {
    const calls: Array<{ method: string; params?: unknown; options?: unknown }> = [];
    const handler = createWorkboardDispatchRouteHandler(async (method, params, options) => {
      calls.push({ method, params, options });
      return {
        ok: true,
        payload: {
          started: [{ cardId: "card-2", title: "next", sessionKey: "agent:main:workboard-card-2", runId: "run-2" }],
          startFailures: [{ cardId: "card-3", error: "no worker" }],
        },
      };
    });

    await withHttpServer(
      async (req, res) => {
        await handler(req, res);
      },
      async (baseUrl) => {
        const response = await fetch(baseUrl + WORKBOARD_DISPATCH_ROUTE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ boardId: "default" }),
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          ok: true,
          payload: {
            started: [{ cardId: "card-2", title: "next", sessionKey: "agent:main:workboard-card-2", runId: "run-2" }],
            startFailures: [{ cardId: "card-3", error: "no worker" }],
          },
        });
      },
    );

    expect(calls).toEqual([{ method: "workboard.cards.dispatch", params: { boardId: "default" }, options: { expectFinal: true } }]);
  });

  it("rejects non-POST and non-whitelisted body fields before dispatch", async () => {
    let dispatchCalls = 0;
    const handler = createWorkboardDispatchRouteHandler(async () => {
      dispatchCalls += 1;
      return { ok: true, payload: {} };
    });

    await withHttpServer(
      async (req, res) => {
        await handler(req, res);
      },
      async (baseUrl) => {
        const getResponse = await fetch(baseUrl + WORKBOARD_DISPATCH_ROUTE_PATH);
        expect(getResponse.status).toBe(405);
        expect(getResponse.headers.get("allow")).toBe("POST");

        const proxyResponse = await fetch(baseUrl + WORKBOARD_DISPATCH_ROUTE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "workboard.cards.dispatch", params: { boardId: "default" } }),
        });
        expect(proxyResponse.status).toBe(400);
        await expect(proxyResponse.json()).resolves.toMatchObject({ ok: false, error: { type: "invalid_request" } });
      },
    );

    expect(dispatchCalls).toBe(0);
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
    expect(wakeRuns[0]).toMatchObject({ sessionKey: "main" });
    expect(wakeRuns[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
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

  it("invokes Workboard notification tools over /tools/invoke with gateway auth and parses result.details", async () => {
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
      },
    );

    expect(captured.map((request) => request.url)).toEqual(["/tools/invoke", "/tools/invoke", "/tools/invoke"]);
    expect(captured.map((request) => request.headers.authorization)).toEqual(["Bearer env-token", "Bearer env-token", "Bearer env-token"]);
    expect(captured.map((request) => request.body.tool)).toEqual(["workboard_notify_subscribe", "workboard_notify_events", "workboard_notify_advance"]);
    expect(captured.map((request) => request.body.tool)).not.toContain("workboard_dispatch");
    expect(captured[0].body).toMatchObject({
      args: { boardId: "default", target: "controller" },
      sessionKey: "main",
    });
  });

  it("invokes Workboard dispatch through the authenticated self-route", async () => {
    const captured: CapturedRequest[] = [];

    await withHttpServer(
      async (req, res) => {
        const body = await readRequestBody(req);
        captured.push({ method: req.method, url: req.url, headers: req.headers, body });
        expect(req.url).toBe(WORKBOARD_DISPATCH_ROUTE_PATH);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, payload: { started: [{ cardId: "card-2", title: "next", sessionKey: "agent:main:workboard-card-2", runId: "run-2" }], startFailures: [] } }));
      },
      async (baseUrl) => {
        const client = createGatewayMethodClient({
          config: { gateway: { auth: { mode: "token", token: "config-token" } } },
          env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
          baseUrl,
        });

        await expect(client.request("workboard.cards.dispatch", { boardId: "default" }, { timeoutMs: 1_000 })).resolves.toEqual({
          started: [{ cardId: "card-2", title: "next", sessionKey: "agent:main:workboard-card-2", runId: "run-2" }],
          startFailures: [],
        });
      },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: "POST",
      url: WORKBOARD_DISPATCH_ROUTE_PATH,
      body: { boardId: "default" },
    });
    expect(captured[0].headers.authorization).toBe("Bearer env-token");
    expect(captured[0].body).not.toHaveProperty("method");
    expect(captured[0].body).not.toHaveProperty("params");
    expect(captured[0].body).not.toHaveProperty("tool");
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
