//! BethTerm (patch 0172): un-squeeze sliver panes after a window resize.
//!
//! The GUI and the host each keep a split tree. When a window hidden in
//! the tray comes back maximized, the per-pane `Resize` PDUs and the
//! host's `rebuild_splits_sizes_from_contained_panes` race, and a
//! two-pane tab can settle as 235 + 1 columns. The divider then sits on
//! the window edge, where the mouse grabs the window border instead, so
//! the user cannot drag it back.
//!
//! After the window size settles the GUI calls [`heal_tab`]: a pane
//! narrower than [`MIN_COLS`] (or shorter than [`MIN_ROWS`]) next to a
//! roomy neighbour gets its divider moved to the middle of the two sides,
//! through `Tab::resize_split_by`, which also resizes the host panes.

use mux::tab::{SplitDirection, Tab};

/// Narrower than this is a sliver nobody asked for.
pub const MIN_COLS: usize = 3;
/// Shorter than this is a sliver nobody asked for.
pub const MIN_ROWS: usize = 2;
/// Both sides together must have at least this many cells to be split
/// evenly; otherwise the tab is simply too small and is left alone.
const MIN_TOTAL: usize = 12;
/// Safety bound on fixes per call (each fix re-lays the tree).
const MAX_FIXES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// A pane's cell rectangle inside its tab.
pub struct PaneRect {
    /// Column of the left edge.
    pub left: usize,
    /// Row of the top edge.
    pub top: usize,
    /// Width in columns.
    pub width: usize,
    /// Height in rows.
    pub height: usize,
    /// Columns the pane really has (its PTY size). The GUI tree can say
    /// 188 while the host left the pane at 1 (2026-09-25, MOBI WIN).
    pub actual_cols: usize,
    /// Rows the pane really has.
    pub actual_rows: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// A split divider line inside a tab.
pub struct Divider {
    /// Split index for `Tab::resize_split_by`.
    pub index: usize,
    /// True for a vertical divider line (panes side by side).
    pub side_by_side: bool,
    /// Column of the divider's top-left cell.
    pub left: usize,
    /// Row of the divider's top-left cell.
    pub top: usize,
    /// Length of the divider line in cells.
    pub size: usize,
}

fn overlaps(a0: usize, alen: usize, b0: usize, blen: usize) -> bool {
    a0 < b0 + blen && b0 < a0 + alen
}

/// The first divider that has a sliver pane on one side, with the delta
/// that moves it to the middle of both sides (positive = right/down).
pub fn find_fix(panes: &[PaneRect], dividers: &[Divider]) -> Option<(usize, isize)> {
    for d in dividers {
        // Project panes onto the axis across the divider.
        let (line, min) = if d.side_by_side {
            (d.left, MIN_COLS)
        } else {
            (d.top, MIN_ROWS)
        };
        let mut before_start: Option<usize> = None;
        let mut after_end: Option<usize> = None;
        let mut before_min = usize::MAX;
        let mut after_min = usize::MAX;
        for p in panes {
            let (start, len, along0, along_len, actual) = if d.side_by_side {
                (p.left, p.width, p.top, p.height, p.actual_cols)
            } else {
                (p.top, p.height, p.left, p.width, p.actual_rows)
            };
            // A sliver is judged by the smaller of the layout and the
            // real size; the extents below come from the layout.
            let seen = len.min(actual);
            let (d_along0, d_along_len) = if d.side_by_side {
                (d.top, d.size)
            } else {
                (d.left, d.size)
            };
            if !overlaps(along0, along_len, d_along0, d_along_len) {
                continue;
            }
            if start + len == line {
                before_start = Some(before_start.map_or(start, |s| s.min(start)));
                before_min = before_min.min(seen);
            } else if start == line + 1 {
                after_end = Some(after_end.map_or(start + len, |e| e.max(start + len)));
                after_min = after_min.min(seen);
            }
        }
        let (Some(before_start), Some(after_end)) = (before_start, after_end) else {
            continue;
        };
        let before = line - before_start;
        let after = after_end - (line + 1);
        if before + after < MIN_TOTAL {
            continue;
        }
        if before_min >= min && after_min >= min {
            continue;
        }
        let target = (before + after) / 2;
        let delta = target as isize - before as isize;
        // delta 0: the layout is already even but a real pane is a sliver;
        // resizing by 0 still re-applies the layout to the panes.
        return Some((d.index, delta));
    }
    None
}

/// Like [`heal_tab`], but at most once per [`COOLDOWN`] per tab, for the
/// periodic check (so a host that keeps reverting a size is not fought
/// every few seconds).
pub fn heal_tab_throttled(tab: &Tab) -> usize {
    use std::time::Instant;
    static LAST: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<mux::tab::TabId, Instant>>,
    > = std::sync::OnceLock::new();
    let id = tab.tab_id();
    {
        let map = LAST
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if map.get(&id).map_or(false, |t| t.elapsed() < COOLDOWN) {
            return 0;
        }
    }
    let fixed = heal_tab(tab);
    if fixed > 0 {
        LAST.get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, Instant::now());
    }
    fixed
}

/// True exactly once per process: the caller starts the periodic check.
pub fn claim_periodic() -> bool {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    !STARTED.swap(true, std::sync::atomic::Ordering::SeqCst)
}

/// Minimum time between two periodic heals of the same tab.
pub const COOLDOWN: std::time::Duration = std::time::Duration::from_secs(20);
/// How often the GUI runs the periodic check.
pub const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// A window resize bumps its generation; a scheduled heal runs only if no
/// newer resize happened meanwhile (debounce while the user drags).
pub fn bump_generation(mux_window_id: usize) -> u64 {
    let mut map = generations();
    let gen = map.entry(mux_window_id).or_insert(0);
    *gen += 1;
    *gen
}

/// True when `generation` is still the latest resize of that window.
pub fn is_current(mux_window_id: usize, generation: u64) -> bool {
    generations().get(&mux_window_id) == Some(&generation)
}

fn generations() -> std::sync::MutexGuard<'static, std::collections::HashMap<usize, u64>> {
    static GENERATIONS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<usize, u64>>,
    > = std::sync::OnceLock::new();
    GENERATIONS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Un-squeeze every sliver pane in `tab`. Returns how many dividers moved.
pub fn heal_tab(tab: &Tab) -> usize {
    if tab.get_zoomed_pane().is_some() {
        return 0;
    }
    let mut fixed = 0;
    let mut last: Option<(usize, isize)> = None;
    while fixed < MAX_FIXES {
        let panes: Vec<PaneRect> = tab
            .iter_panes()
            .iter()
            .map(|p| {
                let dims = p.pane.get_dimensions();
                PaneRect {
                    left: p.left,
                    top: p.top,
                    width: p.width,
                    height: p.height,
                    actual_cols: dims.cols,
                    actual_rows: dims.viewport_rows,
                }
            })
            .collect();
        let dividers: Vec<Divider> = tab
            .iter_splits()
            .iter()
            .map(|s| Divider {
                index: s.index,
                side_by_side: s.direction == SplitDirection::Horizontal,
                left: s.left,
                top: s.top,
                size: s.size,
            })
            .collect();
        let Some((index, delta)) = find_fix(&panes, &dividers) else {
            break;
        };
        // The real sizes arrive from the host asynchronously; do not spin
        // re-applying the same fix inside one call.
        if last == Some((index, delta)) {
            break;
        }
        last = Some((index, delta));
        crate::host::note_life(&format!(
            "split heal: tab {} divider {index} moved by {delta} (sliver pane)",
            tab.tab_id()
        ));
        tab.resize_split_by(index, delta);
        fixed += 1;
    }
    fixed
}

#[cfg(test)]
mod test {
    use super::*;

    fn pane(left: usize, top: usize, width: usize, height: usize) -> PaneRect {
        PaneRect {
            left,
            top,
            width,
            height,
            actual_cols: width,
            actual_rows: height,
        }
    }

    fn vdiv(index: usize, left: usize, size: usize) -> Divider {
        Divider {
            index,
            side_by_side: true,
            left,
            top: 0,
            size,
        }
    }

    #[test]
    fn right_sliver_moves_divider_left_to_the_middle() {
        // The CLIENTES case: 235 + divider + 1 = 237 columns.
        let panes = [pane(0, 0, 235, 52), pane(236, 0, 1, 52)];
        let fix = find_fix(&panes, &[vdiv(0, 235, 52)]);
        // 236 cells shared: 118 | 118 -> first child shrinks by 117.
        assert_eq!(fix, Some((0, -117)));
    }

    #[test]
    fn left_sliver_moves_divider_right() {
        let panes = [pane(0, 0, 1, 40), pane(2, 0, 100, 40)];
        assert_eq!(find_fix(&panes, &[vdiv(0, 1, 40)]), Some((0, 49)));
    }

    #[test]
    fn healthy_split_is_left_alone() {
        let panes = [pane(0, 0, 30, 40), pane(31, 0, 200, 40)];
        assert_eq!(find_fix(&panes, &[vdiv(0, 30, 40)]), None);
    }

    #[test]
    fn tiny_tab_is_left_alone() {
        let panes = [pane(0, 0, 8, 10), pane(9, 0, 1, 10)];
        assert_eq!(find_fix(&panes, &[vdiv(0, 8, 10)]), None);
    }

    #[test]
    fn real_sliver_behind_a_healthy_layout_is_healed() {
        // MOBI WIN: the GUI tree said 188 | 48, the host panes were 235 | 1.
        let mut right = pane(189, 0, 48, 52);
        right.actual_cols = 1;
        let panes = [pane(0, 0, 188, 52), right];
        // 236 cells shared: move from 188 to 118.
        assert_eq!(find_fix(&panes, &[vdiv(0, 188, 52)]), Some((0, -70)));
    }

    #[test]
    fn even_layout_with_real_sliver_reapplies_layout() {
        let mut right = pane(119, 0, 118, 52);
        right.actual_cols = 1;
        let panes = [pane(0, 0, 118, 52), right];
        assert_eq!(find_fix(&panes, &[vdiv(0, 118, 52)]), Some((0, 0)));
    }

    #[test]
    fn stacked_sliver_moves_divider_up() {
        let panes = [pane(0, 0, 80, 50), pane(0, 51, 80, 1)];
        let d = Divider {
            index: 0,
            side_by_side: false,
            left: 0,
            top: 50,
            size: 80,
        };
        assert_eq!(find_fix(&panes, &[d]), Some((0, -25)));
    }

    #[test]
    fn nested_sliver_uses_the_whole_side() {
        // Left pane | (right column split top/bottom), right column 1 wide.
        let panes = [
            pane(0, 0, 100, 40),
            pane(101, 0, 1, 20),
            pane(101, 21, 1, 19),
        ];
        assert_eq!(find_fix(&panes, &[vdiv(0, 100, 40)]), Some((0, -50)));
    }
}
