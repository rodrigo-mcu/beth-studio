# Patch 0007 — LeftStatus/RightStatus open the split picker

**Applied:** 2026-06-06
**File:** `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` (`mouse_event_tab_bar`)
**Status:** Active

## What

```diff
-                TabBarItem::None | TabBarItem::LeftStatus | TabBarItem::RightStatus => {
+                TabBarItem::LeftStatus | TabBarItem::RightStatus => {
+                    // WezTerminator local patch (2026-06-06): see PATCHES.md
+                    // patch 0007. The `LeftStatus` and `RightStatus` areas
+                    // of the tab bar are normally inert text. We
+                    // repurpose them as a "Split" affordance for mouse
+                    // users: a single left-click on the status area
+                    // opens the split picker (split right / split down).
+                    let menu = wtinator::context_menu::build_split_picker();
+                    self.show_input_selector(&menu);
+                    return;
+                }
+                TabBarItem::None => {
                     let maximized = self
```

## Why

The `LeftStatus` / `RightStatus` areas of the tab bar are normally
inert text (set by Lua `window:set_left_status`). We repurpose them
as a **mouse target for the split picker**. The user can click
anywhere in the status area to open the picker.

**Important caveat:** the patch only fires if the `LeftStatus` or
`RightStatus` items are *present* in the `ui_items` list. The upstream
`tabbar.rs` only adds them if the user has set a non-empty status
text via Lua. To make this work out-of-the-box (without requiring the
user to set a status first), we also have **patch 0008** that
guarantees a `LeftStatus` item is always added with the label
"[>_]" when the WezTerminator patch is active.

## Mouse UX

| Action | Mouse gesture |
| --- | --- |
| Open split picker | Click the `[>_]` terminal icon (top-left of tab bar) — see patch 0008 |
| Open shell picker | Click the `+` button (top-right) — see patch 0006 |

## Revert

Remove the `TabBarItem::LeftStatus | TabBarItem::RightStatus` arm and
merge it back into the `TabBarItem::None` arm. Also revert
patch 0008 so the label is no longer injected.

## Risk

Low. The `LeftStatus` / `RightStatus` areas were previously inert;
making them click-to-open-split is purely additive.
