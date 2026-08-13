export type OwnerBindingSource = "owned-tool" | "core-hook" | "manual" | "inherited";

export type OwnerBinding = {
  cardId: string;
  ownerSessionKey: string;
  ownerAgentId?: string;
  source: OwnerBindingSource;
  createdAt: number;
  updatedAt?: number;
  inheritedFromCardId?: string;
};

export function optionalSessionKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isWorkboardWorkerSessionKey(sessionKey: string, cardId?: string): boolean {
  const normalized = sessionKey.toLowerCase();
  if (normalized.startsWith("subagent:") || normalized.includes(":subagent:")) return true;
  if (normalized.includes("workboard-")) return true;
  return Boolean(cardId && normalized.includes(cardId.toLowerCase()) && normalized.includes("workboard"));
}

export function isReliableExternalOwnerSessionKey(sessionKey: string, workerSessionKeys: string[] = [], cardId?: string): boolean {
  const normalized = optionalSessionKey(sessionKey);
  if (!normalized) return false;
  if (workerSessionKeys.includes(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (/^agent:[^:]+(?::main)?$/.test(lower)) return false;
  return !isWorkboardWorkerSessionKey(normalized, cardId);
}

export function agentIdFromSessionKey(sessionKey: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1];
}

