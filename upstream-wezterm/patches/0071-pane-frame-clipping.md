# Patch 0071 — pane frame clipping after resize

## Problem

A pane could retain stale line quads after a split resize. The PTY row count and
the visual pane rectangle can briefly disagree, allowing the terminal content
or cursor to extend below the pane frame. The line cache also did not include
the current right-edge clip width.

## Implementation

- Add the pane clip width to the LineQuadCacheKey, preventing old-width quads from
  being reused after a split resize.
- Compute the physical number of scaled rows that fit between the pane content
  origin and its frame, and skip any stale PTY rows beyond that limit.
- Clamp the cursor to the base-metric pane rectangle while using the scaled
  cell size for its block.
- Keep the dock preview inside pos.height; the header row is already included
  in that layout height and must not be added twice.

## Validation

cargo +nightly check -p wezterm-gui and the Windows release build completed.
The installer refused to replace the deployed binaries while the installed
wezterm-gui.exe and its OpenConsole.exe children were running; no process
was terminated.

## Revert

Remove the pixel_width field from LineQuadCacheKey, remove
max_visible_rows and its guard from render/pane.rs, restore the previous
cursor/dock geometry, then remove this document and row 0071 from PATCHES.md.