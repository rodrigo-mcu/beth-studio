# 0152 — Agent waiting shows on the window icon, tray icon and tray menu

**Status:** Implemented 2026-09-23.

## What

The tab bar already marks a pane that is waiting. The signal is the
terminal protocol, not the program name: a bell, OSC 9, OSC 777, or a
user var such as `claude_status=waiting` / `opencode_status=approval`.
Claude, Codex, OpenCode, Cursor, Grok and the others hit it when they
send one of those. That state stayed in the tab. A window
hidden in the tray, or a taskbar button among many, gave no signal.

The same condition now:

- paints a red dot on that window's taskbar icon (kept if the window
  has a chosen color)
- paints the same dot on the notification-area icon, and adds
  "agente esperando" to its tooltip, while any window is waiting
- prefixes that window's row in the tray menu with `●`

The dot clears when the tab attention clears (the user looks at that
tab) and when `claude_status` is no longer `waiting`.

## Files

- `wtinator/src/agent_wait.rs` (new), `wtinator/src/lib.rs`
- `wtinator/src/taskbar_icon.rs`, `wtinator/src/tray.rs`
- `wezterm-gui/src/termwindow/mod.rs`

## Revert

Remove the module and the publish call. Restore the tray icon loader
and the two-field menu labels. Remove row 0152 and this file.
