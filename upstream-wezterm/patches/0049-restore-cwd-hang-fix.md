# Patch 0049 — Session restore can't hang the window on a dead cwd

**Status:** Implemented + verified 2026-06-14.

## Symptom
The window stopped opening: the process started, restored the session, but no
window ever appeared (`MainWindowHandle == 0`, no panic).

## Cause
`restore_session` (`wezterm-gui/src/termwindow/session_restore.rs`) spawns each
restored pane's shell in its **saved cwd**. A saved cwd pointing at a now-
unreachable network / WSL share (here `\\my-pc\mnt\…`) makes the
Windows process spawn block for a long time resolving the UNC path. The restore
runs on the GUI executor, so that block **starves the event loop** and the
window never paints. (The restore is already `spawn(...).detach()`-ed, but the
blocking spawn still starves the shared executor thread.)

This is data-driven: it triggers whenever a saved session references a cwd that
later becomes unreachable — common for WSL / network paths.

## Fix
`safe_restore_cwd(cwd)` validates the cwd before it's used at BOTH spawn sites
(tab spawn + pane split). The `is_dir` probe runs on a **throwaway thread** with
a **300 ms `recv_timeout`**, so an unreachable UNC host can never block restore.
If the dir isn't reachable, the cwd is **dropped** (logged) and the pane opens
in the default directory instead of hanging the whole window. The `cd <cwd>`
write for the tab-0 active pane uses the same validated value.

Verified: with the exact broken session (4 `\\my-pc\…` panes), the
build now opens the window and logs "restored cwd … is unreachable or missing;
opening the pane in the default directory instead" for each.

## Note
A user's `session.json` with such cwds was backed up to
`%APPDATA%\wezterminator\session.broken-cwds.bak.json` during diagnosis.

## Build
```
cargo +nightly build --release -p wezterm-gui   # Perl on PATH
```
