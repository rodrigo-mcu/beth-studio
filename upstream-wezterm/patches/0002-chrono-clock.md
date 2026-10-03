# Patch 0002 — chrono clock feature

**Applied:** 2026-06-06
**File:** `upstream-wezterm/Cargo.toml` (`[workspace.dependencies]`)
**Status:** Active

## What

```diff
-chrono = {version="0.4", default-features=false, features=["unstable-locales", "serde"]}
+chrono = {version="0.4", default-features=false, features=["unstable-locales", "serde", "clock"]}
```

## Why

`mux/src/client.rs` calls `Utc::now()` at line 69, but the upstream
pin for `chrono` disables default features and only enables
`unstable-locales` and `serde`. The `clock` feature is required for
`Utc::now()` to be available. This is an upstream build bug that
manifests on stable 1.84 + nightly 2026-06-05 toolchains.

## Revert

When upstream fixes the `chrono` features in
`upstream-wezterm/Cargo.toml`, revert by removing `, "clock"` from the
features list. (Upstream's own fix is to add the `clock` feature, so
the line stays the same; we just stop carrying the patch ourselves.)

## Risk

None — the patch adds a feature; it does not remove one.
