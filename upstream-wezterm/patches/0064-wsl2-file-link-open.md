# Patch 0064 — Open file links from a WSL2 pane correctly (Ctrl+click → Explorer/editor)

**Status:** Implemented 2026-06-22.

## Symptom

> "e os arquivos com link no WSL2? ... qdo clicar com o CTRL + mouse esquerdo,
> o wsl2 fica montado no driver A"

Ctrl+clicking a file-path link inside a **WSL2** pane opened the wrong thing /
made Windows mount something odd, instead of opening the file.

## Cause (`wtinator/src/file_link.rs`)

1. `parse_file_uri` stripped `file:///` and then mangled `/` → `\` on Windows,
   turning a Unix path `/home/user/x` into `\home\user\x` (and losing the
   leading slash).
2. `try_wsl_path` built a **malformed UNC** `\\wsl$Ubuntu\…` — missing the `\`
   after `$` (should be `\\wsl$\Ubuntu\…` / `\\wsl.localhost\Ubuntu\…`). That
   malformed path is what made Windows misbehave (the "drive A" symptom).
3. No `/mnt/c/…` → `C:\…` conversion for Windows files reached from WSL.
4. `open_file_link` had **no pane context**, so it couldn't tell a WSL pane from
   a Windows pane and apply the right conversion.
5. The distro was read from `wsl.exe -l -q` as **UTF-8**, but `wsl.exe` emits
   **UTF-16LE** → garbage distro name.

## Fix

- **`wtinator/src/wsl.rs`** (new shared module): `pane_is_wsl` (moved here from
  `image_paste`, patch 0059), `distro_for_pane` (from a `WSL:<distro>` domain
  name, else `wsl.exe -l -q` decoded as **UTF-16LE**), and `unix_path_to_windows`:
  `/mnt/<drive>/…` → `<DRIVE>:\…`; any other absolute path →
  `\\wsl.localhost\<distro>\…`. Unit-tested.
- **`file_link.rs`**: `open_file_link(uri, pane_id)` resolves the pane;
  `parse_file_uri` now returns the **raw** path (un-mangled, correct leading
  slash); `to_native_path` converts a Unix path via `wtinator::wsl` **only when
  the pane is WSL**, otherwise just normalises slashes. The buggy `try_wsl_path`
  is removed.
- **`image_paste.rs`**: now calls `crate::wsl::pane_is_wsl` (its own
  Windows→`/mnt` converter for the paste direction stays).
- **`wezterm-gui/src/termwindow/mod.rs`**: `do_open_link_at_mouse_cursor` threads
  the `pane_id` through to `open_file_link`.

## Files

- `wtinator/src/wsl.rs` (new), `wtinator/src/file_link.rs`,
  `wtinator/src/image_paste.rs`, `wtinator/src/lib.rs`,
  `wezterm-gui/src/termwindow/mod.rs`.

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly test -p wtinator      # wsl::tests + file_link tests (138 pass)
cargo +nightly build --release -p wezterm-gui
```

Manual: in a WSL2 pane, Ctrl+click a file-path link — `/mnt/c/Users/x` opens
`C:\Users\x`; `/home/user/x` opens via `\\wsl.localhost\<distro>\home\user\x`.

## Notes

- Assumes the default `/mnt` automount; `\\wsl.localhost\` (Win11) and `\\wsl$\`
  both resolve in Explorer. If the distro can't be determined, falls back to a
  slash-normalised path.
- Patch 0058 made link-open require **Ctrl+click**, so this is the Ctrl+click
  path.
