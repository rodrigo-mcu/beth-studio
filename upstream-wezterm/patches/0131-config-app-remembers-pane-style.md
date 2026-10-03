# 0131 — Settings app opens with the terminal's current style

**Status:** Implemented 2026-09-21.

## Symptom

Set a theme, font family, size, bold or italic on a terminal, close the
Settings app, right-click → **Configurar terminal** again: every control
is back to the defaults and no theme card is marked as current. The
terminal itself kept the style; only the app forgot it.

Also: the button that saves a default theme was labelled **Usar em
todos**, which does not read as "save as default", so it looked as if
there was no way to save one.

## Cause

`ConfigSnapshot` only carried each tab's active-pane **font family**
(patch 0043). The pane's theme id, font scale, bold and italic were never
sent, and `TabSnapshot.current_theme` was hard-coded to `"default"`.
The React app therefore seeded size from the window base size and
bold/italic/theme from nothing.

## Fix

- `wtinator::notify::PaneSnapshot` (pane_id, tab_id, theme_id,
  font_family, font_scale, font_bold, font_italic). `snapshot_for_config`
  lists every live pane in `ConfigSnapshot.panes` (additive field, no
  protocol bump). `TabSnapshot.current_theme` reports the active pane's
  real theme id.
- `wtinator-config` forwards `panes` in its `snapshot` reply.
- `App.tsx`: on the first snapshot, the pane launched with `--pane-id`
  seeds theme, family, size (`base × scale`, rounded to 0.5 pt), bold
  and italic.
- `ThemeCard.tsx`: **Usar como padrão** / **Padrão** and the badge
  **padrão** (was "Usar em todos" / "Default" / "default").

## Files

- `wtinator/src/notify.rs`, `wtinator/src/notify_ipc.rs` (test ctor)
- `wtinator-config/src/main.rs`
- `wtinator-config/frontend/src/{ipc.ts,App.tsx,ThemeCard.tsx}` and the
  rebuilt `frontend/dist/index.html`

## Verification

- `cargo +nightly test -p wtinator --lib notify` — 22 passed.
- Manual: set theme + font + bold on a pane, reopen Configurar terminal:
  the card shows **current**, family/size/bold match.

## Revert

Remove `PaneSnapshot`/`panes`, restore the hard-coded `current_theme`,
the old seeding in `App.tsx`, and the old labels. Rebuild the frontend.
Remove this document and row 0131 from `PATCHES.md`.
