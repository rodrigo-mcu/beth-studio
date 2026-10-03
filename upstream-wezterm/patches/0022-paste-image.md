# Patch 0022 — Right-click "Paste image" via OSC 1337 (iTerm2 inline image)

**Applied:** 2026-06-07
**Files:**
- `upstream-wezterm/wtinator/src/image_paste.rs` (new)
- `upstream-wezterm/wtinator/src/lib.rs`
- `upstream-wezterm/wtinator/src/menu_icons.rs`
- `upstream-wezterm/wtinator/src/context_menu.rs`
- `upstream-wezterm/wtinator/Cargo.toml`
- `upstream-wezterm/mux/src/pane.rs`
- `upstream-wezterm/mux/src/localpane.rs`
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`

**Status:** Active

## What

The right-click context menu gets a new entry, **"Paste image"**,
which reads `CF_DIB` from the Windows clipboard, encodes it to
PNG, base64-encodes it, and emits an iTerm2 inline-image escape
(OSC 1337) on the focused pane. This mirrors the behaviour of
the VSCode terminal (xterm.js-based) when the user presses
`Ctrl+V` with an image on the clipboard.

## Why the iTerm2 protocol and not an upstream KeyAssignment

The upstream `wezterm-escape-parser/src/osc.rs` already
parses OSC 1337 ("File = [args] : base64" — the iTerm2 file
upload protocol). The upstream renderer already blits the
image into the terminal at the current cursor position. We
don't need a new `KeyAssignment::PasteImage` — we can just
write the escape bytes to the PTY and let the existing
parser pick them up. Claude Code, Aider, lazygit, gitui and
any other TUI that supports the protocol receives the image
as an inline attachment.

The emitted form matches what the VSCode terminal sends:

```
ESC ] 1337 ; File = name=<safe>.png;size=<N>;width=auto;
                  height=auto;preserveAspectRatio=1;inline=1
                  : <base64> BEL
```

`inline=1` is the key — it asks the receiver to display the
image in the terminal rather than as an external attachment.

## Why a new Pane::write trait method

The upstream `Pane::send_paste(&str)` is text-only (it
canonicalises newlines and writes via the bracketed-paste
escape). It does not accept arbitrary bytes. We add a new
default-no-op `Pane::write(&[u8])` and override it in
`LocalPane` to forward to the underlying PTY writer. The
client (remote) panes keep the no-op and silently ignore
the paste — which is the right behaviour because OSC 1337
is a local-only feature.

## Why a new menu entry (and not Ctrl+V)

The upstream `KeyAssignment::PasteFrom(Clipboard)` is
text-only and is bound to `Ctrl+V` (patch 0021 added
`Ctrl+V` for non-macOS targets). Adding `Paste image` as
a third mouse-driven path keeps the keyboard shortcut
focused on text — the user explicitly asks for image paste
via the menu. `Ctrl+Shift+V` would be a natural future
binding for the same action.

## Limitations / future work

- The user has to click "Paste image" — we do not bind
  `Ctrl+Shift+V` to it (the upstream uses that combination
  for something else).
- We accept only `CF_DIB` (the older 32-bpp DIB format).
  Apps that put `CF_BITMAP` only on the clipboard would
  not be picked up. Adding `CF_BITMAP` would require
  `GetDIBits` against a `BITMAPINFOHEADER` we build
  ourselves; the work is straightforward but out of scope
  for this patch.
- We do not handle `CF_DIBV5` differently from `CF_DIB` —
  the first 40 bytes of both are a `BITMAPINFOHEADER`
  (the V5 extended fields come after). Apps that write
  only V5 fields beyond the header (e.g. ICC profiles) would
  lose those fields. The output PNG is still correct because
  the pixel data is identical.

## Revert

1. In `wtinator/src/lib.rs`, drop the `pub mod image_paste;` line.
2. Delete `wtinator/src/image_paste.rs`.
3. In `wtinator/src/menu_icons.rs`, drop the `MenuIconId::PasteImage`
   variant and the `draw_paste_image` helper, and remove
   `PasteImage` from the `all_icons_have_unique_ids` test list.
4. In `wtinator/src/context_menu.rs`:
    - Drop the `NativeCommand::PasteImage` variant.
    - Drop the `0x5005` arm from `w_id()`.
    - Drop the `DispatchAction::PasteImage` variant.
    - Drop the `0x5005` arm from `classify()`.
    - Drop the `NativeCommand::PasteImage => None` arm in
      `dispatch_native()`.
    - Drop the "Paste image" entry in `full_menu_items()`.
    - Update the count in `full_menu_includes_shells_splits_and_close`
      from 18 back to 17.
5. In `wtinator/Cargo.toml`, drop the `image`, `base64`, and
   `Win32_System_Memory` / `Win32_System_DataExchange` features.
6. In `mux/src/pane.rs`, drop the `fn write` default-no-op.
7. In `mux/src/localpane.rs`, drop the `write` impl.
8. In `wezterm-gui/src/termwindow/mouseevent.rs`, drop the
   `Some(DispatchAction::PasteImage)` arm.
9. Remove this file and the row for patch 0022 from `PATCHES.md`.

## Risk

Low. The new module reads from a clipboard the user just
had to manually copy an image to (so the act of reading is
explicit). The OSC bytes are written to the PTY only after a
successful PNG encode. We never run on a non-Windows target
(the module is `#[cfg(windows)]` and the menu item is
gated on the same cfg).

The `Pane::write` default-no-op is added to the `Pane` trait,
which is implemented by every backend (`LocalPane`,
`ClientPane`, `RemotePane`). The non-`LocalPane` impls use
the default, so the change is invisible to remote panes.
The `LocalPane` impl writes to the same PTY writer that
`send_paste` uses — so it inherits the same flush/buffer
semantics.

50/50 unit tests pass (`cargo +nightly test -p wtinator`).
`wezterm.exe` and `wezterm-gui.exe` build in debug and release
with no new warnings.
