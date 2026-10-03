# 0186 — Tray / window name "Beth Studio"

**Status:** Implemented 2026-09-26.

## Why

"Interface web" sounded secondary and technical. The product name for
the Go+React UI is **Beth Studio**; the classic WezTerm GUI stays
BethTerm / clássica. The executable remains `bethterm-web.exe`.

## What

- Tray menu label and missing-file dialog: **Beth Studio**
- `host-life.log` lines from that tray action use the same name
- Beth Studio window / sidebar title: **Beth Studio** (`appTitle`,
  frontend `AppTitle`, `index.html`)

No auto-launch, no change to host/GUI lifecycle.

## Files

- `wtinator/src/tray.rs`
- `bethterm-web/about.go`
- `bethterm-web/frontend/src/components/AppTitle.tsx`
- `bethterm-web/frontend/index.html`
- `bethterm-web/README.md`, `AGENTS.md`

## Revert

Restore the "Interface web" / "BethTerm" strings in those files.
