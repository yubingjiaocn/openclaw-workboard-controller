import { Type } from "typebox";
import { buildJsonPluginConfigSchema, definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { configSchema as rawConfigSchema, normalizeControllerConfig, PLUGIN_DESCRIPTION, PLUGIN_ID, PLUGIN_NAME } from "./config.js";
import { WorkboardController } from "./controller.js";
import { createGatewayMethodClient } from "./gateway-method-client.js";
import { createWorkboardDispatchRouteHandler } from "./workboard-dispatch-route.js";
import { WORKBOARD_DISPATCH_ROUTE_PATH } from "./workboard-dispatch-shared.js";
import { createFileStateStore } from "./state.js";

let controller: WorkboardController | undefined;

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
        description: "Return Workboard controller status and durable cursor state summary.",
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
        description: "Run one Workboard controller notification/dispatch tick now.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          if (!controller) return jsonResult({ running: false, error: "service not started" });
          return jsonResult(await controller.runOnce("tool"));
        },
      },
      { optional: true },
    );

    api.registerHttpRoute({
      path: WORKBOARD_DISPATCH_ROUTE_PATH,
      auth: "gateway",
      match: "exact",
      handler: createWorkboardDispatchRouteHandler(),
    });

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
