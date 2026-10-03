# Patch 0058 — Smarter hyperlink interaction: Ctrl+click to open, hover-highlight follows the pane under the mouse

**Status:** Implemented 2026-06-22.

## Symptom

Two reports about hyperlink (URL) handling:

1. > "tem que ajustar a abertura de link, de forma mais inteligente pq ele
   > atrapalha o copiar e colar"

   A bare left-click opened the URL under the cursor. Worse, the first click
   of a double-click word-select **over** a URL opened the browser instead of
   selecting the word, so selecting/copying URL text was painful.

2. > "o foco do link tem que ser somente se estiver passando o mouse em cima do
   > terminal, pois hoje mesmo com o mouse no terminal do lado ele foca o link
   > do terminal que está 'ativo'"

   With split panes, the hover underline lit up a link in the **active** split
   even when the mouse was hovering a *different* split.

## Cause

**Issue 1 — open-on-bare-click.** The default mouse table
(`wezterm-gui/src/inputmap.rs`) mapped plain, Shift and Alt+Shift `Left Up` to
`CompleteSelectionOrOpenLinkAtMouseCursor`. That action copies when a selection
exists and otherwise **opens the link**. A single click on a URL has an empty
selection, so it always opened — including the first click of a double-click.

**Issue 2 — highlight on the wrong pane.** In
`mouse_event_terminal` (`wezterm-gui/src/termwindow/mouseevent.rs`) the
pane-detection loop translates `column`/`row` into the *hovered* pane's local
coordinate space, but only reassigns `pane` to the hovered pane on `Press`
(or when `pane_focus_follows_mouse` is set). On a plain hover (`Move`) over a
non-active split, `pane` stayed the **active** pane, so the highlight was
computed from the active pane at the hovered pane's coordinates. The result was
written to the single window-level `current_highlight`. Rendering matches a
cell's link by `Arc::ptr_eq` (`render/mod.rs::same_hyperlink`), so only the
active pane's cells matched — lighting up the wrong split.

## Fix

`wezterm-gui/src/inputmap.rs`:

- Plain and Shift `Left Up` → `CompleteSelection` (copy only; no link open).
- Alt+Shift `Left Up` → `CompleteSelection` (copy only).
- **Added** `Ctrl` + `Left Up` → `OpenLinkAtMouseCursor`.

So a bare click never opens a link; **Ctrl+click** opens it.

`wezterm-gui/src/termwindow/mouseevent.rs`:

- Track the pane the mouse is physically over (`hover_pane`) in the
  pane-detection loop.
- Resolve the hovered hyperlink against `hover_pane`, recomputing a stable row
  from that pane's own viewport. When the mouse is over no pane, clear the
  highlight (`new_highlight = None`).
- The `Hand` cursor now appears only while `Ctrl` is held (links open with
  Ctrl+click); the hover underline still shows without Ctrl so links stay
  discoverable.

`do_open_link_at_mouse_cursor` opens whatever `current_highlight` points to, and
that now tracks the hovered pane, so **Ctrl+click opens the correct split's
link**.

## Files

- `wezterm-gui/src/inputmap.rs`
- `wezterm-gui/src/termwindow/mouseevent.rs`

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly check -p wezterm-gui
cargo +nightly build -p wezterm -p wezterm-gui
# release launcher uses target/release:
cargo +nightly build --release -p wezterm -p wezterm-gui
```

Manual checks:

- Hover a URL in a **non-focused** split → only that split underlines; the
  focused split's link no longer lights up.
- Double-click a URL → selects the word (no browser launch). Drag-select a URL
  and release → copies (no browser launch).
- **Ctrl**+hover shows the hand cursor; **Ctrl**+click opens the link in the
  pane under the mouse.

## Notes

To change the open gesture, edit the `Ctrl` binding in `inputmap.rs` (e.g. to
`SUPER` or `ALT`). To restore upstream "bare click opens", revert the three
`CompleteSelection` bindings back to `CompleteSelectionOrOpenLinkAtMouseCursor`.
