# Sidebar and shell layout

### Workspace session search

When saved-session search is available for the current launch, every workspace row has a quiet `.icon-btn` search action immediately left of its collapse chevron; both actions are revealed on workspace hover or keyboard focus and collapse horizontally at rest without reserving name width. The default-on Settings toggle takes effect after restart; a disabled launch has neither row actions nor the global shortcut and starts no background search worker. It uses the shared search icon, stops row-click propagation, and neither activates nor expands/collapses that workspace. `Cmd/Ctrl+Shift+F` opens the same modal for the active workspace. The modal searches saved history scoped to that workspace and known worktrees; preview is read-only and does not activate a session. Only **Open session** uses the existing normal session-open/activation-visit path. See [workspace session search](session-search.md).

### Workspace sidebar ordering & expand state

The sidebar renders workspaces in **manual order** — the user drags a hover-revealed
grip handle on a workspace row to reorder, and the new order is persisted to
`settings.workspaceOrder` (`src/shared/settings.ts`). Ordering is **stable across
restarts**: nothing reorders workspaces on close/reopen. Cold boot restores
`settings.lastActiveWorkspace` only after the full ordered workspace list has
loaded, so seeing an earlier workspace first cannot consume the one-shot restore
before the most-recent workspace is present. `lastActiveWorkspace` is updated by
explicit user workspace activation, including workspace headers, live/stored
session rows, and `+ New session` — not just by header clicks. A newly-picked workspace
(via `+` → Open Workspace) is **appended to the bottom** and **auto-expanded** —
never prepended to slot 0 (the old `recentWorkspaces` recency-sort behavior was
dropped because ambient activity mutating order is a bug, not a feature). The main
process (`src/main/workspaces.ts`) prunes paths that no longer exist on disk on read,
without reordering survivors (pruning ≠ reordering).

**Multiple workspaces can be expanded simultaneously** (`settings.expandedWorkspaces`):
each workspace header has a chevron that toggles its session-list visibility
independently, so the user can monitor recent sessions across workspaces at once.
Expand state is decoupled from the active workspace: clicking the header **activates**
a workspace (sets focus + opens/switches to a session in it) and **never collapses**
it — collapse is via the chevron only, so an active workspace can stay expanded while
the user works in another expanded one. `activeWorkspacePath` (focus/active CSS) and
`expandedWorkspaces` (session-list visibility) are independent concerns in
`sessions-store.ts`; `setActiveSession` derives `activeWorkspacePath` from the session's
workspace. The `workspace.list` IPC channel (renamed from `workspace.recents`)
returns the ordered, existence-pruned list.

**Pinned sessions** (`settings.pinnedSessions`, a global array of session-file paths):
a pinned row floats to the TOP of its containing session group (or the ungrouped
list), above activity-sorted peers, in persisted manual order. Each row has a pin button (hover-
revealed when unpinned, always-visible accent-filled when pinned); pinning appends
to the array (lands at the bottom of the pinned group), and pinned rows are
HTML-draggable to reorder within the group (only same-section pinned-row drops
reorder pins). Dropping onto another section instead moves group membership and
leaves the global pin order unchanged. The array is global across workspaces — each
workspace view renders only its own keys in their relative order. Keyed by file
path (stable across relaunch and shared by the live row and its stored counterpart,
so a pin survives the live→stored idle-eviction transition). Stale keys are filtered
at render, not pruned, matching `archivedSessions`' trade-off. Each section is
paginated independently from the front, so newer unpinned peers cannot push its
pinned rows off that section's first page. A collapsed group remains collapsed.

Unpinned activity order advances from an authoritative delivered user message,
using the message's authored timestamp. Merely opening or reattaching a saved
session never promotes it, while sending new work in an older session moves that
row to the top as soon as Pi delivers the user message.

**Archiving requires explicit confirmation.** The hover-revealed archive action on
both live and stored session rows opens the app-owned `ConfirmDialog` before any
settings or session mutation. The dialog names the selected session, explains that
the file remains on disk but Pi-Vis has no in-app restore flow, and defaults focus
to **Cancel**. Escape and backdrop click cancel without leaking Escape to the active
session; cancel restores focus to the invoking archive button. While confirmation
is being applied, the dialog stays mounted with disabled actions. Confirming follows
the existing archive path: persist the file key in `archivedSessions`, close a live
tab when present, then refresh the workspace session list. Focus then returns to the
original button if the operation failed and its row survived, or to the nearest
surviving session/new-session control after a successful archive.

Each live session row also exposes **Force restart host** immediately beside
Archive, including when its host is starting, failed, or unavailable. Its
danger-toned app-owned confirmation defaults focus to Cancel and states that
running work is interrupted while saved conversation history remains. Confirm
invokes the unconditional main-owned hard restart; it never requires a following
authority plane or an idle host. Dialog focus, Escape, and backdrop behavior
follow the archive convention. Confirmation closes the dialog immediately and
leaves restart reachable during successor startup; startup failures surface through
the ordinary session status and a toast.

### Session groups and sub-agent visibility

The **Create session group** folder action beside **New session** creates a named
workspace-local section. Groups render in saved creation order above **Ungrouped**.
Each header has an independent disclosure, session count, and hover/keyboard-focus
rename/remove actions. Removing a group immediately returns its sessions to
Ungrouped; it never archives, closes, deletes, or rewrites a session. Empty groups
remain available as destinations.

Any file-backed live or stored row can be dragged onto a group header or anywhere
inside a different section of the same workspace. Valid targets highlight using
semantic surface/accent tokens. Dropping onto a collapsed group opens it and
immediately reveals the moved row's page; **Ungrouped** remains a visible drop
destination even when empty. Drops reuse the existing optimistic settings write,
roll back with an error on failure, and never activate or restart a session.
Cross-workspace/foreign drops are ignored; only an in-memory source plus the
private drag marker authorizes a membership change. Source authorization is also
bound to the actual connected row and its current file key; a temporary DOM
observer/native end listener retires a detached or replaced source even when
React's delegated `dragend` cannot reach it. Drag end/cancel clears the source and
target highlight. Focus restoration is gesture-generation fenced so an older
save cannot take focus from a newer drag/drop or group action. A drag claims
Escape so cancelling cannot interrupt
the active agent. Workspace-grip reordering and same-section pin reordering keep
separate admission paths.

A session row's **Move session to group** folder action remains the keyboard-
accessible alternative and opens an app-owned dialog with the workspace's groups
and Ungrouped. **New group** in that dialog creates a
destination and assigns the session in one settings patch. Moving expands the
destination and reveals the moved row's page. Groups use `settings.sessionGroups`
entries `{ id, workspacePath, name, sessionFiles, collapsed }`; membership is keyed
by durable session-file path, just like pins, and survives live/stored transitions
and relaunch. Pathless pending sessions cannot be assigned yet. Missing files are
ignored, not pruned. Duplicate hand-edited membership renders only in the first
matching group. Pins and activity ordering are preserved within each section, and
each section has its own 30-row page budget.

Settings → Interface → **Show sub-agent sessions** defaults off and takes effect
immediately. Discovery supplies a conservative saved-history hint only when a
nonblank `parentSession` header accompanies a latest saved name ending in the
pi-subagents-generated `#<8 hex>` suffix. Parent references alone do not hide normal
forks or clones. Empty names explicitly clear prior generated names, matching
pinned Pi. Old files without lineage and renamed/promoted children remain visible
instead of being guessed. Bounded discovery never uses a head-only name to hide a
session when a skipped middle or discarded boundary row could contain a rename;
only a later sampled name resolves that uncertainty. Live rows use saved lineage
plus the presented live name, including explicit clears, rather than resurrecting
a stale discovery name. The explicitly active child remains in the list even
while its inactive peers are hidden, and activation reveals its section page
without reordering rows or overriding a deliberate collapse. Pins do not
bypass this filter. Filtering precedes section pagination/counts and changes no
runtime, archives, group membership, JSONL, or saved-session search behavior.

Every group change uses `settings-store.updateSessionGroups` with a pure immutable
mutation. It is projected optimistically, then re-evaluated against the latest
confirmed groups when its serialized settings write runs. A later drop, collapse,
rename, or removal therefore cannot re-persist an earlier failed move by capturing
its optimistic array. Generated IDs are allocated once outside the mutation;
only the resulting partial settings object crosses IPC. Other preference writes
retain their existing behavior, and interleaved non-group patches remain intact.

Group dialogs claim Escape, trap focus, and restore the invoking control (or the
moved row when it remounts). During a slow save the focusable dialog itself keeps
keyboard focus while controls are disabled. Failed saves return focus to the
preserved draft with an inline error; settings persistence rolls back the
optimistic update. Failed group removal re-queries the restored header after
rollback rather than focusing its detached predecessor. Labels use
`FadeText`, chrome uses the shared folder SVGs, and all styling uses semantic tokens.

### Session activity indicators

The flashing sidebar dot means **working**, not merely model streaming. Its single
selector includes authority-following streaming and every visible context-compaction
phase (active, cancelling, and retry-wait). A pending Pi input dialog or blocking
custom panel takes sidebar precedence even while its requesting tool is still in
flight: it shows the non-pulsing **Needs attention** triangle in semantic `warning`
(yellow/amber), never the accent/purple working dot. Closing or answering the
surface restores the ordinary working/done/idle state. This is presentation only;
it does not change runtime authority, cancellation, or the transcript timer.
Terminal `agent_settled` results remain
solid done/error dots. Sidebar rows must use this shared selector rather than reading a
raw SDK boolean, so compaction cannot disappear from the session list. Each working dot
animates only its own compositor-friendly opacity. At mount, its CSS animation is anchored
once to document timeline zero, keeping late or reappearing dots exactly in phase without
animating an inherited property on `.sidebar__workspaces`, which would force frame-rate
style recalculation across the full sidebar subtree.

### Shell layout (canvas + floating content card)

The window is a single unified **canvas** (`.app` background = `mantle`). The title bar
and sidebar have **no borders** — they're the top and left strips of that canvas, the
same color. The content area (`.app__main`) is a **floating, rounded card** (`base`
background, hairline border, `--radius-lg`, `--elevation-1`) inset from the canvas by a
`--space-2` gap on the left (from the sidebar), right, and bottom, and flush under the
38px title bar. `overflow: hidden` on the card clips every full-width strip inside it
(transcript, worktree bar, composer, status bar) to the rounded corners, so none of them
form hard outer 90° seams — that grid-of-rectangles look was the thing being replaced.
Setup mode (`.app--setup`, `PiNotFound`) renders directly in `.app`, not `.app__main`,
so it keeps its full-screen centered treatment. In-session notifications live inside
`.transcript-region` (the positioned transcript wrapper) so they overlay only the scrollable
transcript and stop before the composer; the model/thinking dropdowns anchor in the title bar
(outside the card) so they're never clipped.

### Responsive layout system

The app is fully usable from the enforced floor (`minWidth: 480`, `minHeight: 400` in
`main/index.ts`) up to any size. Three independent mechanisms:

- **Collapsible sidebar**: a toggle in the title bar (`TitleBar.tsx`) and `Cmd/Ctrl+B`
  flip `settings.sidebarCollapsed` (persisted). When collapsed, hovering either the
  far-left edge reveal strip or the title-bar toggle temporarily peeks the sidebar as
  an overlay. Collapsed → the grid's sidebar column becomes `0` and `.sidebar` is
  removed from layout. The grid track is
  `min(var(--sidebar-width), 38%)` so even expanded the sidebar can never eat more than
  ~⅓ of a narrow window (a no-op on normal windows). `sidebarWidth` is persisted too;
  App keeps a live local copy for smooth dragging and writes to settings on drag-end.
- **Compact title bar**: the SessionSubBar reflow described above.
- **Title bar layout**: the session name is left-aligned and sized to its text
  (`flex: 0 1 auto`, not `1`) — a modern editor convention, and it leaves the slack to
  its right as part of the title bar's `-webkit-app-region: drag` region. The
  rename input snapshots that clicked label's rendered width and matches its
  accent-font weight, so entering edit mode does not shift or crop the title.
  worktree chip lives with the right-side controls (before the unified view toggle
  and changes/diff button), not beside the title. Only the name button / chip /
  controls are `no-drag`. In sidebar-visible mode, the left
  traffic-light clearance leaves a real gutter before the sidebar toggle; in collapsed
  mode, the floating pill's extra breathing room is its outer inset, not extra internal
  padding on the end controls. The collapsed floating pill uses a border but no
  side-casting shadow, so it doesn't read as a stray fade over the transcript.
  Full-window viewers such as the diff and tree overlays render as direct
  `.app` children; in collapsed mode their scrim spans the whole titlebar+main
  area with no top/bottom inset, while the viewer panel itself supplies the
  traffic-light-clearing margins. The title bar normally remains below that
  overlay plane, but raises above it only while one of its dropdown/context/
  worktree cards is mounted, keeping those user-opened cards interactive without
  permanently placing title chrome over a viewer. A
  full-width centered title would otherwise cover the whole bar as a no-drag element,
  leaving nothing to grab the window by.
- **Fluid transcript**: `.app__main` is a size-query container (`container: mainpane /
  inline-size`). The transcript's horizontal padding scales with the pane via
  `clamp(--space-5, 6cqi, --space-8)`. **One uniform, centered reading column** is
  set once on `.transcript-blocks` (`max-width: var(--transcript-measure)` =
  60rem ≈ 840px — wider than a pure-prose measure because the surface mixes prose
  with code blocks/diffs/tool cards; `margin-inline: auto`), shared by every block type (assistant
  text, user bubbles, tool cards, code blocks, thinking) so the line length never
  grows unbounded on a wide monitor and every element reads as a single coherent
  width; below the measure the column shrinks to fill the pane (the `cqi` side
  padding supplies gutters). There are no per-type percentage caps anymore — user
  bubbles right-align within the column at ~85% to keep the "mine" asymmetry. The
  empty-state outer padding is likewise `cqi`-scaled. Transcript notifications live
  inside `.transcript-region` (a positioned flex wrapper around `TranscriptView`), so
  the container's layout containment doesn't affect them and they never reserve
  horizontal space.
- **Overflow containment**: the app grid's content column is `minmax(0, 1fr)`
  (and collapsed mode uses `minmax(0, 1fr)` too), with `min-width: 0` on the
  title bar, main card, session, transcript region, and rigid dock/composer
  slots. This is load-bearing: otherwise a long title/FadeText or other
  min-content-sized child can widen the grid during sidebar collapse and make
  the title bar/main pane clip against the viewport instead of shrinking. The
  transcript feed and the sidebar list are vertical scrollers, so both set
  `overflow-x: hidden` — a long unbreakable token (a file path or identifier in
  inline code) or a wide row must never spawn a horizontal scrollbar on the
  whole pane. Wide things instead either wrap (`.transcript-block__content` /
  `.inline-code` use `overflow-wrap: anywhere`; blocks carry `min-width: 0`) or
  scroll inside their own box (code blocks, and markdown tables via `display:
  block; width: max-content; overflow-x: auto`). `::-webkit-scrollbar-corner`
  is transparent so the corner where two scrollbars meet doesn't render as a
  light square.
