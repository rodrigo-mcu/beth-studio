# 0141 — Installer copes with the locked ConPTY pair

**Status:** Implemented 2026-09-21.

## Symptom

`install-bethterm-release.ps1` with the host running: it staged
`bethterm-host.exe.new` correctly, then failed on `OpenConsole.exe` /
`conpty.dll` (locked by the host's OpenConsole processes) with an
access-denied `Remove-Item`, and the `catch` rolled the **whole**
install back, including the already-copied GUI and CLI. The result was
a mixed install (new `wtinator-config.exe`, old GUI) and stray
`OpenConsole.exe.new-<pid>` files.

## Fix

- `install-bethterm-release.ps1`: identical files (same SHA-256) are
  skipped without touching them; while the host runs, the three
  host-locked files (`bethterm-host.exe`, `OpenConsole.exe`,
  `conpty.dll`) are staged as `<name>.new`.
- `wtinator::host::apply_pending_binary` applies every staged
  `<name>.new` from `HOST_LOCKED_FILES` before starting the host, not
  only the host exe.

## Revert

Restore the host-exe-only staging in both places. Remove row 0141 and
this file.
