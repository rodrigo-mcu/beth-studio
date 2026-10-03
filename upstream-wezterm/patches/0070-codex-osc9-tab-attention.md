# Patch 0070 — Codex OSC 9 tab attention

## Problem

The existing patch 0063 marks a tab when a pane emits BEL. Codex CLI's TUI
supports `agent-turn-complete` and `approval-requested` notifications, but its
default `auto` method prefers OSC 9 when the terminal supports it. WezTerm
decoded OSC 9 into `Alert::ToastNotification`; the per-window subscription
explicitly filtered that alert out, so it could create a desktop toast but
never change the tab indicator.

## Implementation

- Forward `Alert::ToastNotification` through the mux window subscription.
- Add `mark_tab_attention(pane_id)` as the common BEL/OSC 9 path.
- An OSC 9 notification from Codex or another CLI starts the existing red-dot
  blink and retains the existing acknowledgement rule: the state clears when
  its tab is active in the focused window.
- Keep desktop toast handling unchanged in the frontend.

This intentionally reacts to the terminal notification protocol rather than a
Codex process name, so it works through WSL, wrappers and future agent CLIs.

## Validation

Run `cargo +nightly check -p wezterm-gui` and build both Windows release
binaries. Do not terminate the user's running GUI process during validation.

## Revert

Restore the `ToastNotification` early-return in
`mux_pane_output_event_callback`, restore the no-op notification arm in the
window handler, inline the previous BEL attention block, then remove this
document and row 0070 from `PATCHES.md`.
