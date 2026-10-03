# Patch 0040 — Per-terminal config window

**Applied:** 2026-06-13
**Status:** Builds clean; runtime not yet visually confirmed (see Verification).

## What

Right-clicking a terminal and choosing **"Configure this terminal…"**
(formerly "Open config app…") now opens the `wtinator-config` app
**scoped to the pane you clicked**. In that window you pick a **theme**
and an **exact font size**, and both apply to **that one terminal
(pane) only** — not the whole window and not the tab's active pane.

This builds directly on two existing per-pane primitives:

- Per-pane **theme**: `Pane::set_palette` / `palette()` (patch 0016.3),
  read per pane by the renderer.
- Per-pane **font size**: `Pane::get_font_scale` / `set_font_scale`
  (patch 0039); the renderer already draws each pane at its scale and
  `Tab::resize` re-flows each leaf via `scale_size`.

So this patch is **only** IPC plumbing + a launcher arg + config-app UI.
**No render/mux changes.** (`render/pane.rs`, `render/mod.rs`,
`mux/tab.rs` are untouched.)

## Key pieces

**IPC (`wtinator/src/notify_ipc.rs`):** two new pane-targeted requests
on the `Request` enum (snake_case `type` tags, same line-oriented
JSON-over-named-pipe contract as the rest):

- `{"type":"set_pane_theme","id":N,"pane_id":<usize>,"theme":"<id>"}` —
  mirrors `set_theme` but targets one exact pane. Resolves the theme via
  `palette_from_theme_id` (returns an `Error` body if unknown), then in
  the GUI-thread apply closure calls the new helper
  `apply_theme_to_pane(pane_id, palette)` → `Mux::get().get_pane(pane_id)
  .set_palette(palette)`.
- `{"type":"set_pane_font_size","id":N,"pane_id":<usize>,"size":<f64>}` —
  takes an **absolute** point size. In the apply closure it converts
  size → scale relative to the window's base font size and reflows:

  ```rust
  let base = config::configuration().font_size;   // window base size
  let scale = if base > 0.0 { size / base } else { 1.0 };
  let mux = mux::Mux::get();
  if let Some(pane) = mux.get_pane(pane_id) {
      pane.set_font_scale(scale);                  // LocalPane clamps 0.25..=6.0
      if let Some((_, _, tab_id)) = mux.resolve_pane_id(pane_id) {
          if let Some(tab) = mux.get_tab(tab_id) {
              tab.resize(tab.get_size());          // re-flows PTYs via scale_size
          }
      }
  }
  ```

  (`Mux::resolve_pane_id` returns `Option`, so we destructure with `if
  let Some(..)`, not `Ok(..)`.) No `TermWindow` cache clearing is needed:
  the shape cache key already includes `pane_font_scale` and the quad
  cache key includes the (now scaled) `top_pixel_y`, so a changed scale
  yields fresh cache keys; the PTY resize marks lines dirty.

  **Repaint:** the pipe server already invalidates every window after
  each apply (`wezterm-gui/src/termwindow/notify_pipe.rs` posts
  `MuxNotification::WindowInvalidated` for all windows inside the
  `TermWindowNotif::Apply` closure). **No change was needed there.**

Parse tests added for both variants (mirroring
`request_download_themes_parses`) plus an unknown-theme error test.

**Snapshot (`wtinator/src/notify.rs`):** `ConfigSnapshot` gains
`pub base_font_size: f64` (`#[serde(default)]`, additive — no protocol
bump), populated in `snapshot_for_config()` from
`config::configuration().font_size`. The config app uses it as the
initial value of the size control. Struct-literal sites in the
`notify.rs` and `notify_ipc.rs` tests set `base_font_size: 12.0`.

**Launcher (`wezterm-gui/src/termwindow/mouseevent.rs`):** the
`DispatchAction::OpenConfigApp` handler now spawns
`wtinator-config.exe --wezterm-pid <pid> --pane-id <pane_id>`
(the handler already had `pane_id` in scope via `pane_id_for_log`).

**Menu label (`wtinator/src/context_menu.rs`):** the wID `0x6300` item
relabelled from "Open con&fig app…" to **"&Configure this terminal…"**.
No wID / dispatch change — `schedule_native_menu` /
`PerformAssignment` already targets the right-clicked pane.

**Config app (`wtinator-config/src/main.rs`):**
- New `parse_pane_id()` (+ shared `parse_arg_u64` helper) reads
  `--pane-id <usize>`.
- **How `pane_id` reaches React:** it is added to the `list_tabs`
  snapshot reply JSON as `"pane_id": <id|null>`, alongside
  `"base_font_size": <f64>` (the base size is read from the live pipe
  snapshot when connected, else defaults to 12.0). This keeps a single
  source of truth (the reply) rather than HTML injection. The UI is in
  "pane mode" iff `pane_id != null`.
- `dispatch` gains routes `"set_pane_theme"` and `"set_pane_font_size"`
  that forward `{"type":"set_pane_theme",…}` / `{"type":
  "set_pane_font_size",…}` over the pipe via `ipc_client::round_trip`
  (mirroring `handle_set_theme`) and reply with
  `set_pane_theme_result` / `set_pane_font_size_result`
  (`{ok, pane_id, theme|size, error}`).

**Config app UI (`wtinator-config/frontend`):**
- `ipc.ts`: `Snapshot` gains `pane_id: number | null` and
  `base_font_size: number`; new `SetPaneThemeResult` /
  `SetPaneFontSizeResult` types; `setPaneTheme(paneId, theme)` /
  `setPaneFontSize(paneId, size)` wrappers; demo replies for both.
- `App.tsx`: in pane mode (`pane_id != null`) the header reads
  **"Configuring terminal #<paneId>"**, the theme grid applies via
  `setPaneTheme(pane_id, theme)`, and a **font-size control** (number
  input 6–48 + −/+ steppers, seeded from `base_font_size`) calls
  `setPaneFontSize(pane_id, value)` on commit (blur / Enter / step) and
  shows the result in the status bar. Tab mode (`pane_id == null`,
  launched the old way) is unchanged — the tab rail + `setTheme` path
  still works, so nothing regresses.
- `styles.css`: styling for `.size-control` / `.size-input` /
  `.size-step` and the pane-mode `.subhead`.
- Rebuilt `frontend/dist/index.html` (rust-embed reads it).

## Build / verify

- Frontend: `cd wtinator-config/frontend && npm run build` → clean,
  `dist/index.html` regenerated (156 kB, contains the new pane-mode
  strings).
- Rust: `cargo +nightly build --release -p wezterm-gui
  -p wtinator-config` (Strawberry Perl on PATH for `openssl-sys`) →
  **Finished**. Only pre-existing warnings (unused imports in
  `win32_prompt.rs` / `menu_icons.rs` / `notify*.rs`, openssl `LNK4099`
  PDB warnings); no errors, none from the new code.

## Needs a human visual check (cannot verify headless)

- Right-click a pane → "Configure this terminal…" opens the app with
  the header "Configuring terminal #N".
- Picking a theme card recolours **only that pane**; the size control
  changes **only that pane's** font (sibling panes unchanged).
- The size control seeds to the window's `font_size`, and commits on
  blur / Enter / ± steppers.
- Launching the app the **old** way (no `--pane-id`) still shows the tab
  rail and the per-tab theme behaviour.

## Known follow-ups / caveats

- Inherits patch 0039's caveats for scaled panes (mouse hit-test uses
  window metrics; per-pane scale/theme not persisted across restart).
- Pane mode does not pre-select the pane's *current* theme/size in the
  UI (there is no per-pane "current theme" field in the snapshot yet);
  the grid highlights the last theme you applied this session, and the
  size control seeds from the window base size, not the pane's current
  scale. A future patch could add per-pane current theme + current size
  to the snapshot.
