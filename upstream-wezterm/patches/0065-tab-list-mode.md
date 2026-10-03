# Patch 0065 — Per-tab pane-tab bar / "list mode" [ON HOLD — DOES NOT WORK]

**Status (2026-06-22): ON HOLD — does NOT work acceptably; the user stopped
using it ("não funciona nao, ficou tudo bagunçado, não vou usar por enquanto").**
It compiles + release-builds (last green build 21:10) but the UX is broken in
practice. Saved on the checkpoint branch (see the commit). Do NOT recommend or
enable it until it is reworked from scratch.

### What was tried, and why each was rejected (read before retrying!)
The design pivoted many times on live feedback — every version was built + tested:
1. **Left vertical rail + 1–2 panes side by side (slots).** Rejected: "esse
   estilo de tab é ruim de manipular."
2. **Horizontal sub-tab strip below the top bar, 1-up** (click a chip → that
   pane fills the area). Rejected: the strip OVERLAPPED the terminal, splitting
   looked like it "created a new tab," and the style looked nothing like the
   real tab bar.
3. **Native splits + strip overlay + zoom-on-click.** Rejected: still covered
   content / splits messy.
4. **Proper space reservation** (`resize.rs` + `render/pane.rs` subtract
   `pane_strip_pixel_height()` so the strip reserves its own height; tab-bar-
   height styling; `apply_dimensions` re-run on toggle; split unzooms in list
   mode). STILL rejected: "ficou tudo bagunçado." **User stopped here.**

### Current behavior (last build 21:10, what is on disk)
- `list_mode` per-tab flag (`mux/src/tab.rs`). Toggle: right-click menu "Toggle
  list mode" (wID 0x6500) or `Ctrl+Shift+L`.
- Horizontal pane-tab strip below the top tab bar; reserves its own height via
  `TermWindow::pane_strip_pixel_height()` (consumed by `resize.rs` +
  `render/pane.rs`). Renderer: `render/sidebar.rs::paint_pane_tabs`.
- Left-click chip → zoom that pane; click again → unzoom. Right-click chip →
  the existing native context menu for that pane. "+" chip → split.
- `SplitHorizontal`/`SplitVertical` un-zoom in list mode (`mod.rs`).

### Strong recommendation for any future attempt
Do NOT keep iterating on the custom second bar. The likely-correct model is
**sub-tabs = real wezterm TABS grouped by project (reuse the existing `group`
feature, patch 0028)**: the top bar shows the active group's tabs (each a full
split tree → splits work natively + look right + reserve space automatically),
"+" makes a new tab in the group, switching groups = switching project. This
reuses the entire existing tab bar (look, space-reservation, hit-testing,
splits) instead of a fragile hand-rolled strip. See [[tab-list-mode-feature]].

---

_Below is the ORIGINAL (now historical) design from the `tab-terminal-sidebar-design`
workflow — kept for reference only._

## Goal

A tab can toggle **list mode**: a left rail (~180px) lists all the tab's panes
by name; the main area shows a chosen subset of **1–2 panes side by side**;
clicking a rail entry loads that pane into the focused slot. Use case: 4 Claude
Code terminals in one project tab, see 2 at a time, switch via the rail. Rail
entries blink the patch-0063 attention dot so you see which terminal is waiting.

## Binding design decisions (resolved across the 4 design slices)

1. State lives on mux `TabInner` (single source of truth); the GUI reads live via
   `tab.list_*()` each paint — no duplicate GUI-side state.
2. Slot identity **live = `PaneId`** (`list_slots: Vec<PaneId>`); **persisted =
   `header_text`** string (PaneId is reassigned on respawn).
3. `slot_count` 1..=2 (`LIST_MODE_MAX_SLOTS = 2`), default 2.
4. Rail attention dot = per-pane `PaneState.bell_start` (now `pub`).
5. Zoom **wins** over list mode (gate the list-mode render on `!tab.is_zoomed()`).
6. Focus-sync: `active` == the focused slot's pane, enforced in the mux mutators.

## File checklist

- [x] **File 1** `mux/src/tab.rs` — state + accessors + `reconcile_list_slots` +
  focus-sync (DONE, compiles). *Deferred:* reconcile hooks in
  `remove_pane_if`/`split_and_insert`/`sync_with_pane_tree` (the GUI filters to
  live panes via `list_visible_panes`, so close/spawn degrade gracefully).
- [x] **File 2** `config/src/keyassignment.rs` — `ToggleListMode`,
  `SetListSlots(u8)`, `ActivateListSlotPane(usize)` (DONE).
- [x] **File 9** `wezterm-gui/.../termwindow/mod.rs:212` — `bell_start` → `pub`
  (DONE).
- [ ] **File 3** `wezterm-gui/.../termwindow/mod.rs` — `is_list_mode_active`,
  `list_mode_positioned_panes` (custom 1–2 subset with rail offset rects), the
  branch in `get_pos_panes_for_tab` (~4440, gate `!is_zoomed`),
  `reconcile_list_mode_sizes` (PTY resize, `scale*ratio` like `toggle_zoom`), and
  the `UIItemType::{RailEntry{pane_id,ordinal}, RailAddPane(TabId),
  ListModeToggle(TabId), ListSlotsToggle(TabId)}` variants (~mod.rs:168).
- [ ] **File 5** `wezterm-gui/.../render/pane.rs` (or new `render/sidebar.rs`) —
  `paint_sidebar`: rail bg, per-pane rows (header-text labels, slotted highlight,
  focused left-bar, `bell_start` blink dot), clickable `UIItem`s.
- [ ] **File 4** `wezterm-gui/.../render/paint.rs` — call `paint_sidebar` after
  the pane loop; suppress split dividers in list mode.
- [ ] **File 6** `mouseevent.rs` — dispatch `RailEntry` → `load_pane_into_slot`
  (focused slot), the toggles; add the 4 variants to the
  `leave_ui_item`/`enter_ui_item` no-op arms (exhaustiveness).
- [ ] **File 7** `mod.rs perform_key_assignment` — handlers for the 3 new
  assignments; default `Alt+1..9 → ActivateListSlotPane`.
- [ ] **File 8** `wtinator/src/context_menu.rs` — right-click "Toggle list mode"
  (`wID 0x6500`).
- [ ] **File 10** `wtinator/src/session.rs` — persist `list_mode` /
  `list_slot_count` / `list_visible` (header names); `SESSION_VERSION` 7→8.
- [ ] **File 11** `session_restore.rs` — restore **after** the header_text loop
  (`set_list_from_names` then `set_list_mode`).

## 3 risks (from the adversarial review) + de-risk

1. **reconcile reentrancy / panic:** only call `reconcile_list_slots` at mutation
   *tails* (never mid cursor-walk, where `self.pane` is `None`);
   `debug_assert!(self.pane.is_some())` guards it.
2. **PTY resize thrash / infinite loop:** the change-guard must compare the
   *same rounded* `cols`/`viewport_rows` that `pane.resize` stores (idempotent —
   second call is a no-op); drive `reconcile_list_mode_sizes` only from genuine
   geometry-change events, NOT from every `TabResized`/`WindowInvalidated`.
3. **restore identity by `header_text` (non-unique):** enforce the ordering
   (resolve names AFTER headers are applied), de-dupe first-match, deterministic
   topological back-fill.

## Build order

File 1 → 2 → 9 (done) → 3,5,4 (render) → 6,7 (input) → 8 (menu) → 10,11
(persistence). Each group compiles before the next.

**Minimal testable MVP:** render (3,4,5) + the `ToggleListMode` key handler (7) +
the `RailEntry` click (6) → the user can toggle list mode, see the 2-up layout,
and click the rail to switch.
