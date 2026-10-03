# 0178 — The bridge can resize a host pane

**Status:** Implemented 2026-09-25.

## Why

The web UI mirrored each pane at the size the host has (the GUI's pane
size) and centred it, scaling the font. With a fixed font the grid left
large empty margins ("é estranho", 2026-09-25). A terminal is expected
to fit its columns/rows to its window.

## Protocol

```
{"op":"resize","pane_id":33,"cols":140,"rows":40}
```

- Only for a pane that is alone in its host tab (from the last `list`).
  A pane in a host split is refused with an error: resizing one leaf
  re-lays the host split tree (`rebuild_splits_sizes_from_contained_panes`)
  and can squeeze its neighbours, the bug fixed by 0163/0172.
- Cols clamped to 10–500, rows to 4–300; pixel size keeps the pane's
  current cell size and dpi.
- The pane is shared: the GUI shows the new size too. The web UI must
  not fight the GUI (resize on its own layout changes or on request,
  never in a loop when the host size changes).

## Files

- `wezterm/src/cli/bridge.rs` — `Resize` request, `resize_pane`
- `wezterm/src/cli/list.rs` — `tab_id` visible to the bridge

## Revert

Remove the request, `resize_pane` and the `tab_of` map. Remove row 0178
and this file.
