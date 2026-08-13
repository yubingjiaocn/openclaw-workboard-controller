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

`terminalWakeDebounceMs` defaults to `1000` and is clamped to `0..60000`. The window is non-sliding per resolved owner session. The first pending event for an idle owner sets the wake deadline at `firstObservedAt + terminalWakeDebounceMs`; later events for that owner join the batch but never move the deadline. A continuous stream of terminal events cannot starve the owner wake.

## Routing

Terminal wakes use `ownerRoutes` only. Route matching uses the v0.3.0 resolver: every configured dimension must match, with priority `tenant+boardId+agentId`, then `boardId+agentId`, then `tenant+boardId` or `tenant+agentId`, then single dimensions; declaration order breaks ties.

Worker/subagent session keys are rejected as terminal wake destinations, including public card session keys, execution session keys, event session keys, and dispatch `started.sessionKey`. If no owner route exists, the controller records a visible terminal wake failure and leaves the event pending for bounded-backoff retry. It does not guess `main`, use `wakeFallbackSessionKey`, or deliver to a worker session.

## Processing Order

For each tick the controller:

1. Reads notification events without advancing the cursor.
2. For each unprocessed event, resolves the owner route when possible and persists a pending terminal inbox entry before cursor advance.
3. Starts any due owner wake batches without waiting for unrelated owners.
4. Dispatches ready cards once when the batch contained new terminal events. Dispatch is independent of the debounce window and owner wake delivery.
5. Persists dispatch `blocked` and `startFailure` terminal inbox entries and starts any due owner wake batches.
6. Advances the Workboard notification cursor for the contiguous batch after durable event persistence.

Wake failures do not prevent dispatch or cursor advance. Successful wake batches remove their event identities from the pending inbox and add them to `terminalWakeIds`. Failed wake batches keep their events pending with bounded exponential backoff, so later ticks can retry without losing the terminal event or marking it delivered. A completed wake prompt also tells the owner agent not to duplicate Workboard dispatch or redo completed work, so the owner wake and controller dispatch can coexist without causing duplicate work.

At most one embedded owner wake is in flight per owner session key. Events arriving for that owner during an in-flight wake remain pending and form a later batch. When the in-flight wake finishes, the controller immediately checks whether the next batch is already due. Different owner session keys are tracked independently and can be launched in the same scheduler pass.

## Boundary

The controller does not inspect worktrees or files, reserve paths, detect parallel workers writing the same file, or provide file-conflict isolation. Those concerns belong to owner task decomposition. Within one controller instance, terminal events are coalesced by wake identity, owner wake in-flight state is isolated per owner session key, and automatic dependency dispatch remains independent/idempotent.

## Dedup And Status

Notification wake identity is `event:<event.id>`. Dispatch `blocked` and `startFailure` identities are stable from card/update/error data. Pending inbox entries are de-duplicated by wake identity. Identities are stored in `terminalWakeIds` only after successful delivery so delivered wakes do not repeat across ticks or restarts. Legacy `notifiedProblemIds` are migrated into `terminalWakeIds` to avoid re-waking old failed/stale/blocked events after upgrade.

Status exposes `pendingTerminalEvents` with bounded per-owner counts, `inFlightOwnerWakes`, queued terminal event counters (`terminalEventsQueued`), delivered terminal event counters (`terminalWakes`/legacy `wakes`), batched wake counters (`terminalWakeBatches`), wake error counters (`terminalWakeErrors`/legacy `wakeErrors`), bounded `recentTerminalWakes`, and bounded `terminalWakeFailures`. Legacy `wakeFailures` remains for compatibility and mirrors terminal wake failures.
