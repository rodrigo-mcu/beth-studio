# Patch 0038 — Theme downloader (Gogh community catalog)

**Applied:** 2026-06-13
**Status:** Active.

## What

A one-click **theme downloader** in the `wtinator-config`
companion app. Press **"Download themes"** and the app fetches the
Gogh community theme catalog (365 themes as of writing — Dracula,
Nord, Tokyo Night, One Dark, Monokai, Solarized, Gruvbox,
Catppuccin, …), caches each one as JSON under
`%APPDATA%\wezterminator\themes\<id>.json`, and re-renders the
theme grid so the new themes appear as cards (with a small
"downloaded" badge). Clicking a downloaded card applies it to the
selected terminal live, exactly like a built-in theme.

> **Data source note.** The "0038 (planned)" row in `PATCHES.md`
> originally floated open-vsx.org / a `vscodethemes` mirror. We
> shipped **Gogh** instead: it is a single flat JSON array with a
> stable, fully-populated schema (every entry has all 16 ANSI
> colours + fg/bg/cursor), it is the same source the upstream
> `sync-color-schemes` tool already uses, and the themes are
> overwhelmingly the VSCode-style palettes the user asked for
> (Dark+, One Dark, Dracula, Nord, …). open-vsx would have meant
> per-extension downloads + tmTheme/`workbench` JSON parsing with
> no ANSI palette at all (VSCode themes only define editor token
> colours, not the 16 terminal ANSI colours), so it is a much
> larger and lower-fidelity job for the same end result.

## Data source (Gogh)

`https://raw.githubusercontent.com/Gogh-Co/Gogh/master/data/themes.json`
— a JSON array. **Verified live** (2026-06-13): 365 entries, each
with these fields (extra keys `author`, `variant`, `hash` are
present and ignored):

```
name, color_01 … color_16, foreground, background, cursor
```

`color_01..08` = normal black..white, `color_09..16` =
bright black..white. There is no per-theme selection colour, so we
derive `selection_fg = foreground` and `selection_bg = background`.
All 365 names slugify to **distinct, non-empty** ids (verified), so
a full download writes **365** files with no collisions.

## Key pieces

- **`wtinator/src/theme_download.rs`** (new):
  - `SavedTheme { id, name, ansi[16], foreground, background,
    cursor, selection_fg, selection_bg }` — the on-disk JSON shape,
    identical to `notify::ThemeSnapshot`'s hex fields so it
    round-trips straight into a snapshot.
  - `themes_dir()` = `session::session_dir()?.join("themes")`
    (created on demand).
  - `slugify(name)` — `[a-z0-9]`, other runs → single `-`, trimmed
    ("Tokyo Night" → `tokyo-night`, "Solarized (dark)" →
    `solarized-dark`). Own impl, no crate.
  - `parse_hex("#rrggbb" | "#rgb") -> Option<SrgbaTuple>`.
  - `download_catalog() -> Result<usize>` — blocking GET via
    `reqwest::blocking`, parse, convert, write each `<id>.json`
    atomically (`.tmp` + rename, mirrors `session::save`). One bad
    theme logs a warning and is skipped; it never aborts the batch.
  - `load_saved_themes() -> Vec<SavedTheme>` — reads every `*.json`
    in `themes_dir()`, skips unreadable/unparseable, sorted by id.
  - `palette_for_saved(id)` / `palette_from_saved(&SavedTheme) ->
    Option<ColorPalette>` — builds a real `ColorPalette` reusing
    `vscode_theme::{palette256, ansi_16}` (made `pub(crate)`) so the
    240-cube + 24-grey indexed colours match the built-ins. Per
    patch 0027, `cursor_bg = cursor` (not background) so the block
    cursor stays visible on dark themes.
- **`wtinator/src/notify.rs`**: `snapshot_for_config()` now appends
  every `load_saved_themes()` as a `ThemeKind::UserDownloaded`
  snapshot after the 3 built-ins, de-duped by id (built-ins win).
  New helper `saved_theme_to_snapshot(SavedTheme) -> ThemeSnapshot`.
- **`wtinator/src/notify_ipc.rs`**: `palette_from_theme_id(id)`
  falls through to `theme_download::palette_for_saved(id)` after the
  4 built-in matches, so `set_theme` with a downloaded slug applies.
  New `Request::DownloadThemes { id: Option<u32> }`
  (`#[serde(rename = "download_themes")]`); `handle_request` runs
  `download_catalog()` (off the GUI thread — it only writes files)
  and returns `Ok { ok: true }` or `Error`.
- **`wtinator/Cargo.toml`**: `reqwest = { workspace = true,
  features = ["blocking", "json"] }`. The default-tls
  (native-tls / schannel) backend is already in the workspace
  graph (same as `sync-color-schemes`); only `blocking` is new (the
  config app has no tokio runtime).
- **`wtinator-config/src/main.rs`**: `local_themes()` appends
  `theme_download::load_saved_themes()` (so the standalone app shows
  downloaded themes even with no `--wezterm-pid`); new
  `download_themes` IPC message → `download_catalog()` →
  `download_themes_result` reply (so the UI can refresh).
- **`wtinator-config/frontend`** (React): "Download themes" button
  in the top toolbar with a "Downloading…" state; on success calls
  the existing `refresh()`. `downloadThemes()` wrapper +
  `DownloadThemesResult` type in `ipc.ts`. `ThemeCard` shows a
  "downloaded" badge for `UserDownloaded` themes. `dist/index.html`
  rebuilt (`npm run build`).

## Revert

- Delete `wtinator/src/theme_download.rs` and its `pub mod` line in
  `wtinator/src/lib.rs`.
- Revert `pub(crate)` back to private on `palette256` / `ansi_16` in
  `wtinator/src/vscode_theme.rs`.
- Remove the downloaded-theme loop + `saved_theme_to_snapshot` in
  `notify.rs`; revert the test back to `== 3`.
- Remove the `DownloadThemes` variant + handler and the
  `palette_for_saved` fall-through in `notify_ipc.rs`.
- Remove the `reqwest` dep in `wtinator/Cargo.toml`.
- Revert `local_themes()` + the `download_themes` branch in
  `wtinator-config/src/main.rs`; remove the button / wrapper / type
  / badge in the frontend and rebuild `dist`.

## Risk

**Low–Medium.** Purely additive. The only behaviour change to
existing code is `palette_from_theme_id`'s `_ => None` arm becoming
`other => palette_for_saved(other)` (an unknown id now does a disk
lookup before returning `None` — still `None` for genuinely unknown
ids). `download_catalog` is the only network call and is gated
behind an explicit button press. Writes are atomic and per-file, so
a crash mid-download leaves a partial-but-valid set of themes (each
file is independently parseable). reqwest blocking spins its own
runtime, so it is safe to call from the pipe-server thread and from
the config app (neither has a tokio runtime).

## Verification

- `cargo +nightly test -p wtinator` — **121 pass** (109 prior + 12
  new: 9 in `theme_download` [slugify, parse_hex, JSON round-trip,
  palette build, bad-hex reject, Gogh-entry parse], 1 in `notify`
  [`saved_theme_maps_to_user_downloaded_snapshot`], 1 in
  `notify_ipc` [`request_download_themes_parses`], and the updated
  `snapshot_for_config` / `palette_from_theme_id` tests).
- `cargo +nightly build -p wtinator-config` — clean (debug).
- `cargo +nightly build -p wtinator-config --release` — clean.
- `cargo +nightly check -p wezterm-gui` — clean (the
  `palette_from_theme_id` change compiles where the pipe server
  uses it).
- `cd wtinator-config/frontend && npm run build` — built
  `dist/index.html` (153.82 kB single-file bundle).
- **Schema + count verified live** (curl + a throwaway parse, not
  committed): 365 entries, 0 missing required fields, 0 empty
  slugs, 0 slug collisions → a full download writes 365 files.

## Known gaps / TODOs

- **Live end-to-end download not run from the test binary here.**
  The dev sandbox lets `curl` reach `raw.githubusercontent.com`
  (HTTP 200) but blocks raw TCP egress from the compiled
  `reqwest::blocking` test process ("tcp connect error"), so the
  full `download_catalog()` path could not be exercised from
  `cargo test` in this environment. The parse was validated against
  the real catalog with an out-of-band fetch (field names + counts
  above), and the reqwest client is configured identically to the
  working `sync-color-schemes` crate. Running the button in a real
  WezTerminator session (with normal network) is the remaining
  manual check.
- No "delete downloaded themes" / "update catalog" affordance yet
  (re-downloading overwrites in place, which is the de-facto
  update). A future patch could add a clear-cache button.
- The downloaded `selection_*` colours mirror fg/bg (Gogh has none);
  good enough for the preview and for applying, but a future patch
  could derive a nicer selection tint.
