# 0111 — Tray icon always present + "Novo terminal" launcher

## What

Two changes to the notification-area (tray) icon next to the clock:

1. **The icon lives as long as the GUI process, even with zero hidden
   windows.** Previously `sync_icon` removed the icon when the hidden
   list emptied, so the icon blinked in and out as windows were hidden
   and restored. Now the icon is added once (at first window creation)
   and removed only when the process exits (`WM_DESTROY`).
2. **The menu gains "Novo terminal" as its first entry.** It spawns a
   default terminal in a brand-new OS window — the same path as the
   headless `SpawnWindow` key assignment (default domain, default
   program, `initial_size` fallback), so the persisted default theme
   (patch 0110) applies like everywhere else.

Resulting menu (right-click, or left-click with 0 / 2+ hidden):

```text
Novo terminal
----------------
<newest hidden window>
<older hidden windows…>
----------------
Abrir todas        (only when >1 hidden)
Sair
```

With exactly one hidden window, left-click still restores it directly
(no menu); with zero or several hidden, left-click opens the menu.

## How

- `wtinator/src/tray.rs`
  - `sync_icon` no longer removes the icon on an empty hidden list.
  - `show_menu` always builds the menu via the new pure
    `menu_entries(count) -> Vec<TrayMenuEntry>` helper
    (`NewWindow, Separator, Window(i)…, Separator?, OpenAll?, Quit`),
    covered by unit tests.
  - New `ID_NEW_WINDOW = 3` command id (below `ID_WINDOW_BASE`, so the
    window-index math is untouched) → `request_new_window()`.
  - New `init_for_gui(handler: fn())` + `ensure_tray_owner()`:
    idempotent startup entry point. When another BethTerm process
    already owns the tray window, this process stays in forward mode
    (hides go to the owner via `WM_COPYDATA`) and creates no icon.
    The tray thread additionally destroys its owner window when a
    post-creation `FindWindowW` finds a *different* owner (covers two
    processes starting within milliseconds of each other; a residual
    same-instant race could still yield two icons until restart).
  - The spawn itself lives in `wezterm-gui`, not `wtinator`: `wtinator`
    deliberately does not depend on `wezterm-gui` (the dependency runs
    the other way) nor on `promise`, so the GUI lends a plain `fn()`
    callback (`NEW_WINDOW_HANDLER`). Without a registered handler the
    entry logs a warning and does nothing.
- `wezterm-gui/src/spawn.rs`: new `spawn_default_window()` — default
  `SpawnCommand` → `SpawnWhere::NewWindow`, size from
  `config.initial_size(dpi, cell_pixel_dims)`, same as `frontend.rs`.
- `wezterm-gui/src/termwindow/mod.rs`: `TermWindow::new_window` calls
  `wtinator::tray::init_for_gui(crate::spawn::spawn_default_window)`
  on Windows in BethTerm mode (next to the `window_heal` watchdog).

## Multi-process note

The menu only ever runs on the owner process, so "Novo terminal"
always spawns in the owner's mux/GUI loop. A second
`--always-new-process` GUI registers the same handler but never shows
the menu; its hides keep forwarding to the owner as in patch 0106.

## Revert

- Restore the `count == 0` early-return in `show_menu` and the
  icon-removal branch in `sync_icon`.
- Delete `ID_NEW_WINDOW`, `menu_entries`/`TrayMenuEntry`,
  `init_for_gui`/`ensure_tray_owner`, `request_new_window`,
  `spawn_default_window`, and the `new_window` hook call.
