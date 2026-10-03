# 0128 — Setup update while BethTerm is open

**Status:** Implemented 2026-09-21.

## Symptom

Atualizar sobre `C:\Users\Public\BethTerm` failed while `bethterm-host.exe`
and `OpenConsole.exe` were running. The extractor truncated each file in
place, so Windows returned a sharing violation and the setup stopped on
`bethterm-host.exe`. The GUI had already been replaced; the host had not.

## Fix

Each tar entry is unpacked to a sibling `*.installing` file, then moved
into place.

- `bethterm-host.exe`, if the live image cannot be deleted, is written to
  `bethterm-host.exe.new`. The next host start (`apply_pending_binary`)
  swaps it in. The setup says to Encerrar host and open BethTerm again.
- Any other locked file is renamed to `name.<stamp>.running` (a running
  image can be renamed) and the new file takes the original name.

## Files

- `bethterm-setup/src/main.rs`

## Revert

Restore `extract_zstd_tar` so it unpacks directly onto the destination,
and drop the host note from the success text. Remove this document and
row 0128 from `PATCHES.md`.
