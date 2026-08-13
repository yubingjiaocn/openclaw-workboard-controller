# Workboard Controller

Local-only OpenClaw plugin that closes the first Workboard automation gap:
when Workboard emits terminal notifications, the controller dispatches the next ready cards; failed, stale, or newly blocked work wakes the owner session; normal successful chains stay quiet.

## Design

- Watches Workboard durable notifications through the public `workboard_notify_events` tool without advancing the cursor first.
- Persists only controller state under the OpenClaw plugin state dir: subscription id, processed event ids, notified problem ids, counters, and last error. It does not persist Gateway credentials.
- After processing a contiguous batch, advances the Workboard subscription cursor with `workboard_notify_advance`.
- Calls `workboard_dispatch` over Gateway HTTP `/tools/invoke` so Workboard can promote dependency-ready cards, reclaim expired claims, and block timed-out runs.
- Wakes owners for `failed`, `stale`, dispatch `blocked`, and worker start failures via `api.runtime.agent.runEmbeddedAgent`.
- Does not clear Goals and does not create a workflow ledger.

## Gateway Invoke Path

The controller service does **not** call `openclaw/plugin-sdk/gateway-method-runtime`. That SDK helper checks `getPluginRuntimeGatewayRequestScope().gatewayMethodDispatchAllowed` and only works inside authenticated plugin HTTP route handlers that declare `contracts.gatewayMethodDispatch: ["authenticated-request"]`; a service timer has no such route scope, so that path fails in real Gateway startup.

Instead, the service calls the always-enabled Gateway HTTP endpoint:

- `POST http://127.0.0.1:<gateway-port>/tools/invoke`
- `workboard.notifications.subscribe` -> `workboard_notify_subscribe`
- `workboard.notifications.events` -> `workboard_notify_events`
- `workboard.notifications.advance` -> `workboard_notify_advance`
- `workboard.cards.dispatch` -> `workboard_dispatch`

`/tools/invoke` returns an outer HTTP envelope `{ ok: true, result }`; Workboard tools return `jsonResult(payload)`, so the controller reads `result.details` as the Workboard payload and falls back to parsing the first text content as JSON.

Gateway auth is resolved at runtime only: `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` take precedence, then string values from `gateway.auth.token` / `gateway.auth.password`. `gateway.auth.mode="none"` sends no header. `gateway.auth.mode="trusted-proxy"` uses the documented direct-loopback password fallback, so it requires `gateway.auth.password` or `OPENCLAW_GATEWAY_PASSWORD`. Secrets are not written to controller state, README examples, logs, or error messages.

This plugin does not use an authenticated self-route trampoline. If that path is ever introduced, it must register a plugin HTTP route protected by Gateway HTTP auth, declare `contracts.gatewayMethodDispatch: ["authenticated-request"]`, and have the service call that route rather than calling `dispatchGatewayMethod` directly from the timer.

It does not import Workboard private runtime chunks, read or write Workboard SQLite directly, modify OpenClaw core, or require the bundled `admin-http-rpc` plugin. The service fail-fast gates `api.runtime.version` to `2026.7.1-2` unless `allowUntestedOpenClawVersion` is explicitly set.

## Build And Validate

```bash
npm install
npm run verify
```

`npm run verify` runs TypeScript build, Vitest unit tests, and `scripts/validate-plugin.mjs`. OpenClaw 2026.7.1-2 `openclaw plugins validate` is limited to simple `defineToolPlugin` metadata, so this service plugin uses a local validator that imports `dist/index.js` and checks the manifest, package extension, declared tools, and Gateway dispatch contract without installing or enabling the plugin.

## Install Locally

This project is intended as a local path plugin:

```bash
openclaw plugins install /home/ubuntu/.openclaw/workspace/projects-personal/openclaw-workboard-controller
```

Required config changes are left to the main agent/operator. At minimum, enable both Workboard and this plugin, and allow both plugin ids:

```json5
{
  plugins: {
    allow: ["workboard", "workboard-controller"],
    entries: {
      workboard: { enabled: true, config: {} },
      "workboard-controller": {
        enabled: true,
        config: {
          boardId: "default",
          pollIntervalMs: 15000,
          gatewayToolSessionKey: "main"
        }
      }
    }
  }
}
```

Gateway restart is required after changing plugin config.

## Tools

- `workboard_controller_status`: returns controller status, durable state path, counters, and last error.
- `workboard_controller_tick`: runs one notification/dispatch pass manually.

Both tools are optional and exist for local verification/debugging. The controller's own Workboard calls use `/tools/invoke`; make sure Workboard tools are allowed for `gatewayToolSessionKey` (default `main`).

## Known Limits

- First version does not auto-clear or archive Goals.
- Problem wake uses an embedded agent run. If the target session has no usable delivery route, the event is still recorded in that session but may not produce an external chat notification.
- The controller relies on Workboard notification events; if a card is manually moved to `blocked` without a Workboard `failed`/`stale` notification or dispatch result, it is not detected by this first version.
- Version gate is intentionally strict because the `/tools/invoke` Workboard tool contract and Gateway auth behavior are version-sensitive.
- Runtime `configSchema` is wrapped with `buildJsonPluginConfigSchema`; there is one TypeScript-only cast at that wrapper call because TypeBox objects lack the index signature expected by OpenClaw 2026.7.1-2 `JsonSchemaObject` types.
