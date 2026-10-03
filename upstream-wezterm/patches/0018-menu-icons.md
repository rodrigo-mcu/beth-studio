# Patch 0018 — Menu icons (16x16 RGBA, GDI-rendered)

**Applied:** 2026-06-07
**Files:**
- `upstream-wezterm/wtinator/src/menu_icons.rs` (new)
- `upstream-wezterm/wtinator/src/context_menu.rs`
- `upstream-wezterm/wtinator/Cargo.toml`

**Status:** Active

## What

A small monochrome icon now appears to the left of every entry
in the right-click context menu. The 18 icons (cmd, PowerShell,
PowerShell 7, WSL default, WSL Ubuntu, Git Bash, Copy, Paste,
Select all, Save scrollback, Split right, Split down, Close pane,
Theme paint, Open folder, Theme VSCode light, Theme VSCode dark,
Theme Windows Terminal) are rendered as 16x16 32-bpp bitmaps at
runtime using Win32 GDI primitives, and cached in a process-wide
`Mutex<HashMap<MenuIconId, isize>>`.

## How

`NativeMenuItem` gains one extra field:

```rust
pub struct NativeMenuItem {
    pub w_id: u16,
    pub kind: NativeCommand,
    pub label: String,
    pub enabled: bool,
    pub icon: Option<MenuIconId>,
}
```

The Windows `show_at` builder resolves `item.icon` to an
`HBITMAP` handle via `crate::menu_icons::handle(id)`, and when the
handle is non-null it builds a `MENUITEMINFOW` with
`MIIM_BITMAP | MIIM_ID | MIIM_STRING | MIIM_STATE` and calls
`InsertMenuItemW` with `hbmpItem = hbm`. When the handle is
`None`, it falls back to the legacy `AppendMenuW` path (no
`MIIM_BITMAP`).

## Why GDI (and not bundled PNGs or Skia)

Bundled PNGs would add a new dep on the `png` crate plus several
KiB per icon, and Skia drawing would be overkill for 18
silhouettes. GDI primitives compile to ~600 LoC of code, the
icons pick up the system menu text colour automatically (we read
`COLOR_MENUTEXT` at render time so dark mode works), and the
1-KiB-per-icon memory cost is negligible.

## Threading

Icons are rendered lazily on the first call (which happens on
the GUI thread inside `show_at`). The handles are stored as
`isize` (which is `Send`) rather than raw `*mut c_void` pointers
(which are not), and cached in a `Mutex<HashMap>`. The cache
lives for the process lifetime — we never call `DeleteObject`
on the bitmaps because the OS reclaims them at process exit.

## Revert

1. In `wtinator/Cargo.toml`, drop the `Win32_Graphics_Gdi` feature
   from the `windows-sys` dep.
2. Delete `wtinator/src/menu_icons.rs`.
3. In `wtinator/src/lib.rs`, drop the `pub mod menu_icons;` line.
4. In `wtinator/src/context_menu.rs`:
    - Drop the `icon: Option<MenuIconId>` field from
      `NativeMenuItem`.
    - Drop the `MenuIconId` type alias (or `use`).
    - Drop the `icon: Some(MenuIconId::...)` initialisers in
      every builder.
    - Restore the legacy `populate_items_into` that uses
      `AppendMenuW` only (no `MENUITEMINFOW` / `MIIM_BITMAP`).
    - Drop the `MENUITEMINFOW` / `InsertMenuItemW` / `HBITMAP` /
      `MIIM_*` imports.
5. Remove this file and the row for patch 0018 from `PATCHES.md`.

## Risk

Low. The change is contained to `wtinator`; the upstream
`wezterm-gui` is not modified. When `item.icon` is `None`, the
fallback to `AppendMenuW` is byte-equivalent to the previous
behaviour. The `MENUITEMINFOW` / `InsertMenuItemW` path is only
taken for items that explicitly carry an icon, and a failure
there is no worse than a missing icon (the function returns
`false`, the caller bails).

30/30 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
