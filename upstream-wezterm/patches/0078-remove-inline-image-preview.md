# Patch 0078 — remove terminal inline-image preview

## Problem

The display-only OSC 1337 preview introduced by patch 0077 occupied terminal
rows and made normal command-line use visually worse.

## Implementation

Remove the OSC output injection and restore the local-pane helper to its
internal visibility. Clipboard image paste continues to save a PNG and paste
the Markdown local-file link, including WSL path conversion.

## Validation

Validated with the Windows release build for `wezterm` and `wezterm-gui`, and
`cargo +nightly test -p wtinator` (148 tests passed).

## Revert

Restore the preview injection from patch 0077, then remove this document and
row 0078 from `PATCHES.md`.
