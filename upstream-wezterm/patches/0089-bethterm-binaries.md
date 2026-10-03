# 0089 — Ship bethterm.exe and bethterm-gui.exe

## Why

The product is BethTerm. Shipping `wezterm-gui.exe` made the fork look like
an unofficial WezTerm build. The only hard coupling was `wezterm.exe`
looking up `wezterm-gui.exe` by filename.

## What changed

- `wezterm` crate: `[[bin]] name = "bethterm"` (`autobins = false`).
- `wezterm-gui` crate: `[[bin]] name = "bethterm-gui"` (`autobins = false`).
- Cargo package names are unchanged (`-p wezterm` / `-p wezterm-gui`).
- `delegate_to_gui` prefers `bethterm-gui(.exe)`, then `wezterm-gui(.exe)`.
- Windows VERSIONINFO ProductName / FileDescription say BethTerm, based on
  WezTerm.
- App menu About item: `BethTerm (based on WezTerm …)`. Quit / overlay
  copy say BethTerm. PTY `TERM_PROGRAM=WezTerm` is unchanged so apps still
  detect the engine.

## Revert

Remove the `[[bin]]` overrides and restore the `wezterm-gui` filename in
`delegate_to_gui` and the VERSIONINFO strings.
