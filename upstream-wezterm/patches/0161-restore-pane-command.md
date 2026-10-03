# 0161 — Restored terminals keep their shell (WSL)

**Status:** Implemented 2026-09-23.

## What

On 2026-09-23 the single host exited. The GUI then restored
`session.json` and every WSL Debian terminal came back as the default
Windows shell in `C:\Users\Rodrigo`.

There were two causes:

- `program` comes from `get_foreground_process_name`, which a
  `ClientPane` (host pane) never reports. `session.json` never knew a
  pane ran `wsl.exe -d Debian`.
- A WSL pane's cwd arrives through OSC 7 as
  `\\<computer>\mnt\data\...`. Restore treated it as an unreachable
  share and dropped it.

Now:

- `wtinator::pane_cmd` records the argv of every tab, window, and
  split spawned from `spawn.rs` and from restore. It is stored in
  `%APPDATA%\bethterm\pane-commands.json` under
  `<host domain>#<remote pane id>`, because pane ids restart in every
  window host (0159). A write drops entries of hosts that are no longer
  running.
- The session snapshot saves that argv in `PaneEntry.args`, which
  existed but was always empty.
- `wtinator::wsl::restore_command` picks the restore command:
  - it uses the saved argv, else `program`, else the default shell
  - it maps a WSL cwd (`\\<COMPUTERNAME>\...`, `\\wsl.localhost\<d>\...`,
    `\\wsl$\<d>\...`) to the Linux path and inserts
    `--cd <path>` after `wsl.exe`, replacing a `--cd` recorded by an
    earlier restore, so the pane returns to where it was last saved
  - with no saved argv and a WSL cwd, it starts `wsl.exe --cd <path>`
    (plus `-d <distro>` when the path names one). This covers
    sessions saved before this patch.
  - a missing directory makes wsl start in `/`; the pane still opens.
- Restored splits use `CurrentPaneDomain`. `DefaultDomain` is
  whichever window host registered last (0159), so splits could land
  in another window's host.

## Files

- `wtinator/src/pane_cmd.rs` (new), `wtinator/src/wsl.rs`,
  `wtinator/src/session.rs`, `wtinator/src/lib.rs`
- `wezterm-gui/src/spawn.rs`
- `wezterm-gui/src/termwindow/session_restore.rs`

## Revert

Remove `pane_cmd.rs`, its two `record` calls in `spawn.rs`, and the
`restore_spawn` helper. Restore the `program`-only command builders
and `SpawnTabDomain::DefaultDomain` in the split loop. Remove row 0161
and this file.
