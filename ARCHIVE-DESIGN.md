# Workboard Done-Card Archive Design

## Scope

The controller archives Workboard cards only through public OpenClaw Workboard Gateway RPC methods exposed behind Gateway-authenticated plugin routes:

- `POST /plugins/workboard-controller/workboard-list` -> `workboard.cards.list`
- `POST /plugins/workboard-controller/workboard-archive` -> `workboard.cards.archive`

It does not import Workboard private runtime chunks, read or write Workboard SQLite directly, or modify OpenClaw core.

## Defaults

Archive automation is conservative by default:

```json5
{
  archiveEnabled: false,
  archiveDryRun: true,
  archiveCompletedGraphAfterMs: 86400000,
  archiveStandaloneAfterMs: 604800000,
  archiveRequireProof: true,
  archiveScanIntervalMs: 3600000
}
```

## Eligibility

A Workboard graph is the complete connected component formed by `parent` and `child` links, traversed transitively. It is not limited to immediate parents or immediate children.

A linked component is an archive candidate only when all of these are true:

- Every parent/child link target is present in the public list result, so the component is complete from the scanner's view.
- Every card in the connected component has `status === "done"`.
- No card in the component is in `todo`, `ready`, `running`, `blocked`, `failed`, or `stale`.
- No card has current stale metadata.
- When `archiveRequireProof=true`, every card has at least one non-failed proof entry.
- The latest terminal time across the whole component is older than `archiveCompletedGraphAfterMs`. Terminal time is derived from current card state, preferring `completedAt`, then done transition/event or execution/attempt terminal time, then `updatedAt`.

A card with no parent/child links is standalone. Standalone done cards use `archiveStandaloneAfterMs` instead of the graph threshold.

Reopened cards reset eligibility naturally because non-done cards are not candidates and Workboard removes or refreshes terminal timestamps when status changes. The controller does not persist separate eligibility timestamps.

## Archived Cards And Idempotency

Already archived cards are included while evaluating their connected component, but are skipped for archive actions. This preserves graph safety after a partial archive failure: if one card in a done component archives successfully and another fails, the next scan sees the same component, skips the already archived card, and retries the remaining unarchived card.

If a component has no unarchived cards, it is skipped.

## Scanning

Archive scanning is attached to the controller tick, but it is separately throttled by `archiveScanIntervalMs`. With the default `pollIntervalMs=15000` and `archiveScanIntervalMs=3600000`, the controller does not full-scan Workboard every 15 seconds.

The manual `workboard_controller_tick` tool runs the normal notification/dispatch tick. It does not force an archive scan when `archiveScanIntervalMs` is not due.

## Dry Run And Status

When `archiveDryRun=true`, the scanner computes and stores bounded `archiveCandidates` but does not call `workboard.cards.archive`. Each candidate includes:

- `componentId`
- `cardIds`
- `titles` keyed by card id
- `reason`
- `eligibleAt`

Status also returns archive counters: `archiveScans`, `archiveCandidates`, `archiveActions`, and `archiveErrors`.

## Archive Actions And Failures

When `archiveDryRun=false`, candidates are archived one card at a time through `workboard.cards.archive`. Before acting on a candidate group, the controller re-lists cards and recomputes eligibility, so a reopened or newly blocked card prevents further action for that component in that scan.

Per-card failures are recorded in bounded `archiveLastFailures`, increment `archiveErrors`, and set `lastError`. Successful card archives increment `archiveActions`. A partial failure is never reported as whole-group success; already completed actions remain idempotent and the next due scan retries only remaining unarchived eligible cards.
