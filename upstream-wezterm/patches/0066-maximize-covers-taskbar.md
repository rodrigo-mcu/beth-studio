# Patch 0066 — A maximized window must not cover the Windows taskbar

**Status:** Implemented 2026-07-13.

## Symptom

> "a janela as vezes expande escondendo a barra de tarefas do windows"

Maximizing the terminal sometimes made it cover the whole monitor, hiding the
Windows taskbar. **Intermittent** — the same window, maximized twice, could
behave differently.

## Cause

The fork's window is a **borderless `WS_POPUP`** (the integrated titlebar,
patch 0020: `decorations_to_style`, `window.rs:433-438`). For such a window
`DefWindowProc` maximizes to the full monitor rect (`rcMonitor`) — over the
taskbar — unless the app answers `WM_GETMINMAXINFO` with the monitor's *work
area* (`rcWork`, which excludes the taskbar).

`wm_getminmaxinfo` already computed that clamp correctly. The bug was that it
**bailed out before reaching it**:

```rust
let inner = rc_from_hwnd(hwnd)?;
let inner = match inner.try_borrow() {
    Ok(inner) => inner,
    Err(_) => return None,          // <-- falls through to DefWindowProc
};
if !wtinator_uses_borderless_popup(inner.config.window_decorations) {
    return None;
}
```

It needed to borrow `WindowInner` just to read the config. `WM_GETMINMAXINFO`
can arrive while the WndProc has been **re-entered** and the borrow is already
held (the native context-menu modal loop, resize loops — the same reentrancy
this backend guards against in `wm_nccalcsize` / `wm_nchittest`, see patch
0011). The `try_borrow()` then fails, the handler returns `None`, and Windows
maximizes over the taskbar. Because it depends on timing, the symptom is
intermittent — the "às vezes".

A second, latent mismatch: the window is made `WS_POPUP` whenever the config
contains `INTEGRATED_BUTTONS`, but the clamp additionally required
`wtinator_forces_integrated_titlebar()` (`WTINATOR_ACTIVE=1` or a known exe
name). Any launch not satisfying that would be borderless *and* unclamped.

## Fix

Gate the clamp on the **real window style** instead of the borrowed config —
always readable, no borrow, no reentrancy hazard:

```rust
let style = GetWindowLongW(hwnd, GWL_STYLE);
if (style & WS_POPUP as i32) == 0 {
    return None;   // decorated window: default maximize already respects rcWork
}
// ... clamp ptMaxPosition / ptMaxSize to mi.rcWork (unchanged)
```

This makes the clamp run **every** time the window is borderless, closing both
failure modes. The `rcWork` computation itself is unchanged.

Fullscreen is unaffected: `toggle_fullscreen` (`window.rs:747-795`) sizes the
window with `SetWindowPos` to `rcMonitor`, which `MINMAXINFO.ptMaxSize` does
not constrain. Covering the taskbar in real fullscreen is the intended
behaviour.

## Files

- `window/src/os/windows/window.rs` — `wm_getminmaxinfo`

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm-gui
```

Manual: maximize / restore the window repeatedly, including right after using
the right-click context menu (the reentrancy path) — the taskbar must stay
visible every time. Fullscreen must still cover the whole screen.
