# 0143 — Tray exit entries say what they do

**Status:** Implemented 2026-09-22.

## Symptom

"I clicked exit on the tray icon; nothing is open; why did the update
not apply?" The tray had **Sair** (closes the windows only, no
confirmation, host and every terminal keep running invisibly) and
**Encerrar host** (confirmation, then host + windows). The first one
read as "quit BethTerm".

## Fix

- **Sair** → **Fechar janelas (terminais continuam)**. Still no
  confirmation: nothing is lost.
- **Encerrar host** → **Encerrar BethTerm (fecha os terminais)**. Keeps
  the confirmation dialog ("Encerrar o BethTerm?"), whose body now also
  points at the other entry.

## Files

- `wtinator/src/tray.rs`
- `wtinator/src/confirm.rs`

## Revert

Restore the two labels and the texts. Remove row 0143 and this file.
