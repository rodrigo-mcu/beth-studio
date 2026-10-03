# 0155 — Choose GPU or CPU drawing

**Status:** Implemented 2026-09-23.

## What

The tray menu **Desenho** offers **GPU (placa de vídeo)** and **CPU**.
GPU is OpenGL on the graphics card (the default). CPU sets
`front_end = Software`, which loads Mesa's `opengl32.dll` from the
`mesa` folder next to `bethterm-gui.exe` and draws on the CPU.

The OpenGL context is created with the window, so picking the other
mode saves `%APPDATA%\bethterm\render-mode` and restarts only the
interface. The host and the shells stay. The next start applies the
file before the first window.

## Files

- `wtinator/src/render_mode.rs` (new), `wtinator/src/lib.rs`, `wtinator/src/tray.rs`
- `wezterm-gui/src/main.rs`

## Revert

Remove the module, the menu entry and the `apply()` call. Remove row
0155 and this file.
