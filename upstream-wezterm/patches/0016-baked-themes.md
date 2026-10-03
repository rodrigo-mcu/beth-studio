# Patch 0016 — Built-in color schemes + `TermWindow::set_color_scheme`

**Applied:** 2026-06-06
**Files:**
- `upstream-wezterm/wtinator/src/vscode_theme.rs` (implemented — was a Phase 0 stub)
- `upstream-wezterm/wtinator/Cargo.toml`
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs`

**Status:** Active

## What

Two coordinated changes:

1. **Three baked-in `ColorPalette` factories** in
   `wtinator::vscode_theme`:

   - `vscode_light()` — VS Code "Default Light Modern" (2026).
     Background `#FFFFFF`, foreground `#1F1F1F`, selection bg
     `#ADD6FF`, palette tuned for visibility on a white background.
   - `vscode_dark()` — VS Code "Default Dark Modern" (2026).
     Background `#1F1F1F`, foreground `#D4D4D4`, selection bg
     `#264F78`, saturated ANSI palette.
   - `windows_terminal_dark()` — Windows Terminal "Campbell
     Powershell" colors (the dark default on Windows 11).
     Background `#0C0C0C`, foreground `#CCCCCC`, selection bg
     `#063462`, the historical Campbell 16-color palette.

   Each returns a fully-populated
   `wezterm_term::color::ColorPalette` so the consumer does not
   need to derive the 256-color cube or the cursor / selection /
   scrollbar colors — they are all set.

2. **`pub fn set_color_scheme(&mut self, scheme: ColorPalette)`**
   on `TermWindow` in `wezterm-gui`. Replaces the active
   `ColorPalette` in place and bumps `shape_generation` /
   clears the shape cache so the glyph atlases are re-coloured on
   the next paint pass.

## Why a runtime method

The upstream `wezterm_term::color::ColorPalette` already exists
and is the right type — the only thing missing was a way to
**swap it in without a config reload**. Without a runtime method,
the only way to apply a new palette is
`wezterm.reload_configuration()`, which requires the palette to
live in `~/.wezterm.lua` and adds 100ms+ to a single-click menu
action (file parse + Lua callback).

The new `set_color_scheme` is a 6-line method:

```rust
pub fn set_color_scheme(&mut self, scheme: ColorPalette) {
    self.palette = Some(scheme);
    self.shape_generation += 1;
    self.shape_cache.borrow_mut().clear();
}
```

The shape-cache bump is the same line the upstream
`InvalidateShapeCache` notification runs — it forces the renderer
to rebuild the cached `LineQuad`s under the new palette on the
next paint.

## Why bake the palettes in (and not read user config)

The user request was "I want a light theme that looks like the
VSCode I am using right now, and a dark theme that looks like the
Windows Terminal I am using right now, both selectable from the
right-click menu." Reading the user's `config.color_schemes`
table at click time would:

- require the user to maintain a `wezterm.lua` with three custom
  schemes (one for each of our previews), even if they only
  wanted the right-click convenience
- force a Lua re-parse on every menu open, which is at least
  50ms even on a fast machine
- conflict with any user-defined scheme that happens to have the
  same name

The baked-in approach is one-shot at build time, with zero
runtime cost beyond the palette construction (which is just
field assignments).

User-defined schemes are still available: the user can override
the active palette in `~/.wezterm.lua` via the existing
`config.color_scheme = 'X'` key — that path is independent of
this patch.

## ThemeId enum

The new `ThemeId` enum is `#[repr(u16)]` so its variants can be
used as a contiguous wID offset (0..2 → 0x5001..0x5003 in
patch 0017):

```rust
#[repr(u16)]
pub enum ThemeId {
    VsCodeLight = 0,
    VsCodeDark = 1,
    WindowsTerminalDark = 2,
}
```

The order is stable; do not reorder without also updating the
`NativeCommand::SetTheme(theme) as u16` mapping in
`context_menu.rs`.

## Revert

1. In `wtinator/Cargo.toml`, drop the `wezterm-term = { workspace = true }` line.
2. In `wtinator/src/lib.rs`, the `pub mod vscode_theme;` line
   becomes a Phase 0 stub again.
3. In `wezterm-gui/src/termwindow/mod.rs`, drop the
   `pub fn set_color_scheme` method.
4. In `wezterm-gui/src/termwindow/mouseevent.rs`, remove the
   `use wezterm_term::color::ColorPalette;` import (it becomes
   unused once patch 0017 is also reverted).
5. Remove the `theme_submenu_items` / `SetTheme` / `OpenThemesFolder`
   plumbing added by patch 0017 (see `0017-theme-submenu.md`).
6. Remove this file and the row for patch 0016 from `PATCHES.md`.

## Risk

Low. The new `set_color_scheme` is a small additive method that
mirrors what the upstream `InvalidateShapeCache` notification
already does internally. The three `ColorPalette` factories are
pure data. No existing test or path is affected.

28/28 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
