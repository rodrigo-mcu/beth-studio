# 0173 — Tray entry "Interface web"

**Status:** Implemented 2026-09-25.

## What

The tray menu gets **Interface web** right below **Painel**. It starts
`bethterm-web.exe` (Go + React + WebView2, workspace folder
`bethterm-web/`) from the same folder as `bethterm-gui.exe`, passing
`--bethterm <that folder>\bethterm.exe` so the web app runs the
installed `bethterm cli bridge` (patch 0171). The process is detached
and logged in `host-life.log` (`tray Interface web: started ...`).

The child gets no `WEZTERM_UNIX_SOCKET` / `WEZTERM_PANE`: inherited from
the GUI they made its bridge attach to this GUI instead of the host.

If `bethterm-web.exe` is not installed, a message box names the
missing file (shown from its own thread so the tray thread keeps
running).

## Install

Copy `bethterm-web.exe` and a `bethterm.exe` built with patch 0171 next
to `bethterm-gui.exe`. Neither is used by the host, so this does not
require stopping it.

## Files

- `wtinator/src/tray.rs` — `ID_WEB_UI`, `TrayMenuEntry::WebUi`,
  `open_web_ui`, label, menu tests

## Revert

Remove the id, the enum variant and its menu arm, `open_web_ui` and the
`WebUi` entries in the tests. Remove row 0173 and this file.
