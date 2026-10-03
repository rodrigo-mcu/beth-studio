# Patch 0081 — Modern native close and rename dialogs

**Applied:** 2026-08-30

## What

- Close confirmations now use the Windows **Task Dialog** rather than the
  legacy MessageBox. It supplies contemporary Windows typography, spacing,
  warning iconography, and action buttons while retaining a native modal loop
  on a dedicated worker thread.
- The rename-tab / rename-terminal input dialog now uses a clearer 10pt Segoe
  UI typeface, a roomier layout, localized `Nome da aba`, `Salvar`, and
  `Cancelar` labels, plus the current Windows Explorer visual style for the
  input and buttons.
- Patch 0080's three-second delay and two-confirmation protection still apply
  to closing an entire application/window, including Close All behavior.

## Files

- `wtinator/src/confirm.rs`
- `wtinator/src/header/win32_prompt.rs`
- `PATCHES.md`

## Verification

```powershell
$env:PATH='C:\Strawberry\perl\bin;C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64;' + $env:PATH
cargo +nightly check -p wtinator
```

Manual: open Rename tab and verify the expanded, themed input dialog. Trigger
Close window / Close All and verify the Task Dialog appearance, the 3-second
cooling-off period, and the two required confirmations.

## Revert

Undo the listed changes, delete this file, and remove the 0081 entry from
`PATCHES.md`.
