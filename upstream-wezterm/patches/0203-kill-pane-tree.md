# 0203 — KillPane ends the whole process tree

**Status:** Implemented 2026-11-02.

## Why

`KillPane` (Studio **Encerrar terminal…**, patch 0180) called
`TerminateProcess` on the pane's shell only. On 2026-11-02 a `cursor-agent`
in a pwsh pane stopped reading the keyboard; ending that terminal would have
left `node.exe`, its MCP servers (each in its own console: `python`, `uvx`,
`npx`, `wsl.exe`) and their children running with no pane. The user asked
for **Matar terminal** to end everything the terminal was running, and for a
**Reiniciar este terminal** that does the same before opening a new shell.

## What

- New `Pane::kill_tree` (default: `kill`). `LocalPane::kill_tree` ends every
  descendant of the pane's shell, deepest first, then the shell as before.
- Only the explicit `KillPane` request uses it. Pane removal, host quit and
  the shell exiting on its own still call `kill` and behave as upstream.
- `mux/src/proctree.rs` builds the list from a fresh Toolhelp32 snapshot
  (not the 1 s shared one of patch 0202):
  - a child counts only if it was created after its parent, because Windows
    reuses PIDs and an orphan's parent id may now name the shell;
  - a process whose creation time cannot be read is left alone;
  - `bethstudio-host.exe`, `bethstudio-web.exe`, `bethstudio.exe` (and the
    Cargo names `wezterm-mux-server.exe`, `wezterm.exe`) and their subtrees
    are never ended, even when started from a terminal;
  - before `TerminateProcess` the creation time is read again, so a PID that
    was reused in between is skipped;
  - up to 3 rounds, so a child spawned during the kill is followed.
- WSL: ending `wsl.exe` closes the Linux session; background Linux jobs
  that ignore SIGHUP (e.g. `nohup`) can outlive it, as before.
- Each ended process is logged at `info` (`kill_tree: ended …`).

## Files

- `mux/src/proctree.rs` (new) — `descendants` (pure, unit-tested) and
  `kill_descendants` (Windows)
- `mux/src/lib.rs` — `pub mod proctree`
- `mux/src/pane.rs` — `Pane::kill_tree` with a default
- `mux/src/localpane.rs` — `LocalPane::kill_tree`
- `mux/Cargo.toml` — `winnt` feature of `winapi`
- `wezterm-mux-server-impl/src/sessionhandler.rs` — `KillPane` calls
  `kill_tree`

Studio side (not upstream): the tab menu items, `KillDialog` modes
`matar` / `reiniciar` and `frontend/src/lib/restartPane.ts`.

## Tests

`cargo +nightly test -p mux proctree`: whole tree deepest first, reused
parent PID not followed, protected process and its subtree kept, unknown
start time left alone, missing root ends nothing.

## Revert

Call `pane.kill()` again in the `KillPane` handler, remove `kill_tree` from
`Pane` and `LocalPane`, delete `mux/src/proctree.rs` and its `mod` line, drop
the `winnt` feature. Remove row 0203 and this file.
