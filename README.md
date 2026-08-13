# Workboard Controller

Local-only OpenClaw plugin that closes the first Workboard automation gap:
when Workboard emits terminal notifications, the controller dispatches the next ready cards; failed, stale, or newly blocked work wakes the owner session; normal successful chains stay quiet.

## Design

- Watches Workboard durable notifications through the public `workboard_notify_events` tool without advancing the cursor first.
- Persists only controller state under the OpenClaw plugin state dir: subscription id, processed event ids, notified problem ids, counters, and last error. It does not persist Gateway credentials.
- After processing a contiguous batch, advances the Workboard subscription cursor with `workboard_notify_advance`.
- Calls a Gateway-authenticated plugin self-route for `workboard.cards.dispatch`, so Workboard promotes ready cards and starts the same subagent worker runs used by the dashboard and CLI dispatch action.
- Wakes owners for `failed`, `stale`, dispatch `blocked`, and worker start failures via `api.runtime.agent.runEmbeddedAgent`.
- Does not clear Goals and does not create a workflow ledger.

## Gateway Invoke Path

The controller uses two Gateway HTTP paths:

- Notification subscription, event reads, and cursor advance still call public Workboard notification tools through `/tools/invoke`: `workboard_notify_subscribe`, `workboard_notify_events`, and `workboard_notify_advance`.
- Dispatch calls `POST /plugins/workboard-controller/workboard-dispatch`, a plugin-owned route registered with `auth: "gateway"` and `match: "exact"`. The route body is fixed to `{ "boardId": string }`, rejects unknown fields, and internally calls only `dispatchGatewayMethod("workboard.cards.dispatch", { boardId }, { expectFinal: true })`.

The manifest declares `contracts.gatewayMethodDispatch: ["authenticated-request"]`. OpenClaw grants the required `gatewayMethodDispatchAllowed` runtime scope only to authenticated plugin HTTP routes with that contract; the service timer never calls `dispatchGatewayMethod` directly.

This matters because the public `workboard_dispatch` tool only runs Workboard store dispatch. The Gateway RPC method `workboard.cards.dispatch` uses Workboard `dispatchAndStartWorkboardCards` and starts ready-card subagent runs, returning the `started` and `startFailures` envelope that the controller inspects.

Gateway auth is resolved at runtime only: `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` take precedence, then string values from `gateway.auth.token` / `gateway.auth.password`. `gateway.auth.mode="none"` sends no header and should only be used behind a private ingress. `gateway.auth.mode="trusted-proxy"` direct loopback uses the password fallback, so it requires `gateway.auth.password` or `OPENCLAW_GATEWAY_PASSWORD`. Secrets are held in memory only and are not written to controller state, README examples, logs, or error messages.

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

Both tools are optional and exist for local verification/debugging. The controller's notification calls use `/tools/invoke`; make sure Workboard notification tools are allowed for `gatewayToolSessionKey` (default `main`). Dispatch uses the Gateway-authenticated self-route and does not call the public `workboard_dispatch` tool.

## Known Limits

- First version does not auto-clear or archive Goals.
- Problem wake uses an embedded agent run. If the target session has no usable delivery route, the event is still recorded in that session but may not produce an external chat notification.
- The controller relies on Workboard notification events; if a card is manually moved to `blocked` without a Workboard `failed`/`stale` notification or dispatch result, it is not detected by this first version.
- Version gate is intentionally strict because the Workboard notification tools, Gateway-authenticated route scope, and `workboard.cards.dispatch` envelope are version-sensitive.
- Runtime `configSchema` is wrapped with `buildJsonPluginConfigSchema`; there is one TypeScript-only cast at that wrapper call because TypeBox objects lack the index signature expected by OpenClaw 2026.7.1-2 `JsonSchemaObject` types.
