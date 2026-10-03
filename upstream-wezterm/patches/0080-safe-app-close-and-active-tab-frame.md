# Patch 0080 — Safer whole-application close and stronger active-tab frame

**Applied:** 2026-08-30

## What

- Every WezTerminator application-close path (the integrated title-bar X,
  Alt+F4, and the operating-system close request) now uses the native close
  confirmation flow.
- The destructive **Yes** button is not shown until a three-second cooling-off
  period has elapsed. Selecting Yes then opens an explicit final confirmation;
  closing the application requires **Yes** in both dialogs.
- Duplicate close clicks while that flow is pending are ignored.
- The active tab now has a two-pixel frame in its foreground colour in the
  fancy integrated tab bar, providing a dependable high-contrast boundary when
  many tabs are open. Non-WezTerminator rendering is unchanged.

## Files

- `wtinator/src/confirm.rs`
- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/src/termwindow/render/fancy_tab_bar.rs`
- `PATCHES.md`

## Why

A title-bar X can otherwise kill every terminal process from a single accidental
click. The delay prevents an immediate reflexive confirmation and the second
question makes the final action intentional. The previous active-tab treatment
could merge into adjacent tabs under several colour themes, making it too easy
to act in the wrong tab.

## Verification

```powershell
$env:PATH='C:\Strawberry\perl\bin;C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64;' + $env:PATH
cargo +nightly check -p wezterm-gui
cargo +nightly test -p wtinator
```

Manual: click the application X and verify no Yes is presented for three
seconds, then choose Yes twice. Choose No at either step and confirm the window
remains open. Repeat via Alt+F4. Open a dense tab strip and confirm the active
tab's two-pixel contrasting frame remains visible.

## Revert

Remove the local changes listed above, delete this file, and remove the 0080
entry from `PATCHES.md`.
