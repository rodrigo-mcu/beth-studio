# 0162 — UI stall watchdog; a forced stop kills only its own host

**Status:** Implemented 2026-09-23.

## What

On 2026-09-23 a window was moved, its title bar disappeared, and the
GUI froze. The title bar vanishing is Windows' "Not responding" ghost
window. The GUI log stopped at 11:57:26 and the process was killed at
12:03:45. There was no panic, WER report, or dump. The GUI logs from
the UI thread, so a stall leaves nothing behind.

### Watchdog

- `window` records the message `wnd_proc` is handling and the nesting
  depth in two atomics (`wndproc_state()`). The probe's own `WM_NULL`
  is not recorded. `depth=0` means the thread is stuck in a
  main-thread task, outside any window message.
- `wtinator::ui_watchdog` runs a thread that sends `WM_NULL` to a
  registered BethTerm window every 2s with `SendMessageTimeoutW`
  (5s, `SMTO_ABORTIFHUNG`). A window drag, a native menu, and a
  TaskDialog all pump sent messages, so they are not reported.
- When the UI thread stalls, `host-life.log` gets
  `ui watchdog: UI thread is not answering (5s); last window message
  0x.... NAME wnd_proc depth=N`.
- After 10s a minidump with every thread's stack goes to
  `%LOCALAPPDATA%\bethterm\hang-dumps\` (last 3 kept). Open it with
  the matching `target\release\bethterm_gui.pdb`.
- When the UI thread answers again, a recovery line is logged.

### Kill only the stuck host

`request_stop_id` fell back to `terminate_host_processes()`, which
killed every `bethterm-host.exe`. With one host per window (0159),
stopping one host that did not answer took every window with it.

Hosts now write `<socket>.pid` (`hosts\<id>.pid`, or `host.pid`
for the legacy host). The fallback kills only that pid, and only if
it is still named `bethterm-host.exe`. A host without a pid file
(started by an older build) is not killed.

## Files

- `window/src/os/windows/window.rs` (upstream)
- `wtinator/src/ui_watchdog.rs` (new), `wtinator/src/host.rs`,
  `wtinator/src/window_geom.rs`, `wtinator/src/lib.rs`,
  `wtinator/Cargo.toml` (`Win32_System_Diagnostics_Debug`,
  `Win32_System_Kernel`)
- `wezterm-gui/src/main.rs`

## Revert

Remove the two atomics and `wndproc_state` from `window.rs`, the
`ui_watchdog::start` call, `ui_watchdog.rs`, `any_hwnd`, and the pid
file. Restore `terminate_host_processes`. Remove row 0162 and this
file.
