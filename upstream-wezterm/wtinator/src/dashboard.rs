//! Left-rail dashboard of every live pane (patch 0124).
//!
//! Fixed-width list of terminal names. Click switches the terminal shown
//! on the right. Never splits, never types into the PTY.

use mux::pane::{CachePolicy, PaneId};
use mux::tab::TabId;
use mux::window::WindowId;
use mux::Mux;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// Fixed pixel width of the open sidebar. Shared by paint and resize.
pub const SIDEBAR_PX: usize = 280;
/// Header row height (title + close).
pub const HEADER_PX: usize = 36;
/// One pane row.
pub const ROW_PX: usize = 48;

static OPEN: OnceLock<Mutex<HashSet<WindowId>>> = OnceLock::new();
static SELECTED: OnceLock<Mutex<HashMap<WindowId, PaneId>>> = OnceLock::new();
static PENDING_OPEN: AtomicBool = AtomicBool::new(false);

fn open_set() -> std::sync::MutexGuard<'static, HashSet<WindowId>> {
    OPEN.get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn selected_map() -> std::sync::MutexGuard<'static, HashMap<WindowId, PaneId>> {
    SELECTED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Pane currently shown on the right of this dashboard window.
pub fn selected_pane(window_id: WindowId) -> Option<PaneId> {
    selected_map().get(&window_id).copied()
}

/// One live terminal in the rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Mux pane id.
    pub pane_id: PaneId,
    /// Tab that owns the pane.
    pub tab_id: TabId,
    /// Window that currently hosts the tab.
    pub window_id: WindowId,
    /// Short label (header, user title, OSC title, or fallback).
    pub title: String,
    /// Last path component of the cwd, if known.
    pub detail: String,
    /// Unseen output (agent printed something off-screen).
    pub waiting: bool,
}

/// True when this mux window is showing the rail.
pub fn is_open(window_id: WindowId) -> bool {
    open_set().contains(&window_id)
}

/// Open the rail on `window_id` and show the current terminal on the right.
pub fn open(window_id: WindowId) {
    open_set().insert(window_id);
    if let Some(mux) = Mux::try_get() {
        if let Some(tab) = mux.get_active_tab_for_window(window_id) {
            if let Some(pane) = tab.get_active_pane() {
                let _ = activate(window_id, pane.pane_id());
            }
        }
    }
}

/// Close the rail on `window_id` and restore the tab's own layout.
pub fn close(window_id: WindowId) {
    if let Some(mux) = Mux::try_get() {
        if let Some(tab) = mux.get_active_tab_for_window(window_id) {
            tab.set_zoomed(false);
        }
    }
    selected_map().remove(&window_id);
    open_set().remove(&window_id);
}

/// Toggle the rail. Returns the new open state.
pub fn toggle(window_id: WindowId) -> bool {
    if is_open(window_id) {
        close(window_id);
        false
    } else {
        open(window_id);
        true
    }
}

/// Reserved left inset, or 0 when the rail is closed.
pub fn width_px(window_id: WindowId) -> usize {
    if is_open(window_id) {
        SIDEBAR_PX
    } else {
        0
    }
}

/// How a new window should look. Default is the classic tab strip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowMode {
    /// Tabs + splits, no left rail.
    Classic,
    /// Fixed left list of terminal names.
    Dashboard,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ModeStore {
    #[serde(default)]
    window: Option<String>,
}

const MODE_FILENAME: &str = "ui-mode.json";

/// Persisted default for new windows. Missing file → classic.
pub fn preferred_mode() -> WindowMode {
    preferred_mode_from(mode_path().as_deref())
}

/// Save the default for new windows (`%APPDATA%\bethterm\ui-mode.json`).
pub fn set_preferred_mode(mode: WindowMode) {
    if let Ok(path) = crate::session::session_dir() {
        let _ = save_mode_to(&path.join(MODE_FILENAME), mode);
    }
}

fn mode_path() -> Option<std::path::PathBuf> {
    crate::session::session_dir()
        .ok()
        .map(|d| d.join(MODE_FILENAME))
}

fn preferred_mode_from(path: Option<&Path>) -> WindowMode {
    let Some(path) = path else {
        return WindowMode::Classic;
    };
    let Ok(bytes) = std::fs::read(path) else {
        return WindowMode::Classic;
    };
    let Ok(store) = serde_json::from_slice::<ModeStore>(&bytes) else {
        return WindowMode::Classic;
    };
    match store.window.as_deref() {
        Some("dashboard") => WindowMode::Dashboard,
        _ => WindowMode::Classic,
    }
}

fn save_mode_to(path: &Path, mode: WindowMode) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let window = match mode {
        WindowMode::Classic => "classic",
        WindowMode::Dashboard => "dashboard",
    };
    let json = serde_json::to_vec_pretty(&ModeStore {
        window: Some(window.to_string()),
    })?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Next new window should open with the rail already visible.
pub fn request_open_on_next_window() {
    PENDING_OPEN.store(true, Ordering::SeqCst);
}

/// Consume the pending-open flag (called from `TermWindow::new_window`).
pub fn take_pending_open() -> bool {
    PENDING_OPEN.swap(false, Ordering::SeqCst)
}

/// Open the rail on this new window: tray pending, test env, or saved default.
pub fn should_open_on_new_window() -> bool {
    take_pending_open()
        || std::env::var_os("BETHTERM_DASHBOARD").is_some()
        || preferred_mode() == WindowMode::Dashboard
}

/// Every live pane, window order then tab order.
pub fn collect() -> Vec<Entry> {
    let Some(mux) = Mux::try_get() else {
        return Vec::new();
    };
    let mut pending = Vec::new();
    for window_id in mux.iter_windows() {
        let Some(window) = mux.get_window(window_id) else {
            continue;
        };
        for tab in window.iter() {
            let tab_id = tab.tab_id();
            let user_title = tab.get_user_title();
            for pos in tab.iter_panes_ignoring_zoom() {
                pending.push((window_id, tab_id, user_title.clone(), pos.pane.clone()));
            }
        }
    }
    pending
        .into_iter()
        .map(|(window_id, tab_id, user_title, pane)| {
            entry_from_pane(window_id, tab_id, user_title.as_deref(), pane.as_ref())
        })
        .collect()
}

fn entry_from_pane(
    window_id: WindowId,
    tab_id: TabId,
    user_title: Option<&str>,
    pane: &dyn mux::pane::Pane,
) -> Entry {
    let pane_id = pane.pane_id();
    let title = pane_title(pane, user_title, pane_id);
    let detail = cwd_label(pane);
    let waiting = pane.has_unseen_output();
    Entry {
        pane_id,
        tab_id,
        window_id,
        title,
        detail,
        waiting,
    }
}

fn pane_title(pane: &dyn mux::pane::Pane, user_title: Option<&str>, pane_id: PaneId) -> String {
    if let Some(h) = pane.get_header_text() {
        let h = collapse_ws(&h);
        if !h.is_empty() {
            return h;
        }
    }
    if let Some(t) = user_title {
        let t = collapse_ws(t);
        if !t.is_empty() {
            return t;
        }
    }
    let osc = collapse_ws(&pane.get_title());
    if !osc.is_empty() {
        return osc;
    }
    format!("Terminal {pane_id}")
}

fn cwd_label(pane: &dyn mux::pane::Pane) -> String {
    let Some(url) = pane.get_current_working_dir(CachePolicy::AllowStale) else {
        return String::new();
    };
    let path = url.path();
    let trimmed = path.trim_end_matches('/');
    let name = trimmed
        .rsplit(|c| c == '/' || c == '\\')
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed);
    let name = name.strip_prefix(':').unwrap_or(name);
    collapse_ws(name)
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push(' ');
        }
        gap = false;
        out.push(ch);
    }
    out
}

/// Truncate a label so it fits the rail (used by paint and tests).
pub fn clip_label(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let keep = max_chars.saturating_sub(1);
    let mut out: String = s.chars().take(keep).collect();
    out.push('…');
    out
}

/// Show `pane_id` on the right of `dest_window`.
///
/// The sidebar is the only navigator. Tabs stay hidden while the
/// dashboard is open. Never splits and never writes to the PTY.
pub fn activate(dest_window: WindowId, pane_id: PaneId) -> anyhow::Result<()> {
    let mux = Mux::get();
    let Some((_, src_window, tab_id)) = mux.resolve_pane_id(pane_id) else {
        anyhow::bail!("pane {pane_id} is gone");
    };
    if is_open(dest_window) {
        if let Some(prev) = mux.get_active_tab_for_window(dest_window) {
            prev.set_zoomed(false);
        }
    }
    if src_window != dest_window {
        mux.move_tab_to_window(tab_id, Some(dest_window))?;
    }
    if let Some(mut window) = mux.get_window_mut(dest_window) {
        if let Some(idx) = window.idx_by_id(tab_id) {
            window.save_and_then_set_active(idx);
        }
    }
    if let Some(tab) = mux.get_tab(tab_id) {
        if let Some(pane) = mux.get_pane(pane_id) {
            tab.set_active_pane(&pane);
            if is_open(dest_window) {
                tab.set_zoomed(true);
            }
        }
    }
    selected_map().insert(dest_window, pane_id);
    mux.notify(mux::MuxNotification::WindowInvalidated(dest_window));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn width_is_zero_until_opened() {
        let id = 9_001;
        close(id);
        assert_eq!(width_px(id), 0);
        open(id);
        assert_eq!(width_px(id), SIDEBAR_PX);
        assert_eq!(selected_pane(id), None);
        assert!(toggle(id) == false);
        assert_eq!(width_px(id), 0);
        close(id);
    }

    #[test]
    fn pending_open_is_one_shot() {
        request_open_on_next_window();
        assert!(take_pending_open());
        assert!(!take_pending_open());
    }

    #[test]
    fn clip_label_adds_ellipsis() {
        assert_eq!(clip_label("ok", 8), "ok");
        assert_eq!(clip_label("abcdefghij", 6), "abcde…");
    }

    #[test]
    fn collapse_ws_flattens_newlines() {
        assert_eq!(collapse_ws("  foo\nbar  "), "foo bar");
    }

    #[test]
    fn collect_without_mux_is_empty() {
        assert!(collect().is_empty());
    }

    #[test]
    fn preferred_mode_defaults_to_classic() {
        assert_eq!(preferred_mode_from(None), WindowMode::Classic);
        let dir = std::env::temp_dir().join(format!("bethterm-ui-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ui-mode.json");
        assert_eq!(preferred_mode_from(Some(&path)), WindowMode::Classic);
        save_mode_to(&path, WindowMode::Dashboard).unwrap();
        assert_eq!(preferred_mode_from(Some(&path)), WindowMode::Dashboard);
        save_mode_to(&path, WindowMode::Classic).unwrap();
        assert_eq!(preferred_mode_from(Some(&path)), WindowMode::Classic);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
