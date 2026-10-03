# 0140 — Host sync must not kill the GUI when a local window is gone

**Status:** Implemented 2026-09-21.

## Symptom

Right-click → move a tab to a new window, then a few seconds later the
whole GUI exits. Log:

```
wezterminator: moved tab 2 to new window 4
panic at wezterm-client\src\domain.rs:624:26 - !?
```

## Cause

`ClientDomain::process_pane_list` keeps a remote-window → local-window
map. Moving the last tab out of a local window empties it and the mux
drops that window, but the map still points at it. The next host sync
(any `TabResized`) looked the window up with `expect("no such
window!?")` and the panic took the GUI down. The same `expect` existed
in the window-title loop.

## Fix (`wezterm-client/src/domain.rs`)

- If the mapped local window is gone, re-map the remote window to the
  window that now contains the tab (`Mux::window_containing_tab`) and
  continue. If the tab is in no window, drop the mapping and fall
  through to the primary-window / new-window logic.
- The title loop ignores a vanished window.

## Revert

Restore both `expect` calls. Remove row 0140 and this file.
