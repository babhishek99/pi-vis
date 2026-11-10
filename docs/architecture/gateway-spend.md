# Gateway-recorded spend (personal fork)

This optional subsystem reads **recorded USD costs from gateway audit logs**.
It never prices tokens, uses Pi's catalog-derived `stats.cost` as a receipt, or
claims provider-invoice reconciliation. It is separate from AgentSession's
semantic authority, transcript, and model context. Installing or running this
fork does not replace the installed Pi-Vis application.

## Private launch configuration

Configuration is opt-in and main-only: `<userData>/gateway-spend.json`. For the
recommended personal launch, that is the directory selected by
`PIVIS_SETTINGS_DIR`, not the installed app's normal profile. Changes take effect
on the **next app launch**; already-running hosts retain one consistent scope.
There is no query, executable, identity or gateway-URL editor in the renderer.

Example (replace deployment-specific values locally; never commit them):

```json
{
  "version": 1,
  "pupExecutable": "/absolute/path/to/pup",
  "auditQuery": "service:my-gateway env:my-environment \"audit trail message\"",
  "userEmail": "person@company.example",
  "gateways": [
    {
      "provider": "my-gateway-openai",
      "baseUrl": "https://gateway.example/api/v2/providers/openai/v1"
    }
  ]
}
```

Keep this file private (`0600`). Use the existing authenticated Datadog `pup`
installation; Pi-Vis never copies, parses or publishes its OAuth credentials.
The executable must be absolute and runs without a shell. Provider URLs must be
credential-free HTTPS; explicit HTTP `127.0.0.1` endpoints are allowed for local
fixtures/development, never arbitrary remote HTTP or DNS loopback aliases. Missing configuration makes
both surfaces invisible and leaves the SDK runtime unchanged. Invalid
configuration shows a fixed unavailable reason, not private parser output.

The deployment contract is the personal **legacy gateway** audit schema:
`@cost` is USD, `@user_email` identifies the user, `@key_type:personal` scopes
personal keys, and custom tags are indexed under `@custom_tags`. Main wraps the
local base query in parentheses and independently appends the validated personal
identity/key constraints. This is **all harnesses and personal keys in that audit
source**, not all AI subscriptions or traffic to a different/new gateway.

## Main-process reads and cache

`src/main/gateway-spend/` owns strict launch configuration, bounded subprocesses,
Datadog validation, coalescing, rate limits, and a disposable private cache.
Typed `gatewaySpend.month` and `gatewaySpend.session` invokes return only the
bounded billing read model from `src/shared/gateway-spend.ts`.

- The month is the **previous completed UTC calendar month**, with an exclusive
  end. Main converts that end to Datadog's inclusive final millisecond; it never
  requests a rolling thirty-day interval or silently applies the machine's local
  timezone. The UI exposes both boundaries and `UTC`.
- Each refresh uses `pup --read-only --no-agent --output=json logs aggregate`
  against `flex` storage. One query computes `count,sum(@cost)` for priced
  records; another counts records missing `@cost`. Both must complete without
  warnings, timeout, unexpected groups/paging, malformed or negative values.
- The queries are eventually consistent source reads, not an atomic billing
  transaction. Late audit ingestion/pricing can change a later snapshot. A zero
  priced-record count is **no priced records**, not a known `$0`. Explicit
  zero-cost records can legitimately sum to `$0`; missing-price records make
  totals partial.
- Repeated reads replace snapshots; amounts are never incrementally added from
  Pi events, client nonces, retries, or copied history. The source's per-request
  audit records have the same aggregation semantics as its budget dashboard.
- A sixty-second minimum refresh interval is enforced in main, including manual
  refresh. Month cache TTL is one hour; session TTL is two minutes. The renderer
  refreshes the monthly widget hourly and at the UTC month boundary, fencing the
  previous reporting generation immediately. A session is read only on card
  opening or explicit refresh—never per streamed token. Session query bounds are
  captured at queued-job dispatch, not admission; their as-of/freshness follows
  that coverage upper bound rather than granting query delay a fresh TTL.
- Reads for one key share one flight. At most eight distinct keys are admitted
  to a serialized queue; one job owns at most two bounded CLI processes. Both
  captures settle before another job starts, including partial failures. Each
  capture has a sixty-second deadline and 128-KiB combined output limit.
- An abortable bounded capture owns process-tree cleanup. App teardown aborts
  active queries and prevents queued jobs from starting. No billing subprocess
  should outlive application shutdown.
- Cache files live under `<userData>/gateway-spend/v1/<config hash>/cache.json`
  (`0600`, temporary file plus atomic rename). Only 128 aggregate snapshots are
  retained in memory/on disk. Identity/source configuration hashes partition
  caches, so changing account or query cannot reuse another scope's amount.
  Cache read/write failures cannot become a fabricated zero.
- CLI stderr, raw logs, tokens, queries, internal URLs and session paths never
  cross billing IPC. Failures use fixed reason codes. Last good values remain
  visibly **stale** with their as-of time and the error; no prior month is reused
  for a newly completed month.

## Prospective direct-session attribution

`resources/pi-session-host/gateway-spend.mjs` decorates the **public**
`ModelRuntime` request methods before a session is constructed. Non-request
methods remain bound to the original instance. No SDK source patch, private
import, provider replacement, global-fetch patch, header-only hook, or second
live-state authority is introduced.

Pi 1.4.0's `before_provider_headers` exposes no destination, and `ctx.model` can
be virtual or auth-overridden. It is therefore insufficient for safe tagging.
For configured providers using the supported **OpenAI Responses HTTP** adapter,
the decorator supplies the public `options.fetch`. Only that transport callback,
after checking the **actual request URL's exact origin and provider-base path
boundary**, may add attribution. An auth override or unrelated URL passes through
unchanged. Existing custom fetch implementations, unsupported APIs, and option
dictionaries that cannot be copied without losing inherited/accessor/non-enumerable
behavior remain untracked and unchanged. Tagged requests use `redirect: "error"`,
so redirects cannot forward
custom attribution to another destination; a gateway that redirects needs an
explicitly corrected base URL rather than an automatic credential/tag forwarding
fallback.

The header preserves `harness` and unrelated custom tags and adds:

- `pivis_session`: SHA-256 of the exact UTF-8 public
  `SessionManager.getSessionId()` string. No paths/names/prompts are transmitted.
- `pivis_call`: an opaque invocation nonce, **not a gateway request/charge ID**.
  HTTP retries can reuse it; it must never deduplicate gateway charges.

Before sending tags, the host durably establishes a private metadata-only marker
at `<scope>/tracking/<session tag>.json`:

```json
{ "version": 1, "sessionTag": "<sha256>", "trackedSince": "<ISO UTC>" }
```

Publication must preserve an existing earliest valid marker and must not
clobber malformed bytes. A marker failure leaves the original model request
working **without attribution**, rather than failing a user turn. No marker,
header, cost, or instrumentation entry is appended to conversation JSONL.

Main obtains the matching UUID only from the bounded header of the **registry's
known session file**; the renderer cannot supply a path or query. File transitions,
closing/dead/recreated records, or header identity changes fence delayed responses,
including the interval before asynchronous host retirement deletes a record.
Resume/reload/tree navigation retain direct billing identity; new/fork/clone
sessions have new UUIDs, and copied messages do not create additional charges.
Direct totals include that UUID's tracked requests across branches. There is
**no parent/child rollup**, and grouping/hiding a sidebar row changes no cost.

Coverage is always **Partial · Tracked since …**. Other APIs, classifier/image
calls, arbitrary extension-side requests, external subagents and extension-disabled
clones are not guaranteed to use this decorated transport. Compaction/cache
warming is covered only when it uses the same supported public request path.
Historical sessions without a marker say **Not tracked**, never an inferred
amount. A marker proves prospective tagging began, not complete lifetime coverage;
no records yet means **Awaiting audit logs**, not free work. A separate profile or
lost marker starts a new partial tracking window, not a historical backfill.

## Presentation and verification

The sidebar shows the completed-month aggregate above its footer. Its details
expose source/scope, exact UTC range, record counts, as-of/stale/error information
and bounded refresh. The ContextMeter details include a separately labeled direct
session section; they do not change the context gauge or Pi statistics. Its open
card refits to its clipping pane after control-row/font changes and sidebar
resizing, with one bounded vertical scroll owner. Both surfaces use semantic
theme tokens and the app's existing focus/Escape conventions.

Focused unit tests cover boundaries, config privacy, no-record versus explicit
zero, malformed/partial responses, scope-isolated cache/restarts, request
coalescing/rate limits, errors/staleness, tracking metadata and transition fences.
Host tests exercise transport URL checks, redirects, stable identities, marker
failures and the pristine pinned SDK against a loopback provider. Render tests
exercise loading, unavailable/partial/zero/stale states and keyboard/geometry in
light/dark modes. Isolated Electron coverage uses a fake read-only CLI and checks
real IPC/cache restart behavior and unchanged fixture JSONL. No tests query real
billing data or spend provider credits. The opt-in browser `?spendDemo=1` likewise
uses only synthetic data.
