# Patch 0025 - Right-click screenshot actions

## Files

- `upstream-wezterm/wtinator/src/screenshot.rs`
- `upstream-wezterm/wtinator/src/context_menu.rs`
- `upstream-wezterm/wtinator/src/lib.rs`
- `upstream-wezterm/wtinator/Cargo.toml`
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`
- `upstream-wezterm/window/src/os/windows/window.rs`

## What changed

The full right-click menu now includes a `Screenshot` submenu with two actions:

- `Save as JPEG...` (`wID = 0x5006`)
- `Copy to clipboard` (`wID = 0x5007`)

`wtinator::screenshot` captures the current Win32 window with
`PrintWindow(PW_RENDERFULLCONTENT)`, extracts a 32-bpp bitmap with `GetDIBits`,
converts BGRA pixels to RGBA, and then either:

- encodes the image as JPEG and writes it to a path chosen with
  `GetSaveFileNameW`; or
- converts the capture to a top-down 32-bpp `CF_DIB` and writes it to the
  Windows clipboard.

The menu routing uses new `DispatchAction::ScreenshotSave` and
`DispatchAction::ScreenshotCopy` variants. The handler lives in the patched
`schedule_native_menu` path in `wezterm-gui/src/termwindow/mouseevent.rs`.

Patch 0022's image paste path was hardened while completing this work and then
changed to paste a concrete file reference:

- `CF_DIBV5` detection now reads `CF_DIBV5` instead of always asking for
  `CF_DIB`.
- Clipboard DIB decoding now handles top-down and bottom-up images.
- 32-bpp BGRA and 24-bpp BGR are converted explicitly to RGBA.
- The clipboard image is encoded as PNG under
  `%TEMP%\wezterminator\clipboard-images\`.
- The pane receives a visible Markdown image link like
  `![image](C:/.../clipboard-1920x1080-....png)`.
- The menu label is now `Paste image from clipboard` for clearer discovery.

## Why

The user asked for a terminal-level screenshot feature and for image clipboard
paste to work reliably after copying a screen capture. The existing partial
`wtinator::screenshot` module was not wired into the UI and still failed to
compile. The right-click menu is already the primary mouse entry point for this
fork, so the screenshot actions belong there next to the clipboard/image
commands.

The clipboard copy action uses `CF_DIB`, not raw JPEG bytes, because `CF_DIB`
is the portable Windows clipboard image format. Many receiving applications do
not consume custom `image/jpeg` clipboard formats.

## Limitations

- The capture is Windows-only.
- The capture asks the OS for the window image. It does not render from
  wezterm's GPU framebuffer directly.
- If `PrintWindow` fails, the current fallback uses a screen `BitBlt`; this is
  best-effort and depends on the window being visible.
- The paste-image action now pastes a Markdown file reference. The receiving
  CLI still needs to support opening local file paths.

## Verification

Validated on 2026-06-07:

```powershell
cargo +nightly test -p wtinator
cargo +nightly check -p wezterm-gui
```

`cargo +nightly test -p wtinator` passed 55 tests, including new tests for:

- screenshot menu routing;
- screenshot submenu contents;
- RGBA-to-CF_DIB conversion;
- bottom-up DIB decoding for paste-image.

## Revert

1. Delete `upstream-wezterm/wtinator/src/screenshot.rs`.
2. Remove `pub mod screenshot;` from `wtinator/src/lib.rs`.
3. Remove `ScreenshotSave` / `ScreenshotCopy` from
   `wtinator/src/context_menu.rs`, including wIDs `0x5006` and `0x5007`.
4. Remove the screenshot handler arms from
   `wezterm-gui/src/termwindow/mouseevent.rs`.
5. Remove the `hwnd()` getter from `window/src/os/windows/window.rs` if no other
   patch uses it.
6. If patch 0022 should remain but without the hardening from this patch, revert
   only the `wtinator/src/image_paste.rs` changes that convert DIBs explicitly.
