# Patch 0024 — Cursor colour auto-picks contrast based on theme

**Applied:** 2026-06-07
**Files:**
- `upstream-wezterm/wtinator/src/cursor_color.rs` (new)
- `upstream-wezterm/wtinator/src/lib.rs`
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs`

**Status:** Active

## What

The freshly constructed `TermWindow` measures the luminance
of the merged `colors.background` and emits a
`colors.cursor_fg` override so the cursor is always the
visual inverse of the background:

| Background | Cursor | Hex |
| --- | --- | --- |
| `background.luminance < 0.45` (dark) | white | `#FFFFFF` |
| `0.45 ≤ luminance ≤ 0.55` (mid-grey) | no override | (upstream default) |
| `luminance > 0.55` (light) | black | `#000000` |

The luminance weights follow ITU-R BT.601 (`0.299R + 0.587G
+ 0.114B`) because that is the convention the upstream
`wezterm_term::color` uses for `colors.foreground` defaults.

The mid-grey dead-band is important: many real-world
"dark" themes (e.g. `Material Theme Darker`,
`Solarized Dark`) have a background around `#1F1F1F` to
`#002B36` and the upstream default cursor already
contrasts well. Overriding to pure white would not be a
visible improvement, and the dead-band keeps us from
churning the override on every config reload.

## How the override is applied

`TermWindow::new_window` runs the cursor-colour pass
*after* the titlebar and vscode_font passes (patches 0020
and 0023). The merged `config`'s `colors.background` is
read; if `Option<None>` (the user has no background set
or set it via custom `ColorPalette`), we fall back to
`(0.0, 0.0, 0.0)` (treating the screen as "dark" — a
sensible default because most terminals default to a dark
background).

The user's own `colors.cursor_fg` setting still wins
because the upstream merge order applies the user-facing
config last. The patch is opt-out by setting
`colors.cursor_fg` in `wezterm.lua` to any value (even
`"#888888"` — the override only fires when the user has
NOT set the field).

## Revert

1. In `wtinator/src/lib.rs`, drop the `pub mod cursor_color;` line.
2. Delete `wtinator/src/cursor_color.rs`.
3. In `wezterm-gui/src/termwindow/mod.rs`:
    - Drop the cursor-overrides block and the
      `merge_override_passes(overrides, cursor_overrides)`
      call in `new_window`.
4. Remove this file and the row for patch 0024 from
   `PATCHES.md`.

## Risk

Low. The override is computed from the merged config's
`colors.background` and written as a single
`colors.cursor_fg` key. The upstream merge picks the
value up the same way it picks up any
`config.colors.*` change, so we are not introducing a
new code path. The dead-band means that mid-grey
backgrounds (the only case where a wrong call would be
visible) defer to the upstream default — so the worst-case
visible regression is "the cursor didn't change when I
expected it to", not "the cursor is invisible".

50/50 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and
release with no new warnings.
