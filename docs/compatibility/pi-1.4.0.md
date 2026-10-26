# Pi 1.4.0 compatibility audit

This is the current runtime compatibility contract for Pi-Vis. It audits every
release from the shipped 1.0.0 pin through exact
`@earendil-works/pi-coding-agent@1.4.0` (1.0.1–1.0.4 and 1.1–1.4).
The [1.0.0 audit](pi-1.0.0.md) and [0.99.2 audit](pi-0.99.2.md) remain historical
records. Pi-Vis embeds the SDK, owns its React transcript and application
lifecycle, and uses public `TuiMainScreen` for extension panels. It does not
instantiate upstream `InteractiveMode` or update Pi independently of the app.

## Package and security closure

The seven runtime packages are coding-agent, agent-core, pi-ai, codemode, MCP,
telemetry, and pi-tui, all exact 1.4.0. Upstream now pins its internal packages
exactly and removed chord plus the unpublished experimental client/server/plugin
exports. The Node requirement remains `>=22.19.0`; the SDK anchor remains
`dist/cli.js`, its public root `dist/index.js`, and the executable
`dist/bundle/cli.js`. Dependencies now normally hoist into the root
`node_modules`; host resolution and packaging continue to support both layouts.

Pi removed its published shrinkwrap in 1.0.1 and directly requires safe
`brace-expansion@5.0.12`. The application consumes the official 1.4.0 tarball
unchanged, with its registry integrity pinned in the lock and security gate.
A stale installed shrinkwrap or root `hasShrinkwrap` is rejected. Pi/minimatch
must actually resolve 5.0.12 in source and packaged layouts.

The October security audit additionally requires narrow Undici patch overrides:
Pi's 8.10.2 becomes 8.12.2, 7.30.0 becomes 7.30.1, and the build dependency's
6.29.0 becomes 6.29.1. These close the EventSource parser, subresource-integrity,
and excessive-content-encoding advisories without modifying Pi source. The
security gate pins Pi's patched transport lock metadata and actual installed
bytes; final-app verification repeats actual resolution after packaging.

Zod moves to exact 4.6.6 rather than its vulnerable v3 compatibility export.
All application schemas use the actual v4 parser. Record signatures, recursive
types, nested font defaults, and intentionally optional unknown tool-event
fields preserve the previous contracts. An adversarial regression runs the real
Markdown batch schema against more than 100,000 malformed elements and requires
one size error without reading any element. This verifies the collection-size
fix behaviorally rather than trusting the package version alone.

## Breaking changes and application adaptation

| Upstream change | Pi-Vis integration |
|---|---|
| Azure provider renamed `azure-openai-responses` → `azure` | The account catalog uses the new ID/name. Before SDK construction the host performs the one-time locked global-credential migration below. Saved default/scoped patterns and persisted/resume model references normalize the old provider when resolving the public catalog; JSONL is unchanged. |
| Pi-TUI `Terminal.setProgramStatus()` is required | The embedded terminal implements the method as a no-op. App authority and sidebar result state already own status, rather than OSC 7501 in embedded xterm. `agent_settled.aborted` crosses the typed protocol; cancellation no longer creates a successful unread-completion marker. |
| Editor/Input fake cursor changes to zero-width APC markers | Embedded editors continue through the public `TuiMainScreen` compositor, which resolves the markers and honors hardware-cursor settings. Non-TUI ANSI transcript rendering strips unsupported control sequences. |
| `before_agent_start` becomes a `messageType: "user" | "custom"` union and also runs for extension-triggered custom turns | Pi owns those hooks and its new starting-run busy/cancellation behavior. Pi-Vis no longer has a production handler that assumes every event has a prompt; extension fixtures and SDK journeys exercise native delivery. |
| Generated settings/models/themes schemas and stricter startup theme validation | The published schemas ship with the package. Pi-Vis uses public settings/theme APIs and semantic app theme tokens; custom Pi themes must adopt the migration instructions below. |
| Kimi Code changes to Chat Completions with a `/v1` endpoint | Inherited public provider implementation. Custom base URL overrides must include `/v1`; Pi-Vis does not reinterpret arbitrary endpoint URLs. |
| `telemetryContext` → `telemetry?: TelemetrySpan`; removed `getPiUserAgent()`; new client identity | Host integration uses no retired request option/helper. Public runtime identity owns attribution and detailed `pi/1.4.0 (...)` user-agent headers. Extensions inherit the new header-hook order and can still remove headers with `null`. |
| `resolveTranscriptTools()` now takes `TranscriptToolSupport`; `foldedSystemMessages` replaces `anchorsAdditions` | Pi owns provider-facing tool/transcript projection. Pi-Vis never copies that algorithm or calls the retired boolean signature. |
| Removed assistant message frames, experimental source-only exports, and chord | No app production dependency used those surfaces. Installed-package gates assert their removal and the exact remaining public surface. |
| Summary `reserveTokens` no longer imposes an output cap; replayed thinking omitted from serialization | Compaction and branch summaries use public SDK functions. The summary test supplies a tiny reserve, requires no request `maxTokens`, retains reasoning/custom instructions, and excludes replayed thinking. |
| Native SDK constructor now restores active tools, including newly installed extension tools | The hidden Pi-Vis transcript-restoration extension is removed. Native Pi owns restore/pending/default activation on resume, tree navigation, reconnect, and reload. Keeping the workaround would incorrectly suppress tools Pi 1.4 now enables. |

### Azure account and configuration migration

The only automatic file mutation is `<agentDir>/auth.json`. A missing file or
one without the legacy key is unchanged. The host takes Pi's ordinary
`auth.json.lock`, rereads the file, and validates the legacy API-key credential
including optional string-valued provider environment fields. If `azure` is
absent it moves the exact credential there; if `azure` already exists it remains
authoritative. The legacy key is removed in the same atomic write. This makes
the migration idempotent and prevents signing out from silently recreating the
account on the next host spawn. Other accounts, formatting indentation, and the
existing file mode and ownership survive. For an `auth.json` symlink, the host
keeps the symlink and atomically updates its validated target under the original
Pi lock. An exclusive same-directory temporary file is fsynced before rename,
with best-effort directory fsync and cleanup. A malformed
file/credential is never overwritten. Errors presented to the user are fixed
and secret-free. No project file is read or written by this migration.

Saved provider selection and exact `azure-openai-responses/` model-pattern
prefixes are normalized in memory. Historical sessions are never rewritten.
Custom Azure definitions in `models.json` should rename their provider key to
`azure`; the model API may still correctly be named `azure-openai-responses`.
`AZURE_OPENAI_*` environment names are unchanged. Custom `modelThinkingLevels`
keys should likewise use `azure/<deployment>`.

For Kimi Code, custom `models.json` base URL overrides must now include `/v1`.
For custom Pi themes, use `$schema: "https://pi.dev/schemas/theme.schema.json"`,
put reusable colors under `vars`, and remove unsupported metadata. The other
published schemas are `https://pi.dev/schemas/{settings,models,keybindings}.schema.json`.
These provider/theme documents remain user-managed; Pi reports invalid
configuration through its normal diagnostics.

## New feature disposition

| Released feature | Pi-Vis behavior |
|---|---|
| Image classifiers: GPT-6 Luna Decisions, native llama.cpp decision models, TypeSafe Jev/Cloudflare Clef/OpenRouter images and System One compatibility | Available through public `ModelRegistry.classify()` and codemode `models.classify()`. The real codemode gate sends an image with session-resolved credentials, verifies canonical model resolution and all three results, and retains typed result/usage/nested-call paths. Classifiers remain separate from chat-model selection. |
| Codemode saves generated/read images as private temporary files | Inherited public codemode implementation. Ordered text/image output and the saved-file notice survive the existing tool-result contract and transcript image display. |
| Codemode worker queue and `PI_CODEMODE_MAX_WORKERS` | Inherited public factory. A test blocks both workers, starts a third call, proves it waits rather than fails, releases capacity, and requires all three calls to finish. `settings.piEnv` already forwards the configuration variable on spawn/reload. |
| Codemode constraints, namespace aliases, `reachesTools`, prompt guidelines, output separators, frozen built-ins, bounded output and worker cancellation | Inherited public codemode/tool-search/MCP factories. Pi-Vis neither copies declarations nor creates a competing worker or tool scheduler. |
| Recorded tool execution duration and codemode timing | Typed events retain monotonic `durationMs`, excluding hooks. Tool-result messages, live reduction, history, and reload retain it; tool-card summaries display the same recorded duration. Tools that did not run do not invent a duration. |
| `pi.registerToolRenderer()` for tools that are not registered yet | Public resolver-based rendering is exposed through an owner-fenced host read and the tool-card extension view, including saved results and absent MCP definitions. Functions remain in the host; raw results and provider context remain unchanged. |
| MCP project overrides and interactive manager live updates | Inherited public ResourceLoader/MCP configuration and custom Pi-TUI manager. Project resources still require trust; upstream project overrides do not bypass Pi-Vis deny-by-default startup. |
| MCP Client ID Metadata Documents, native OAuth registration, full-flow cancellation/timeouts, BOM handling, scalar/null/array structured content | Inherited public MCP stack. The protocol retains arbitrary structured content, and planned host disposal still awaits native MCP cleanup; hard restart is a separate explicit process lifecycle action. |
| Per-key OpenRouter catalogs, regional/custom endpoints, offline catalog cache | Inherited public `ModelRuntime` refresh and app catalog revalidation; allowed model limits and prices come from Pi rather than a copied app catalog. |
| Per-thinking-level sampling parameters | `samplingParamsByThinkingLevel` in `models.json` is consumed by the public provider runtime. Saved Pi-Vis model/thinking defaults use public setters and wait for successful global settings persistence. |
| New models/effort support, defaults, context sizes, tiered pricing, provider protocol fixes and retired Codex models | Dynamic public catalog, available thinking levels, request adapters, cost attribution, and retry/context-overflow behavior inherit the exact 1.4 runtime. There is no second hardcoded model catalog. |
| `sessionShareDestination` (`auto`, `gist`, `radius`) | `/share` reads the public setting in the host. `radius` uploads the selected branch using public session-resolved credentials; `auto` chooses Radius when authenticated and otherwise uses the existing private Gist path; `gist` selects that path explicitly. A failed or ambiguous Radius upload never falls back or replays. Export-only viewer metadata never alters persisted JSONL. |
| Tool selection modifiers/patterns, optional MCP disable, newly registered extension-tool restore | SDK `defaultTools` and public built-in resource composition own selection. CLI-only flags remain available in the shipped exact-version executable; Pi-Vis does not synthesize them as app state. |
| Rex/Herdr support, terminal color/key/mouse/clipboard fixes, output padding, image transcoder API | Public Pi-TUI improvements apply to embedded components. Local app clipboard and React transcript remain app-owned; CLI terminal-detection/OSC52/fullscreen behavior applies to CLI launches only. |
| Nix/managed installer changes, CLI print-mode exit semantics, CLI update retention | Available in the exact bundled CLI where applicable. Pi-Vis neither installs a separate Pi runtime nor exposes Pi self-update. |

The 1.0 capabilities remain active: codemode image generation, Anthropic
copy-code login, OAuth Account/Subscription labels, Radius consented MCP setup,
MCP OAuth issuer/metadata/credential/scope hardening, public model routing,
Markdown transformers, direct Shell Turns, and project trust.

## Private llama.cpp boundary and release gates

Pi 1.4.0 still ships exactly four aggregate built-ins: llama.cpp, codemode,
tool-search, and MCP. The public root still exports factories only for the
latter three. [ADR 0006](../decisions/0006-pinned-llama-private-extension-exception.md)
therefore renews only the exact-version llama registry lookup. The adapter
selects one validated `{ name, factory, builtin: true }` entry, ignores all
others, and returns immediately to public extension/provider/UI APIs.

Release-blocking tests retain pristine-runtime JSONL-tail repair, fragmented
indexed Mistral tool-call continuation, and custom-message/tool-result
adjacency. Installed public/declaration/CLI, compatibility migration, native
MCP resume/reload, real codemode image/classifier/worker, MCP OAuth loopback,
Pi-TUI, and llama-manager journeys move with the pin. Duration has shared,
history, reducer, and render coverage; cancelled settlement has a store
regression. Radius/Gist sharing has cancellation, exact-owner, response-size,
credential-redaction and lost-response tests plus browser and real-host journeys.
The Pi-TUI fake-cursor APC markers are stripped as complete control strings
while visible text and styling survive. Final acceptance requires clean `npm ci`,
zero-advisory production
`npm audit`, the full typecheck/lint/unit/render/Electron suite, `npm ls --all`,
and `npm run dist` with final-artifact runtime/security/PTY checks. Signed
publication still requires the signing/notarization, real-provider Kitty,
and manual GUI/IME checks in [RELEASING.md](../../RELEASING.md).

## Primary references

- [Coding-agent changelog through 1.4.0](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md)
- [Pi-AI changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/CHANGELOG.md)
- [Agent-core changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/agent/CHANGELOG.md)
- [Pi-TUI changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/tui/CHANGELOG.md)
- [Undici security advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c)
- [Zod collection validation advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
