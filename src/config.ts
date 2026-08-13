import { Type } from "typebox";

export const PLUGIN_ID = "workboard-controller";
export const PLUGIN_NAME = "Workboard Controller";
export const PLUGIN_DESCRIPTION = "Automatically dispatches Workboard ready cards after terminal events and wakes owners on problem events.";
export const SUPPORTED_OPENCLAW_VERSION = "2026.7.1-2";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_LIMIT = 50;
const DEFAULT_DISPATCH_COOLDOWN_MS = 2_000;
const DEFAULT_WAKE_TIMEOUT_MS = 120_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 60_000;

export const configSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: "Start the controller service on Gateway startup. Default true." })),
    boardId: Type.Optional(Type.String({ description: "Workboard board id to watch. Default default." })),
    subscriptionId: Type.Optional(Type.String({ description: "Existing Workboard notification subscription id to reuse." })),
    target: Type.Optional(Type.String({ description: "Notification subscription target marker. Default workboard-controller." })),
    pollIntervalMs: Type.Optional(Type.Number({ description: "Notification poll interval in milliseconds. Default 15000." })),
    batchLimit: Type.Optional(Type.Number({ description: "Maximum Workboard notifications to process per tick. Default 50." })),
    dispatchCooldownMs: Type.Optional(Type.Number({ description: "Minimum delay between dispatch calls. Default 2000." })),
    dispatchTimeoutMs: Type.Optional(Type.Number({ description: "Gateway /tools/invoke timeout for Workboard dispatch in milliseconds. Default 60000." })),
    gatewayBaseUrl: Type.Optional(Type.String({ description: "Optional Gateway HTTP base URL for /tools/invoke. Default http://127.0.0.1:${OPENCLAW_GATEWAY_PORT || gateway.port || 18789}." })),
    gatewayToolSessionKey: Type.Optional(Type.String({ description: "Session key passed to /tools/invoke for tool policy routing. Default main." })),
    wakeEnabled: Type.Optional(Type.Boolean({ description: "Wake owner sessions on failed/stale/blocked events. Default true." })),
    wakeFallbackSessionKey: Type.Optional(Type.String({ description: "Fallback session key when an event/card has no linked session." })),
    wakeFallbackAgentId: Type.Optional(Type.String({ description: "Fallback agent id when an event/card has no agent. Default main." })),
    wakeTimeoutMs: Type.Optional(Type.Number({ description: "Problem wake embedded-agent timeout in milliseconds. Default 120000." })),
    wakeToolsAllow: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist for problem wake runs." })),
    compatibleOpenClawVersions: Type.Optional(Type.Array(Type.String(), { description: "Exact OpenClaw versions accepted by this compatibility seam." })),
    allowUntestedOpenClawVersion: Type.Optional(Type.Boolean({ description: "Disable exact OpenClaw version fail-fast. Default false." })),
  },
  { additionalProperties: false },
);

export type ControllerConfig = {
  enabled: boolean;
  boardId: string;
  subscriptionId?: string;
  target: string;
  pollIntervalMs: number;
  batchLimit: number;
  dispatchCooldownMs: number;
  dispatchTimeoutMs: number;
  gatewayBaseUrl?: string;
  gatewayToolSessionKey: string;
  wakeEnabled: boolean;
  wakeFallbackSessionKey?: string;
  wakeFallbackAgentId: string;
  wakeTimeoutMs: number;
  wakeToolsAllow?: string[];
  compatibleOpenClawVersions: string[];
  allowUntestedOpenClawVersion: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  return items.length ? Array.from(new Set(items)) : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function optionalBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeControllerConfig(raw: unknown): ControllerConfig {
  const record = asRecord(raw);
  return {
    enabled: optionalBoolean(record, "enabled", true),
    boardId: optionalString(record, "boardId") ?? "default",
    subscriptionId: optionalString(record, "subscriptionId"),
    target: optionalString(record, "target") ?? PLUGIN_ID,
    pollIntervalMs: optionalNumber(record, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS, 1_000, 300_000),
    batchLimit: optionalNumber(record, "batchLimit", DEFAULT_LIMIT, 1, 200),
    dispatchCooldownMs: optionalNumber(record, "dispatchCooldownMs", DEFAULT_DISPATCH_COOLDOWN_MS, 0, 300_000),
    dispatchTimeoutMs: optionalNumber(record, "dispatchTimeoutMs", DEFAULT_DISPATCH_TIMEOUT_MS, 1_000, 600_000),
    gatewayBaseUrl: optionalString(record, "gatewayBaseUrl"),
    gatewayToolSessionKey: optionalString(record, "gatewayToolSessionKey") ?? "main",
    wakeEnabled: optionalBoolean(record, "wakeEnabled", true),
    wakeFallbackSessionKey: optionalString(record, "wakeFallbackSessionKey"),
    wakeFallbackAgentId: optionalString(record, "wakeFallbackAgentId") ?? "main",
    wakeTimeoutMs: optionalNumber(record, "wakeTimeoutMs", DEFAULT_WAKE_TIMEOUT_MS, 1_000, 900_000),
    wakeToolsAllow: optionalStringArray(record, "wakeToolsAllow"),
    compatibleOpenClawVersions: optionalStringArray(record, "compatibleOpenClawVersions") ?? [SUPPORTED_OPENCLAW_VERSION],
    allowUntestedOpenClawVersion: optionalBoolean(record, "allowUntestedOpenClawVersion", false),
  };
}

export function assertCompatibleOpenClawVersion(config: ControllerConfig, runtimeVersion: string): void {
  if (config.allowUntestedOpenClawVersion) return;
  if (config.compatibleOpenClawVersions.includes(runtimeVersion)) return;
  throw new Error(
    `${PLUGIN_ID} is version-gated for OpenClaw ${config.compatibleOpenClawVersions.join(", ")}; current runtime is ${runtimeVersion}. ` +
      "Set allowUntestedOpenClawVersion=true only after checking Workboard notification and dispatch contracts.",
  );
}
