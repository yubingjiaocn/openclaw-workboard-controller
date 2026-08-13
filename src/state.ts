import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type ControllerState = {
  version: 1;
  subscriptionId?: string;
  processedEventIds: string[];
  notifiedProblemIds: string[];
  lastDispatchAt?: number;
  lastTickAt?: number;
  lastError?: string;
  counters: {
    ticks: number;
    events: number;
    dispatches: number;
    wakes: number;
    errors: number;
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
    counters: { ticks: 0, events: 0, dispatches: 0, wakes: 0, errors: 0 },
  };
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
    lastError: typeof record.lastError === "string" ? record.lastError : undefined,
    counters: {
      ticks: typeof counters.ticks === "number" ? counters.ticks : 0,
      events: typeof counters.events === "number" ? counters.events : 0,
      dispatches: typeof counters.dispatches === "number" ? counters.dispatches : 0,
      wakes: typeof counters.wakes === "number" ? counters.wakes : 0,
      errors: typeof counters.errors === "number" ? counters.errors : 0,
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
