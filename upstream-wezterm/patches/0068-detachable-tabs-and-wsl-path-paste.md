# Patch 0068 — detachable tabs and WSL-aware path paste

## Detachable tabs and multiple windows

- `Mux::move_tab_to_window` transfers the existing `Arc<Tab>` between mux
  windows. It does not respawn panes, so PTYs, processes, scrollback, group
  names, titles, themes and fonts remain intact.
- Dropping a tab outside its tab strip creates a populated mux window and lets
  the frontend create the corresponding physical window.
- Right-clicking a tab exposes **Move tab to**, with **New window** plus all
  existing windows. The source window is disabled as a destination.
- Moving the final tab closes only the now-empty source window, after the live
  tab has been attached to its destination.

## Multi-window session persistence

- Session schema version 8 adds `TabEntry.window_index`; older sessions default
  to window 0.
- Pane `tab_index` is now global across the snapshot instead of restarting at
  zero in each window.
- Restore creates each additional mux window atomically with its first tab and
  maps metadata by stable session-tab index.
- A process-global startup claim prevents the newly-created physical windows
  from recursively restoring the same session.

Window coordinates/monitor assignment remain controlled by the Windows window
manager. The restored session recreates the window separation; users can place
each window on the desired monitor.

## WSL-aware text paste

- After clipboard-control sanitization, the destination pane is checked with
  `wtinator::wsl::pane_is_wsl`.
- Only WSL panes rewrite embedded absolute drive paths:
  `C:\work\repo` → `/mnt/c/work/repo`.
- Quoted paths keep their quote characters and spaces. Multiple paths in one
  clipboard payload are supported.
- PowerShell, cmd and other non-WSL panes receive the sanitized original text.

## Validation

Unit coverage includes path conversion, quoted paths, non-Windows text,
session-v8 window indices, legacy-session defaults and native command routing.
The GUI must be rebuilt before manual testing; no running process is terminated
by the implementation or validation workflow.
