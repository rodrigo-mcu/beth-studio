# 0193 — Close window leaves the host

**Status:** Implemented 2026-09-27.

## What

The native confirmation **Fechar esta janela** used to say that the
tabs and the programs in them would be killed, then called
`kill_window`. That detaches the whole host domain from the GUI.

Yes now closes only that GUI window. Client panes are marked
`ignore_next_kill` and the window is dropped with `release_window`,
which does not detach the domain and does not send `KillPane`. The
host, the shells, and Beth Studio stay. The second confirmation says
the same thing.

## Files

- `mux/src/lib.rs` (`release_window`)
- `wtinator/src/confirm.rs`
- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/src/overlay/confirm_close_pane.rs`

## Revert

Remove `release_window` and `close_gui_window_keep_host`, and restore
the old confirmation text and `kill_window` call. Remove row 0193 and
this file.
