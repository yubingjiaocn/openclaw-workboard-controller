import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod, type GatewayMethodDispatchResponse } from "openclaw/plugin-sdk/gateway-method-runtime";
import { normalizeWorkboardDispatchRequestBody } from "./workboard-dispatch-shared.js";
import { errorMessage } from "./gateway-method-client.js";

type DispatchGatewayMethod = typeof dispatchGatewayMethod;

const MAX_BODY_BYTES = 8 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  sendJson(res, status, { ok: false, error: { type, message } });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_BODY_BYTES) throw new HttpInputError(413, "payload_too_large", "Payload too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) throw new HttpInputError(400, "invalid_request", "request body must be JSON");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpInputError(400, "invalid_request", "request body must be valid JSON");
  }
}

class HttpInputError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

function statusForDispatchResponse(response: GatewayMethodDispatchResponse): number {
  if (response.ok) return 200;
  const code = response.error?.code;
  if (code === "unauthorized" || code === "forbidden") return 403;
  if (code === "not_found") return 404;
  if (response.error?.retryable) return 503;
  return 502;
}

export function createWorkboardDispatchRouteHandler(dispatch: DispatchGatewayMethod = dispatchGatewayMethod) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      res.setHeader("allow", "POST");
      sendError(res, 405, "method_not_allowed", "Method Not Allowed");
      return true;
    }

    let params: ReturnType<typeof normalizeWorkboardDispatchRequestBody>;
    try {
      params = normalizeWorkboardDispatchRequestBody(await readJsonBody(req));
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendError(res, error.status, error.type, error.message);
        return true;
      }
      sendError(res, 400, "invalid_request", errorMessage(error));
      return true;
    }

    try {
      const response = await dispatch("workboard.cards.dispatch", params, { expectFinal: true });
      sendJson(res, statusForDispatchResponse(response), response);
      return true;
    } catch (error) {
      sendError(res, 503, "gateway_dispatch_failed", errorMessage(error));
      return true;
    }
  };
}
