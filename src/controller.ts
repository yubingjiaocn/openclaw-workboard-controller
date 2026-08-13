import { randomUUID } from "node:crypto";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { computeArchiveCandidates, type WorkboardArchiveCard } from "./archive.js";
import type { ControllerConfig, OwnerRoute } from "./config.js";
import { assertCompatibleOpenClawVersion } from "./config.js";
import type { GatewayMethodClient } from "./gateway-method-client.js";
import { agentIdFromSessionKey, isReliableExternalOwnerSessionKey, isWorkboardWorkerSessionKey, optionalSessionKey, type OwnerBinding, type OwnerBindingSource } from "./owner-binding.js";
import { errorMessage } from "./gateway-method-client.js";
import type { ArchiveFailure, ControllerState, PendingTerminalEvent, StartNotificationFailure, StateStore, TerminalWakeFailure, TerminalWakeRecord } from "./state.js";
import { rememberBounded } from "./state.js";

const MAX_PENDING_TERMINAL_EVENTS = 1000;
const INITIAL_TERMINAL_WAKE_RETRY_MS = 1_000;
const MAX_TERMINAL_WAKE_RETRY_MS = 60_000;

type Logger = {
  info?: (message: string, data?: unknown) => void;
  warn?: (message: string, data?: unknown) => void;
  error?: (message: string, data?: unknown) => void;
  debug?: (message: string, data?: unknown) => void;
};

type RuntimeAgent = OpenClawPluginApi["runtime"]["agent"];

type TerminalWakeKind = "completed" | "failed" | "stale" | "blocked" | "startFailure";

type WorkboardNotification = {
  id: string;
  kind: "completed" | "failed" | "stale";
  createdAt: number;
  sequence?: number;
  message: string;
  cardId?: string;
  sessionKey?: string;
  runId?: string;
};

type WorkboardCard = WorkboardArchiveCard & {
  boardId?: string;
  tenant?: string;
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

type WorkboardReadPayload = {
  card?: WorkboardCard;
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

type OwnerRouteContext = {
  tenant?: string;
  boardId?: string;
  agentId?: string;
};

type OwnerTargetResolution =
  | { status: "target"; sessionKey: string; agentId: string; source: "ownerBinding" | "ownerRoutes" | "legacy-startNotifySessionKey" | "legacy-wakeFallbackSessionKey" }
  | { status: "rejected"; error: string; target?: string }
  | { status: "none" };

type InFlightOwnerWake = {
  ownerSessionKey: string;
  ownerAgentId: string;
  wakeKeys: string[];
  startedAt: number;
};

type PendingTerminalEventsStatus = {
  total: number;
  byOwner: Array<{
    ownerSessionKey: string;
    count: number;
    oldestFirstObservedAt?: number;
    nextDueAt?: number;
  }>;
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
  recentTerminalWakes: ControllerState["recentTerminalWakes"];
  terminalWakeFailures: ControllerState["terminalWakeFailures"];
  pendingTerminalEvents: PendingTerminalEventsStatus;
  inFlightOwnerWakes: InFlightOwnerWake[];
  wakeFailures: ControllerState["wakeFailures"];
  ownerBindings: {
    total: number;
    bySource: Record<string, number>;
    recent: Array<{ cardId: string; source: string; ownerAgentId?: string; createdAt: number; updatedAt?: number; inheritedFromCardId?: string }>;
  };
  reconciliation: {
    enabled: boolean;
    intervalMs: number;
    nextAt?: number;
  };
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
  private readonly inFlightOwnerWakes = new Map<string, InFlightOwnerWake>();
  private readonly inFlightTerminalWakeKeys = new Set<string>();

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
      counters: state?.counters ?? { ticks: 0, events: 0, dispatches: 0, wakes: 0, wakeErrors: 0, terminalWakes: 0, terminalWakeErrors: 0, errors: 0, archiveScans: 0, archiveCandidates: 0, archiveActions: 0, archiveErrors: 0, startNotifications: 0, startNotificationErrors: 0, terminalEventsQueued: 0, terminalWakeBatches: 0, terminalWakeBatchErrors: 0 },
      archiveCandidates: state?.archiveCandidates ?? [],
      archiveLastFailures: state?.archiveLastFailures ?? [],
      recentStartNotifications: state?.recentStartNotifications ?? [],
      startNotificationFailures: state?.startNotificationFailures ?? [],
      recentTerminalWakes: state?.recentTerminalWakes ?? [],
      terminalWakeFailures: state?.terminalWakeFailures ?? [],
      pendingTerminalEvents: pendingTerminalEventsStatus(state?.pendingTerminalEvents ?? [], this.options.config.terminalWakeDebounceMs),
      inFlightOwnerWakes: Array.from(this.inFlightOwnerWakes.values()).map((wake) => ({ ...wake, wakeKeys: [...wake.wakeKeys] })),
      wakeFailures: state?.wakeFailures ?? [],
      ownerBindings: ownerBindingsStatus(state?.ownerBindings ?? []),
      reconciliation: {
        enabled: this.options.config.reconcileIntervalMs > 0,
        intervalMs: this.options.config.reconcileIntervalMs,
        nextAt: state?.lastDispatchAt === undefined || this.options.config.reconcileIntervalMs === 0
          ? undefined
          : state.lastDispatchAt + this.options.config.reconcileIntervalMs,
      },
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

  async bindOwner(input: { cardId: string; ownerSessionKey: string; ownerAgentId?: string; source: OwnerBindingSource; inheritedFromCardId?: string }): Promise<OwnerBinding> {
    const cardId = optionalSessionKey(input.cardId);
    const ownerSessionKey = optionalSessionKey(input.ownerSessionKey);
    if (!cardId) throw new Error("cardId must be a non-empty string");
    if (!ownerSessionKey || !isReliableExternalOwnerSessionKey(ownerSessionKey, [], cardId)) {
      throw new Error("ownerSessionKey must be a reliable external direct session key");
    }
    const state = await this.requireState();
    const now = Date.now();
    const existing = state.ownerBindings.find((binding) => binding.cardId === cardId);
    if (existing && input.source !== "manual") {
      if (existing.ownerSessionKey !== ownerSessionKey) {
        throw new Error(`card ${cardId} is already bound to another owner session`);
      }
      return existing;
    }
    const binding: OwnerBinding = {
      cardId,
      ownerSessionKey,
      ownerAgentId: optionalSessionKey(input.ownerAgentId) ?? agentIdFromSessionKey(ownerSessionKey),
      source: input.source,
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing ? now : undefined,
      inheritedFromCardId: optionalSessionKey(input.inheritedFromCardId),
    };
    state.ownerBindings = [...state.ownerBindings.filter((entry) => entry.cardId !== cardId), binding].slice(-5000);
    await this.save();
    return binding;
  }

  async createOwnedCard(params: Record<string, unknown>, ownerSessionKey: string, ownerAgentId?: string): Promise<unknown> {
    if (!isReliableExternalOwnerSessionKey(ownerSessionKey)) throw new Error("ownerSessionKey must be a reliable external direct session key");
    const payload = await this.options.gateway.request<{ card?: { id?: string } }>("workboard.cards.create", params);
    const cardId = optionalSessionKey(payload.card?.id);
    if (!cardId) throw new Error("workboard.cards.create returned no card id");
    await this.bindOwner({ cardId, ownerSessionKey, ownerAgentId, source: "owned-tool" });
    return payload;
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
      await this.processDueTerminalWakes();
      if (batch.newEvents > 0 || this.isReconciliationDue(Date.now())) {
        await this.dispatchReadyCards(batch.newEvents > 0 ? reason : `reconcile:${reason}`);
      }
      await this.processDueTerminalWakes();
      if (batch.advanceCount > 0) await this.advanceNotifications(batch.advanceCount);
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
    return { advanceCount, newEvents };
  }

  private async advanceNotifications(advanceCount: number): Promise<void> {
    const subscriptionId = await this.ensureSubscription();
    await this.options.gateway.request("workboard.notifications.advance", { subscriptionId, limit: advanceCount });
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
    await this.enqueueTerminalWake({
      wakeKey: terminalWakeKeyForEvent(event),
      kind: event.kind,
      message: event.message,
      cardId: event.cardId,
      sessionKey: event.sessionKey,
      runId: event.runId,
      event,
    });
  }

  private isReconciliationDue(now: number): boolean {
    if (this.options.config.reconcileIntervalMs <= 0) return false;
    const lastDispatchAt = this.state?.lastDispatchAt;
    return lastDispatchAt === undefined || now - lastDispatchAt >= this.options.config.reconcileIntervalMs;
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
      await this.enqueueTerminalWake({
        wakeKey: `blocked:${card.id}:${card.updatedAt ?? card.status ?? "unknown"}`,
        kind: "blocked",
        message: `Workboard card blocked during dispatch (${reason}): ${card.title ?? card.id}`,
        card,
      });
    }
    for (const failure of result.startFailures ?? []) {
      await this.enqueueTerminalWake({
        wakeKey: startFailureWakeKey(failure),
        kind: "startFailure",
        message: `Workboard worker start failed: ${failure.error ?? "unknown error"}`,
        cardId: failure.cardId ?? failure.card?.id,
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
    if (this.options.config.ownerRoutes.length || state.ownerBindings.length) {
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
      const target = await this.resolveStartNotificationTarget(entry.card, listedCard, cardsById);
      if (target.status !== "target") {
        const error = target.status === "rejected"
          ? target.error
          : listError
            ? `could not resolve owner route after workboard.cards.list failed: ${listError}`
            : "could not resolve a reliable owner route; configure ownerRoutes, startNotifySessionKey, or wakeFallbackSessionKey";
        await this.recordStartNotificationFailure({ cardId, title, target: target.status === "rejected" ? target.target : undefined, error, at: Date.now() });
        continue;
      }

      try {
        const workspaceDir = this.options.runtimeAgent.resolveAgentWorkspaceDir(this.options.fullConfig, target.agentId);
        const timeoutMs = this.options.config.wakeTimeoutMs || this.options.runtimeAgent.resolveAgentTimeoutMs({ cfg: this.options.fullConfig });
        await this.options.runtimeAgent.runEmbeddedAgent({
          sessionId: randomUUID(),
          sessionKey: target.sessionKey,
          agentId: target.agentId,
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

  private async resolveStartNotificationTarget(started: StartedWorkboardCard, card?: WorkboardCard, cardsById = new Map<string, WorkboardCard>()): Promise<OwnerTargetResolution> {
    const cardId = startedCardId(started) ?? card?.id;
    const context = this.ownerRouteContext({ started, card });
    const workerKeys = workerSessionKeys({ started, card });
    const bindingTarget = await this.resolveBoundOwnerTarget(cardId, workerKeys, context, card, cardsById);
    if (bindingTarget.status !== "none") return bindingTarget;
    const routeTarget = this.resolveConfiguredOwnerRoute(context, workerKeys, cardId);
    if (routeTarget.status !== "none") return routeTarget;

    const explicit = optionalSessionKey(this.options.config.startNotifySessionKey);
    if (explicit) {
      if (isReliableExternalOwnerSessionKey(explicit, workerSessionKeys({ started, card }), cardId)) {
        return { status: "target", sessionKey: explicit, agentId: this.targetAgentId(explicit, context), source: "legacy-startNotifySessionKey" };
      }
      return { status: "rejected", target: explicit, error: `legacy startNotifySessionKey target rejected as a worker session: ${explicit}` };
    }

    const fallback = optionalSessionKey(this.options.config.wakeFallbackSessionKey);
    if (fallback) {
      if (isReliableExternalOwnerSessionKey(fallback, workerSessionKeys({ started, card }), cardId)) {
        return { status: "target", sessionKey: fallback, agentId: this.targetAgentId(fallback, context), source: "legacy-wakeFallbackSessionKey" };
      }
      return { status: "rejected", target: fallback, error: `legacy wakeFallbackSessionKey target rejected as a worker session: ${fallback}` };
    }
    return { status: "none" };
  }

  private async recordStartNotificationFailure(failure: StartNotificationFailure): Promise<void> {
    const state = await this.requireState();
    state.startNotificationFailures = [...state.startNotificationFailures, failure].slice(-50);
    state.lastError = `start notification failed${failure.cardId ? ` for ${failure.cardId}` : ""}: ${failure.error}`;
    state.counters.startNotificationErrors += 1;
    await this.save();
    this.options.logger?.warn?.("workboard-controller start notification failed", failure);
  }

  private async enqueueTerminalWake(input: {
    wakeKey: string;
    kind: TerminalWakeKind;
    message: string;
    cardId?: string;
    sessionKey?: string;
    runId?: string;
    card?: WorkboardCard;
    event?: WorkboardNotification;
  }): Promise<void> {
    const state = await this.requireState();
    if (!this.options.config.terminalWakeEnabled) return;
    if (state.terminalWakeIds.includes(input.wakeKey)) return;
    if (state.pendingTerminalEvents.some((event) => event.wakeKey === input.wakeKey)) return;
    if (this.inFlightTerminalWakeKeys.has(input.wakeKey)) return;

    const contextResult = await this.resolveProblemCardContext(input);
    const card = contextResult.card ?? input.card;
    const cardId = input.cardId ?? card?.id;
    const title = terminalWakeTitle(input, card);
    const target = await this.resolveTerminalWakeTarget(input, card);
    const pending: PendingTerminalEvent = {
      wakeKey: input.wakeKey,
      kind: input.kind,
      message: input.message,
      firstObservedAt: Date.now(),
      cardId,
      title,
      sessionKey: input.sessionKey,
      runId: input.runId,
      ownerSessionKey: target.status === "target" ? target.sessionKey : undefined,
      ownerAgentId: target.status === "target" ? target.agentId : undefined,
      event: serializableRecord(input.event),
      card: serializableRecord(card),
      attemptCount: 0,
      lastError: target.status === "rejected"
        ? target.error
        : target.status === "none" && contextResult.lookupError
          ? `could not resolve owner route after workboard.cards.list failed: ${contextResult.lookupError}`
          : undefined,
    };
    state.pendingTerminalEvents = [...state.pendingTerminalEvents, pending].slice(-MAX_PENDING_TERMINAL_EVENTS);
    state.counters.terminalEventsQueued += 1;
    await this.save();
  }

  private async processDueTerminalWakes(): Promise<void> {
    if (!this.options.config.terminalWakeEnabled) return;
    const state = await this.requireState();
    const now = Date.now();
    let changed = false;

    for (const event of state.pendingTerminalEvents) {
      if (event.ownerSessionKey || this.inFlightTerminalWakeKeys.has(event.wakeKey)) continue;
      if (!isPendingTerminalEventDue(event, now, this.options.config.terminalWakeDebounceMs)) continue;
      const target = await this.resolvePendingTerminalWakeTarget(event);
      if (target.status === "target") {
        event.ownerSessionKey = target.sessionKey;
        event.ownerAgentId = target.agentId;
        event.lastError = undefined;
        event.nextAttemptAt = undefined;
        changed = true;
        continue;
      }
      const error = target.status === "rejected"
        ? target.error
        : "could not resolve a reliable owner route; configure ownerRoutes with the original owner sessionKey";
      this.markPendingTerminalEventFailure(event, error, now);
      await this.recordTerminalWakeFailure({ wakeKey: event.wakeKey, kind: event.kind, cardId: event.cardId, target: target.status === "rejected" ? target.target : undefined, error, at: now });
      changed = true;
    }
    if (changed) await this.save();

    const byOwner = new Map<string, PendingTerminalEvent[]>();
    for (const event of state.pendingTerminalEvents) {
      if (!event.ownerSessionKey) continue;
      if (this.inFlightTerminalWakeKeys.has(event.wakeKey)) continue;
      if (!isPendingTerminalEventAvailable(event, now)) continue;
      const events = byOwner.get(event.ownerSessionKey) ?? [];
      events.push(event);
      byOwner.set(event.ownerSessionKey, events);
    }

    for (const [ownerSessionKey, events] of byOwner) {
      if (this.inFlightOwnerWakes.has(ownerSessionKey)) continue;
      const ownerDueAt = Math.min(...events.map((event) => terminalEventDueAt(event, this.options.config.terminalWakeDebounceMs)));
      if (ownerDueAt > now) continue;
      const ownerAgentId = events.find((event) => event.ownerAgentId)?.ownerAgentId ?? this.targetAgentId(ownerSessionKey, {});
      this.startOwnerWakeBatch(ownerSessionKey, ownerAgentId, events, now);
    }
  }

  private async resolvePendingTerminalWakeTarget(event: PendingTerminalEvent): Promise<OwnerTargetResolution> {
    const input = pendingEventWakeInput(event);
    const contextResult = await this.resolveProblemCardContext(input);
    const card = contextResult.card ?? input.card;
    if (card && (!event.card || !isIdentifiedCard(event.card as WorkboardCard))) event.card = serializableRecord(card);
    if (!event.cardId && card?.id) event.cardId = card.id;
    if (!event.title) event.title = terminalWakeTitle(input, card);
    const target = await this.resolveTerminalWakeTarget(input, card);
    if (target.status !== "none" || !contextResult.lookupError) return target;
    return { status: "rejected", error: `could not resolve owner route after workboard.cards.list failed: ${contextResult.lookupError}` };
  }

  private startOwnerWakeBatch(ownerSessionKey: string, ownerAgentId: string, events: PendingTerminalEvent[], startedAt: number): void {
    const wakeKeys = events.map((event) => event.wakeKey);
    for (const wakeKey of wakeKeys) this.inFlightTerminalWakeKeys.add(wakeKey);
    this.inFlightOwnerWakes.set(ownerSessionKey, { ownerSessionKey, ownerAgentId, wakeKeys, startedAt });
    void this.deliverOwnerWakeBatch(ownerSessionKey, ownerAgentId, events.map((event) => ({ ...event }))).finally(() => {
      for (const wakeKey of wakeKeys) this.inFlightTerminalWakeKeys.delete(wakeKey);
      this.inFlightOwnerWakes.delete(ownerSessionKey);
      void this.processDueTerminalWakes();
    });
  }

  private async deliverOwnerWakeBatch(ownerSessionKey: string, ownerAgentId: string, events: PendingTerminalEvent[]): Promise<void> {
    const workspaceDir = this.options.runtimeAgent.resolveAgentWorkspaceDir(this.options.fullConfig, ownerAgentId);
    const timeoutMs = this.options.config.wakeTimeoutMs || this.options.runtimeAgent.resolveAgentTimeoutMs({ cfg: this.options.fullConfig });
    try {
      await this.options.runtimeAgent.runEmbeddedAgent({
        // sessionId is a transcript identifier, not the owner routing sessionKey.
        sessionId: randomUUID(),
        sessionKey: ownerSessionKey,
        agentId: ownerAgentId,
        workspaceDir,
        config: this.options.fullConfig,
        prompt: buildTerminalWakeBatchPrompt(events),
        trigger: "manual",
        runId: randomUUID(),
        timeoutMs,
        ...(this.options.config.wakeToolsAllow ? { toolsAllow: this.options.config.wakeToolsAllow } : {}),
      });
      const state = await this.requireState();
      const deliveredAt = Date.now();
      const deliveredKeys = new Set(events.map((event) => event.wakeKey));
      state.pendingTerminalEvents = state.pendingTerminalEvents.filter((event) => !deliveredKeys.has(event.wakeKey));
      for (const event of events) {
        state.terminalWakeIds = rememberBounded(state.terminalWakeIds, event.wakeKey);
        if (event.kind !== "completed") state.notifiedProblemIds = rememberBounded(state.notifiedProblemIds, event.wakeKey);
        const record: TerminalWakeRecord = { wakeKey: event.wakeKey, kind: event.kind, cardId: event.cardId, title: event.title, target: ownerSessionKey, wokenAt: deliveredAt };
        state.recentTerminalWakes = [...state.recentTerminalWakes, record].slice(-50);
      }
      state.counters.terminalWakes += events.length;
      state.counters.wakes += events.length;
      state.counters.terminalWakeBatches += 1;
      if (state.lastError?.startsWith("terminal wake failed") || state.lastError?.startsWith("problem wake failed")) state.lastError = undefined;
      await this.save();
    } catch (error) {
      const state = await this.requireState();
      const at = Date.now();
      const message = errorMessage(error);
      const wakeKeys = new Set(events.map((event) => event.wakeKey));
      for (const event of state.pendingTerminalEvents) {
        if (wakeKeys.has(event.wakeKey)) this.markPendingTerminalEventFailure(event, message, at);
      }
      const failures: TerminalWakeFailure[] = events.map((event) => ({ wakeKey: event.wakeKey, kind: event.kind, cardId: event.cardId, target: ownerSessionKey, error: message, at }));
      state.terminalWakeFailures = [...state.terminalWakeFailures, ...failures].slice(-50);
      state.wakeFailures = [...state.wakeFailures, ...failures.map((failure) => ({ problemKey: failure.wakeKey, kind: failure.kind, cardId: failure.cardId, target: failure.target, error: failure.error, at: failure.at }))].slice(-50);
      state.lastError = `terminal wake failed${events.length === 1 && events[0].cardId ? ` for ${events[0].cardId}` : ""}: ${message}`;
      state.counters.terminalWakeErrors += events.length;
      state.counters.wakeErrors += events.length;
      state.counters.terminalWakeBatchErrors += 1;
      await this.save();
      this.options.logger?.warn?.("workboard-controller terminal wake batch failed", { ownerSessionKey, wakeKeys: [...wakeKeys], error: message });
    }
  }

  private markPendingTerminalEventFailure(event: PendingTerminalEvent, error: string, at: number): void {
    event.attemptCount += 1;
    event.lastAttemptAt = at;
    event.lastError = error;
    event.nextAttemptAt = at + terminalWakeBackoffMs(event.attemptCount);
  }

  private async resolveTerminalWakeTarget(input: { cardId?: string; sessionKey?: string; runId?: string; card?: WorkboardCard }, card?: WorkboardCard): Promise<OwnerTargetResolution> {
    const cardId = input.cardId ?? card?.id ?? input.card?.id;
    const context = this.ownerRouteContext({ card: card ?? input.card });
    const eventSessionKey = optionalSessionKey(input.sessionKey);
    const workerKeys = workerSessionKeys({
      card: card ?? input.card,
      extra: eventSessionKey && isWorkboardWorkerSessionKey(eventSessionKey, cardId) ? [eventSessionKey] : [],
    });
    const bindingTarget = await this.resolveBoundOwnerTarget(cardId, workerKeys, context, card ?? input.card);
    if (bindingTarget.status !== "none") return bindingTarget;
    return this.resolveConfiguredOwnerRoute(context, workerKeys, cardId);
  }

  private async resolveBoundOwnerTarget(cardId: string | undefined, workerKeys: string[], context: OwnerRouteContext, card?: WorkboardCard, cardsById = new Map<string, WorkboardCard>()): Promise<OwnerTargetResolution> {
    const state = await this.requireState();
    const binding = await this.findOrInheritOwnerBinding(cardId, card, cardsById);
    if (!binding) return { status: "none" };
    if (!isReliableExternalOwnerSessionKey(binding.ownerSessionKey, workerKeys, cardId)) {
      return { status: "rejected", target: binding.ownerSessionKey, error: "owner binding target rejected as a worker session: " + binding.ownerSessionKey };
    }
    const liveBinding = state.ownerBindings.find((entry) => entry.cardId === binding.cardId) ?? binding;
    return { status: "target", sessionKey: liveBinding.ownerSessionKey, agentId: liveBinding.ownerAgentId ?? this.targetAgentId(liveBinding.ownerSessionKey, context), source: "ownerBinding" };
  }

  private async findOrInheritOwnerBinding(cardId?: string, card?: WorkboardCard, cardsById = new Map<string, WorkboardCard>()): Promise<OwnerBinding | undefined> {
    const state = await this.requireState();
    const directCardId = optionalSessionKey(cardId ?? card?.id);
    if (!directCardId) return undefined;
    const direct = state.ownerBindings.find((binding) => binding.cardId === directCardId);
    if (direct) return direct;
    const seen = new Set<string>([directCardId]);
    let current = card ?? cardsById.get(directCardId);
    for (let depth = 0; depth < 8; depth += 1) {
      const parentId = createdByCardIdFromCard(current);
      if (!parentId || seen.has(parentId)) return undefined;
      seen.add(parentId);
      const parentBinding = state.ownerBindings.find((binding) => binding.cardId === parentId);
      if (parentBinding) {
        return await this.bindOwner({
          cardId: directCardId,
          ownerSessionKey: parentBinding.ownerSessionKey,
          ownerAgentId: parentBinding.ownerAgentId,
          source: "inherited",
          inheritedFromCardId: parentId,
        });
      }
      current = cardsById.get(parentId);
      if (!current) return undefined;
    }
    return undefined;
  }

  private async recordTerminalWakeFailure(failure: TerminalWakeFailure): Promise<void> {
    const state = await this.requireState();
    state.terminalWakeFailures = [...state.terminalWakeFailures, failure].slice(-50);
    state.wakeFailures = [...state.wakeFailures, { problemKey: failure.wakeKey, kind: failure.kind, cardId: failure.cardId, target: failure.target, error: failure.error, at: failure.at }].slice(-50);
    state.lastError = `terminal wake failed${failure.cardId ? ` for ${failure.cardId}` : ""}: ${failure.error}`;
    state.counters.terminalWakeErrors += 1;
    state.counters.wakeErrors += 1;
    state.counters.terminalWakeBatchErrors += 1;
    await this.save();
    this.options.logger?.warn?.("workboard-controller terminal wake failed", failure);
  }
  private resolveConfiguredOwnerRoute(context: OwnerRouteContext, workerKeys: string[], cardId?: string): OwnerTargetResolution {
    const route = selectOwnerRoute(this.options.config.ownerRoutes, context);
    if (!route) return { status: "none" };
    if (!isReliableExternalOwnerSessionKey(route.sessionKey, workerKeys, cardId)) {
      return { status: "rejected", target: route.sessionKey, error: `ownerRoutes target rejected as a worker session: ${route.sessionKey}` };
    }
    return { status: "target", sessionKey: route.sessionKey, agentId: this.targetAgentId(route.sessionKey, context), source: "ownerRoutes" };
  }

  private ownerRouteContext(input: { started?: StartedWorkboardCard; card?: WorkboardCard }): OwnerRouteContext {
    return {
      tenant: tenantFromCard(input.card) ?? tenantFromCard(input.started),
      boardId: cardBoardId(input.card) ?? cardBoardId(input.started) ?? this.options.config.boardId,
      agentId: optionalSessionKey(input.started?.agentId) ?? optionalSessionKey(input.card?.agentId),
    };
  }

  private targetAgentId(sessionKey: string, context: OwnerRouteContext): string {
    return agentIdFromSessionKey(sessionKey) ?? context.agentId ?? this.options.config.wakeFallbackAgentId;
  }

  private async resolveProblemCardContext(input: { cardId?: string; sessionKey?: string; runId?: string; card?: WorkboardCard; event?: WorkboardNotification }): Promise<{ card?: WorkboardCard; lookupError?: string }> {
    if (input.card && isIdentifiedCard(input.card)) return { card: input.card };
    const cardId = optionalSessionKey(input.cardId);
    const runId = optionalSessionKey(input.runId);
    const sessionKey = optionalSessionKey(input.sessionKey);
    const notificationId = optionalSessionKey(input.event?.id);
    if (!cardId && !runId && !sessionKey && !notificationId) return {};
    try {
      const payload = await this.options.gateway.request<WorkboardListPayload>("workboard.cards.list", { boardId: this.options.config.boardId });
      const cards = payload.cards ?? [];
      const cardsById = new Map(cards.map((entry) => [entry.id, entry]));
      let card = cards.find((candidate) => {
        if (cardId && candidate.id === cardId) return true;
        if (runId && (candidate.runId === runId || candidate.execution?.runId === runId)) return true;
        if (sessionKey && (candidate.sessionKey === sessionKey || candidate.execution?.sessionKey === sessionKey)) return true;
        return false;
      });
      if (!card && notificationId) {
        const fullCards: WorkboardCard[] = [];
        for (const candidate of cards) {
          const candidateId = optionalSessionKey(candidate.id);
          if (!candidateId) continue;
          const readPayload = await this.options.gateway.request<WorkboardReadPayload | WorkboardCard>("workboard.cards.read", { id: candidateId });
          const fullCard = isIdentifiedCard(readPayload as WorkboardCard) ? readPayload as WorkboardCard : (readPayload as WorkboardReadPayload).card;
          if (!fullCard) throw new Error(`workboard.cards.read returned no card for ${candidateId}`);
          fullCards.push(fullCard);
        }
        card = uniqueNotificationCardMatch(fullCards, notificationId, input.event?.sequence);
      }
      if (card) await this.findOrInheritOwnerBinding(card.id, card, cardsById);
      return { card };
    } catch (error) {
      return { lookupError: errorMessage(error) };
    }
  }


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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cardBoardId(card: unknown): string | undefined {
  return optionalSessionKey(asRecord(card).boardId);
}

function tenantFromCard(card: unknown): string | undefined {
  const record = asRecord(card);
  const metadata = asRecord(record.metadata);
  return optionalSessionKey(record.tenant) ?? optionalSessionKey(metadata.tenant) ?? optionalSessionKey(metadata.tenantId);
}

function createdByCardIdFromCard(card: unknown): string | undefined {
  const metadata = asRecord(asRecord(card).metadata);
  const automation = asRecord(metadata.automation);
  return optionalSessionKey(automation.createdByCardId) ?? optionalSessionKey(metadata.createdByCardId);
}

function workerSessionKeys(input: { started?: StartedWorkboardCard; card?: WorkboardCard; extra?: unknown[] }): string[] {
  const values = [
    input.started?.sessionKey,
    input.started?.execution?.sessionKey,
    input.card?.sessionKey,
    input.card?.execution?.sessionKey,
    ...(input.extra ?? []),
  ];
  return Array.from(new Set(values.flatMap((value) => {
    const sessionKey = optionalSessionKey(value);
    return sessionKey ? [sessionKey] : [];
  })));
}

function routeMatches(route: OwnerRoute, context: OwnerRouteContext): boolean {
  if (route.tenant && route.tenant !== context.tenant) return false;
  if (route.boardId && route.boardId !== context.boardId) return false;
  if (route.agentId && route.agentId !== context.agentId) return false;
  return true;
}

function routePriority(route: OwnerRoute): number {
  const hasTenant = Boolean(route.tenant);
  const hasBoard = Boolean(route.boardId);
  const hasAgent = Boolean(route.agentId);
  if (hasTenant && hasBoard && hasAgent) return 5;
  if (hasBoard && hasAgent) return 4;
  if (hasTenant && (hasBoard || hasAgent)) return 3;
  if (hasTenant || hasBoard || hasAgent) return 2;
  return 0;
}

function selectOwnerRoute(routes: OwnerRoute[], context: OwnerRouteContext): OwnerRoute | undefined {
  let selected: OwnerRoute | undefined;
  let selectedPriority = 0;
  for (const route of routes) {
    if (!routeMatches(route, context)) continue;
    const priority = routePriority(route);
    if (priority > selectedPriority) {
      selected = route;
      selectedPriority = priority;
    }
  }
  return selected;
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

function terminalWakeKeyForEvent(event: WorkboardNotification): string {
  return `event:${event.id}`;
}

function startFailureWakeKey(failure: NonNullable<DispatchPayload["startFailures"]>[number]): string {
  const cardId = optionalSessionKey(failure.cardId) ?? optionalSessionKey(failure.card?.id) ?? "unknown-card";
  const error = compactIdentityPart(failure.error ?? "unknown");
  return `start-failure:${cardId}:${error}`;
}

function compactIdentityPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 96) || "unknown";
}

function serializableRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

function isIdentifiedCard(card: WorkboardCard): boolean {
  return Boolean(
    optionalSessionKey(card.id)
      ?? optionalSessionKey(card.runId)
      ?? optionalSessionKey(card.execution?.runId)
      ?? optionalSessionKey(card.sessionKey)
      ?? optionalSessionKey(card.execution?.sessionKey),
  );
}

function pendingEventWakeInput(event: PendingTerminalEvent): {
  wakeKey: string;
  kind: TerminalWakeKind;
  message: string;
  cardId?: string;
  sessionKey?: string;
  runId?: string;
  card?: WorkboardCard;
  event?: WorkboardNotification;
} {
  return {
    wakeKey: event.wakeKey,
    kind: event.kind as TerminalWakeKind,
    message: event.message,
    cardId: event.cardId,
    sessionKey: event.sessionKey,
    runId: event.runId,
    card: event.card as WorkboardCard | undefined,
    event: event.event as WorkboardNotification | undefined,
  };
}

function terminalWakeBackoffMs(attemptCount: number): number {
  return Math.min(MAX_TERMINAL_WAKE_RETRY_MS, INITIAL_TERMINAL_WAKE_RETRY_MS * 2 ** Math.max(0, attemptCount - 1));
}

function isPendingTerminalEventAvailable(event: PendingTerminalEvent, now: number): boolean {
  return event.nextAttemptAt === undefined || event.nextAttemptAt <= now;
}

function terminalEventDueAt(event: PendingTerminalEvent, debounceMs: number): number {
  const debounceDueAt = event.firstObservedAt + debounceMs;
  return event.nextAttemptAt === undefined ? debounceDueAt : Math.max(debounceDueAt, event.nextAttemptAt);
}

function isPendingTerminalEventDue(event: PendingTerminalEvent, now: number, debounceMs: number): boolean {
  return isPendingTerminalEventAvailable(event, now) && terminalEventDueAt(event, debounceMs) <= now;
}

function ownerBindingsStatus(bindings: OwnerBinding[]): ControllerStatus["ownerBindings"] {
  const bySource: Record<string, number> = {};
  for (const binding of bindings) bySource[binding.source] = (bySource[binding.source] ?? 0) + 1;
  return {
    total: bindings.length,
    bySource,
    recent: bindings.slice(-20).map((binding) => ({
      cardId: binding.cardId,
      source: binding.source,
      ownerAgentId: binding.ownerAgentId,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
      inheritedFromCardId: binding.inheritedFromCardId,
    })),
  };
}

function pendingTerminalEventsStatus(events: PendingTerminalEvent[], debounceMs: number): PendingTerminalEventsStatus {
  const byOwner = new Map<string, { count: number; oldestFirstObservedAt?: number; nextDueAt?: number }>();
  for (const event of events) {
    const ownerSessionKey = event.ownerSessionKey ?? "unresolved";
    const current = byOwner.get(ownerSessionKey) ?? { count: 0 };
    const dueAt = terminalEventDueAt(event, debounceMs);
    byOwner.set(ownerSessionKey, {
      count: current.count + 1,
      oldestFirstObservedAt: current.oldestFirstObservedAt === undefined ? event.firstObservedAt : Math.min(current.oldestFirstObservedAt, event.firstObservedAt),
      nextDueAt: current.nextDueAt === undefined ? dueAt : Math.min(current.nextDueAt, dueAt),
    });
  }
  return {
    total: events.length,
    byOwner: Array.from(byOwner.entries()).map(([ownerSessionKey, value]) => ({ ownerSessionKey, ...value })),
  };
}

function terminalWakeTitle(input: { cardId?: string; card?: WorkboardCard; event?: WorkboardNotification }, card?: WorkboardCard): string | undefined {
  return optionalSessionKey(card?.title) ?? optionalSessionKey(input.card?.title) ?? optionalSessionKey(input.cardId) ?? optionalSessionKey(card?.id) ?? optionalSessionKey(input.event?.cardId);
}

function uniqueNotificationCardMatch(cards: WorkboardCard[], notificationId: string, sequence?: number): WorkboardCard | undefined {
  const matches = cards.filter((card) => cardHasNotification(card, notificationId, sequence));
  return matches.length === 1 ? matches[0] : undefined;
}

function cardHasNotification(card: WorkboardCard, notificationId: string, sequence?: number): boolean {
  const entries = cardNotificationEntries(card).filter((entry) => entry.id === notificationId);
  if (!entries.length) return false;
  if (typeof sequence !== "number" || !Number.isFinite(sequence)) return true;
  return entries.some((entry) => entry.sequence === sequence);
}

function cardNotificationEntries(card: WorkboardCard): Array<{ id?: string; sequence?: number }> {
  const metadata = asRecord(card.metadata);
  const notifications = metadata.notifications;
  if (!Array.isArray(notifications)) return [];
  return notifications.flatMap((entry) => {
    const record = asRecord(entry);
    const id = optionalSessionKey(record.id);
    if (!id) return [];
    const sequence = typeof record.sequence === "number" && Number.isFinite(record.sequence) ? record.sequence : undefined;
    return [{ id, sequence }];
  });
}

function buildTerminalWakeBatchPrompt(events: PendingTerminalEvent[]): string {
  if (events.length === 1) return buildTerminalWakePrompt(pendingEventWakeInput(events[0]));
  const lines = [
    "OpenClaw Workboard controller is waking the original owner session for a batch of terminal Workboard events.",
    "This is an owner-agent processing turn. Use the public Workboard notification/card data below as context.",
    `batchSize: ${events.length}`,
  ];
  events.forEach((event, index) => {
    lines.push(`--- terminalEvent ${index + 1} ---`);
    lines.push(buildTerminalWakePrompt(pendingEventWakeInput(event)));
  });
  lines.push(
    "Instruction: Process the batch together. Update the user only if useful, repair or retry failed/stale/blocked/start-failure items when safe, and do not duplicate Workboard dispatch or redo completed work.",
  );
  return lines.join("\n");
}

function buildTerminalWakePrompt(input: { wakeKey: string; kind: TerminalWakeKind; message: string; runId?: string; card?: WorkboardCard; event?: WorkboardNotification }): string {
  const card = input.card;
  const cardId = optionalSessionKey(card?.id) ?? optionalSessionKey(input.event?.cardId) ?? "unknown";
  const title = optionalSessionKey(card?.title) ?? "unknown";
  const lines = [
    "OpenClaw Workboard controller is waking the original owner session for a terminal Workboard event.",
    "This is an owner-agent processing turn. Use the public Workboard notification/card data below as context.",
    `eventKind: ${input.kind}`,
    `wakeKey: ${input.wakeKey}`,
    `cardId: ${cardId}`,
    `cardTitle: ${title}`,
    `summary: ${input.message || "none"}`,
  ];
  if (input.event?.id) lines.push(`eventId: ${input.event.id}`);
  if (input.event?.createdAt !== undefined) lines.push(`eventCreatedAt: ${input.event.createdAt}`);
  if (input.runId) lines.push(`runId: ${input.runId}`);
  if (card?.status) lines.push(`cardStatus: ${card.status}`);
  if (card?.boardId) lines.push(`boardId: ${card.boardId}`);
  if (card?.agentId) lines.push(`agentId: ${card.agentId}`);
  const tenant = tenantFromCard(card);
  if (tenant) lines.push(`tenant: ${tenant}`);
  lines.push(...publicResultPointers(card));
  if (input.kind === "completed") {
    lines.push(
      "Instruction: Review the terminal result, update the user only if useful, and handle any necessary follow-up.",
      "Do not duplicate Workboard dispatch and do not redo completed work. The controller may auto-dispatch next ready cards separately.",
    );
  } else {
    lines.push(
      "Instruction: Inspect the card/run, explain or repair/retry when safe, use Workboard recovery actions as appropriate, and notify the user when action or a decision is needed.",
      "Do not blindly retry infinitely, bypass maxRetries, or route work into a worker session.",
    );
  }
  return lines.join("\n");
}

function publicResultPointers(card?: WorkboardCard): string[] {
  if (!card) return ["publicPointers: none available in public notification/card data"];
  const lines: string[] = [];
  if (card.completedAt !== undefined) lines.push(`completedAt: ${card.completedAt}`);
  if (card.updatedAt !== undefined) lines.push(`updatedAt: ${card.updatedAt}`);
  const metadata = asRecord(card.metadata);
  const pointerKeys = ["summary", "completion", "result", "results", "proof", "proofs", "artifact", "artifacts", "deliverable", "deliverables", "links"];
  for (const key of pointerKeys) {
    const value = metadata[key];
    if (value !== undefined) lines.push(`public.${key}: ${compactJson(value)}`);
  }
  return lines.length ? lines : ["publicPointers: none available in public notification/card data"];
}

function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return String(value);
    return text.length > 900 ? `${text.slice(0, 897)}...` : text;
  } catch {
    return String(value);
  }
}
