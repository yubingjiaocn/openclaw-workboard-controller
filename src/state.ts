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

export type ControllerState = {
  version: 1;
  subscriptionId?: string;
  processedEventIds: string[];
  notifiedProblemIds: string[];
  lastDispatchAt?: number;
  lastTickAt?: number;
  lastArchiveScanAt?: number;
  lastError?: string;
  archiveCandidates: ArchiveCandidate[];
  archiveLastFailures: ArchiveFailure[];
  counters: {
    ticks: number;
    events: number;
    dispatches: number;
    wakes: number;
    errors: number;
    archiveScans: number;
    archiveCandidates: number;
    archiveActions: number;
    archiveErrors: number;
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
    archiveCandidates: [],
    archiveLastFailures: [],
    counters: { ticks: 0, events: 0, dispatches: 0, wakes: 0, errors: 0, archiveScans: 0, archiveCandidates: 0, archiveActions: 0, archiveErrors: 0 },
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

function normalizeState(raw: unknown): ControllerState {
  const fallback = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const record = raw as Record<string, unknown>;
  const counters = record.counters && typeof record.counters === "object" && !Array.isArray(record.counters)
    ? (record.counters as Record<string, unknown>)
    : {};
  return {
    version: 1,
    subscriptionId: typeof record.subscriptionId === "string" ? record.subscriptionId : undefined,
    processedEventIds: Array.isArray(record.processedEventIds) ? record.processedEventIds.filter((v): v is string => typeof v === "string").slice(-1000) : [],
    notifiedProblemIds: Array.isArray(record.notifiedProblemIds) ? record.notifiedProblemIds.filter((v): v is string => typeof v === "string").slice(-1000) : [],
    lastDispatchAt: typeof record.lastDispatchAt === "number" ? record.lastDispatchAt : undefined,
    lastTickAt: typeof record.lastTickAt === "number" ? record.lastTickAt : undefined,
    lastArchiveScanAt: typeof record.lastArchiveScanAt === "number" ? record.lastArchiveScanAt : undefined,
    lastError: typeof record.lastError === "string" ? record.lastError : undefined,
    archiveCandidates: normalizeArchiveCandidates(record.archiveCandidates),
    archiveLastFailures: normalizeArchiveFailures(record.archiveLastFailures),
    counters: {
      ticks: typeof counters.ticks === "number" ? counters.ticks : 0,
      events: typeof counters.events === "number" ? counters.events : 0,
      dispatches: typeof counters.dispatches === "number" ? counters.dispatches : 0,
      wakes: typeof counters.wakes === "number" ? counters.wakes : 0,
      errors: typeof counters.errors === "number" ? counters.errors : 0,
      archiveScans: typeof counters.archiveScans === "number" ? counters.archiveScans : 0,
      archiveCandidates: typeof counters.archiveCandidates === "number" ? counters.archiveCandidates : 0,
      archiveActions: typeof counters.archiveActions === "number" ? counters.archiveActions : 0,
      archiveErrors: typeof counters.archiveErrors === "number" ? counters.archiveErrors : 0,
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
