export const WORKBOARD_LIST_ROUTE_PATH = "/plugins/workboard-controller/workboard-list";
export const WORKBOARD_ARCHIVE_ROUTE_PATH = "/plugins/workboard-controller/workboard-archive";
export const WORKBOARD_CREATE_ROUTE_PATH = "/plugins/workboard-controller/workboard-create";

export type WorkboardListRequestBody = {
  boardId?: string;
};

export type WorkboardArchiveRequestBody = {
  id: string;
  archived?: boolean;
};

export type WorkboardCreateRequestBody = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowedKeys: Set<string>): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) throw new Error(`unsupported request field: ${unknownKeys[0]}`);
}

export function normalizeWorkboardListRequestBody(value: unknown): WorkboardListRequestBody {
  const record = asRecord(value);
  if (!record) throw new Error("request body must be an object");
  rejectUnknownKeys(record, new Set(["boardId"]));
  if (!Object.hasOwn(record, "boardId")) return {};
  const boardId = record.boardId;
  if (typeof boardId !== "string" || !boardId.trim()) throw new Error("boardId must be a non-empty string when provided");
  return { boardId: boardId.trim() };
}

export function normalizeWorkboardArchiveRequestBody(value: unknown): WorkboardArchiveRequestBody {
  const record = asRecord(value);
  if (!record) throw new Error("request body must be an object");
  rejectUnknownKeys(record, new Set(["id", "archived"]));
  const id = record.id;
  if (typeof id !== "string" || !id.trim()) throw new Error("id must be a non-empty string");
  const archived = record.archived;
  if (archived !== undefined && typeof archived !== "boolean") throw new Error("archived must be a boolean when provided");
  return { id: id.trim(), ...(archived !== undefined ? { archived } : {}) };
}

const WORKBOARD_CREATE_ALLOWED_KEYS = new Set([
  "title",
  "notes",
  "status",
  "priority",
  "labels",
  "agentId",
  "parents",
  "token",
  "tenant",
  "boardId",
  "createdByCardId",
  "idempotencyKey",
  "skills",
  "workspace",
  "maxRuntimeSeconds",
  "maxRetries",
  "scheduledAt",
  "sessionKey",
]);

function optionalTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(key + " must be a non-empty string when provided");
  return value.trim();
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(key + " must be an array of strings when provided");
  return value;
}

function optionalNumberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(key + " must be a finite number when provided");
  return value;
}

function normalizeWorkspace(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) throw new Error("workspace must be an object when provided");
  rejectUnknownKeys(record, new Set(["kind", "path", "branch"]));
  const kind = optionalTrimmedString(record, "kind");
  if (!kind) throw new Error("workspace.kind must be a non-empty string");
  const path = optionalTrimmedString(record, "path");
  const branch = optionalTrimmedString(record, "branch");
  return { kind, ...(path ? { path } : {}), ...(branch ? { branch } : {}) };
}

export function normalizeWorkboardCreateRequestBody(value: unknown): WorkboardCreateRequestBody {
  const record = asRecord(value);
  if (!record) throw new Error("request body must be an object");
  rejectUnknownKeys(record, WORKBOARD_CREATE_ALLOWED_KEYS);
  const title = optionalTrimmedString(record, "title");
  if (!title) throw new Error("title must be a non-empty string");
  const workspace = normalizeWorkspace(record.workspace);
  return {
    title,
    ...(optionalTrimmedString(record, "notes") ? { notes: optionalTrimmedString(record, "notes") } : {}),
    ...(optionalTrimmedString(record, "status") ? { status: optionalTrimmedString(record, "status") } : {}),
    ...(optionalTrimmedString(record, "priority") ? { priority: optionalTrimmedString(record, "priority") } : {}),
    ...(optionalStringArray(record, "labels") ? { labels: optionalStringArray(record, "labels") } : {}),
    ...(optionalTrimmedString(record, "agentId") !== undefined ? { agentId: optionalTrimmedString(record, "agentId") } : {}),
    ...(optionalStringArray(record, "parents") ? { parents: optionalStringArray(record, "parents") } : {}),
    ...(optionalTrimmedString(record, "token") ? { token: optionalTrimmedString(record, "token") } : {}),
    ...(optionalTrimmedString(record, "tenant") ? { tenant: optionalTrimmedString(record, "tenant") } : {}),
    ...(optionalTrimmedString(record, "boardId") ? { boardId: optionalTrimmedString(record, "boardId") } : {}),
    ...(optionalTrimmedString(record, "createdByCardId") ? { createdByCardId: optionalTrimmedString(record, "createdByCardId") } : {}),
    ...(optionalTrimmedString(record, "idempotencyKey") ? { idempotencyKey: optionalTrimmedString(record, "idempotencyKey") } : {}),
    ...(optionalStringArray(record, "skills") ? { skills: optionalStringArray(record, "skills") } : {}),
    ...(workspace ? { workspace } : {}),
    ...(optionalNumberValue(record, "maxRuntimeSeconds") !== undefined ? { maxRuntimeSeconds: optionalNumberValue(record, "maxRuntimeSeconds") } : {}),
    ...(optionalNumberValue(record, "maxRetries") !== undefined ? { maxRetries: optionalNumberValue(record, "maxRetries") } : {}),
    ...(optionalNumberValue(record, "scheduledAt") !== undefined ? { scheduledAt: optionalNumberValue(record, "scheduledAt") } : {}),
    ...(optionalTrimmedString(record, "sessionKey") ? { sessionKey: optionalTrimmedString(record, "sessionKey") } : {}),
  };
}
