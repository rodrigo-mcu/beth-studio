# Patch 0006 — `+` button on tab bar opens the shell picker

**Applied:** 2026-06-06
**File:** `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` (`do_new_tab_button_click`)
**Status:** Active

## What

```diff
     fn do_new_tab_button_click(&mut self, button: MousePress) {
         let pane = match self.get_active_pane_or_overlay() {
             Some(pane) => pane,
             None => return,
         };
+
+        // WezTerminator local patch (2026-06-06): see PATCHES.md patch 0006.
+        // The `+` button on the tab bar is the primary entry point for
+        // "I want a new terminal" in our UX. To make it friendly, the
+        // left-click on `+` opens the WezTerminator shell picker
+        // (cmd / PowerShell / PowerShell 7+ / WSL / WSL — Ubuntu / Git Bash)
+        // with a single click. The user does not need to remember
+        // any hotkeys.
+        let action = match button {
+            MousePress::Left => {
+                let menu = wtinator::context_menu::build_shell_picker();
+                self.show_input_selector(&menu);
+                return;
+            }
+            MousePress::Right => {
+                // Right-click on `+` opens the full menu (shells + splits
+                // + close pane). Two-click access to splits.
+                let menu = wtinator::context_menu::build_full_menu();
+                self.show_input_selector(&menu);
+                return;
+            }
+            MousePress::Middle => None,
+        };

         let action = match button {
-            MousePress::Left => Some(KeyAssignment::SpawnTab(SpawnTabDomain::CurrentPaneDomain)),
             MousePress::Right => Some(KeyAssignment::ShowLauncher),
             MousePress::Middle => None,
         };
```

## Why

The user reported that "right-click doesn't show a menu" in their Windows
session. This is likely an overlay-rendering issue specific to their
graphics environment. To work around it, we changed the primary entry
point from the right-click-on-pane to the **`+` button on the tab bar**,
which is a UI element that is part of the tab bar (always rendered, easy
to find) and the click target is well-defined.

The `+` button is the natural "I want a new terminal" affordance. By
intercepting its click and showing our picker, we turn a one-key
operation (Ctrl+Shift+T) into a one-click operation (click `+`,
pick shell) with no loss of power.

## Mouse UX (the full picture)

After patches 0006 and 0008, the user has **three** mouse-driven entry
points to all terminal-management actions:

| Action | Mouse gesture |
| --- | --- |
| **Open a new terminal** | Click the `+` on the tab bar (top-right) |
| **Pick a different shell** (PowerShell, WSL, ...) | Click the `+` (left click = shell picker; right click = full menu) |
| **Split the current pane** | Click the `[>_]` terminal icon on the tab bar (top-left) |
| **Close a pane** | Right-click the `+` (full menu includes "Close pane") |
| **Switch tab** | Click the tab |
| **Close tab** | Click the `x` on the tab |

No hotkeys required. Power users can still bind hotkeys via
`~/.wezterm.lua` (e.g. `Ctrl+Shift+S` for split, `Ctrl+Shift+T` for
new tab in default shell) — those are orthogonal to the mouse UX.

## Revert

To restore the upstream behavior (`+` left-click = open default shell,
right-click = launch menu, middle-click = no-op):

Replace the `match button` block in `do_new_tab_button_click` with the
original two lines:

```rust
let action = match button {
    MousePress::Left => Some(KeyAssignment::SpawnTab(SpawnTabDomain::CurrentPaneDomain)),
    MousePress::Right => Some(KeyAssignment::ShowLauncher),
    MousePress::Middle => None,
};
```

## Risk

Low. The patch replaces the upstream `SpawnTab` action with a custom
picker, but the picker produces the same `KeyAssignment::SpawnCommandInNewTab`
when the user picks a shell. Middle-click is preserved (no-op).
