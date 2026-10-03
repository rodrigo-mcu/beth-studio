# Patch 0004 — wezterm depends on wtinator

**Applied:** 2026-06-06
**File:** `upstream-wezterm/wezterm/Cargo.toml` (`[dependencies]`)
**Status:** Active

## What

```diff
 wezterm-term.workspace = true
+# WezTerminator local addition (see PATCHES.md patch 0003). The upstream
+# wezterm binary's `main()` calls `wtinator::install()` to initialize
+# our delta. This adds the workspace dep reference.
+wtinator.workspace = true
```

## Why

Patch 0003 adds a `wtinator::install()` call to `upstream-wezterm/wezterm/src/main.rs`.
The `wezterm` crate is a binary, so its dependencies live in
`upstream-wezterm/wezterm/Cargo.toml`. We need to declare the `wtinator`
dep so Cargo links it in.

## Revert

Remove the `wtinator.workspace = true` line from
`upstream-wezterm/wezterm/Cargo.toml`. **Do this together with patch
0003 revert**, otherwise the upstream main will fail to compile.

## Risk

None — adding a single `Cargo.toml` line.
