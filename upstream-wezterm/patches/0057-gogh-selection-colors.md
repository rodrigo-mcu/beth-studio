# Patch 0057 — Visible selection colours for downloaded Gogh themes

**Status:** Implemented 2026-06-16.

## Symptom

The user reported that text selection is invisible on some themes:

> "dependendo do tema nao da pra ver a selecao, é isso, dependendo do tema
> nao da pra ver o texto selecionado"

Built-in themes (VSCode Light/Dark, Windows Terminal Dark) showed the
selection normally, but themes downloaded from the Gogh catalog did not.

## Cause

`wtinator/src/theme_download.rs` converted Gogh entries into `SavedTheme`
objects. Because the Gogh JSON schema has no `selection_fg` / `selection_bg`
fields, the code copied the theme's foreground/background into those slots:

```rust
let selection_fg = self.foreground.clone();
let selection_bg = self.background.clone();
```

When the theme was applied, `palette_for_saved()` then produced a
`ColorPalette` whose `selection_fg` and `selection_bg` were exactly the
theme's normal text/background colours. The renderer painted selected text
with the same colours as unselected text, making the selection invisible.

## Fix

Derive a visible selection colour instead of copying fg/bg.

In `wtinator/src/theme_download.rs`:

1. Added a small `luminance()` helper (BT.601).
2. Added `derive_selection_colors(fg, bg)` which mixes `background` with
   `foreground`, increasing the mix until the luminance delta against the
   background is at least `0.20`. This guarantees the highlight is always
   visibly different from the background, regardless of the theme's ANSI
   palette.
3. `selection_fg` is kept equal to the theme's foreground so selected text
   stays legible.
4. The derivation is called both in `GoghEntry::into_saved()` (so the
   config-app preview is accurate) and in `palette_for_saved()` (so themes
   already cached with the old fg/bg copy are also fixed automatically when
   reapplied).
5. A fallback path handles the degenerate case where foreground and
   background have nearly identical luminance by mixing with black or white.

## Files

- `wtinator/src/theme_download.rs`

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly check -p wezterm-gui
cargo +nightly build -p wezterm -p wezterm-gui
cargo +nightly test -p wtinator
```

After rebuilding, downloading or re-applying a Gogh theme shows selected
text with a visible highlight. The `derive_selection_colors_*` and
`palette_from_saved_builds_a_palette` tests guard the behaviour.

**Note:** the `run-wezterminator-release.cmd` launcher uses the release
binary in `upstream-wezterm/target/release/`. Make sure to rebuild that
profile (`cargo +nightly build --release -p wezterm -p wezterm-gui`) before
testing with the release launcher.
