# Patch 0034 (MVP) — wtinator-config companion app foundation

**Applied:** 2026-06-13
**Files:**
- `upstream-wezterm/wtinator/src/notify.rs` (new, ~250 lines:
  `ConfigSnapshot` / `TabSnapshot` / `ThemeSnapshot` / `ThemeKind`
  + `snapshot_for_config()` + 5 unit tests)
- `upstream-wezterm/wtinator/src/notify_ipc.rs` (new, ~280
  lines: `Request` / `Response` enums with `serde(tag = "type")`
  for the JSON contract, `palette_from_theme_id`,
  `apply_theme_to_tab`, `handle_request` + 8 unit tests covering
  the wire format and the dispatch logic)
- `upstream-wezterm/wtinator/src/vscode_theme.rs` (+~30 lines:
  `iter()` / `display_name()` / `id_str()` methods on
  `ThemeId`)
- `upstream-wezterm/wtinator/src/lib.rs` (+2 lines: `pub mod
  notify;` and `pub mod notify_ipc;` declarations)
- `upstream-wezterm/wtinator/src/context_menu.rs` (+~50 lines:
  `NativeCommand::OpenConfigApp` enum variant, wID `0x6300`,
  `DispatchAction::OpenConfigApp`, classify mapping, "Open
  config app…" menu item, test updates)
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`
  (+~25 lines: new dispatch arm for `OpenConfigApp` that
  spawns a `std::thread` to show a Win32 messagebox)
- `upstream-wezterm/wezterm-gui/Cargo.toml` (+1 line:
  `windows-sys` features extended with `Win32_System_Pipes` +
  `Win32_Storage_FileSystem` + `Win32_Security` +
  `Win32_System_Threading` for the follow-up named-pipe server)
- `upstream-wezterm/PATCHES.md` (+5 rows in the active-patches
  table: 0034 MVP, 0034.5 / 0035 / 0036 planned, and the
  already-shipped 0033)
- `upstream-wezterm/patches/0034-wtinator-config.md` (this file)

**Status:** **MVP** foundation only. The standalone
`wtinator-config.exe` (React + WebView2) lands in patch
**0034.5** (planned, follow-up).

## What

The user asked on 2026-06-12:

> "quero que analise o que precisa para ter uma
> aplicacao reactweb com webview nativo do windows
> para configuracao do terminal, em ambiente grafico
> moderno, para escolher o tema de cada terminal, e
> fazer baixar os temas do vscode para ficarem
> disponiveis no nosso terminal"

This patch ships the **data model + IPC contract** for
the companion app. The actual React + WebView2 host is
follow-up work in patch 0034.5 (because building a
shippable React app with a WebView2 control is its own
multi-day effort and would have blown out the
single-session scope of this turn).

What is in this patch:

1. **`wtinator::notify`** — serializable
   `ConfigSnapshot` containing
   `Vec<TabSnapshot>` (per-tab: id, index, title, group,
   current theme, active pane id) and
   `Vec<ThemeSnapshot>` (per-theme: id, name, kind,
   16-color ANSI palette as `#rrggbb` hex, foreground /
   background / cursor / selection colors, preview text).
   The `snapshot_for_config()` function reads the live
   mux and projects it down to the snapshot.
2. **`wtinator::notify_ipc`** — JSON-over-named-pipe
   IPC contract. Three request types: `list_tabs`
   (returns the snapshot), `set_theme` (applies a
   named theme to a tab's active pane on the GUI
   thread), and `ping`. The `palette_from_theme_id`
   helper resolves theme id strings to `ColorPalette`
   instances. The `apply_theme_to_tab` helper does the
   apply (and must be called on the GUI thread because
   it takes the mux lock).
3. **Right-click "Open config app…" entry** — wID
   `0x6300`, kind `NativeCommand::OpenConfigApp`. The
   dispatcher (in `wezterm-gui/src/termwindow/mouseevent.rs`)
   spawns a `std::thread` that shows a Win32 native
   `MessageBoxW` explaining that the React app lands
   in patch 0034.5 and points the user at this patch
   note.
4. **`vscode_theme::ThemeId` helpers** — `iter()`,
   `display_name()`, `id_str()`. Used by the snapshot
   enumerator and by the React app (the `id_str`
   matches the wire-format theme id).

What is **not** in this patch (planned follow-ups):

- **0034.5**: the standalone `wtinator-config.exe` (a
  React + TypeScript frontend built with Vite, hosted
  in a WebView2 control), plus the actual named-pipe
  server runtime in `wezterm-gui`. The MVP data model
  + IPC contract are in place; only the GUI + the
  pipe server runtime are missing.
- **0035**: the VSCode theme downloader (open-vsx.org
  / GitHub raw mirror, JSON validation, save to
  `%APPDATA%\wezterminator\themes\`).
- **0036**: per-group theme default ("when I open a
  new tab in group X, use theme Y").

## Why these decisions

- **MVP-first, not big-bang**: the user asked for
  "React app + WebView2 + theme downloader + per-
  terminal apply" — a 3-day feature. Shipping the
  data model + IPC contract first lets a follow-up
  patch focus on the React UI without re-deriving
  the wire format. The contract is stable: any
  patch that lands after 0034 can build against
  `wtinator::notify::ConfigSnapshot` /
  `wtinator::notify_ipc::Request` / `Response`.
- **JSON over named pipe, not stdio / TCP / shared
  memory**: the upstream wezterm mux server already
  uses Unix sockets / named pipes for IPC (the mux
  client). Reusing the named-pipe pattern means
  the config app and the GUI can talk without any
  new networking, auth, or service discovery. The
  pipe name is `\\.\pipe\wtinator-config-<pid>` so
  multiple wezterm-gui instances do not stomp on
  each other's pipes.
- **`serde(tag = "type")` for the Request enum**:
  gives us the natural `{"type":"list_tabs", ...}`
  wire format with no custom `Deserialize` impl. The
  cost is that each variant needs a
  `#[serde(rename = "...")]` so the JSON tag matches
  the snake_case convention used by the React side.
- **Hex strings for the palette, not full
  `ColorPalette`**: the wire format only needs the
  16 ANSI colors + fg/bg/cursor/selection. The
  240-cube + 24-grey are derived from the 16 ANSI
  on the React side at render time. This keeps the
  payload small (~500 bytes per theme instead of
  ~5KB) and avoids serializing the full
  `ColorPalette` struct (which has internal
  invariants that are easy to break with a
  derive).
- **MVP `OpenConfigApp` dispatch shows a messagebox
  instead of launching the (not-yet-existing)
  `wtinator-config.exe`**: keeps the patch
  buildable without a parallel frontend build. The
  messagebox is the same Win32 native
  `MessageBoxW` API the patch 0032 `confirm_close`
  uses, so no new infrastructure. The user gets a
  clear "this is coming in 0034.5" message instead
  of a silent dead menu entry.

## Reuse from existing code

- **`Pane::set_palette`** (patch 0016.3): the
  per-pane palette setter. The new
  `apply_theme_to_tab` calls this on the tab's
  active pane.
- **`wtinator::vscode_theme::ThemeId` + `build_palette`**
  (patch 0016): the 3 baked-in palettes. The new
  `palette_from_theme_id` and
  `snapshot_for_config` both go through this API so
  any future tweaks to the palette derivation are
  picked up automatically.
- **`wtinator::confirm::confirm_close`** (patch
  0032): the Win32 `MessageBoxW` infrastructure.
  The MVP `OpenConfigApp` dispatch reuses this
  directly with `ConfirmKind::Window` — the kind
  is currently just a debug aid, so any kind
  works.
- **`Tab::effective_title`** (patch 0031): the
  per-tab title used in `TabSnapshot`.
- **`MuxNotification::WindowInvalidated`** (patch
  0031): the standard "force a repaint" signal.
  After `apply_theme_to_tab` is wired up in patch
  0034.5, the dispatch will post a
  `WindowInvalidated` after the apply so the
  terminal redraws with the new colors.
- **`windows-sys` features** (already a dep of
  `wezterm-gui` for the right-click menu): the new
  `Win32_System_Pipes` + `Win32_Storage_FileSystem` +
  `Win32_Security` + `Win32_System_Threading` features
  prepare for the actual named-pipe server runtime
  in patch 0034.5.

## Revert

1. Remove `pub mod notify;` and `pub mod
   notify_ipc;` from `wtinator/src/lib.rs`, then
   delete `wtinator/src/notify.rs` and
   `wtinator/src/notify_ipc.rs`.
2. Remove the `iter()` / `display_name()` /
   `id_str()` methods from
   `wtinator::vscode_theme::ThemeId`.
3. In `wtinator::context_menu.rs`, remove
   `NativeCommand::OpenConfigApp` (enum variant +
   wID mapping + `DispatchAction::OpenConfigApp` +
   classify mapping + `dispatch_native` arm +
   "Open config app…" menu item) and revert the
   `full_menu_includes_shells_splits_and_close` test
   count from `+ 16` back to `+ 15`. Remove the
   `OpenConfigApp` wID test from
   `all_w_ids_are_unique`.
4. In `wezterm-gui/src/termwindow/mouseevent.rs`,
   remove the `OpenConfigApp` dispatch arm.
5. In `wezterm-gui/Cargo.toml`, drop the
   `Win32_System_Pipes` / `Win32_Storage_FileSystem` /
   `Win32_Security` / `Win32_System_Threading` features
   from `windows-sys`.
6. Remove this file and the row for patch 0034 from
   `PATCHES.md`.

## Risk

**Very low for the MVP.** The patch is pure additive
infrastructure:

- 2 new modules in `wtinator` (`notify`,
  `notify_ipc`) with no callers in production code
  (the `OpenConfigApp` dispatch does call into
  `wtinator::confirm` for the messagebox, but that
  is an existing public API).
- 1 new enum variant in `NativeCommand` and
  `DispatchAction` (`OpenConfigApp`).
- 1 new menu item in the right-click full menu.
- 1 new dispatch arm in `mouse_event.rs` that
  spawns a `std::thread` to show a messagebox.
- 1 new line in `wezterm-gui/Cargo.toml` extending
  the `windows-sys` feature list (the new features
  are unused until patch 0034.5).

The wire format is **not** stable yet — patch 0034.5
will likely adjust `ConfigSnapshot` (add `cwd` and
`process_name` per tab for the React app's tab list,
add a `palette_name` and `palette_is_builtin` for
the per-tab theme badge, etc.). The
`PROTOCOL_VERSION` constant is the migration
boundary; the React app and the Rust server will
both check this and reject mismatched versions.

## Verification

### 1. Unit tests

```bash
cd upstream-wezterm
cargo +nightly test -p wtinator
```

Expected: **107 wtinator tests pass** (was 92, +15
new: 5 in `notify` + 8 in `notify_ipc` + 2 from
the menu/serde tests).

### 2. Compile

```bash
cd upstream-wezterm
cargo +nightly check -p wtinator
cargo +nightly check -p mux
cargo +nightly check -p wezterm-gui
cargo +nightly build --release -p wezterm-gui
```

### 3. End-to-end manual test (MVP scope)

```cmd
cd <workspace>
run-wezterminator-release.cmd
```

1. Open a few tabs.
2. Right-click on the terminal pane.
3. Verify the new "Open config app…" entry is
   visible (just after "Rename tab…", just before
   "Move pane to").
4. Click it.
5. **Verify a Win32 native messagebox appears**
   with title "wtinator-config — coming soon" and
   the body text explaining the patch 0034.5
   follow-up.
6. Click OK to dismiss.

The messagebox is the entire MVP UX; the actual
React app is patch 0034.5.

## Out of scope (deferred to follow-up patches)

- **0034.5**: standalone `wtinator-config.exe` +
  real named-pipe server runtime. ~300-500 LoC of
  Rust + ~500 LoC of TypeScript. The React app
  lives at `wtinator-config/frontend/`; the
  Vite-built static bundle is embedded in the
  binary via `include_bytes!`.
- **0035**: VSCode theme downloader. Browse
  open-vsx.org / GitHub raw, download JSON,
  validate against `ColorPalette` shape, save to
  `%APPDATA%\wezterminator\themes\`, refresh the
  React app's theme list.
- **0036**: per-group theme default.
