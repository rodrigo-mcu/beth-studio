# 0135 — Warning cleanup in BethTerm files

**Status:** Implemented 2026-09-21.

## What

`cargo check -p wtinator -p wezterm-gui -p wtinator-config` printed
unused-import / unused-variable / dead-code warnings in files BethTerm
owns or patched. They hid real problems. Fixed:

- `wtinator/src/header/win32_prompt.rs` — unused Win32 imports.
- `wtinator/src/menu_icons.rs` — unused GDI imports, unused `pt`.
- `wtinator/src/notify_ipc.rs` — `BufReader`, `PROTOCOL_VERSION`.
- `wtinator/src/notify.rs` — `mux::pane::Pane` (trait methods are
  reached through `Arc<dyn Pane>`).
- `wtinator/src/image_paste.rs` — `build_osc_1337` is test-only now:
  `#[cfg_attr(not(test), allow(dead_code))]` with a comment.
- `wezterm-gui/src/main.rs` — `block_on` import.
- `wezterm-gui/src/termwindow/render/pane.rs` — needless `mut`.

Left alone (not BethTerm files, or being edited elsewhere):
`mux/src/localpane.rs:591` (`std::io::Write`),
`wezterm-gui/src/termwindow/resize.rs:177` (`mut size`),
`wtinator/src/tray.rs::stack_labels` (used by tests; the caller was
removed by patch 0125 — decide whether to delete it with its tests),
`wtinator/src/menu_icons.rs:118` (unnecessary `unsafe` — the `render`
wrapper is documented as intentionally unsafe).

## Verification

`cargo +nightly check -p wtinator -p wezterm-gui -p wtinator-config`
and `cargo +nightly test -p wtinator --lib`.

## Revert

Restore the imports; harmless.
