import type { ArchiveCandidate } from "./state.js";

export type WorkboardArchiveProof = {
  status?: string;
};

export type WorkboardArchiveLink = {
  type?: string;
  targetCardId?: string;
};

export type WorkboardArchiveEvent = {
  kind?: string;
  at?: number;
  toStatus?: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardArchiveAttempt = {
  status?: string;
  endedAt?: number;
};

export type WorkboardArchiveCard = {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: number;
  completedAt?: number;
  events?: WorkboardArchiveEvent[];
  execution?: { status?: string; updatedAt?: number; startedAt?: number };
  metadata?: {
    archivedAt?: number;
    links?: WorkboardArchiveLink[];
    proof?: WorkboardArchiveProof[];
    stale?: unknown;
    attempts?: WorkboardArchiveAttempt[];
  };
};

export type ArchivePlanOptions = {
  now: number;
  completedGraphAfterMs: number;
  standaloneAfterMs: number;
  requireProof: boolean;
  maxCandidates?: number;
};

const BLOCKING_STATUSES = new Set(["todo", "ready", "running", "blocked", "failed", "stale"]);
const DEPENDENCY_LINK_TYPES = new Set(["parent", "child"]);

function isArchived(card: WorkboardArchiveCard): boolean {
  return typeof card.metadata?.archivedAt === "number" && card.metadata.archivedAt > 0;
}

function dependencyTargets(card: WorkboardArchiveCard): string[] {
  const targets = card.metadata?.links?.flatMap((link) => {
    if (!DEPENDENCY_LINK_TYPES.has(link.type ?? "")) return [];
    return link.targetCardId ? [link.targetCardId] : [];
  }) ?? [];
  return Array.from(new Set(targets));
}

function latestDoneEventAt(card: WorkboardArchiveCard): number | undefined {
  for (let index = (card.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = card.events?.[index];
    if ((event?.kind === "moved" || event?.kind === "created") && event.toStatus === "done" && typeof event.at === "number" && Number.isFinite(event.at)) return event.at;
  }
  return undefined;
}

function latestSucceededAttemptEndedAt(card: WorkboardArchiveCard): number | undefined {
  for (let index = (card.metadata?.attempts?.length ?? 0) - 1; index >= 0; index -= 1) {
    const attempt = card.metadata?.attempts?.[index];
    if (attempt?.status === "succeeded" && typeof attempt.endedAt === "number" && Number.isFinite(attempt.endedAt)) return attempt.endedAt;
  }
  return undefined;
}

export function terminalTime(card: WorkboardArchiveCard): number | undefined {
  if (card.status !== "done") return undefined;
  const candidates = [
    card.completedAt,
    latestDoneEventAt(card),
    card.execution?.status === "done" ? card.execution.updatedAt : undefined,
    latestSucceededAttemptEndedAt(card),
    card.updatedAt,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return candidates.length ? Math.max(...candidates) : undefined;
}

function hasRequiredProof(card: WorkboardArchiveCard, requireProof: boolean): boolean {
  if (!requireProof) return true;
  return Boolean(card.metadata?.proof?.some((proof) => proof.status !== "failed"));
}

function componentIdFor(cards: WorkboardArchiveCard[], standalone: boolean): string {
  const ids = cards.map((card) => card.id).sort();
  return `${standalone ? "standalone" : "component"}:${ids[0]}`;
}

function buildComponents(cards: WorkboardArchiveCard[]): WorkboardArchiveCard[][] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const edges = new Map<string, Set<string>>();
  for (const card of cards) {
    const set = edges.get(card.id) ?? new Set<string>();
    edges.set(card.id, set);
    for (const targetId of dependencyTargets(card)) {
      if (!byId.has(targetId)) continue;
      set.add(targetId);
      const reverse = edges.get(targetId) ?? new Set<string>();
      reverse.add(card.id);
      edges.set(targetId, reverse);
    }
  }

  const visited = new Set<string>();
  const components: WorkboardArchiveCard[][] = [];
  for (const card of cards) {
    if (visited.has(card.id)) continue;
    const stack = [card.id];
    const component: WorkboardArchiveCard[] = [];
    visited.add(card.id);
    while (stack.length) {
      const id = stack.pop();
      if (!id) continue;
      const current = byId.get(id);
      if (!current) continue;
      component.push(current);
      for (const nextId of edges.get(id) ?? []) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        stack.push(nextId);
      }
    }
    components.push(component);
  }
  return components;
}

function isStandaloneComponent(component: WorkboardArchiveCard[]): boolean {
  return component.length === 1 && dependencyTargets(component[0]!).length === 0;
}

export function computeArchiveCandidates(cards: WorkboardArchiveCard[], options: ArchivePlanOptions): ArchiveCandidate[] {
  const candidates: ArchiveCandidate[] = [];
  const knownIds = new Set(cards.map((card) => card.id));
  const maxCandidates = options.maxCandidates ?? 50;
  for (const component of buildComponents(cards)) {
    if (component.some((card) => dependencyTargets(card).some((targetId) => !knownIds.has(targetId)))) continue;
    const unarchived = component.filter((card) => !isArchived(card));
    if (!unarchived.length) continue;
    if (component.some((card) => card.metadata?.stale)) continue;
    if (component.some((card) => BLOCKING_STATUSES.has(card.status ?? ""))) continue;
    if (component.some((card) => card.status !== "done")) continue;
    if (component.some((card) => !hasRequiredProof(card, options.requireProof))) continue;

    const terminalTimes = component.map(terminalTime);
    if (terminalTimes.some((value) => value === undefined)) continue;

    const standalone = isStandaloneComponent(component);
    const threshold = standalone ? options.standaloneAfterMs : options.completedGraphAfterMs;
    const eligibleAt = Math.max(...(terminalTimes as number[])) + threshold;
    if (options.now < eligibleAt) continue;

    const titles: Record<string, string> = {};
    for (const card of unarchived) titles[card.id] = card.title ?? card.id;
    candidates.push({
      componentId: componentIdFor(component, standalone),
      cardIds: unarchived.map((card) => card.id).sort(),
      titles,
      reason: standalone ? "standalone_done_cooldown_elapsed" : "component_all_done_cooldown_elapsed",
      eligibleAt,
    });
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}
