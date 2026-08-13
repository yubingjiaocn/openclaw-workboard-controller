import { describe, expect, it } from "vitest";
import { assertCompatibleOpenClawVersion, normalizeControllerConfig, SUPPORTED_OPENCLAW_VERSION } from "./config.js";
import { WorkboardController } from "./controller.js";
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
