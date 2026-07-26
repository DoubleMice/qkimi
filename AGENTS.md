# AGENTS.md

Guidance for AI agents working in this repository. `CLAUDE.md` carries the same
content; when you change one, keep the other in sync.

## What this is

Kimi 2007 is a retro QQ-2007-skinned desktop client for `kimi server` (the local
Kimi CLI's REST/WebSocket daemon). The same frontend runs in two modes:

- **Native macOS client** (primary): a ~1 MB Swift/AppKit app hosting the page
  in a system `WKWebView` — no Electron/Chromium/Node runtime is bundled.
- **Browser compatibility mode**: `tools/serve.js`, a small Node HTTP server
  that serves the page and exposes browser-only runtime config through
  `/env.json`.

Both modes use the source tree under `web/` and deliver the same public routes.
The difference is only how `window.KIMI_ENV` / `window.KimiDesktop` are
populated.

## Commands

```bash
npm start            # bash native/build.sh run — release-builds and runs the native macOS app
npm run start:web    # node tools/serve.js — browser compatibility mode on http://127.0.0.1:2007
npm run check        # validates web manifest/assembled JS, serve.js, then Swift debug build for arm64
npm test             # bash native/smoke.sh — native WKWebView end-to-end smoke test
npm run package      # bash native/build.sh package — release .app under out/
npm run make         # bash native/build.sh make — package plus DMG and ZIP under out/make/
```

There is no JS unit-test suite or framework build. `npm run check` is the
required syntax/compile gate after modifying anything in `web/`, `tools/`, or
the Swift sources. `native/smoke.sh` has one in-page test program in
`App/SmokeTestRunner.swift`; it has no per-test filter. Toggle flags:
`QKIMI_SMOKE_UPLOAD=1`, `QKIMI_SMOKE_PERMISSION=1` (default on), and
`QKIMI_SMOKE_WIDTH` / `QKIMI_SMOKE_HEIGHT`.

## Frontend architecture

### Source fragments and virtual bundles

There is no transpiler or third-party bundler. Instead,
`web/static-manifest.json` is the single source of truth for the public static
routes and bundle order:

```text
web/
  index.html
  static-manifest.json        # allowed routes and /app.js + /style.css composition order
  app/                        # one shared IIFE, split by responsibility (all files < 800 lines)
    core.js                   # state, DOM helpers, markdown and shared UI primitives
    messages.js + message-actions.js
                              # timeline, message operations, export and favorites
    api.js + session-*.js     # REST and session/model/tag/permission lifecycle
    connection.js + live-presentation.js + activity-center.js
                              # WebSocket connection, streaming UI and activity state
    feedback.js + frame-handler.js + interactions.js
                              # sound/title feedback, event dispatch, approvals/questions
    composer.js + completion.js + attachments.js
                              # sending, slash/@ completion and uploads
    window-interactions.js + navigation.js + panels.js + layout.js + command-palette.js
                              # chrome, panels, responsive layout and commands
    pet.js                    # desktop pet
    boot.js                   # startup only
  styles/                     # ordered CSS responsibility fragments
  runtime/bootstrap.js        # resolves runtime config, then loads /app.js
  vendor/markdown-it.min.js
  assets/pet-kimi.png
```

`/app.js` is assembled by wrapping the ordered `app/` fragments in one strict
IIFE, preserving the deliberately private shared state and the
`window.__kimi2007` smoke/debug hook. `/style.css` is assembled in the same
order from `styles/`. Do not load a fragment directly and do not turn fragments
into globals. When a new cross-cutting feature is added, put it in the smallest
existing owner (or a new focused fragment), then add it at the correct position
in `static-manifest.json`.

`tools/web-assets.js` validates and serves the manifest in browser mode;
`Web/LoopbackServer.swift` decodes the same manifest in native mode. Both
reject paths outside the explicit allowlist. `native/build.sh` copies the whole
`web/` tree, so a new source or asset needs only the manifest update when it
must be network-visible. `tools/check-web.js` checks the actual assembled
`/app.js` rather than checking fragments in isolation.

### Markdown rendering

Chat message bodies are rendered by the vendored UMD bundle
`web/vendor/markdown-it.min.js`, configured with
`{ html: false, linkify: true, breaks: true }`; raw HTML is always escaped.
`app/core.js` overrides `fence` to retain the `.codeblock` / `.cb-head` /
`.cb-copy` structure and overrides `link_open` to force
`target="_blank" rel="noreferrer"`.

### Runtime config handshake (`runtime/bootstrap.js` → `/app.js`)

`runtime/bootstrap.js` resolves `{ base, token, model, cwd }` before injecting
the virtual `/app.js` route:

- **Native mode** calls `window.KimiDesktop.getRuntimeEnv()`, injected by
  `Web/NativeBridge.swift` at document start.
- **Browser mode** fetches `/env.json` from `tools/serve.js`; it forwards
  `window.location.search`, so `?cwd=<dir>` binds a tab to an existing
  workspace.

`app/core.js` reads `window.KIMI_ENV` and the native bridge for window chrome,
workspace selection, new workspace windows, and `onWindowState`.

## Backend contract

Both the frontend and native layer communicate with a separately installed
`kimi server` daemon (`~/.kimi-code/bin/kimi`, overridable with `KIMI_BIN`):

- REST: `http://127.0.0.1:<port>/api/v1/...`, Bearer token; default port
  `58627`, overridable by `KIMI_SERVER_PORT` / `KIMI_SERVER_BASE`.
- WebSocket: `ws://127.0.0.1:<port>/api/v1/ws?client_id=...`, subprotocol
  `kimi-code.bearer.<token>`.
- The token lives at `~/.kimi-code/server.token` (overridable with
  `KIMI_SERVER_TOKEN_FILE`). `tools/serve.js` and `Runtime/KimiRuntime.swift`
  start `kimi server run --keep-alive --port <port>` themselves when needed.

`app/api.js` owns the REST `api()` helper. `app/connection.js`,
`app/frame-handler.js` and activity fragments own WS connection/replay handling
(`lastSeq` plus epochs) and live activity state. REST is used for commands and
snapshots; WS is used for deltas.

Verified server behavior the UI relies on:

- REST `prompts` does not intercept `/` text; the composer performs registered
  local slash commands and sends other slash text as a regular prompt.
- `fs:list` / `fs:search` power `@` references. The first `@` builds a local
  workspace index in the background; server lookup is only a build/failure
  fallback.
- Session actions use `POST /api/v1/sessions/:sid:<action>` (`compact`, `undo`,
  `fork`, `abort`, `archive`). There is no REST title/rename route.

## Native Swift layer (`native/Sources/Kimi2007/`)

- `main.swift` — `NSApplication` entry point.
- `App/` — application lifecycle, per-window controller/store, and the
  standalone `SmokeTestRunner`; `AppDelegate` now only coordinates lifecycle,
  menu and windows.
- `Runtime/KimiRuntime.swift` — daemon discovery, health check and token
  loading; workspace-free.
- `Web/` — loopback static service, WK bridge and custom web view behavior.
  Each `KimiWindowController` owns its bridge and `WorkspaceStore`.

All windows use `WKWebsiteDataStore.default()`, so local storage is shared;
drafts/tags/favorites are keyed by session and the last-open session is stored
per workspace in `kimi2007.sidByWs`.

## Security posture

Keep the strict CSP and headers in `tools/serve.js` and
`Web/LoopbackServer.swift` aligned. Only routes declared in
`web/static-manifest.json` are served; internal source fragments and the
manifest itself are not HTTP routes. Native mode never exposes `/env.json` over
HTTP. External `http`/`https` links open in the system browser. Vendored scripts
must remain `unsafe-eval`-free and must not use raw HTML injection.

## Conventions

- Frontend strings, comments and UI copy are Simplified Chinese.
- Keep colors, radii and shadows on the variables in
  `web/styles/base-shell.css`; do not introduce near-duplicate literals in a
  feature fragment. Corner radii: controls 3px, popups 5px, panels/chips 8px.
- `docs/todolist.md` tracks completed batches and in-flight work. Add a batch
  entry after landing a feature. `docs/DESKTOP.md` records native operational
  notes.
- Preserve user changes in a dirty worktree; do not reset or overwrite
  unrelated edits.
