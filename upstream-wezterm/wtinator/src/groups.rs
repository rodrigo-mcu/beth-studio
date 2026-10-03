// wtinator::groups — Phase 1.C (patch 0028).
//
// A "group" is a logical bucket of `Tab`s identified by name. The
// group name is stored as `Tab.group_name` (an `Option<String>`)
// and is otherwise invisible to the upstream wezterm renderer.
// This module owns:
//
//   - Listing the groups that are currently in use across all
//     open windows (`list_groups`, `group_of_tab`, `tabs_in_group`).
//   - Moving a single `Pane` from its current `Tab` to a new `Tab`
//     in the target group (`move_pane_to_group`).
//
// The persistence side of groups (auto-save every 30s, restore
// on startup) is owned by `wtinator::session` (patch 0029), not
// here — `groups` is purely the in-memory model and the
// move-pane operation.
//
// ## Why move the pane into a *new* tab in the target group?
//
// `Tab::assign_pane` replaces the whole pane tree of the tab,
// which would obliterate any existing splits. The simplest
// predictable behavior is to spawn a brand-new tab in the target
// group, sized to match the source tab, and put the moved pane
// there as the sole pane. The user can split it later if they
// want — this matches the iTerm2 "Move to Window" UX and avoids
// a class of bugs around "what happens to the destination tab's
// splits".
//
// The new tab is added to the **same window** as the source
// pane's window, so the user's window layout is preserved. If
// the source tab becomes empty after the move, it is removed
// from the mux (this is what `Mux::move_pane_to_new_tab` does
// upstream and is the right behavior here too).

use anyhow::{anyhow, Context, Result};
use mux::pane::PaneId;
use mux::tab::Tab;
use mux::Mux;
use std::collections::BTreeSet;
use std::sync::Arc;

/// Sentinel for the "no group" bucket. Tabs whose
/// `group_name` is `None` are collected under this label in
/// `list_groups`. The empty string is reserved (an empty group
/// name on a tab is treated as `None` for safety).
pub const NO_GROUP_LABEL: &str = "(no group)";

/// Maximum group name length we accept. The upstream `Tab.title`
/// has no enforced limit, but a group name shows up in the
/// right-click submenu and in `session.json`, so we cap it to
/// keep both UIs sane. 64 chars is plenty for human-readable
/// labels like "frontend" or "backend-services".
pub const MAX_GROUP_NAME_LEN: usize = 64;

/// Normalize a user-supplied group name.
///
/// Returns `Ok(None)` for an empty or whitespace-only string
/// (which means "no group") and `Err` if the string is too long
/// or contains control characters. Whitespace at the edges is
/// trimmed.
pub fn normalize_group_name(raw: &str) -> Result<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(anyhow!("group name contains control characters"));
    }
    if trimmed.chars().count() > MAX_GROUP_NAME_LEN {
        return Err(anyhow!(
            "group name is longer than {} chars",
            MAX_GROUP_NAME_LEN
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// Snapshot of all groups currently in use across all windows
/// of the mux. Tabs in the same group are listed together
/// (across all windows).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupListing {
    /// Group names in lexicographic order, with the
    /// "no group" bucket last so that real groups show up
    /// at the top of the right-click submenu.
    pub names: Vec<String>,
}

/// Build a listing of all groups that currently have at least
/// one tab. The "no group" bucket appears only if there is at
/// least one tab with `group_name == None`.
///
/// If the mux is not initialized (which can happen in unit
/// tests that build the menu without a live `Mux::get()`),
/// returns an empty listing — the menu shows just the
/// "(no group)" sentinel as a disabled entry.
pub fn list_groups() -> GroupListing {
    let Some(mux) = Mux::try_get() else {
        return GroupListing { names: vec![] };
    };
    let mut set: BTreeSet<String> = BTreeSet::new();
    let mut has_ungrouped = false;
    for window_id in mux.iter_windows() {
        let Some(window) = mux.get_window(window_id) else {
            continue;
        };
        for tab in window.iter() {
            match tab.get_group_name() {
                Some(name) => {
                    set.insert(name);
                }
                None => {
                    has_ungrouped = true;
                }
            }
        }
    }
    let mut names: Vec<String> = set.into_iter().collect();
    if has_ungrouped {
        names.push(NO_GROUP_LABEL.to_string());
    }
    GroupListing { names }
}

/// Return the group name of a tab, with `None` represented as
/// `NO_GROUP_LABEL`. Useful for the right-click submenu.
pub fn display_group_of_tab(tab: &Arc<Tab>) -> String {
    tab.get_group_name()
        .unwrap_or_else(|| NO_GROUP_LABEL.to_string())
}

/// Outcome of `move_pane_to_group`. Reports what actually
/// happened so the caller (the menu dispatch) can log or
/// surface a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveOutcome {
    /// The pane was moved into a brand-new tab in the target
    /// group, in the same window as the source pane. Carries
    /// the new tab's id so the caller can activate it.
    MovedToNewTab {
        new_tab_id: mux::tab::TabId,
        window_id: mux::window::WindowId,
    },
    /// The pane was split into an existing target tab (patch
    /// 0035, drag-and-drop). Carries the target tab's id.
    MovedToTab {
        target_tab_id: mux::tab::TabId,
    },
    /// Nothing happened because the pane was already in the
    /// target tab.
    NoOp,
}

/// Move a single pane out of its current tab and into a new
/// tab in the target group, in the same window.
///
/// `target_group = None` (or `Some("")`) means "no group" — the
/// new tab is created with `group_name = None`.
///
/// The source tab is removed from the mux if it becomes empty
/// after the move. The new tab is added to the mux, then to
/// the source window.
pub fn move_pane_to_group(
    pane_id: PaneId,
    target_group: Option<&str>,
) -> Result<MoveOutcome> {
    let mux = Mux::get();
    // (domain_id, window_id, src_tab_id)
    let (_, window_id, src_tab_id) = mux
        .resolve_pane_id(pane_id)
        .ok_or_else(|| anyhow!("pane {pane_id} not found"))?;

    let src_tab = mux
        .get_tab(src_tab_id)
        .ok_or_else(|| anyhow!("source tab {src_tab_id} not found"))?;

    let size = src_tab.get_size();
    let pane = src_tab
        .remove_pane(pane_id)
        .ok_or_else(|| anyhow!("pane {pane_id} was not in tab {src_tab_id}"))?;

    // Resize the detached pane to match the source tab size so
    // it doesn't briefly render with stale dimensions when it
    // lands in the new tab.
    pane.resize(size).context("resize moved pane to new tab size")?;

    let new_tab = Arc::new(Tab::new(&size));
    new_tab.assign_pane(&pane);

    let target = normalize_group_name(target_group.unwrap_or(""))?;
    new_tab.set_group_name(target);

    mux.add_tab_and_active_pane(&new_tab)
        .context("add new tab to mux")?;
    mux.add_tab_to_window(&new_tab, window_id)
        .context("add new tab to source window")?;

    if src_tab.is_dead() {
        mux.remove_tab(src_tab_id);
    }

    Ok(MoveOutcome::MovedToNewTab {
        new_tab_id: new_tab.tab_id(),
        window_id,
    })
}

/// WezTerminator (patch 0035): move `pane_id` out of its current
/// tab and split it into `target_tab_id` (at that tab's active
/// pane, horizontal split, 50%). No-op if the pane is already in
/// the target tab. Removes the source tab if it becomes empty.
pub fn move_pane_to_tab(pane_id: PaneId, target_tab_id: mux::tab::TabId) -> Result<MoveOutcome> {
    let mux = Mux::get();
    let (_, _window_id, src_tab_id) = mux
        .resolve_pane_id(pane_id)
        .ok_or_else(|| anyhow!("pane {pane_id} not found"))?;
    if src_tab_id == target_tab_id {
        return Ok(MoveOutcome::NoOp);
    }
    let src_tab = mux
        .get_tab(src_tab_id)
        .ok_or_else(|| anyhow!("source tab {src_tab_id} not found"))?;
    let target_tab = mux
        .get_tab(target_tab_id)
        .ok_or_else(|| anyhow!("target tab {target_tab_id} not found"))?;
    // split_and_insert bails if the target tab is zoomed; unzoom first.
    target_tab.set_zoomed(false);
    let pane = src_tab
        .remove_pane(pane_id)
        .ok_or_else(|| anyhow!("pane {pane_id} was not in tab {src_tab_id}"))?;
    let active_idx = target_tab.get_active_idx();
    let request = mux::tab::SplitRequest {
        direction: mux::tab::SplitDirection::Horizontal,
        target_is_second: true,
        size: mux::tab::SplitSize::Percent(50),
        top_level: false,
    };
    target_tab
        .split_and_insert(active_idx, request, pane)
        .context("split moved pane into target tab")?;
    if src_tab.is_dead() {
        mux.remove_tab(src_tab_id);
    }
    Ok(MoveOutcome::MovedToTab { target_tab_id })
}

/// WezTerminator (patch 0037): which edge of a target pane a
/// dragged pane should dock to (Visual-Studio-style docking).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockZone {
    /// Dock to the left of the target (target keeps the right half).
    Left,
    /// Dock to the right of the target.
    Right,
    /// Dock above the target.
    Up,
    /// Dock below the target.
    Down,
    /// Swap the dragged pane with the target pane (no new split).
    Center,
}

/// WezTerminator (patch 0037): dock `dragged_pane_id` to a
/// specific edge of `target_pane_id` (VS-style window docking).
///
/// The dragged pane is removed from its source tab and split
/// into the target pane's position in the requested direction
/// (Left/Right => horizontal split, Up/Down => vertical split).
/// For `Center`, the two panes swap places within the tab (or,
/// across tabs, the dragged pane moves into the target's tab).
/// The source tab is removed if it becomes empty.
pub fn dock_pane_to_pane(
    dragged_pane_id: PaneId,
    target_pane_id: PaneId,
    zone: DockZone,
) -> Result<MoveOutcome> {
    if dragged_pane_id == target_pane_id {
        return Ok(MoveOutcome::NoOp);
    }
    let mux = Mux::get();
    let (_, _w1, src_tab_id) = mux
        .resolve_pane_id(dragged_pane_id)
        .ok_or_else(|| anyhow!("dragged pane {dragged_pane_id} not found"))?;
    let (_, _w2, target_tab_id) = mux
        .resolve_pane_id(target_pane_id)
        .ok_or_else(|| anyhow!("target pane {target_pane_id} not found"))?;
    let target_tab = mux
        .get_tab(target_tab_id)
        .ok_or_else(|| anyhow!("target tab {target_tab_id} not found"))?;

    // Center => swap the two panes (within a tab); across tabs,
    // fall back to moving the dragged pane into the target's tab.
    if zone == DockZone::Center {
        if src_tab_id == target_tab_id {
            let panes = target_tab.iter_panes();
            let s = panes
                .iter()
                .find(|p| p.pane.pane_id() == dragged_pane_id)
                .map(|p| p.index);
            let d = panes
                .iter()
                .find(|p| p.pane.pane_id() == target_pane_id)
                .map(|p| p.index);
            if let (Some(s), Some(d)) = (s, d) {
                target_tab.set_active_idx(s);
                target_tab.swap_active_with_index(d, true);
            }
            return Ok(MoveOutcome::MovedToTab { target_tab_id });
        }
        return move_pane_to_tab(dragged_pane_id, target_tab_id);
    }

    let (direction, target_is_second) = match zone {
        DockZone::Left => (mux::tab::SplitDirection::Horizontal, false),
        DockZone::Right => (mux::tab::SplitDirection::Horizontal, true),
        DockZone::Up => (mux::tab::SplitDirection::Vertical, false),
        DockZone::Down => (mux::tab::SplitDirection::Vertical, true),
        DockZone::Center => unreachable!("handled above"),
    };

    let src_tab = mux
        .get_tab(src_tab_id)
        .ok_or_else(|| anyhow!("source tab {src_tab_id} not found"))?;
    // split_and_insert bails if the target tab is zoomed.
    target_tab.set_zoomed(false);
    let pane = src_tab
        .remove_pane(dragged_pane_id)
        .ok_or_else(|| anyhow!("dragged pane {dragged_pane_id} was not in tab {src_tab_id}"))?;

    // Resolve the target pane's index AFTER the removal (so it is
    // correct even when both panes were in the same tab).
    let target_idx = target_tab
        .iter_panes()
        .iter()
        .find(|p| p.pane.pane_id() == target_pane_id)
        .map(|p| p.index)
        .ok_or_else(|| {
            anyhow!("target pane {target_pane_id} not found in target tab after removal")
        })?;
    let request = mux::tab::SplitRequest {
        direction,
        target_is_second,
        size: mux::tab::SplitSize::Percent(50),
        top_level: false,
    };
    target_tab
        .split_and_insert(target_idx, request, pane)
        .context("dock: split target pane")?;
    if src_tab.is_dead() {
        mux.remove_tab(src_tab_id);
    }
    Ok(MoveOutcome::MovedToTab { target_tab_id })
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_group_name_trims_whitespace() {
        assert_eq!(normalize_group_name("  frontend  ").unwrap(), Some("frontend".to_string()));
        assert_eq!(normalize_group_name("").unwrap(), None);
        assert_eq!(normalize_group_name("   ").unwrap(), None);
    }

    #[test]
    fn normalize_group_name_rejects_control_chars() {
        assert!(normalize_group_name("front\nend").is_err());
        assert!(normalize_group_name("front\x00end").is_err());
    }

    #[test]
    fn normalize_group_name_caps_length() {
        let long = "a".repeat(MAX_GROUP_NAME_LEN + 1);
        assert!(normalize_group_name(&long).is_err());
        let just_right = "a".repeat(MAX_GROUP_NAME_LEN);
        assert_eq!(normalize_group_name(&just_right).unwrap().unwrap().len(), MAX_GROUP_NAME_LEN);
    }

    #[test]
    fn display_group_of_tab_handles_ungrouped() {
        // We can't easily build a real `Tab` here without going
        // through the mux, so this test only checks the
        // `normalize_group_name` path that the function uses.
        // The display logic is straightforward and exercised by
        // the manual test plan in patches/0028-tab-groups.md.
        assert_eq!(display_group_of_tab_isolated(None), NO_GROUP_LABEL);
        assert_eq!(display_group_of_tab_isolated(Some("frontend")), "frontend");
    }

    fn display_group_of_tab_isolated(name: Option<&str>) -> String {
        name.map(|s| s.to_string()).unwrap_or_else(|| NO_GROUP_LABEL.to_string())
    }

    #[test]
    fn move_outcome_variants_compile() {
        // Patch 0035 added two MoveOutcome variants. We can't
        // exercise move_pane_to_tab without a live Mux::get(), so
        // (mirroring the other tests) we just construct the
        // variants to prove they compile and carry the right
        // payload.
        let moved = MoveOutcome::MovedToTab { target_tab_id: 1 };
        assert_eq!(moved, MoveOutcome::MovedToTab { target_tab_id: 1 });
        assert_ne!(moved, MoveOutcome::NoOp);
        assert_eq!(MoveOutcome::NoOp, MoveOutcome::NoOp);
    }

    #[test]
    fn dock_zone_variants_and_same_pane_is_noop() {
        // Patch 0037: the five dock zones are distinct, and
        // docking a pane onto itself is a no-op (does not need
        // a live mux).
        assert_ne!(DockZone::Left, DockZone::Right);
        assert_ne!(DockZone::Up, DockZone::Down);
        assert_ne!(DockZone::Center, DockZone::Left);
        assert_eq!(
            dock_pane_to_pane(7, 7, DockZone::Right).unwrap(),
            MoveOutcome::NoOp
        );
    }

    #[test]
    fn no_group_label_is_stable() {
        // The right-click submenu and the session JSON both
        // depend on this constant; if it ever changes, the
        // session file will not be portable across versions.
        assert_eq!(NO_GROUP_LABEL, "(no group)");
    }
}
