//! BethTerm (patch 0148): keep each OS window's placement and name
//! across GUI restarts.
//!
//! Since patch 0121 the terminals live in `bethterm-host.exe`; a GUI
//! restart re-attaches and re-creates one OS window per host window.
//! Nothing remembered where those windows were, so every one was
//! healed to the same corner, and `session.json` matched window names
//! by enumeration index, which changes on re-attach. The stable key is
//! the set of **host pane ids** a window shows.
//!
//! Store: `%APPDATA%\bethterm\host-windows.json`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use wezterm_client::pane::ClientPane;

const FILENAME: &str = "host-windows.json";

/// Where a window was, in `GetWindowPlacement` terms.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    #[serde(default)]
    pub maximized: bool,
    /// Hidden in the notification area when the snapshot was taken.
    #[serde(default)]
    pub hidden: bool,
}

/// One OS window, identified by the host panes it contained.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowRecord {
    /// `bethterm-host` or `bethterm-host-<id>`. Absent on records
    /// written by the single-host builds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub remote_pane_ids: Vec<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<Placement>,
    /// Taskbar icon swatch id (`taskbar_icon::SWATCHES`). Absent = app icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
struct Store {
    #[serde(default)]
    windows: Vec<WindowRecord>,
}

/// mux window id → HWND, registered by the GUI when the window exists.
static HWNDS: Mutex<Option<HashMap<usize, isize>>> = Mutex::new(None);
/// Windows restored as "hidden in the tray": the visibility watchdog
/// must leave them alone.
static KEEP_HIDDEN: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static LAST_WRITTEN: Mutex<Option<Vec<u8>>> = Mutex::new(None);

pub fn register_hwnd(mux_window_id: usize, hwnd: isize) {
    let mut g = HWNDS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashMap::new).insert(mux_window_id, hwnd);
}

pub fn unregister_hwnd(mux_window_id: usize) {
    let mut g = HWNDS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        if let Some(hwnd) = map.remove(&mux_window_id) {
            KEEP_HIDDEN
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|h| *h != hwnd);
        }
    }
}

/// Any registered BethTerm window. They all share the UI thread, so
/// the UI watchdog (patch 0162) needs only one.
pub fn any_hwnd() -> Option<isize> {
    HWNDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.values().next().copied())
}

fn hwnd_for(mux_window_id: usize) -> Option<isize> {
    HWNDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(&mux_window_id).copied())
}

/// True for a window that was restored hidden (tray) and must not be
/// pulled on-screen by `window_heal`.
pub fn is_keep_hidden(hwnd: isize) -> bool {
    KEEP_HIDDEN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&hwnd)
}

/// The user hid this window (title-bar X or "Esconder tudo").
/// The visibility watchdog must not pull it back on screen.
pub fn note_hidden(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    let mut hidden = KEEP_HIDDEN.lock().unwrap_or_else(|e| e.into_inner());
    if !hidden.contains(&hwnd) {
        hidden.push(hwnd);
    }
}

/// Forget the keep-hidden mark (the user restored the window).
pub fn clear_keep_hidden(hwnd: isize) {
    KEEP_HIDDEN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|h| *h != hwnd);
}

fn store_path() -> Result<PathBuf> {
    Ok(crate::session::session_dir()?.join(FILENAME))
}

fn load_store() -> Store {
    let Ok(path) = store_path() else {
        return Store::default();
    };
    std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// True when a store with at least one window exists (then
/// `session.json`'s index-based window names must not be applied).
pub fn store_has_windows() -> bool {
    !load_store().windows.is_empty()
}

/// Sorted host pane ids shown by a local mux window.
pub fn remote_pane_ids_of_window(mux: &mux::Mux, window_id: mux::window::WindowId) -> Vec<usize> {
    let mut ids = Vec::new();
    if let Some(window) = mux.get_window(window_id) {
        for tab in window.iter() {
            for pos in tab.iter_panes_ignoring_zoom() {
                if let Some(cp) = pos.pane.downcast_ref::<ClientPane>() {
                    ids.push(cp.remote_pane_id);
                }
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// The record sharing the most host panes with `ids` (at least one).
fn hosts_match(record: Option<&str>, window: Option<&str>) -> bool {
    match (record, window) {
        (None, None) => true,
        (None, Some(window)) => window == "bethterm-host",
        (Some(record), Some(window)) => record == window,
        (Some(_), None) => false,
    }
}

pub fn best_match<'a>(
    records: &'a [WindowRecord],
    ids: &[usize],
    host: Option<&str>,
) -> Option<&'a WindowRecord> {
    let mut best: Option<(usize, &WindowRecord)> = None;
    for rec in records {
        if !hosts_match(rec.host_id.as_deref(), host) {
            continue;
        }
        let overlap = rec
            .remote_pane_ids
            .iter()
            .filter(|id| ids.contains(id))
            .count();
        if overlap == 0 {
            continue;
        }
        match best {
            Some((n, _)) if n >= overlap => {}
            _ => best = Some((overlap, rec)),
        }
    }
    best.map(|(_, r)| r)
}

#[cfg(windows)]
fn read_placement(hwnd: isize) -> Option<Placement> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, IsWindow, IsWindowVisible, SW_SHOWMAXIMIZED, WINDOWPLACEMENT,
    };
    let hwnd = hwnd as HWND;
    unsafe {
        if IsWindow(hwnd) == 0 {
            return None;
        }
        let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        if GetWindowPlacement(hwnd, &mut wp) == 0 {
            return None;
        }
        let r = wp.rcNormalPosition;
        Some(Placement {
            x: r.left,
            y: r.top,
            w: r.right - r.left,
            h: r.bottom - r.top,
            maximized: wp.showCmd == SW_SHOWMAXIMIZED as u32,
            hidden: IsWindowVisible(hwnd) == 0,
        })
    }
}

#[cfg(not(windows))]
fn read_placement(_hwnd: isize) -> Option<Placement> {
    None
}

#[cfg(windows)]
fn apply_placement(hwnd: isize, p: &Placement) -> bool {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPlacement, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWNORMAL, WINDOWPLACEMENT,
    };
    if p.w < 80 || p.h < 80 {
        return false;
    }
    let hwnd = hwnd as HWND;
    unsafe {
        let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        wp.showCmd = if p.hidden {
            SW_HIDE
        } else if p.maximized {
            SW_SHOWMAXIMIZED
        } else {
            SW_SHOWNORMAL
        } as u32;
        wp.rcNormalPosition = RECT {
            left: p.x,
            top: p.y,
            right: p.x + p.w,
            bottom: p.y + p.h,
        };
        SetWindowPlacement(hwnd, &wp) != 0
    }
}

#[cfg(not(windows))]
fn apply_placement(_hwnd: isize, _p: &Placement) -> bool {
    false
}

/// Snapshot every registered window and write the store when it
/// changed. Cheap: one `GetWindowPlacement` per window.
pub fn save_now() -> Result<usize> {
    let Some(mux) = mux::Mux::try_get() else {
        return Ok(0);
    };
    let mut store = load_store();
    let mut seen: Vec<Vec<usize>> = Vec::new();
    for window_id in mux.iter_windows() {
        let ids = remote_pane_ids_of_window(&mux, window_id);
        if ids.is_empty() {
            continue;
        }
        let host_id = crate::host::domain_name_of_window(&mux, window_id);
        let user_title = mux
            .get_window(window_id)
            .and_then(|w| w.get_user_title())
            .filter(|s| !s.is_empty());
        let placement = hwnd_for(window_id).and_then(read_placement);
        seen.push(ids.clone());
        match store
            .windows
            .iter_mut()
            .find(|r| r.remote_pane_ids == ids && r.host_id == host_id)
        {
            Some(rec) => {
                rec.user_title = user_title;
                if placement.is_some() {
                    rec.placement = placement;
                }
                apply_saved_icon_color(rec, &ids);
            }
            None => {
                let mut rec = WindowRecord {
                    host_id: host_id.clone(),
                    remote_pane_ids: ids.clone(),
                    user_title,
                    placement,
                    icon_color: None,
                };
                apply_saved_icon_color(&mut rec, &ids);
                store.windows.push(rec);
            }
        }
    }
    // Drop records whose panes no longer exist anywhere.
    let live: std::collections::HashSet<usize> = mux
        .iter_panes()
        .iter()
        .filter_map(|p| p.downcast_ref::<ClientPane>().map(|cp| cp.remote_pane_id))
        .collect();
    store
        .windows
        .retain(|r| r.remote_pane_ids.iter().any(|id| live.contains(id)));
    let n = store.windows.len();
    let bytes = serde_json::to_vec_pretty(&store).context("serialize host-windows")?;
    {
        let mut last = LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_deref() == Some(bytes.as_slice()) {
            return Ok(n);
        }
        *last = Some(bytes.clone());
    }
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))?;
    Ok(n)
}

fn apply_saved_icon_color(rec: &mut WindowRecord, ids: &[usize]) {
    match crate::taskbar_icon::choice_for_save(ids) {
        crate::taskbar_icon::SavedColor::Keep => {}
        crate::taskbar_icon::SavedColor::Clear => rec.icon_color = None,
        crate::taskbar_icon::SavedColor::Set(id) => rec.icon_color = Some(id),
    }
}

/// What `restore_for_window` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Restored {
    pub placement: bool,
    pub hidden: bool,
}

/// Give a freshly created OS window its remembered name and placement.
/// Returns `None` when nothing was remembered for its host panes.
pub fn restore_for_window(mux_window_id: usize, hwnd: isize) -> Option<Restored> {
    let mux = mux::Mux::try_get()?;
    let ids = remote_pane_ids_of_window(&mux, mux_window_id);
    if ids.is_empty() {
        return None;
    }
    let host = crate::host::domain_name_of_window(&mux, mux_window_id);
    let store = load_store();
    let rec = best_match(&store.windows, &ids, host.as_deref())?;
    if let Some(title) = rec.user_title.clone() {
        if let Some(mut w) = mux.get_window_mut(mux_window_id) {
            w.set_user_title(Some(title));
        }
    }
    if let Some(color) = rec.icon_color.clone() {
        crate::taskbar_icon::restore_saved(mux_window_id, hwnd, &color);
    }
    let mut out = Restored {
        placement: false,
        hidden: false,
    };
    if let Some(p) = &rec.placement {
        out.placement = apply_placement(hwnd, p);
        if out.placement && p.hidden {
            out.hidden = true;
            KEEP_HIDDEN
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(hwnd);
        }
    }
    log::info!(
        "bethterm: window {} restored from host-windows.json (panes {:?}, title {:?}, placement {}, hidden {})",
        mux_window_id,
        ids,
        rec.user_title,
        out.placement,
        out.hidden
    );
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ids: &[usize], title: &str) -> WindowRecord {
        WindowRecord {
            host_id: None,
            remote_pane_ids: ids.to_vec(),
            user_title: Some(title.to_string()),
            placement: None,
            icon_color: None,
        }
    }

    #[test]
    fn best_match_prefers_most_shared_panes() {
        let records = vec![rec(&[1, 2], "a"), rec(&[3, 4, 5], "b"), rec(&[9], "c")];
        assert_eq!(
            best_match(&records, &[3, 5], Some("bethterm-host"))
                .unwrap()
                .user_title
                .as_deref(),
            Some("b")
        );
        assert_eq!(
            best_match(&records, &[2], Some("bethterm-host"))
                .unwrap()
                .user_title
                .as_deref(),
            Some("a")
        );
        assert!(best_match(&records, &[7], Some("bethterm-host")).is_none());
        assert!(best_match(&records, &[2], Some("bethterm-host-w9")).is_none());
    }

    #[test]
    fn store_roundtrips_and_tolerates_old_fields() {
        let store = Store {
            windows: vec![WindowRecord {
                host_id: None,
                remote_pane_ids: vec![4, 5],
                user_title: Some("mobi".into()),
                placement: Some(Placement {
                    x: 10,
                    y: 20,
                    w: 800,
                    h: 600,
                    maximized: true,
                    hidden: false,
                }),
                icon_color: None,
            }],
        };
        let json = serde_json::to_string(&store).unwrap();
        let back: Store = serde_json::from_str(&json).unwrap();
        assert_eq!(back, store);
        let old: Store =
            serde_json::from_str(r#"{"windows":[{"remote_pane_ids":[1]}]}"#).unwrap();
        assert_eq!(old.windows[0].placement, None);
        assert_eq!(old.windows[0].user_title, None);
    }
}
