# 0122 — Encerrar host, theme/font on reconnect, staged host update

**Status:** Implemented 2026-09-16.

## What

Patch 0121 left three holes:

1. Tray had no way to stop `bethterm-host.exe`. **Sair** left
   shells running with no off switch.
2. `ClientPane` ignored header / theme / font, so Settings and
   session restore did nothing after attach.
3. Windows cannot overwrite a running host exe, so a GUI/setup
   update could not stage a new host.

This patch:

- Adds **Encerrar host** (confirm, then quit event / terminate,
  then Sair).
- Stores visual fields on `ClientPane` and persists them by host
  pane id in `%APPDATA%\bethterm\host-panes.json`.
- Applies that sidecar (and session.json order) after attach.
- Stages `bethterm-host.exe.new` when the host is live; the next
  host start swaps it in.

## Files

- `wtinator/src/host.rs`
- `wtinator/src/host_meta.rs` (new)
- `wtinator/src/{lib,tray,confirm,session}.rs`
- `wtinator/Cargo.toml`
- `wezterm-client/src/pane/{mod,clientpane}.rs`
- `wezterm-gui/src/main.rs`
- `wezterm-gui/src/termwindow/session_restore.rs`
- `wezterm-mux-server/src/main.rs`
- `install-bethterm-release.ps1`

## Revert

Remove Encerrar host, ClientPane visual fields, and the `.exe.new`
swap. Restore the 0121 “GUI-only Sair” behavior.
