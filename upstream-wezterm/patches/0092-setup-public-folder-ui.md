# 0092 — Installer UI, public folder, transparent install copy

## What

Redesign the native Win32 setup window:

- Default folder is `%PUBLIC%\BethTerm` (typically `C:\Users\Public\BethTerm`).
- Header states the install is portable and does not touch the registry
  or hidden folders.
- A “Instalação transparente” group lists: no registry, no services,
  no AppData/ProgramData/hidden paths, files only in the chosen folder,
  uninstall = delete that folder.
- Optional Desktop / Start Menu shortcuts remain a checkbox.

## Revert

Restore the compact 520×260 layout and `C:\Users\Public\BethTerm` default.
