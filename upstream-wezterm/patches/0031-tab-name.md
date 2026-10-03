# Patch 0031 — Per-tab user title (sticky override of the OSC 0/2 title)

**Applied:** 2026-06-12
**Files:**
- `upstream-wezterm/mux/src/tab.rs` (+~60 lines: new field, three
  methods, one regression test)
- `upstream-wezterm/wtinator/src/context_menu.rs` (+~50 lines: new
  `NativeCommand::RenameTab` and `DispatchAction::RenameTab` variants,
  new menu entry, new wID 0x6200, new test count)
- `upstream-wezterm/wtinator/src/menu_icons.rs` (+~40 lines: new
  `MenuIconId::RenameTab` variant, new `draw_rename_tab` function,
  updated test pre-population)
- `upstream-wezterm/wtinator/src/header/mod.rs` (+~15 lines: new
  `prompt_user_title` thin wrapper that calls the same
  `win32_prompt::run` dialog as `prompt_rename`)
- `upstream-wezterm/wtinator/src/session.rs` (+~70 lines: schema
  bump v5 → v6, new `user_title` field on `TabEntry`, capture /
  apply in `snapshot()` / `apply()`, two new regression tests
  covering v5 → v6 transparent upgrade and v6 round-trip)
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`
  (+~95 lines: new `RenameTab` dispatch arm in
  `schedule_native_menu` mirroring the existing `RenameTerminal`
  arm, **plus** a `is_wtinator_active` check in the tab-bar
  right-click handler so right-click on a tab in WezTerminator
  mode opens the WezTerminator native menu — which now includes
  "Rename tab…" — instead of the upstream `show_tab_navigator`
  Skia overlay that would otherwise eat the right-click and
  block access to the per-tab rename)
- `upstream-wezterm/wezterm-gui/src/tabbar.rs` (+~25 lines: prefer
  `user_title` over `tab_title` in `compute_tab_title`, **plus**
  a `pub fn is_wtinator_active()` re-export so
  `termwindow::mouseevent` can branch on WezTerminator mode)
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs` (+~25 lines:
  new `user_title` field on `TabInformation`, populate it in
  `get_tab_information`, expose it to Lua)
- `upstream-wezterm/PATCHES.md` (+1 row in the active-patches table)
- `upstream-wezterm/patches/0031-tab-name.md` (this file)

**Status:** Active (no follow-up TODOs).

## What

A per-tab user-set name that overrides the OSC 0/2 title set by the
program running inside the shell. Right-click on the terminal pane →
"Rename tab…" opens a real Win32 modal input dialog (re-using the
existing patch 0030.5 dialog) that sets a `user_title: Option<String>`
field on `mux::tab::Tab`. The name **sticks across OSC 0/2 escapes**
from the shell — programs like `vim`, `tmux`, `claude --continue`,
etc. cannot clobber it. The name is persisted in `session.json`
(schema v5 → v6) and rendered in the tab-bar title in preference to
the OSC title.

A new `Tab::effective_title()` helper returns the user-set title if
set, else the existing `title` (OSC 0/2). The tab-bar renderer
(`wezterm-gui/src/tabbar.rs::compute_tab_title`) reads
`TabInformation::user_title` (new field, populated from
`effective_title`) in preference to `tab_title`. The Lua-exposed
`tab_title` field is left untouched (still returns the raw OSC
value) for backwards compatibility with user `format-tab-title`
callbacks — a new `user_title` field exposes the user-set value
(empty when not set).

## Why

Rodrigo asked for "implementar nomeacao de tabs" on 2026-06-12.
With 3-5 groups open and 2-3 tabs each (patches 0028 + 0029), the
tab bar at the top of the window is the only way to tell which
terminal is which at a glance, but the OSC title is constantly
overwritten by shell programs. The per-pane header text (patch
0030.5) lives **inside** the terminal and rolls with the scrollback;
it does not solve the "I want to call this tab
`frontend-build` no matter what" problem.

## Decisions made with the user

- **Sticky override** (not "OSC wins"): the user explicitly
  rejected the alternatives. The whole point of the feature is
  that the user-set name survives `vim`, `tmux`, and friends.
- **Right-click menu entry** (not double-click on the tab, not
  F2): consistent with the existing "Rename terminal…" entry
  (patch 0030.5, removed in favour of double-click in patch
  0030.5; see "But what about double-click?" below). Reuses
  the Win32 dialog and the dispatcher pattern in
  `mouseevent.rs`.
- **Per-tab, not per-group**: the user already has groups for
  clustering; tab names are the inner-level differentiator
  (e.g. "frontend-build" vs "frontend-tests" inside the
  "frontend" group). This mirrors how Chrome / Firefox tabs
  work.
- **Render immediately on rename**: posting a
  `MuxNotification::WindowInvalidated` after `set_user_title`
  makes the tab-bar repaint with the new name on the very
  next frame, no need to click on the tab or move the mouse.

## How the operation works

The right-click menu entry is "Rename tab…" (label: "Rename
&tab…", wID `0x6200`, kind `NativeCommand::RenameTab`,
icon `MenuIconId::RenameTab`). Clicking it dispatches
`DispatchAction::RenameTab` via the patched upstream
`schedule_native_menu` (the same dispatcher that handles
`RenameTerminal`).

### Tab-bar right-click no longer opens the tab navigator

The upstream wezterm tab bar opens a **Skia-based "Tab
Navigator" overlay** (a fuzzy-search launcher filtered to
the list of open tabs) when the user right-clicks on a tab.
That overlay is a real modal — it eats the right-click,
hides the terminal pane, and does not include a "Rename
tab…" entry. With this patch in place, the right-click on
a tab in **WezTerminator mode** (`WTINATOR_ACTIVE=1` or
one of the `wezterm*.exe` / `wezterminator.exe` exe names)
instead opens the WezTerminator native right-click menu
(the same menu you get from right-clicking the terminal
pane), which now includes the "Rename tab…" entry.

The check lives in `mouseevent.rs::mouse_event_tab_bar`'s
`WMEK::Press(MousePress::Right)` arm:

```rust
TabBarItem::Tab { .. } => {
    if crate::tabbar::is_wtinator_active() {
        if let Some(pane) = self.get_active_pane_or_overlay() {
            show_native_full_menu(self, pane.pane_id());
        }
    } else {
        self.show_tab_navigator();  // upstream behaviour
    }
}
```

The `is_wtinator_active()` helper is a public re-export
(of the existing private `wtinator_active()`) in
`wezterm-gui/src/tabbar.rs`. In plain wezterm (no
`WTINATOR_ACTIVE` env, plain `wezterm-gui.exe` binary)
the upstream `show_tab_navigator` behaviour is preserved
so non-WezTerminator users still get the tab-list overlay.

The active pane id is used to open the menu (same as
right-click on the terminal pane); the per-pane
`RenameTerminal` and the per-tab `RenameTab` entries are
both visible. The user picks the one they want.

### Dispatch (right-click anywhere in WezTerminator mode)

The dispatch arm (in `mouseevent.rs`):

1. Resolves the focused pane → tab id via
   `mux.resolve_pane_id(pane_id)`.
2. Fetches the current `user_title` via `tab.get_user_title()`.
3. Spawns a dedicated `std::thread` that runs the existing
   `wtinator::header::win32_prompt::run` dialog (via the new
   `prompt_user_title` wrapper) prefilled with the current
   title. The dialog is identical to the patch 0030.5 per-pane
   rename dialog (same Segoe UI 9pt font, same `#FAFAFA`
   background, same OK/Cancel/Enter/Esc/close behaviour).
4. On OK, posts a `TermWindowNotif::Apply` back to the main
   thread that:
   - Calls `tab.set_user_title(Some(new_title))` on the
     `mux::Mux` (mux locks must be taken on the main thread —
     the dialog thread only carries data).
   - Posts a `MuxNotification::WindowInvalidated(window_id)`
     so the tab-bar repaints with the new name on the very
     next frame.

The tab-bar render reads `user_title` (via the new
`TabInformation::user_title` field) in preference to
`tab_title` in `compute_tab_title`. The fallback chain is:

```
user_title (if set and non-empty)
  → tab_title (OSC 0/2 from the shell)
  → pane.title (upstream pane title)
```

This means the user-set name sticks even if the shell keeps
sending `OSC 0; vim` to rewrite the title.

## Threading model (mirrors patch 0030.5)

The Win32 input dialog has its own `GetMessageW` message loop,
which would **block the wezterm main message loop** if run
there. We therefore spawn a dedicated `std::thread` for the
dialog, and post a `TermWindowNotif::Apply` back to the main
thread when the user picks OK / Cancel. The wezterm window
remains responsive while the dialog is open (paint events,
key input, focus changes, etc. all still flow through the
main thread's `PeekMessageW`).

The dialog thread carries only data (`hwnd_isize`,
`current_user_title: Option<String>`, `tab_id`); it never
takes a mux lock. The mux mutations happen on the main
thread inside the `TermWindowNotif::Apply` closure, which
respects the "no mux locks off the main thread" rule that
patch 0030.5 documented.

## Upstream change to `Tab`

The `mux` patch is **purely additive** — one field, three
methods (mirroring the `group_name` field from patch 0028):

```rust
struct TabInner {
    // ... existing fields ...
    group_name: Option<String>,    // patch 0028
    user_title: Option<String>,   // patch 0031
    recency: Recency,
}

impl Tab {
    pub fn get_user_title(&self) -> Option<String> { ... }
    pub fn set_user_title(&self, title: Option<String>) { ... }
    pub fn effective_title(&self) -> String { ... }
}
```

`effective_title` returns the user-set title if set and
non-empty, else the regular `title` field (the OSC 0/2
value). The empty string is treated like `None` for the
override so that "clear the user title" is a single API
call.

We deliberately do **not** emit a `MuxNotification` for
`set_user_title` because the field is a WezTerminator-private
concept and the upstream wezterm GUI ignores it. The "Rename
tab…" handler posts an explicit
`MuxNotification::WindowInvalidated` after the rename so the
tab-bar repaints immediately; the same pattern keeps the
patch free of any new variant in the `MuxNotification` enum.

## `Tab.user_title` survives across restarts

The save/restore of the user title is owned by
`wtinator::session` (this patch). The data model is purely
additive; the persistence side adds:

- A new optional `user_title: Option<String>` field on
  `TabEntry` with `#[serde(default,
  skip_serializing_if = "Option::is_none")]` so v5 files
  (which lack the field) parse cleanly into v6 with
  `user_title = None`.
- A capture step in `snapshot()` that calls
  `tab.get_user_title()` next to `tab.get_title()`.
- An apply step in `apply()` that calls
  `tab.set_user_title(Some(user_title.clone()))` only when
  the persisted value is `Some`, so we do not clobber the
  user-set value on a brand-new tab whose loaded entry has
  no `user_title` (the default for v5 files).
- A schema bump from v5 to v6. The new version is
  recorded in the JSON `version` field; the loader
  already accepts older versions as long as
  `session.version <= SESSION_VERSION`.

## Revert

1. Remove `user_title` from `TabInner` and the three
   methods (`get_user_title`, `set_user_title`,
   `effective_title`) from `impl Tab` in
   `upstream-wezterm/mux/src/tab.rs`. Revert the
   `effective_title_prefers_user_title` test.
2. Remove `NativeCommand::RenameTab`,
   `DispatchAction::RenameTab`, the wID `0x6200`, and the
   "Rename tab…" `MenuEntry::Item` from
   `upstream-wezterm/wtinator/src/context_menu.rs`. Revert
   the `full_menu_includes_*` test count from 15 back to
   14. Remove the `seen.insert(NativeCommand::RenameTab.w_id())`
   line from the `all_w_ids_are_unique` test.
3. Remove `MenuIconId::RenameTab` and the `draw_rename_tab`
   function from
   `upstream-wezterm/wtinator/src/menu_icons.rs`. Revert
   the `ids` test array.
4. Remove `prompt_user_title` from
   `upstream-wezterm/wtinator/src/header/mod.rs`.
5. Remove the `DispatchAction::RenameTab` arm in
   `wezterm-gui/src/termwindow/mouseevent.rs::schedule_native_menu`.
   Revert the `is_wtinator_active()` check in
   `mouse_event_tab_bar`'s `WMEK::Press(MousePress::Right)` arm
   back to the unconditional `self.show_tab_navigator()`.
6. In `wezterm-gui/src/tabbar.rs::compute_tab_title`,
   revert the `user_title` branch back to the
   tab_title / pane.title fallback. Remove the
   `pub fn is_wtinator_active()` re-export (and the
   private `wtinator_active()` helper can stay as it
   was).
7. In `wezterm-gui/src/termwindow/mod.rs`, remove
   `user_title` from `TabInformation` and from
   `get_tab_information`; remove the Lua
   `add_field_method_get("user_title", ...)` call.
8. In `wtinator/src/session.rs`, drop `user_title` from
   `TabEntry`, revert `SESSION_VERSION` to 5, drop the
   `user_title` capture in `snapshot()`, drop the
   `set_user_title` call in `apply()`. Revert the
   `session_v5_file_loads_into_v6_with_default_user_title`
   and `session_v6_round_trip_preserves_user_title` tests,
   and restore the original
   `session_v5_schema_serializes_cleanly` test (without
   the `assert!(parsed.version <= SESSION_VERSION)`).
9. Remove this file and the row for patch 0031 from
   `PATCHES.md`.

## Risk

**Low.** Mirrors patch 0030.5 (per-pane header rename) and
patch 0028 (tab group) line for line:

- 1 new field in `TabInner` (mux patch is purely additive;
  no existing code touched).
- 1 new `NativeCommand` variant + 1 new `DispatchAction`
  variant (just an enum tag, no new dispatch path surface).
- 1 new menu item (extending the existing full-menu
  builder).
- 1 new menu icon variant.
- 1 new dispatch arm in `mouseevent.rs` (a `match` arm
  that mirrors `RenameTerminal` line-for-line, only with
  a different field name and wID).
- 1 new field in `TabEntry` with `serde(default)` (v5 →
  v6 is transparent).
- 1 new field in `TabInformation` + 1 line in
  `tabbar.rs::compute_tab_title` (just a precedence swap).

If `user_title` happens to be `None` for every tab at
runtime (the most common state), the `effective_title`
helper returns the existing `title` field — **no
behavior change** for users who never use "Rename tab…".

The only non-trivial piece is the threading model in the
`mouseevent.rs` arm, but it is a copy of the patch 0030.5
pattern that has been working since 2026-06-08.

All 89 `wtinator` tests pass, including the 2 new ones
(`session_v5_file_loads_into_v6_with_default_user_title`
and `session_v6_round_trip_preserves_user_title`) and the
1 new mux test (`effective_title_prefers_user_title`).

## But what about double-click?

Patch 0030.5 deliberately removed the "Rename terminal…"
entry from the right-click menu in favour of **double-click
on the in-pane header bar** to enter edit mode. We
considered doing the same for "Rename tab…" — i.e.
double-click on the tab in the title/tab strip — but
decided against it for now:

- The tab-bar mouse handling is more complex than the
  in-pane header handling: the tab bar lives in the
  custom title strip (patch 0020) and the click target
  is a moving rectangle that depends on the current
  layout (number of tabs, active state, hover state,
  etc.). Adding a "double-click → edit" path here would
  touch the `fancy_tab_bar` renderer and the
  `mouseevent.rs` UI-item resolution, both of which are
  out of scope for a one-line tab-name feature.
- The right-click menu is already where the user goes
  for tab-level actions ("Move pane to…", close, etc.),
  so "Rename tab…" is discoverable in the same place.
- If the user later wants double-click on the tab, the
  right-click entry is still there as a fallback.

## Out of scope (deferred)

- **Tab icon / emoji prefix** (e.g. 🔥 for "hot reload"):
  out of scope; can be added later by allowing leading
  non-ASCII in `normalize_user_title` (a new function
  with the same role as the per-pane
  `wtinator::header::normalize_header_text`).
- **Live Lua callback integration for `effective_title`:
  the new `user_title` field is exposed to Lua but
  `format-tab-title` callbacks still see the OSC
  `tab_title` unchanged. If the user later wants Lua
  callbacks to differentiate between user-set and
  OSC-set, a follow-up patch can add a
  `has_user_title: bool` field or rework
  `compute_tab_title` to call the Lua callback with the
  effective title.
- **Per-window "tab manager" dialog** (one window listing
  all tabs across all groups, like a tabs-overview): the
  user can ask for this in a future patch.
- **Hot-key shortcut for rename** (e.g. F2 / Ctrl+Shift+R):
  can be added by a new `KeyAssignment` variant in
  `config/src/keyassignment.rs` + a `wezterm-gui` handler
  in `keyevent.rs` that calls the same dialog.
