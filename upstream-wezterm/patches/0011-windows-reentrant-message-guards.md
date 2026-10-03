# Patch 0011 - Windows reentrant message guards

**Applied:** 2026-06-06
**Documented by:** Codex gpt-5.5
**Files:**
- `upstream-wezterm/window/src/os/windows/window.rs`

**Status:** Active

## What

`WM_PAINT` and `WM_MOUSELEAVE` now use `try_borrow_mut()` when borrowing
`WindowInner`:

```rust
let Ok(mut inner) = inner.try_borrow_mut() else {
    log::warn!("wezterminator patch 0011: skipping reentrant WM_MOUSELEAVE while WindowInner is borrowed");
    return Some(0);
};
```

The guarded paths log `wezterminator patch 0011` at warning level before
returning, so a prevented panic is visible even when trace logging is
disabled.

## Why

The native Win32 popup menu used by WezTerminator runs a nested modal
loop. Windows may deliver paint or mouse-leave messages while another
window callback is still active. The previous code used `borrow_mut()`,
which panics if `WindowInner` is already mutably borrowed:

```text
panic at window\src\os\windows\window.rs:1889:27
core::cell::panic_already_borrowed
...
NtUserTrackPopupMenuEx
wtinator::context_menu::platform::show_at
```

Skipping a reentrant paint or mouse-leave notification is preferable to
closing the GUI. The next normal paint or mouse event will refresh the
state.

This patch complements patch 0010. Patch 0010 opens the native menu only
after the current mouse callback returns, but the Win32 menu loop itself can
still re-enter `WndProc`. These guards make those reentrant messages
non-fatal.

## Revert

Replace the two `try_borrow_mut()` guards with the original
`inner.borrow_mut()` calls in `wm_paint` and `mouse_leave`.

## Risk

Low to medium. This changes core Win32 window behavior, but only in a
state that previously panicked. A skipped reentrant paint may delay a
repaint until the next invalidation; a skipped reentrant mouse-leave may
leave hover state stale briefly. Both are less severe than closing the
application.
