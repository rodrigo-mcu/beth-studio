# 0181 — A bell no longer means "waiting" forever

**Status:** Implemented 2026-09-25.

## Symptom

The web UI's "agent waiting" indicator (patch 0175) stayed lit on a
Claude Code pane that was, in fact, still working: "Waiting for 2
background agents" in the transcript, but the web showed "aguardando
você" until the user typed in that pane.

## Cause

Claude Code rings the terminal bell (or sends an OSC 9 toast) at the
end of each turn, even when it immediately keeps going on background
work. The bridge treated bell/toast the same as a `claude_status`
user-var wait: sticky until the next input.

## Fix

A bell/toast-sourced wait is cleared automatically, with
`{"ev":"agent","waiting":false,"reason":"working"}`, as soon as the
pane's title shows a working spinner glyph (◐ ◑ ◒ ◓ — the same set the
GUI's tab bar already recognizes). This is checked on every `list`
refresh.

A `claude_status`/`*_status`/`*_waiting` user-var wait is untouched:
the hook that sets it also clears it explicitly, so it does not need
this heuristic.

## Files

- `wezterm/src/cli/bridge.rs`

## Revert

Remove the working-spinner check after `tab_of`/`per_tab` is rebuilt
from `list`. Remove row 0181 and this file.
