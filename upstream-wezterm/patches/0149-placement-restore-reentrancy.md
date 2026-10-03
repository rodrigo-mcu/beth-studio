# 0149 — Restoring window placement must not panic the GUI

**Status:** Implemented 2026-09-23.

## Symptom

`bethterm gui-restart` (patch 0147) ended `bethterm-gui.exe` and started
it again. The new process attached to the host (18 panes), then panicked
and exited:

```
panic at wezterm-gui\src\termwindow\mod.rs:1288:39 - !?
```

The host kept every terminal. The GUI was gone. The backtrace went
through `NtUserSetWindowPlacement` into the window proc.

## Cause

Patch 0148 calls `SetWindowPlacement` from `TermWindow::new` while
`myself` still holds `tw.borrow_mut()`. Windows delivers
`WM_WINDOWPOSCHANGED` before `SetWindowPlacement` returns. The window
proc runs the event callback, which `borrow_mut`s the same `RefCell`
and panics.

This only happens when the new window already has host panes that match
`host-windows.json`. A normal new window has no match yet, so daily use
never hit it. A reattach always matches.

## Fix

- Drop the `TermWindow` borrow before `restore_for_window`, then borrow
  again. The resize event from `WM_WINDOWPOSCHANGED` can run.
- The event callback uses `try_borrow_mut`. A nested event that still
  finds the `RefCell` borrowed is logged and skipped. It no longer
  takes down the process.

## Files

- `wezterm-gui/src/termwindow/mod.rs`

## Verification

- `cargo +nightly check -p wezterm-gui`
- Manual: with `host-windows.json` present, `bethterm gui-restart`
  brings the windows back. The GUI log has no `borrow_mut` panic.

## Revert

Restore the unconditional `borrow_mut` in the window callback and call
`restore_for_window` while `myself` is held. Remove row 0149 and this
file.
