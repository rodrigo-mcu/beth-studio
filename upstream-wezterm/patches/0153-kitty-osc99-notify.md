# 0153 — Kitty OSC 99 is an agent-waiting notification

**Status:** Implemented 2026-09-23.

## What

Claude (when it detects kitty), and other CLIs, ask for attention with
OSC 99 instead of OSC 9 or the bell. WezTerm stored that sequence as
an unknown OSC, so the tab dot and the taskbar/tray markers never saw
it. An OSC 99 that is not a close or a query now becomes the same
toast alert as OSC 9 and OSC 777.

The marker itself does not know the program name. Claude, Codex,
OpenCode, Cursor, Grok and the rest light it when they send a bell,
OSC 9, OSC 777, OSC 99, or a user var such as `*_status=waiting`.

## Files

- `term/src/terminalstate/performer.rs`

The parser runs in the host. A running `bethterm-host.exe` keeps the
old parser until it is started again.

## Revert

Drop the `Unspecified` OSC 99 branch and `kitty_notify_body`. Remove
row 0153 and this file.
