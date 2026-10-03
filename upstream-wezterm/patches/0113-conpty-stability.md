# 0113 — Stop Windows freezes: ConPTY close, session I/O, disk sample

**Status:** Implemented 2026-09-16.

## Symptom

BethTerm (WezTerm on Windows) would freeze the whole window: Not
Responding after closing a pane/tab, after a flood of agent output, or
after AppData/disk I/O stalled. A second GPU process or a hung
`ClosePseudoConsole` left the GUI executor blocked.

## Cause

1. `ClosePseudoConsole` ran on the GUI thread. WezTerm also dropped the
   `HPCON` **before** the communication pipes. Microsoft's ConPTY
   contract is the opposite: that call waits until the output pipe is
   drained, so a busy pane (WSL, `cat`, Claude/Codex) deadlocks the UI.
   `PSEUDOCONSOLE_INHERIT_CURSOR` is the other documented hang.
2. The 30 s session auto-save wrote `%APPDATA%\bethterm\session.json` on
   the GUI executor. A slow or full disk froze the window (load already
   had a timeout from patch 0079; save did not).
3. The Sistema panel sampled every fixed drive on the tray thread with
   `GetDiskFreeSpaceExW`. A wedged volume stalls for seconds.
4. The vendored `conpty.dll` / `OpenConsole.exe` pair was the older
   1.22 host (or missing from `assets/windows/conhost`). WezTerm
   upstream and Microsoft Terminal 1.24 fixed several FailFast / close
   hangs.

## Fix

- Drop the ConPTY pipes first (`Inner` field order), skip
  `INHERIT_CURSOR`, and call `ClosePseudoConsole` on a helper thread
  named `bethterm-conpty-close`. A stuck OpenConsole can no longer
  freeze the window.
- Session **save** I/O has a 2 s timeout. The auto-save timer uses
  `save_async()` (snapshot on the mux thread, write in the background).
- Disk sampling uses a 250 ms timeout and reuses the last good sample.
- Ship the matched Microsoft ConPTY **1.24.260402001** x64 pair
  (`conpty.dll` + `OpenConsole.exe`, file version `1.24.2604.02001`)
  in `assets/windows/conhost`. `wezterm-gui/build.rs` recopies when
  the source is newer so an old pair in `target/` cannot stick.

## Files

- `pty/src/win/psuedocon.rs`
- `pty/src/win/conpty.rs`
- `wtinator/src/session.rs`
- `wtinator/src/sysmon.rs`
- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/build.rs`
- `assets/windows/conhost/{conpty.dll,OpenConsole.exe,README.md}`

## Revert

Restore the previous `Drop` / field order / `INHERIT_CURSOR` flags,
inline `session::save` writes, synchronous `disk_sample`,
exists-only DLL copy, and the older conhost binaries.
