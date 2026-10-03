# 0101 — Cleaner native installer layout

## What

Tighten the Win32 setup window: shorter copy, no group box, thin
progress bar, grey footer with right-aligned buttons, themed
Explorer controls, and a 48px icon.

## Files

- `bethterm-setup/src/main.rs`

## Revert

Restore the previous 580×530 layout with the “Instalação transparente”
group box.
