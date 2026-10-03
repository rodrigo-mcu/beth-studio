# 0096 — Active tab uses a top accent, not a foreground frame

## What

Patch 0080 drew a two-pixel **foreground-colour** box around the active tab.
On many themes that colour is an ANSI pink/magenta, so the tab looked like a
selected list item instead of a Windows tab.

BethTerm now draws a 2px azure bar on the **top** edge only (same blue as the
app icon). Left/right/bottom match the tab background so the tab sits on the
content. Upstream (non-BethTerm) rendering is unchanged.

## Files

- `wezterm-gui/src/termwindow/render/fancy_tab_bar.rs`

## Revert

Restore the patch 0080 `BorderColor::new(fg)` full frame.
