# Claude Multitask

An Electron app for Windows 11 (primary), macOS and Linux: a themed grid of real terminals
(`node-pty`; ConPTY on Windows), each pane running its own Claude Code session — or any
command, or a bare shell — on its own task in its own folder. Shells: `cmd`, `powershell`,
`wsl`, `docker`, and `posix` (the user's `$SHELL`, macOS/Linux). The point is to run
several agents in parallel without having to watch them: each pane reports what its Claude
session is doing (from Claude Code's hook events), and the app surfaces the one that needs
you.

`README.md` is the user-facing manual. Keep it in sync when behaviour or config changes.

## Commands

```powershell
npm install            # node_modules must be complete; esbuild/xterm/zod are devDeps
npm run build          # esbuild -> dist/ (main, preload, renderer)
npm start              # build + launch Electron
npm run dev            # esbuild watch; relaunch `npx electron .` to pick up main changes
npm run typecheck      # tsc --noEmit, strict, noUnused* (src only; scripts are checked by bundling)
npm test               # scripts/test.ts: unit + real-PTY tests, any OS, no Claude/Docker needed
npm run check:themes   # contrast audit of every built-in theme; must exit 0
npm run smoke          # bundles scripts/smoke.ts -> dist/smoke.cjs
```

Definition of done for any change: `typecheck` clean, `build` clean, `npm test` passes,
`check:themes` passes if themes/chrome were touched, and a real-Claude smoke run for any
change to the launch sequence, profiles, hooks or docker (see Testing). New platform- or
user-dependent logic gets a test in `scripts/test.ts`.

**Target: it works for any user on any supported platform** — Windows x64/ARM64, macOS
arm64/x64, Linux x64/ARM64, any keyboard layout, any system language, any install
location, usernames and paths with spaces, `$` or quotes. Never assume this machine: no
hard-coded paths, distros, usernames or English-only error text.

## Architecture

```
main (Node/Electron)                         renderer (browser, contextIsolation on)
  index.ts    lifecycle, IPC, config watch     app.ts       grid, toolbar, hotkeys, state
  manager.ts  session pool, replay, sizes      pane.ts      one xterm.js pane + header
  session.ts  one PTY + launch sequence        settings.ts  settings / pane editor
  profiles.ts ShellProfile registry            palette.ts   Ctrl+K command palette
  docker.ts   engine/image/credential mounts   images.ts    Docker images dialog
  hooks.ts    hook settings + event tailer     theme-editor.ts, dom.ts
  config.ts   zod schema, resolvePanes()
  resources.ts CPU/mem sampling
preload/index.ts  the `window.mt` bridge — the renderer's only way into main
shared/  types.ts, ipc.ts (channel names), themes.ts (palettes + chrome derivation)
```

Data flow: `multitask.config.json` → `loadConfig` (zod) → `resolvePanes` fills every field
from defaults → `Manager` owns one `Session` per started pane → PTY output goes
`onData` → renderer; pane state goes `onState` → renderer. The renderer never resolves
defaults itself; it receives `ResolvedPane[]` in the `Snapshot`.

### Launch sequence (session.ts) — the delicate part

1. `profile.prepare` (docker: engine, image, stale container, credential mounts).
2. For `launch: claude` with reachable hooks: write `.multitask/hooks.settings.json`,
   truncate `events.ndjson`, start the `EventTail`.
3. Spawn the PTY at the last size the renderer reported (`Manager.sizes`).
4. Wait for a shell prompt: visible text ending in `> $ # %` plus 400 ms quiet, or 2.5 s
   quiet as a fallback. ConPTY's startup escape burst does not count as output.
5. Type the command. For Claude, wait for a footer hint (`CLAUDE_TUI`) — never for mere
   quiet, never for the banner. `CLAUDE_MISSING` → error. `CLAUDE_SETUP` (login/trust
   dialog) → stay `running`, wait up to 15 min for the TUI, then send the task.
6. Send the task: bracketed paste for Claude with echo confirmation and one retry; plain
   lines for anything else.

Readiness regexes run on `compact()` text (ANSI stripped, all whitespace removed,
lowercased), so write patterns without spaces: `forshortcuts`, not `for shortcuts`.

### Activity state

Comes only from Claude Code hook events (`hooks.ts`), never from scraping the TUI. The hook
command appends stdin to `.multitask/events.ndjson` (`findstr "^"` on Windows shells,
`cat` elsewhere); `EventTail` polls the file (fs.watch is unreliable through docker bind
mounts). `Stop` → `needs-you`. The session id from events drives `--resume`.

## Invariants — do not break

- **Never delete user data.** `workspaces/` and any pane `workspace` folder hold the user's
  real projects. Do not remove, clean or overwrite them, including in tests; use
  `SMOKE_WORKSPACE` pointed at a temp dir or `dist/`.
- Keep panes as fresh top-level Claude sessions: strip `CLAUDECODE`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT` (`profiles.ts: baseEnv`).
- Never type the task anywhere it could run as a shell line or answer a menu. When unsure,
  leave the pane `running` with a `message` and let ⏎ / auto-continue handle it.
- A pane in `error` has ⏎ disabled. Use `error` only when the pane can't reach its program;
  a live, recoverable pane is `running` + `message`.
- Killing a pane must sweep the process tree: `taskkill /T /F` on Windows (ConPTY leaves
  `claude` and `node` orphans), and on POSIX a `ps` snapshot taken *before* the shell dies
  (its children are reparented to init the moment it exits). See `Session.stop`.
- Platform checks go through `PROFILES` / `profileAvailable` in `shared/types.ts`, so main
  and the settings dialog agree. A shell missing on this OS fails with a message; never
  let it reach `pty.spawn`.
- On macOS, app shortcuts use Cmd (`modKey`, `keys()` in `renderer/dom.ts`) and Ctrl is
  entirely the terminal's. Never bind a Ctrl shortcut on macOS; write shortcut labels as
  `keys('Ctrl+…')` so they read correctly on each OS.
- Match shortcut keys with `keyIs(e, 'k')` / `digitOf(e)` from `dom.ts`, never raw
  `e.key` (AZERTY digits, Cyrillic letters), and never take an Alt combination (AltGr is
  Ctrl+Alt on Windows and types characters).
- Don't detect failures by English text alone. The launch sequence treats the shell's own
  prompt reappearing (`failWhen` in `runLaunchSequence`) as "the command ended"; the
  English patterns are only a faster path.
- macOS/Linux: `adoptLoginShellPath()` (`main/env.ts`) runs before anything looks up an
  executable; GUI-launched apps otherwise have a bare `PATH`. Resolve executables with
  `which()` in `profiles.ts`, which honours PATHEXT on Windows and the executable bit
  elsewhere.
- Quote per shell: `shellQuoteWin` (cmd), `shellQuotePwsh` (single quotes, `$` literal),
  `shellQuotePosix`. PowerShell starts npm installs as `claude.cmd`, since `claude.ps1`
  is blocked by the default execution policy.
- Packaged builds keep config and `workspaces/` in `appRoot()`: next to the exe on Windows
  (`PORTABLE_EXECUTABLE_DIR` for the portable build; `userData` if that folder is not
  writable, e.g. Program Files), `userData` on macOS/Linux, where the bundle is read-only.
- `docker run` argv is built only in `buildRunArgs` (`main/docker.ts`). On Linux it runs
  the container as the host uid:gid with a per-pane home, so nothing in the user's project
  or `~/.claude` becomes root-owned; a pane's explicit `user` opts out.
- Secrets reach containers only as bare `-e KEY` flags, never `KEY=value` in argv.
- Docker panes get their own `.claude.json` (never write the host's), with the mount point
  pre-trusted.
- App shortcuts are registered in the capture phase (xterm swallows Ctrl+digit). Escape
  belongs to the focused terminal (it interrupts Claude).
- Only the topmost `.overlay` dialog reacts to Escape.
- The renderer stays sandboxed: no Node in the renderer; everything goes through
  `window.mt` and the strict CSP in `index.html`.

## Adding features — where things go

**A config field**
1. `shared/types.ts`: add to `PaneConfig` (and `ResolvedPane` / `Defaults` if inherited).
2. `main/config.ts`: add to the zod schema; resolve it in `resolvePanes` (pane → defaults
   → built-in default). Unknown or optional values must fall back, not invalidate the file.
3. `renderer/settings.ts`: control + `commit()` + include it in the change-listener list;
   add it to the re-render list if it changes which fields are shown.
4. README config table.

**A shell profile** — one object in the `registry` in `main/profiles.ts` implementing
`ShellProfile` (`buildSpawn`, `shellPath`, `claudeCommand`, `newline`; optional `prepare`,
`cleanup`, `warningFor`, `hooksReachable`; set `enabled` for the platforms it exists on).
Then add the id to `ProfileId` and to `PROFILES` (with `platforms`) in `shared/types.ts`,
the zod `profileId` enum in `config.ts`, `appendCommand` in `hooks.ts` if Claude runs
somewhere its hook shell differs, and the README Shells table. Quote with `shellQuoteWin` / `shellQuotePosix`.

**An IPC call** — channel name in `shared/ipc.ts` → `handle(...)` in `main/index.ts` →
method on `Manager` → typed wrapper in `preload/index.ts`. Errors thrown in a handler are
already toasted; don't toast them twice.

**A theme** — add to `THEMES` in `shared/themes.ts` (palette only; chrome is derived by
`chromeVars`). Run `npm run check:themes`; body 4.5–13:1, every ANSI colour ≥ 3:1,
red/green separation ≥ 150. Update the README theme table.

**A pane action / command** — header button in `pane.ts` `buildChrome`, plus an entry in
`buildCommands()` in `app.ts` so it is reachable from Ctrl+K. Every action should be in the
palette.

**A hotkey** — the capture-phase listener in `app.ts registerHotkeys`, or the xterm
`attachCustomKeyEventHandler` in `pane.ts` for per-terminal keys. Don't take keys that
shells or Claude need (plain Ctrl+F, Ctrl+R, Esc, Ctrl+C without a selection). Document
it in README Controls.

## Testing

`npm test` (`scripts/test.ts`, `node:test`) is the portable suite: quoting per shell, WSL
path translation, hook commands, docker argv (secrets, Linux user mapping), and real PTY
sessions with this OS's default shell — a command runs after the prompt, a missing
`claude` is reported, a command that returns to the prompt counts as failed, stop ends
the shell. It needs no Claude Code, Docker or network, so it is what CI should run on
Windows, macOS and Linux. Tests use `os.tmpdir()`, never `workspaces/`.

`scripts/smoke.ts` drives one `Session` headlessly, which is the fastest loop for launch
sequence work:

```bash
npm run smoke
SMOKE_WORKSPACE=<temp dir> SMOKE_LAUNCH=command SMOKE_COMMAND="echo hi" node dist/smoke.cjs wsl "" 10
SMOKE_WORKSPACE=dist/smoke-ws node dist/smoke.cjs cmd "Reply PONG. No tools." 60
```

- Args: profile, task, time limit (s). Env: `SMOKE_LAUNCH`, `SMOKE_COMMAND`,
  `SMOKE_CLAUDE_BIN`, `SMOKE_CLAUDE_ARGS`, `SMOKE_DISTRO`, `SMOKE_IMAGE`, `SMOKE_DOCKER_MODE`,
  `SMOKE_CONTAINER`, `SMOKE_CLAUDE_MODE`, `SMOKE_CLAUDE_HOME`.
- A folder outside a trusted tree shows Claude's trust dialog. `dist/` under the repo
  inherits the repo's trust; don't accept trust dialogs in temp folders (that writes to
  the user's global `~/.claude.json`).
- Real-Claude runs cost tokens: keep tasks trivial and time limits short.
- `session.log` in the pane's `.multitask/` has the raw PTY stream; strip ANSI to read it.
- `AttachConsole failed` from `node-pty`'s console-list agent on stop is known noise.
- UI changes: `npm start`, with `ELECTRON_ENABLE_LOGGING=1` for renderer console output.
  Say so before launching the window, since the user may interact with it.
- `scripts/docker-argv.ts` prints the docker argv for each credential mode without
  starting a container.

## Environment notes

- Developed and tested on Windows. The macOS/Linux code paths (`posix` shell, `ps` tree
  kill, login-shell PATH, Cmd shortcuts, Mac menu, `userData` app root, Keychain warning,
  Linux docker user mapping) are written but have **not** run on a real Mac or Linux
  machine yet; treat them as unverified until `npm test` has passed there.
- Paths in config may be relative to the app root or absolute.
- `node-pty` uses N-API prebuilds for Windows and macOS (no electron-rebuild needed); on
  Linux `npm install` compiles it and needs `build-essential` + `python3`.
- Build installers on the target OS: `npm run dist:win` / `dist:mac` / `dist:linux`.
- Working copies use CRLF (a few newer files LF); `.gitattributes` normalizes on commit.
  When scripting edits on Windows, keep `\r`-style escapes out of shell heredocs; use the Edit
  tool or a script file.
- Not a git repository at present.

## Feature backlog

Candidate next features, roughly by value. Confirm scope with the user before starting one.

- **Finish the macOS/Linux port** (code is in; verification is not). First, a GitHub
  Actions matrix (windows-latest, macos-latest, ubuntu-latest) running `npm ci`,
  `typecheck`, `build`, `npm test` — that covers most of it automatically. Then by hand on
  a real Mac and a Linux box: `npm start` launched from Finder / the app menu (login-shell
  PATH), smoke `posix` in claude mode,
  stop/restart leaves no `claude` process behind, Cmd+C/V/A/F and Cmd+K/1–9/Shift+M/,
  behave, Cmd+Q asks when terminals run, packaged app writes its config to `userData`,
  docker panes (Linux: file ownership with and without **Run as user**; macOS: Keychain
  warning shows), `npm run dist:mac` / `dist:linux` produce working artifacts. Then:
  a Settings "Open data folder" action for packaged builds, and mac code
  signing/notarization if distributing.
- **Non-English keyboard/locale QA**: `npm test` covers locale-independent failure
  detection; AZERTY/Cyrillic shortcut handling is covered only by reasoning so far.

- **Pre-trust pane folders** for cmd/powershell/wsl panes (opt-in setting), so a new pane
  doesn't stop on the trust dialog. It must not silently edit `~/.claude.json`.
- **Split / resizable layouts** beyond the uniform cols×rows grid (drag dividers, spans).
- **Tabs / workspaces**: several named grids, switchable, each its own pane set.
- **Pane templates**: "new pane from…" presets (profile + launch + args + theme).
- **Broadcast input**: type once into several selected panes.
- **Session history viewer**: browse `session.log` / Claude transcripts per pane.
- **Per-pane cost / token and turn summary** from hook or transcript data.
- **Git awareness**: branch and dirty state in the pane header; optional worktree per pane
  so parallel agents don't collide in one repo.
- **Clear-on-restart option**: reset the xterm buffer when a pane restarts.
- **Docker exec activity**: a way to reach hooks inside an existing container.
- **SSH profile** as a fifth `ShellProfile`.
- **More tests**: `config.resolvePanes` (needs `electron` stubbed out of `config.ts`),
  the hook `EventTail`, and renderer key helpers under a DOM shim.
