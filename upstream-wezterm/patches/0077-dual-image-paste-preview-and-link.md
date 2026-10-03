# Patch 0077 — dual clipboard image paste: preview plus portable link

## Problem

Pasting an image saved a PNG and sent only its Markdown file link. That is the
interoperable form for agent CLIs, but provided no visual feedback inside the
terminal. Sending OSC 1337 through `send_paste` would instead put control bytes
in the foreground agent's input stream.

## Implementation

- Save the PNG under the existing readable clipboard-image directory.
- Inject a display-only OSC 1337 inline-image preview through
  `mux::localpane::emit_output_for_pane`.
- Send the Markdown local-file link separately through `send_paste`.

The process input remains portable across Codex, Claude Code, Grok, Kimi and
OpenCode. The preview is a WezTerminator visual aid, not agent input.

## Validation

Validated with `cargo +nightly check -p wezterm-gui`, the Windows release
build for `wezterm` and `wezterm-gui`, and `cargo +nightly test -p wtinator`
(148 tests passed).

## Revert

Remove the `emit_output_for_pane` call and restore its visibility, then remove
this document and row 0077 from `PATCHES.md`.
