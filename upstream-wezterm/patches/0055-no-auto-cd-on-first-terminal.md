# Patch 0055 — No auto-typed `cd` on the restored first terminal

**Status:** Implemented 2026-06-14.

## Symptom

On restore, the **first** terminal came up with a command it never typed:

```
C:\Users\Rodrigo>cd C:\Users\Rodrigo\
```

(The user: "pq o primeiro terminal sempre exibe na linha de comando o
diretorio… nao fui eu quem digitei, ele entra assim automaticamente.")

## Cause

The GUI creates one default tab at startup, then `restore_session` runs. For
tab 0 it **reused** that already-created tab and, to put it back in the saved
working directory, **wrote `cd <cwd>\n` into the shell's input**. cmd.exe (and
any shell) echoes typed input, so that `cd` was visible in the scrollback.
Tabs 1+ never showed it because they spawn fresh with the cwd passed straight
to the spawn (`CommandBuilder::cwd`), so no `cd` is needed.

## Fix

Spawn **every** restored tab fresh in its own cwd — the same path tabs 1+
already use — and remove the now-redundant startup tab:

- Capture the startup tab id before the loop
  (`mux.get_active_tab_for_window(window_id)`).
- Drop the `tab_index == 0` special case so tab 0 goes through
  `mux.spawn_tab_or_window(..., command_dir, ...)` like the rest (cwd applied
  at spawn, no `cd` written).
- After the tabs are created, `mux.remove_tab(startup)` — guarded by
  `!created_tabs.is_empty()` so a fully-failed restore never removes the only
  tab and leaves an empty window (and `!created_tabs.contains(&startup)` for
  safety).

The first terminal now opens directly in its saved directory with a clean
prompt and no auto-typed command. `remove_tab` calls `prune_dead_windows`, but
the guard guarantees other tabs exist, so the window is never pruned.

## Files

- `wezterm-gui/src/termwindow/session_restore.rs`

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm-gui
```

Restore a session: the first terminal shows just its prompt in the saved
folder — no `cd ...` line. The tab count/order is unchanged (the empty startup
tab is gone).
