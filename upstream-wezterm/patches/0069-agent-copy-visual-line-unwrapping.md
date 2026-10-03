# Patch 0069 — agent CLI copy visual-line unwrapping

## Problem

WezTerm normally records whether a physical row is a soft continuation and
`selection_text` correctly omits the newline. Full-screen agent CLIs such as
Claude Code may instead paint each visual row independently. Those rows look
like explicit line endings to the terminal, so pasting the copied answer into
an editor produces a newline at every former screen edge.

## Implementation

- `wtinator::clipboard::unwrap_visual_rows` joins a row when it reaches within
  eight columns of the terminal edge or the following row is clearly a
  lowercase/punctuation continuation of an unfinished sentence.
- Blank rows, indented rows, fenced Markdown, headings, block quotes, bullets
  and numbered-list items remain separate.
- Rectangular selections bypass the transformation because their physical
  row structure is intentional.
- The transformation runs after WezTerm's native logical-line reconstruction,
  so ordinary soft wraps retain their existing exact behavior.

## Validation

Unit tests cover edge-wrapped prose, sentence continuation in a wide terminal,
paragraph/list/indented-code preservation and numbered Markdown lists. Build
and test on Windows; do not terminate the user's running WezTerminator process.

## Revert

Remove the final `unwrap_visual_rows` call from `selection_text`, delete the
helper/tests, remove this document and remove row 0069 from `PATCHES.md`.
