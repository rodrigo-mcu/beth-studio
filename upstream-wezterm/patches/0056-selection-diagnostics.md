# Patch 0056 — Mouse selection diagnostics and header coordinate hardening

**Status:** Implemented 2026-06-16.

## Symptom

The user reported that selecting text with the mouse sometimes does not work
and the selection highlight is not visible:

> "a selecao de caracteres para copiar e colar as vezes nao funciona, nem
> mostra a selecao na tela, ai fica complicado saber / ver o que esta sendo
> feito"

Several WezTerminator patches touch the mouse/selection path (custom titlebar,
per-pane header, per-pane font scaling, native context menus), so the failure
could come from coordinate drift, the header consuming clicks, or a repaint
issue.

## Fix

Two concrete changes:

1. **Harden the header subtraction in `mouse_event_terminal`.**
   The already-captured drag branch already clamped `row` with `.max(0)` after
   subtracting the header line, but the first-press branch did not. A click on
   the top edge of a pane (or a drag that crossed back over the header) could
   therefore produce a negative local `row`, which then flowed into
   `stable_row` and selection range math. Both branches now clamp consistently.

2. **Add targeted debug logging through the selection pipeline.**
   With `WEZTERM_LOG=debug` the following points now emit diagnostics:
   - `mouse_event_terminal`: raw window cell, detected pane, whether the pane
     has a header, local cell after header/scale adjustment, and stable row.
   - Mouse action lookup: which `KeyAssignment` was triggered
     (`SelectTextAtMouseCursor`, `ExtendSelectionToMouseCursor`, etc.).
   - `select_text_at_mouse_cursor` / `extend_selection_at_mouse_cursor`:
     coordinates, origin, and computed selection range.
   - `selection_text`: the range being copied and the copied text (truncated).
   - `paint_pane`: when a non-empty selection range is being rendered.

These logs let us see exactly which step fails when the user reproduces the
problem (no selection created, range created but not rendered, wrong pane hit,
etc.).

## Files

- `wezterm-gui/src/termwindow/mouseevent.rs`
- `wezterm-gui/src/termwindow/selection.rs`
- `wezterm-gui/src/termwindow/render/pane.rs`

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly check -p wezterm-gui
cargo +nightly build -p wezterm -p wezterm-gui
cargo +nightly test -p wtinator
```

To collect logs during a reproduction:

```cmd
set WEZTERM_LOG=debug
run-wezterminator-debug.cmd
```

Then attempt the problematic selection and look for lines prefixed with
`wezterminator selection diag:` in the console output.
