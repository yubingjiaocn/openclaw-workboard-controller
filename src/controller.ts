import { randomUUID } from "node:crypto";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ControllerConfig } from "./config.js";
import { assertCompatibleOpenClawVersion } from "./config.js";
import type { GatewayMethodClient } from "./gateway-method-client.js";
import { errorMessage } from "./gateway-method-client.js";
import type { ControllerState, StateStore } from "./state.js";
import { rememberBounded } from "./state.js";

type Logger = {
  info?: (message: string, data?: unknown) => void;
  warn?: (message: string, data?: unknown) => void;
  error?: (message: string, data?: unknown) => void;
  debug?: (message: string, data?: unknown) => void;
};

type RuntimeAgent = OpenClawPluginApi["runtime"]["agent"];

type WorkboardNotification = {
  id: string;
  kind: "completed" | "failed" | "stale";
  createdAt: number;
  sequence?: number;
  message: string;
  sessionKey?: string;
  runId?: string;
};

type WorkboardCard = {
  id: string;
  title?: string;
  status?: string;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  updatedAt?: number;
  execution?: { sessionKey?: string; runId?: string; status?: string };
};

type NotificationEventsPayload = {
  subscription?: { id: string };
  events: WorkboardNotification[];
};

type SubscribePayload = {
  subscription: { id: string };
};

type DispatchPayload = {
  promoted?: WorkboardCard[];
  reclaimed?: WorkboardCard[];
  blocked?: WorkboardCard[];
  orchestrated?: WorkboardCard[];
  started?: WorkboardCard[];
  startFailures?: Array<{ cardId?: string; error?: string; card?: WorkboardCard }>;
};

export type ControllerStatus = {
  running: boolean;
  enabled: boolean;
  statePath: string;
  subscriptionId?: string;
  lastTickAt?: number;
  lastDispatchAt?: number;
  lastError?: string;
  counters: ControllerState["counters"];
  inFlight: boolean;
};

export type WorkboardControllerOptions = {
  config: ControllerConfig;
  runtimeVersion: string;
  fullConfig: OpenClawConfig;
  stateStore: StateStore;
  gateway: GatewayMethodClient;
  runtimeAgent: RuntimeAgent;
  logger?: Logger;
};

export class WorkboardController {
  private state: ControllerState | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private running = false;

  constructor(private readonly options: WorkboardControllerOptions) {}

  async start(): Promise<void> {
    assertCompatibleOpenClawVersion(this.options.config, this.options.runtimeVersion);
    this.state = await this.options.stateStore.load();
    if (this.options.config.subscriptionId && this.state.subscriptionId !== this.options.config.subscriptionId) {
      this.state.subscriptionId = this.options.config.subscriptionId;
      await this.save();
    }
    this.running = true;
    if (!this.options.config.enabled) {
      this.options.logger?.info?.("workboard-controller disabled by config");
      return;
    }
    await this.ensureSubscription();
    this.timer = setInterval(() => {
      void this.runOnce("interval");
    }, this.options.config.pollIntervalMs);
    this.timer.unref?.();
    void this.runOnce("startup");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
    if (this.state) await this.save();
  }

  status(): ControllerStatus {
    const state = this.state;
    return {
      running: this.running,
      enabled: this.options.config.enabled,
      statePath: this.options.stateStore.path,
      subscriptionId: state?.subscriptionId,
      lastTickAt: state?.lastTickAt,
      lastDispatchAt: state?.lastDispatchAt,
      lastError: state?.lastError,
      counters: state?.counters ?? { ticks: 0, events: 0, dispatches: 0, wakes: 0, errors: 0 },
      inFlight: this.inFlight,
    };
  }

  async runOnce(reason = "manual"): Promise<ControllerStatus> {
    if (this.inFlight) return this.status();
    this.inFlight = true;
    try {
      const state = await this.requireState();
      state.lastTickAt = Date.now();
      state.counters.ticks += 1;
      await this.ensureSubscription();
      const batch = await this.processNotificationBatch();
      if (batch.newEvents > 0) await this.dispatchReadyCards(reason);
      state.lastError = undefined;
      await this.save();
      return this.status();
    } catch (error) {
      const state = await this.requireState();
      state.lastError = errorMessage(error);
      state.counters.errors += 1;
      await this.save();
      this.options.logger?.warn?.("workboard-controller tick failed", { error: state.lastError });
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  private async requireState(): Promise<ControllerState> {
    if (!this.state) this.state = await this.options.stateStore.load();
    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) return;
    await this.options.stateStore.save(this.state);
  }

  private async ensureSubscription(): Promise<string> {
    const state = await this.requireState();
    if (state.subscriptionId) return state.subscriptionId;
    const payload = await this.options.gateway.request<SubscribePayload>("workboard.notifications.subscribe", {
      boardId: this.options.config.boardId,
      target: this.options.config.target,
      eventKinds: ["completed", "failed", "stale"],
    });
    state.subscriptionId = payload.subscription.id;
    await this.save();
    return state.subscriptionId;
  }

  private async processNotificationBatch(): Promise<{ advanceCount: number; newEvents: number }> {
    const state = await this.requireState();
    const subscriptionId = await this.ensureSubscription();
    const payload = await this.options.gateway.request<NotificationEventsPayload>("workboard.notifications.events", {
      subscriptionId,
      limit: this.options.config.batchLimit,
    });
    const events = payload.events ?? [];
    let advanceCount = 0;
    let newEvents = 0;
    for (const event of events) {
      if (state.processedEventIds.includes(event.id)) {
        advanceCount += 1;
        continue;
      }
      await this.handleNotification(event);
      state.processedEventIds = rememberBounded(state.processedEventIds, event.id);
      state.counters.events += 1;
      advanceCount += 1;
      newEvents += 1;
      await this.save();
    }
    if (advanceCount > 0) {
      await this.options.gateway.request("workboard.notifications.advance", { subscriptionId, limit: advanceCount });
    }
    return { advanceCount, newEvents };
  }

  private async handleNotification(event: WorkboardNotification): Promise<void> {
    if (event.kind === "completed") return;
    await this.wakeOwner({
      problemKey: `${event.kind}:${event.id}`,
      kind: event.kind,
      message: event.message,
      sessionKey: event.sessionKey,
      runId: event.runId,
    });
  }

  private async dispatchReadyCards(reason: string): Promise<void> {
    const state = await this.requireState();
    const now = Date.now();
    if (state.lastDispatchAt && now - state.lastDispatchAt < this.options.config.dispatchCooldownMs) return;
    const result = await this.options.gateway.request<DispatchPayload>(
      "workboard.cards.dispatch",
      { boardId: this.options.config.boardId },
      { timeoutMs: this.options.config.dispatchTimeoutMs },
    );
    state.lastDispatchAt = now;
    state.counters.dispatches += 1;
    await this.save();
    for (const card of result.blocked ?? []) {
      await this.wakeOwner({
        problemKey: `blocked:${card.id}:${card.updatedAt ?? card.status ?? "unknown"}`,
        kind: "blocked",
        message: `Workboard card blocked during dispatch (${reason}): ${card.title ?? card.id}`,
        card,
      });
    }
    for (const failure of result.startFailures ?? []) {
      await this.wakeOwner({
        problemKey: `start-failure:${failure.cardId ?? failure.card?.id ?? randomUUID()}:${failure.error ?? "unknown"}`,
        kind: "failed",
        message: `Workboard worker start failed: ${failure.error ?? "unknown error"}`,
        card: failure.card,
      });
    }
  }

  private async wakeOwner(input: {
    problemKey: string;
    kind: "failed" | "stale" | "blocked";
    message: string;
    sessionKey?: string;
    runId?: string;
    card?: WorkboardCard;
  }): Promise<void> {
    const state = await this.requireState();
    if (!this.options.config.wakeEnabled) return;
    if (state.notifiedProblemIds.includes(input.problemKey)) return;
    const sessionKey = input.sessionKey ?? input.card?.sessionKey ?? input.card?.execution?.sessionKey ?? this.options.config.wakeFallbackSessionKey;
    const agentId = input.card?.agentId ?? this.options.config.wakeFallbackAgentId;
    const workspaceDir = this.options.runtimeAgent.resolveAgentWorkspaceDir(this.options.fullConfig, agentId);
    const timeoutMs = this.options.config.wakeTimeoutMs || this.options.runtimeAgent.resolveAgentTimeoutMs({ cfg: this.options.fullConfig });
    const prompt = buildWakePrompt(input);
    await this.options.runtimeAgent.runEmbeddedAgent({
      // sessionId is a transcript identifier, not a routing sessionKey.
      sessionId: randomUUID(),
      sessionKey,
      agentId,
      workspaceDir,
      config: this.options.fullConfig,
      prompt,
      trigger: "manual",
      runId: randomUUID(),
      timeoutMs,
      ...(this.options.config.wakeToolsAllow ? { toolsAllow: this.options.config.wakeToolsAllow } : {}),
    });
    state.notifiedProblemIds = rememberBounded(state.notifiedProblemIds, input.problemKey);
    state.counters.wakes += 1;
    await this.save();
  }
}

function buildWakePrompt(input: { kind: string; message: string; runId?: string; card?: WorkboardCard }): string {
  const lines = [
    "OpenClaw Workboard controller noticed a problem event.",
    "Notify the owner concisely through the normal session route. Do not clear Goals. Do not create a second workflow ledger.",
    `kind: ${input.kind}`,
    `message: ${input.message}`,
  ];
  if (input.runId) lines.push(`runId: ${input.runId}`);
  if (input.card) {
    lines.push(`cardId: ${input.card.id}`);
    if (input.card.title) lines.push(`cardTitle: ${input.card.title}`);
    if (input.card.status) lines.push(`cardStatus: ${input.card.status}`);
  }
  return lines.join("\n");
}
