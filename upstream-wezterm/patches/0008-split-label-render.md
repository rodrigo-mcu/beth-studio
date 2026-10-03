# Patch 0008 - render compact terminal icon on the tab bar

**Applied:** 2026-06-06
**Updated:** 2026-06-07
**File:** `upstream-wezterm/wezterm-gui/src/tabbar.rs` (left_status rendering)
**Status:** Active

## What

```diff
         let left_status_line = parse_status_text(left_status, black_cell.attrs().clone());
+        // WezTerminator local patch (2026-06-06): see PATCHES.md patch 0008.
+        // When the wtinator patch is active, we always emit a LeftStatus
+        // item with a compact terminal icon so the user can click it to
+        // open the split picker. The user's existing left_status text is
+        // preserved in the same item.
+        let wtinator_active = std::env::var_os("WTINATOR_ACTIVE").is_some();
+        if wtinator_active {
+            let mut combined = parse_status_text("[>_] ", black_cell.attrs().clone());
+            combined.append_line(left_status_line.clone(), SEQ_ZERO);
+            items.push(TabEntry {
+                item: TabBarItem::LeftStatus,
+                title: combined.clone(),
+                x,
+                width: combined.len(),
+            });
+            x += combined.len();
+            line.append_line(combined, SEQ_ZERO);
+        } else if left_status_line.len() > 0 {
             items.push(TabEntry {
                 item: TabBarItem::LeftStatus,
                 title: left_status_line.clone(),
                 x,
                 width: left_status_line.len(),
             });
             x += left_status_line.len();
             line.append_line(left_status_line, SEQ_ZERO);
         }
```

## Why

The `LeftStatus` tab bar item is only added by the upstream code if
the user has set a non-empty `left_status` text via Lua. Without that,
the user has no visible affordance to click on to open the split
picker (patch 0007).

By detecting the `WTINATOR_ACTIVE` env var, we always inject a
`LeftStatus` item when the WezTerminator patch is active. The visible
label is now only the compact terminal icon `[>_]`, avoiding the old
text label before the first tab. The user's existing `left_status`
text, if any, is preserved after the icon.

## Env Var: `WTINATOR_ACTIVE`

Set by `wtinator::install()` in `wtinator/src/lib.rs`. The env var
approach was chosen because:

- It survives process lifetime without a global static.
- It is read-only on the upstream side.
- The cost is negligible, called once per tab bar paint.

## Mouse UX

After patches 0006 + 0007 + 0008, the user has a fully mouse-driven
UX for terminal management:

| Action | Mouse gesture |
| --- | --- |
| Open a new terminal | Click `+` on the tab bar |
| Pick a different shell | Click `+`; picker shows all configured shells |
| Split the current pane | Click `[>_]` at the left of the tab bar |
| Open the full menu | Right-click `+` |
| Switch tab | Click the tab |
| Close tab | Click the tab close button |

## Revert

To restore the upstream behavior with no injected split-picker icon,
replace the `if wtinator_active` block with the original:

```rust
if left_status_line.len() > 0 {
    items.push(TabEntry {
        item: TabBarItem::LeftStatus,
        title: left_status_line.clone(),
        x,
        width: left_status_line.len(),
    });
    x += left_status_line.len();
    line.append_line(left_status_line, SEQ_ZERO);
}
```

## Risk

Low. The patch is conditional on the `WTINATOR_ACTIVE` env var. If the
launcher does not set the env var, the tab bar returns to upstream
behavior.
