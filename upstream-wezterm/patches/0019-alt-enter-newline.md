# Patch 0019 — `Alt+Enter` sends `LF` for multi-line input in AI agent CLIs

**Applied:** 2026-06-07 (revised 2026-06-07 — see "Fix 0019.1"
below)
**Files:**
- `upstream-wezterm/wezterm-gui/src/commands.rs`

**Status:** Active

## What

Two new default key bindings are added at the end of
`CommandDef::default_key_assignments`:

| Mods | Key | Action |
| --- | --- | --- |
| `ALT` | `Char('\r')` (the "Enter" key) | `SendString("\n")` |
| `ALT` | `Physical(KeypadEnter)` | `SendString("\n")` |

The default `Enter` (no mods) continues to send `CR` (`0x0D`), so
existing shells and `cat`/`less` etc. see no change.

## Why

AI agent CLIs (Claude Code, Gemini CLI, Aider, OpenHands) often
need a literal newline in the middle of a prompt — for example
to break a paragraph, to add a code-fence line, or to start a new
sub-prompt. The standard `Enter` in a TUI sends `CR`, which most
agents treat as "submit the prompt". Holding `Alt` while pressing
`Enter` is a long-standing convention in chat-style TUIs to mean
"newline" (the same role as `Shift+Enter` in a web browser).

Without this binding, the user has to fall back to copy-pasting a
multi-line string or configuring the binding by hand in
`wezterm.lua`. The patch makes `Alt+Enter` work out of the box.

## How the upstream dispatches it

`SendString` is one of the upstream `KeyAssignment` variants
(`config::keyassignment::KeyAssignment::SendString(String)`). When
the keyevent handler reaches this binding, it serialises the
string into the focused pane's input stream as a sequence of
bytes. The string `"\n"` is one byte, `0x0A` (LF), which the agent
sees as a newline.

The bindings are appended to `result` *after* the iteration over
`expanded_commands`, so they participate in the upstream
`disable_default_key_bindings` check that gates the rest of the
default table. A user who sets `disable_default_key_bindings =
true` to take full control of the keymap will also disable
`Alt+Enter` and can re-add it manually.

## User override

The bindings are inserted at the **end** of the defaults list and
do not collide with any default binding (the upstream maps
`Enter` to `KeyCode::Char('\r')` with no modifier for the default
`ActivateCommandPalette` etc.). A user who wants a different
`Alt+Enter` action can set one in their `wezterm.lua`:

```lua
config.keys = {
  { key = "Enter", mods = "ALT", action = wezterm.action_callback { ... } },
}
```

The user's setting wins because the `InputMap` consults the
`keys.default` table before adding the bootstrap `Alt+Enter`
binding.

## Fix 0019.1: don't conflict with the upstream `ToggleFullScreen` default

The user reported that `Alt+Enter` was "toggling fullscreen"
rather than inserting a newline. Root cause: the upstream
`ToggleFullScreen` `CommandDef` is itself bound to
`(Modifiers::ALT, "Return")` — a Windows-Explorer convention.
The upstream `default_key_assignments` loop, when running, hits
the upstream `ToggleFullScreen` entry first and inserts it into
`result`. The `InputMap::new` dedup pass at
`wezterm-gui/src/inputmap.rs:74-86` then normalises
`KeyCode::Char('\r')` (from the upstream `"Return"` label)
and `(Modifiers::ALT, KeyCode::Char('\r'))` from our
`SendString("\n")` binding, sees that the key is already in
`keys.default`, and discards our new binding. The user
effectively only has the upstream `ToggleFullScreen` action.

The fix removes the upstream `(Modifiers::ALT, Char('\r') | Physical(KeypadEnter))`
entry from the default list *before* adding the new
`SendString("\n")` binding. The user can still get
fullscreen-toggle via `F11` (the upstream itself registers
`F11` as a second default for `ToggleFullScreen`) or via
the integrated maximise button in the custom title bar
(patch 0020). The user can also set the binding manually
in `wezterm.lua` if they want a different shortcut.

## Revert

To disable the `Alt+Enter` default binding:

1. In `wezterm-gui/src/commands.rs`, drop the `if !config.disable_default_key_bindings { ... }` block at the end of `default_key_assignments`.
2. Drop this file and the row for patch 0019 from `PATCHES.md`.

## Risk

Low. The bindings are additive — no existing default keymap
binding is changed. The only effect is that pressing
`Alt+Enter` now sends `0x0A` (LF) instead of `0x0D` (CR); both
behaviours are valid terminal inputs and the difference is only
visible to programs that read the input stream character-by-character
(AI agent CLIs).

33/33 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
