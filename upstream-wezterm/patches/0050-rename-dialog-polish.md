# Patch 0050 — Rename dialog: consistent background + tighter layout

**Status:** Implemented 2026-06-14. Tweaks patch 0030's Win32 rename dialog
(`wtinator/src/header/win32_prompt.rs`), used by "Rename tab…" and the
per-pane header rename.

## Fixes
- **Faint grey box** around the label / controls: the window class background
  was `WHITE_BRUSH` (#FFF) while the controls' `WM_CTLCOLOR*` painted `#FAFAFA`,
  so the off-white controls showed as boxes on the white dialog. The class
  background now uses the SAME `dialog_brush()` (#FAFAFA) as the controls, so it
  is seamless.
- **Dead space + excess height**: there was a ~42 px gap between the edit and
  the buttons and the dialog was taller than needed. Tightened: `DIALOG_H`
  170 → 150, `EDIT_H` 32 → 28, `BUTTON_Y` 110 → 84 (just below the edit),
  buttons 110×36 → 100×30 with a proper 10 px gap, 16 px margins, and the
  vertical centring offset updated to the new height.

No behaviour change — only the dialog's appearance.
