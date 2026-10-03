# 0118 — Tray "Novo terminal" must spawn on the GUI thread

**Status:** Implemented 2026-09-16.

## Symptom

Right-click the notification-area icon → **Novo terminal** → WSL (or
any shell) closed the entire BethTerm process.

## Cause

The tray owner lives on `bethterm-tray`. The 0117 handler called
`spawn_new_window` there. That function:

1. Built fonts via `cell_pixel_dims` (GUI/`Rc` work).
2. Used `promise::spawn::spawn` (`async_task::spawn_local`).

`spawn_local` must be polled on the thread that created it. The GUI
loop later ran the task and panicked, which ended the message loop.

## Fix

`spawn_new_window` only posts `spawn_into_main_thread` (callable from
any thread). Fonts and `spawn_command_impl` run on the GUI executor.
The tray call is wrapped in `catch_unwind`.

## Files

- `wezterm-gui/src/spawn.rs`
- `wtinator/src/tray.rs`

## Revert

Restore the in-place `spawn_new_window` body and the unguarded
handler call.
