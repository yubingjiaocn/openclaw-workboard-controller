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
const DEFAULT_ARCHIVE_COMPLETED_GRAPH_AFTER_MS = 86_400_000;
const DEFAULT_ARCHIVE_STANDALONE_AFTER_MS = 604_800_000;
const DEFAULT_ARCHIVE_SCAN_INTERVAL_MS = 3_600_000;

export const configSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: "Start the controller service on Gateway startup. Default true." })),
    boardId: Type.Optional(Type.String({ description: "Workboard board id to watch. Default default." })),
    subscriptionId: Type.Optional(Type.String({ description: "Existing Workboard notification subscription id to reuse." })),
    target: Type.Optional(Type.String({ description: "Notification subscription target marker. Default workboard-controller." })),
    pollIntervalMs: Type.Optional(Type.Number({ description: "Notification poll interval in milliseconds. Default 15000." })),
    batchLimit: Type.Optional(Type.Number({ description: "Maximum Workboard notifications to process per tick. Default 50." })),
    dispatchCooldownMs: Type.Optional(Type.Number({ description: "Minimum delay between dispatch calls. Default 2000." })),
    dispatchTimeoutMs: Type.Optional(Type.Number({ description: "Gateway self-route timeout for Workboard dispatch in milliseconds. Default 60000." })),
    gatewayBaseUrl: Type.Optional(Type.String({ description: "Optional Gateway HTTP base URL for /tools/invoke and the controller self-route. Default http://127.0.0.1:${OPENCLAW_GATEWAY_PORT || gateway.port || 18789}." })),
    gatewayToolSessionKey: Type.Optional(Type.String({ description: "Session key passed to /tools/invoke for Workboard notification tool policy routing. Default main." })),
    wakeEnabled: Type.Optional(Type.Boolean({ description: "Wake owner sessions on failed/stale/blocked events. Default true." })),
    wakeFallbackSessionKey: Type.Optional(Type.String({ description: "Fallback session key when an event/card has no linked session." })),
    wakeFallbackAgentId: Type.Optional(Type.String({ description: "Fallback agent id when an event/card has no agent. Default main." })),
    wakeTimeoutMs: Type.Optional(Type.Number({ description: "Problem wake embedded-agent timeout in milliseconds. Default 120000." })),
    wakeToolsAllow: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist for problem wake runs." })),
    archiveEnabled: Type.Optional(Type.Boolean({ description: "Archive eligible done Workboard cards. Default false." })),
    archiveDryRun: Type.Optional(Type.Boolean({ description: "Report archive candidates without mutating cards. Default true." })),
    archiveCompletedGraphAfterMs: Type.Optional(Type.Number({ description: "Cooling period for all-done linked components before archive. Default 86400000." })),
    archiveStandaloneAfterMs: Type.Optional(Type.Number({ description: "Cooling period for standalone done cards before archive. Default 604800000." })),
    archiveRequireProof: Type.Optional(Type.Boolean({ description: "Require every card to have non-failed proof before archive. Default true." })),
    archiveScanIntervalMs: Type.Optional(Type.Number({ description: "Minimum delay between archive scans. Default 3600000." })),
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
  archiveEnabled: boolean;
  archiveDryRun: boolean;
  archiveCompletedGraphAfterMs: number;
  archiveStandaloneAfterMs: number;
  archiveRequireProof: boolean;
  archiveScanIntervalMs: number;
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
    archiveEnabled: optionalBoolean(record, "archiveEnabled", false),
    archiveDryRun: optionalBoolean(record, "archiveDryRun", true),
    archiveCompletedGraphAfterMs: optionalNumber(record, "archiveCompletedGraphAfterMs", DEFAULT_ARCHIVE_COMPLETED_GRAPH_AFTER_MS, 0, 31_536_000_000),
    archiveStandaloneAfterMs: optionalNumber(record, "archiveStandaloneAfterMs", DEFAULT_ARCHIVE_STANDALONE_AFTER_MS, 0, 31_536_000_000),
    archiveRequireProof: optionalBoolean(record, "archiveRequireProof", true),
    archiveScanIntervalMs: optionalNumber(record, "archiveScanIntervalMs", DEFAULT_ARCHIVE_SCAN_INTERVAL_MS, 60_000, 86_400_000),
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
