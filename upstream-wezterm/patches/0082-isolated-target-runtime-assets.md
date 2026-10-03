# Patch 0082 — Honour isolated Cargo targets for Windows runtime assets

**Applied:** 2026-08-30

## What

`wezterm-gui/build.rs` now honours `CARGO_TARGET_DIR` when copying its Windows
runtime DLLs (`conpty.dll`, ANGLE, Mesa). It also creates the profile directory
before copying.

## Why

An isolated release build must not copy files into the default `target/release`
directory, which may be an active test/deployment directory. The old hard-coded
path also made the isolated build fail when that default profile directory did
not exist.

## Files

- `wezterm-gui/build.rs`
- `PATCHES.md`

## Revert

Restore the former `repo_dir.join("target").join(profile)` output path, delete
this file, and remove the 0082 entry from `PATCHES.md`.
