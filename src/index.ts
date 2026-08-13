import { Type } from "typebox";
import { buildJsonPluginConfigSchema, definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { configSchema as rawConfigSchema, normalizeControllerConfig, PLUGIN_DESCRIPTION, PLUGIN_ID, PLUGIN_NAME } from "./config.js";
import { WorkboardController } from "./controller.js";
import { createGatewayMethodClient } from "./gateway-method-client.js";
import { createWorkboardDispatchRouteHandler } from "./workboard-dispatch-route.js";
import { createWorkboardArchiveRouteHandler, createWorkboardCreateRouteHandler, createWorkboardListRouteHandler } from "./workboard-gateway-routes.js";
import { WORKBOARD_DISPATCH_ROUTE_PATH } from "./workboard-dispatch-shared.js";
import { WORKBOARD_ARCHIVE_ROUTE_PATH, WORKBOARD_CREATE_ROUTE_PATH, WORKBOARD_LIST_ROUTE_PATH } from "./workboard-gateway-shared.js";
import { createFileStateStore } from "./state.js";
import { agentIdFromSessionKey, isReliableExternalOwnerSessionKey, isWorkboardWorkerSessionKey, optionalSessionKey } from "./owner-binding.js";

let controller: WorkboardController | undefined;

type PendingCoreCreate = { ownerSessionKey: string; ownerAgentId?: string; capturedAt: number };
const pendingCoreCreates = new Map<string, PendingCoreCreate>();


function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stripOwnerCreateParams(value: unknown): { createParams: Record<string, unknown>; ownerSessionKey?: string } {
  const record = asRecord(value);
  const { ownerSessionKey, ...createParams } = record;
  return { createParams, ownerSessionKey: optionalSessionKey(ownerSessionKey) };
}

function extractCreatedCardId(result: unknown): string | undefined {
  const record = asRecord(result);
  const details = asRecord(record.details);
  const payload = Object.keys(details).length ? details : record;
  const cardId = optionalSessionKey(asRecord(payload.card).id) ?? optionalSessionKey(payload.id) ?? optionalSessionKey(payload.cardId);
  if (cardId) return cardId;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content.map((entry) => asRecord(entry)).find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (typeof text === "string") {
    try {
      return extractCreatedCardId(JSON.parse(text));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function coreCreateCorrelationKey(event: Record<string, unknown>, ctx: Record<string, unknown>): string | undefined {
  return optionalSessionKey(event.toolCallId) ?? optionalSessionKey(ctx.toolCallId);
}

function registerCoreCreateHooks(api: Record<string, unknown>): void {
  if (typeof api.registerHook !== "function") return;
  api.registerHook("before_tool_call", (event: unknown, ctx: unknown) => {
    const eventRecord = asRecord(event);
    const ctxRecord = asRecord(ctx);
    if (eventRecord.toolName !== "workboard_create") return;
    const key = coreCreateCorrelationKey(eventRecord, ctxRecord);
    const ownerSessionKey = optionalSessionKey(ctxRecord.sessionKey);
    if (!key || !ownerSessionKey || isWorkboardWorkerSessionKey(ownerSessionKey)) return;
    if (!isReliableExternalOwnerSessionKey(ownerSessionKey)) return;
    pendingCoreCreates.set(key, { ownerSessionKey, ownerAgentId: optionalSessionKey(ctxRecord.agentId) ?? agentIdFromSessionKey(ownerSessionKey), capturedAt: Date.now() });
  });
  api.registerHook("after_tool_call", (event: unknown, ctx: unknown) => {
    const eventRecord = asRecord(event);
    const ctxRecord = asRecord(ctx);
    if (eventRecord.toolName !== "workboard_create") return;
    const key = coreCreateCorrelationKey(eventRecord, ctxRecord);
    if (!key) return;
    const pending = pendingCoreCreates.get(key);
    pendingCoreCreates.delete(key);
    if (!pending || eventRecord.error || !controller) return;
    const cardId = extractCreatedCardId(eventRecord.result);
    if (!cardId) return;
    void controller.bindOwner({ cardId, ownerSessionKey: pending.ownerSessionKey, ownerAgentId: pending.ownerAgentId, source: "core-hook" }).catch(() => {});
  });
}

const workboardCreateOwnedParameters = Type.Object({
  title: Type.String({ description: "Card title." }),
  notes: Type.Optional(Type.String({ description: "Card notes or acceptance criteria." })),
  status: Type.Optional(Type.String({ description: "Initial status." })),
  priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "Card labels." })),
  agentId: Type.Optional(Type.String({ description: "Assigned Workboard agent id; not used for owner derivation." })),
  parents: Type.Optional(Type.Array(Type.String(), { description: "Parent card ids." })),
  token: Type.Optional(Type.String({ description: "Claim token for claimed parent cards." })),
  tenant: Type.Optional(Type.String({ description: "Soft tenant namespace." })),
  boardId: Type.Optional(Type.String({ description: "Soft board namespace." })),
  createdByCardId: Type.Optional(Type.String({ description: "Parent card that created this card." })),
  idempotencyKey: Type.Optional(Type.String({ description: "Idempotent create key." })),
  skills: Type.Optional(Type.Array(Type.String(), { description: "Suggested skills." })),
  workspace: Type.Optional(Type.Object({
    kind: Type.String({ description: "scratch, dir, or worktree." }),
    path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
    branch: Type.Optional(Type.String({ description: "Suggested branch." })),
  }, { additionalProperties: false })),
  maxRuntimeSeconds: Type.Optional(Type.Number({ description: "Run timeout seconds." })),
  maxRetries: Type.Optional(Type.Number({ description: "Retry budget." })),
  scheduledAt: Type.Optional(Type.Number({ description: "Unix epoch milliseconds." })),
  sessionKey: Type.Optional(Type.String({ description: "Optional Workboard session linkage field forwarded to core create." })),
  ownerSessionKey: Type.Optional(Type.String({ description: "Exact external direct owner session key. Defaults to trusted tool context sessionKey." })),
}, { additionalProperties: false });

const pluginConfigSchema = buildJsonPluginConfigSchema(rawConfigSchema as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0]);

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  configSchema: pluginConfigSchema,
  register(api) {
    api.registerTool(
      {
        name: "workboard_controller_status",
        label: "Workboard Controller Status",
        description: "Return Workboard controller status, terminal wake/start notification history, archive dry-run candidates, counters, and durable cursor state summary.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          return jsonResult(controller?.status() ?? { running: false, reason: "service not started" });
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "workboard_controller_tick",
        label: "Workboard Controller Tick",
        description: "Run one Workboard controller terminal wake/dispatch tick now; archive scan runs only when its interval is due.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          if (!controller) return jsonResult({ running: false, error: "service not started" });
          return jsonResult(await controller.runOnce("tool"));
        },
      },
      { optional: true },
    );

    api.registerTool(
      (ctx: Record<string, unknown>) => ({
        name: "workboard_create_owned",
        label: "Workboard Create Owned",
        description: "Create a Workboard card through the official Gateway method and persist a controller-owned owner binding for terminal wakes.",
        parameters: workboardCreateOwnedParameters,
        async execute(_toolCallId: string, rawParams: unknown) {
          if (!controller) return jsonResult({ ok: false, error: "service not started" });
          const { createParams, ownerSessionKey: explicitOwnerSessionKey } = stripOwnerCreateParams(rawParams);
          const ownerSessionKey = explicitOwnerSessionKey ?? optionalSessionKey(ctx.sessionKey);
          if (!ownerSessionKey || !isReliableExternalOwnerSessionKey(ownerSessionKey)) {
            return jsonResult({ ok: false, error: "ownerSessionKey must be a reliable external direct session key" });
          }
          return jsonResult(await controller.createOwnedCard(createParams, ownerSessionKey, optionalSessionKey(ctx.agentId) ?? agentIdFromSessionKey(ownerSessionKey)));
        },
      }),
      { optional: true, names: ["workboard_create_owned"] },
    );

    api.registerTool(
      (ctx: Record<string, unknown>) => ({
        name: "workboard_owner_bind",
        label: "Workboard Owner Bind",
        description: "Set or repair the controller-owned owner binding for an existing Workboard card.",
        parameters: Type.Object({
          cardId: Type.String({ description: "Existing Workboard card id." }),
          ownerSessionKey: Type.Optional(Type.String({ description: "Exact external direct owner session key. Defaults to trusted tool context sessionKey." })),
        }, { additionalProperties: false }),
        async execute(_toolCallId: string, rawParams: unknown) {
          if (!controller) return jsonResult({ ok: false, error: "service not started" });
          const record = asRecord(rawParams);
          const cardId = optionalSessionKey(record.cardId);
          const ownerSessionKey = optionalSessionKey(record.ownerSessionKey) ?? optionalSessionKey(ctx.sessionKey);
          if (!cardId || !ownerSessionKey || !isReliableExternalOwnerSessionKey(ownerSessionKey, [], cardId)) {
            return jsonResult({ ok: false, error: "cardId and reliable external ownerSessionKey are required" });
          }
          const binding = await controller.bindOwner({ cardId, ownerSessionKey, ownerAgentId: optionalSessionKey(ctx.agentId) ?? agentIdFromSessionKey(ownerSessionKey), source: "manual" });
          return jsonResult({ ok: true, binding: { cardId: binding.cardId, ownerAgentId: binding.ownerAgentId, source: binding.source, createdAt: binding.createdAt, updatedAt: binding.updatedAt } });
        },
      }),
      { optional: true, names: ["workboard_owner_bind"] },
    );

    api.registerHttpRoute({
      path: WORKBOARD_DISPATCH_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      handler: createWorkboardDispatchRouteHandler(),
    });

    api.registerHttpRoute({
      path: WORKBOARD_LIST_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      handler: createWorkboardListRouteHandler(),
    });

    api.registerHttpRoute({
      path: WORKBOARD_ARCHIVE_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      handler: createWorkboardArchiveRouteHandler(),
    });

    api.registerHttpRoute({
      path: WORKBOARD_CREATE_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      handler: createWorkboardCreateRouteHandler(),
    });

    registerCoreCreateHooks(api as unknown as Record<string, unknown>);

    if (api.registrationMode !== "full") return;

    api.registerService({
      id: "workboard-controller",
      async start(ctx) {
        const config = normalizeControllerConfig(api.pluginConfig);
        controller = new WorkboardController({
          config,
          runtimeVersion: api.runtime.version,
          fullConfig: ctx.config,
          stateStore: createFileStateStore(ctx.stateDir),
          gateway: createGatewayMethodClient({ config: ctx.config, baseUrl: config.gatewayBaseUrl, sessionKey: config.gatewayToolSessionKey }),
          runtimeAgent: api.runtime.agent,
          logger: ctx.logger,
        });
        await controller.start();
      },
      async stop() {
        await controller?.stop();
        controller = undefined;
      },
    });
  },
});

export default plugin;
