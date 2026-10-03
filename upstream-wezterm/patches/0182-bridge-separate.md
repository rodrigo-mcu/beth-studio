# 0182 — Bridge can move a pane out of its host split

**Status:** Implemented 2026-09-25.

## Why

The web UI can resize a pane to fill its own window (patch 0178), but
only when that pane is alone in its BethTerm tab — resizing one leaf of
a host split re-lays the whole split tree and can squeeze its
neighbours (the bug fixed by 0163/0172). A pane the user had split in
the GUI (e.g. "CLIENTE 5000" sharing a tab with another shell) could
not be fitted to the web window at all.

## Protocol

```
{"op":"separate","pane_id":33}
  -> {"ev":"separated","pane_id":33,"tab_id":40,"window_id":6}
```

- Refused (`"pane N is already alone in its BethTerm tab"`) if the pane
  has no split-mate.
- Otherwise sends `MovePaneToNewTab` for that pane, targeting the same
  host window it is already in (found via the last `list`), so the GUI
  simply shows one more tab in that window — nothing is closed or
  moved to a different window.
- Only on an explicit, confirmed user action in the web UI
  ("Separar no BethTerm…"); the confirmation dialog says plainly that
  the pane leaves its split and becomes its own tab, and that nothing
  is closed. After `separated`, the web UI switches that pane to "fit
  to window" (0178) automatically.

## Files

- `wezterm/src/cli/bridge.rs`
- `wezterm/src/cli/list.rs` (`window_id` made visible to the bridge)

## Revert

Remove the `Separate` request, `Event::Separated` and the
`move_pane_to_new_tab` call. Remove row 0182 and this file.
