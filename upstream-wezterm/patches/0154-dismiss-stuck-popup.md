# 0154 — A stuck menu must not block the next one

**Status:** Implemented 2026-09-23.

## Symptom

Clicking the tray icon or the right-click menu did nothing. The log was:

```
TrackPopupMenuEx returned 0 after 21.5µs (err=1446)
TrackPopupMenuEx failed again (err=1446)
```

1446 is `ERROR_POPUP_ALREADY_ACTIVE`: Windows still counts a menu as
open. The patch 0146 retry only took the foreground, so every later
click failed the same way until the GUI process was restarted.

## Fix

On 1446, call `EndMenu` and `WM_CANCELMODE` on the owner before the
foreground retry. That drops the menu the thread still considers
active, including one the user cannot see, and the new menu opens.

## Files

- `wtinator/src/context_menu.rs`

## Revert

Remove the `EndMenu` / `WM_CANCELMODE` block. Remove row 0154 and this
file.
