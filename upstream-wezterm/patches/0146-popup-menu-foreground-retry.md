# 0146 — Native popup menus log and retry instead of failing silently

**Status:** Implemented 2026-09-22.

## Symptom

In the same session as patch 0145, every right-click (panes, tabs, the
tray) logged `main thread is showing HMENU`, `TrackPopupMenuEx` was
called, and nothing appeared. Windows refuses to show a popup when the
calling thread is not allowed to take the foreground; the call returns
0 immediately with `GetLastError` set, which the code treated as "user
dismissed the menu".

## Fix

`wtinator::context_menu::platform::track_popup_checked` wraps every
`TrackPopupMenuEx` (pane/tab menus in `context_menu.rs`, the tray menu
in `tray.rs`):

- `SetLastError(0)` before; if the call returns 0 **and** either
  `GetLastError() != 0` or it returned in under 50 ms, log WARN with
  the code and retry once after the official foreground trick:
  `AttachThreadInput(<foreground thread>, <us>, TRUE)`,
  `SetForegroundWindow(owner)`, `BringWindowToTop(owner)`, detach.
- A second failure is logged with the code and a pointer to
  **Reiniciar interface** / `bethterm gui-restart` (patch 0147).
- `AllowSetForegroundWindow(ASFW_ANY)` once at tray init.
- TPM flags are unchanged and the menu is still shown from the UI/main
  thread (AGENTS.md right-click rules).

## Revert

Call `TrackPopupMenuEx` directly again at both sites and drop
`track_popup_checked`. Remove row 0146 and this file.
