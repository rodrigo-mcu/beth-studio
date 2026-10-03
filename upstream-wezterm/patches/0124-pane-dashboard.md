# 0124 — Left-rail pane dashboard

**Status:** Implemented 2026-09-16.

## What

A **Painel** in the running GUI: a left list of every live mux pane
(local and host). Click a row and that terminal appears on the right.

- Click a name: switch that terminal onto the right. No split.
- While the rail is open the tab strip is hidden (window buttons stay).
  The left list is the only navigator, so 40 terminals do not become
  40 visible tabs.
- Other-window pane: its tab is moved here for display only.
- Closing the rail restores the tab strip and the tab's own layout.
- Clicks never write to the PTY, so an agent waiting for input is
  not disturbed.
- Tray menu entry **Painel** (after **Sistema**) opens or focuses the
  rail. With no GUI window it spawns one and opens the rail.
- Tray **Janela nova como** chooses the default: **Abas (clássico)** or
  **Painel**. Saved in `%APPDATA%\bethterm\ui-mode.json`. Missing file
  is classic. **Novo terminal** follows that default. × on the rail
  returns that window to tabs without changing the default.
- The rail insets `padding_left_top` and `resize.rs` so the PTY
  width is correct. Close with the × on the header.

## Files

- `wtinator/src/dashboard.rs` (new)
- `wtinator/src/lib.rs`, `wtinator/src/tray.rs`
- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/src/termwindow/mouseevent.rs`
- `wezterm-gui/src/termwindow/resize.rs`
- `wezterm-gui/src/termwindow/render/{mod.rs,paint.rs,dashboard.rs}`

## Revert

Remove the module, tray entry, `UIItemType` variants, and the
padding/resize insets.
