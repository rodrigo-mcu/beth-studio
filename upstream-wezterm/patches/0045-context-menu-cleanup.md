# Patch 0045 — Right-click menu cleanup + submenu icons

**Status:** Implemented 2026-06-14. Depends on patches 0018 (menu icons),
0028/0039/0040 (the entries being moved), 0043 (the config window that absorbs
them).

Now that "Configure this terminal…" (patch 0040/0043) owns the per-terminal
theme, font family and font size, the standalone in-menu submenus for those were
redundant. This patch slims the right-click menu and adds icons to the split
submenus.

## Changes — `wtinator/src/context_menu.rs`

`full_menu_items()` restructured:
- **"Configure this terminal…" moved to the TOP** (was buried after the
  clipboard group). It is the single entry point for theme + font family + size.
- **Removed** three submenus (their builder fns are kept for tests / dispatch):
  - `&Theme` (`theme_submenu_items`) — theme is per-terminal via Configure.
  - `Font &size` (`font_size_submenu_items`) — size is per-terminal via Configure.
  - `&Move pane to` (`move_pane_submenu_items`) — declutter.
- New order: Configure · sep · shells · split right/down · sep · Copy / Paste /
  Paste image / Select all / Save scrollback / Rename tab / Screenshot · sep ·
  Close pane.

### Submenu icons
`MenuEntry::Submenu` gained an `icon: Option<MenuIconId>` field. `populate_hmenu`
renders it via `MENUITEMINFOW { fMask: MIIM_STRING | MIIM_SUBMENU | MIIM_BITMAP,
hSubMenu, hbmpItem }` (the icon-less path still uses `AppendMenuW(MF_POPUP)`).
"Split right" / "Split down" now show the existing `MenuIconId::SplitRight` /
`SplitDown` glyphs.

Test `full_menu_includes_shells_splits_and_close` updated for the new count
(`default_shells().len() + 14`), asserts Configure is first, and asserts the
Theme / Move-pane submenus are gone.

## Note on the keyboard
The `IncreasePaneFontSize` / `DecreasePaneFontSize` / `ResetPaneFontSize`
key assignments (`CTRL+SHIFT+=/-/0`, patch 0039) still exist but effectively
collide with the global font-zoom (`CTRL+=`) on US/ABNT layouts, where
`SHIFT+=` normalises to `+`. Per-terminal font is now driven from the config
window, so the keyboard path is no longer the primary interface; rebinding it to
a non-colliding chord is a follow-up.

## Follow-up (not in this patch)
- **Modern icons.** The menu icons are hand-drawn 16×16 GDI silhouettes
  (`wtinator/src/menu_icons.rs`). A crisper set could render glyphs from
  "Segoe MDL2 Assets" (Win10) / "Segoe Fluent Icons" (Win11) via `DrawTextW`
  into the same DIB, mapping each `MenuIconId` to a codepoint.
