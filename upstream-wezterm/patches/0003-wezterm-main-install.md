# Patch 0003 — wezterm main calls wtinator::install()

**Applied:** 2026-06-06
**File:** `upstream-wezterm/wezterm/src/main.rs` (`fn main`)
**Status:** Active

## What

```diff
 fn main() {
+    // WezTerminator local patch (2026-06-06): see PATCHES.md patch 0003.
+    // Initialize the WezTerminator delta before config loads, so the
+    // `wtinator = { ... }` table is picked up by config::common_init.
+    if let Err(e) = wtinator::install() {
+        eprintln!("wtinator::install() failed: {:#}", e);
+        std::process::exit(1);
+    }
+
     config::designate_this_as_the_main_thread();
```

## Why

The upstream `wezterm` crate is a **binary** (it has a `fn main()` and
no `lib.rs`). It does not expose a library entry point we can call from
our own binary to inject behavior before the GUI starts.

`docs/ARCHITECTURE.md §"Option B"` describes the workaround: copy
`upstream-wezterm/wezterm/src/main.rs` into our `wezterminator/src/main.rs`
and modify it. We chose a smaller, less invasive alternative: **patch
the upstream main in place** to call our `wtinator::install()` hook.

The hook runs:

- **Before** `config::common_init`, so our config lua is read at the
  same time as the standard wezterm config.
- **Before** any GUI / mux / SSH state is initialized, so feature
  sidecars can be installed before the first `Mux` event.
- **Synchronously**, so a failure aborts the process with a clear
  message (`wtinator::install() failed: <context>`).

## Revert

When either:

- Wezterm upstream grows a library entry point (e.g. `pub fn run()`),
  or
- We move to the "copy main.rs into our binary" strategy (Option B
  in `docs/ARCHITECTURE.md`),

revert by replacing the `wtinator::install()` block in
`upstream-wezterm/wezterm/src/main.rs` with the original two lines
(`config::designate_this_as_the_main_thread(); config::assign_error_callback(...)`).

## Risk

Low. The hook is a single function call. Its failure is loud (process
exit 1 with the error chain). If `wtinator::install()` ever panics, the
process aborts; this is acceptable because a misconfigured WezTerminator
is a misconfigured wezterm.
