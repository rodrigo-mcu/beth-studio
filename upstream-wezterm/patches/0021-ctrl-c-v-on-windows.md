# Patch 0021 — `Ctrl+C` / `Ctrl+V` / `Ctrl+Insert` on Windows (and Linux)

**Applied:** 2026-06-07
**Files:**
- `upstream-wezterm/wezterm-gui/src/commands.rs`

**Status:** Active

## What

Three additional default key bindings are appended to
`CommandDef::default_key_assignments` on non-macOS targets:

| Mods | Key | Action |
| --- | --- | --- |
| `CTRL` | `Char('v')` | `PasteFrom(ClipboardPasteSource::Clipboard)` |
| `CTRL` | `Char('c')` | `CopyTo(ClipboardCopyDestination::ClipboardAndPrimarySelection)` |
| `CTRL` | `Insert` | `PasteFrom(ClipboardPasteSource::PrimarySelection)` |

The existing upstream `SUPER + v` / `SUPER + c` / `SUPER + Insert`
bindings are untouched — they keep working on macOS (where
`SUPER` means `Cmd`) and are no-ops on Windows (where `SUPER`
would otherwise require the literal `Win` key). The new `CTRL`
bindings cover what Windows and Linux users expect.

## Why

The upstream `wezterm-gui/src/commands.rs::compute_default_actions`
emits `PasteFrom(ClipboardPasteSource::Clipboard)` with the
keys `vec![(Modifiers::SUPER, "v".into())]`. `SUPER` is
mapped to:

- **`Win`** on Windows
- **`Cmd`** on macOS
- **`Win`** on Linux

The macOS case is correct (the platform convention is `Cmd+V`).
The Windows and Linux cases are not — the user expects
`Ctrl+V` on both platforms. Pressing `Ctrl+V` in a wezterm
window on Windows does **nothing** today because the default
keymap does not contain that combination.

This is a long-standing user-visible bug in upstream
([wezterm/wezterm#3262]-class — see the upstream
`InputMap::new` comment about the `Ctrl+V → PasteFrom`
duplicate-bind-avoidance logic) that has not landed a fix.

The `inputmap.rs:51-86` loop already supports adding extra
default keys (it just runs after the user's `config.keys`
are loaded, so a user override wins). The new bindings go
through that loop, which means:

- A user who sets `config.keys = { { key = "v", mods = "CTRL", action = "SendString 'hi'" }}`
  in their `wezterm.lua` still wins — the new default is
  filtered out by the upstream `(disable_code, disable_mods)
  in keys.default` check.
- A user who sets `config.disable_default_key_bindings =
  true` (full keymap control) gets neither the upstream
  defaults nor these new ones.

## Revert

1. In `wezterm-gui/src/commands.rs`, drop the new
   `if !cfg!(target_os = "macos") && !config.disable_default_key_bindings { ... }` block at the end of `default_key_assignments`.
2. Remove this file and the row for patch 0021 from `PATCHES.md`.

## Risk

Low. The change is additive. The `SUPER` bindings from
upstream are kept (so macOS users see no change) and the
user's `config.keys` table still wins. On Windows and Linux
the user now gets the expected `Ctrl+C` / `Ctrl+V` /
`Ctrl+Insert` behaviour; on macOS the bindings are
compile-time-stripped via `cfg!(target_os = "macos")` so no
double-binding occurs.

34/34 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
