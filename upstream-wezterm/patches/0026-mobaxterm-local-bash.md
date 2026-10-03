# Patch 0026 - Optional MobaXterm local bash shell

## Files

- `upstream-wezterm/wtinator/src/context_menu.rs`

## What changed

The default shell picker now detects:

```text
%USERPROFILE%\Documents\MobaXterm\slash\bin\bash.exe
```

When that file exists, the new-tab picker and both split submenus get a
`MobaXterm local bash` entry.

This patch originally also hard-coded a second, site-specific entry (a
desktop application started in debug mode with its log file followed in
PowerShell). That entry was removed from the code by patch 0183; the same
kind of entry can now be defined by each user in
`%APPDATA%\bethterm\shells.json`.

## Limitations

`MobaXterm local bash` opens the extracted MobaXterm bash, but it does not
reproduce MobaXterm's own terminal bridge. MobaXterm's `winpty` helper does
not attach to a ConPTY-backed pane, so programs that rely on it behave as in a
plain Windows console.

## Revert

Remove `moba_local_bash_path()` and the optional `mobaxterm.local` entry from
`default_shells()`. Remove row 0026 and this file.
