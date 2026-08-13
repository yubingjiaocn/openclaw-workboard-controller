# Workboard Controller

Local-only OpenClaw plugin that closes the first Workboard automation gap:
when Workboard emits terminal notifications, the controller dispatches the next ready cards; failed, stale, or newly blocked work wakes the owner session; normal successful chains stay quiet.

## Design

- Watches Workboard durable notifications through `workboard.notifications.events` without advancing the cursor first.
- Persists only controller state under the OpenClaw plugin state dir: subscription id, processed event ids, notified problem ids, counters, and last error.
- After processing a contiguous batch, advances the Workboard subscription cursor with `workboard.notifications.advance`.
- Calls `workboard.cards.dispatch` so Gateway-backed dispatch can promote dependencies, reclaim stale claims, block timed-out runs, and start worker subagents.
- Wakes owners for `failed`, `stale`, dispatch `blocked`, and worker start failures via `api.runtime.agent.runEmbeddedAgent`.
- Does not clear Goals and does not create a workflow ledger.

## Compatibility seam

OpenClaw 2026.7.1-2 documents `api.runtime.gateway.request(...)`, but that helper rejects arbitrary external plugins. This plugin therefore uses the narrow `openclaw/plugin-sdk/gateway-method-runtime` dispatch seam and declares `contracts.gatewayMethodDispatch: ["authenticated-request"]`, then calls only these Gateway methods:

- `workboard.notifications.subscribe`
- `workboard.notifications.events`
- `workboard.notifications.advance`
- `workboard.cards.dispatch`

It does not import Workboard private runtime chunks, read or write Workboard SQLite directly, or modify OpenClaw core. The service fail-fast gates `api.runtime.version` to `2026.7.1-2` unless `allowUntestedOpenClawVersion` is explicitly set.

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
          pollIntervalMs: 15000
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

Both tools are optional and exist for local verification/debugging.

## Known Limits

- First version does not auto-clear or archive Goals.
- Problem wake uses an embedded agent run. If the target session has no usable delivery route, the event is still recorded in that session but may not produce an external chat notification.
- The controller relies on Workboard notification events; if a card is manually moved to `blocked` without a Workboard `failed`/`stale` notification or dispatch result, it is not detected by this first version.
- Version gate is intentionally strict because the Gateway method dispatch seam is narrower than a stable external controller SDK.
- Runtime `configSchema` is wrapped with `buildJsonPluginConfigSchema`; there is one TypeScript-only cast at that wrapper call because TypeBox objects lack the index signature expected by OpenClaw 2026.7.1-2 `JsonSchemaObject` types.
