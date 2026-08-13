# Terminal Wake Design

## OpenClaw 2026.7.1-2 Session Delivery

OpenClaw 2026.7.1-2 exposes plugin embedded runs through `api.runtime.agent.runEmbeddedAgent`. The controller passes the resolved owner `sessionKey` to that API unchanged. The `sessionKey` is treated as the full opaque delivery context for the channel-specific owner session; the controller does not synthesize `agent:<id>:main`, trim provider-specific suffixes, or convert Feishu/QQ/Telegram/DingTalk direct keys.

## Terminal Events

Terminal owner wakes are enabled by `terminalWakeEnabled` and cover:

- Workboard notification `completed`
- Workboard notification `failed`
- Workboard notification `stale`
- Dispatch result `blocked`
- Dispatch result `startFailure`

`terminalWakeEnabled` defaults to `true`. Migration precedence is: explicit `terminalWakeEnabled`, then legacy `wakeEnabled`, then `true`. `startNotifyEnabled` is independent and controls only short card-start messages.

## Routing

Terminal wakes use `ownerRoutes` only. Route matching uses the v0.3.0 resolver: every configured dimension must match, with priority `tenant+boardId+agentId`, then `boardId+agentId`, then `tenant+boardId` or `tenant+agentId`, then single dimensions; declaration order breaks ties.

Worker/subagent session keys are rejected as terminal wake destinations, including public card session keys, execution session keys, event session keys, and dispatch `started.sessionKey`. If no owner route exists, the controller records a visible terminal wake failure. It does not guess `main`, use `wakeFallbackSessionKey`, or deliver to a worker session.

## Processing Order

For each tick the controller:

1. Reads notification events without advancing the cursor.
2. For each unprocessed event, attempts the terminal owner wake best-effort and persists the event id and terminal wake id/failure.
3. Dispatches ready cards once when the batch contained new terminal events.
4. Wakes owners for dispatch `blocked` and `startFailure` results best-effort.
5. Advances the Workboard notification cursor for the contiguous batch.

Wake failures do not prevent dispatch or cursor advance. A completed wake prompt also tells the owner agent not to duplicate Workboard dispatch or redo completed work, so the owner wake and controller dispatch can coexist without causing duplicate work.

## Dedup And Status

Notification wake identity is `event:<event.id>`. Dispatch `blocked` and `startFailure` identities are stable from card/update/error data. Identities are stored in `terminalWakeIds` so wakes do not repeat across ticks or restarts. Legacy `notifiedProblemIds` are migrated into `terminalWakeIds` to avoid re-waking old failed/stale/blocked events after upgrade.

Status exposes `terminalWakes`, `terminalWakeErrors`, bounded `recentTerminalWakes`, and bounded `terminalWakeFailures`. Legacy `wakes`, `wakeErrors`, and `wakeFailures` remain for compatibility and mirror terminal wake activity.
