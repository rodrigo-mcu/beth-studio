# 0088 — Product rename to BethTerm

## Why

The public product name is BethTerm (named for Elizabeth). WezTerminator
was a working title and collided with the WezTerm brand more than we want
for an independent open-source fork.

## What changed

- Detect BethTerm mode from `BETHTERM_ACTIVE` as well as `WTINATOR_ACTIVE`.
- Treat `bethterm.exe` / `bethterm-gui.exe` like `wezterminator.exe` in
  executable-name detection (`tabbar.rs`, `fancy_tab_bar.rs`,
  `window/src/os/windows/window.rs`).
- Store runtime data under `%APPDATA%\bethterm` (or `~/.config/bethterm`).
  If only the legacy `wezterminator` directory exists, rename it on first
  access.
- Settings app window title and brand string: BethTerm.
- Workspace package `bethterm` (path still `wezterminator/`) replaces the
  `wezterminator` package name.
- Public docs, launchers, and installer use the new name.

## What did not change

- The delta crate is still `wtinator`.
- The Lua table is still `config.wtinator`.
- Historical patch notes still say WezTerminator.
- The shipped GUI binary is still the patched `wezterm-gui.exe`.

## Revert

Restore the previous env-only `WTINATOR_ACTIVE` checks, the
`wezterminator` data directory, and the WezTerminator UI strings.
