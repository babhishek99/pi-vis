# Important paths

| Path | Purpose |
|---|---|
| `resources/pi-session-host/host.mjs` | SDK-host subprocess entry; the sole live `AgentSession` authority. |
| `resources/pi-session-host/state-authority.mjs` | Direct snapshots, submission admission/custody, escape, queue restoration, and atomic transitions. |
| `resources/pi-session-host/state-authority.test.mjs` | Fault-injection regression coverage for authority protocol. |
| `resources/pi-session-host/bridge.mjs` | Public SDK command/event bridge and runtime rebind wiring. |
| `src/main/diagnostics.ts` | Synchronous rotating diagnostic sink plus main-process console and fatal-error capture. |
| `src/main/diagnostics.test.ts` | Diagnostic formatting, rotation, file-permission, and failure-isolation coverage. |
| `src/main/index.ts` | Electron bootstrap and renderer/Electron-child/Crashpad diagnostic wiring. |
| `src/main/pi/session-host.ts` | Child-IPC wrapper, host envelope identity/sequence validation, and resync fencing. |
| `src/preload/index.ts` | Typed renderer bridge and uncaught renderer-error reporting. |
| `src/main/sessions/session-registry.ts` | Snapshot lease/availability, lifecycle, activation-visit retirement, acknowledgements, and two-phase close; it has no fixed process-cap refusal. |
| `src/main/sessions/session-search/` | Planned worker-owned persisted-JSONL catalog, disposable SQLite index, query, and exact read-only context implementation. |
| `src/main/ipc.ts` | Typed renderer↔main handler registration and host event forwarding. |
| `src/main/gateway-spend/` | Optional read-only Datadog audit aggregates, private launch config, cache and rate limits. |
| `src/shared/gateway-spend.ts` | Bounded spend IPC read model and completed-UTC-month helper. |
| `resources/pi-session-host/gateway-spend.mjs` | Public-transport destination-gated prospective direct-session tagging. |
| `<userData>/gateway-spend.json` | Private opt-in deployment/identity configuration; never renderer settings. |
| `<userData>/gateway-spend/v1/` | Scope-hashed aggregate cache and metadata-only tracking markers; no transcripts. |
| `docs/architecture/gateway-spend.md` | Source scope, safety, coverage, privacy and refresh contract. |
| `src/shared/ipc-contract.ts` | Typed IPC boundary. |
| `src/shared/pi-protocol/runtime-state.ts` | Snapshot, disposition, transition, escape, and runtime-state schemas. |
| `src/renderer/src/stores/sessions-store.ts` | Renderer projection of runtime authority plus presentation state. |
| `src/renderer/src/lib/commands/` | Composer parsing and command/submission dispatch. |
| `src/renderer/src/stores/tree-store.ts` | Conversation tree state and host capability handling. |
| `tests/fixtures/fake-host-process.mjs` | Deterministic SDK-host child-process test harness. |
| `tests/fixtures/fake-pi.mjs` | Version/update test executable; not a session runtime. |
| `~/.pi/agent/sessions/` | Persisted session JSONL history. |
| `~/Library/Application Support/pi-vis/settings.json` | Pi-Vis settings. |
| `<userData>/diagnostics.log` | Rotating main, renderer, Electron-child, and SDK-host error diagnostics; the previous file is `diagnostics.log.1`. |
| `<crashDumps>/` | Local Electron Crashpad minidumps for native process crashes; uploads are disabled. |
| `<userData>/session-search/v1/` | Disposable private SQLite search index; JSONL remains authoritative. |
| `tests/e2e/electron-launch.mts` | Electron E2E launcher and cleanup integration. |
| `RELEASING.md` | Packaging, signing, and release instructions. |
| `docs/architecture/session-search.md` | Persisted workspace-search boundaries, context, worker lifecycle, corpus, and performance gates. |
| `docs/decisions/0002-workspace-session-search.md` | Binding workspace-search decision and 17 invariants. |
