# 0110 — Default theme for all terminals

## What

The Settings app can mark one theme as the **default for every terminal**.

- **Usar em todos** on a theme card saves the id to
  `%APPDATA%\bethterm\default-theme.json` and recolours every live pane
  in every window.
- New tabs and new windows with no explicit per-pane theme stamp that
  default.
- Splits still inherit the source pane (patch 0054).
- Restored panes that never had a theme also pick up the default.
- The matching card shows a **default** badge.

Per-pane Apply is unchanged: it still colours only the right-clicked
terminal.

## Files

- `wtinator/src/default_theme.rs` (new)
- `wtinator/src/lib.rs`
- `wtinator/src/notify.rs`
- `wtinator/src/notify_ipc.rs`
- `wezterm-gui/src/spawn.rs`
- `wezterm-gui/src/frontend.rs`
- `wezterm-gui/src/termwindow/session_restore.rs`
- `wtinator-config/src/main.rs`
- `wtinator-config/frontend/src/{App.tsx,ipc.ts,ThemeCard.tsx,styles.css}`
  and rebuilt `frontend/dist/index.html`

## Revert

Delete `default_theme.rs`, drop the `set_default_theme` IPC variant, and
remove the spawn/restore stamp plus the Settings **Usar em todos** button.
