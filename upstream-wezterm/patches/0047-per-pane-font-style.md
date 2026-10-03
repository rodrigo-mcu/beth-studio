# Patch 0047 — Per-terminal font BOLD / ITALIC

**Status:** Implemented 2026-06-14. Extends patch 0043 (per-terminal font
family + size); same architecture, one more style axis.

Each pane can render its font **bold** and/or **italic**, toggled from
"Configure this terminal…". Like family/size, the style is per-pane, lives in
the mux as intent, is built by the GUI, reflows correctly, and persists.

## Changes

- **config** (`config/src/lib.rs`): `with_font_family` generalised to
  `with_font_override(family: Option<&str>, bold, italic)` — clones the window
  config and sets the primary `FontAttributes` weight (`FontWeight::BOLD`) /
  style (`FontStyle::Italic`). When `family` is `None` the bold/italic apply to
  the config's *current* primary (so the window font can be styled too).
  `with_font_family` is now a thin wrapper.
- **mux** (`mux/src/pane.rs`, `localpane.rs`): `get/set_font_bold`,
  `get/set_font_italic` (default false; `LocalPane` stores them).
- **render** (`render/mod.rs`): `fonts_and_metrics_for_pane_font(scale, family,
  bold, italic)` — builds via `with_font_override` when family/bold/italic is
  set; `PaneFontKey` gains `bold`/`italic`. `paint_pane` reads & passes them.
- **geometry** (`termwindow/mod.rs`): `apply_pane_font_scale_change` and
  `ensure_pane_geometry` treat a pane as "styled" when family **or** bold **or**
  italic is set (bold can widen the cell), so `family_ratio` is recomputed and
  the grid reflows.
- **IPC** (`wtinator/src/notify_ipc.rs`): `SetPaneFontStyle{pane_id,bold,italic}`
  → `set_font_bold` + `set_font_italic`; the pipe-server apply then reflows.
- **host + UI** (`wtinator-config/src/main.rs` + `frontend/`):
  `handle_set_pane_font_style` round-trip; `setPaneFontStyle` in ipc.ts; **B / I
  toggle buttons** in the config toolbar (pane mode).
- **persistence** (`wtinator/src/session.rs`, `session_restore.rs`):
  `PaneEntry.font_bold` / `font_italic` (`#[serde(default)]`, back-compatible);
  restored via `set_font_bold` / `set_font_italic`.

## Known limitation
The toolbar B/I checkboxes start unchecked on open (not seeded from the pane's
current style — the snapshot doesn't yet carry `active_pane_bold/italic`).
Toggling still works; seeding is a small follow-up in `wtinator/src/notify.rs`.

## Build
```
cd upstream-wezterm/wtinator-config/frontend && npm run build
cargo +nightly build --release -p wezterm-gui -p wtinator-config   # Perl on PATH
```
