# Personal fork development

This checkout adds workspace-local sidebar session groups and a default-off
**Show sub-agent sessions** preference. The implementation is source-level; it
has not replaced the installed `/Applications/Pi-Vis.app`.

## Run safely alongside the installed app

For a UI-only sandbox with synthetic sessions and no model requests:

```sh
cd ~/github/pi-vis
npm ci
npm run dev:renderer
```

Open the local URL printed by Vite and append `?sidebarDemo=1` (normally
`http://localhost:5173/?sidebarDemo=1`). This adds synthetic saved sessions for
moving between groups and an example generated child for the visibility toggle.
The initial demo conversation and newly messaged preview sessions also have
synthetic file keys so their group/pin controls work; opening a saved demo keeps
its name. These keys never create files.
The preview uses `preview-stub.ts`, not your real sessions, credentials, or
gateway. Its settings live in memory and reset on page reload; use the isolated
Electron sandbox below to test persistence across restarts.

For the real Electron app, use a separate Pi-Vis profile:

```sh
cd ~/github/pi-vis
PIVIS_SETTINGS_DIR="$HOME/Library/Application Support/pi-vis-personal" npm run dev
```

`PIVIS_SETTINGS_DIR` isolates the app settings, Chromium data, search index,
diagnostics, and single-instance lock. It does **not** isolate Pi's provider
configuration, extensions, or session history: those still use your normal Pi
agent directory. Add the desired workspace in the new profile. Do not open the
same saved conversation for mutation in both apps at once; Pi-Vis's advisory
session locks coordinate its own hosts, not arbitrary external writers.

To experiment with a completely throwaway runtime instead, set all three paths
alongside `PIVIS_SETTINGS_DIR`:

```sh
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/pi-vis-personal.XXXXXX")"
mkdir -p "$sandbox/app" "$sandbox/agent" "$sandbox/sessions/bucket"
PIVIS_SETTINGS_DIR="$sandbox/app" \
PI_CODING_AGENT_DIR="$sandbox/agent" \
PI_CODING_AGENT_SESSION_DIR="$sandbox/sessions/bucket" \
PIVIS_SESSIONS_DIR="$sandbox/sessions" \
npm run dev
```

The final two variables must agree: the Pi runtime writes to the bucket, while
Pi-Vis discovery scans its parent for one-level session buckets. This sandbox
does not copy your file-backed providers, credentials, or extensions. Shell
environment variables are still inherited, so this is not a credential sandbox;
use the renderer preview for guaranteed model-free UI work. No copying of
credentials is required for renderer previews or automated tests.

Use `npm run test:full` for the repository's typecheck, lint, unit, renderer, and
Electron gates. These tests use synthetic or loopback providers rather than paid
model calls by default.

## Organize sessions

- Use the folder-plus action beside **New session** to create a group.
- Drag a file-backed session onto a group header/section to move it, or onto
  **Ungrouped** to remove its assignment. Collapsed destinations open on drop;
  empty Ungrouped stays available. Only same-workspace drops are accepted.
- Alternatively, use the row's folder action to choose a destination with the
  keyboard, return it to **Ungrouped**, or create-and-assign a new group.
  Unsaved/pathless sessions in the real app must acquire a saved file first.
- Collapse, rename, or remove groups from their headers. Removing one keeps all
  its sessions. Pins keep their order within each section.
- In Settings → Interface, enable **Show sub-agent sessions** when needed.
  Recognition is deliberately conservative: a parent reference plus a generated
  `name#<8 hex>` suffix. Ordinary forks, renamed children, and legacy files without
  lineage are not hidden by guesswork. Long histories also stay visible when
  bounded sampling cannot rule out an unread rename. Hiding does not stop any agent.
- A session awaiting a Pi input dialog or blocking custom panel shows a yellow/amber
  **Needs attention** triangle, even while the requesting tool remains in flight.
  Ordinary working dots and active-session highlights keep their normal accent.

See [sidebar semantics](architecture/sidebar-shell-layout.md) for the persisted
shape, active-child exception, pagination, and focus behavior.

## Gateway-recorded costs

The optional Datadog adapter uses an existing authenticated `pup` CLI to read
personal legacy-gateway audit costs. Create the private, launch-scoped
`gateway-spend.json` in **this personal profile** using the schema/example in
[Gateway-recorded spend](architecture/gateway-spend.md). Use an absolute CLI path
and your own source query/identity/gateway allowlist; no credentials belong in
this file. Restart the personal fork to load it. Do not configure the installed
app's profile or change your normal Pi provider settings.

- The sidebar total is the **previous completed calendar month in UTC**, across
  all harnesses/personal keys in that gateway source. Open it for exact bounds,
  source/scope, record counts, refresh and as-of/error/stale information. It is
  not an all-subscription total or provider-invoice reconciliation.
- Open the title-bar context ring for **direct session gateway spend**. Supported
  OpenAI Responses requests are tagged prospectively only after their actual
  destination matches the configured gateway; redirects cannot forward tags.
- Session coverage is always **Partial**, with **Tracked since …**. Other APIs,
  arbitrary extension calls and external subagents may be untracked. Children
  are excluded; there is no double-counting parent rollup.
- Older sessions without attribution say **Not tracked**. Newly tracked sessions
  with no audit records say **Awaiting audit logs**. Missing/failed/unpriced data
  never becomes a guessed `$0` or a model-catalog estimate. Real zero-cost
  records can legitimately show zero; positive sub-cent amounts stay distinct.
- Refresh is cached and bounded (sixty-second minimum, hourly monthly refresh).
  A failed read retains the last good value visibly stale, never as current.

Attribution markers and the aggregate cache live only under the personal profile;
no session history is rewritten, and no model request is made by cost reads.
`?spendDemo=1` in the browser preview supplies synthetic cost data without real
Datadog access, just as `?sidebarDemo=1` supplies synthetic saved rows. The two
flags can be combined for UI-only exploration.

Keep credentials and gateway access in main/host code, not the renderer or session
history. This fork is public: do not commit private gateway URLs, credentials,
request logs, or user-specific billing data. Deployment-specific values remain
in local configuration.

## Packaging later

Development mode is the safe starting point. Before installing a separately
branded build, choose its app name, bundle ID, profile location, and release/update
feed in `electron-builder.yml` and the app-update configuration. Do not publish
or install a personal package that can silently update itself from the upstream
Pi-Vis feed. Packaging/signing instructions remain in `RELEASING.md`.
