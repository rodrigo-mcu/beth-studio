# 0204 — Studio mouse for fullscreen programs, and OSC 52 copy

**Status:** Implemented 2026-11-07.

## Why

On 2026-11-07 the user could not log in to Grok over SSH: the login screen
says "click here to copy" and "Click here to show full URL", and clicking
did nothing. The bridge (`bethstudio cli bridge`, patch 0171) sends the
Studio only a picture of the screen (SGR and OSC 8). The program's DECSET
1000/1002/1003 never reached the Studio's xterm, so the xterm never
reported a click, and the Studio had no way to send one. The log had no
`link osc8:` entry: those buttons are not links.

## What

- The host already pushes `GetPaneRenderChangesResponse` (with
  `mouse_grabbed`) to every client on pane output. The bridge's unilateral
  hook (patch 0175) now keeps `mouse_grabbed` per pane.
- `screen` events carry `"mouse": B` (also part of the change hash, so a
  change alone re-sends the screen).
- On `watch`, the bridge asks `GetPaneRenderChanges` once per pane, so an
  idle pane's mouse state arrives too.
- New request `{"op":"mouse","pane_id":N,"kind":"press|release|move",
  "button":"left|middle|right|wheel_up|wheel_down|wheel_left|wheel_right|none",
  "x":X,"y":Y,"shift":B,"ctrl":B,"alt":B}` (0-based cells), sent as
  `SendMouseEvent`; the host encodes it as the program asked (X10, SGR...).
  Dropped while the pane is scrolled back (the cells are history).
- `SetClipboard` PDUs (OSC 52, clipboard selection, up to 1 MiB) become
  `{"ev":"clipboard","pane_id":N,"text":"..."}`.

Studio side (not upstream): `bethstudio-web` validates and forwards `mouse`
(`mouse.go`), sends `clipboard` only to non-phone pages watching the pane;
the frontend turns on xterm 1002+1006 while `mouse` is true and the view is
live, converts the SGR reports into `mouse` requests
(`src/lib/termMouse.ts`), and copies OSC 52 text with a "Copiado pelo
programa" notice. Ctrl+click on a link still opens the link.

## Verified

Isolated host (`BETHSTUDIO_HOST_ID=mousetest`, own APPDATA) with a WSL
Python script that turns on 1000+1006 and logs its input: the bridge
reported `mouse=true`, a left click at (4,2) arrived as `ESC[<0;5;3M` /
`ESC[<0;5;3m`, the wheel as `ESC[<65;2;2M`, and an OSC 52 write came out as
the `clipboard` event.

## Files

- `wezterm/src/cli/bridge.rs` — hook, `Mouse` request, `mouse` field,
  `Clipboard` event, `mouse_event_of` (unit-tested)
