# Patch 0020 — Custom title bar hosting the terminal tabs

**Applied:** 2026-06-07 (revised four times — see "Fix" sections
below)
**Files:**
- `upstream-wezterm/wtinator/src/titlebar.rs` (new)
- `upstream-wezterm/wtinator/src/lib.rs`
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs`
- `upstream-wezterm/window/src/os/windows/window.rs`

**Status:** Active

## What

The native Win32 title bar is replaced with a custom-drawn one
that hosts the terminal tabs. The upstream `wezterm-gui` already
implements the `fancy_tab_bar` renderer — it is gated on the
config keys `window_decorations = "INTEGRATED_BUTTONS"` and
`use_fancy_tab_bar = true`. This patch sets both as **defaults**
so the user gets the custom title bar without any `wezterm.lua`
configuration.

## The `window_decorations` value

`WindowDecorations` is a bit-flag struct (in
`wezterm-input-types/src/lib.rs`):

| Bit | Flag | Meaning |
| --- | --- | --- |
| `0x01` | `TITLE` | OS draws a native title bar (drop this) |
| `0x02` | `RESIZE` | OS provides a resize border (keep) |
| `0x10` | `INTEGRATED_BUTTONS` | Min/Max/Close are drawn into the fancy tab bar (add) |

Combined we want `RESIZE | INTEGRATED_BUTTONS = 0x12 = 18`, but
the upstream dynamic parser accepts this field as a pipe-separated
string, not a packed integer. The patch sets
`window_decorations = "RESIZE|INTEGRATED_BUTTONS"` so
`overridden_config` parses the intended bit pattern.

## Fix #1: apply the overrides *before* `Window::new_window`

The first cut of this patch only stashed the overrides in the
`TermWindow` `config_overrides` field, which is consumed by the
upstream `config_was_reloaded()` *after* the OS window is already
created. The OS reads `config.window_decorations` from the raw
`configuration()` global when `Window::new_window` runs — so the
native Win32 title bar was being created regardless of the
override. The user reported the regression and the fix was to
**resolve the merged config *before* constructing the window**:

```rust
let overrides = wtinator::titlebar::default_overrides()
    .unwrap_or_else(wezterm_dynamic::Value::default);
let config = match &overrides {
    wezterm_dynamic::Value::Null => configuration(),
    _ => config::overridden_config(&overrides)
        .unwrap_or_else(|_| configuration()),
};
// ... then Window::new_window(Some(&config), ...)
```

The merged `config` is also stashed in the `config_overrides`
slot so subsequent `config_was_reloaded()` calls keep applying
the same overrides (e.g. when the user changes a font size, the
overrides are preserved).

## Fix #2: extend `decorations_to_style` to drop `WS_CAPTION` when `INTEGRATED_BUTTONS` is set

After fix #1, the merged `config.window_decorations` was
correctly `0x12` (RESIZE | INTEGRATED_BUTTONS) by the time
`Window::new_window` ran. The native title bar still appeared,
though, because the upstream helper
`window/src/os/windows/window.rs::decorations_to_style` is a
chain of `if/else if` matches that **does not have a branch for
`INTEGRATED_BUTTONS`**. The default branch (the `else` at the
end) returns `WS_OVERLAPPEDWINDOW`, which includes `WS_CAPTION` —
the flag that asks the OS for a native title bar.

The fix is a single new branch at the top of the chain that
returns `WS_THICKFRAME | WS_MINIMIZEBOX` when
`INTEGRATED_BUTTONS` is set:

```rust
if decorations.contains(WindowDecorations::INTEGRATED_BUTTONS) {
    return WS_THICKFRAME | WS_MINIMIZEBOX;
}
```

`WS_THICKFRAME` keeps the OS resize border; `WS_MINIMIZEBOX`
lets the user minimise the window from the taskbar; `WS_CAPTION`
is **omitted** (no native title bar) and `WS_SYSMENU` is
**omitted** (no system menu on right-click — the close button is
ours, not the OS's). `WS_MAXIMIZEBOX` is also omitted because
wezterm draws its own maximise button.

## Fix #3: pass the override as a String, not a U64

After fixes #1 and #2 the merged `config` was being passed to
`Window::new_window` correctly *and* `decorations_to_style` was
returning the right `WS_THICKFRAME | WS_MINIMIZEBOX`. Yet the
native title bar still appeared. A diagnostic log revealed that
the actual `config.window_decorations` at the point of window
creation was still the upstream default — `TITLE | RESIZE` —
not the override we were trying to set.

Root cause: `WindowDecorations` is parsed by an upstream derive
that has `try_from = "String", into = "String"` (see
`wezterm-input-types/src/lib.rs:2087` — the only impl is
`TryFrom<String>` for `WindowDecorations`, which splits the
input on `|` and OR-combines the named bits). When the override
in `wtinator::titlebar::default_overrides()` carried
`window_decorations = Value::U64(0x12)`, the parser failed (a
`U64` is not a `String`) and the override was silently dropped
by `config::overridden_config(...).unwrap_or_else(|_| configuration())`
in `TermWindow::new_window`. The fallback `configuration()` is
the upstream default — `TITLE | RESIZE` — which gives a
`WS_OVERLAPPEDWINDOW` style and a native title bar.

The fix is to pass the value as the name-based string the parser
expects:

```rust
map.insert(
    Value::String("window_decorations".to_string()),
    Value::String("RESIZE|INTEGRATED_BUTTONS".to_string()),
);
```

The combined flags are:
- **omit** `TITLE` (no native title bar)
- **keep** `RESIZE` (OS resize border)
- **add** `INTEGRATED_BUTTONS` (wezterm draws the buttons)

The corresponding unit test was updated to assert the new
`Value::String` payload.

## Fix #4: use `WS_POPUP` for the integrated title-bar style

After fixes #1-#3, the config reached `Window::new_window` and
`decorations_to_style` selected a style without `WS_CAPTION`.
The native title bar could still appear on Windows because the
window remained in the normal overlapped-window style family while
DWM/non-client handling was being recalculated.

The fix changes the `INTEGRATED_BUTTONS` style to:

```rust
WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
```

This keeps resize borders, taskbar minimise, maximise/snap-layout
support, and explicitly opts out of overlapped-window caption
chrome. It still omits `WS_CAPTION` and `WS_SYSMENU`, so Windows
does not draw native title-bar buttons over the fancy tab bar.

The runtime decoration re-application path now clears both
`WS_OVERLAPPEDWINDOW` and `WS_POPUP` before OR-ing in the new
style:

```rust
let decoration_style_mask = (WS_OVERLAPPEDWINDOW | WS_POPUP) as i32;
let new_style = (orig_style & !decoration_style_mask) | style as i32;
```

That prevents stale chrome bits from surviving when decorations are
changed after window creation or after a config reload.

## Fix #5: force effective Win32 decorations under `WTINATOR_ACTIVE`

The user-visible requirement is not optional: WezTerminator should
not show the native Windows title bar. If a user config reload or
merge path reintroduces the `TITLE` bit, the GUI can still render
the tab strip correctly while Windows also draws native caption
chrome above it.

The Windows backend now computes an effective decoration value when
`WTINATOR_ACTIVE=1`:

```rust
(decorations | WindowDecorations::RESIZE | WindowDecorations::INTEGRATED_BUTTONS)
    & !WindowDecorations::TITLE
```

That effective value is used by:
- `decorations_to_style`, so `CreateWindowExW` and decoration
  re-application never request `WS_CAPTION` / `WS_SYSMENU`.
- `no_native_title_bar`, so `WM_NCCALCSIZE` removes the native
  non-client title area even if the raw config still contains
  `TITLE`.
- DWM frame/border calculations, so there is no extended native
  title frame left behind.

This fallback is scoped to WezTerminator launches. It activates when
`WTINATOR_ACTIVE=1` is present (the repository launchers set it) or
when the current executable name is one of the fork binaries
(`wezterm.exe`, `wezterm-gui.exe`, or `wezterminator.exe`). The
executable-name fallback is required because users may open
`wezterm-gui.exe` directly from `target\release\` without going
through the launcher.

## Fix #6: force rendering of the three integrated window buttons

After the native title bar was removed, the tab strip could still
miss the app-rendered window controls because the GUI-side tab bar
only created `TabBarItem::WindowButton` entries when the raw
`config.window_decorations` contained `INTEGRATED_BUTTONS`. The
Win32 backend may now force the effective decorations under
`WTINATOR_ACTIVE`, so the raw config is no longer a reliable
render gate.

The default override now explicitly sets:

```rust
integrated_title_button_alignment = "Right"
integrated_title_button_style = "Windows"
integrated_title_buttons = ["Hide", "Maximize", "Close"]
```

The `tabbar.rs` builder and `fancy_tab_bar.rs` renderer also treat
`WTINATOR_ACTIVE=1` or a direct fork executable launch as enabling
integrated title buttons. The existing click dispatch was already
present:
- `Hide` calls `window.hide()`.
- `Maximize` toggles `window.maximize()` / `window.restore()`.
- `Close` routes through the dedicated confirmation path described
  below.

## Fix #7: app-rendered close button always asks for confirmation

The custom title-bar `X` should behave like an explicit destructive
UI action, not like a low-level OS close event. The upstream
`close_requested()` path respects `window_close_confirmation =
"NeverPrompt"` and also skips the overlay when the mux reports that
the window can close without prompting. For WezTerminator's
app-rendered close button, that is too permissive.

`TermWindow` now has a dedicated
`close_requested_with_confirmation()` path. It starts the same
`confirm_close_window()` overlay as the normal prompted close flow,
but it does not consult `window_close_confirmation` and does not use
the `can_close_without_prompting()` shortcut. The integrated
`WindowButton(Close)` mouse handler calls this dedicated path, so a
click on the custom `X` always asks before killing the window's tabs
and panes.

## Fix #8: suppress the visible Win32 border in WezTerminator mode

After removing the native title bar, the remaining resize frame could
still leave an unattractive visual border around the window. The
first pass kept `WS_THICKFRAME`, because that preserves resizing and
Windows snap behavior, but that still let Windows/DWM reserve and draw
native-frame details that did not match the custom tab bar.

When WezTerminator mode is active and integrated buttons are active,
the Win32 backend now uses `WS_POPUP | WS_MINIMIZEBOX | WS_MAXIMIZEBOX`,
omitting `WS_THICKFRAME` as well as the caption bits. Resizing is
preserved by handling `WM_NCHITTEST` manually and returning `HTLEFT`,
`HTRIGHT`, `HTTOP`, `HTBOTTOM`, and the corner variants for the resize
zones.

WezTerminator mode is true for both launcher-based runs
(`WTINATOR_ACTIVE=1`) and direct runs of the fork binaries by filename.

The backend also reports zero painted border dimensions to the GUI
renderer. That prevents `paint_window_borders()` from drawing the
1px/2px OS border strips. `apply_theme()` sets `DWMWA_BORDER_COLOR` to
`DWMWA_COLOR_NONE`, asking DWM not to draw a colored frame around the
window.

## Fix #9: maximized borderless window respects the taskbar

With the WezTerminator borderless `WS_POPUP` style, the default Windows
maximize calculation can use the full monitor rectangle and cover the
taskbar. That is not the desired behavior for the title-bar maximize
button; it should behave like a normal maximized app window and occupy
the monitor work area.

The Win32 backend now handles `WM_GETMINMAXINFO` when the WezTerminator
borderless popup path is active. It reads the nearest monitor's
`MONITORINFO.rcWork` and writes:

- `ptMaxPosition` relative to `rcMonitor`
- `ptMaxSize` from the `rcWork` width/height

This keeps `ShowWindow(..., SW_MAXIMIZE)` as the maximize mechanism, so
Windows still reports the window as maximized, while the resulting size
respects the taskbar and other reserved desktop work-area edges.

## How the override is applied

`wtinator::titlebar::default_overrides()` returns
`Some(wezterm_dynamic::Value::Object)` with two keys:
`window_decorations = "RESIZE|INTEGRATED_BUTTONS"` and
`use_fancy_tab_bar = true`. The
patched upstream `TermWindow::new_window` (the only function in
the codebase that constructs a `TermWindow`) reads the function,
applies the override to the global config to produce a merged
`ConfigHandle`, and passes that to `Window::new_window`. The
same overrides are stashed in the term-window's
`config_overrides` slot for subsequent reloads.

The user can still override either key in their `wezterm.lua`:

```lua
return {
  window_decorations = "TITLE|RESIZE",  -- bring back the native title bar
  use_fancy_tab_bar = false,           -- disable the custom one
}
```

The user's config is merged with the overrides via
`wezterm_dynamic::Value` semantics, so a user setting wins
because the user-facing config has the highest priority in the
upstream merge order.

## Why a separate `wezterm_dynamic::Object` and not raw `Map`

The upstream merge code expects a `wezterm_dynamic::Value` and
walks it as a Lua-like table. The `Object` type is the
right level of abstraction: it preserves string keys
(case-sensitive, no quoting needed) and the
`BorrowedKey::Str` interning avoids re-allocating the key strings
on every config reload.

## Revert

1. In `wtinator/src/lib.rs`, drop the `pub mod titlebar;` line.
2. Delete `wtinator/src/titlebar.rs`.
3. In `wezterm-gui/src/termwindow/mod.rs`:
    - Drop the `overrides` resolution at the top of
      `new_window` (revert to `let config = configuration();`).
    - Drop the `config_overrides: overrides,` line in the
      `Self { ... }` constructor (revert to
      `config_overrides: wezterm_dynamic::Value::default(),`).
4. In `window/src/os/windows/window.rs`, drop the new
   `if decorations.contains(WindowDecorations::INTEGRATED_BUTTONS) { return WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX; }` branch at the top of `decorations_to_style`, and revert the runtime decoration mask to clear only `WS_OVERLAPPEDWINDOW`.
5. Drop the 3 tests in `titlebar::tests`.
6. Remove this file and the row for patch 0020 from `PATCHES.md`.

## Risk

Low. The change in `decorations_to_style` is one new branch
that fires only when `INTEGRATED_BUTTONS` is set in the
merged config (which is the WezTerminator default). All other
config combinations are unchanged. Users who set
`window_decorations = "TITLE|RESIZE"` continue to get
`WS_OVERLAPPEDWINDOW` (the existing `else` branch) and the
native title bar.

33/33 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
