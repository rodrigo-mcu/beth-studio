# Patch 0085 — Named physical windows

**Applied:** 2026-09-05

## What

Physical WezTerminator windows can be given a sticky user-chosen name, so
"Move tab to" destinations, the taskbar and Alt+Tab are distinguishable.

- `mux::window::Window` gains `user_title`, independent of the auto/OSC title.
- Right-click **Rename window…** opens the existing Win32 input dialog
  (`Nome da janela`).
- **Move tab to → New window…** asks for a name before creating the window.
  Cancel aborts the move; empty input still creates an unnamed window.
- Dragging a tab out of the strip also prompts for a name after the new
  window is created. Cancel leaves that window unnamed.
- The destination submenu shows the user name when one is set; unnamed
  windows keep the previous `Window N — title` fallback.
- Session schema version 9 records `windows[].user_title`. Version 8 and
  older files load as unnamed windows.

## Files

- `mux/src/window.rs`
- `wtinator/src/header/mod.rs`
- `wtinator/src/header/win32_prompt.rs`
- `wtinator/src/context_menu.rs`
- `wtinator/src/session.rs`
- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/src/termwindow/mouseevent.rs`
- `wezterm-gui/src/termwindow/session_restore.rs`
- `PATCHES.md`

## Verification

```powershell
$env:PATH='C:\Strawberry\perl\bin;C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64;' + $env:PATH
cargo +nightly test -p wtinator
cargo +nightly check -p wezterm-gui
```

Manual: right-click a tab → Rename window… and confirm the name appears in
Move tab to. Move a tab to New window…, type a name, and confirm the new
window shows that name in the destination list of the other window.

## Revert

Undo the listed changes, delete this file, and remove the 0085 entry from
`PATCHES.md`.
