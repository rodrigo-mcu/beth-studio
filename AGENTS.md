# Agent Notes

Last major update: 2026-10-03 (Phase B: the native window is gone).

This file records the current operational rules for agents working on this
workspace. Read this before changing or testing the project.

## Project Shape

- The product name is **Beth Studio** (named for Elizabeth). It is more than a terminal: the Studio and the phone page are one product. The native window (`bethterm-gui.exe`, crate `wezterm-gui`) was removed in Phase B (see `docs/HISTORY.md`). The program files on disk are still `bethterm.exe`, `bethterm-host.exe`, and `bethterm-web.exe`.
- The real Rust workspace is `upstream-wezterm/`.
- **`bethterm-web/`** (Go + React, WebView2) is **Beth Studio**: a
  separate UI for the same terminals, reached through `bethterm cli bridge`
  (`upstream-wezterm/patches/0171-cli-bridge.md` onward). It is now the
  only interface. The Studio **supervises the
  host**: it starts `bethterm-host.exe` when none runs, restarts it after a
  crash (at most 3 times in 10 minutes), owns the tray icon, and hides to
  the tray when its window is closed. It still **never stops the host on
  its own**: only the tray entry "Encerrar tudo", after the user confirms in
  a dialog, asks the host to quit. After a host crash it restores the
  terminals. See
  `docs/superpowers/specs/2026-10-03-studio-supervisor-design.md` and
  `bethterm-web/README.md`.
- **`bethterm-mobile/`** (Expo/TypeScript) is a skeleton Android/iOS app.
  The phone path that ships is the phone web app (separate build:
  `bethterm-web/frontend/phone.html`, `src/phone/`, output `dist/phone`;
  never the Studio page) plus the Linux program
  `bethterm-web/cmd/bethstudio-proxy`. See
  `docs/superpowers/specs/2026-09-27-celular-remoto-design.md`.
  `bethterm-mobile/docs/REMOTE_ACCESS.md` is an older Tailscale proposal
  and is not what runs.
- The end-user binaries are `bethterm.exe` (CLI and `cli bridge`),
  `bethterm-host.exe`, and `bethterm-web.exe` (Cargo packages `wezterm` and
  `wezterm-mux-server`, plus the Go Studio). The placeholder crate in
  `upstream-wezterm/wezterminator/` is not what users launch.
  `bethterm-host.exe` owns the PTYs; Beth Studio attaches to it. Do not
  kill a running host unless the user asks.
- The host may also have an installed WezTerm at `C:\Program Files\WezTerm`.
  Do not use plain `wezterm` from PATH when testing this fork.
- Existing upstream files may be changed only as documented patches. Every
  such change must be recorded in `upstream-wezterm/PATCHES.md` and a matching
  `upstream-wezterm/patches/NNNN-*.md` file.
- The delta crate is still named `wtinator`. Do not mass-rename it.

## Feature catalog

User-facing features are listed in `FEATURES.md`. When you add, change, or
remove one, update that file in the same change and set its `Atualizado`
date. The same rule is in `.cursor/rules/features-catalog.mdc`. Bugfixes
and internal refactors do not belong there. Patch notes stay in
`upstream-wezterm/PATCHES.md`.

## Live Terminals Rule (2026-09-23)

The user's terminals, agents, and WSL sessions live in the running
`bethterm-host.exe`. Stopping it loses them. On 2026-09-23 a host was
stopped while an agent was installing a build, and the user had not
asked for it.

- Do not install to `C:\Users\Public\BethTerm`, run `BethTerm-Setup.exe`,
  or run `install-bethterm-release.ps1` while a `bethterm-host.exe` from
  that folder is running, unless the user explicitly says to do it now.
- Never set the `Local\BethTermHostQuit*` events, never `taskkill` /
  `Stop-Process` a `bethterm-host.exe` or `bethterm-web.exe` you did not
  start, and never tick "Encerrar tudo" in the setup on the user's
  behalf.
- Test in isolation: start the build from `target\release` with
  `APPDATA` pointed at a short temp folder (the socket path must stay
  under 108 characters) and stop only the processes you started.
- To test the Studio supervisor, set `BETHTERM_HOST_ID=<unique id>` (a
  separate mutex, quit event and files, so the real host is never seen) and
  `BETHTERM_IGNORE_GUI=1` (set by the tests only). Never run the supervisor tests without an id.
- `%APPDATA%\bethterm\host-life.log` records every start, stop, pane
  open/close, and who asked for a stop (patch 0168). Read it before
  guessing why a terminal disappeared. A stop with
  `requester UNKNOWN` came from outside BethTerm.

## Architecture: one host (patch 0167)

One `bethterm-host.exe` owns every PTY; Beth Studio and its single tray
icon attach to it. Patch 0159 (one host per window) was reverted by
0167 after it caused duplicated tabs, collapsed splits, hosts left
running, and a window that closed when a host was slow. Do not bring it
back without a new, tested design.

## Default Run Rule

Default daily launch:

```cmd
run-bethterm.cmd
```

That is the same as `run-bethterm-release.cmd`: it starts
`bethterm-web.exe` (Beth Studio) from `bethterm-web\`, which supervises the
host and owns the tray icon. Build it first with
`powershell -File bethterm-webuild.ps1`.

`run-bethterm-debug.cmd` is only for traces: it sets `WEZTERM_LOG=debug`.

Do not copy over a running installed copy, and do not kill a
`bethterm-web.exe` or `bethterm-host.exe` the user is using unless they
explicitly ask.

## Windows Build Commands

From `upstream-wezterm/`, use the Windows PATH that has worked on this machine:

```powershell
$env:PATH='C:\Strawberry\perlin;C:\Program Files\Microsoft Visual Studio2\Community\VC\Tools\MSVC.29.30133in\HostX64d;' + $env:PATH
cargo +nightly check -p wezterm -p wezterm-mux-server
cargo +nightly build --release -p wezterm -p wezterm-mux-server
cargo +nightly test -p wtinator
```

Build `wezterm` (`bethterm.exe`) and `wezterm-mux-server`
(`bethterm-host.exe`). Then, from the repository root,
`powershell -File bethterm-webuild.ps1` builds the Studio and
`pack-bethterm-setup.ps1` builds the installer. Updating only the CLI binary
is not enough for host behavior changes.
