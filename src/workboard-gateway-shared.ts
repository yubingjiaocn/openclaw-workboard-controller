export const WORKBOARD_LIST_ROUTE_PATH = "/plugins/workboard-controller/workboard-list";
export const WORKBOARD_ARCHIVE_ROUTE_PATH = "/plugins/workboard-controller/workboard-archive";

export type WorkboardListRequestBody = {
  boardId?: string;
};

export type WorkboardArchiveRequestBody = {
  id: string;
  archived?: boolean;
};

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
