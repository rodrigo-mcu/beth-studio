# Upstream (WezTerm): base, policy, and how to compare

BethTerm is a derivative work of [WezTerm](https://github.com/wezterm/wezterm)
(MIT). This page says exactly which WezTerm it was taken from, what differs,
and how to keep or move that base. Attribution and license text are in
[`NOTICE.md`](../NOTICE.md) and [`LICENSE.md`](../LICENSE.md).

## Base

| | |
| --- | --- |
| Repository | https://github.com/wez/wezterm.git |
| Commit | `05c5c9cc15e7bc195cd1938fdc7ba2f7dad26590` |
| Commit date | 2026-06-06 |
| Subject | `docs: changelog for #7137 & #7710` |

The same data is in [`upstream-wezterm/UPSTREAM_BASE`](../upstream-wezterm/UPSTREAM_BASE).

## What this repository contains

The whole WezTerm tree is **vendored** in [`upstream-wezterm/`](../upstream-wezterm/),
including the C libraries it builds (freetype2, libpng, zlib, harfbuzz) as plain
files. **You do not need the upstream repository to build or run BethTerm.**
There is no submodule and no nested `.git`.

What differs from the base is recorded three ways:

| File | What it holds |
| --- | --- |
| [`upstream-wezterm/UPSTREAM_DIFF.patch`](../upstream-wezterm/UPSTREAM_DIFF.patch) | The exact diff, against the base, of the **50 existing WezTerm files** that were changed (about 10,000 lines). It applies cleanly to the base. |
| [`upstream-wezterm/UPSTREAM_ADDED.txt`](../upstream-wezterm/UPSTREAM_ADDED.txt) | The **83 files that do not exist upstream** (mostly `wtinator/`, `wtinator-config/`, `bethterm-setup/`). They never conflict with upstream. |
| [`upstream-wezterm/PATCHES.md`](../upstream-wezterm/PATCHES.md) | The reason for every change, one numbered note per patch in [`upstream-wezterm/patches/`](../upstream-wezterm/patches/). |

Left out of the diff on purpose: `Cargo.lock` (dependency churn), the binary
files under `assets/` (icons, the bundled `OpenConsole.exe` and `conpty.dll`),
and the local build setting `.cargo/config.toml`.

Two things from the base are **not** in this tree: the macOS `*.dylib` files
(unused on Windows) and upstream's own `.cargo/config.toml` (MinGW linker
settings, unused with MSVC). Everything needed to build on Windows is here,
including the ANGLE and Mesa DLLs under `upstream-wezterm/assets/windows/`.

Most of the change is concentrated in a few files:
`wezterm-gui/src/termwindow/mod.rs`, `mouseevent.rs`, `render/pane.rs`,
`mux/src/tab.rs`, `mux/src/localpane.rs`, `window/src/os/windows/window.rs`, and
`wezterm-gui/src/main.rs`.

## Policy: the base is frozen

BethTerm does **not** track WezTerm. The vendored tree stays at the base commit
above. We port a fix from upstream by hand only when it matters (security, or a
bug that affects BethTerm). Reasons: the delta is large in a handful of GUI
files, and the main interface (Beth Studio) does not depend on them.

To port one upstream fix:

1. Clone https://github.com/wez/wezterm and look at the upstream commit.
2. Apply the same change to the matching file in `upstream-wezterm/`.
3. If the file is in `UPSTREAM_DIFF.patch`, check that your edit does not collide with a BethTerm hunk.
4. Record it as a numbered patch in `PATCHES.md`, as for any other edit.

## If you want to move to a newer WezTerm later

```sh
git clone https://github.com/wez/wezterm.git wezterm-base
cd wezterm-base
git checkout 05c5c9cc15e7bc195cd1938fdc7ba2f7dad26590
git checkout -b bethterm
git apply --whitespace=nowarn /path/to/beth-studio/upstream-wezterm/UPSTREAM_DIFF.patch
# copy the files listed in UPSTREAM_ADDED.txt, then:
git add -A && git commit -m "BethTerm delta"
git rebase origin/main        # resolve conflicts, mostly in the files named above
```

Expect real conflicts in the GUI files. That is the cost the freeze avoids.

## Files that came from this process

- `upstream-wezterm/UPSTREAM_BASE`, `UPSTREAM_DIFF.patch`, `UPSTREAM_ADDED.txt`: generated against the base above.
- To regenerate the diff, run `git diff HEAD -- . ':!Cargo.lock' ':!assets' ':!.cargo'` in a WezTerm clone at the base commit that has the BethTerm files applied.
