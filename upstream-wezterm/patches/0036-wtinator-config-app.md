# Patch 0036 — wtinator-config standalone app (React + WebView2) + named-pipe server

**Applied:** 2026-06-13
**Files:**
- `upstream-wezterm/wtinator-config/Cargo.toml` (new crate;
  `[[bin]] wtinator-config`; deps `tao` 0.35, `wry` 0.55,
  `rust-embed` 8, `wtinator` (workspace), `serde` / `serde_json`,
  `anyhow`, `log`, `env_logger`, and Windows `windows-sys` for the
  named-pipe client)
- `upstream-wezterm/wtinator-config/src/main.rs` (new, ~340 lines:
  tao window + wry WebView, IPC dispatch, local theme list,
  `list_tabs` / `set_theme` over the pipe, embedded frontend)
- `upstream-wezterm/wtinator-config/src/ipc_client.rs` (new, ~110
  lines: Win32 `CreateFileW` named-pipe client, one JSON-line
  round-trip per request, `ERROR_PIPE_BUSY` retry + graceful
  failure)
- `upstream-wezterm/wtinator-config/frontend/` (new: Vite + React +
  TypeScript app — `package.json`, `vite.config.ts`, `tsconfig.json`,
  `index.html`, `src/main.tsx`, `src/App.tsx`, `src/ThemeCard.tsx`,
  `src/ipc.ts`, `src/styles.css`, and the **built**
  `frontend/dist/index.html` that rust-embed reads at compile time)
- `upstream-wezterm/Cargo.toml` (+1 workspace member:
  `"wtinator-config"`)
- `upstream-wezterm/wezterm-gui/src/termwindow/notify_pipe.rs`
  (new, ~170 lines: the named-pipe **server** runtime —
  `CreateNamedPipeW` + `ConnectNamedPipe` accept loop on a
  dedicated `std::thread`, `handle_client`, GUI-thread apply
  callback)
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs` (+~15 lines:
  `pub mod notify_pipe;` (windows-only) + `notify_pipe::start(
  window.clone())` call near the patch 0029 auto-save timer in
  `new_window`)
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`
  (~70 lines: the `OpenConfigApp` dispatch arm now launches
  `wtinator-config.exe --wezterm-pid <pid>` instead of the patch
  0034 "coming soon" messagebox; messagebox fallback if the exe is
  not found)
- `upstream-wezterm/PATCHES.md` (the "0036 (planned)" row replaced
  with the applied entry)
- `upstream-wezterm/patches/0036-wtinator-config-app.md` (this file)

**Status:** Active. This is the follow-up that patch 0034 deferred
(the 0034 note called it "0034.5"). It builds on the data model +
IPC contract shipped in patch 0034 with no changes to that contract.

## What

The standalone WezTerminator Settings app, and the runtime that
lets it talk to a running terminal:

1. **`wtinator-config.exe`** — a native Windows WebView2 window
   (the Tauri webview stack: `tao` for the window, `wry` for the
   WebView2 control + JS<->Rust IPC). It hosts a React + TypeScript
   frontend, built by Vite into a single self-contained
   `index.html` (via `vite-plugin-singlefile`) and embedded into
   the binary with `rust-embed`.
   - **Theme list** is built locally from
     `wtinator::vscode_theme::ThemeId::iter()` +
     `wtinator::notify::snapshot_theme` — this works with **no mux**,
     so the app always shows the 3 built-in themes even when
     launched standalone.
   - **Tab list** + **live apply** require a running wezterm-gui:
     the app takes `--wezterm-pid <PID>` and connects to
     `\\.\pipe\wtinator-config-<pid>`, sends `{"type":"list_tabs"}`,
     and renders the returned `TabSnapshot`s in the left rail.
   - The UI is a dark, modern two-pane layout: left rail = tabs
     (title + "Tab #N · group" + current theme); center = a grid of
     theme cards. Each card draws a 16-swatch ANSI strip, the
     `preview_text` rendered with a tiny ANSI-SGR interpreter using
     the theme's hex colors, and fg/bg chips. Clicking **Apply**
     while a tab is selected sends
     `{"type":"set_theme","tab_id":N,"theme":"..."}`.
2. **`ipc_client.rs`** — the named-pipe **client**: `CreateFileW`
   on the pipe path, wrap the HANDLE as a `std::fs::File`, write one
   JSON line, read one JSON line. Retries on `ERROR_PIPE_BUSY`; any
   other failure becomes a "not connected to a terminal" notice in
   the UI rather than a crash.
3. **`notify_pipe.rs`** — the named-pipe **server** runtime inside
   wezterm-gui. A dedicated `std::thread` (started in
   `TermWindow::new_window`) runs an accept loop: `CreateNamedPipeW`
   → `ConnectNamedPipe` → wrap as `std::fs::File` →
   `wtinator::notify_ipc::handle_client(reader, writer,
   notify_apply)` → `DisconnectNamedPipe` → repeat. The
   `notify_apply` callback posts the `set_theme` work to the GUI
   main thread via `Window::notify(TermWindowNotif::Apply(..))` and
   then issues `WindowInvalidated` so the terminal repaints with the
   new palette.
4. **Right-click "Open config app…"** (wID `0x6300`, added in patch
   0034) now actually **launches** `wtinator-config.exe
   --wezterm-pid <our pid>`, resolved next to `current_exe()`. If
   the exe is missing it shows a Win32 messagebox with build
   instructions.

## Why these decisions

- **`tao` + `wry` (the Tauri stack), not raw Win32 + WebView2-COM**:
  `wry` bootstraps the WebView2 environment cleanly, exposes the
  `window.ipc.postMessage` bridge and `evaluate_script`, and builds
  on this Rust nightly with no manual COM plumbing. The prompt
  suggested wry 0.4x but the current matched pair that builds here
  is **wry 0.55 + tao 0.35** (the 0.4x API is several breaking
  releases old). The extra ~20MB of deps is acceptable for a
  separate, optional binary.
- **Single-file frontend via `vite-plugin-singlefile` + wry
  `with_html`**: the entire frontend is inlined into one
  `index.html` (JS + CSS + assets), so the Rust side embeds exactly
  one file with `rust-embed` and loads it with `WebViewBuilder::
  with_html`. This sidesteps wry's custom-protocol machinery (which
  needs the `protocol` feature and a multi-asset handler) entirely.
- **IPC forwarded through the event loop**: the wry `WebView` is
  `!Send`, so it lives on the main (event-loop) thread. The
  `with_ipc_handler` closure (also on the main thread) cannot borrow
  the WebView, so it forwards each request to the event loop as a
  `UserEvent::Ipc(String)` via an `EventLoopProxy`; the event-loop
  body owns the WebView and replies with
  `evaluate_script("window.__wtinator_reply(<json>)")`. Requests are
  serviced FIFO, which the TypeScript `ipc.ts` relies on (a queue of
  pending resolvers).
- **One pipe instance per client, re-armed in a loop**: the
  simplest correct server model. The config app does a few quick
  request/response exchanges and disconnects; the server re-arms
  for the next launch. `PIPE_UNLIMITED_INSTANCES` is set so a
  second app launch is not rejected while the first is mid-exchange.
- **`set_theme` apply wrapped in `Mutex<Option<..>>`**:
  `TermWindowNotif::Apply` wants a `Send + Sync` closure, but the
  `ApplyCallback` hands us a `Box<dyn FnOnce() + Send>` (Send, not
  Sync). Wrapping it in a `Mutex<Option<..>>` makes the outer
  closure `Sync`; the main thread takes it out and calls it once.
- **Launch resolves next to `current_exe()`**: the app ships beside
  `wezterm-gui.exe`. No registry / PATH lookup; if it is not there,
  the messagebox tells the user how to build + place it.

## Reuse from existing code

- **`wtinator::notify` / `wtinator::notify_ipc`** (patch 0034): the
  whole data model + wire contract. This patch adds **no** new
  message types and does not bump `PROTOCOL_VERSION`.
- **`wtinator::notify::snapshot_theme` + `vscode_theme::ThemeId`**
  (patch 0034 / 0016): the app's local theme list goes through the
  exact same projection the GUI uses, so previews match what the
  terminal renders.
- **`Window::notify(TermWindowNotif::Apply(..))`** (patches
  0030/0031/0032): the GUI-thread hop for `set_theme`. The server
  callback is a near-clone of the "Rename tab" dispatch.
- **`wtinator::notify_ipc::handle_client` / `handle_request`**
  (patch 0034): the server thread calls these directly — they were
  written in 0034 as the reference server and are now the real one.
- **`windows-sys` `Win32_System_Pipes` / `Win32_Storage_FileSystem`
  / `Win32_Security` features** (already enabled in
  `wezterm-gui/Cargo.toml` by patch 0034): no Cargo change needed
  for the server.
- **`wtinator::confirm::confirm_close`** (patch 0032): the
  messagebox fallback when the exe is not found.

## Revert

1. Remove `"wtinator-config"` from `[workspace.members]` in the root
   `Cargo.toml` and delete the `wtinator-config/` directory.
2. In `wezterm-gui/src/termwindow/mod.rs`, remove
   `pub mod notify_pipe;` and the `notify_pipe::start(window.clone())`
   call in `new_window`; delete
   `wezterm-gui/src/termwindow/notify_pipe.rs`.
3. In `wezterm-gui/src/termwindow/mouseevent.rs`, restore the patch
   0034 `OpenConfigApp` arm (the "coming soon" messagebox).
4. Restore the "0036 (planned)" row in `PATCHES.md` and remove this
   file.

Patch 0034's data model + IPC contract are untouched, so reverting
0036 leaves the foundation intact.

## Risk

**Low–medium.** The standalone app is a separate, optional binary —
nothing in the normal terminal path depends on it. The only changes
to the always-running `wezterm-gui` are:

- A new windows-only `std::thread` (the pipe server) started once
  per window. If `CreateNamedPipeW` fails the thread logs and
  retries; it never touches the mux off the main thread (the
  `set_theme` apply is posted to the GUI thread).
- The `OpenConfigApp` dispatch now spawns a child process instead
  of showing a messagebox. Spawn failure / missing exe both fall
  back to a messagebox.

The wire protocol is unchanged from patch 0034
(`PROTOCOL_VERSION == 1`).

## Verification

### 1. Build the frontend

```bash
cd upstream-wezterm/wtinator-config/frontend
npm install
npm run build      # → dist/index.html (single self-contained file)
```

### 2. Build the app + check the GUI

```bash
cd upstream-wezterm
cargo +nightly build -p wtinator-config              # debug, ~13MB
cargo +nightly build --release -p wtinator-config    # release, ~7MB
cargo +nightly check -p wezterm-gui
cargo +nightly test -p wtinator                      # 108 tests pass
```

All of the above pass (the only `wtinator-config` build warning is
a benign `LNK4099` PDB warning from a transitive OpenSSL dep).

### 3. Standalone launch (no terminal)

```cmd
target\debug\wtinator-config.exe
```

A 960x680 "WezTerminator Settings" window opens showing the 3
built-in theme cards and a "Showing themes only…" notice (no tabs,
no terminal connected). Launching with a bogus pid
(`--wezterm-pid 999999`) also opens cleanly and shows a "not
connected" notice — it does not crash.

### 4. End-to-end (live apply)

1. Build + run `wezterm-gui.exe` (or the WezTerminator release).
2. Open a couple of tabs.
3. Right-click a pane → "Open config app…".
4. The settings window opens, the left rail lists the open tabs,
   the status bar shows "Connected to wezterm (pid …)".
5. Select a tab, click a theme card's **Apply** — the terminal's
   active pane recolors live.

## Out of scope (deferred)

- **0037**: VSCode theme downloader (open-vsx / GitHub raw → JSON →
  `%APPDATA%\wezterminator\themes\`). The `ThemeKind::UserDownloaded`
  variant already exists in the data model for this.
- **0038**: per-group default theme.
- The `current_theme` field in `TabSnapshot` is still hard-coded to
  `"default"` on the server side (patch 0034's `snapshot_tab` has no
  per-tab theme store yet), so the app's "current" badge is only
  accurate after the user applies a theme in the current session.
  A follow-up that records the applied theme id per tab/pane would
  make the badge persistent.
