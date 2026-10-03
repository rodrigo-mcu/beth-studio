# Patch 0067 — clipboard controls and split header fit

## Problems

1. Some Windows applications put invisible control separators in their plain
   text clipboard representation. U+001F reaches the PTY and a shell displays
   it as `^_`, although pasting into an HTML-aware application looks normal.
2. The custom `Tab #N` header consumes one cell row in every pane. The earlier
   workaround removed one row from the entire tab, so it only fit correctly
   for a single pane. In nested splits, the final content row of an upper pane
   could render through its bottom boundary.

## Changes

- `wtinator::clipboard::sanitize_paste_text` removes C0/C1 controls other than
  tab, carriage return and line feed. The GUI applies it immediately before a
  text clipboard payload is sent to the focused pane.
- `mux::tab::reserve_pane_header_row` converts each leaf's full layout size to
  its content size before per-pane font scaling. It subtracts one base row and
  the matching pixel height while leaving the split rectangle unchanged.
- Zoomed panes use the same sizing path.
- The GUI-wide one-row subtraction in `resize.rs` is removed.

## Validation

- Unit tests cover U+001F/control filtering, preservation of line structure and
  Unicode, normal header-row geometry, and the one-row tiny-pane guard.
- Build/check validation does not launch or terminate a GUI process.

## Risk

Low to moderate. Clipboard filtering intentionally prevents pasting raw escape
and other terminal-control bytes. Pane PTY dimensions lose exactly the row that
the visible custom header already occupies; split topology and divider geometry
remain unchanged.
