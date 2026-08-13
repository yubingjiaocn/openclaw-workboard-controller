# Isolated Gateway E2E Smoke Test Report

Date: 2026-08-13 UTC  
OpenClaw: `2026.7.1-2 (0790d9f)`  
Plugin commit at test start: `b43c57b`  
Result: **PASS after one plugin bug fix**

## Scope and isolation

This was a real Gateway/Workboard/subagent run, not a store mock.

Official local docs were checked before startup:

- `docs/gateway/index.md` and `docs/gateway/multiple-gateways.md` require a unique `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, `agents.defaults.workspace`, and Gateway port for each concurrent instance.
- `docs/help/environment.md` confirms `OPENCLAW_STATE_DIR` overrides the default state root and `OPENCLAW_CONFIG_PATH` overrides the config file.
- `docs/cli/workboard.md` confirms `workboard.cards.dispatch` is the Gateway-backed path that starts subagent worker runs; local/data-only dispatch does not.

Isolated runtime:

- Temporary root: `/tmp/openclaw-wb-e2e-Z4Mq0U`
- State/config: `/tmp/openclaw-wb-e2e-Z4Mq0U/state` and its regular file `openclaw.json`
- Workspace: `/tmp/openclaw-wb-e2e-Z4Mq0U/workspace`
- Loopback port: `52569` (random unused high port)
- Bind: loopback only (`127.0.0.1` and `::1`)
- Auth: a newly generated independent token, kept only in a mode-0600 temp file/config and never printed or copied into this report
- Channels: none configured; process also used `OPENCLAW_SKIP_CHANNELS=1`
- Plugins allowed/enabled: bundled `workboard` and local path `workboard-controller` only
- Agent: one `main` agent in the temporary workspace
- Model: local LiteLLM provider `litellm-openai/gpt-5.6-sol`; no production auth-profile/state copy
- Agent tool policy: explicit Workboard/controller allowlist; no messaging tools and no external channel surface

Representative startup command (token value omitted):

```bash
OPENCLAW_CONFIG_PATH=/tmp/openclaw-wb-e2e-Z4Mq0U/state/openclaw.json \
OPENCLAW_STATE_DIR=/tmp/openclaw-wb-e2e-Z4Mq0U/state \
OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_GATEWAY_TOKEN='<independent temporary token>' \
openclaw gateway run --port 52569 --bind loopback --auth token --token "$OPENCLAW_GATEWAY_TOKEN" --verbose
```

The production config was never opened for writing. No systemd command was used and production Gateway PID 1493 was never stopped/restarted.

## Preflight

`npm run verify` passed before E2E: TypeScript build, 11 Vitest tests, and the project service-plugin validator.

Isolated config validation passed:

```text
Config valid: /tmp/openclaw-wb-e2e-Z4Mq0U/state/openclaw.json
```

Runtime plugin inspection reported `workboard-controller` as `loaded`, with both controller tools, one authenticated exact HTTP route, no diagnostics, and contract `gatewayMethodDispatch: ["authenticated-request"]`.

Gateway startup evidence (`gateway-1.log`, repeated on later starts):

```text
[plugins] loading workboard-controller from .../openclaw-workboard-controller/dist/index.js
[plugins] loading workboard from .../openclaw/dist/extensions/workboard/index.js
[gateway] http server listening (2 plugins: workboard, workboard-controller; 0.7s)
```

`GET /health` returned `{"ok":true,"status":"live"}`. There were no plugin version or Gateway auth errors.

## Real dependency dispatch

Using authenticated `POST /tools/invoke`, the test created:

- Parent: `c4725144-86ec-4718-ab01-db8a721fc3c2`
- Dependent child: `8c35302d-f094-4817-b0a6-1ab5e2847fb6`
- The child was created with the parent in `parents`, initially `todo`.

The parent was claimed and completed using the real `workboard_claim` and `workboard_complete` tools. Its terminal `completed` notification was consumed by the controller. Controller durable state recorded the event and advanced the Workboard subscription cursor:

- subscription: `f289ff1a-d936-4ba5-805d-ea654c131470`
- processed parent event: `9ab0c4b9-e518-4de7-aabb-fe0a93822bb5`
- controller counters advanced to `events=2`, `dispatches=2`
- `workboard_notify_events` after processing returned `events: []`; its subscription `lastEventId`/`lastEventSequence` had advanced

The child event history proves dependency promotion (`todo -> ready`) occurred in the real Workboard store. The controller used its authenticated self-route to call `workboard.cards.dispatch`, not the public data-only `workboard_dispatch` tool.

A first child had already been started before a tool-policy correction, proving the controller route started a real worker even in that failed attempt:

```text
status=running
sessionKey=agent:main:subagent:workboard-default-01ca20ea-fac4-4e1b-a08e-702629f1dd4f
runId=workboard:01ca20ea-fac4-4e1b-a08e-702629f1dd4f:1786613848025
workerLog="Dispatcher started subagent run ..."
```

That first attempt was blocked because `tools.profile=minimal` removes optional plugin tools before the final explicit allowlist. The isolated config was corrected to `profile=full` plus a restrictive explicit allowlist. This was a test-config issue, not a controller code defect.

After releasing the failed first attempt, the Gateway dispatch response for the target child was:

```json
{
  "count": 1,
  "started": [{
    "cardId": "8c35302d-f094-4817-b0a6-1ab5e2847fb6",
    "sessionKey": "agent:main:subagent:workboard-default-8c35302d-f094-4817-b0a6-1ab5e2847fb6",
    "runId": "workboard:8c35302d-f094-4817-b0a6-1ab5e2847fb6:1786613957636"
  }],
  "startFailures": []
}
```

The real embedded agent ran via local LiteLLM, called Workboard tools, added proof, and completed the child. Final card evidence:

- status: `done`
- linked sessionKey and runId exactly as above
- one attempt, status `succeeded`
- worker log: `Dispatcher started subagent run ...`
- proof label `Isolated E2E child execution`, note `isolated-E2E-child-ran`
- event chain includes `dispatch`, `claimed`, `ready -> running`, `linked`, `orchestration`, `heartbeat`, `proof_added`, and `running -> done`

Gateway log evidence includes a real model request with HTTP 200, Workboard tool calls, and:

```text
[agent/embedded] embedded run start: runId=workboard:8c353... provider=litellm-openai model=gpt-5.6-sol
[agent/embedded] embedded run tool start: ... tool=workboard_proof
[agent/embedded] embedded run tool start: ... tool=workboard_complete
[agent/embedded] embedded run done: ... aborted=false
Card completed successfully. Proof recorded: `isolated-E2E-child-ran`.
```

## Cursor and idempotency

After child completion, the controller consumed and advanced its completed event too. Durable state contained four unique processed event IDs total (including the controlled failure below), and Workboard notification reads returned no pending events.

Repeated manual controller ticks did not create another attempt for the child. Before and after the final Gateway restart:

```text
status=done
sessionKey=agent:main:subagent:workboard-default-8c35302d-f094-4817-b0a6-1ab5e2847fb6
runId=workboard:8c35302d-f094-4817-b0a6-1ab5e2847fb6:1786613957636
attemptCount=1
```

The card's `dispatchCount=3` includes two passes where the ready card was conservatively skipped while the same owner had active work plus the one actual worker start. Crucially, it has exactly one claim/start attempt and one linked run.

## Controlled failure and wake path

A separate card `3b0afbf1-4c2e-4b5a-99c1-01172d8cb777` was claimed and intentionally blocked with reason `controlled-isolated-e2e-failure`. Workboard emitted a real `failed` notification `093c3cc2-1ae4-4fbc-a11d-715b0a26eb4c`.

This exposed a real controller bug: it passed a routing key such as `agent:main:e2e-wake` as `runEmbeddedAgent.sessionId`; OpenClaw requires `sessionId` to be a transcript-safe identifier. The isolated Gateway failed that wake and exited with `Invalid session ID: agent:main:e2e-wake`.

Fix applied in this project:

- keep the routing value in `sessionKey`
- always generate an independent UUID for `sessionId`
- add a unit assertion that the routed key remains in `sessionKey` and `sessionId` is UUID-shaped

After rebuilding (`npm run verify`: 11/11 tests passed) and restarting only the isolated Gateway, the same durable failed notification replayed and succeeded:

```text
lane=session:agent:main:e2e-wake
[agent/embedded] embedded run start ... sessionId=2353bec4-69bb-431c-abc6-4a55d3e49cbc ... messageChannel=unknown
[agent/embedded] embedded run done ... aborted=false
```

Durable controller state then showed:

- `processedEventIds` includes the failed event
- `notifiedProblemIds` includes `failed:093c3cc2-1ae4-4fbc-a11d-715b0a26eb4c`
- `wakes=1`

Because the isolated instance had no external channels by design, the wake was recorded/routed only to session `agent:main:e2e-wake`; no external delivery was possible or attempted. This is the expected no-channel behavior.

The durable `errors=1` counter is the preserved evidence of the pre-fix failed wake. No post-fix wake error occurred.

## Restart persistence

The isolated Gateway was terminated and started again on the same isolated state/port. Before versus after restart and another explicit tick:

- subscription ID unchanged: `f289ff1a-d936-4ba5-805d-ea654c131470`
- processed event IDs unchanged (same four IDs)
- notified failed problem ID unchanged
- semantic counters unchanged: `events=4`, `dispatches=4`, `wakes=1`, `errors=1`
- only `ticks` advanced (`146 -> 155`)
- successful child remained `done` with the same sessionKey/runId and `attemptCount=1`
- restart log contained no second embedded run for that child

This proves controller cursor/state persistence and no duplicate dispatch/start across restart.

## Commands and evidence files

All commands used the isolated `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR`. Main command classes:

```bash
openclaw config validate
openclaw plugins inspect workboard-controller --runtime --json
openclaw gateway run --port 52569 --bind loopback --auth token ...
curl -H 'Authorization: Bearer <temporary token>' -d '{"tool":"workboard_*",...}' http://127.0.0.1:52569/tools/invoke
openclaw gateway call workboard.cards.dispatch --url ws://127.0.0.1:52569 --token ... --expect-final --json
npm run verify
```

Detailed raw evidence remained under `/tmp/openclaw-wb-e2e-Z4Mq0U` during the test, including `gateway-1.log` through `gateway-4.log`, controller states, card reads, dispatch response, and restart before/after snapshots. This directory contains the temporary token/config and is intentionally not committed.

## Cleanup and production invariants

The last isolated Gateway process was explicitly terminated. Final checks:

- isolated port `52569`: no listener
- no matching isolated Gateway process
- production Gateway listener: unchanged on `0.0.0.0:18789`
- production Gateway PID before/after: `1493`
- production config SHA-256 before/after: `0304d43567dd295059c62b41408ade7733f1443eb7ed1537e6b3b1dda1ff52c9`
- no production Gateway restart/stop command and no systemd mutation
- production Workboard/plugin SQLite was never selected because every CLI/Gateway process used the temporary state root

One OpenClaw CLI migration quirk was observed during isolated runtime inspection: despite the explicit temporary state root, it renamed the production `~/.openclaw/exec-approvals.json` to `.migrated`. This was detected immediately and restored byte-for-byte before Gateway testing; production config, Gateway process, ports, and SQLite state were not changed. No further isolated command performed that migration.

## Conclusion

The plugin passed the requested real isolated smoke test after fixing the wake `sessionId` bug. A terminal parent completion advanced the durable notification cursor, promoted its dependent child, and the controller's authenticated `workboard.cards.dispatch` route started a real subagent with linked sessionKey/runId. The worker completed the card with persisted proof. Repeated ticks and a Gateway restart did not start it again. A controlled failed event invoked and persisted the no-channel session wake exactly once after the fix.
