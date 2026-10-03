# 0183 — User-defined shells in `shells.json`

**Status:** Implemented 2026-09-25.

## Why

BethTerm is going to be published as open source. The "Novo terminal"
list had one entry hard-coded for a single workstation (a desktop
application started in debug mode, with its log followed in PowerShell,
at a fixed path), plus a personal fallback path for MobaXterm. Neither
belongs in shared code, but the entry is still useful to its user.

## What changed

- `default_shells()` appends user entries read once per process from
  `%APPDATA%\bethterm\shells.json`:

  ```json
  [
    { "id": "my.tool", "label": "My tool log",
      "args": ["powershell.exe", "-NoLogo", "-NoExit", "-Command", "..."] }
  ]
  ```

  Entries with empty `args`, a blank `label`, an `id` outside
  `[a-z0-9._-]` or a duplicate `id` are skipped; a file that is not a
  JSON list is ignored with a warning. The strings are leaked once per
  process so `ShellEntry` keeps its `&'static str` fields.
- The same list feeds the GUI menus (new tab, split right/down, tray
  "Novo terminal") and `bethterm cli bridge`'s `shells` op, so custom
  entries appear in the web UI too.
- The hard-coded site-specific entry and the personal MobaXterm fallback
  path were removed.
- Test fixtures in `clipboard.rs` and `wsl.rs` use generic names and
  paths.

Edits to `shells.json` take effect on the next GUI start
(`bethterm gui-restart`) and the next bridge start (reopen the web UI).

## Files

- `wtinator/src/context_menu.rs` — `custom_shells`, `parse_custom_shells`,
  test `custom_shells_keep_valid_unique_entries`
- `wtinator/src/clipboard.rs`, `wtinator/src/wsl.rs` — test fixtures

## Revert

Remove `custom_shells`/`parse_custom_shells` and the `extend` call.
Remove row 0183 and this file.
