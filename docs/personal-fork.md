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
- Use a saved row's folder action to move it into a group, return it to
  **Ungrouped**, or create a new destination.
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

## Live gateway costs: pending API contract

No gateway billing adapter or actual-cost UI is implemented yet. Before adding
one, establish:

1. The gateway's supported usage/cost endpoint or event stream, authentication
   mechanism, refresh limits, retention, and permission scope.
2. A stable request ID and a supported way to attach the Pi session ID and
   parent-session ID to requests, including sub-agents, summarization, tool-side
   model calls, and retries. Do not infer attribution from names or time windows.
3. The authoritative cost field, currency/unit, billed-versus-provisional state,
   cache accounting, and whether responses are cumulative or request-level.
4. A deduplication/reconciliation contract across retries, paging, relaunch, and
   final gateway settlement. Copied conversation history is not new billed usage.
5. A UI contract: show direct session spend and any child rollup separately,
   distinguish gateway charges from estimates, and expose pending/stale/error
   states with an as-of time. Missing data must never appear as a known `$0`.

Keep credentials and gateway access in main/host code, not the renderer or session
history. This fork is public: do not commit private gateway URLs, credentials,
request logs, or user-specific billing data. Keep deployment-specific values in
local configuration.

## Packaging later

Development mode is the safe starting point. Before installing a separately
branded build, choose its app name, bundle ID, profile location, and release/update
feed in `electron-builder.yml` and the app-update configuration. Do not publish
or install a personal package that can silently update itself from the upstream
Pi-Vis feed. Packaging/signing instructions remain in `RELEASING.md`.
