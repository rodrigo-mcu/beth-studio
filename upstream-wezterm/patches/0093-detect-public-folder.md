# 0093 — Detect the Windows Public folder

## What

The installer default is `<Public>\BethTerm`, where Public is resolved for
this Windows version and layout:

1. `SHGetKnownFolderPath(FOLDERID_Public)` (Vista / 7 / 10 / 11, including
   relocated or non-`C:` Public folders)
2. `%PUBLIC%` if that directory exists
3. Parent of `CSIDL_COMMON_DOCUMENTS` (XP `All Users`, Vista+ `Public`)
4. `%SystemDrive%\Users\Public` or `\Documents and Settings\All Users`
   if those directories exist

`C:\Users\Public` is only the last-ditch fallback, not the primary path.

## Revert

Restore the `%PUBLIC%` / hardcoded `C:\Users\Public` lookup in
`suggested_install_dir()`.
