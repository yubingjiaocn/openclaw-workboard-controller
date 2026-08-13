import { randomUUID } from "node:crypto";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { computeArchiveCandidates, type WorkboardArchiveCard } from "./archive.js";
import type { ControllerConfig, OwnerRoute } from "./config.js";
import { assertCompatibleOpenClawVersion } from "./config.js";
import type { GatewayMethodClient } from "./gateway-method-client.js";
import { errorMessage } from "./gateway-method-client.js";
import type { ArchiveFailure, ControllerState, StartNotificationFailure, StateStore, TerminalWakeFailure, TerminalWakeRecord } from "./state.js";
import { rememberBounded } from "./state.js";

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
  | { status: "target"; sessionKey: string; agentId: string; source: "ownerRoutes" | "legacy-startNotifySessionKey" | "legacy-wakeFallbackSessionKey" }
  | { status: "rejected"; error: string; target?: string }
  | { status: "none" };

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
  wakeFailures: ControllerState["wakeFailures"];
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
      counters: state?.counters ?? { ticks: 0, events: 0, dispatches: 0, wakes: 0, wakeErrors: 0, terminalWakes: 0, terminalWakeErrors: 0, errors: 0, archiveScans: 0, archiveCandidates: 0, archiveActions: 0, archiveErrors: 0, startNotifications: 0, startNotificationErrors: 0 },
      archiveCandidates: state?.archiveCandidates ?? [],
      archiveLastFailures: state?.archiveLastFailures ?? [],
      recentStartNotifications: state?.recentStartNotifications ?? [],
      startNotificationFailures: state?.startNotificationFailures ?? [],
      recentTerminalWakes: state?.recentTerminalWakes ?? [],
      terminalWakeFailures: state?.terminalWakeFailures ?? [],
      wakeFailures: state?.wakeFailures ?? [],
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
    await this.wakeTerminalOwner({
      wakeKey: terminalWakeKeyForEvent(event),
      kind: event.kind,
      message: event.message,
      cardId: event.cardId,
      sessionKey: event.sessionKey,
      runId: event.runId,
      event,
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
      await this.wakeTerminalOwner({
        wakeKey: `blocked:${card.id}:${card.updatedAt ?? card.status ?? "unknown"}`,
        kind: "blocked",
        message: `Workboard card blocked during dispatch (${reason}): ${card.title ?? card.id}`,
        card,
      });
    }
    for (const failure of result.startFailures ?? []) {
      await this.wakeTerminalOwner({
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
    if (this.options.config.ownerRoutes.length) {
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

  private resolveStartNotificationTarget(started: StartedWorkboardCard, card?: WorkboardCard): OwnerTargetResolution {
    const cardId = startedCardId(started) ?? card?.id;
    const context = this.ownerRouteContext({ started, card });
    const routeTarget = this.resolveConfiguredOwnerRoute(context, workerSessionKeys({ started, card }), cardId);
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

  private async wakeTerminalOwner(input: {
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

    const contextResult = await this.resolveProblemCardContext(input);
    const card = contextResult.card;
    const cardId = input.cardId ?? card?.id;
    const title = terminalWakeTitle(input, card);
    const target = this.resolveTerminalWakeTarget(input, card);
    if (target.status !== "target") {
      const error = target.status === "rejected"
        ? target.error
        : contextResult.lookupError
          ? `could not resolve owner route after workboard.cards.list failed: ${contextResult.lookupError}`
          : "could not resolve a reliable owner route; configure ownerRoutes with the original owner sessionKey";
      await this.recordTerminalWakeFailure({ wakeKey: input.wakeKey, kind: input.kind, cardId, target: target.status === "rejected" ? target.target : undefined, error, at: Date.now() });
      return;
    }

    const workspaceDir = this.options.runtimeAgent.resolveAgentWorkspaceDir(this.options.fullConfig, target.agentId);
    const timeoutMs = this.options.config.wakeTimeoutMs || this.options.runtimeAgent.resolveAgentTimeoutMs({ cfg: this.options.fullConfig });
    const prompt = buildTerminalWakePrompt({ ...input, card });
    try {
      await this.options.runtimeAgent.runEmbeddedAgent({
        // sessionId is a transcript identifier, not the owner routing sessionKey.
        sessionId: randomUUID(),
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        workspaceDir,
        config: this.options.fullConfig,
        prompt,
        trigger: "manual",
        runId: randomUUID(),
        timeoutMs,
        ...(this.options.config.wakeToolsAllow ? { toolsAllow: this.options.config.wakeToolsAllow } : {}),
      });
      const record: TerminalWakeRecord = { wakeKey: input.wakeKey, kind: input.kind, cardId, title, target: target.sessionKey, wokenAt: Date.now() };
      state.terminalWakeIds = rememberBounded(state.terminalWakeIds, input.wakeKey);
      if (input.kind !== "completed") state.notifiedProblemIds = rememberBounded(state.notifiedProblemIds, input.wakeKey);
      state.recentTerminalWakes = [...state.recentTerminalWakes, record].slice(-50);
      state.counters.terminalWakes += 1;
      state.counters.wakes += 1;
      if (state.lastError?.startsWith("terminal wake failed") || state.lastError?.startsWith("problem wake failed")) state.lastError = undefined;
      await this.save();
    } catch (error) {
      await this.recordTerminalWakeFailure({ wakeKey: input.wakeKey, kind: input.kind, cardId, target: target.sessionKey, error: errorMessage(error), at: Date.now() });
    }
  }

  private resolveTerminalWakeTarget(input: { cardId?: string; sessionKey?: string; runId?: string; card?: WorkboardCard }, card?: WorkboardCard): OwnerTargetResolution {
    const cardId = input.cardId ?? card?.id ?? input.card?.id;
    const context = this.ownerRouteContext({ card: card ?? input.card });
    const eventSessionKey = optionalSessionKey(input.sessionKey);
    const workerKeys = workerSessionKeys({
      card: card ?? input.card,
      extra: eventSessionKey && isWorkboardWorkerSessionKey(eventSessionKey, cardId) ? [eventSessionKey] : [],
    });
    return this.resolveConfiguredOwnerRoute(context, workerKeys, cardId);
  }

  private async recordTerminalWakeFailure(failure: TerminalWakeFailure): Promise<void> {
    const state = await this.requireState();
    state.terminalWakeFailures = [...state.terminalWakeFailures, failure].slice(-50);
    state.wakeFailures = [...state.wakeFailures, { problemKey: failure.wakeKey, kind: failure.kind, cardId: failure.cardId, target: failure.target, error: failure.error, at: failure.at }].slice(-50);
    state.terminalWakeIds = rememberBounded(state.terminalWakeIds, failure.wakeKey);
    if (failure.kind !== "completed") state.notifiedProblemIds = rememberBounded(state.notifiedProblemIds, failure.wakeKey);
    state.lastError = `terminal wake failed${failure.cardId ? ` for ${failure.cardId}` : ""}: ${failure.error}`;
    state.counters.terminalWakeErrors += 1;
    state.counters.wakeErrors += 1;
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

  private async resolveProblemCardContext(input: { cardId?: string; sessionKey?: string; runId?: string; card?: WorkboardCard }): Promise<{ card?: WorkboardCard; lookupError?: string }> {
    if (input.card) return { card: input.card };
    const cardId = optionalSessionKey(input.cardId);
    const runId = optionalSessionKey(input.runId);
    const sessionKey = optionalSessionKey(input.sessionKey);
    if (!cardId && !runId && !sessionKey) return {};
    try {
      const payload = await this.options.gateway.request<WorkboardListPayload>("workboard.cards.list", { boardId: this.options.config.boardId });
      const cards = payload.cards ?? [];
      const card = cards.find((candidate) => {
        if (cardId && candidate.id === cardId) return true;
        if (runId && (candidate.runId === runId || candidate.execution?.runId === runId)) return true;
        if (sessionKey && (candidate.sessionKey === sessionKey || candidate.execution?.sessionKey === sessionKey)) return true;
        return false;
      });
      return { card };
    } catch (error) {
      return { lookupError: errorMessage(error) };
    }
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

function isWorkboardWorkerSessionKey(sessionKey: string, cardId?: string): boolean {
  const normalized = sessionKey.toLowerCase();
  if (normalized.startsWith("subagent:") || normalized.includes(":subagent:")) return true;
  if (normalized.includes("workboard-")) return true;
  return Boolean(cardId && normalized.includes(cardId.toLowerCase()) && normalized.includes("workboard"));
}

function isReliableExternalOwnerSessionKey(sessionKey: string, workerSessionKeys: string[] = [], cardId?: string): boolean {
  const normalized = optionalSessionKey(sessionKey);
  if (!normalized) return false;
  if (workerSessionKeys.includes(normalized)) return false;
  return !isWorkboardWorkerSessionKey(normalized, cardId);
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

function terminalWakeTitle(input: { cardId?: string; card?: WorkboardCard; event?: WorkboardNotification }, card?: WorkboardCard): string | undefined {
  return optionalSessionKey(card?.title) ?? optionalSessionKey(input.card?.title) ?? optionalSessionKey(input.cardId) ?? optionalSessionKey(card?.id) ?? optionalSessionKey(input.event?.cardId);
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
