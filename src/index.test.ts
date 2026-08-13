import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import plugin from "./index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeArchiveCandidates, type WorkboardArchiveCard } from "./archive.js";
import { assertCompatibleOpenClawVersion, normalizeControllerConfig, SUPPORTED_OPENCLAW_VERSION } from "./config.js";
import { WorkboardController } from "./controller.js";
import { createGatewayMethodClient } from "./gateway-method-client.js";
import { createWorkboardDispatchRouteHandler } from "./workboard-dispatch-route.js";
import { createWorkboardArchiveRouteHandler, createWorkboardCreateRouteHandler, createWorkboardListRouteHandler } from "./workboard-gateway-routes.js";
import { normalizeWorkboardDispatchRequestBody, WORKBOARD_DISPATCH_ROUTE_PATH } from "./workboard-dispatch-shared.js";
import {
  normalizeWorkboardArchiveRequestBody,
  normalizeWorkboardCreateRequestBody,
  normalizeWorkboardListRequestBody,
  WORKBOARD_ARCHIVE_ROUTE_PATH,
  WORKBOARD_CREATE_ROUTE_PATH,
  WORKBOARD_LIST_ROUTE_PATH,
} from "./workboard-gateway-shared.js";
import type { ControllerState, StateStore } from "./state.js";
import { createFileStateStore, emptyState } from "./state.js";
import { isReliableExternalOwnerSessionKey } from "./owner-binding.js";

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

function makeRuntimeAgent(options: { fail?: boolean } = {}) {
  const wakeRuns: Record<string, unknown>[] = [];
  return {
    wakeRuns,
    runtimeAgent: {
      resolveAgentWorkspaceDir: () => "/tmp/workspace",
      resolveAgentTimeoutMs: () => 120_000,
      runEmbeddedAgent: async (params: Record<string, unknown>) => {
        wakeRuns.push(params);
        if (options.fail) throw new Error("embedded delivery failed");
        return { ok: true };
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
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


function doneCard(id: string, overrides: Partial<WorkboardArchiveCard> = {}): WorkboardArchiveCard {
  return {
    id,
    title: `Card ${id}`,
    status: "done",
    priority: "normal",
    labels: [],
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    completedAt: 1,
    metadata: { proof: [{ status: "passed" }], ...(overrides.metadata ?? {}) },
    ...overrides,
  } as WorkboardArchiveCard;
}

function linkTo(type: "parent" | "child", targetCardId: string) {
  return { id: `${type}-${targetCardId}`, type, targetCardId, createdAt: 1 };
}

function completedEvent(id: string): Record<string, unknown> {
  return { id, kind: "completed", createdAt: 1, message: "done" };
}

type StartNotificationGatewayOptions = {
  eventBatches?: Array<Array<Record<string, unknown>>>;
  started?: Array<Record<string, unknown>>;
  startFailures?: Array<Record<string, unknown>>;
  blocked?: Array<Record<string, unknown>>;
  cards?: Array<Record<string, unknown>>;
  listError?: Error;
  methods?: string[];
  dispatchCalls?: { count: number };
};

function startNotificationGateway(options: StartNotificationGatewayOptions) {
  let eventBatchIndex = 0;
  return {
    async request(method: string) {
      options.methods?.push(method);
      if (method === "workboard.notifications.subscribe") return { subscription: { id: "sub-start" } };
      if (method === "workboard.notifications.events") {
        const batches = options.eventBatches ?? [[completedEvent("evt-start")]];
        return { events: structuredClone(batches[eventBatchIndex++] ?? []) };
      }
      if (method === "workboard.notifications.advance") return {};
      if (method === "workboard.cards.dispatch") {
        if (options.dispatchCalls) options.dispatchCalls.count += 1;
        return { started: structuredClone(options.started ?? []), blocked: structuredClone(options.blocked ?? []), startFailures: structuredClone(options.startFailures ?? []) };
      }
      if (method === "workboard.cards.list") {
        if (options.listError) throw options.listError;
        return { cards: structuredClone(options.cards ?? []) };
      }
      return {};
    },
  };
}

function archiveGateway(cards: WorkboardArchiveCard[], extra?: { failArchiveIds?: Set<string>; archives?: string[]; listCalls?: { count: number } }) {
  return {
    async request(method: string, params?: unknown) {
      if (method === "workboard.notifications.subscribe") return { subscription: { id: "sub-archive" } };
      if (method === "workboard.notifications.events") return { events: [] };
      if (method === "workboard.cards.list") {
        if (extra?.listCalls) extra.listCalls.count += 1;
        return { cards: structuredClone(cards) };
      }
      if (method === "workboard.cards.archive") {
        const id = (params as { id?: string }).id;
        if (!id) throw new Error("missing id");
        if (extra?.failArchiveIds?.has(id)) throw new Error(`archive denied for ${id}`);
        extra?.archives?.push(id);
        const card = cards.find((entry) => entry.id === id);
        if (!card) throw new Error(`card not found: ${id}`);
        card.metadata = { ...(card.metadata ?? {}), archivedAt: Date.now() };
        return { card };
      }
      return {};
    },
  };
}

describe("config", () => {
  it("defaults to the pinned OpenClaw version", () => {
    const config = normalizeControllerConfig({});
    expect(config.compatibleOpenClawVersions).toEqual([SUPPORTED_OPENCLAW_VERSION]);
    expect(() => assertCompatibleOpenClawVersion(config, SUPPORTED_OPENCLAW_VERSION)).not.toThrow();
    expect(() => assertCompatibleOpenClawVersion(config, "2026.8.1")).toThrow(/version-gated/);
  });

  it("normalizes ownerRoutes and rejects entries without match dimensions", () => {
    expect(normalizeControllerConfig({ ownerRoutes: [{ boardId: " default ", sessionKey: " agent:main:telegram:direct:1 " }] }).ownerRoutes).toEqual([
      { boardId: "default", sessionKey: "agent:main:telegram:direct:1", tenant: undefined, agentId: undefined },
    ]);
    expect(() => normalizeControllerConfig({ ownerRoutes: [{ sessionKey: "agent:main:telegram:direct:1" }] })).toThrow(/at least one/);
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
      on() {},
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


  it("exposes fixed Gateway RPC self-routes for Workboard list and archive", async () => {
    expect(normalizeWorkboardListRequestBody({ boardId: " default " })).toEqual({ boardId: "default" });
    expect(() => normalizeWorkboardListRequestBody({ boardId: "default", method: "workboard.cards.list" })).toThrow(/unsupported request field: method/);
    expect(normalizeWorkboardArchiveRequestBody({ id: " card-1 ", archived: true })).toEqual({ id: "card-1", archived: true });
    expect(() => normalizeWorkboardArchiveRequestBody({ id: "card-1", params: {} })).toThrow(/unsupported request field: params/);

    const calls: Array<{ method: string; params?: unknown; options?: unknown }> = [];
    const listHandler = createWorkboardListRouteHandler(async (method, params, options) => {
      calls.push({ method, params, options });
      return { ok: true, payload: { cards: [{ id: "card-1", title: "done", status: "done" }] } };
    });
    const archiveHandler = createWorkboardArchiveRouteHandler(async (method, params, options) => {
      calls.push({ method, params, options });
      return { ok: true, payload: { card: { id: "card-1", title: "done", status: "done", metadata: { archivedAt: 10 } } } };
    });

    await withHttpServer(
      async (req, res) => {
        if (req.url === WORKBOARD_LIST_ROUTE_PATH) await listHandler(req, res);
        else if (req.url === WORKBOARD_ARCHIVE_ROUTE_PATH) await archiveHandler(req, res);
        else {
          res.writeHead(404);
          res.end();
        }
      },
      async (baseUrl) => {
        const listResponse = await fetch(baseUrl + WORKBOARD_LIST_ROUTE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ boardId: "default" }),
        });
        expect(listResponse.status).toBe(200);
        await expect(listResponse.json()).resolves.toMatchObject({ ok: true, payload: { cards: [{ id: "card-1" }] } });

        const archiveResponse = await fetch(baseUrl + WORKBOARD_ARCHIVE_ROUTE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "card-1", archived: true }),
        });
        expect(archiveResponse.status).toBe(200);
        await expect(archiveResponse.json()).resolves.toMatchObject({ ok: true, payload: { card: { id: "card-1" } } });
      },
    );

    expect(calls).toEqual([
      { method: "workboard.cards.list", params: { boardId: "default" }, options: { expectFinal: true } },
      { method: "workboard.cards.archive", params: { id: "card-1", archived: true }, options: { expectFinal: true } },
    ]);
  });

describe("WorkboardController", () => {
  it("dispatches after completed notification and advances after durable processing", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifyEnabled: false, terminalWakeEnabled: false }),
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
      "workboard.cards.dispatch",
      "workboard.notifications.advance",
    ]);
    expect(store.state.processedEventIds).toEqual(["evt-1"]);
    expect(store.state.counters.dispatches).toBe(1);
    expect(wakeRuns).toHaveLength(0);
  });


  it("wakes the owner session for completed notifications with result context and still dispatches", async () => {
    const store = new MemoryStateStore();
    const methods: string[] = [];
    const dispatchCalls = { count: 0 };
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-complete",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [{ boardId: "board-complete", agentId: "may", sessionKey: "agent:may:feishu:direct:ou_complete" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        methods,
        dispatchCalls,
        eventBatches: [[{ id: "evt-completed-owner", kind: "completed", createdAt: 7, message: "completed with proof", cardId: "card-completed-owner", sessionKey: "agent:may:workboard-card-completed-owner", runId: "run-completed-owner" }]],
        cards: [{
          id: "card-completed-owner",
          boardId: "board-complete",
          agentId: "may",
          title: "Completed Owner Wake",
          status: "done",
          completedAt: 10,
          sessionKey: "agent:may:workboard-card-completed-owner",
          execution: { runId: "run-completed-owner", sessionKey: "agent:may:workboard-card-completed-owner" },
          metadata: { tenant: "tenant-complete", proof: [{ status: "passed", note: "unit proof" }], artifacts: [{ path: "dist/report.txt" }] },
        }],
      }),
    });

    const status = await controller.runOnce("completed-owner");

    expect(methods).toEqual([
      "workboard.notifications.subscribe",
      "workboard.notifications.events",
      "workboard.cards.list",
      "workboard.cards.dispatch",
      "workboard.notifications.advance",
    ]);
    expect(dispatchCalls.count).toBe(1);
    expect(wakeRuns).toHaveLength(1);
    expect(wakeRuns[0]).toMatchObject({ sessionKey: "agent:may:feishu:direct:ou_complete", agentId: "may", trigger: "manual" });
    expect(wakeRuns[0]).not.toMatchObject({ sessionKey: "agent:may:workboard-card-completed-owner" });
    const prompt = String(wakeRuns[0].prompt);
    expect(prompt).toContain("cardId: card-completed-owner");
    expect(prompt).toContain("cardTitle: Completed Owner Wake");
    expect(prompt).toContain("summary: completed with proof");
    expect(prompt).toContain("public.proof");
    expect(prompt).toContain("dist/report.txt");
    expect(prompt).toContain("Review the terminal result");
    expect(prompt).toContain("Do not duplicate Workboard dispatch");
    expect(status.counters.terminalWakes).toBe(1);
    expect(status.counters.terminalWakeErrors).toBe(0);
    expect(status.counters.dispatches).toBe(1);
    expect(status.recentTerminalWakes).toMatchObject([{ wakeKey: "event:evt-completed-owner", kind: "completed", cardId: "card-completed-owner", target: "agent:may:feishu:direct:ou_complete" }]);
  });

  it("deduplicates completed terminal wakes and dispatch after restart", async () => {
    const store = new MemoryStateStore();
    const dispatchCalls = { count: 0 };
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const config = normalizeControllerConfig({
      boardId: "board-repeat",
      dispatchCooldownMs: 0,
      terminalWakeDebounceMs: 0,
      ownerRoutes: [{ boardId: "board-repeat", sessionKey: "agent:main:telegram:direct:repeat-owner" }],
    });

    const first = new WorkboardController({
      config,
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        dispatchCalls,
        eventBatches: [[{ id: "evt-completed-repeat", kind: "completed", createdAt: 1, message: "done" }]],
      }),
    });
    await first.runOnce("before-restart");

    const second = new WorkboardController({
      config,
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        dispatchCalls,
        eventBatches: [[{ id: "evt-completed-repeat", kind: "completed", createdAt: 1, message: "done" }]],
      }),
    });
    const status = await second.runOnce("after-restart");

    expect(wakeRuns).toHaveLength(1);
    expect(dispatchCalls.count).toBe(1);
    expect(status.counters.terminalWakes).toBe(1);
    expect(store.state.terminalWakeIds).toEqual(["event:evt-completed-repeat"]);
    expect(store.state.processedEventIds).toEqual(["evt-completed-repeat"]);
  });

  it("continues dispatch and cursor advance when completed owner wake delivery fails", async () => {
    const store = new MemoryStateStore();
    const methods: string[] = [];
    const dispatchCalls = { count: 0 };
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent({ fail: true });
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-wake-fail",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [{ boardId: "board-wake-fail", sessionKey: "agent:main:telegram:direct:wake-fail-owner" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        methods,
        dispatchCalls,
        eventBatches: [[{ id: "evt-completed-wake-fail", kind: "completed", createdAt: 1, message: "done" }]],
      }),
    });

    const status = await controller.runOnce("wake-failure");

    expect(wakeRuns).toHaveLength(1);
    expect(dispatchCalls.count).toBe(1);
    expect(methods).toEqual([
      "workboard.notifications.subscribe",
      "workboard.notifications.events",
      "workboard.cards.list",
      "workboard.cards.dispatch",
      "workboard.notifications.advance",
    ]);
    expect(status.counters.dispatches).toBe(1);
    expect(status.counters.terminalWakeErrors).toBe(1);
    expect(status.terminalWakeFailures).toMatchObject([{ wakeKey: "event:evt-completed-wake-fail", kind: "completed", target: "agent:main:telegram:direct:wake-fail-owner", error: "embedded delivery failed" }]);
    expect(store.state.processedEventIds).toEqual(["evt-completed-wake-fail"]);
  });

  it("rejects worker ownerRoutes targets for completed terminal wakes without blocking dispatch", async () => {
    const store = new MemoryStateStore();
    const dispatchCalls = { count: 0 };
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-completed-worker",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [{ boardId: "board-completed-worker", agentId: "main", sessionKey: "agent:main:workboard-card-completed-worker" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        dispatchCalls,
        eventBatches: [[{ id: "evt-completed-worker", kind: "completed", createdAt: 1, message: "done", cardId: "card-completed-worker", sessionKey: "agent:main:workboard-card-completed-worker" }]],
        cards: [{ id: "card-completed-worker", boardId: "board-completed-worker", agentId: "main", title: "Completed Worker", sessionKey: "agent:main:workboard-card-completed-worker" }],
      }),
    });

    const status = await controller.runOnce("completed-worker-target");

    expect(wakeRuns).toHaveLength(0);
    expect(dispatchCalls.count).toBe(1);
    expect(status.counters.terminalWakeErrors).toBe(1);
    expect(status.terminalWakeFailures[0]).toMatchObject({ wakeKey: "event:evt-completed-worker", kind: "completed", target: "agent:main:workboard-card-completed-worker" });
    expect(status.terminalWakeFailures[0]?.error).toMatch(/ownerRoutes target rejected as a worker session/);
  });

  it("wakes once for repeated failed notification ids", async () => {
    const store = new MemoryStateStore();
    const calls: string[] = [];
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, terminalWakeDebounceMs: 0, ownerRoutes: [{ boardId: "default", sessionKey: "agent:main:telegram:direct:owner" }] }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: {
        async request(method) {
          calls.push(method);
          if (method === "workboard.notifications.subscribe") return { subscription: { id: "sub-1" } };
          if (method === "workboard.notifications.events") {
            return { events: [{ id: "evt-failed", kind: "failed", createdAt: 1, message: "failed", sessionKey: "agent:main:workboard-card-failed" }] };
          }
          if (method === "workboard.cards.dispatch") return {};
          return {};
        },
      },
    });

    await controller.runOnce("first");
    await controller.runOnce("second");

    expect(wakeRuns).toHaveLength(1);
    expect(wakeRuns[0]).toMatchObject({ sessionKey: "agent:main:telegram:direct:owner" });
    expect(wakeRuns[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.filter((method) => method === "workboard.cards.dispatch")).toHaveLength(1);
    expect(calls.filter((method) => method === "workboard.notifications.advance")).toHaveLength(2);
    expect(store.state.notifiedProblemIds).toEqual(["event:evt-failed"]);
    expect(store.state.processedEventIds).toEqual(["evt-failed"]);
  });

  it("coalesces three near-simultaneous completions for the same owner into one non-sliding batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    const dispatchCalls = { count: 0 };
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        dispatchCooldownMs: 0,
        ownerRoutes: [{ boardId: "default", sessionKey: "agent:main:telegram:direct:batch-owner" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        dispatchCalls,
        eventBatches: [[
          { id: "evt-batch-1", kind: "completed", createdAt: 1, message: "one" },
          { id: "evt-batch-2", kind: "completed", createdAt: 2, message: "two" },
          { id: "evt-batch-3", kind: "completed", createdAt: 3, message: "three" },
        ], [], []],
      }),
    });

    let status = await controller.runOnce("batch-start");
    expect(wakeRuns).toHaveLength(0);
    expect(dispatchCalls.count).toBe(1);
    expect(status.pendingTerminalEvents.total).toBe(3);
    expect(status.counters.terminalEventsQueued).toBe(3);

    vi.setSystemTime(999);
    status = await controller.runOnce("not-yet");
    expect(wakeRuns).toHaveLength(0);

    vi.setSystemTime(1000);
    status = await controller.runOnce("due");
    await flushAsyncWork();
    expect(wakeRuns).toHaveLength(1);
    expect(String(wakeRuns[0].prompt)).toContain("batchSize: 3");
    expect(status.counters.terminalWakeBatches).toBe(1);
    expect(store.state.pendingTerminalEvents).toEqual([]);
  });

  it("wakes a short sibling after debounce and a later long sibling in a second batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, ownerRoutes: [{ boardId: "default", sessionKey: "agent:main:telegram:direct:siblings" }] }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-short", kind: "completed", createdAt: 1, message: "short done" }], [], [{ id: "evt-long", kind: "completed", createdAt: 2, message: "long done" }], []],
      }),
    });

    await controller.runOnce("short-arrives");
    vi.setSystemTime(1000);
    await controller.runOnce("short-due");
    await flushAsyncWork();
    expect(wakeRuns).toHaveLength(1);
    expect(String(wakeRuns[0].prompt)).toContain("evt-short");

    vi.setSystemTime(1500);
    await controller.runOnce("long-arrives");
    expect(wakeRuns).toHaveLength(1);

    vi.setSystemTime(2500);
    await controller.runOnce("long-due");
    await flushAsyncWork();
    expect(wakeRuns).toHaveLength(2);
    expect(String(wakeRuns[1].prompt)).toContain("evt-long");
  });

  it("does not extend the first owner deadline under continuous arrivals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, ownerRoutes: [{ boardId: "default", sessionKey: "agent:main:telegram:direct:continuous" }] }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [
          [{ id: "evt-cont-1", kind: "completed", createdAt: 1, message: "one" }],
          [{ id: "evt-cont-2", kind: "completed", createdAt: 2, message: "two" }],
          [{ id: "evt-cont-3", kind: "completed", createdAt: 3, message: "three" }],
          [],
        ],
      }),
    });

    await controller.runOnce("first");
    vi.setSystemTime(500);
    await controller.runOnce("second");
    vi.setSystemTime(999);
    await controller.runOnce("third");
    expect(wakeRuns).toHaveLength(0);

    vi.setSystemTime(1000);
    await controller.runOnce("first-deadline");
    await flushAsyncWork();
    expect(wakeRuns).toHaveLength(1);
    expect(String(wakeRuns[0].prompt)).toContain("batchSize: 3");
  });

  it("allows mixed completed and failed terminal events in one owner batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, ownerRoutes: [{ boardId: "default", sessionKey: "agent:main:telegram:direct:mixed" }] }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[
          { id: "evt-mixed-completed", kind: "completed", createdAt: 1, message: "done" },
          { id: "evt-mixed-failed", kind: "failed", createdAt: 2, message: "failed" },
        ], []],
      }),
    });

    await controller.runOnce("mixed-arrives");
    vi.setSystemTime(1000);
    const status = await controller.runOnce("mixed-due");
    await flushAsyncWork();
    expect(wakeRuns).toHaveLength(1);
    expect(String(wakeRuns[0].prompt)).toContain("eventKind: completed");
    expect(String(wakeRuns[0].prompt)).toContain("eventKind: failed");
    expect(status.counters.terminalWakes).toBe(2);
    expect(status.counters.terminalWakeBatches).toBe(1);
  });

  it("queues arrivals during an in-flight owner wake for a second immediate batch when overdue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    const wakeRuns: Record<string, unknown>[] = [];
    const resolvers: Array<() => void> = [];
    const runtimeAgent = {
      resolveAgentWorkspaceDir: () => "/tmp/workspace",
      resolveAgentTimeoutMs: () => 120_000,
      runEmbeddedAgent: async (params: Record<string, unknown>) => {
        wakeRuns.push(params);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return { ok: true };
      },
    };
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, ownerRoutes: [{ boardId: "default", sessionKey: "agent:main:telegram:direct:inflight" }] }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-inflight-1", kind: "completed", createdAt: 1, message: "first" }], [], [{ id: "evt-inflight-2", kind: "completed", createdAt: 2, message: "second" }], []],
      }),
    });

    await controller.runOnce("first-arrives");
    vi.setSystemTime(1000);
    let status = await controller.runOnce("first-due");
    expect(wakeRuns).toHaveLength(1);
    expect(status.inFlightOwnerWakes).toHaveLength(1);

    vi.setSystemTime(1100);
    status = await controller.runOnce("second-arrives");
    expect(wakeRuns).toHaveLength(1);
    expect(status.pendingTerminalEvents.total).toBe(2);

    vi.setSystemTime(2200);
    resolvers.shift()?.();
    await flushAsyncWork();
    expect(wakeRuns).toHaveLength(2);
    expect(String(wakeRuns[1].prompt)).toContain("evt-inflight-2");
    resolvers.shift()?.();
    await flushAsyncWork();
    expect(store.state.pendingTerminalEvents).toEqual([]);
  });

  it("delivers a pending terminal inbox after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const config = normalizeControllerConfig({ dispatchCooldownMs: 0, ownerRoutes: [{ boardId: "default", sessionKey: "agent:main:telegram:direct:restart-pending" }] });

    const before = new WorkboardController({
      config,
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({ eventBatches: [[{ id: "evt-pending-restart", kind: "completed", createdAt: 1, message: "done" }]] }),
    });
    await before.runOnce("persist-before-restart");
    expect(store.state.pendingTerminalEvents).toHaveLength(1);

    vi.setSystemTime(1000);
    const after = new WorkboardController({
      config,
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({ eventBatches: [[]] }),
    });
    const status = await after.runOnce("after-restart");
    await flushAsyncWork();
    expect(wakeRuns).toHaveLength(1);
    expect(status.pendingTerminalEvents.total).toBe(0);
    expect(store.state.terminalWakeIds).toEqual(["event:evt-pending-restart"]);
  });

  it("resolves a production-shape pending notification from card metadata on retry and prefers durable binding", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = new MemoryStateStore();
    store.state.ownerBindings = [{ cardId: "31fee4f7-card", ownerSessionKey: "agent:main:telegram:direct:8068735520", ownerAgentId: "main", source: "manual", createdAt: 1 }];
    store.state.pendingTerminalEvents = [{
      wakeKey: "event:a87bab10-prod",
      kind: "completed",
      message: "done",
      firstObservedAt: 0,
      event: { id: "a87bab10-prod", kind: "completed", createdAt: 1, message: "done", sequence: 714 },
      attemptCount: 1,
      lastError: "could not resolve a reliable owner route; configure ownerRoutes with the original owner sessionKey",
    }];
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "default",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [{ boardId: "default", sessionKey: "agent:route:telegram:direct:wrong" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[]],
        cards: [
          { id: "wrong-sequence-card", boardId: "default", title: "Wrong", metadata: { notifications: [{ id: "a87bab10-prod", sequence: 713 }] } },
          { id: "31fee4f7-card", boardId: "default", title: "Real", metadata: { notifications: [{ id: "a87bab10-prod", sequence: 714 }] } },
        ],
      }),
    });

    await controller.runOnce("retry-production-shape");
    await flushAsyncWork();

    expect(wakeRuns).toHaveLength(1);
    expect(wakeRuns[0]).toMatchObject({ sessionKey: "agent:main:telegram:direct:8068735520", agentId: "main" });
    expect(String(wakeRuns[0].prompt)).toContain("cardId: 31fee4f7-card");
    expect(store.state.pendingTerminalEvents).toEqual([]);
    expect(store.state.terminalWakeIds).toEqual(["event:a87bab10-prod"]);
  });

  it("leaves ambiguous and unmatched metadata notification events pending without guessing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    store.state.ownerBindings = [
      { cardId: "ambiguous-a", ownerSessionKey: "agent:a:telegram:direct:1", ownerAgentId: "a", source: "manual", createdAt: 1 },
      { cardId: "ambiguous-b", ownerSessionKey: "agent:b:telegram:direct:2", ownerAgentId: "b", source: "manual", createdAt: 1 },
      { cardId: "sequence-mismatch", ownerSessionKey: "agent:c:telegram:direct:3", ownerAgentId: "c", source: "manual", createdAt: 1 },
    ];
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ boardId: "default", dispatchCooldownMs: 0, terminalWakeDebounceMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[
          { id: "evt-ambiguous", kind: "completed", createdAt: 1, message: "ambiguous", sequence: 42 },
          { id: "evt-no-match", kind: "completed", createdAt: 2, message: "missing", sequence: 100 },
        ], []],
        cards: [
          { id: "ambiguous-a", boardId: "default", title: "A", metadata: { notifications: [{ id: "evt-ambiguous", sequence: 42 }] } },
          { id: "ambiguous-b", boardId: "default", title: "B", metadata: { notifications: [{ id: "evt-ambiguous", sequence: 42 }] } },
          { id: "sequence-mismatch", boardId: "default", title: "C", metadata: { notifications: [{ id: "evt-no-match", sequence: 99 }] } },
        ],
      }),
    });

    await controller.runOnce("ambiguous-no-match");
    await flushAsyncWork();

    expect(wakeRuns).toEqual([]);
    expect(store.state.pendingTerminalEvents).toHaveLength(2);
    expect(store.state.pendingTerminalEvents).toMatchObject([
      { wakeKey: "event:evt-ambiguous", cardId: undefined, ownerSessionKey: undefined, attemptCount: 1 },
      { wakeKey: "event:evt-no-match", cardId: undefined, ownerSessionKey: undefined, attemptCount: 1 },
    ]);
    expect(store.state.terminalWakeFailures.map((failure) => failure.wakeKey)).toEqual(["event:evt-ambiguous", "event:evt-no-match"]);
    expect(store.state.terminalWakeIds).toEqual([]);
  });

  it("retains pending terminal events after wake failure for later retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent({ fail: true });
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, terminalWakeDebounceMs: 0, ownerRoutes: [{ boardId: "default", sessionKey: "agent:main:telegram:direct:retry" }] }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({ eventBatches: [[{ id: "evt-retry", kind: "completed", createdAt: 1, message: "done" }], []] }),
    });

    let status = await controller.runOnce("first-fails");
    await flushAsyncWork();
    expect(wakeRuns).toHaveLength(1);
    expect(status.counters.terminalWakeErrors).toBe(1);
    expect(store.state.pendingTerminalEvents).toMatchObject([{ wakeKey: "event:evt-retry", attemptCount: 1, lastError: "embedded delivery failed" }]);
    expect(store.state.terminalWakeIds).toEqual([]);

    vi.setSystemTime(999);
    status = await controller.runOnce("backoff-not-yet");
    expect(wakeRuns).toHaveLength(1);
    expect(status.pendingTerminalEvents.total).toBe(1);
  });

  it("isolates two different owners into independent due batches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-owners",
        dispatchCooldownMs: 0,
        ownerRoutes: [
          { boardId: "board-owners", agentId: "may", sessionKey: "agent:may:telegram:direct:owner-a" },
          { boardId: "board-owners", agentId: "muriel", sessionKey: "agent:muriel:telegram:direct:owner-b" },
        ],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[
          { id: "evt-owner-a", kind: "completed", createdAt: 1, message: "a", cardId: "card-a" },
          { id: "evt-owner-b", kind: "completed", createdAt: 2, message: "b", cardId: "card-b" },
        ], []],
        cards: [
          { id: "card-a", boardId: "board-owners", agentId: "may", title: "Owner A" },
          { id: "card-b", boardId: "board-owners", agentId: "muriel", title: "Owner B" },
        ],
      }),
    });

    await controller.runOnce("owners-arrive");
    vi.setSystemTime(1000);
    const status = await controller.runOnce("owners-due");
    await flushAsyncWork();
    expect(wakeRuns.map((run) => run.sessionKey)).toEqual(["agent:may:telegram:direct:owner-a", "agent:muriel:telegram:direct:owner-b"]);
    expect(status.counters.terminalWakeBatches).toBe(2);
    expect(status.pendingTerminalEvents.total).toBe(0);
  });

  it("sends a visible start notification for a single started card", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifySessionKey: "agent:main:telegram:direct:owner" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        started: [{ cardId: "card-2", title: "Next Card", sessionKey: "agent:main:workboard-card-2", runId: "run-2" }],
      }),
    });

    const status = await controller.runOnce("unit-test");

    expect(wakeRuns).toHaveLength(1);
    expect(wakeRuns[0]).toMatchObject({ sessionKey: "agent:main:telegram:direct:owner", agentId: "main", trigger: "manual" });
    expect(String(wakeRuns[0]?.prompt)).toContain("▶️ Workboard 已启动：Next Card\nID: card-2\nReason: unit-test");
    expect(String(wakeRuns[0]?.prompt)).toContain("Do not work on the card");
    expect(status.counters.startNotifications).toBe(1);
    expect(status.recentStartNotifications).toMatchObject([{ cardId: "card-2", title: "Next Card", target: "agent:main:telegram:direct:owner" }]);
    expect(store.state.notifiedStartIds).toEqual(["run:run-2"]);
  });

  it("sends start notifications for multiple started cards", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifySessionKey: "agent:main:telegram:direct:owner" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        started: [
          { cardId: "card-a", title: "Alpha", sessionKey: "agent:main:workboard-card-a", runId: "run-a" },
          { cardId: "card-b", title: "Beta", sessionKey: "agent:main:workboard-card-b", runId: "run-b" },
        ],
      }),
    });

    const status = await controller.runOnce("multi");

    expect(wakeRuns).toHaveLength(2);
    expect(wakeRuns.map((run) => run.sessionKey)).toEqual(["agent:main:telegram:direct:owner", "agent:main:telegram:direct:owner"]);
    expect(wakeRuns.map((run) => String(run.prompt))).toEqual([expect.stringContaining("ID: card-a"), expect.stringContaining("ID: card-b")]);
    expect(status.counters.startNotifications).toBe(2);
  });

  it("deduplicates duplicate start identities in one envelope and repeated ticks", async () => {
    const store = new MemoryStateStore();
    const dispatchCalls = { count: 0 };
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifySessionKey: "agent:main:telegram:direct:owner" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[completedEvent("evt-1")], [completedEvent("evt-2")]],
        dispatchCalls,
        started: [
          { cardId: "card-dup", title: "Duplicate", sessionKey: "agent:main:workboard-card-dup", runId: "run-dup" },
          { cardId: "card-dup", title: "Duplicate", sessionKey: "agent:main:workboard-card-dup", runId: "run-dup" },
        ],
      }),
    });

    await controller.runOnce("first");
    const status = await controller.runOnce("second");

    expect(dispatchCalls.count).toBe(2);
    expect(wakeRuns).toHaveLength(1);
    expect(status.counters.startNotifications).toBe(1);
    expect(store.state.notifiedStartIds).toEqual(["run:run-dup"]);
  });

  it("deduplicates start notifications after controller restart", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const first = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifySessionKey: "agent:main:telegram:direct:owner" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[completedEvent("evt-before-restart")]],
        started: [{ cardId: "card-restart", title: "Restart", sessionKey: "agent:main:workboard-card-restart", runId: "run-restart" }],
      }),
    });
    await first.runOnce("before-restart");

    const second = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifySessionKey: "agent:main:telegram:direct:owner" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[completedEvent("evt-after-restart")]],
        started: [{ cardId: "card-restart", title: "Restart", sessionKey: "agent:main:workboard-card-restart", runId: "run-restart" }],
      }),
    });
    const status = await second.runOnce("after-restart");

    expect(wakeRuns).toHaveLength(1);
    expect(status.counters.startNotifications).toBe(1);
    expect(store.state.notifiedStartIds).toEqual(["run:run-restart"]);
  });

  it("does not send start notifications when disabled", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifyEnabled: false, startNotifySessionKey: "agent:main:telegram:direct:owner" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        started: [{ cardId: "card-muted", title: "Muted", sessionKey: "agent:main:workboard-card-muted", runId: "run-muted" }],
      }),
    });

    const status = await controller.runOnce("disabled");

    expect(wakeRuns).toHaveLength(0);
    expect(status.counters.startNotifications).toBe(0);
    expect(status.counters.startNotificationErrors).toBe(0);
  });

  it("resolves ownerRoutes by specificity and declaration order for start notifications", async () => {
    async function runCase(input: {
      config: Record<string, unknown>;
      started: Record<string, unknown>;
      cards?: Array<Record<string, unknown>>;
    }) {
      const store = new MemoryStateStore();
      const methods: string[] = [];
      const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
      const controller = new WorkboardController({
        config: normalizeControllerConfig({ dispatchCooldownMs: 0, terminalWakeEnabled: false, ...input.config }),
        runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
        fullConfig: {},
        stateStore: store,
        runtimeAgent,
        gateway: startNotificationGateway({ methods, started: [input.started], cards: input.cards }),
      });
      await controller.runOnce("target");
      return { methods, wakeRuns };
    }

    const exact = await runCase({
      config: {
        boardId: "board-a",
        ownerRoutes: [
          { boardId: "board-a", sessionKey: "agent:main:telegram:direct:board" },
          { tenant: "tenant-may", boardId: "board-a", sessionKey: "agent:may:feishu:direct:tenant" },
          { tenant: "tenant-may", boardId: "board-a", agentId: "may", sessionKey: "agent:may:feishu:direct:exact" },
        ],
        startNotifySessionKey: "agent:main:telegram:direct:legacy",
        wakeFallbackSessionKey: "agent:main:telegram:direct:fallback",
      },
      started: { cardId: "card-exact", title: "Exact", sessionKey: "agent:may:workboard-card-exact", runId: "run-exact" },
      cards: [{ id: "card-exact", agentId: "may", title: "Exact", metadata: { tenant: "tenant-may" } }],
    });
    expect(exact.wakeRuns).toHaveLength(1);
    expect(exact.wakeRuns[0]).toMatchObject({ sessionKey: "agent:may:feishu:direct:exact", agentId: "may" });
    expect(exact.methods).toContain("workboard.cards.list");

    const tenantBoard = await runCase({
      config: {
        boardId: "board-a",
        ownerRoutes: [
          { boardId: "board-a", sessionKey: "agent:main:telegram:direct:board" },
          { tenant: "tenant-may", boardId: "board-a", sessionKey: "agent:may:feishu:direct:tenant" },
        ],
      },
      started: { cardId: "card-tenant", title: "Tenant", sessionKey: "agent:muriel:workboard-card-tenant", runId: "run-tenant" },
      cards: [{ id: "card-tenant", agentId: "muriel", title: "Tenant", metadata: { tenant: "tenant-may" } }],
    });
    expect(tenantBoard.wakeRuns).toHaveLength(1);
    expect(tenantBoard.wakeRuns[0]).toMatchObject({ sessionKey: "agent:may:feishu:direct:tenant", agentId: "may" });

    const board = await runCase({
      config: {
        boardId: "board-a",
        ownerRoutes: [
          { boardId: "board-a", sessionKey: "agent:main:telegram:direct:board" },
          { tenant: "tenant-other", boardId: "board-a", sessionKey: "agent:other:feishu:direct:tenant" },
        ],
      },
      started: { cardId: "card-board", title: "Board", sessionKey: "agent:muriel:workboard-card-board", runId: "run-board" },
      cards: [{ id: "card-board", agentId: "muriel", title: "Board", metadata: { tenant: "tenant-may" } }],
    });
    expect(board.wakeRuns).toHaveLength(1);
    expect(board.wakeRuns[0]).toMatchObject({ sessionKey: "agent:main:telegram:direct:board", agentId: "main" });

    const legacy = await runCase({
      config: {
        boardId: "board-c",
        ownerRoutes: [{ boardId: "board-a", agentId: "may", sessionKey: "agent:may:feishu:direct:exact" }],
        startNotifySessionKey: "agent:main:telegram:direct:legacy",
        wakeFallbackSessionKey: "agent:main:telegram:direct:fallback",
      },
      started: { cardId: "card-legacy", title: "Legacy", sessionKey: "agent:muriel:workboard-card-legacy", runId: "run-legacy" },
      cards: [{ id: "card-legacy", agentId: "muriel", title: "Legacy" }],
    });
    expect(legacy.wakeRuns).toHaveLength(1);
    expect(legacy.wakeRuns[0]).toMatchObject({ sessionKey: "agent:main:telegram:direct:legacy" });

    const tie = await runCase({
      config: {
        boardId: "board-tie",
        ownerRoutes: [
          { boardId: "board-tie", sessionKey: "agent:main:telegram:direct:first" },
          { boardId: "board-tie", sessionKey: "agent:main:telegram:direct:second" },
        ],
      },
      started: { cardId: "card-tie", title: "Tie", sessionKey: "agent:main:workboard-card-tie", runId: "run-tie" },
      cards: [{ id: "card-tie", agentId: "main", title: "Tie" }],
    });
    expect(tie.wakeRuns).toHaveLength(1);
    expect(tie.wakeRuns[0]).toMatchObject({ sessionKey: "agent:main:telegram:direct:first" });
  });

  it("resolves ownerRoutes before legacy start notification fallbacks", async () => {
    const store = new MemoryStateStore();
    const methods: string[] = [];
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-start",
        dispatchCooldownMs: 0,
        ownerRoutes: [{ boardId: "board-start", agentId: "may", sessionKey: "agent:may:feishu:direct:ou_chat_abc" }],
        startNotifySessionKey: "agent:main:telegram:direct:legacy",
        wakeFallbackSessionKey: "agent:main:telegram:direct:fallback",
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        methods,
        started: [{ cardId: "card-start", title: "Start", sessionKey: "agent:may:workboard-card-start", runId: "run-start" }],
        cards: [{ id: "card-start", agentId: "may", title: "Start" }],
      }),
    });

    await controller.runOnce("start-route");

    expect(methods).toContain("workboard.cards.list");
    expect(wakeRuns).toHaveLength(1);
    expect(wakeRuns[0]).toMatchObject({ sessionKey: "agent:may:feishu:direct:ou_chat_abc", agentId: "may" });
  });

  it("preserves opaque Feishu and QQ owner route session keys unchanged", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-opaque",
        dispatchCooldownMs: 0,
        ownerRoutes: [
          { boardId: "board-opaque", agentId: "may", sessionKey: "agent:may:feishu:direct:ou_abc123" },
          { boardId: "board-opaque", agentId: "muriel", sessionKey: "agent:muriel:qq:direct:qq_456" },
        ],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        started: [
          { cardId: "card-may", title: "May", sessionKey: "agent:may:workboard-card-may", runId: "run-may" },
          { cardId: "card-muriel", title: "Muriel", sessionKey: "agent:muriel:workboard-card-muriel", runId: "run-muriel" },
        ],
        cards: [
          { id: "card-may", agentId: "may", title: "May" },
          { id: "card-muriel", agentId: "muriel", title: "Muriel" },
        ],
      }),
    });

    await controller.runOnce("opaque-routes");

    expect(wakeRuns.map((run) => run.sessionKey)).toEqual(["agent:may:feishu:direct:ou_abc123", "agent:muriel:qq:direct:qq_456"]);
  });

  it("uses ownerRoutes for problem wake via public list context and ignores worker session keys", async () => {
    const store = new MemoryStateStore();
    const methods: string[] = [];
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-problem",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [{ tenant: "tenant-may", boardId: "board-problem", agentId: "may", sessionKey: "agent:may:feishu:direct:problem-owner" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        methods,
        eventBatches: [[{ id: "evt-problem", kind: "failed", createdAt: 1, message: "failed", sessionKey: "agent:may:workboard-card-problem", runId: "run-problem" }]],
        cards: [{ id: "card-problem", agentId: "may", title: "Problem", sessionKey: "agent:may:workboard-card-problem", execution: { runId: "run-problem", sessionKey: "agent:may:workboard-card-problem" }, metadata: { tenant: "tenant-may" } }],
      }),
    });

    const status = await controller.runOnce("problem-route");

    expect(methods).toContain("workboard.cards.list");
    expect(wakeRuns).toHaveLength(1);
    expect(wakeRuns[0]).toMatchObject({ sessionKey: "agent:may:feishu:direct:problem-owner", agentId: "may" });
    expect(wakeRuns[0]).not.toMatchObject({ sessionKey: "agent:may:workboard-card-problem" });
    expect(status.counters.wakes).toBe(1);
    expect(status.counters.wakeErrors).toBe(0);
  });

  it("routes failed stale blocked and startFailure problem wakes through ownerRoutes with opaque session keys", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-problem-all",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [
          { boardId: "board-problem-all", agentId: "main", sessionKey: "agent:main:telegram:direct:8068735520" },
          { boardId: "board-problem-all", agentId: "may", sessionKey: "agent:may:feishu:direct:ou_abc123" },
          { boardId: "board-problem-all", agentId: "muriel", sessionKey: "agent:muriel:qq:direct:qq_456" },
        ],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[
          { id: "evt-failed-may", kind: "failed", createdAt: 1, message: "failed", sessionKey: "agent:may:workboard-card-failed", runId: "run-failed" },
          { id: "evt-stale-muriel", kind: "stale", createdAt: 2, message: "stale", cardId: "card-stale", sessionKey: "agent:muriel:workboard-card-stale", runId: "run-stale" },
        ]],
        cards: [
          { id: "card-failed", boardId: "board-problem-all", agentId: "may", title: "Failed", sessionKey: "agent:may:workboard-card-failed", execution: { runId: "run-failed", sessionKey: "agent:may:workboard-card-failed" } },
          { id: "card-stale", boardId: "board-problem-all", agentId: "muriel", title: "Stale", sessionKey: "agent:muriel:workboard-card-stale", execution: { runId: "run-stale", sessionKey: "agent:muriel:workboard-card-stale" } },
        ],
        blocked: [{ id: "card-blocked", boardId: "board-problem-all", agentId: "main", title: "Blocked", status: "blocked", updatedAt: 123, sessionKey: "agent:main:workboard-card-blocked" }],
        startFailures: [{ cardId: "card-start-failure", error: "worker boot failed", card: { id: "card-start-failure", boardId: "board-problem-all", agentId: "main", title: "Start Failure", sessionKey: "agent:main:workboard-card-start-failure" } }],
      }),
    });

    const status = await controller.runOnce("problem-all-routes");

    expect(wakeRuns.map((run) => run.sessionKey)).toEqual([
      "agent:may:feishu:direct:ou_abc123",
      "agent:muriel:qq:direct:qq_456",
      "agent:main:telegram:direct:8068735520",
    ]);
    expect(String(wakeRuns[0].prompt)).toContain("Inspect the card/run");
    expect(String(wakeRuns[0].prompt)).toContain("maxRetries");
    expect(status.counters.wakes).toBe(4);
    expect(status.counters.terminalWakes).toBe(4);
    expect(status.counters.terminalWakeBatches).toBe(3);
    expect(status.counters.wakeErrors).toBe(0);
  });

  it("prefers board and agent owner routes over tenant and board routes for problem wakes", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-priority",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [
          { tenant: "tenant-a", boardId: "board-priority", sessionKey: "agent:may:feishu:direct:tenant-board" },
          { boardId: "board-priority", agentId: "may", sessionKey: "agent:may:telegram:direct:board-agent" },
          { tenant: "tenant-a", sessionKey: "agent:may:qq:direct:tenant" },
        ],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-priority", kind: "failed", createdAt: 1, message: "failed", runId: "run-priority" }]],
        cards: [{ id: "card-priority", boardId: "board-priority", agentId: "may", title: "Priority", execution: { runId: "run-priority", sessionKey: "agent:may:workboard-card-priority" }, metadata: { tenant: "tenant-a" } }],
      }),
    });

    await controller.runOnce("problem-priority");

    expect(wakeRuns).toHaveLength(1);
    expect(wakeRuns[0]).toMatchObject({ sessionKey: "agent:may:telegram:direct:board-agent", agentId: "may" });
  });

  it("rejects ownerRoutes problem wake targets that are worker session keys", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-problem-worker",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [{ boardId: "board-problem-worker", agentId: "main", sessionKey: "agent:main:workboard-card-problem-worker" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-problem-worker", kind: "failed", createdAt: 1, message: "failed", sessionKey: "agent:main:workboard-card-problem-worker", runId: "run-problem-worker" }]],
        cards: [{ id: "card-problem-worker", boardId: "board-problem-worker", agentId: "main", title: "Problem Worker", sessionKey: "agent:main:workboard-card-problem-worker", execution: { runId: "run-problem-worker", sessionKey: "agent:main:workboard-card-problem-worker" } }],
      }),
    });

    const status = await controller.runOnce("problem-worker-target");

    expect(wakeRuns).toHaveLength(0);
    expect(status.counters.wakeErrors).toBe(1);
    expect(status.wakeFailures[0]).toMatchObject({ target: "agent:main:workboard-card-problem-worker" });
    expect(status.wakeFailures[0]?.error).toMatch(/ownerRoutes target rejected as a worker session/);
  });

  it("does not use legacy wakeFallbackSessionKey as a terminal wake target", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-problem-fallback-worker",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        wakeFallbackSessionKey: "agent:main:workboard-card-fallback-worker",
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-problem-fallback-worker", kind: "failed", createdAt: 1, message: "failed", sessionKey: "agent:main:workboard-card-fallback-worker", runId: "run-fallback-worker" }]],
        cards: [{ id: "card-fallback-worker", boardId: "board-problem-fallback-worker", agentId: "main", title: "Fallback Worker", sessionKey: "agent:main:workboard-card-fallback-worker", execution: { runId: "run-fallback-worker", sessionKey: "agent:main:workboard-card-fallback-worker" } }],
      }),
    });

    const status = await controller.runOnce("problem-fallback-worker-target");

    expect(wakeRuns).toHaveLength(0);
    expect(status.counters.wakeErrors).toBe(1);
    expect(status.wakeFailures[0]).toMatchObject({ target: undefined });
    expect(status.wakeFailures[0]?.error).toMatch(/configure ownerRoutes/);
  });

  it("records visible failure when no reliable external start notification target exists", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, terminalWakeDebounceMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        started: [{ cardId: "card-no-target", title: "No Target", sessionKey: "agent:main:workboard-card-no-target", runId: "run-no-target" }],
        cards: [{ id: "card-no-target", title: "No Target", sessionKey: "agent:main:workboard-card-no-target" }],
      }),
    });

    const status = await controller.runOnce("no-target");

    expect(wakeRuns).toHaveLength(0);
    expect(status.counters.dispatches).toBe(1);
    expect(status.counters.startNotifications).toBe(0);
    expect(status.counters.startNotificationErrors).toBe(1);
    expect(status.lastError).toMatch(/start notification failed for card-no-target/);
    expect(status.startNotificationFailures).toMatchObject([{ cardId: "card-no-target", title: "No Target" }]);
  });

  it("records visible failure without rolling back dispatch when start notification delivery fails", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent({ fail: true });
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifySessionKey: "agent:main:telegram:direct:owner" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        started: [{ cardId: "card-fail", title: "Delivery Fail", sessionKey: "agent:main:workboard-card-fail", runId: "run-fail" }],
      }),
    });

    const status = await controller.runOnce("delivery-fail");

    expect(wakeRuns).toHaveLength(1);
    expect(status.counters.dispatches).toBe(1);
    expect(status.counters.startNotifications).toBe(0);
    expect(status.counters.startNotificationErrors).toBe(1);
    expect(status.lastError).toMatch(/embedded delivery failed/);
    expect(status.startNotificationFailures).toMatchObject([{ cardId: "card-fail", target: "agent:main:telegram:direct:owner", error: "embedded delivery failed" }]);
  });

  it("rejects worker session keys as start notification targets", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, startNotifySessionKey: "agent:main:workboard-card-worker" }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        started: [{ cardId: "card-worker", title: "Worker", sessionKey: "agent:main:workboard-card-worker", runId: "run-worker" }],
      }),
    });

    const status = await controller.runOnce("worker-target");

    expect(wakeRuns).toHaveLength(0);
    expect(status.counters.startNotificationErrors).toBe(1);
    expect(status.startNotificationFailures[0]?.error).toMatch(/startNotifySessionKey target rejected as a worker session/);
  });

  it("rejects ownerRoutes targets that are worker session keys", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-worker",
        dispatchCooldownMs: 0,
        ownerRoutes: [{ boardId: "board-worker", sessionKey: "agent:main:workboard-card-worker-route" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        started: [{ cardId: "card-worker-route", title: "Worker Route", sessionKey: "agent:main:workboard-card-worker-route", runId: "run-worker-route" }],
        cards: [{ id: "card-worker-route", agentId: "main", title: "Worker Route" }],
      }),
    });

    const status = await controller.runOnce("worker-route-target");

    expect(wakeRuns).toHaveLength(0);
    expect(status.counters.startNotificationErrors).toBe(1);
    expect(status.startNotificationFailures[0]).toMatchObject({ target: "agent:main:workboard-card-worker-route" });
    expect(status.startNotificationFailures[0]?.error).toMatch(/ownerRoutes target rejected as a worker session/);
  });

  it("records visible wake failure when no reliable problem route exists", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, terminalWakeDebounceMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-no-route", kind: "failed", createdAt: 1, message: "failed", sessionKey: "agent:main:workboard-card-no-route", runId: "run-no-route" }]],
        cards: [{ id: "card-no-route", agentId: "main", title: "No Route", execution: { runId: "run-no-route", sessionKey: "agent:main:workboard-card-no-route" } }],
      }),
    });

    const status = await controller.runOnce("problem-no-route");

    expect(wakeRuns).toHaveLength(0);
    expect(status.counters.wakeErrors).toBe(1);
    expect(status.lastError).toMatch(/terminal wake failed/);
    expect(status.wakeFailures).toMatchObject([{ problemKey: "event:evt-no-route", kind: "failed", cardId: "card-no-route" }]);
  });

  it("records no-route wake failure for startFailure without card context", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ dispatchCooldownMs: 0, terminalWakeDebounceMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-completed-context", kind: "completed", createdAt: 1, message: "done", cardId: "card-completed-context" }]],
        cards: [{ id: "card-completed-context", boardId: "default", agentId: "may", title: "Completed Context" }],
        startFailures: [{ error: "no worker" }],
      }),
    });

    const status = await controller.runOnce("start-failure-no-context");

    expect(wakeRuns).toHaveLength(0);
    expect(status.counters.wakeErrors).toBe(2);
    expect(status.wakeFailures.at(-1)).toMatchObject({ kind: "startFailure", error: expect.stringMatching(/could not resolve a reliable owner route/) });
    expect(status.wakeFailures.at(-1)?.problemKey).toMatch(/^start-failure:/);
  });

});


describe("archive candidate planning", () => {
  it("treats parent/child links as a full connected component", () => {
    const cards = [
      doneCard("a", { metadata: { proof: [{ status: "passed" }], links: [linkTo("child", "b")] } }),
      doneCard("b", { metadata: { proof: [{ status: "passed" }], links: [linkTo("parent", "a"), linkTo("child", "c")] } }),
      doneCard("c", { metadata: { proof: [{ status: "passed" }], links: [linkTo("parent", "b")] } }),
    ];

    expect(computeArchiveCandidates(cards, { now: 10, completedGraphAfterMs: 0, standaloneAfterMs: 1000, requireProof: true })).toEqual([
      {
        componentId: "component:a",
        cardIds: ["a", "b", "c"],
        titles: { a: "Card a", b: "Card b", c: "Card c" },
        reason: "component_all_done_cooldown_elapsed",
        eligibleAt: 1,
      },
    ]);
  });

  it("uses the standalone threshold for unlinked done cards", () => {
    const card = doneCard("solo", { completedAt: 100, updatedAt: 100 });
    expect(computeArchiveCandidates([card], { now: 500, completedGraphAfterMs: 0, standaloneAfterMs: 1000, requireProof: true })).toEqual([]);
    expect(computeArchiveCandidates([card], { now: 1100, completedGraphAfterMs: 0, standaloneAfterMs: 1000, requireProof: true })).toMatchObject([
      { componentId: "standalone:solo", cardIds: ["solo"], reason: "standalone_done_cooldown_elapsed", eligibleAt: 1100 },
    ]);
  });

  it("requires proof and resets eligibility when a card is reopened", () => {
    const parent = doneCard("parent", { metadata: { proof: [{ status: "passed" }], links: [linkTo("child", "child")] } });
    const childMissingProof = doneCard("child", { metadata: { links: [linkTo("parent", "parent")] } });
    expect(computeArchiveCandidates([parent, childMissingProof], { now: 10_000, completedGraphAfterMs: 0, standaloneAfterMs: 0, requireProof: true })).toEqual([]);

    const childReopened = doneCard("child", {
      status: "todo",
      completedAt: undefined,
      updatedAt: 9_000,
      metadata: { proof: [{ status: "passed" }], links: [linkTo("parent", "parent")] },
    });
    expect(computeArchiveCandidates([parent, childReopened], { now: 10_000, completedGraphAfterMs: 0, standaloneAfterMs: 0, requireProof: true })).toEqual([]);

    const childRecentlyDone = doneCard("child", {
      completedAt: 9_900,
      updatedAt: 9_900,
      metadata: { proof: [{ status: "passed" }], links: [linkTo("parent", "parent")] },
    });
    expect(computeArchiveCandidates([parent, childRecentlyDone], { now: 10_000, completedGraphAfterMs: 200, standaloneAfterMs: 0, requireProof: true })).toEqual([]);
  });

  it("does not archive cards with parent/child links to missing cards", () => {
    const card = doneCard("child", { metadata: { proof: [{ status: "passed" }], links: [linkTo("parent", "missing-parent")] } });
    expect(computeArchiveCandidates([card], { now: 10, completedGraphAfterMs: 0, standaloneAfterMs: 0, requireProof: true })).toEqual([]);
  });

  it("skips blocked, failed, stale, and already archived cards", () => {
    const blocked = doneCard("blocked", { status: "blocked" });
    const failed = doneCard("failed", { status: "failed" });
    const stale = doneCard("stale", { metadata: { proof: [{ status: "passed" }], stale: { detectedAt: 1, reason: "old" } } });
    const archived = doneCard("archived", { metadata: { proof: [{ status: "passed" }], archivedAt: 5 } });
    expect(computeArchiveCandidates([blocked, failed, stale, archived], { now: 10, completedGraphAfterMs: 0, standaloneAfterMs: 0, requireProof: true })).toEqual([]);
  });
});

describe("WorkboardController archive scan", () => {
  it("returns dry-run graph candidates without archive actions", async () => {
    const cards = [
      doneCard("a", { metadata: { proof: [{ status: "passed" }], links: [linkTo("child", "b")] } }),
      doneCard("b", { metadata: { proof: [{ status: "passed" }], links: [linkTo("parent", "a"), linkTo("child", "c")] } }),
      doneCard("c", { metadata: { proof: [{ status: "passed" }], links: [linkTo("parent", "b")] } }),
    ];
    const store = new MemoryStateStore();
    const { runtimeAgent } = makeRuntimeAgent();
    const archives: string[] = [];
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ archiveEnabled: true, archiveDryRun: true, archiveCompletedGraphAfterMs: 0, archiveStandaloneAfterMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: archiveGateway(cards, { archives }),
    });

    const status = await controller.runOnce("archive-dry-run");

    expect(status.archiveCandidates).toHaveLength(1);
    expect(status.archiveCandidates[0]).toMatchObject({ componentId: "component:a", cardIds: ["a", "b", "c"] });
    expect(status.counters.archiveScans).toBe(1);
    expect(status.counters.archiveCandidates).toBe(3);
    expect(status.counters.archiveActions).toBe(0);
    expect(archives).toEqual([]);
  });

  it("records partial archive failure and later fills remaining unarchived cards", async () => {
    const cards = [
      doneCard("a", { metadata: { proof: [{ status: "passed" }], links: [linkTo("child", "b")] } }),
      doneCard("b", { metadata: { proof: [{ status: "passed" }], links: [linkTo("parent", "a")] } }),
    ];
    const store = new MemoryStateStore();
    const { runtimeAgent } = makeRuntimeAgent();
    const failArchiveIds = new Set(["b"]);
    const archives: string[] = [];
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ archiveEnabled: true, archiveDryRun: false, archiveCompletedGraphAfterMs: 0, archiveStandaloneAfterMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: archiveGateway(cards, { failArchiveIds, archives }),
    });

    let status = await controller.runOnce("archive-action");

    expect(archives).toEqual(["a"]);
    expect(status.archiveLastFailures).toMatchObject([{ componentId: "component:a", cardId: "b", error: "archive denied for b" }]);
    expect(status.lastError).toMatch(/archive failed for b/);
    expect(status.counters.archiveActions).toBe(1);
    expect(status.counters.archiveErrors).toBe(1);

    failArchiveIds.clear();
    delete store.state.lastArchiveScanAt;
    const retryController = new WorkboardController({
      config: normalizeControllerConfig({ archiveEnabled: true, archiveDryRun: false, archiveCompletedGraphAfterMs: 0, archiveStandaloneAfterMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: archiveGateway(cards, { failArchiveIds, archives }),
    });
    status = await retryController.runOnce("archive-retry");

    expect(archives).toEqual(["a", "b"]);
    expect(status.archiveLastFailures).toEqual([]);
    expect(status.lastError).toBeUndefined();
    expect(status.counters.archiveActions).toBe(2);
  });

  it("does not rescan archive candidates before archiveScanIntervalMs elapses", async () => {
    const cards = [doneCard("solo")];
    const listCalls = { count: 0 };
    const store = new MemoryStateStore();
    const { runtimeAgent } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ archiveEnabled: true, archiveDryRun: true, archiveStandaloneAfterMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: archiveGateway(cards, { listCalls }),
    });

    await controller.runOnce("first");
    await controller.runOnce("second");

    expect(listCalls.count).toBe(1);
    expect(store.state.counters.archiveScans).toBe(1);
  });
});




describe("owner session key validation", () => {
  it("accepts direct channel owner keys and rejects shortcuts and non-direct system keys", () => {
    for (const key of [
      "agent:owner:telegram:direct:123",
      "agent:owner:feishu:direct:ou_abc",
      "agent:owner:qq:direct:qq_456",
      "agent:owner:qqbot:direct:qqbot_456",
      "agent:owner:dingtalk:direct:ding_789",
      "agent:owner:future-channel:direct:opaque_abc",
    ]) {
      expect(isReliableExternalOwnerSessionKey(key)).toBe(true);
    }

    for (const key of [
      "main",
      "agent:owner",
      "agent:owner:main",
      "agent:main:owner",
      "worker:card-a",
      "subagent:card-a",
      "agent:owner:workboard-card-a",
      "cron:daily",
      "dashboard:default",
      "acp:session",
      "agent:owner:telegram:group:123",
    ]) {
      expect(isReliableExternalOwnerSessionKey(key, [], "card-a")).toBe(false);
    }
  });
});

describe("file state store", () => {
  it("serializes concurrent saves and keeps the later logical snapshot", async () => {
    const fs = await import("node:fs/promises");
    const stateDir = await fs.mkdtemp("/tmp/workboard-controller-state-");
    try {
      vi.spyOn(Date, "now").mockReturnValue(123);
      const store = createFileStateStore(stateDir);
      const first = emptyState();
      first.counters.ticks = 1;
      const second = emptyState();
      second.counters.ticks = 2;
      second.ownerBindings = [{ cardId: "card-later", ownerSessionKey: "agent:owner:telegram:direct:later", source: "manual", createdAt: 2 }];

      await Promise.all([store.save(first), store.save(second)]);

      const persisted = JSON.parse(await fs.readFile(store.path, "utf8"));
      expect(persisted.counters.ticks).toBe(2);
      expect(persisted.ownerBindings).toMatchObject([{ cardId: "card-later", ownerSessionKey: "agent:owner:telegram:direct:later" }]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("owner bindings", () => {
  it("persists explicit owned create bindings only after Gateway create succeeds", async () => {
    const store = new MemoryStateStore();
    const calls: Array<{ method: string; params?: unknown }> = [];
    const { runtimeAgent } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ enabled: false }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "workboard.cards.create") return { card: { id: "card-owned", title: "Owned" } };
          return {};
        },
      },
    });

    const payload = await controller.createOwnedCard({ title: "Owned", agentId: "worker-agent" }, "agent:owner:telegram:direct:123", "owner");

    expect(payload).toEqual({ card: { id: "card-owned", title: "Owned" } });
    expect(calls).toEqual([{ method: "workboard.cards.create", params: { title: "Owned", agentId: "worker-agent" } }]);
    expect(store.state.ownerBindings).toMatchObject([{ cardId: "card-owned", ownerSessionKey: "agent:owner:telegram:direct:123", ownerAgentId: "owner", source: "owned-tool" }]);

    await expect(controller.createOwnedCard({ title: "Bad" }, "agent:owner:workboard-card-bad")).rejects.toThrow(/reliable external/);
  });

  it("does not bind when owned create fails", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ enabled: false }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: { async request() { throw new Error("create denied"); } },
    });

    await expect(controller.createOwnedCard({ title: "Nope" }, "agent:owner:telegram:direct:123")).rejects.toThrow(/create denied/);
    expect(store.state.ownerBindings).toEqual([]);
  });

  it("does not hijack an existing binding when owned create returns an idempotent card", async () => {
    const store = new MemoryStateStore();
    store.state.ownerBindings = [{ cardId: "card-owned", ownerSessionKey: "agent:other:telegram:direct:999", ownerAgentId: "other", source: "manual", createdAt: 1 }];
    const { runtimeAgent } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ enabled: false }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: { async request() { return { card: { id: "card-owned", title: "Owned" } }; } },
    });

    await expect(controller.createOwnedCard({ title: "Owned", idempotencyKey: "same" }, "agent:owner:telegram:direct:123", "owner")).rejects.toThrow(/already bound to another owner/);
    expect(store.state.ownerBindings).toEqual([{ cardId: "card-owned", ownerSessionKey: "agent:other:telegram:direct:999", ownerAgentId: "other", source: "manual", createdAt: 1 }]);
  });

  it("leaves an existing same-owner binding unchanged for idempotent owned create", async () => {
    const store = new MemoryStateStore();
    store.state.ownerBindings = [{ cardId: "card-owned", ownerSessionKey: "agent:owner:telegram:direct:123", ownerAgentId: "owner", source: "manual", createdAt: 1 }];
    const { runtimeAgent } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ enabled: false }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: { async request() { return { card: { id: "card-owned", title: "Owned" } }; } },
    });

    await expect(controller.createOwnedCard({ title: "Owned", idempotencyKey: "same" }, "agent:owner:telegram:direct:123", "owner")).resolves.toEqual({ card: { id: "card-owned", title: "Owned" } });
    expect(store.state.ownerBindings).toEqual([{ cardId: "card-owned", ownerSessionKey: "agent:owner:telegram:direct:123", ownerAgentId: "owner", source: "manual", createdAt: 1 }]);
  });

  it("prefers durable binding over ownerRoutes for terminal wakes and start notifications", async () => {
    const store = new MemoryStateStore();
    store.state.ownerBindings = [{ cardId: "card-bound", ownerSessionKey: "agent:bound:telegram:direct:1", ownerAgentId: "bound", source: "manual", createdAt: 1 }];
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({
        boardId: "board-bound",
        dispatchCooldownMs: 0,
        terminalWakeDebounceMs: 0,
        ownerRoutes: [{ boardId: "board-bound", sessionKey: "agent:route:telegram:direct:2" }],
      }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-bound", kind: "completed", createdAt: 1, message: "done", cardId: "card-bound" }]],
        started: [{ cardId: "card-bound", title: "Bound", sessionKey: "agent:main:workboard-card-bound", runId: "run-bound" }],
        cards: [{ id: "card-bound", boardId: "board-bound", agentId: "main", title: "Bound", sessionKey: "agent:main:workboard-card-bound" }],
      }),
    });

    await controller.runOnce("binding-precedence");
    await flushAsyncWork();

    expect(wakeRuns.map((run) => run.sessionKey)).toEqual(["agent:bound:telegram:direct:1", "agent:bound:telegram:direct:1"]);
  });

  it("inherits ancestor owner binding from metadata.automation.createdByCardId", async () => {
    const store = new MemoryStateStore();
    store.state.ownerBindings = [{ cardId: "parent", ownerSessionKey: "agent:parent:telegram:direct:1", ownerAgentId: "parent", source: "manual", createdAt: 1 }];
    const { runtimeAgent, wakeRuns } = makeRuntimeAgent();
    const controller = new WorkboardController({
      config: normalizeControllerConfig({ boardId: "board-inherit", dispatchCooldownMs: 0, terminalWakeDebounceMs: 0 }),
      runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
      fullConfig: {},
      stateStore: store,
      runtimeAgent,
      gateway: startNotificationGateway({
        eventBatches: [[{ id: "evt-child", kind: "completed", createdAt: 1, message: "done", cardId: "child" }]],
        cards: [
          { id: "parent", boardId: "board-inherit", title: "Parent" },
          { id: "child", boardId: "board-inherit", title: "Child", metadata: { automation: { createdByCardId: "parent" } } },
        ],
      }),
    });

    await controller.runOnce("inherit");
    await flushAsyncWork();

    expect(wakeRuns[0]).toMatchObject({ sessionKey: "agent:parent:telegram:direct:1" });
    expect(store.state.ownerBindings).toMatchObject([
      { cardId: "parent", source: "manual" },
      { cardId: "child", source: "inherited", inheritedFromCardId: "parent", ownerSessionKey: "agent:parent:telegram:direct:1" },
    ]);
  });

  it("persists bindings across controller restart", async () => {
    const store = new MemoryStateStore();
    const { runtimeAgent } = makeRuntimeAgent();
    const config = normalizeControllerConfig({ enabled: false });
    const first = new WorkboardController({ config, runtimeVersion: SUPPORTED_OPENCLAW_VERSION, fullConfig: {}, stateStore: store, runtimeAgent, gateway: { async request() { return {}; } } });
    await first.bindOwner({ cardId: "card-restart-bind", ownerSessionKey: "agent:owner:telegram:direct:restart", source: "manual" });
    const second = new WorkboardController({ config, runtimeVersion: SUPPORTED_OPENCLAW_VERSION, fullConfig: {}, stateStore: store, runtimeAgent, gateway: { async request() { return {}; } } });
    await second.start();
    expect(second.status().ownerBindings).toMatchObject({ total: 1, bySource: { manual: 1 } });
  });

  it("auto-captures core workboard_create by toolCallId and skips worker sessions", async () => {
    const tools = new Map<string, Record<string, unknown>>();
    const hooks: Record<string, Function> = {};
    const services: Array<{ start: Function; stop?: Function }> = [];
    const stateDir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/workboard-controller-test-"));
    (plugin.register as (api: Record<string, unknown>) => void)({
      registrationMode: "full",
      pluginConfig: { enabled: false },
      config: {},
      runtime: { version: SUPPORTED_OPENCLAW_VERSION, agent: makeRuntimeAgent().runtimeAgent },
      registerTool(toolOrFactory: unknown) {
        const tool = typeof toolOrFactory === "function" ? (toolOrFactory as Function)({ sessionKey: "agent:owner:telegram:direct:hook", agentId: "owner" }) : toolOrFactory;
        tools.set((tool as Record<string, unknown>).name as string, tool as Record<string, unknown>);
      },
      registerHttpRoute() {},
      on(name: string, handler: Function) { hooks[name] = handler; },
      registerService(service: Record<string, unknown>) { services.push(service as { start: Function; stop?: Function }); },
    });
    expect(Object.keys(hooks).sort()).toEqual(["after_tool_call", "before_tool_call"]);
    await services[0].start({ config: { gateway: { auth: { mode: "none" } } }, stateDir, logger: {} });

    hooks.before_tool_call({ toolName: "workboard_create", toolCallId: "call-a", params: { title: "A" } }, { toolCallId: "call-a", sessionKey: "agent:owner:telegram:direct:hook", agentId: "owner" });
    hooks.before_tool_call({ toolName: "workboard_create", toolCallId: "call-b", params: { title: "B" } }, { toolCallId: "call-b", sessionKey: "agent:worker:workboard-card-b", agentId: "worker" });
    hooks.after_tool_call({ toolName: "workboard_create", toolCallId: "call-b", result: { details: { card: { id: "card-b" } } } }, { toolCallId: "call-b" });
    hooks.after_tool_call({ toolName: "workboard_create", toolCallId: "call-a", result: { details: { card: { id: "card-a" } } } }, { toolCallId: "call-a" });
    await flushAsyncWork();

    const statusResult = await (tools.get("workboard_controller_status")!.execute as Function)();
    const text = (statusResult.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).ownerBindings).toMatchObject({ total: 1, bySource: { "core-hook": 1 } });
    await services[0].stop?.();
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


  it("invokes Workboard list and archive through fixed authenticated self-routes", async () => {
    const captured: CapturedRequest[] = [];

    await withHttpServer(
      async (req, res) => {
        const body = await readRequestBody(req);
        captured.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url === WORKBOARD_LIST_ROUTE_PATH) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, payload: { cards: [{ id: "card-1", status: "done" }] } }));
          return;
        }
        if (req.url === WORKBOARD_ARCHIVE_ROUTE_PATH) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, payload: { card: { id: "card-1", status: "done", metadata: { archivedAt: 10 } } } }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { message: "not found" } }));
      },
      async (baseUrl) => {
        const client = createGatewayMethodClient({
          config: { gateway: { auth: { mode: "token", token: "config-token" } } },
          env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
          baseUrl,
        });

        await expect(client.request("workboard.cards.list", { boardId: "default" })).resolves.toEqual({ cards: [{ id: "card-1", status: "done" }] });
        await expect(client.request("workboard.cards.archive", { id: "card-1", archived: true })).resolves.toEqual({
          card: { id: "card-1", status: "done", metadata: { archivedAt: 10 } },
        });
      },
    );

    expect(captured.map((request) => request.url)).toEqual([WORKBOARD_LIST_ROUTE_PATH, WORKBOARD_ARCHIVE_ROUTE_PATH]);
    expect(captured.map((request) => request.headers.authorization)).toEqual(["Bearer env-token", "Bearer env-token"]);
    expect(captured.map((request) => request.body)).toEqual([{ boardId: "default" }, { id: "card-1", archived: true }]);
    expect(captured.flatMap((request) => Object.keys(request.body))).not.toContain("method");
    expect(captured.flatMap((request) => Object.keys(request.body))).not.toContain("params");
    expect(captured.flatMap((request) => Object.keys(request.body))).not.toContain("tool");
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
