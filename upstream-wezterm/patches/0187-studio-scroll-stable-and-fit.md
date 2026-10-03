# 0187 — Stable scrollback + no horizontal clip in Beth Studio

**Status:** Implemented 2026-09-26.

## Why

1. Scrolling up in Claude Code (and similar fullscreen TUIs) looked
   "mixed": each poll re-applied `offset` as lines-above-live, so new
   redraw frames pushed into scrollback slid the history under the user.
2. Long lines looked cut off on the right: every screen write forced
   `scrollLeft = 0`, so a host grid wider than the panel could never be
   panned; font shrink alone was not enough.

## What

### Bridge (`bethterm cli bridge`)

- A scroll request pins an absolute stable top row (`anchors`).
- While pinned, new scrollback does not change which rows are shown;
  the reported `offset` may grow as live output continues.
- `send` / `paste` / `offset: 0` clear the pin (back to live).

### Beth Studio frontend

- Only reset `scrollLeft` when the grid fits the area.
- If the font is already at the minimum and the grid still overflows,
  CSS-scale the xterm to fit (no right-edge clip).
- Banner while scrolled: history of fullscreen apps may look mixed;
  use "Voltar ao fim".
- "Não cabe" offers **Ajustar à janela** when the pane is alone in its
  host tab.

## Files

- `wezterm/src/cli/bridge.rs`
- `bethterm-web/frontend/src/components/TerminalView.tsx`

## Revert

Restore relative-only `offsets` in the bridge and the unconditional
`scrollLeft = 0` plus the previous fit step (no CSS scale).
