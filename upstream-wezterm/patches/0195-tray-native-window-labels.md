# 0195 — Tray labels name the native windows

**Status:** Implemented 2026-09-27.

## What

Two tray entries said "interface" without saying which one. Beth Studio
is an interface too, so it was not clear what they turned on or
restarted.

| Before | After |
|---|---|
| Interface gráfica | Janelas de terminal nativas |
| Reiniciar interface (terminais continuam) | Reiniciar janelas nativas (terminais continuam) |

Behavior is unchanged: the first entry is still the on/off check from
patch 0192, the second still restarts only `bethterm-gui.exe` (patch
0147). The log names of both actions and the hint in the
`TrackPopupMenuEx` failure warning use the new labels.

## Files

- `wtinator/src/tray.rs`
- `wtinator/src/context_menu.rs`
- `wtinator/src/gui_restart.rs` (doc comment)

## Revert

Put the two old strings back in those files. Remove row 0195 and this
file.
