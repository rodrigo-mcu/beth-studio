# Patch 0029 — Session save and restore

**Applied:** 2026-06-07
**Files:**
- `upstream-wezterm/wtinator/src/session.rs` (new, +200 lines)
- `upstream-wezterm/wtinator/src/lib.rs` (`pub mod session;`)
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs` (+~70 lines: hooks
  in `new_window` and `close_requested`; new `save_cancel` field)
- `upstream-wezterm/patches/0029-session-save-restore.md` (this file)

**Status:** Active

## What

`wtinator::session` persists the **(tab_id, group_name)** pairing
for every open tab in a single JSON file alongside the user's
wezterm config dir:

- **Windows:** `%APPDATA%\wezterminator\session.json`
- **Linux / macOS:** `$XDG_CONFIG_HOME/wezterminator/session.json`
  (or `$HOME/.config/wezterminator/session.json` if `XDG_CONFIG_HOME`
  is unset)

The mux upstream already saves and restores the tabs, panes,
and positions on its own (`Mux::save_to_dir` / `load_from_dir`).
WezTerminator only needs to remember the group metadata on top
of that, so the user comes back to the same logical layout
after a restart.

The JSON shape is:

```json
{
  "version": 1,
  "tabs": [
    { "tab_id": 7, "group_name": "frontend" },
    { "tab_id": 12, "group_name": null }
  ]
}
```

`null` group_name means the tab belongs to the default
(ungrouped) bucket.

## Why

Rodrigo asked for "opção de salvar a organização dos grupos e
terminais para reabrir na próxima sessão" on 2026-06-07. With
patch 0028 (groups + move pane) the user can now rearrange
their terminal layout into groups; without persistence the
arrangement is lost on every restart.

## Lifecycle

**Save (full mux snapshot):**

1. **Every 30 seconds** on a background timer armed in
   `TermWindow::new_window`. The timer is implemented with
   `smol::Timer::at(Instant::now() + Duration::from_secs(30))`
   inside a `loop { ... }` — the `smol` crate is what the
   rest of the termwindow uses (see `keyevent.rs:262` for the
   same pattern), because the wezterm GUI runs on its own
   `promise::spawn` / `async_task` executor and does **not**
   have a live tokio runtime. The earlier draft of this
   patch used `tokio::time::interval`, which panicked at
   startup with "there is no reactor running" — the
   `smol` version is the working one.
2. **On `close_requested_with_confirmation`** (just before the
   close-confirmation overlay opens — guarantees the
   click-X-to-close path also captures state).
3. **On `close_requested`** (the upstream path, after the
   user has confirmed the close in the overlay).

The auto-save timer is cancelled by a `Arc<AtomicBool>` in
the `TermWindow.save_cancel` field. The cancel flag is
flipped in both `close_requested` and
`close_requested_with_confirmation` so the timer cannot race
the window teardown.

**Load (apply to live mux):**

- In `TermWindow::new_window`, after the upstream mux has
  finished populating the tabs from `Mux::load_from_dir`.
  Tabs that the upstream mux did **not** restore (because
  the shell process died, etc.) are silently skipped by
  `apply()`.

## Schema versioning

The JSON has a top-level `version: u32` field. The current
schema is `1`. If the layout ever changes incompatibly, bump
the version and add a migration in `load()`. The loader
refuses to parse any version it does not recognize — better
to fail loud than silently misinterpret the data.

## Atomic write

`save()` writes the JSON to a `session.json.tmp` file first,
then renames it to `session.json` so a crash mid-write
cannot leave a half-written file that would parse-fail on
the next load and silently wipe the user's groups.

## Revert

1. Remove `pub mod session;` from `wtinator/src/lib.rs` and
   delete `wtinator/src/session.rs`.
2. Revert the `wezterm-gui/src/termwindow/mod.rs` changes:
   drop the `save_cancel` field, drop the `wtinator::session::save()`
   calls in `close_requested` and `close_requested_with_confirmation`,
   and drop the `load + apply` + timer-arm block in `new_window`.
3. Remove this file and the row for patch 0029 from
   `PATCHES.md`.

## Risk

**Low.** The new module is self-contained. The
`wezterm-gui` changes are additive hooks (a new field, three
small `match` arms, and one background timer). All 69
`wtinator` tests pass, including the six new ones:

- `session_round_trip_preserves_data`
- `session_default_version_is_current`
- `session_rejects_unknown_version`
- `apply_with_no_mux_is_a_no_op`
- `snapshot_with_no_mux_returns_empty`
- `session_path_is_under_a_wezterminator_dir`

The only operational risk is a race between the auto-save
timer and the shutdown-driven save. The internal `SAVE_LOCK`
mutex serializes them so the final file is always a complete
snapshot.
