import { randomUUID } from "node:crypto";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { computeArchiveCandidates, type WorkboardArchiveCard } from "./archive.js";
import type { ControllerConfig } from "./config.js";
import { assertCompatibleOpenClawVersion } from "./config.js";
import type { GatewayMethodClient } from "./gateway-method-client.js";
import { errorMessage } from "./gateway-method-client.js";
import type { ArchiveFailure, ControllerState, StartNotificationFailure, StateStore } from "./state.js";
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

type WorkboardCard = WorkboardArchiveCard & {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  execution?: WorkboardArchiveCard["execution"] & { sessionKey?: string; runId?: string };
};

type NotificationEventsPayload = {
  subscription?: { id: string };
  events: WorkboardNotification[];
};

type SubscribePayload = {
  subscription: { id: string };
};

type WorkboardListPayload = {
  cards: WorkboardCard[];
};

type ArchivePayload = {
  card: WorkboardCard;
};

type StartedWorkboardCard = Partial<WorkboardCard> & {
  cardId?: string;
  id?: string;
  title?: string;
  sessionKey?: string;
  runId?: string;
  startedAt?: number;
};

type DispatchPayload = {
  promoted?: WorkboardCard[];
  reclaimed?: WorkboardCard[];
  blocked?: WorkboardCard[];
  orchestrated?: WorkboardCard[];
  started?: StartedWorkboardCard[];
  startFailures?: Array<{ cardId?: string; error?: string; card?: WorkboardCard }>;
};

export type ControllerStatus = {
  running: boolean;
  enabled: boolean;
  statePath: string;
  subscriptionId?: string;
  lastTickAt?: number;
  lastDispatchAt?: number;
  lastArchiveScanAt?: number;
  lastError?: string;
  counters: ControllerState["counters"];
  archiveCandidates: ControllerState["archiveCandidates"];
  archiveLastFailures: ControllerState["archiveLastFailures"];
  recentStartNotifications: ControllerState["recentStartNotifications"];
  startNotificationFailures: ControllerState["startNotificationFailures"];
  archive: {
    enabled: boolean;
    dryRun: boolean;
    requireProof: boolean;
    scanIntervalMs: number;
    completedGraphAfterMs: number;
    standaloneAfterMs: number;
    nextScanAt?: number;
  };
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
      lastArchiveScanAt: state?.lastArchiveScanAt,
      lastError: state?.lastError,
      counters: state?.counters ?? { ticks: 0, events: 0, dispatches: 0, wakes: 0, errors: 0, archiveScans: 0, archiveCandidates: 0, archiveActions: 0, archiveErrors: 0, startNotifications: 0, startNotificationErrors: 0 },
      archiveCandidates: state?.archiveCandidates ?? [],
      archiveLastFailures: state?.archiveLastFailures ?? [],
      recentStartNotifications: state?.recentStartNotifications ?? [],
      startNotificationFailures: state?.startNotificationFailures ?? [],
      archive: {
        enabled: this.options.config.archiveEnabled,
        dryRun: this.options.config.archiveDryRun,
        requireProof: this.options.config.archiveRequireProof,
        scanIntervalMs: this.options.config.archiveScanIntervalMs,
        completedGraphAfterMs: this.options.config.archiveCompletedGraphAfterMs,
        standaloneAfterMs: this.options.config.archiveStandaloneAfterMs,
        nextScanAt: state?.lastArchiveScanAt === undefined ? undefined : state.lastArchiveScanAt + this.options.config.archiveScanIntervalMs,
      },
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
      const archiveOk = await this.runArchiveScanIfDue();
      if (archiveOk && state.lastError?.startsWith("archive ")) state.lastError = undefined;
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


  private async runArchiveScanIfDue(): Promise<boolean> {
    const state = await this.requireState();
    if (!this.options.config.archiveEnabled) return true;
    const now = Date.now();
    if (state.lastArchiveScanAt && now - state.lastArchiveScanAt < this.options.config.archiveScanIntervalMs) return true;
    state.lastArchiveScanAt = now;
    state.counters.archiveScans += 1;
    state.archiveCandidates = [];
    state.archiveLastFailures = [];
    await this.save();
    let archiveOk = true;

    try {
      const payload = await this.options.gateway.request<WorkboardListPayload>("workboard.cards.list", { boardId: this.options.config.boardId });
      const candidates = computeArchiveCandidates(payload.cards ?? [], {
        now,
        completedGraphAfterMs: this.options.config.archiveCompletedGraphAfterMs,
        standaloneAfterMs: this.options.config.archiveStandaloneAfterMs,
        requireProof: this.options.config.archiveRequireProof,
        maxCandidates: 50,
      });
      state.archiveCandidates = candidates;
      state.counters.archiveCandidates += candidates.reduce((total, candidate) => total + candidate.cardIds.length, 0);
      await this.save();

      if (this.options.config.archiveDryRun) {
        if (state.lastError?.startsWith("archive ")) state.lastError = undefined;
        await this.save();
        return true;
      }
      for (const candidate of candidates) {
        const currentPayload = await this.options.gateway.request<WorkboardListPayload>("workboard.cards.list", { boardId: this.options.config.boardId });
        const stillEligible = computeArchiveCandidates(currentPayload.cards ?? [], {
          now: Date.now(),
          completedGraphAfterMs: this.options.config.archiveCompletedGraphAfterMs,
          standaloneAfterMs: this.options.config.archiveStandaloneAfterMs,
          requireProof: this.options.config.archiveRequireProof,
          maxCandidates: 50,
        }).find((entry) => entry.componentId === candidate.componentId);
        if (!stillEligible) continue;
        for (const cardId of stillEligible.cardIds) {
          const title = stillEligible.titles[cardId];
          try {
            await this.options.gateway.request<ArchivePayload>("workboard.cards.archive", { id: cardId, archived: true });
            state.counters.archiveActions += 1;
            await this.save();
          } catch (error) {
            const failure: ArchiveFailure = { componentId: stillEligible.componentId, cardId, title, error: errorMessage(error), at: Date.now() };
            archiveOk = false;
            state.archiveLastFailures = [...state.archiveLastFailures, failure].slice(-50);
            state.lastError = `archive failed for ${cardId}: ${failure.error}`;
            state.counters.archiveErrors += 1;
            await this.save();
            this.options.logger?.warn?.("workboard-controller archive card failed", failure);
          }
        }
      }
    } catch (error) {
      archiveOk = false;
      state.lastError = `archive scan failed: ${errorMessage(error)}`;
      state.counters.archiveErrors += 1;
      await this.save();
      this.options.logger?.warn?.("workboard-controller archive scan failed", { error: state.lastError });
    }
    if (archiveOk && state.lastError?.startsWith("archive ")) state.lastError = undefined;
    await this.save();
    return archiveOk;
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
    await this.notifyStartedCards(result.started ?? [], reason, now);
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


  private async notifyStartedCards(started: StartedWorkboardCard[], reason: string, dispatchAt: number): Promise<void> {
    const state = await this.requireState();
    if (!this.options.config.startNotifyEnabled) return;
    const pending = started.map((card) => ({ card, cardId: startedCardId(card), identity: startNotificationIdentity(card, dispatchAt) })).filter((entry) => entry.cardId && entry.identity);
    if (!pending.length) return;

    let cardsById = new Map<string, WorkboardCard>();
    let listError: string | undefined;
    if (!this.options.config.startNotifySessionKey) {
      try {
        const payload = await this.options.gateway.request<WorkboardListPayload>("workboard.cards.list", { boardId: this.options.config.boardId });
        cardsById = new Map((payload.cards ?? []).map((card) => [card.id, card]));
      } catch (error) {
        listError = errorMessage(error);
      }
    }

    for (const entry of pending) {
      const cardId = entry.cardId!;
      const identity = entry.identity!;
      if (state.notifiedStartIds.includes(identity)) continue;
      const listedCard = cardsById.get(cardId);
      const title = startedCardTitle(entry.card, listedCard);
      const target = this.resolveStartNotificationTarget(entry.card, listedCard);
      if (!target) {
        const error = listError
          ? `could not resolve owner session after workboard.cards.list failed: ${listError}`
          : "could not resolve a reliable external owner session; configure startNotifySessionKey or wakeFallbackSessionKey";
        await this.recordStartNotificationFailure({ cardId, title, error, at: Date.now() });
        continue;
      }

      try {
        const agentId = agentIdFromSessionKey(target.sessionKey) ?? listedCard?.agentId ?? this.options.config.wakeFallbackAgentId;
        const workspaceDir = this.options.runtimeAgent.resolveAgentWorkspaceDir(this.options.fullConfig, agentId);
        const timeoutMs = this.options.config.wakeTimeoutMs || this.options.runtimeAgent.resolveAgentTimeoutMs({ cfg: this.options.fullConfig });
        await this.options.runtimeAgent.runEmbeddedAgent({
          sessionId: randomUUID(),
          sessionKey: target.sessionKey,
          agentId,
          workspaceDir,
          config: this.options.fullConfig,
          prompt: buildStartNotificationPrompt({ cardId, title, reason }),
          trigger: "manual",
          runId: randomUUID(),
          timeoutMs,
        });
        const notifiedAt = Date.now();
        state.notifiedStartIds = rememberBounded(state.notifiedStartIds, identity);
        state.recentStartNotifications = [...state.recentStartNotifications, { cardId, title, notifiedAt, target: target.sessionKey }].slice(-50);
        state.counters.startNotifications += 1;
        if (state.lastError?.startsWith("start notification failed")) state.lastError = undefined;
        await this.save();
      } catch (error) {
        await this.recordStartNotificationFailure({ cardId, title, target: target.sessionKey, error: errorMessage(error), at: Date.now() });
      }
    }
  }

  private resolveStartNotificationTarget(started: StartedWorkboardCard, card?: WorkboardCard): { sessionKey: string } | undefined {
    const cardId = startedCardId(started) ?? card?.id;
    const workerSessionKey = optionalSessionKey(started.sessionKey) ?? optionalSessionKey(card?.execution?.sessionKey) ?? optionalSessionKey(card?.sessionKey);
    const explicit = optionalSessionKey(this.options.config.startNotifySessionKey);
    if (explicit) return isReliableExternalOwnerSessionKey(explicit, workerSessionKey, cardId) ? { sessionKey: explicit } : undefined;

    const ownerSessionKey = resolveOwnerSessionKeyFromCard(card, workerSessionKey, cardId);
    if (ownerSessionKey) return { sessionKey: ownerSessionKey };

    const fallback = optionalSessionKey(this.options.config.wakeFallbackSessionKey);
    if (fallback && isReliableExternalOwnerSessionKey(fallback, workerSessionKey, cardId)) return { sessionKey: fallback };
    return undefined;
  }

  private async recordStartNotificationFailure(failure: StartNotificationFailure): Promise<void> {
    const state = await this.requireState();
    state.startNotificationFailures = [...state.startNotificationFailures, failure].slice(-50);
    state.lastError = `start notification failed${failure.cardId ? ` for ${failure.cardId}` : ""}: ${failure.error}`;
    state.counters.startNotificationErrors += 1;
    await this.save();
    this.options.logger?.warn?.("workboard-controller start notification failed", failure);
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


function optionalSessionKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function startedCardId(card: StartedWorkboardCard): string | undefined {
  return optionalSessionKey(card.id) ?? optionalSessionKey(card.cardId);
}

function startedCardTitle(started: StartedWorkboardCard, card?: WorkboardCard): string {
  return optionalSessionKey(started.title) ?? optionalSessionKey(card?.title) ?? startedCardId(started) ?? "unknown card";
}

function startNotificationIdentity(card: StartedWorkboardCard, dispatchAt: number): string | undefined {
  const cardId = startedCardId(card);
  const runId = optionalSessionKey(card.runId) ?? optionalSessionKey(card.execution?.runId);
  if (runId) return `run:${runId}`;
  if (!cardId) return undefined;
  const startedAt = typeof card.startedAt === "number" && Number.isFinite(card.startedAt)
    ? card.startedAt
    : typeof card.execution?.startedAt === "number" && Number.isFinite(card.execution.startedAt)
      ? card.execution.startedAt
      : dispatchAt;
  return `card:${cardId}:${Math.trunc(startedAt)}`;
}

function isWorkboardWorkerSessionKey(sessionKey: string, cardId?: string): boolean {
  const normalized = sessionKey.toLowerCase();
  if (normalized.startsWith("subagent:") || normalized.includes(":subagent:")) return true;
  if (normalized.includes("workboard-")) return true;
  return Boolean(cardId && normalized.includes(cardId.toLowerCase()) && normalized.includes("workboard"));
}

function isReliableExternalOwnerSessionKey(sessionKey: string, workerSessionKey?: string, cardId?: string): boolean {
  const normalized = optionalSessionKey(sessionKey);
  if (!normalized) return false;
  if (workerSessionKey && normalized === workerSessionKey) return false;
  return !isWorkboardWorkerSessionKey(normalized, cardId);
}

function resolveOwnerSessionKeyFromCard(card: WorkboardCard | undefined, workerSessionKey?: string, cardId?: string): string | undefined {
  if (!card) return undefined;
  const candidates = [
    optionalSessionKey(card.sessionKey),
    ...(card.events ?? []).map((event) => optionalSessionKey(event.sessionKey)).reverse(),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && isReliableExternalOwnerSessionKey(candidate, workerSessionKey, cardId)));
}

function agentIdFromSessionKey(sessionKey: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1];
}

function formatStartNotification(input: { cardId: string; title: string; reason: string }): string {
  const lines = [`▶️ Workboard 已启动：${input.title}`, `ID: ${input.cardId}`];
  if (input.reason.trim()) lines.push(`Reason: ${input.reason.trim()}`);
  return lines.join("\n");
}

function buildStartNotificationPrompt(input: { cardId: string; title: string; reason: string }): string {
  return [
    "You are delivering a Workboard controller start notification to this existing owner session.",
    "Send exactly the notification text below as the visible reply. Do not work on the card. Do not inspect files. Do not call tools. Do not add commentary.",
    "Notification:",
    formatStartNotification(input),
  ].join("\n");
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
