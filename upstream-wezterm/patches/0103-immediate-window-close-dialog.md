# 0103 — Window-close dialog appears immediately

## What

Clicking the title-bar X (or Alt+F4) slept three seconds before the first
Task Dialog (patch 0080). The window looked hung. The first confirmation
now opens at once. Closing the application still requires two independent
Yes answers.

`session::save()` runs *after* the dialog thread is spawned so a slow
AppData write cannot delay the prompt.

## Files

- `wtinator/src/confirm.rs`
- `wezterm-gui/src/termwindow/mod.rs`

## Revert

Restore the `thread::sleep(Duration::from_secs(3))` in the
`ConfirmKind::Window` arm of `confirm_close`, and move
`wtinator::session::save()` back to the start of
`close_requested_with_confirmation`.
