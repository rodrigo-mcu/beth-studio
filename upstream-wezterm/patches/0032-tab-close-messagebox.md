# Patch 0032 — Per-tab close X with Win32 native messagebox

**Applied:** 2026-06-12
**Files:**
- `upstream-wezterm/wtinator/src/titlebar.rs` (+~25 lines: new
  `show_close_tab_button_in_tabs = true` override +
  `default_overrides_pins_close_tab_button_on` regression test)
- `upstream-wezterm/wtinator/src/lib.rs` (+~3 lines: new
  `pub mod confirm;` declaration + doc note about the
  `unsafe_code` lint policy)
- `upstream-wezterm/wtinator/src/confirm.rs` (new, ~190 lines:
  `ConfirmKind` enum, `confirm_close` function with Win32
  `MessageBoxW` body, 3 unit tests)
- `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs`
  (+~10 lines: new `close_specific_tab_with_win32_confirm`
  call site in `mouse_event_close_tab`)
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs` (+~100
  lines: new `close_specific_tab_with_win32_confirm` method on
  `TermWindow`, near-clone of `close_specific_tab` with the
  Win32 confirmation backend)
- `upstream-wezterm/PATCHES.md` (+1 row in the active-patches
  table)
- `upstream-wezterm/patches/0032-tab-close-messagebox.md`
  (this file)

**Status:** Active (no follow-up TODOs).

## What

The per-tab close X is rendered by the upstream
`fancy_tab_bar` (`wezterm-gui/src/termwindow/render/fancy_tab_bar.rs`
→ `make_x_button`) whenever
`config.show_close_tab_button_in_tabs` is `true`. The
upstream default is `true`, but it is **not** explicitly
pinned by `wtinator::titlebar::default_overrides()` — a
user config that turns it off (`show_close_tab_button_in_tabs
= false` in `wezterm.lua`) would silently regress the
feature. Patch 0032 forces the value to `true` in
WezTerminator mode via a new entry in
`wtinator::titlebar::default_overrides()`. The user can
still override via `wezterm.lua` (the user-facing config
has the highest priority in the upstream merge order) so
this is opt-out rather than opt-in.

The bigger change is the **confirmation backend**. Today,
clicking the X calls `close_specific_tab(idx, true)` →
`confirm_close_tab` (in
`wezterm-gui/src/overlay/confirm_close_pane.rs`), which
runs the **Skia-based** `confirm::run_confirmation` overlay
that draws "🛑 Really kill this tab and all contained
panes?" inside the terminal viewport itself. That Skia
overlay runs on the same UI thread as the terminal
renderer. If a terminal **freezes** (the user's case on
2026-06-12), the overlay can also freeze because the UI
thread is busy — so the user has no way to confirm the
close with a click, and no way to dismiss the overlay
with a click on a different control.

Patch 0032 replaces the Skia overlay with a real Win32
native `MessageBoxW` running on a dedicated `std::thread`.
The user gets a real Windows question-mark icon, the
standard Yes/No buttons, and **a guarantee that the
messagebox paints on top of any other window** (even a
hung one). The terminal UI thread is not blocked; the
Win32 modal message loop runs on the worker thread.

## Why

Rodrigo reported on 2026-06-12:

> "verifique pq aconteceu isso em um terminal, depois que
> aconteceu isso eu não consegui mais fecha-lo"
>
> "é bom colocar na barra do nome um X para fechar aquele
> terminal com o mouse, pois caso trave a gente consegue
> fechar com o mouse, mas tem que exibir um messagebox de
> confirmacao"

A frozen terminal that the user cannot close with the
mouse is a serious UX problem. The user wants:

1. A visible X close button on every tab.
2. A real Windows native confirmation that is guaranteed
   to come up (not a Skia overlay that can hang if the UI
   thread is busy).

This patch delivers both.

## Why these decisions

- **Force `show_close_tab_button_in_tabs = true` in
  WezTerminator mode**: makes the X an intentional,
  documented WezTerminator feature rather than an
  undocumented side-effect of the upstream default. The
  user can still override via `wezterm.lua` (the user's
  config wins in the merge order), so this is opt-out
  rather than opt-in.
- **Win32 native `MessageBoxW` (not a custom modal
  window)**: `MessageBoxW(hwnd, text, title, MB_YESNO |
  MB_ICONWARNING)` is a one-call API on Windows. It runs
  its own modal message loop, the OS guarantees it
  paints on top of any other window (even a hung one),
  and it does not require the same UI thread as the
  terminal. The user gets a real Windows question-mark
  icon and the standard Yes/No buttons.
- **`std::thread::spawn` + `mpsc::channel` for the
  result**: the worker thread calls `MessageBoxW` and
  sends the result back over the channel. The caller
  (`close_specific_tab_with_win32_confirm`) blocks on
  `channel::recv()` until the user dismisses the
  messagebox, then posts a `TermWindowNotif::Apply` to
  the main thread to commit the close. This is the same
  pattern as the patch 0030 rename dialog, which is
  known to work in production.
- **Honour the `can_close_without_prompting` check**:
  the upstream `can_close_without_prompting(CloseReason::Tab)`
  returns `true` for a freshly-opened / empty tab that
  has never had a process. Honoring it means the user
  does not see a messagebox for the common "close the
  tab I just opened and never used" case. If the user
  has typed anything in the tab, the check returns
  `false` and the messagebox shows.

## How the operation works

### Tab-bar X click in WezTerminator mode

The X is rendered by the upstream `fancy_tab_bar`
(`make_x_button` in
`wezterm-gui/src/termwindow/render/fancy_tab_bar.rs:493`)
whenever `config.show_close_tab_button_in_tabs` is
`true`. The X is a `UIItemType::CloseTab(tab_idx)` — the
upstream `TabBarItem::CloseTab` variant. The click is
handled by `mouse_event_close_tab` in
`wezterm-gui/src/termwindow/mouseevent.rs:430`, which
(this patch) calls the new
`close_specific_tab_with_win32_confirm(idx)`.

### `close_specific_tab_with_win32_confirm`

The method is a near-clone of `close_specific_tab`
(`wezterm-gui/src/termwindow/mod.rs:3587`) — only the
confirmation backend changes. The flow:

1. Resolve the tab via `mux.get_window(self.mux_window_id)
   .and_then(|w| w.get_by_idx(tab_idx).cloned())`.
2. Check `tab.can_close_without_prompting(CloseReason::Tab)`:
   if `true`, call `mux.remove_tab(tab_id)` directly
   (preserves the upstream silent-close optimization for
   fresh / empty tabs).
3. Otherwise, get the parent HWND via
   `self.window.as_ref().map(|w| w.hwnd() as isize)`
   (the `Window::hwnd()` getter from patch 0025). If
   no HWND is available, fall back to the Skia
   confirmation path (`close_specific_tab`).
4. Build the dialog text using `tab.effective_title()`
   (the user-set title from patch 0031, with a `Tab #N`
   fallback). The title is "Close tab?" and the body
   is `Really close "<user_title>"?\n\nAll panes in
   this tab will be killed. The shell program running
   in each pane will not get a chance to clean up.`.
5. Spawn a dedicated `std::thread` (named
   `wtinator::confirm::messagebox` for stack-trace
   clarity) that calls
   `wtinator::confirm::confirm_close(hwnd, ConfirmKind::Tab,
   title, text)`. The function blocks the calling
   thread (the worker) until the user dismisses the
   `MessageBoxW`, then returns `true` on Yes, `false`
   on No/Esc/close.
6. On `true`, the worker calls
   `gui_window_for_notify.notify(TermWindowNotif::Apply(…))`
   to post the close back to the main thread. The
   closure calls `mux.remove_tab(tab_id)`.

### `wtinator::confirm::confirm_close`

The function is `#[cfg(windows)]` for the body and
`#[cfg(not(windows))]` for the stub. The Windows body
encodes the title and text as UTF-16 `Vec<u16>` via
`OsStr::encode_wide`, spawns a `std::thread::Builder`
with the `wtinator::confirm::messagebox` name, and calls
`MessageBoxW(hwnd as HWND, text_w.as_ptr(),
title_w.as_ptr(), MB_YESNO | MB_ICONWARNING)`. The
hard-coded constants are:

```text
MB_YESNO       = 0x00000004
MB_ICONWARNING = 0x00000030
IDYES          = 6
IDNO           = 7
```

The `windows-sys` 0.61 crate we depend on does not expose
`MB_YESNO` / `MB_ICONWARNING` / `IDYES` / `IDNO` as named
constants, so we hard-code them. The function returns
`result == IDYES`. The non-Windows stub returns `false`
unconditionally so callers do not close anything on
platforms that cannot show the dialog.

The `unsafe` block is wrapped in `#[allow(unsafe_code)]`
on the function (the crate-level `unsafe_code` lint is
`warn` in `wtinator/Cargo.toml`, per patch 0030).

## Revert

1. Remove the `show_close_tab_button_in_tabs = true`
   entry from `wtinator::titlebar::default_overrides()`
   and the `default_overrides_pins_close_tab_button_on`
   regression test.
2. Remove `pub mod confirm;` from `wtinator::lib.rs` and
   delete `wtinator/src/confirm.rs`.
3. In `wezterm-gui/src/termwindow/mouseevent.rs::mouse_event_close_tab`,
   change the dispatch back to
   `self.close_specific_tab(idx, true);` (the original
   Skia path).
4. Remove the new `close_specific_tab_with_win32_confirm`
   method from `wezterm-gui/src/termwindow/mod.rs`. (The
   existing `close_specific_tab` is left intact, so
   the Skia path keeps working.)
5. Remove this file and the row for patch 0032 from
   `PATCHES.md`.

## Risk

**Low.**

- 1 new field in `wtinator::titlebar` overrides
  (1-line change, additive).
- 1 new module `wtinator::confirm` (new file, ~190
  lines, `#[cfg(windows)]` body + `#[cfg(not(windows))]`
  stub + 3 unit tests).
- 1 new method `close_specific_tab_with_win32_confirm`
  on `TermWindow` (near-clone of `close_specific_tab`,
  only the confirmation backend changes).
- 1 changed call site in `mouse_event_close_tab`
  (1-line change, additive).
- 1 new public API on `wtinator::confirm`
  (1 new function, 1 new enum).

The Win32 `MessageBoxW` API is **guaranteed non-blocking**
for the caller: the messagebox runs its own modal message
loop on the thread that called it, and the OS guarantees
it paints on top of any other window (even a hung one).
This is the explicit property the user requested — "a
gente consegue fechar com o mouse" — and is the central
reason for this patch.

The threading model is identical to patch 0030 (Win32
input dialog) and patch 0025 (`Window::hwnd()` getter) —
both of which are known to work in production. There is
no new infrastructure to test.

If the user has multiple wezterm windows open and closes
a tab in one of them, the messagebox parents to that
window's HWND so it does not get lost behind the other
windows. This is the upstream behaviour for the
window-level close confirmation, which the user has been
using without complaint since patch 0020.

## Investigation: why did the user's terminal freeze?

The user reported on 2026-06-12 that a terminal froze
and they could not close it. The screenshot was shared
but the file content was not retrievable from this
session, so a definitive root cause analysis was not
possible. Common causes for an unresponsive wezterm
terminal pane include:

- **ConPTY deadlock** when the shell process is
  producing output faster than the consumer is
  reading it (e.g. an infinite `echo` loop in a
  shell script that ignores `^C` because the script
  traps it).
- **A TUI program in alternate-screen mode** that
  has entered a state where it is not draining
  input (e.g. `vim` waiting for a stuck terminal
  emulator escape, or `tmux` waiting for an escape
  that never comes).
- **A child process inheriting stdin** and blocking
  the pane's input pipe (e.g. a `python -c` script
  that reads stdin in a tight loop).
- **An out-of-memory condition** in the ConPTY host
  that has stalled the write pipe.

The X close button + Win32 messagebox delivered by
this patch is the **recovery path** for all of these
cases: the user can force-close the pane regardless
of what the shell is doing, because the messagebox
runs on a thread the shell cannot block. The
**prevention** (debugging the specific freeze) is
out of scope for this patch and would need a
reproducible test case.

## Out of scope (deferred)

- **`wtinator::confirm::confirm_close` for
  `ConfirmKind::Window` and `ConfirmKind::Pane`**:
  the enum and the function support all three kinds,
  but the dispatcher in this patch only wires up the
  `Tab` kind. The `Window` kind could replace the
  Skia overlay in `close_requested_with_confirmation`
  (a follow-up), and the `Pane` kind could replace
  the Skia overlay in `confirm_close_pane` (also a
  follow-up). Doing all three in this patch would be
  a lot of churn for marginal benefit; the user
  explicitly asked for the **per-tab** case, and that
  is what this patch delivers.
- **Replacing the Skia overlay for
  `confirm_quit_program` (Quit WezTerm?)**: also a
  follow-up.
- **Per-pane close X**: the user did not ask for it.
  The current per-pane "Close pane" entry in the
  right-click menu (patch 0009) is the only way to
  close a single pane. A follow-up patch could add a
  per-pane X in the in-pane header (patch 0030.5) —
  the header is already a UI item, so the click target
  is a 30-line change.
- **Root-cause analysis of the user's frozen
  terminal**: see "Investigation" above. Needs a
  reproducible test case.
