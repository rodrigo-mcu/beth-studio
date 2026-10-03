# Patch 0063 — Blinking tab attention on the bell (no-hook "Claude is waiting")

**Status:** Implemented 2026-06-22. Builds on patch 0061.

## Goal

Light up a tab with a **blinking** dot when a pane needs the user — and make it
work **without any Claude Code hook**.

## How (no hook)

Claude Code's setting **`preferredNotifChannel: "terminal_bell"`** makes Claude
ring the terminal bell when it is waiting (idle for the next prompt, or a
permission prompt). The bell is emitted on Claude's own stdout, so it reaches
wezterminator **natively** — no hook, no `CONOUT$` write (which is what patch
0061's hook path needed). wezterminator turns that bell into a blinking tab dot.
It also works for any other program that rings the bell.

## Change (`wezterm-gui`)

- `TermWindow` gains `tab_bell_attention: RefCell<HashMap<TabId, Instant>>` (tab
  → when it rang) and `bell_blink_running: Arc<AtomicBool>`.
- **Bell handler** (`Alert::Bell`): resolve pane → tab via `mux.resolve_pane_id`,
  flag the tab (`or_insert_with` keeps the blink phase stable across repeated
  bells), arm the blink loop, `update_title()`.
- **Blink loop**: a ~400 ms `smol::Timer` loop posts `TermWindowNotif::Apply` →
  `tick_bell_blink` → `update_title()` while any tab needs attention; it
  self-stops when none do. It runs **regardless of window focus** (the alert
  matters most when the user is looking elsewhere, where the focus-gated
  animation scheduler would not fire).
- **`get_tab_information`**: clears a tab's attention once it is **active and the
  window is focused** (the user is looking at it); otherwise computes
  `needs_attention` and a 400 ms on/off `attention_blink` phase, passed on
  `TabInformation`.
- **`compute_tab_title`** (`tabbar.rs`): renders a blinking **red ●** when
  `needs_attention`, reserving the same width in the off phase so the title
  doesn't jump. It sits next to the patch-0061 yellow `claude_status` dot.

## Files

- `wezterm-gui/src/termwindow/mod.rs`
- `wezterm-gui/src/tabbar.rs`
- (config) `~/.claude/settings.json` gains `"preferredNotifChannel": "terminal_bell"`.

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly check -p wezterm-gui
cargo +nightly build --release -p wezterm -p wezterm-gui
```

Manual: in a **non-focused** tab, ring the bell — `printf '\a'` (bash) or let
Claude finish a turn — and the tab blinks a red ●. Switch to / focus that tab
and it clears. A tab that is already active+focused never shows it.

## Notes

- Blink rate ~1.25 Hz (400 ms on / 400 ms off). Red, to distinguish from the
  yellow OSC-user-var dot (patch 0061).
- The bell fires for "needs you" in general (idle wait or permission), which is
  exactly the target state. It is not Claude-specific — any bell counts.
