# 0185 — Settings window closes when deactivated

**Status:** Implemented 2026-09-26.

## Why

After picking a theme in **BethTerm Settings** (`wtinator-config.exe`),
clicking back on the terminal (or anywhere outside the settings window)
left the settings window open. It should dismiss like a picker.

## What

On `WindowEvent::Focused(false)`, exit the event loop — but only when
the top-level HWND is no longer `GetForegroundWindow()`. Keyboard focus
moving into the WebView2 child also emits `Focused(false)` while the
window stays in the foreground; those must not close the app.

## Files

- `wtinator-config/src/main.rs` — deactivate → exit (Windows active check)

## Revert

Drop the `Focused(false)` arm from the event loop in `main.rs`.
