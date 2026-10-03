// wtinator::session — Phase 1.D (patch 0029).
//
// BethTerm persists the full terminal layout so the user
// gets their tabs, splits, working directories, and custom
// names back after a restart.
//
// ## Schema v9
//
// In addition to group_name, tab_title (OSC 0/2), header_text,
// program, args, cwd, pane geometry, per-tab user_title, and
// per-tab window_index (added across schema versions 1..8),
// v9 records:
//
//   - `windows[]`: sticky user-chosen names for physical mux
//     windows (set via "Rename window…" or the new-window
//     prompt when moving a tab). Older sessions default to
//     an empty list (unnamed windows).
//
// ## Path resolution
//
// - Windows: `%APPDATA%\bethterm\session.json`
// - Linux / macOS: `~/.config/bethterm/session.json`
//
// If only the legacy `%APPDATA%\wezterminator` (or `~/.config/wezterminator`)
// directory exists, it is renamed to `bethterm` on first access.
//
// ## Schema versioning
//
// The JSON has a top-level `version: u32` field. The loader
// rejects any version it does not recognize.

use anyhow::{Context, Result};
use mux::Mux;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

pub const SESSION_VERSION: u32 = 9;

pub const SESSION_FILENAME: &str = "session.json";

// `Eq` is intentionally NOT derived: `PaneEntry` carries an
// `Option<f64>` (font_scale, patch 0041) and `f64` is not `Eq`.
// `PartialEq` is all we need (the tests use `assert_eq!`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    #[serde(default = "default_session_version")]
    pub version: u32,
    pub tabs: Vec<TabEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub panes: Vec<PaneEntry>,
    /// WezTerminator (patch 0085): per-window sticky names. Older
    /// sessions omit this field and restore as unnamed windows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<WindowEntry>,
}

/// One physical mux window's persisted metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowEntry {
    /// Index in the snapshot's window list (0 is the first window).
    pub window_index: usize,
    /// Sticky user-chosen window name. `None` means unnamed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_title: Option<String>,
}

fn default_session_version() -> u32 {
    SESSION_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TabEntry {
    /// Physical mux window containing this tab. Version 7 and older sessions
    /// default to the first window.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub window_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_title: Option<String>,
    /// WezTerminator (patch 0031): user-set tab title
    /// (sticky override of the OSC 0/2 title). `None` or
    /// the empty string means "no user override" (the tab
    /// falls back to the OSC `tab_title` above, which will
    /// itself be overwritten by the next OSC escape from
    /// the shell on restart). The OSC title is still
    /// persisted for backwards compatibility and for users
    /// who haven't yet adopted "Rename tab…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_title: Option<String>,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PaneEntry {
    #[serde(default)]
    pub tab_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub left: usize,
    #[serde(default)]
    pub top: usize,
    #[serde(default)]
    pub width: usize,
    #[serde(default)]
    pub height: usize,
    #[serde(default)]
    pub is_active: bool,
    /// WezTerminator (patch 0041): per-pane font scale (None = 1.0,
    /// the window default). Restored via `Pane::set_font_scale`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_scale: Option<f64>,
    /// WezTerminator (patch 0041): id of the theme applied to this
    /// pane via "Configure this terminal…" (None = the window theme).
    /// Restored via `notify_ipc::palette_from_theme_id` + `set_palette`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_id: Option<String>,
    /// WezTerminator (patch 0043): per-pane font family (None = the
    /// window font). Restored via `Pane::set_font_family`, after which
    /// the GUI recomputes the cell scale and reflows. Additive;
    /// composes with `font_scale` (size) and `theme_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    /// WezTerminator (patch 0047): per-pane bold / italic. Restored via
    /// `Pane::set_font_bold` / `set_font_italic`. `#[serde(default)]` so
    /// older session files (without these) still load.
    #[serde(default)]
    pub font_bold: bool,
    #[serde(default)]
    pub font_italic: bool,
}

static SAVE_LOCK: Mutex<()> = Mutex::new(());
/// BethTerm (patch 0134): bytes of the last session.json we wrote (or
/// handed to the background writer). An auto-save whose serialized
/// snapshot equals this is skipped: no disk I/O, no info log.
static LAST_WRITTEN: Mutex<Option<Vec<u8>>> = Mutex::new(None);
/// BethTerm (patch 0134): when the last background auto-save ran. If
/// more than one 30 s timer is alive (one per TermWindow), only the
/// first tick inside this window does work.
static LAST_AUTO_SAVE: Mutex<Option<std::time::Instant>> = Mutex::new(None);
const AUTO_SAVE_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);
static STARTUP_RESTORE_CLAIMED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Only the first physical GUI window may bootstrap the saved mux layout.
/// Windows created by that restore also run `TermWindow::created`; without
/// this guard they would recursively restore the same session again.
pub fn claim_startup_restore() -> bool {
    !STARTUP_RESTORE_CLAIMED.swap(true, std::sync::atomic::Ordering::SeqCst)
}

/// Patch 0167: after the host died, let the next window restore
/// `session.json` again, as at startup.
pub fn rearm_startup_restore() {
    STARTUP_RESTORE_CLAIMED.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Patch 0165: the saved session was already read. Before that, an
/// empty mux must never overwrite `session.json`.
pub fn startup_restore_claimed() -> bool {
    STARTUP_RESTORE_CLAIMED.load(std::sync::atomic::Ordering::SeqCst)
}

pub fn session_dir() -> Result<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE").map(|p| {
                    let mut pb = PathBuf::from(p);
                    pb.push("AppData");
                    pb.push("Roaming");
                    pb
                })
            })
            .context("could not resolve %APPDATA% or %USERPROFILE%")?
    } else {
        let xdg = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let mut pb = PathBuf::from(
                    std::env::var_os("HOME").unwrap_or_else(|| ".".into()),
                );
                pb.push(".config");
                pb
            });
        xdg
    };
    let new_dir = base.join(crate::DATA_DIR_NAME);
    if new_dir.exists() {
        return Ok(new_dir);
    }
    let old_dir = base.join(crate::LEGACY_DATA_DIR_NAME);
    if old_dir.exists() {
        match fs::rename(&old_dir, &new_dir) {
            Ok(()) => return Ok(new_dir),
            Err(e) => {
                log::warn!(
                    "bethterm: could not migrate {} to {}: {:#}; using the legacy directory",
                    old_dir.display(),
                    new_dir.display(),
                    e
                );
                return Ok(old_dir);
            }
        }
    }
    Ok(new_dir)
}

pub fn session_path() -> Result<PathBuf> {
    Ok(session_dir()?.join(SESSION_FILENAME))
}

pub fn snapshot() -> Result<Session> {
    let Some(mux) = Mux::try_get() else {
        return Ok(Session {
            version: SESSION_VERSION,
            tabs: Vec::new(),
            panes: Vec::new(),
            windows: Vec::new(),
        });
    };
    let mut tabs = Vec::new();
    let mut panes = Vec::new();
    let mut windows = Vec::new();
    for (window_index, window_id) in mux.iter_windows().into_iter().enumerate() {
        let Some(window) = mux.get_window(window_id) else {
            continue;
        };
        let user_title = window.get_user_title().and_then(|s| {
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });
        if user_title.is_some() {
            windows.push(WindowEntry {
                window_index,
                user_title,
            });
        }
        for tab in window.iter() {
            let tab_index = tabs.len();
            let group_name = tab.get_group_name();
            let tab_title = {
                let t = tab.get_title();
                if t.is_empty() { None } else { Some(t) }
            };
            // WezTerminator (patch 0031): persist the
            // user-set title override (sticky across OSC
            // escapes). Empty strings are normalised to
            // `None` so the JSON does not carry a
            // meaningless empty value.
            let user_title = tab.get_user_title().and_then(|s| {
                if s.is_empty() { None } else { Some(s) }
            });
            tabs.push(TabEntry {
                window_index,
                group_name,
                tab_title,
                user_title,
            });
            for pos in tab.iter_panes_ignoring_zoom() {
                let program = pos.pane.get_foreground_process_name(mux::pane::CachePolicy::AllowStale);
                let cwd = pos
                    .pane
                    .get_current_working_dir(mux::pane::CachePolicy::AllowStale)
                    .and_then(|url| {
                        if url.scheme() == "file" {
                            url.to_file_path().ok()
                        } else {
                            None
                        }
                    })
                    .map(|p| p.to_string_lossy().to_string());
                let header_text = pos.pane.get_header_text();
                let is_active = pos.is_active;
                // WezTerminator (patch 0041): persist per-pane font
                // scale (only when non-default) and the applied theme.
                let font_scale = {
                    let s = pos.pane.get_font_scale();
                    if (s - 1.0).abs() > f64::EPSILON {
                        Some(s)
                    } else {
                        None
                    }
                };
                let theme_id = pos.pane.get_theme_id();
                // WezTerminator (patch 0043): persist the per-pane font
                // family (None when on the window font).
                let font_family = pos.pane.get_font_family();
                // WezTerminator (patch 0047): persist per-pane bold/italic.
                let font_bold = pos.pane.get_font_bold();
                let font_italic = pos.pane.get_font_italic();
                panes.push(PaneEntry {
                    tab_index,
                    header_text,
                    program,
                    // Patch 0161: the full argv the pane was spawned
                    // with (host panes cannot report `program`).
                    args: crate::pane_cmd::lookup(&*pos.pane).unwrap_or_default(),
                    cwd,
                    left: pos.left,
                    top: pos.top,
                    width: pos.width,
                    height: pos.height,
                    is_active,
                    font_scale,
                    theme_id,
                    font_family,
                    font_bold,
                    font_italic,
                });
            }
        }
    }
    log::debug!(
        "wezterminator: snapshot captured {} tab(s) and {} pane(s)",
        tabs.len(),
        panes.len()
    );
    Ok(Session {
        version: SESSION_VERSION,
        tabs,
        panes,
        windows,
    })
}

pub fn save() -> Result<usize> {
    persist_session(PersistMode::Wait)
}

/// Snapshot on the caller (mux) thread, then write AppData in the
/// background. Used by the 30s auto-save so a stalled disk cannot
/// freeze the GUI (BethTerm patch 0113).
pub fn save_async() -> Result<usize> {
    persist_session(PersistMode::Background)
}

enum PersistMode {
    Wait,
    Background,
}

/// BethTerm (patch 0134): true when `bytes` equal the last written
/// snapshot. Updates the record when they differ.
fn unchanged_since_last_write(bytes: &[u8]) -> bool {
    let mut last = LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_deref() == Some(bytes) {
        return true;
    }
    *last = Some(bytes.to_vec());
    false
}

/// BethTerm (patch 0134): rate guard for the background auto-save.
fn auto_save_due() -> bool {
    let mut last = LAST_AUTO_SAVE.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    match *last {
        Some(t) if now.duration_since(t) < AUTO_SAVE_MIN_INTERVAL => false,
        _ => {
            *last = Some(now);
            true
        }
    }
}

fn persist_session(mode: PersistMode) -> Result<usize> {
    if matches!(mode, PersistMode::Background) && !auto_save_due() {
        return Ok(0);
    }
    let session = snapshot()?;
    // Patch 0148: window placements/names keyed by host panes.
    if let Err(e) = crate::window_geom::save_now() {
        log::debug!("bethterm: host-windows save failed: {e:#}");
    }
    let n = session.tabs.len();
    let path = session_path()?;
    let bytes = serde_json::to_vec_pretty(&session).context("serialize session")?;
    if unchanged_since_last_write(&bytes) {
        log::debug!("wezterminator: session unchanged; skipping write");
        return Ok(n);
    }
    log::info!(
        "wezterminator: session changed; saving {} tab(s) and {} pane(s)",
        n,
        session.panes.len()
    );
    match mode {
        PersistMode::Wait => {
            write_session_bytes(&path, &bytes)?;
        }
        PersistMode::Background => {
            let dest = path;
            let _ = std::thread::Builder::new()
                .name("wt-session-write".into())
                .spawn(move || {
                    if let Err(e) = write_session_bytes(&dest, &bytes) {
                        log::warn!("wezterminator: background session save failed: {e:#}");
                    }
                });
        }
    }
    Ok(n)
}

fn write_session_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let mut tmp = path.to_path_buf();
    tmp.as_mut_os_string().push(".tmp");
    write_path_with_timeout(&tmp, bytes, std::time::Duration::from_secs(2))?;
    rename_with_timeout(&tmp, path, std::time::Duration::from_secs(2))?;
    Ok(())
}

pub fn load() -> Result<Option<Session>> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = session_path()?;
    if !path.exists() {
        return Ok(None);
    }
    // Patch 0079: AppData can stall for minutes after a disk-full freeze.
    // Never block the GUI thread on that I/O.
    let bytes = match read_path_with_timeout(&path, std::time::Duration::from_secs(2)) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!(
                "wezterminator: skipping session restore (read failed or timed out): {:#}",
                e
            );
            return Ok(None);
        }
    };
    let session: Session = match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                "wezterminator: session.json is corrupt ({e}); quarantining and starting empty"
            );
            let _ = quarantine_session_file(&path);
            return Ok(None);
        }
    };
    if session.version > SESSION_VERSION {
        anyhow::bail!(
            "session.json has version {} but this build only understands up to {}. \
             Refusing to load — please remove the file or upgrade BethTerm.",
            session.version,
            SESSION_VERSION
        );
    }
    if session.version < SESSION_VERSION {
        log::info!(
            "wezterminator: upgrading session.json from v{} to v{}",
            session.version,
            SESSION_VERSION,
        );
    }
    Ok(Some(session))
}

fn write_path_with_timeout(
    path: &std::path::Path,
    bytes: &[u8],
    timeout: std::time::Duration,
) -> Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let probe = path.to_path_buf();
    let payload = bytes.to_vec();
    let _ = std::thread::Builder::new()
        .name("wt-session-fs-write".into())
        .spawn(move || {
            let _ = tx.send(fs::write(&probe, &payload));
        });
    match rx.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e).context("writing session.json"),
        Err(_) => anyhow::bail!(
            "timed out after {:?} writing {}",
            timeout,
            path.display()
        ),
    }
}

fn rename_with_timeout(
    from: &std::path::Path,
    to: &std::path::Path,
    timeout: std::time::Duration,
) -> Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let src = from.to_path_buf();
    let dest = to.to_path_buf();
    let _ = std::thread::Builder::new()
        .name("wt-session-fs-rename".into())
        .spawn(move || {
            let _ = tx.send(fs::rename(&src, &dest));
        });
    match rx.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e).context("renaming session.json"),
        Err(_) => anyhow::bail!(
            "timed out after {:?} renaming {} -> {}",
            timeout,
            from.display(),
            to.display()
        ),
    }
}

fn read_path_with_timeout(path: &std::path::Path, timeout: std::time::Duration) -> Result<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let probe = path.to_path_buf();
    let _ = std::thread::Builder::new()
        .name("wt-session-read".into())
        .spawn(move || {
            let _ = tx.send(fs::read(&probe));
        });
    match rx.recv_timeout(timeout) {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => Err(e).context("reading session.json"),
        Err(_) => anyhow::bail!(
            "timed out after {:?} reading {}",
            timeout,
            path.display()
        ),
    }
}

fn quarantine_session_file(path: &std::path::Path) -> Result<()> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut dest = path.to_path_buf();
    dest.set_file_name(format!("session.corrupt-{ts}.json"));
    fs::rename(path, &dest)
        .with_context(|| format!("quarantine {} -> {}", path.display(), dest.display()))?;
    log::warn!("wezterminator: moved broken session to {}", dest.display());
    Ok(())
}

pub fn apply(session: &Session) -> (usize, usize, usize) {
    let Some(mux) = Mux::try_get() else {
        return (0, 0, 0);
    };
    let mut applied_tabs = 0usize;
    let mut applied_panes = 0usize;
    let mut skipped = 0usize;
    // Patch 0148: with a host, windows are matched by their host panes
    // (`window_geom`), never by enumeration index, which changes on
    // every re-attach and shuffled the names.
    let index_names_ok = !crate::window_geom::store_has_windows();
    for (window_index, window_id) in mux.iter_windows().into_iter().enumerate() {
        if !index_names_ok {
            break;
        }
        if let Some(entry) = session
            .windows
            .iter()
            .find(|window| window.window_index == window_index)
        {
            if let Some(ref title) = entry.user_title {
                if let Some(mut window) = mux.get_window_mut(window_id) {
                    window.set_user_title(Some(title.clone()));
                }
            }
        }
    }
    for window_id in mux.iter_windows() {
        let Some(window) = mux.get_window(window_id) else {
            continue;
        };
        for (tab_index, tab) in window.iter().enumerate() {
            if let Some(tab_entry) = session.tabs.get(tab_index) {
                tab.set_group_name(tab_entry.group_name.clone());
                if let Some(ref title) = tab_entry.tab_title {
                    tab.set_title(title);
                }
                // WezTerminator (patch 0031): restore the
                // user-set title override. Only call
                // `set_user_title` when the persisted value
                // is `Some` so we do not clobber the
                // user-set value on a brand-new tab whose
                // loaded entry has no `user_title` (the
                // default for v5 files that predate patch
                // 0031).
                if let Some(ref user_title) = tab_entry.user_title {
                    tab.set_user_title(Some(user_title.clone()));
                }
                applied_tabs += 1;
            }
        }
        break;
    }
    for pane_entry in &session.panes {
        if pane_entry.header_text.is_some()
            || pane_entry.theme_id.is_some()
            || pane_entry.font_family.is_some()
            || pane_entry.font_scale.is_some()
            || pane_entry.font_bold
            || pane_entry.font_italic
        {
            for window_id in mux.iter_windows() {
                let Some(window) = mux.get_window(window_id) else {
                    continue;
                };
                if let Some(tab) = window.iter().nth(pane_entry.tab_index) {
                    let panes = tab.iter_panes();
                    let tab_panes: Vec<&PaneEntry> = session
                        .panes
                        .iter()
                        .filter(|p| p.tab_index == pane_entry.tab_index)
                        .collect();
                    let idx = tab_panes
                        .iter()
                        .position(|p| std::ptr::eq(*p, pane_entry))
                        .unwrap_or(0);
                    if let Some(pos) = panes.get(idx) {
                        pos.pane.set_header_text(pane_entry.header_text.clone());
                        if let Some(scale) = pane_entry.font_scale {
                            pos.pane.set_font_scale(scale);
                        }
                        pos.pane.set_font_family(pane_entry.font_family.clone());
                        pos.pane.set_font_bold(pane_entry.font_bold);
                        pos.pane.set_font_italic(pane_entry.font_italic);
                        #[cfg(windows)]
                        if let Some(ref theme) = pane_entry.theme_id {
                            if let Some(palette) =
                                crate::notify_ipc::palette_from_theme_id(theme)
                            {
                                pos.pane.set_palette(palette);
                                pos.pane.set_theme_id(Some(theme.clone()));
                            }
                        }
                        applied_panes += 1;
                    }
                }
                break;
            }
        } else {
            skipped += 1;
        }
    }
    (applied_tabs, applied_panes, skipped)
}

/// Patch 0163: panes of `tab_index` worth restoring. A pane saved with
/// fewer than 3 columns or 2 rows is a leftover of an earlier bad
/// restore; recreating it only adds another sliver. The first pane is
/// always kept so the tab is never empty.
pub fn restorable_panes(panes: &[PaneEntry], tab_index: usize) -> Vec<&PaneEntry> {
    panes
        .iter()
        .filter(|p| p.tab_index == tab_index)
        .enumerate()
        .filter(|(i, p)| *i == 0 || (p.width >= 3 && p.height >= 2))
        .map(|(_, p)| p)
        .collect()
}

/// Patch 0163: size of the new pane when restore splits pane `i - 1`
/// to create pane `i`. Restore splits the newest pane each time, so the
/// pane being split holds panes `i - 1 ..`; a fixed 50% halved every
/// later pane (1-column slivers). Uses widths for a side-by-side split
/// and heights for a stacked one.
pub fn split_percent(panes: &[&PaneEntry], i: usize, side_by_side: bool) -> u8 {
    let dim = |p: &&PaneEntry| if side_by_side { p.width } else { p.height };
    let (Some(rest), Some(all)) = (panes.get(i..), panes.get(i.saturating_sub(1)..)) else {
        return 50;
    };
    let rest: usize = rest.iter().map(dim).sum();
    let all: usize = all.iter().map(dim).sum();
    if all == 0 || i == 0 {
        return 50;
    }
    ((rest * 100 / all).clamp(10, 90)) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(tab_index: usize, left: usize, top: usize, width: usize, height: usize) -> PaneEntry {
        PaneEntry {
            tab_index,
            header_text: None,
            program: None,
            args: Vec::new(),
            cwd: None,
            left,
            top,
            width,
            height,
            is_active: false,
            font_scale: None,
            theme_id: None,
            font_family: None,
            font_bold: false,
            font_italic: false,
        }
    }

    #[test]
    fn slivers_are_not_restored() {
        let panes = vec![
            pane(5, 0, 0, 90, 51),
            pane(5, 91, 0, 1, 51),
            pane(5, 93, 0, 1, 51),
            pane(5, 95, 0, 91, 51),
            pane(6, 0, 0, 190, 45),
        ];
        let kept = restorable_panes(&panes, 5);
        assert_eq!(kept.iter().map(|p| p.width).collect::<Vec<_>>(), vec![90, 91]);
        assert_eq!(restorable_panes(&panes, 6).len(), 1);
    }

    #[test]
    fn splits_follow_saved_sizes() {
        let panes = [pane(0, 0, 0, 60, 40), pane(0, 61, 0, 60, 40), pane(0, 122, 0, 60, 40)];
        let refs: Vec<&PaneEntry> = panes.iter().collect();
        // Three equal columns: 2/3 then 1/2, not 1/2 then 1/4.
        assert_eq!(split_percent(&refs, 1, true), 66);
        assert_eq!(split_percent(&refs, 2, true), 50);
        assert_eq!(split_percent(&refs, 9, true), 50);
    }

    #[test]
    fn unchanged_bytes_are_skipped_until_they_change() {
        // Reset the record so the test is order-independent.
        *LAST_WRITTEN.lock().unwrap() = None;
        assert!(!unchanged_since_last_write(b"{\"a\":1}"), "first write goes through");
        assert!(unchanged_since_last_write(b"{\"a\":1}"), "identical bytes are skipped");
        assert!(!unchanged_since_last_write(b"{\"a\":2}"), "changed bytes are written");
        assert!(unchanged_since_last_write(b"{\"a\":2}"));
    }

    #[test]
    fn auto_save_rate_guard_collapses_duplicate_timers() {
        *LAST_AUTO_SAVE.lock().unwrap() = None;
        assert!(auto_save_due(), "first tick runs");
        assert!(!auto_save_due(), "a second timer's tick right after is skipped");
        *LAST_AUTO_SAVE.lock().unwrap() =
            Some(std::time::Instant::now() - AUTO_SAVE_MIN_INTERVAL - std::time::Duration::from_secs(1));
        assert!(auto_save_due(), "runs again once the interval has passed");
    }

    #[test]
    fn session_round_trip_preserves_data() {
        let s = Session {
            version: SESSION_VERSION,
            tabs: vec![
                TabEntry {
                    window_index: 0,
                    group_name: Some("frontend".to_string()),
                    tab_title: Some("my tab".to_string()),
                    user_title: Some("frontend-build".to_string()),
                },
                TabEntry {
                    window_index: 1,
                    group_name: None,
                    tab_title: None,
                    user_title: None,
                },
            ],
            panes: vec![
                PaneEntry {
                    tab_index: 0,
                    header_text: Some("build-watch".to_string()),
                    program: Some("cmd.exe".to_string()),
                    args: vec![],
                    cwd: Some("C:\\Users\\test".to_string()),
                    left: 0,
                    top: 0,
                    width: 80,
                    height: 24,
                    is_active: true,
                    font_scale: None,
                    theme_id: None,
                    font_family: None,
                    font_bold: false,
                    font_italic: false,
                },
            ],
            windows: vec![WindowEntry {
                window_index: 1,
                user_title: Some("backend".to_string()),
            }],
        };
        let bytes = serde_json::to_vec(&s).unwrap();
        let parsed: Session = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(s, parsed);
        assert_eq!(parsed.tabs[1].window_index, 1);
        assert_eq!(
            parsed.windows[0].user_title.as_deref(),
            Some("backend")
        );
    }

    #[test]
    fn session_v8_file_loads_into_v9_with_empty_windows() {
        let json = r#"{
            "version": 8,
            "tabs": [
                { "window_index": 1, "user_title": "frontend-build" }
            ],
            "panes": []
        }"#;
        let parsed: Session = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.version, 8);
        assert!(parsed.windows.is_empty());
        assert_eq!(parsed.tabs[0].window_index, 1);
        let reserialized = serde_json::to_string(&parsed).unwrap();
        assert!(
            !reserialized.contains("\"windows\""),
            "empty windows should be skipped: {}",
            reserialized
        );
    }

    #[test]
    fn session_v5_schema_serializes_cleanly() {
        let json = r#"{
            "version": 5,
            "tabs": [
                { "group_name": "frontend", "tab_title": "my tab" },
                { "group_name": null }
            ],
            "panes": [
                { "tab_index": 0, "program": "powershell.exe", "cwd": "C:\\Users", "left": 0, "top": 0, "width": 120, "height": 40, "is_active": true }
            ]
        }"#;
        let parsed: Session = serde_json::from_str(json).unwrap();
        // The JSON declares `version: 5`. It loads
        // cleanly into the current v6 schema (the new
        // `user_title` field defaults to `None`).
        assert_eq!(parsed.version, 5);
        assert!(parsed.version <= SESSION_VERSION);
        assert_eq!(parsed.tabs.len(), 2);
        assert!(parsed.tabs.iter().all(|tab| tab.window_index == 0));
        assert_eq!(parsed.tabs[0].group_name, Some("frontend".to_string()));
        assert_eq!(parsed.panes.len(), 1);
        assert_eq!(parsed.panes[0].tab_index, 0);
        assert_eq!(parsed.panes[0].program, Some("powershell.exe".to_string()));
    }

    #[test]
    fn session_v5_file_loads_into_v6_with_default_user_title() {
        // Patch 0031: a v5 file (no `user_title` field on
        // `TabEntry`) must load cleanly into the current
        // v6 schema. The new field defaults to `None`
        // because of `serde(default)`, so the load is
        // transparent.
        let json = r#"{
            "version": 5,
            "tabs": [
                { "group_name": "frontend", "tab_title": "my tab" },
                { "group_name": "backend",  "tab_title": null }
            ],
            "panes": []
        }"#;
        let parsed: Session = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.tabs.len(), 2);
        assert_eq!(parsed.tabs[0].user_title, None);
        assert_eq!(parsed.tabs[1].user_title, None);
        // Round-trip back to JSON; the `user_title` field
        // should be skipped (not written) because it is
        // `None` and the struct has
        // `skip_serializing_if = "Option::is_none"`.
        let reserialized = serde_json::to_string(&parsed).unwrap();
        assert!(
            !reserialized.contains("user_title"),
            "user_title should be skipped when None: {}",
            reserialized
        );
    }

    #[test]
    fn session_v6_round_trip_preserves_user_title() {
        // Patch 0031: a v6 file (with `user_title`) must
        // round-trip cleanly. The `user_title` field is
        // written only when it is `Some` (non-None); a
        // tab without a user-set title has no
        // `user_title` key in the JSON at all.
        let s = Session {
            version: SESSION_VERSION,
            tabs: vec![
                TabEntry {
                    window_index: 0,
                    group_name: Some("frontend".to_string()),
                    tab_title: None,
                    user_title: Some("frontend-build".to_string()),
                },
                TabEntry {
                    window_index: 0,
                    group_name: None,
                    tab_title: None,
                    user_title: None,
                },
            ],
            panes: vec![],
            windows: vec![],
        };
        let bytes = serde_json::to_vec(&s).unwrap();
        let parsed: Session = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(s, parsed);
        let json_str = std::str::from_utf8(&bytes).unwrap();
        assert!(
            json_str.contains("\"user_title\":\"frontend-build\""),
            "user_title should be present: {}",
            json_str
        );
    }

    #[test]
    fn session_default_version_is_current() {
        let json = r#"{"tabs":[]}"#;
        let parsed: Session = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.version, SESSION_VERSION);
        assert!(parsed.panes.is_empty());
    }

    #[test]
    fn session_rejects_unknown_version() {
        let s = Session {
            version: 999,
            tabs: vec![],
            panes: vec![],
            windows: vec![],
        };
        let bytes = serde_json::to_vec(&s).unwrap();
        let parsed: Session = serde_json::from_slice(&bytes).unwrap();
        assert!(parsed.version > SESSION_VERSION);
    }

    #[test]
    fn apply_with_no_mux_is_a_no_op() {
        let s = Session {
            version: SESSION_VERSION,
            tabs: vec![TabEntry {
                window_index: 0,
                group_name: Some("x".to_string()),
                tab_title: None,
                user_title: None,
            }],
            panes: vec![],
            windows: vec![],
        };
        let (applied_tabs, applied_panes, skipped) = apply(&s);
        assert_eq!(applied_tabs, 0);
        assert_eq!(applied_panes, 0);
        assert_eq!(skipped, 0);
    }

    #[test]
    fn snapshot_with_no_mux_returns_empty() {
        let s = snapshot().unwrap();
        assert_eq!(s.version, SESSION_VERSION);
        assert!(s.tabs.is_empty());
    }

    #[test]
    fn session_path_is_under_a_bethterm_dir() {
        let p = session_path().unwrap();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(SESSION_FILENAME));
        let ancestors: Vec<String> = p
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();
        assert!(
            ancestors
                .iter()
                .any(|c| c == crate::DATA_DIR_NAME || c == crate::LEGACY_DATA_DIR_NAME),
            "session path {:?} is not under a bethterm/ (or legacy wezterminator/) dir",
            p
        );
    }

    #[test]
    fn pane_entry_has_layout_fields() {
        let e = PaneEntry {
            tab_index: 0,
            header_text: None,
            program: Some("powershell.exe".to_string()),
            args: vec!["-NoLogo".to_string()],
            cwd: Some("C:\\Users\\dev".to_string()),
            left: 0,
            top: 0,
            width: 120,
            height: 40,
            is_active: true,
            font_scale: None,
            theme_id: None,
            font_family: None,
            font_bold: false,
            font_italic: false,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"program\":\"powershell.exe\""));
        assert!(json.contains("\"cwd\":\"C:\\\\Users\\\\dev\""));
        assert!(json.contains("\"is_active\":true"));
    }

    #[test]
    fn session_fs_helpers_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "bethterm-session-fs-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let tmp = dir.join("session.json.tmp");
        let dest = dir.join("session.json");
        write_path_with_timeout(&tmp, b"{\"tabs\":[]}", std::time::Duration::from_secs(2))
            .unwrap();
        rename_with_timeout(&tmp, &dest, std::time::Duration::from_secs(2)).unwrap();
        let bytes = read_path_with_timeout(&dest, std::time::Duration::from_secs(2)).unwrap();
        assert_eq!(bytes, b"{\"tabs\":[]}");
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir(&dir);
    }
}
