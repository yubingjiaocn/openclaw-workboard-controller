import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeWorkboardDispatchRequestBody, WORKBOARD_DISPATCH_ROUTE_PATH } from "./workboard-dispatch-shared.js";
import {
  normalizeWorkboardArchiveRequestBody,
  normalizeWorkboardCreateRequestBody,
  normalizeWorkboardListRequestBody,
  WORKBOARD_ARCHIVE_ROUTE_PATH,
  WORKBOARD_CREATE_ROUTE_PATH,
  WORKBOARD_LIST_ROUTE_PATH,
} from "./workboard-gateway-shared.js";

export type GatewayMethodClient = {
  request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type GatewayMethodClientOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  baseUrl?: string;
  sessionKey?: string;
};

type HttpAuth =
  | { kind: "none" }
  | { kind: "bearer"; value: string };

type ToolInvokeEnvelope = {
  ok?: unknown;
  result?: unknown;
  error?: { type?: string; message?: string };
};

type GatewayDispatchEnvelope = {
  ok?: unknown;
  payload?: unknown;
  error?: { type?: string; code?: string; message?: string };
  meta?: Record<string, unknown>;
};

const DEFAULT_GATEWAY_PORT = 18789;
const METHOD_TO_TOOL: Record<string, string> = {
  "workboard.notifications.subscribe": "workboard_notify_subscribe",
  "workboard.notifications.events": "workboard_notify_events",
  "workboard.notifications.advance": "workboard_notify_advance",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function gatewayAuthRecord(config: OpenClawConfig): Record<string, unknown> {
  return asRecord(asRecord(config.gateway).auth);
}

function runtimeEnvString(config: OpenClawConfig, env: NodeJS.ProcessEnv, key: string): string | undefined {
  return optionalString(env[key]) ?? optionalString(asRecord(asRecord(config.env).vars)[key]) ?? optionalString(asRecord(config.env)[key]);
}

function resolveGatewayPort(config: OpenClawConfig, env: NodeJS.ProcessEnv): number {
  const envPort = Number(runtimeEnvString(config, env, "OPENCLAW_GATEWAY_PORT"));
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  return optionalNumber(asRecord(config.gateway).port) ?? DEFAULT_GATEWAY_PORT;
}

function resolveGatewayBaseUrl(config: OpenClawConfig, env: NodeJS.ProcessEnv, explicitBaseUrl?: string): string {
  const explicit = optionalString(explicitBaseUrl);
  if (explicit) return explicit.replace(/\/+$/, "");
  return `http://127.0.0.1:${resolveGatewayPort(config, env)}`;
}

function resolveGatewayHttpAuth(config: OpenClawConfig, env: NodeJS.ProcessEnv): HttpAuth {
  const auth = gatewayAuthRecord(config);
  const mode = optionalString(auth.mode) ?? "token";
  if (mode === "none") return { kind: "none" };

  if (mode === "password") {
    const password = runtimeEnvString(config, env, "OPENCLAW_GATEWAY_PASSWORD") ?? optionalString(auth.password);
    if (!password) throw new Error("gateway password auth is configured, but no runtime gateway password is available");
    return { kind: "bearer", value: password };
  }

  if (mode === "trusted-proxy") {
    const password = runtimeEnvString(config, env, "OPENCLAW_GATEWAY_PASSWORD") ?? optionalString(auth.password);
    if (!password) {
      throw new Error("gateway trusted-proxy auth is configured; direct loopback Gateway HTTP requires gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD fallback");
    }
    return { kind: "bearer", value: password };
  }

  if (mode !== "token") throw new Error(`unsupported gateway auth mode for Gateway HTTP: ${mode}`);
  const token = runtimeEnvString(config, env, "OPENCLAW_GATEWAY_TOKEN") ?? optionalString(auth.token);
  if (!token) throw new Error("gateway token auth is configured, but no runtime gateway token is available");
  return { kind: "bearer", value: token };
}

function buildToolInvokeUrl(baseUrl: string): string {
  return `${baseUrl}/tools/invoke`;
}

function buildWorkboardDispatchRouteUrl(baseUrl: string): string {
  return `${baseUrl}${WORKBOARD_DISPATCH_ROUTE_PATH}`;
}

function buildWorkboardListRouteUrl(baseUrl: string): string {
  return `${baseUrl}${WORKBOARD_LIST_ROUTE_PATH}`;
}

function buildWorkboardArchiveRouteUrl(baseUrl: string): string {
  return `${baseUrl}${WORKBOARD_ARCHIVE_ROUTE_PATH}`;
}

function buildWorkboardCreateRouteUrl(baseUrl: string): string {
  return `${baseUrl}${WORKBOARD_CREATE_ROUTE_PATH}`;
}

function toolForMethod(method: string): string {
  const tool = METHOD_TO_TOOL[method];
  if (!tool) throw new Error(`unsupported gateway method for Workboard tool invoke client: ${method}`);
  return tool;
}

function extractToolText(result: Record<string, unknown>): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const firstText = content.find((entry) => asRecord(entry).type === "text" && typeof asRecord(entry).text === "string");
  return firstText ? (asRecord(firstText).text as string) : undefined;
}

function parseToolPayload<T>(method: string, result: unknown): T {
  const record = asRecord(result);
  if (record.isError === true) {
    const text = extractToolText(record) ?? "tool returned an error";
    throw new Error(`${method} failed: ${text}`);
  }
  if ("details" in record) return record.details as T;

  const text = extractToolText(record);
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`tool result did not contain valid JSON details: ${method}`);
    }
  }
  throw new Error(`tool result returned an invalid response: ${method}`);
}

async function readJsonResponse(response: Response): Promise<ToolInvokeEnvelope> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as ToolInvokeEnvelope;
  } catch {
    return { ok: false, error: { message: text } };
  }
}

async function readGatewayRouteResponse(response: Response): Promise<GatewayDispatchEnvelope> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as GatewayDispatchEnvelope;
  } catch {
    return { ok: false, error: { message: text } };
  }
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function createGatewayMethodClient(options: GatewayMethodClientOptions): GatewayMethodClient {
  const env = options.env ?? process.env;
  const baseUrl = resolveGatewayBaseUrl(options.config, env, options.baseUrl);
  const toolInvokeUrl = buildToolInvokeUrl(baseUrl);
  const workboardDispatchRouteUrl = buildWorkboardDispatchRouteUrl(baseUrl);
  const workboardListRouteUrl = buildWorkboardListRouteUrl(baseUrl);
  const workboardArchiveRouteUrl = buildWorkboardArchiveRouteUrl(baseUrl);
  const workboardCreateRouteUrl = buildWorkboardCreateRouteUrl(baseUrl);
  const auth = resolveGatewayHttpAuth(options.config, env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("global fetch is unavailable for gateway HTTP client");

  return {
    async request<T = unknown>(method: string, params?: unknown, requestOptions?: { timeoutMs?: number }): Promise<T> {
      const controller = requestOptions?.timeoutMs ? new AbortController() : undefined;
      const timeout = controller
        ? setTimeout(() => controller.abort(new Error(`gateway HTTP request timed out after ${requestOptions?.timeoutMs}ms: ${method}`)), requestOptions?.timeoutMs)
        : undefined;
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (auth.kind === "bearer") headers.authorization = `Bearer ${auth.value}`;
        if (method === "workboard.cards.dispatch" || method === "workboard.cards.list" || method === "workboard.cards.archive" || method === "workboard.cards.create") {
          const route = method === "workboard.cards.dispatch"
            ? workboardDispatchRouteUrl
            : method === "workboard.cards.list"
              ? workboardListRouteUrl
              : method === "workboard.cards.archive"
                ? workboardArchiveRouteUrl
                : workboardCreateRouteUrl;
          const body = method === "workboard.cards.dispatch"
            ? normalizeWorkboardDispatchRequestBody(params ?? {})
            : method === "workboard.cards.list"
              ? normalizeWorkboardListRequestBody(params ?? {})
              : method === "workboard.cards.archive"
                ? normalizeWorkboardArchiveRequestBody(params ?? {})
                : normalizeWorkboardCreateRequestBody(params ?? {});
          const response = await fetchImpl(route, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller?.signal,
          });
          const envelope = await readGatewayRouteResponse(response);
          if (!response.ok) {
            throw new Error(`${method} HTTP ${response.status}: ${envelope.error?.message ?? response.statusText}`);
          }
          if (envelope.ok !== true) {
            const type = envelope.error?.code ?? envelope.error?.type;
            const prefix = type ? `${type}: ` : "";
            throw new Error(`${method} failed: ${prefix}${envelope.error?.message ?? "unknown error"}`);
          }
          return envelope.payload as T;
        }

        const response = await fetchImpl(toolInvokeUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            tool: toolForMethod(method),
            args: asRecord(params),
            sessionKey: options.sessionKey ?? "main",
          }),
          signal: controller?.signal,
        });
        const envelope = await readJsonResponse(response);
        if (!response.ok) {
          throw new Error(`${method} HTTP ${response.status}: ${envelope.error?.message ?? response.statusText}`);
        }
        if (envelope.ok !== true) {
          const type = envelope.error?.type ? `${envelope.error.type}: ` : "";
          throw new Error(`${method} failed: ${type}${envelope.error?.message ?? "unknown error"}`);
        }
        return parseToolPayload<T>(method, envelope.result);
      } catch (error) {
        if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") {
          throw new Error(`gateway HTTP request timed out after ${requestOptions?.timeoutMs}ms: ${method}`);
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}
