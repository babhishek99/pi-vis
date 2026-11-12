# Active-tab agent activity

The header's **Agents in this tab** tray is a bounded, read-only observation of
one captured runtime's `pi-subagents` extension. It does not replace tools,
management dialogs, the session's semantic authority, or cancellation. It never
reconstructs liveness from transcripts, persisted history, lifecycle events, or
a process-global manager registry. Sidebar child hiding remains an independent,
conservative saved-history presentation preference.

## Owner-bound read path

- `src/shared/pi-protocol/commands.ts` and `runtime-state.ts` declare the strict,
  parameter-free `{ type: "get_subagent_activity" }` read, with `same_owner`
  policy. It travels through the existing typed `session.query`, not a new
  generic extension-call or mutation channel.
- `SessionRegistry.query` captures the record/process and expected host/epoch,
  waits for that owner to be available, and rechecks it after the read. It never
  activates a cold host, retries a callback against a successor, or reduces the
  result into canonical session state.
- The bridge handles this query before semantic admission, `activeCommands`,
  or normal command-finally publication. It captures the actual `AgentSession`
  and authority epoch before extension callbacks/awaits, and rejects a changed,
  transitioning or closing owner afterward. The read publishes no semantic
  frame or synthetic activity, including on transition refusal.
- The runtime factory creates clients on that runtime's public Pi `EventBus`
  and associates them privately with its captured session in a `WeakMap`.
  `subagent-activity.mjs` requires protocol **4** and capability
  **`activitySnapshot: 1`**, then requests
  `subagents:rpc:activity-snapshot` with only a UUID `requestId`. Each scoped
  listener has a 250 ms unref'd deadline and is removed on every outcome.
  `SessionHost` separately imposes a 2,000 ms command deadline.
- The host validates and copies bounded plain display data before child IPC;
  `SessionHost` and the shared result schema revalidate it. Unknown fields,
  accessors, invalid relationships/counts, oversized data, and private errors
  are not forwarded as successful observations. A failed child response becomes
  sanitized `{ status: "failed" }`, not an extension error object.

Results are `ready` with snapshot v1, or `unavailable`, `unsupported`, or
`failed`. Registry lifecycle cuts additionally return their existing typed
query outcomes. Every non-ready outcome is **unknown**, not zero, idle,
completed, or evidence that requested cancellation settled. `observedAt` is an
observation time, not an authority cursor or a liveness lease.

## Bounded contract and provenance

Limits are shared with the host in `subagent-activity-limits.mjs` / `.d.mts` and
validated by `src/shared/pi-protocol/subagent-activity.ts`:

| Item | Bound |
|---|---|
| Emitted agents / workflows | 128 / 32 |
| IDs | 128 UTF-16 code units, nonblank |
| Names and agent types | 80 UTF-16 code units |
| Authored task summaries | 240 UTF-16 code units |
| Phases | 120 UTF-16 code units |
| Serialized snapshot | 512 KiB UTF-8 |

Arrays are capped before visiting their elements. All records are strict,
control-free plain data; counts/times are nonnegative safe integers. Coherence
requires unique IDs, visible per-state counts within full counts, exact
visible-plus-omitted totals, raw/display status agreement, and no known-parent
cycles. Missing ancestors remain valid because they may be omitted or evicted.
A manager row has `recordId === id`; a pre-record workflow call has null
`recordId`, a real workflow ID and no invented parent agent.

The extension scans retained plus actual in-flight records and cached collapsed
workflow progress. It counts all retained work before applying live-first display
budgets; omissions remain explicit. Display formatting/materialization is
bounded, but full retained-reference/ID/progress scans remain. This is not a
constant-time or constant-total-memory interface or a complete history API.

Only authored descriptions, explicit workflow labels (including safe same-run
resume labels), metadata names/descriptions and phase titles enter display text.
Unlabeled calls have type-based presentation and an empty task, not a prompt
prefix. Legacy prompt-derived workflow labels and direct/model mention
descriptions stay out, including after tombstone eviction/reopen. No prompt,
result, script, args, runtime path, usage, credential, private metadata, or private
error field exists in the projection. Explicit display labels are authored text,
not a general-purpose secret scrubber.

## States and relationships

Agents distinguish `running`, `starting`, `queued`, `unwinding`, and `finished`.
Queued pre-record workflow work requires `queuedAt != null && startedAt == null`;
missing timing means starting. Only a call for which no manager record has yet
been issued can have a synthetic display ID. Once issued, the real retained or
in-flight record owns liveness: stale workflow progress cannot resurrect a
settled, evicted record. Resume reports accepted record ownership before waiting
for completion, avoiding a transient double count.

A terminal record still in flight remains **unwinding** through actual cleanup,
even if ordinary completed-record eviction removed it. Workflows distinguish
`running`, `paused`, `stopping`, and `finished`; an aborted live/paused task is
stopping, not finished. Separate pending-preparation, aborted-operation cleanup,
and held-notification flags cover evidence with no agent row. Future schedules
are not enumerated, disabled or counted as current work.

The renderer attaches an agent to its actual parent first, otherwise its actual
workflow, otherwise the root. Missing-parent/workflow notes stay explicit; no
ancestor is fabricated. Nested `workflow()` calls share their real task and
scoped phases instead of becoming invented workflow tasks. Finished siblings
follow live siblings, and visual indentation is capped without flattening the
actual nested DOM relationships.

## Renderer leases and UI ownership

`useAgentActivity` keeps samples locally, tagged by exact visit/owner lease. A
layout-effect store subscription synchronously retires that lease on active-tab,
availability, semantic-following or host/epoch boundaries. A local revision
survives React-coalesced A→B→A or unavailable→available cuts with equal final
props; an old reply can never paint the returned visit. Reads are serial within
a lease: the next poll is scheduled 2 seconds after a ready result or 5 seconds
after an unknown result settles. Focus/visibility and explicit retry can refresh
that same lease. Retired outstanding requests may finish, but cannot repaint it.
Timers/listeners retire on cleanup. Results never enter the session-store reducer.

`AgentTray` mounts in common full/compact `SessionControls`, beside model,
thinking, context and spend controls. Its count includes running, starting,
queued and unwinding agents, with active/paused/stopping workflow counts beside
it. Unknown shows `?`; preparation/cleanup without an agent shows `…`, not an
invented agent count. The card includes state totals, retained terminal rows,
shortening/omission notes and observation time, not a claim of complete history.

The raised semantic-token card is portalled to body and fitted to the actual
trigger and available viewport. Its header/footer stay outside the one padded
native vertical list scroller; `ScrollFadeFrame` supplies sibling overflow fades
without covering the shared scrollbar lane. All rows and omission notes remain
reachable at the 480×400 minimum in light/dark modes. Names use `FadeText`, tasks
and phases wrap, and only running/starting/unwinding/stopping rows get the shared
accent rotor. Failure uses danger; there are no card-edge accent rails.

Opening from the trigger focuses the scroll list. Close/Escape restores the
trigger; outside pointer/focus dismissal does not steal the new focus. The tray
holds a layout-effect normal `useEscapeClaim(open)` token and dismisses only if
that exact token is the newest normal claim. The first bare, non-IME Escape
closes it **without cancelling work**. Only a later unclaimed Escape may reach
the existing direct owner-fenced `session.escape`. Routed terminal claims remain
exclusive; modifiers, IME, dialogs, editors and drag cancellation keep their
existing ownership. Read retry is the tray's only runtime action.

See [testing](../testing.md#agent-tray-coverage) for browser, owner-race, validation,
and production-source two-tab gates. Source integration does not install,
publish, restart, reset, reload, or replace an app or extension.
