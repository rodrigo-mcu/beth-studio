# Patch 0017 — Theme submenu in the right-click context menu

**Applied:** 2026-06-06
**Files:**
- `upstream-wezterm/wtinator/src/context_menu.rs`
- `upstream-wezterm/wtinator/src/themes_folder.rs` (new)
- `upstream-wezterm/wtinator/src/lib.rs`
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`

**Status:** Active

## What

A new **Theme ▶** submenu in the right-click full menu, sitting
between the "Save scrollback as…" entry and the split submenus:

```
─────────────────
VSCode Light
VSCode Dark
Windows Terminal Dark
─────────────────
Open themes folder…
```

The first three entries apply one of the baked-in schemes
introduced in patch 0016. The fourth opens the user's wezterm
config directory in the OS file manager so they can drop a
custom `*.toml` scheme into the `colors/` subfolder.

The submenu uses the existing `MenuEntry::Submenu` machinery from
patch 0012 — no new render code, no new dispatch infrastructure
beyond two new `DispatchAction` variants.

## Architecture

### New `DispatchAction` variants

```rust
pub enum DispatchAction {
    Assignment(KeyAssignment),
    SaveScrollback,
    SetTheme(ThemeId),       // <-- new
    OpenThemesFolder,        // <-- new
}
```

`classify(w_id)` is extended:

```rust
0x5001 => Some(DispatchAction::SetTheme(ThemeId::VsCodeLight)),
0x5002 => Some(DispatchAction::SetTheme(ThemeId::VsCodeDark)),
0x5003 => Some(DispatchAction::SetTheme(ThemeId::WindowsTerminalDark)),
0x5004 => Some(DispatchAction::OpenThemesFolder),
```

The new wID range `0x5000+` is contiguous with the `0x1000–0x4004`
wIDs already in use — the next free range is `0x6000+` for future
patches.

### `SetTheme` handler (in `mouseevent.rs`)

The handler builds the `ColorPalette` from the `ThemeId` and
posts a `TermWindowNotif::Apply(closure)` to the GUI thread:

```rust
gui_window.notify(TermWindowNotif::Apply(Box::new(move |tw| {
    tw.set_color_scheme(palette);
})));
```

`set_color_scheme` was added in patch 0016. Using the existing
`Apply` notification means we do not need a new
`TermWindowNotif` variant — the same plumbing that lets
upstream Lua scripts run arbitrary code on the GUI thread also
covers our case.

### `OpenThemesFolder` handler (in `wtinator::themes_folder`)

The new module resolves the user's wezterm config directory in
this order:

1. `$WEZTERM_CONFIG_DIR` (if set and non-empty)
2. `%APPDATA%/wezterm` (Windows) — `$XDG_CONFIG_HOME/wezterm` or
   `~/.config/wezterm` (Linux) — `~/Library/Application
   Support/wezterm` (macOS)
3. `create_dir_all` the resolved path so a brand-new user can
   drop a file into it without first launching the GUI

It then spawns the OS file manager:

- Windows: `explorer.exe <dir>`
- macOS: `open <dir>`
- Linux/BSD: `xdg-open <dir>`

The spawned process is detached — we do not wait on it. The
function is best-effort: errors are surfaced via
`log::error!` but do not crash the caller.

## Revert

1. Delete `wtinator/src/themes_folder.rs`.
2. In `wtinator/src/lib.rs`, drop the `pub mod themes_folder;` line.
3. In `wtinator/src/context_menu.rs`:
    - Drop the `SetTheme(ThemeId)` and `OpenThemesFolder` variants
      from `NativeCommand`.
    - Drop the corresponding `0x5001`..`0x5004` arms in `w_id()`,
      `dispatch_native`, and `classify`.
    - Drop the `SetTheme` and `OpenThemesFolder` arms of
      `DispatchAction`.
    - Drop the `theme_submenu_items()` builder and its insertion
      in `full_menu_items()`.
4. In `wezterm-gui/src/termwindow/mouseevent.rs`, drop the
   `Some(DispatchAction::SetTheme(_))` and
   `Some(DispatchAction::OpenThemesFolder)` arms in
   `schedule_native_menu`, and the `use wezterm_term::color::ColorPalette;`
   import (which becomes unused).
5. Drop the new tests
   (`classify_routes_themes`,
    `theme_submenu_lists_three_themes_and_open_folder`,
    `themes_folder::config_dir_creates_directory_if_missing`,
    `themes_folder::open_path_in_file_manager_path_succeeds`),
   update `all_w_ids_are_unique` to not assert on the 0x500X
   wIDs, and update `full_menu_includes_shells_splits_and_close`
   to expect 16 entries.
6. Remove this file and the row for patch 0017 from `PATCHES.md`.

## Risk

Low. The changes are additive:

- A new `MenuEntry::Submenu` in `full_menu_items()` (the
  `MenuEntry::Submenu` machinery is already exercised by the
  split submenus from patch 0012).
- Two new `DispatchAction` variants routed by `classify`.
- A new module that resolves a path and spawns a process.
- Two new test cases.

The `set_color_scheme` method that the `SetTheme` arm calls was
added in patch 0016 and is itself low-risk.

28/28 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
