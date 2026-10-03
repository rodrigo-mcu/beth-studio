# 0127 — Do not set ConPTY flag 0x8

**Status:** Corrected 2026-09-21. The first version of this patch was wrong
and is reverted.

## What went wrong

`PSEUDOCONSOLE_PASSTHROUGH_MODE = 0x8` is a stale name. The ConPTY 1.24
DLL shipped in `assets/windows/conhost` (`conpty-static.h` from Windows
Terminal v1.24.10921.0) defines that bit as
`PSEUDOCONSOLE_GLYPH_WIDTH_GRAPHEMES`, part of
`PSEUDOCONSOLE_GLYPH_WIDTH__MASK` (0x18). That header has no passthrough
flag.

Passing 0x8 makes ConPTY measure columns by grapheme clusters while
WezTerm measures them its own way. A full-screen app (the Grok agent)
then sees a different width, clears, jumps the cursor to the top, and
repaints in a loop. Enter looks like it does nothing.

## Fix

`CreatePseudoConsole` stays on the patch 0113 flags only:
`PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE`. The
constant is renamed so 0x8 is not passed again.

## Files

- `pty/src/win/psuedocon.rs`

## Revert

Nothing to restore. The create call matches patch 0113.
