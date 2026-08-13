import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type ArchiveCandidate = {
  componentId: string;
  cardIds: string[];
  titles: Record<string, string>;
  reason: string;
  eligibleAt: number;
};

export type ArchiveFailure = {
  componentId: string;
  cardId: string;
  title?: string;
  error: string;
  at: number;
};

export type StartNotificationRecord = {
  cardId: string;
  title?: string;
  notifiedAt: number;
  target: string;
};

export type StartNotificationFailure = {
  cardId?: string;
  title?: string;
  target?: string;
  error: string;
  at: number;
};

export type TerminalWakeRecord = {
  wakeKey: string;
  kind: string;
  cardId?: string;
  title?: string;
  target: string;
  wokenAt: number;
};

export type TerminalWakeFailure = {
  wakeKey: string;
  kind: string;
  cardId?: string;
  target?: string;
  error: string;
  at: number;
};

export type PendingTerminalEvent = {
  wakeKey: string;
  kind: string;
  message: string;
  firstObservedAt: number;
  cardId?: string;
  title?: string;
  sessionKey?: string;
  runId?: string;
  ownerSessionKey?: string;
  ownerAgentId?: string;
  event?: Record<string, unknown>;
  card?: Record<string, unknown>;
  attemptCount: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  lastError?: string;
};

export type WakeFailure = {
  problemKey: string;
  kind: string;
  cardId?: string;
  target?: string;
  error: string;
  at: number;
};

export type ControllerState = {
  version: 1;
  subscriptionId?: string;
  processedEventIds: string[];
  terminalWakeIds: string[];
  notifiedProblemIds: string[];
  notifiedStartIds: string[];
  lastDispatchAt?: number;
  lastTickAt?: number;
  lastArchiveScanAt?: number;
  lastError?: string;
  archiveCandidates: ArchiveCandidate[];
  archiveLastFailures: ArchiveFailure[];
  recentStartNotifications: StartNotificationRecord[];
  startNotificationFailures: StartNotificationFailure[];
  recentTerminalWakes: TerminalWakeRecord[];
  terminalWakeFailures: TerminalWakeFailure[];
  pendingTerminalEvents: PendingTerminalEvent[];
  wakeFailures: WakeFailure[];
  counters: {
    ticks: number;
    events: number;
    dispatches: number;
    wakes: number;
    wakeErrors: number;
    terminalWakes: number;
    terminalWakeErrors: number;
    errors: number;
    archiveScans: number;
    archiveCandidates: number;
    archiveActions: number;
    archiveErrors: number;
    startNotifications: number;
    startNotificationErrors: number;
    terminalEventsQueued: number;
    terminalWakeBatches: number;
    terminalWakeBatchErrors: number;
  };
};

export type StateStore = {
  path: string;
  load(): Promise<ControllerState>;
  save(state: ControllerState): Promise<void>;
};

export function emptyState(): ControllerState {
  return {
    version: 1,
    processedEventIds: [],
    notifiedProblemIds: [],
    terminalWakeIds: [],
    notifiedStartIds: [],
    archiveCandidates: [],
    archiveLastFailures: [],
    recentStartNotifications: [],
    startNotificationFailures: [],
    recentTerminalWakes: [],
    terminalWakeFailures: [],
    pendingTerminalEvents: [],
    wakeFailures: [],
    counters: { ticks: 0, events: 0, dispatches: 0, wakes: 0, wakeErrors: 0, terminalWakes: 0, terminalWakeErrors: 0, errors: 0, archiveScans: 0, archiveCandidates: 0, archiveActions: 0, archiveErrors: 0, startNotifications: 0, startNotificationErrors: 0, terminalEventsQueued: 0, terminalWakeBatches: 0, terminalWakeBatchErrors: 0 },
  };
}


function normalizeArchiveCandidates(value: unknown): ArchiveCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ArchiveCandidate[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const componentId = typeof record.componentId === "string" ? record.componentId : undefined;
    const cardIds = Array.isArray(record.cardIds) ? record.cardIds.filter((id): id is string => typeof id === "string") : [];
    const titlesRecord = record.titles && typeof record.titles === "object" && !Array.isArray(record.titles) ? (record.titles as Record<string, unknown>) : {};
    const titles = Object.fromEntries(Object.entries(titlesRecord).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const reason = typeof record.reason === "string" ? record.reason : undefined;
    const eligibleAt = typeof record.eligibleAt === "number" && Number.isFinite(record.eligibleAt) ? record.eligibleAt : undefined;
    if (!componentId || !cardIds.length || !reason || eligibleAt === undefined) return [];
    return [{ componentId, cardIds, titles, reason, eligibleAt }];
  }).slice(0, 50);
}

function normalizeArchiveFailures(value: unknown): ArchiveFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ArchiveFailure[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const componentId = typeof record.componentId === "string" ? record.componentId : undefined;
    const cardId = typeof record.cardId === "string" ? record.cardId : undefined;
    const title = typeof record.title === "string" ? record.title : undefined;
    const error = typeof record.error === "string" ? record.error : undefined;
    const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : undefined;
    if (!componentId || !cardId || !error || at === undefined) return [];
    return [{ componentId, cardId, title, error, at }];
  }).slice(-50);
}

function normalizeStartNotifications(value: unknown): StartNotificationRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): StartNotificationRecord[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const cardId = typeof record.cardId === "string" ? record.cardId : undefined;
    const title = typeof record.title === "string" ? record.title : undefined;
    const notifiedAt = typeof record.notifiedAt === "number" && Number.isFinite(record.notifiedAt) ? record.notifiedAt : undefined;
    const target = typeof record.target === "string" ? record.target : undefined;
    if (!cardId || notifiedAt === undefined || !target) return [];
    return [{ cardId, title, notifiedAt, target }];
  }).slice(-50);
}

function normalizeStartNotificationFailures(value: unknown): StartNotificationFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): StartNotificationFailure[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const cardId = typeof record.cardId === "string" ? record.cardId : undefined;
    const title = typeof record.title === "string" ? record.title : undefined;
    const target = typeof record.target === "string" ? record.target : undefined;
    const error = typeof record.error === "string" ? record.error : undefined;
    const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : undefined;
    if (!error || at === undefined) return [];
    return [{ cardId, title, target, error, at }];
  }).slice(-50);
}

function normalizeTerminalWakes(value: unknown): TerminalWakeRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TerminalWakeRecord[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const wakeKey = typeof record.wakeKey === "string" ? record.wakeKey : undefined;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const cardId = typeof record.cardId === "string" ? record.cardId : undefined;
    const title = typeof record.title === "string" ? record.title : undefined;
    const target = typeof record.target === "string" ? record.target : undefined;
    const wokenAt = typeof record.wokenAt === "number" && Number.isFinite(record.wokenAt) ? record.wokenAt : undefined;
    if (!wakeKey || !kind || !target || wokenAt === undefined) return [];
    return [{ wakeKey, kind, cardId, title, target, wokenAt }];
  }).slice(-50);
}

function normalizeTerminalWakeFailures(value: unknown): TerminalWakeFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TerminalWakeFailure[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const wakeKey = typeof record.wakeKey === "string"
      ? record.wakeKey
      : typeof record.problemKey === "string"
        ? record.problemKey
        : undefined;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const cardId = typeof record.cardId === "string" ? record.cardId : undefined;
    const target = typeof record.target === "string" ? record.target : undefined;
    const error = typeof record.error === "string" ? record.error : undefined;
    const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : undefined;
    if (!wakeKey || !kind || !error || at === undefined) return [];
    return [{ wakeKey, kind, cardId, target, error, at }];
  }).slice(-50);
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizePendingTerminalEvents(value: unknown): PendingTerminalEvent[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items = value.flatMap((entry): PendingTerminalEvent[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const wakeKey = typeof record.wakeKey === "string" ? record.wakeKey : undefined;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const message = typeof record.message === "string" ? record.message : "";
    const firstObservedAt = typeof record.firstObservedAt === "number" && Number.isFinite(record.firstObservedAt) ? record.firstObservedAt : undefined;
    if (!wakeKey || !kind || firstObservedAt === undefined || seen.has(wakeKey)) return [];
    seen.add(wakeKey);
    const item: PendingTerminalEvent = {
      wakeKey,
      kind,
      message,
      firstObservedAt,
      cardId: typeof record.cardId === "string" ? record.cardId : undefined,
      title: typeof record.title === "string" ? record.title : undefined,
      sessionKey: typeof record.sessionKey === "string" ? record.sessionKey : undefined,
      runId: typeof record.runId === "string" ? record.runId : undefined,
      ownerSessionKey: typeof record.ownerSessionKey === "string" ? record.ownerSessionKey : undefined,
      ownerAgentId: typeof record.ownerAgentId === "string" ? record.ownerAgentId : undefined,
      event: normalizeRecord(record.event),
      card: normalizeRecord(record.card),
      attemptCount: typeof record.attemptCount === "number" && Number.isFinite(record.attemptCount) ? Math.max(0, Math.trunc(record.attemptCount)) : 0,
      lastAttemptAt: typeof record.lastAttemptAt === "number" && Number.isFinite(record.lastAttemptAt) ? record.lastAttemptAt : undefined,
      nextAttemptAt: typeof record.nextAttemptAt === "number" && Number.isFinite(record.nextAttemptAt) ? record.nextAttemptAt : undefined,
      lastError: typeof record.lastError === "string" ? record.lastError : undefined,
    };
    return [item];
  });
  return items.slice(-1000);
}

function normalizeWakeFailures(value: unknown): WakeFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): WakeFailure[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const problemKey = typeof record.problemKey === "string" ? record.problemKey : undefined;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const cardId = typeof record.cardId === "string" ? record.cardId : undefined;
    const target = typeof record.target === "string" ? record.target : undefined;
    const error = typeof record.error === "string" ? record.error : undefined;
    const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : undefined;
    if (!problemKey || !kind || !error || at === undefined) return [];
    return [{ problemKey, kind, cardId, target, error, at }];
  }).slice(-50);
}

function normalizeState(raw: unknown): ControllerState {
  const fallback = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const record = raw as Record<string, unknown>;
  const counters = record.counters && typeof record.counters === "object" && !Array.isArray(record.counters)
    ? (record.counters as Record<string, unknown>)
    : {};
  const legacyProblemIds = Array.isArray(record.notifiedProblemIds) ? record.notifiedProblemIds.filter((v): v is string => typeof v === "string").slice(-1000) : [];
  const terminalWakeIds = Array.isArray(record.terminalWakeIds)
    ? record.terminalWakeIds.filter((v): v is string => typeof v === "string").slice(-1000)
    : legacyProblemIds;
  const wakeFailures = normalizeWakeFailures(record.wakeFailures);
  return {
    version: 1,
    subscriptionId: typeof record.subscriptionId === "string" ? record.subscriptionId : undefined,
    processedEventIds: Array.isArray(record.processedEventIds) ? record.processedEventIds.filter((v): v is string => typeof v === "string").slice(-1000) : [],
    terminalWakeIds,
    notifiedProblemIds: legacyProblemIds,
    notifiedStartIds: Array.isArray(record.notifiedStartIds) ? record.notifiedStartIds.filter((v): v is string => typeof v === "string").slice(-1000) : [],
    lastDispatchAt: typeof record.lastDispatchAt === "number" ? record.lastDispatchAt : undefined,
    lastTickAt: typeof record.lastTickAt === "number" ? record.lastTickAt : undefined,
    lastArchiveScanAt: typeof record.lastArchiveScanAt === "number" ? record.lastArchiveScanAt : undefined,
    lastError: typeof record.lastError === "string" ? record.lastError : undefined,
    archiveCandidates: normalizeArchiveCandidates(record.archiveCandidates),
    archiveLastFailures: normalizeArchiveFailures(record.archiveLastFailures),
    recentStartNotifications: normalizeStartNotifications(record.recentStartNotifications),
    startNotificationFailures: normalizeStartNotificationFailures(record.startNotificationFailures),
    recentTerminalWakes: normalizeTerminalWakes(record.recentTerminalWakes),
    terminalWakeFailures: normalizeTerminalWakeFailures(record.terminalWakeFailures ?? record.wakeFailures),
    pendingTerminalEvents: normalizePendingTerminalEvents(record.pendingTerminalEvents),
    wakeFailures,
    counters: {
      ticks: typeof counters.ticks === "number" ? counters.ticks : 0,
      events: typeof counters.events === "number" ? counters.events : 0,
      dispatches: typeof counters.dispatches === "number" ? counters.dispatches : 0,
      wakes: typeof counters.wakes === "number" ? counters.wakes : 0,
      wakeErrors: typeof counters.wakeErrors === "number" ? counters.wakeErrors : 0,
      terminalWakes: typeof counters.terminalWakes === "number" ? counters.terminalWakes : (typeof counters.wakes === "number" ? counters.wakes : 0),
      terminalWakeErrors: typeof counters.terminalWakeErrors === "number" ? counters.terminalWakeErrors : (typeof counters.wakeErrors === "number" ? counters.wakeErrors : 0),
      errors: typeof counters.errors === "number" ? counters.errors : 0,
      archiveScans: typeof counters.archiveScans === "number" ? counters.archiveScans : 0,
      archiveCandidates: typeof counters.archiveCandidates === "number" ? counters.archiveCandidates : 0,
      archiveActions: typeof counters.archiveActions === "number" ? counters.archiveActions : 0,
      archiveErrors: typeof counters.archiveErrors === "number" ? counters.archiveErrors : 0,
      startNotifications: typeof counters.startNotifications === "number" ? counters.startNotifications : 0,
      startNotificationErrors: typeof counters.startNotificationErrors === "number" ? counters.startNotificationErrors : 0,
      terminalEventsQueued: typeof counters.terminalEventsQueued === "number" ? counters.terminalEventsQueued : 0,
      terminalWakeBatches: typeof counters.terminalWakeBatches === "number" ? counters.terminalWakeBatches : 0,
      terminalWakeBatchErrors: typeof counters.terminalWakeBatchErrors === "number" ? counters.terminalWakeBatchErrors : 0,
    },
  };
}

export function createFileStateStore(stateDir: string): StateStore {
  const dataDir = path.join(stateDir, "workboard-controller");
  const filePath = path.join(dataDir, "state.json");
  return {
    path: filePath,
    async load() {
      try {
        return normalizeState(JSON.parse(await readFile(filePath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
        throw error;
      }
    },
    async save(state) {
      await mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tmpPath, filePath);
    },
  };
}

export function rememberBounded(items: string[], id: string, max = 1000): string[] {
  if (items.includes(id)) return items;
  return [...items, id].slice(-max);
}
