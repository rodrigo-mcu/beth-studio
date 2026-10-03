# 0133 — Prune the GUI log directory

**Status:** Implemented 2026-09-21.

## Symptom

`%USERPROFILE%\.local\share\wezterm` held 609 MB of
`bethterm-gui.exe-log-<pid>.txt` files; one debug session left a 308 MB
file. Upstream `env_bootstrap::ringlog::prune_old_logs` only removes
logs older than seven days, so a week of traces accumulates.

## Fix

`wtinator::log_prune` (new), called from `wezterm-gui/src/main.rs`
right after `env_bootstrap::bootstrap()`:

- Lists `bethterm-gui.exe-log-*.txt`, `bethterm.exe-log-*.txt` and
  `bethterm-host*.txt` in `config::RUNTIME_DIR`.
- Deletes files older than 7 days, then the oldest until the rest fit
  in 100 MB. The current process's own log is never deleted.
- Runs on a helper thread (`bethterm-log-prune`), so a slow disk never
  delays the first window. Logs one INFO line when something was
  removed.

Default level stays `info` (upstream `setup_pretty`), because these
INFO lines are used for diagnosis: `bethterm-host: default domain`,
`window heal …`, `window hidden to notification area`,
`session changed; saving …` (patch 0134), `applied default theme …`.
`snapshot captured …` moved to DEBUG (patch 0134).

## Files

- `wtinator/src/log_prune.rs` (new), `wtinator/src/lib.rs`
- `wezterm-gui/src/main.rs`

## Verification

`cargo +nightly test -p wtinator --lib log_prune` — 4 tests (age rule,
size cap oldest-first with own log kept, no-op case, real temp dir).

## Revert

Remove the module and the call in `main.rs`. Remove this document and
row 0133 from `PATCHES.md`.
