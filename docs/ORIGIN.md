# Origin: based on WezTerm

**Beth Studio started as a fork of [WezTerm](https://github.com/wezterm/wezterm).**
That fact is part of the project identity. Do not drop it from the README,
LICENSE, NOTICE, About text, or release notes.

## What that means

| Layer | Source |
| --- | --- |
| GPU renderer, PTY, tabs, splits, multiplexer, SSH, `wezterm.lua` | WezTerm (vendored in `upstream-wezterm/`) |
| Mouse-first Windows UI (native menus, drag-drop dock, per-pane theme/font, session restore, Settings app) | Beth Studio (`wtinator`, `wtinator-config`, documented patches) |

WezTerm already has tabs and splits. The gap is the default UX: keyboard and Lua first, not mouse-first on Windows.

The shipped binaries are `bethstudio.exe` and `bethterm-gui.exe`: patched
WezTerm CLI/GUI under Beth Studio names. The engine is still WezTerm.

## Where this is recorded (keep all of these)

| File | Role |
| --- | --- |
| [`NOTICE.md`](../NOTICE.md) | Canonical attribution. Ship this with source and binaries. |
| [`LICENSE.md`](../LICENSE.md) | MIT text + Wez Furlong copyright + “derivative work of WezTerm”. |
| [`upstream-wezterm/LICENSE.md`](../upstream-wezterm/LICENSE.md) | Unmodified upstream MIT license. |
| [`README.md`](../README.md) | First-screen explanation for humans. |
| [`upstream-wezterm/PATCHES.md`](../upstream-wezterm/PATCHES.md) | Every change to existing WezTerm files. |
| This file | Policy: do not omit the origin. |

## Rules for later changes

1. The README must say, in the first screenful, that Beth Studio is based on WezTerm.
2. Binary distributions must include `LICENSE.md`, `NOTICE.md`, and
   `upstream-wezterm/LICENSE.md`.
3. Do not rephrase the project as a from-scratch terminal. It is a fork with a
   large delta.
4. Credit Wez Furlong and WezTerm contributors in Acknowledgements.
5. Do not imply WezTerm endorsement. Independent fork, based on their code.
6. New contributors add Beth Studio work in `wtinator/` when possible; edits to
   existing WezTerm files go through `PATCHES.md`.

## Upstream

- Source: https://github.com/wezterm/wezterm
- Docs: https://wezterm.org/
- License: MIT
