# Patch 0023 — Use the same font the user has in VSCode

**Applied:** 2026-06-07
**Files:**
- `upstream-wezterm/wtinator/src/vscode_font.rs` (new)
- `upstream-wezterm/wtinator/src/lib.rs`
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs`

**Status:** Active

## What

The freshly constructed `TermWindow` reads the user's
Visual Studio Code `settings.json` and applies
`editor.fontFamily` and `editor.fontSize` as config
overrides, so the terminal uses the same monospace font
the user sees in their editor.

If the user has `JetBrains Mono` set as their editor
font, the terminal uses `JetBrains Mono`; if they have
`Cascadia Code NF` with `fontSize: 12`, the terminal uses
that at 12pt. No `wezterm.lua` is required.

## Where the file lives

We check, in order:

1. `%APPDATA%\Code\User\settings.json`
2. `%APPDATA%\Code - Insiders\User\settings.json`
3. `%APPDATA%\VSCodium\User\settings.json`
4. `%APPDATA%\Cursor\User\settings.json`

The first file that exists wins. If none exists, or if the
file is unparseable, or if neither `editor.fontFamily` nor
`editor.fontSize` is set, no override is produced and the
terminal keeps the upstream default.

## How the override is applied

The upstream `TermWindow::new_window` now reads **three**
override passes — titlebar (patch 0020), vscode_font
(this patch), and cursor colour (patch 0024) — and
chunks them into a single merged `wezterm_dynamic::Value::Object`.
A small helper, `merge_override_passes(a, b)`, is added
to `termwindow/mod.rs` to combine the passes; later passes
win on key conflicts. The user's own `wezterm.lua`
overrides still trump the merged override because the
upstream merge order applies the user config last.

## Limitations / future work

- Strict `serde_json` parsing of `settings.json` — VSCode
  allows JSON5 (comments, trailing commas) and our parser
  rejects those. A future patch could swap in `json5` to
  support them.
- Per-workspace `.vscode/settings.json` is not consulted.
  The user-level file is the right one for the "match the
  editor" goal because the terminal has no notion of a
  workspace.
- `font_fallback` is not propagated. VSCode's
  `editor.fontFamily` accepts a comma-separated list of
  fallbacks; we keep only the primary name because
  wezterm's `font` setting takes a single primary family
  plus its own fallback list (managed via the
  `wezterm.font_with_fallback` Lua API).

## Revert

1. In `wtinator/src/lib.rs`, drop the `pub mod vscode_font;` line.
2. Delete `wtinator/src/vscode_font.rs`.
3. In `wezterm-gui/src/termwindow/mod.rs`:
    - Drop the `merge_override_passes` helper.
    - Drop the `wtinator::vscode_font::default_overrides()`
      call in `new_window` and the second `merge_override_passes`
      call.
4. Remove this file and the row for patch 0023 from
   `PATCHES.md`.

## Risk

Low. The change is read-only on disk (we open the user's
`settings.json` for read only, parse it strictly, and never
write). The override is silent — a missing file, a parse
error, or an unrelated settings.json (a different user
profile) just means "no override" and the terminal keeps
the upstream default. The user can always pin a font in
their `wezterm.lua` to opt out.

50/50 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and
release with no new warnings.
