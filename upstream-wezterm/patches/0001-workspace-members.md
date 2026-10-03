# Patch 0001 — Workspace members and dependencies

**Applied:** 2026-06-06
**Files:**
- `upstream-wezterm/Cargo.toml` (`[workspace.members]`)
- `upstream-wezterm/Cargo.toml` (`[workspace.dependencies]`)

**Status:** Active

## What

```diff
 [workspace.members]
+  # WezTerminator local additions (see upstream-wezterm/PATCHES.md
+  # patch 0001). These two members are our delta crates; everything
+  # else in this list is unmodified from upstream.
+  "wtinator",
+  "wezterminator",
```

```diff
 zvariant = "4.0"
+
+# WezTerminator local additions (see PATCHES.md patch 0001). These
+# are referenced by the `wtinator` and `wezterminator` crates via
+# `xxx.workspace = true`. We add them to the upstream workspace's
+# [workspace.dependencies] table so that our crates can inherit them.
+# The upstream code itself does not use these entries.
+wtinator = { path = "wtinator" }
+wezterminator = { path = "wezterminator" }
```

## Why

The "vendor + delta" strategy (see `docs/ARCHITECTURE.md §"Strategy"`)
requires our `wtinator` crate to depend on upstream wezterm's **public**
crates (`mux`, `config`, etc.). Two issues block that:

1. Cargo workspaces are not nestable. If our root `Cargo.toml` declares
   a workspace, the upstream's own `[workspace]` block is ignored.
2. Upstream's `xxx.workspace = true` references resolve to the **parent
   workspace** of the crate. If the parent workspace is ours, it must
   mirror all of upstream's `[workspace.dependencies]`.

The cleanest workaround (Option C in `docs/IMPLEMENTATION.md` Phase 0
Findings §2) is to **make the upstream itself the workspace root** by
adding our two crates to its `[workspace.members]` list. The upstream
code never looks at those members, so it is unaffected.

The `wtinator` and `wezterminator` directories live **inside**
`upstream-wezterm/` (not as siblings). This is required by Cargo: a
workspace member must be reachable as a subdirectory of the workspace
root. See `docs/PROJECT_LAYOUT.md` for the rationale of "the only places
we add new files" (i.e. inside the upstream tree, not modifying upstream
files).

## Revert

To revert:

1. Remove the two `wtinator` and `wezterminator` lines from
   `[workspace.members]` in `upstream-wezterm/Cargo.toml`.
2. Remove the corresponding lines from `[workspace.dependencies]`.
3. Move `upstream-wezterm/wtinator/` and `upstream-wezterm/wezterminator/`
   back to `wezterminator/` at the repo root (if the rest of the project
   has been adjusted to expect them there).
4. Reinstate the `Cargo.toml` at the repo root, with the
   `[workspace.members] = ["wtinator", "wezterminator"]` it had before
   the restructure.

## Risk

Low. The two added members are inert from upstream's perspective.
