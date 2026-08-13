# Workboard Controller

Local-only OpenClaw plugin that closes the first Workboard automation gap:
when Workboard emits terminal notifications, the controller dispatches the next ready cards; each newly started card sends a concise visible start notification to the owner/routing session; failed, stale, or newly blocked work wakes the owner session. It can also scan for safely archived done cards, disabled and dry-run by default.

## Design

- Watches Workboard durable notifications through the public `workboard_notify_events` tool without advancing the cursor first.
- Persists only controller state under the OpenClaw plugin state dir: subscription id, processed event ids, notified problem ids, notified start identities, bounded recent start notifications/failures, counters, and last error. It does not persist Gateway credentials.
- After processing a contiguous batch, advances the Workboard subscription cursor with `workboard_notify_advance`.
- Calls a Gateway-authenticated plugin self-route for `workboard.cards.dispatch`, so Workboard promotes ready cards and starts the same subagent worker runs used by the dashboard and CLI dispatch action.
- Sends start notifications and wakes owners for `failed`, `stale`, dispatch `blocked`, and worker start failures via the official session routing/delivery surface available to plugins. On OpenClaw 2026.7.1-2 this is `api.runtime.agent.runEmbeddedAgent` with the target `sessionKey` preserved exactly. Start notification prompts are locked to deliver only the concise notification text and not perform card work.
- Does not clear Goals and does not create a workflow ledger.
- Optionally scans Workboard cards through public Gateway RPC for done-card archive candidates. Archive automation defaults to `archiveEnabled=false` and `archiveDryRun=true`.
- Treats a Workboard graph as the entire connected component reachable through parent/child links. A linked component is eligible only when every card in that component is visible in the public list result, every card is `done`, every card satisfies proof when `archiveRequireProof=true`, no card is todo/ready/running/blocked/failed/stale, and the component's latest terminal timestamp has passed `archiveCompletedGraphAfterMs`.
- Uses `archiveStandaloneAfterMs` for unlinked done cards. Already archived cards are included in component safety checks but skipped for archive actions, so partial failures are retried idempotently.
- Runs archive scans at most once per `archiveScanIntervalMs` from the periodic tick. The manual tick tool does not force a full archive rescan when the interval is not due.

## Gateway Invoke Path

The controller uses these Gateway HTTP paths:

- Notification subscription, event reads, and cursor advance still call public Workboard notification tools through `/tools/invoke`: `workboard_notify_subscribe`, `workboard_notify_events`, and `workboard_notify_advance`.
- Dispatch calls `POST /plugins/workboard-controller/workboard-dispatch`, a plugin-owned route registered with `auth: "gateway"` and `match: "exact"`. The route body is fixed to `{ "boardId": string }`, rejects unknown fields, and internally calls only `dispatchGatewayMethod("workboard.cards.dispatch", { boardId }, { expectFinal: true })`.
- Archive scan reads cards through `POST /plugins/workboard-controller/workboard-list`, fixed to `workboard.cards.list`. Archive actions call `POST /plugins/workboard-controller/workboard-archive`, fixed to `workboard.cards.archive` with `{ "id": string, "archived": true }`. Both routes reject unknown fields and require Gateway auth.

The manifest declares `contracts.gatewayMethodDispatch: ["authenticated-request"]`. OpenClaw grants the required `gatewayMethodDispatchAllowed` runtime scope only to authenticated plugin HTTP routes with that contract; the service timer never calls `dispatchGatewayMethod` directly.

This matters because the public `workboard_dispatch` tool only runs Workboard store dispatch. The Gateway RPC method `workboard.cards.dispatch` uses Workboard `dispatchAndStartWorkboardCards` and starts ready-card subagent runs, returning the `started` and `startFailures` envelope that the controller inspects. For each `started` card, the controller de-duplicates by `runId` when present, otherwise by card/start time, then sends `▶️ Workboard 已启动：<title>\nID: <id>` to the resolved explicit start-notification route. Route matching is channel-agnostic: `sessionKey` is treated as an opaque OpenClaw delivery context and is never rewritten for Telegram, Feishu, QQ, DingTalk, or any other provider.

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
          gatewayToolSessionKey: "main",
          startNotifyEnabled: true,
          // Preferred: route start notifications and problem wakes explicitly by owner route.
          // Each sessionKey must be the full direct channel-specific owner session.
          ownerRoutes: [
            { tenant: "prod", boardId: "default", agentId: "main", sessionKey: "agent:main:telegram:direct:8068735520" },
            { boardId: "default", agentId: "may", sessionKey: "agent:may:feishu:direct:<may-direct-session-key>" },
            { boardId: "default", agentId: "muriel", sessionKey: "agent:muriel:qq:direct:<muriel-direct-session-key>" }
          ],
          // Legacy global fallback for installations with one owner route.
          // startNotifySessionKey: "agent:main:telegram:direct:8068735520",
          // Last-resort explicit route when no ownerRoutes entry matches.
          // wakeFallbackSessionKey: "agent:main:telegram:direct:8068735520",
          archiveEnabled: false,
          archiveDryRun: true,
          archiveCompletedGraphAfterMs: 86400000,
          archiveStandaloneAfterMs: 604800000,
          archiveRequireProof: true,
          archiveScanIntervalMs: 3600000
        }
      }
    }
  }
}
```

Gateway restart is required after changing plugin config.

`ownerRoutes.sessionKey` is opaque to the controller and is passed through unchanged. Use the exact channel-specific direct session key for the owner route, for example Telegram/Feishu/QQ/DingTalk direct keys. Do not use `agent:<id>:main`, `agent:<id>`, or card/subagent session keys as shortcuts; those are unsafe for channel-specific delivery and may route into worker sessions.

## Tools

- `workboard_controller_status`: returns controller status, durable state path, counters including `wakeErrors`, last error, bounded `recentStartNotifications`, bounded `startNotificationFailures`, bounded `wakeFailures`, archive config summary, bounded `archiveCandidates`, and bounded `archiveLastFailures`.
- `workboard_controller_tick`: runs one notification/dispatch pass manually. It runs an archive scan only if `archiveEnabled=true` and `archiveScanIntervalMs` is due.

Both tools are optional and exist for local verification/debugging. The controller's Workboard notification polling calls use `/tools/invoke`; make sure Workboard notification tools are allowed for `gatewayToolSessionKey` (default `main`). Dispatch, list, and archive use Gateway-authenticated self-routes fixed to public Workboard Gateway RPC methods. Dispatch does not call the public `workboard_dispatch` tool. Start notifications and problem wakes use the same channel-agnostic `ownerRoutes` resolver. Each route must provide the full direct `sessionKey` plus at least one match dimension: `tenant`, `boardId`, or `agentId`. All supplied dimensions must match; route priority is `tenant+boardId+agentId`, then `boardId+agentId`, then `tenant+boardId` or `tenant+agentId`, then single-dimension `tenant`, `boardId`, or `agentId`; equal priority uses declaration order. Start target precedence is `ownerRoutes`, then legacy `startNotifySessionKey`, then legacy `wakeFallbackSessionKey`; problem wake precedence is `ownerRoutes`, then legacy `wakeFallbackSessionKey`. Worker/subagent session keys are rejected, including `card.sessionKey`, `card.execution.sessionKey`, event worker session keys, and the dispatch `started.sessionKey`. If no reliable route exists, the controller records a visible start/wake failure instead of guessing `agent:<id>:main` or reusing Workboard worker linkage.

## Known Limits

- The controller does not auto-clear or archive Goals.
- Start notification and problem wake delivery prefer the official direct session-delivery API when OpenClaw exposes one to plugins. OpenClaw 2026.7.1-2 does not expose a stable plugin API for direct visible message delivery to an existing session, so the controller uses `api.runtime.agent.runEmbeddedAgent` with prompts constrained to notification delivery only. The embedded run uses the configured target `sessionKey` and therefore the target session's existing delivery context. If the target session has no usable delivery route, the event is still recorded in that session but may not produce an external chat notification.
- The controller relies on Workboard notification events; if a card is manually moved to `blocked` without a Workboard `failed`/`stale` notification or dispatch result, it is not detected by this first version.
- Version gate is intentionally strict because the Workboard notification tools, Gateway-authenticated route scope, and `workboard.cards.dispatch` envelope are version-sensitive.
- Runtime `configSchema` is wrapped with `buildJsonPluginConfigSchema`; there is one TypeScript-only cast at that wrapper call because TypeBox objects lack the index signature expected by OpenClaw 2026.7.1-2 `JsonSchemaObject` types.
