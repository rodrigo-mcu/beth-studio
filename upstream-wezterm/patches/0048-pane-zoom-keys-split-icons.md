# Patch 0048 — Ctrl+/− zoom the focused terminal; cleaner split icons

**Status:** Implemented 2026-06-14.

Two UX fixes requested by the user.

## 1. `Ctrl +` / `Ctrl -` / `Ctrl 0` now zoom ONE terminal

Previously plain `Ctrl + =/-/0` was the **whole-window** font zoom, and the
per-pane zoom was on `Ctrl+Shift+ =/-/0` — which, via shift normalisation
(`Shift+=` → `+`), collided with the window zoom and fired it unexpectedly.

`wezterm-gui/src/commands.rs`:
- `IncreasePaneFontSize` / `DecreasePaneFontSize` / `ResetPaneFontSize` →
  **`Ctrl + =`/`-`/`0`** (zoom just the focused terminal).
- `IncreaseFontSize` / `DecreaseFontSize` / `ResetFontSize` (whole window) →
  **`Super + =`/`-`/`0`** only (the plain-`Ctrl` bindings were removed so they
  can't collide with the per-pane ones).

So `Ctrl +`/`Ctrl -` is now per-terminal (the common case); the whole-window
zoom lives on the Windows/Super key.

## 2. Split-right / split-down icons

`wtinator/src/menu_icons.rs` — the old icons were a filled block + an arrow,
which read oddly. Replaced with a terminal **outline** plus a single divider:
- **Split right**: a vertical divider toward the right (new pane on the right).
- **Split down**: a horizontal divider toward the bottom (new pane below).

## Build
```
cargo +nightly build --release -p wezterm-gui   # Perl on PATH; covers wtinator too
```
