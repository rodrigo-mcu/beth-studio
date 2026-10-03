# 0189 — Studio theme reaches OSC 10/11 (Codex / Cursor light themes)

**Status:** Implemented 2026-09-26.

## Why

Codex, Cursor, and similar CLIs decide light vs dark by querying the real
PTY (OSC 11 background, sometimes OSC 10 / OSC 4). Beth Studio was painting
the theme only in xterm.js, so the host still answered with the default
dark palette and light themes never registered.

## What

- Bridge op `palette`: foreground, background, optional cursor, and the 16
  ANSI colours. It calls `SetPalette` on the pane.
- The mux server also applies that palette on the terminal itself
  (`pane.set_palette`), so a pane that already forked a dynamic palette
  still answers OSC queries with the Studio colours. Panes that have not
  forked one already pick up the client palette from the existing
  `SetPalette` handler.
- Beth Studio pushes the effective theme (pane theme, otherwise the Studio
  default, otherwise the factory VS Code Dark) when a theme is saved and
  again when the pane list arrives. Unchanged panes are not resent.

An agent that already sampled the theme at startup has to be started again
to notice the new colours.
