# Personal fork development

This checkout adds workspace-local sidebar session groups, a default-off
**Show sub-agent sessions** preference, and optional gateway-recorded spending.
It can run in development or as a separately packaged **Pi-Vis Personal.app**;
neither path replaces the installed `/Applications/Pi-Vis.app`.

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

## Standalone personal desktop app

The opt-in `electron-builder.personal.yml` extends the normal packaging rules
without changing the upstream build. It uses **Pi-Vis Personal**, bundle ID
`dev.pivis.personal`, and separate output under `release/personal/<version>/`.
Its packaged metadata selects `pi-vis-personal` under Electron's app-data
location (on macOS, `~/Library/Application Support/pi-vis-personal`) before
logging or acquiring instance locks. Finder/Dock launches need no environment
variables. An explicit `PIVIS_SETTINGS_DIR` still overrides the profile for tests
or development. The build directory's bundle and internal executable remain
`Pi-Vis` for compatibility with the existing final-artifact tools; the install
below names the separate bundle `Pi-Vis Personal.app`, with personal display and
runtime names.

Personal builds permanently disable app-update checks **and installation**,
including when a feed override is inherited. There is no personal release feed;
`publish: null` and `--publish never` prevent publication. Normal extension
package checks and Pi's provider configuration remain unchanged.

Build a locally ad-hoc-signed Apple Silicon app and run its final packaged
runtime, security-closure and main/SDK-host PTY checks before installing:

```sh
cd ~/github/pi-vis
npm run dist:personal
version="$(node -p "require('./package.json').version")"
bundle="$PWD/release/personal/$version/mac-arm64/Pi-Vis.app"
codesign --verify --deep --strict --verbose=2 "$bundle"
node scripts/verify-packaged-pty.mjs "$bundle"
```

The existing Mach-O-only signer seals the app with ad-hoc identity `-`; no
Developer ID certificate or Apple credentials are used. This avoids leaving
Electron's renamed bundle with an invalid linker signature. It is **not** a
Developer ID-signed/notarized release, and Gatekeeper approval for distribution
is not claimed. This directory build creates no DMG/ZIP, tags, GitHub release or
notarization. The full verification suite and signing/notarization/manual gates
in `RELEASING.md` are still required before claiming release readiness or
distributing it. Verify the copied app's strict signature too.

For a first install (do not overwrite a running personal app):

```sh
mkdir -p "$HOME/Applications"
test ! -e "$HOME/Applications/Pi-Vis Personal.app" &&
  ditto "$bundle" "$HOME/Applications/Pi-Vis Personal.app"
env -u ELECTRON_RUN_AS_NODE open "$HOME/Applications/Pi-Vis Personal.app"
```

Clearing `ELECTRON_RUN_AS_NODE` matters when invoking `open` from an
Electron-hosted coding-agent shell: otherwise LaunchServices inherits Node-only
mode and the app can exit before bootstrap. Normal Finder/Dock launches need no
such wrapper. Never carry test-only visibility/profile overrides into a real
launch.

The app runs independently of the terminal and source checkout. You can keep it
in the Dock. Rebuild and replace it manually for future fork changes, only after
quitting the personal app; upstream auto-updates cannot overwrite this fork.
The profile/history-sharing cautions above apply equally to standalone builds.
