export const WORKBOARD_DISPATCH_ROUTE_PATH = "/plugins/workboard-controller/workboard-dispatch";

export type WorkboardDispatchRequestBody = {
  boardId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function normalizeWorkboardDispatchRequestBody(value: unknown): WorkboardDispatchRequestBody {
  const record = asRecord(value);
  if (!record) throw new Error("request body must be an object");

  const allowedKeys = new Set(["boardId"]);
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) throw new Error(`unsupported request field: ${unknownKeys[0]}`);

  if (!Object.hasOwn(record, "boardId")) return {};
  const boardId = record.boardId;
  if (typeof boardId !== "string" || !boardId.trim()) throw new Error("boardId must be a non-empty string when provided");
  return { boardId: boardId.trim() };
}
