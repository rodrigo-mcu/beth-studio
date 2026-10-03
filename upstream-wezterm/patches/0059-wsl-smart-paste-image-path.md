# Patch 0059 — Smart paste: rewrite the pasted image path to WSL2 `/mnt`

**Status:** Implemented 2026-06-22.

## Symptom

> "tem que fazer um colar mais inteligente qdo estiver colando por exemplo no
> wsl2 e a imagem estiver vindo do windows, ajustar automaticamente os caminhos"

When pasting a Windows-clipboard image into a pane running a **WSL2** shell, the
image-paste feature (patches 0022/0025) saves the PNG to a Windows temp dir
(`C:\tmp\wezterminator\...` or `%TEMP%\...`) and types a Markdown link holding
the **Windows** path, e.g. `![image](C:/tmp/wezterminator/clipboard-images/…png)`.
A program running inside WSL2 (e.g. Claude Code) cannot open that path.

## Fix (scope: image paste only)

In `wtinator/src/image_paste.rs`:

- **`windows_path_to_wsl_mount()`** — `C:/…` / `C:\…` → `/mnt/c/…` (drive letter
  lowercased; assumes the default `/mnt` automount root). Non-drive paths pass
  through (with backslashes normalised).
- **`pane_is_wsl()`** — true when **either** the pane's domain is a wezterm WSL
  domain (`domain_name()` starts with `"WSL:"`) **or** the foreground process is
  `wsl.exe` (covers running `wsl` in a plain local pane). Combined detection was
  chosen because the user may launch WSL either way.
- **`markdown_image_link(path, wsl)`** — converts the path when `wsl` is true;
  `paste_image_to_pane()` passes `pane_is_wsl(pane)`.

Only the generated **image path** is rewritten. Ordinary pasted text is left
untouched — converting arbitrary clipboard text would risk mangling legitimate
content. A general, opt-in Windows→WSL text-paste conversion can be added later.

## Files

- `wtinator/src/image_paste.rs`

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly test -p wtinator      # markdown_image_link_rewrites_wsl_paths,
                                     # windows_path_to_wsl_mount_maps_drive_letters
cargo +nightly build --release -p wezterm -p wezterm-gui
```

Manual: in a WSL2 pane, paste a Windows-clipboard image → the typed link is
`![image](/mnt/c/…)`. In a normal Windows pane it stays `![image](C:/…)`.

## Notes

- Assumes the default `/mnt` automount root. If a user remaps automount via
  `wsl.conf` (`[automount] root=/`), the prefix would differ; we could shell out
  to `wslpath -a -u` for exactness later, at the cost of a process spawn per
  paste.
- Foreground-process detection matches `wsl.exe`; distro-specific launchers
  (`ubuntu.exe`, `debian.exe`) are covered only when launched via a wezterm WSL
  domain. Extend the name match if needed.
