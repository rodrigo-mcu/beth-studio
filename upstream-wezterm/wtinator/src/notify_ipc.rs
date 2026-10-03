// wtinator::notify_ipc — Phase 1.G (patch 0034).
//
// Named-pipe IPC server that exposes a small
// JSON-RPC-style interface to the
// `wtinator-config` companion app. The server
// runs on a dedicated `std::thread` started by
// `wezterm-gui` at window creation; the pipe name
// is `\\.\pipe\wtinator-config-<pid>` where `<pid>`
// is the wezterm-gui process id (so multiple
// wezterm-gui instances do not stomp on each
// other's pipes).
//
// Wire format: one JSON object per line. Each
// request is a `Request`; each reply is a
// `Response`. A request is matched with its
// reply by the `id` field. The server is
// line-oriented — `serde_json` decodes each
// line and the server loops over `ReadFile`
// until the client closes the pipe.
//
// Threading: the server runs on its own
// `std::thread` so a slow / dead client cannot
// block the wezterm-gui main thread. The
// thread-safety boundary is the `mux::Mux` lock
// (which the server takes when handling
// requests that need to read the mux). The
// server NEVER calls into `TermWindow` directly
// — for write operations (e.g. set_theme) it
// posts a `TermWindowNotif::Apply` closure to
// the GUI thread via the `GuiWin::notify`
// channel, mirroring the pattern in patches
// 0030.5 / 0031 / 0032.

#![cfg(windows)]

use mux::Mux;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use wezterm_term::color::ColorPalette;
use crate::notify::ConfigSnapshot;

/// The IPC pipe name template. The `<pid>` is
/// the wezterm-gui process id. The full pipe
/// name is `\\.\pipe\wtinator-config-<pid>`.
pub const PIPE_NAME_TEMPLATE: &str = "\\\\.\\pipe\\wtinator-config-";

/// Build the full pipe name for a given PID.
pub fn pipe_name_for_pid(pid: u32) -> String {
    format!("{}{}", PIPE_NAME_TEMPLATE, pid)
}

/// A request from the config app. One JSON
/// object per line over the named pipe.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    /// `{"type":"list_tabs","id":1}` — returns
    /// the full `ConfigSnapshot` (tabs + themes).
    #[serde(rename = "list_tabs")]
    ListTabs {
        #[serde(default)]
        id: Option<u32>,
    },
    /// `{"type":"set_theme","id":2,"tab_id":7,"theme":"vscode_dark"}`
    /// — applies the named theme to the active
    /// pane of the given tab. Returns
    /// `{"ok":true}` on success.
    #[serde(rename = "set_theme")]
    SetTheme {
        #[serde(default)]
        id: Option<u32>,
        tab_id: usize,
        theme: String,
    },
    /// `{"type":"ping","id":3}` — returns
    /// `{"pong":true}`. Used by the config app to
    /// detect that the GUI is still alive.
    #[serde(rename = "ping")]
    Ping {
        #[serde(default)]
        id: Option<u32>,
    },
    /// `{"type":"download_themes","id":4}` — fetches
    /// the Gogh community theme catalog and caches each
    /// theme under `%APPDATA%\wezterminator\themes\`.
    /// Returns `{"ok":true}` on success, or an error.
    /// Does NOT touch the GUI thread (it only writes
    /// files); the config app refreshes its theme grid
    /// after the reply. (Patch 0038.) The optional `id`
    /// here is the request-correlation id (it is NOT a
    /// tab id — there is no `tab_id` field).
    #[serde(rename = "download_themes")]
    DownloadThemes {
        #[serde(default)]
        id: Option<u32>,
    },
    /// WezTerminator (patch 0040):
    /// `{"type":"set_pane_theme","id":5,"pane_id":12,"theme":"dracula"}`
    /// — applies the named theme to **one specific pane**
    /// (the pane the user right-clicked), not the active
    /// pane of a tab. This is the per-terminal config
    /// window's theme path. Returns `{"ok":true}` on
    /// success, or `{"error":..}` if the theme id is
    /// unknown. (`SetTheme` targets a tab's active pane;
    /// this targets an exact pane by id.)
    #[serde(rename = "set_pane_theme")]
    SetPaneTheme {
        #[serde(default)]
        id: Option<u32>,
        pane_id: usize,
        theme: String,
    },
    /// WezTerminator (patch 0040):
    /// `{"type":"set_pane_font_size","id":6,"pane_id":12,"size":18.0}`
    /// — sets an **absolute** font size (in points) on one
    /// specific pane. The GUI thread converts the absolute
    /// size to a per-pane scale relative to the window's
    /// base font size and reflows that pane's PTY (patch
    /// 0039 machinery). Returns `{"ok":true}`.
    #[serde(rename = "set_pane_font_size")]
    SetPaneFontSize {
        #[serde(default)]
        id: Option<u32>,
        pane_id: usize,
        size: f64,
    },
    /// WezTerminator (patch 0043):
    /// `{"type":"set_pane_font_family","id":7,"pane_id":12,"family":"JetBrains Mono"}`
    /// — sets the font FAMILY (typeface) on one specific pane. `family`
    /// is `null` (or absent) to CLEAR the override and return the pane
    /// to the window font. The GUI thread records the family on the
    /// pane, recomputes its cell scale, reflows the owning tab's PTY
    /// grid, and invalidates the line/shape caches (a same-size family
    /// change does not move the geometry-derived cache keys, so the
    /// cache must be cleared explicitly — see
    /// `TermWindow::apply_pane_font_scale_change`). Returns
    /// `{"ok":true}`.
    #[serde(rename = "set_pane_font_family")]
    SetPaneFontFamily {
        #[serde(default)]
        id: Option<u32>,
        pane_id: usize,
        #[serde(default)]
        family: Option<String>,
    },
    /// WezTerminator (patch 0047):
    /// `{"type":"set_pane_font_style","id":9,"pane_id":12,"bold":true,"italic":false}`
    /// — sets the font WEIGHT (bold) and STYLE (italic) on one pane. The
    /// GUI rebuilds the pane's styled FontConfiguration, recomputes its
    /// cell aspect and reflows. Returns `{"ok":true}`.
    #[serde(rename = "set_pane_font_style")]
    SetPaneFontStyle {
        #[serde(default)]
        id: Option<u32>,
        pane_id: usize,
        #[serde(default)]
        bold: bool,
        #[serde(default)]
        italic: bool,
    },
    /// WezTerminator (patch 0043):
    /// `{"type":"list_fonts","id":8}` — returns the list of font family
    /// names the resolver can actually load on this host, so the config
    /// app's family picker shows exactly the accepted names. The list is
    /// enumerated by the GUI (`wezterm-font`'s `list_system_fonts`) at
    /// startup and stashed in a process-global (`set_available_fonts`);
    /// `mux`/`wtinator` never depend on `wezterm-font`. Returns
    /// `{"fonts":[...]}`.
    #[serde(rename = "list_fonts")]
    ListFonts {
        #[serde(default)]
        id: Option<u32>,
    },
    /// Beth Studio (patch 0110):
    /// `{"type":"set_default_theme","id":10,"theme":"dracula"}`
    /// — persists `theme` as the default for new terminals and applies
    /// it to every live pane in every window. Empty `theme` clears the
    /// saved default without recolouring open panes.
    /// Beth Studio (patch 0132): the optional font fields make the
    /// default a full style. `font_size` is in points (converted to a
    /// scale against the window base size). Omitted fields keep the
    /// previously saved font.
    #[serde(rename = "set_default_theme")]
    SetDefaultTheme {
        #[serde(default)]
        id: Option<u32>,
        theme: String,
        #[serde(default)]
        font_family: Option<String>,
        #[serde(default)]
        font_size: Option<f64>,
        #[serde(default)]
        font_bold: Option<bool>,
        #[serde(default)]
        font_italic: Option<bool>,
    },
}

/// A response to the config app. The `id` field
/// (when present) echoes the request id so the
/// client can correlate requests and replies.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    #[serde(flatten)]
    pub body: ResponseBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponseBody {
    /// Successful `list_tabs` reply.
    Snapshot { snapshot: ConfigSnapshot },
    /// WezTerminator (patch 0043): successful `list_fonts` reply — the
    /// font family names the host can load. Placed before `Ok` so the
    /// untagged deserializer tries the richer shape first.
    Fonts { fonts: Vec<String> },
    /// Successful `set_theme` or `ping` reply.
    Ok { ok: bool },
    /// Error reply.
    Error { error: String },
}

/// WezTerminator (patch 0043): process-global list of font family
/// names the resolver can load on this host. The GUI populates it once
/// at startup via `set_available_fonts` (it owns the `wezterm-font`
/// `FontConfiguration`); the pipe server thread reads it for
/// `list_fonts` requests. This keeps `wtinator` free of any
/// `wezterm-font` dependency — the names cross the crate boundary as
/// plain `String`s.
static AVAILABLE_FONTS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

/// Store the enumerated font family names. Idempotent: the first call
/// wins (the font set does not change over a process's lifetime).
/// Called by the GUI host (`wezterm-gui`) once at window creation.
pub fn set_available_fonts(mut fonts: Vec<String>) {
    fonts.sort();
    fonts.dedup();
    let _ = AVAILABLE_FONTS.set(fonts);
}

/// Read the enumerated font family names (empty until the GUI has
/// populated them). Used by the `list_fonts` IPC handler.
pub fn available_fonts() -> Vec<String> {
    AVAILABLE_FONTS.get().cloned().unwrap_or_default()
}

/// Compute a `ColorPalette` from a theme id
/// string. The id is one of:
/// - `"vscode_light"` → `ThemeId::VsCodeLight`
/// - `"vscode_dark"` → `ThemeId::VsCodeDark`
/// - `"windows_terminal_dark"` →
///   `ThemeId::WindowsTerminalDark`
/// - `"default"` → vscode_dark (closest baked-in;
///   a follow-up patch can plumb the upstream
///   wezterm default)
/// - any downloaded theme id (slug) → built from the cached
///   `%APPDATA%\wezterminator\themes\<id>.json` via
///   `theme_download::palette_for_saved` (patch 0038).
pub fn palette_from_theme_id(id: &str) -> Option<ColorPalette> {
    crate::default_theme::palette_for(id)
}

/// Beth Studio (patch 0110): apply a theme to every live pane in every
/// mux window. Collects pane ids first so we do not hold a window
/// lock while mutating palettes. Returns the number of panes touched.
pub fn apply_theme_to_all_panes(
    palette: ColorPalette,
    theme_id: Option<String>,
) -> Result<usize, String> {
    let mux = Mux::get();
    let mut pane_ids = Vec::new();
    for window_id in mux.iter_windows() {
        if let Some(window) = mux.get_window(window_id) {
            for tab in window.iter() {
                for pos in tab.iter_panes_ignoring_zoom() {
                    pane_ids.push(pos.pane.pane_id());
                }
            }
        }
    }
    let mut n = 0usize;
    for pane_id in pane_ids {
        if apply_theme_to_pane(pane_id, palette.clone(), theme_id.clone()).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// Beth Studio (patch 0132): stamp the default font on every live pane and
/// reflow every tab. Runs on the GUI thread (via `notify_apply`).
pub fn apply_font_to_all_panes(style: &crate::default_theme::DefaultStyle) -> usize {
    let mux = Mux::get();
    let mut n = 0usize;
    for window_id in mux.iter_windows() {
        if let Some(window) = mux.get_window(window_id) {
            for tab in window.iter() {
                for pos in tab.iter_panes_ignoring_zoom() {
                    crate::default_theme::apply_font_to_pane(&*pos.pane, style);
                    n += 1;
                }
                // Re-flow each leaf's PTY via `scale_size` (mirrors the
                // per-pane font size handler).
                tab.resize(tab.get_size());
            }
        }
    }
    n
}

/// Apply a theme to a tab. Returns `Ok(())` on
/// success, `Err(msg)` on failure. The caller
/// posts a `TermWindowNotif::Apply` closure to
/// the GUI thread that calls this.
pub fn apply_theme_to_tab(tab_id: usize, palette: ColorPalette) -> Result<(), String> {
    let mux = Mux::get();
    let tab = mux
        .get_tab(tab_id)
        .ok_or_else(|| format!("tab {} not found", tab_id))?;
    let pane = tab
        .get_active_pane()
        .ok_or_else(|| format!("tab {} has no active pane", tab_id))?;
    pane.set_palette(palette);
    Ok(())
}

/// WezTerminator (patch 0040): apply a theme to one
/// specific pane (by id), not a tab's active pane.
/// Returns `Ok(())` on success, `Err(msg)` if the
/// pane is gone. The caller posts a
/// `TermWindowNotif::Apply` closure to the GUI thread
/// that calls this.
pub fn apply_theme_to_pane(
    pane_id: usize,
    palette: ColorPalette,
    theme_id: Option<String>,
) -> Result<(), String> {
    let mux = Mux::get();
    let pane = mux
        .get_pane(pane_id)
        .ok_or_else(|| format!("pane {} not found", pane_id))?;
    pane.set_palette(palette);
    // WezTerminator (patch 0041): record which theme produced these
    // colours so `wtinator::session` can persist + restore the
    // per-pane theme across restarts.
    pane.set_theme_id(theme_id);
    Ok(())
}

/// WezTerminator (patch 0043): set the font FAMILY on one specific pane
/// (by id). `family == None` clears the override (back to the window
/// font). This records only the *intent* on the mux pane; the GUI's
/// `apply_pane_font_scale_change` (invoked right after by the pipe
/// server's apply closure) computes the resulting cell geometry,
/// reflows the PTY, and clears the render caches. Returns `Ok(())` on
/// success, `Err(msg)` if the pane is gone.
pub fn apply_font_family_to_pane(
    pane_id: usize,
    family: Option<String>,
) -> Result<(), String> {
    let mux = Mux::get();
    let pane = mux
        .get_pane(pane_id)
        .ok_or_else(|| format!("pane {} not found", pane_id))?;
    pane.set_font_family(family);
    Ok(())
}

/// Read a complete request from the pipe (one
/// line of UTF-8 JSON, terminated by `\n`).
fn read_request<R: BufRead>(reader: &mut R) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    let n = reader.read_line(&mut line)?;
    if n == 0 {
        return Ok(None);
    }
    let req: Request = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(e) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid JSON request: {}", e),
            ));
        }
    };
    Ok(Some(req))
}

/// Write a complete response to the pipe (one
/// line of UTF-8 JSON, terminated by `\n`).
fn write_response<W: Write>(writer: &mut W, resp: &Response) -> std::io::Result<()> {
    let s = serde_json::to_string(resp).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("failed to serialize response: {}", e),
        )
    })?;
    writer.write_all(s.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

/// A callback that posts a `TermWindowNotif::Apply`
/// closure to the GUI thread. The closure runs
/// on the main thread, where it is safe to call
/// `mux::Mux::get()` and `pane.set_palette()`.
///
/// In the `wezterm-gui` caller, the callback is
/// `Box::new(move |f| gui_window.notify(
/// TermWindowNotif::Apply(Box::new(f))))`. We
/// accept the callback as a `Box<dyn Fn + Send>`
/// so it can be called multiple times (the pipe
/// server handles many requests in a loop).
pub type ApplyCallback = Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync + 'static>;

/// Handle one client connection. The function
/// loops over `read_request` until the client
/// closes the pipe (EOF) or an I/O error
/// occurs. Each request is dispatched to the
/// `handle_request` helper which produces a
/// `Response`.
///
/// **MVP scope (patch 0034):** this function
/// is provided as a reference for the wire
/// format; the actual named-pipe server is wired
/// up in `wezterm-gui/src/termwindow/notify_pipe.rs`
/// (patch 0034.5, follow-up). The MVP just
/// ships the data model + the request/response
/// types so the React app can be built against
/// a stable contract.
pub fn handle_client<R: BufRead, W: Write>(
    mut reader: R,
    mut writer: W,
    notify_apply: ApplyCallback,
) -> std::io::Result<()> {
    loop {
        let req = match read_request(&mut reader) {
            Ok(Some(r)) => r,
            Ok(None) => return Ok(()), // EOF
            Err(e) => {
                log::warn!(
                    "wezterminator patch 0034: read_request failed: {}",
                    e
                );
                return Err(e);
            }
        };
        let resp = handle_request(req, &notify_apply);
        if let Err(e) = write_response(&mut writer, &resp) {
            log::warn!(
                "wezterminator patch 0034: write_response failed: {}",
                e
            );
            return Err(e);
        }
    }
}

/// Handle a single request. Returns the
/// response. `notify_apply` is the callback
/// into the GUI thread for write operations;
/// it is called at most once per
/// `handle_request` call (only for `set_theme`).
pub fn handle_request(req: Request, notify_apply: &ApplyCallback) -> Response {
    let id = match &req {
        Request::ListTabs { id } => *id,
        Request::SetTheme { id, .. } => *id,
        Request::Ping { id } => *id,
        Request::DownloadThemes { id } => *id,
        Request::SetPaneTheme { id, .. } => *id,
        Request::SetPaneFontSize { id, .. } => *id,
        Request::SetPaneFontFamily { id, .. } => *id,
        Request::SetPaneFontStyle { id, .. } => *id,
        Request::ListFonts { id } => *id,
        Request::SetDefaultTheme { id, .. } => *id,
    };
    let body = match req {
        Request::ListTabs { .. } => {
            let snap = crate::notify::snapshot_for_config();
            ResponseBody::Snapshot { snapshot: snap }
        }
        Request::Ping { .. } => ResponseBody::Ok { ok: true },
        Request::DownloadThemes { .. } => {
            // Patch 0038: fetch + cache the Gogh catalog. This runs
            // on the pipe-server thread (NOT the GUI thread) — it
            // only does a blocking HTTP GET + file writes, both of
            // which are safe off the main thread. The config app
            // re-issues `list_tabs` after this reply to pick up the
            // new `UserDownloaded` themes.
            match crate::theme_download::download_catalog() {
                Ok(result) => {
                    log::info!(
                        "bethstudio: installed {} theme(s) ({:?})",
                        result.count,
                        result.source
                    );
                    ResponseBody::Ok { ok: true }
                }
                Err(e) => ResponseBody::Error {
                    error: format!("theme download failed: {:#}", e),
                },
            }
        }
        Request::SetTheme { tab_id, theme, .. } => {
            let palette = match palette_from_theme_id(&theme) {
                Some(p) => p,
                None => {
                    return Response {
                        id,
                        body: ResponseBody::Error {
                            error: format!("unknown theme: {}", theme),
                        },
                    };
                }
            };
            // Post the apply to the GUI thread.
            // The closure runs on the main thread,
            // so it can safely call
            // `apply_theme_to_tab` (which takes
            // the mux lock).
            notify_apply(Box::new(move || {
                if let Err(e) = apply_theme_to_tab(tab_id, palette) {
                    log::warn!(
                        "wezterminator patch 0034: set_theme failed: {}",
                        e
                    );
                }
            }));
            ResponseBody::Ok { ok: true }
        }
        // WezTerminator (patch 0040): per-pane theme. Mirrors
        // `SetTheme` but targets one exact pane by id (the
        // right-clicked pane) instead of a tab's active pane.
        Request::SetPaneTheme { pane_id, theme, .. } => {
            let palette = match palette_from_theme_id(&theme) {
                Some(p) => p,
                None => {
                    return Response {
                        id,
                        body: ResponseBody::Error {
                            error: format!("unknown theme: {}", theme),
                        },
                    };
                }
            };
            notify_apply(Box::new(move || {
                if let Err(e) = apply_theme_to_pane(pane_id, palette, Some(theme)) {
                    log::warn!(
                        "wezterminator patch 0040: set_pane_theme failed: {}",
                        e
                    );
                }
            }));
            ResponseBody::Ok { ok: true }
        }
        // WezTerminator (patch 0040): per-pane absolute font
        // size. We convert the absolute point size to a scale
        // relative to the window's base `font_size` and drive
        // the patch-0039 per-pane scale machinery, then reflow
        // the owning tab so the pane's PTY picks up the new
        // cell size. No TermWindow cache clearing is needed:
        // the shape cache key includes `pane_font_scale` and
        // the quad cache key includes the (now scaled)
        // `top_pixel_y`, so a changed scale yields fresh cache
        // keys; the PTY resize marks lines dirty, and the pipe
        // server invalidates the window after each apply.
        Request::SetPaneFontSize { pane_id, size, .. } => {
            notify_apply(Box::new(move || {
                let base = config::configuration().font_size;
                let scale = if base > 0.0 { size / base } else { 1.0 };
                let mux = mux::Mux::get();
                if let Some(pane) = mux.get_pane(pane_id) {
                    // `LocalPane::set_font_scale` clamps to 0.25..=6.0.
                    pane.set_font_scale(scale);
                    if let Some((_, _, tab_id)) = mux.resolve_pane_id(pane_id) {
                        if let Some(tab) = mux.get_tab(tab_id) {
                            // Re-flow each leaf's PTY via `scale_size`
                            // using the pane's new scale.
                            tab.resize(tab.get_size());
                        }
                    }
                } else {
                    log::warn!(
                        "wezterminator patch 0040: set_pane_font_size: pane {} not found",
                        pane_id
                    );
                }
            }));
            ResponseBody::Ok { ok: true }
        }
        // WezTerminator (patch 0043): per-pane font FAMILY. The closure
        // records the family on the mux pane; the pipe server's apply
        // wrapper then calls `TermWindow::apply_pane_font_scale_change`,
        // which recomputes the override's cell geometry, reflows the
        // owning tab, and clears the line/shape caches. `family == None`
        // clears the override.
        Request::SetPaneFontFamily {
            pane_id, family, ..
        } => {
            notify_apply(Box::new(move || {
                if let Err(e) = apply_font_family_to_pane(pane_id, family) {
                    log::warn!(
                        "wezterminator patch 0043: set_pane_font_family failed: {}",
                        e
                    );
                }
            }));
            ResponseBody::Ok { ok: true }
        }
        // WezTerminator (patch 0047): per-pane bold / italic. Records the
        // style on the mux pane; the pipe server's apply wrapper then
        // calls `apply_pane_font_scale_change`, which rebuilds the styled
        // metrics, recomputes the cell aspect and reflows.
        Request::SetPaneFontStyle {
            pane_id,
            bold,
            italic,
            ..
        } => {
            notify_apply(Box::new(move || {
                let mux = mux::Mux::get();
                if let Some(pane) = mux.get_pane(pane_id) {
                    pane.set_font_bold(bold);
                    pane.set_font_italic(italic);
                } else {
                    log::warn!(
                        "wezterminator patch 0047: set_pane_font_style: pane {} not found",
                        pane_id
                    );
                }
            }));
            ResponseBody::Ok { ok: true }
        }
        // WezTerminator (patch 0043): font enumeration. Pure read of the
        // process-global font list the GUI populated at startup; no GUI
        // thread hop needed.
        Request::ListFonts { .. } => ResponseBody::Fonts {
            fonts: available_fonts(),
        },
        // Beth Studio (patch 0110): persist the default theme and apply
        // it to every live pane. Persistence is disk-only (safe on
        // the pipe thread); the mux apply is posted to the GUI thread.
        Request::SetDefaultTheme {
            theme,
            font_family,
            font_size,
            font_bold,
            font_italic,
            ..
        } => {
            let cleaned = theme.trim();
            if cleaned.is_empty() {
                if let Err(e) = crate::default_theme::save(None) {
                    return Response {
                        id,
                        body: ResponseBody::Error {
                            error: format!("save default theme: {e:#}"),
                        },
                    };
                }
                return Response {
                    id,
                    body: ResponseBody::Ok { ok: true },
                };
            }
            let palette = match palette_from_theme_id(cleaned) {
                Some(p) => p,
                None => {
                    return Response {
                        id,
                        body: ResponseBody::Error {
                            error: format!("unknown theme: {}", cleaned),
                        },
                    };
                }
            };
            // Patch 0132: merge the font fields over the saved style.
            let mut style = crate::default_theme::load_style().unwrap_or_default();
            style.theme = Some(cleaned.to_string());
            if let Some(fam) = font_family {
                let fam = fam.trim().to_string();
                style.font_family = if fam.is_empty() { None } else { Some(fam) };
            }
            if let Some(size) = font_size {
                let base = config::configuration().font_size;
                style.font_scale = if base > 0.0 && size > 0.0 {
                    Some(size / base)
                } else {
                    None
                };
            }
            if let Some(b) = font_bold {
                style.font_bold = b;
            }
            if let Some(i) = font_italic {
                style.font_italic = i;
            }
            if let Err(e) = crate::default_theme::save_style(&style) {
                return Response {
                    id,
                    body: ResponseBody::Error {
                        error: format!("save default theme: {e:#}"),
                    },
                };
            }
            let theme_for_apply = cleaned.to_string();
            notify_apply(Box::new(move || {
                match apply_theme_to_all_panes(palette, Some(theme_for_apply)) {
                    Ok(n) => log::info!(
                        "bethstudio: applied default theme to {} pane(s)",
                        n
                    ),
                    Err(e) => log::warn!(
                        "bethstudio patch 0110: set_default_theme apply failed: {}",
                        e
                    ),
                }
                // Patch 0132: the default font goes to every open pane
                // too, then each tab reflows its PTY grids.
                let n = apply_font_to_all_panes(&style);
                log::info!("bethstudio: applied default font to {} pane(s)", n);
            }));
            ResponseBody::Ok { ok: true }
        }
    };
    Response { id, body }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::PROTOCOL_VERSION;

    #[test]
    fn pipe_name_for_pid_is_correct() {
        assert_eq!(pipe_name_for_pid(1234), "\\\\.\\pipe\\wtinator-config-1234");
    }

    #[test]
    fn request_list_tabs_parses() {
        let json = r#"{"type":"list_tabs","id":1}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::ListTabs { id } => assert_eq!(id, Some(1)),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn request_set_theme_parses() {
        let json =
            r#"{"type":"set_theme","id":2,"tab_id":7,"theme":"vscode_dark"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::SetTheme { id, tab_id, theme } => {
                assert_eq!(id, Some(2));
                assert_eq!(tab_id, 7);
                assert_eq!(theme, "vscode_dark");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn request_ping_parses() {
        let json = r#"{"type":"ping"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::Ping { id } => assert_eq!(id, None),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn request_download_themes_parses() {
        // Patch 0038: the `download_themes` variant parses with and
        // without a correlation id.
        let json = r#"{"type":"download_themes","id":4}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::DownloadThemes { id } => assert_eq!(id, Some(4)),
            _ => panic!("wrong variant"),
        }
        let json = r#"{"type":"download_themes"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::DownloadThemes { id } => assert_eq!(id, None),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn request_set_pane_theme_parses() {
        // Patch 0040: the per-pane theme request parses with and
        // without a correlation id.
        let json =
            r#"{"type":"set_pane_theme","id":5,"pane_id":12,"theme":"dracula"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::SetPaneTheme { id, pane_id, theme } => {
                assert_eq!(id, Some(5));
                assert_eq!(pane_id, 12);
                assert_eq!(theme, "dracula");
            }
            _ => panic!("wrong variant"),
        }
        let json = r#"{"type":"set_pane_theme","pane_id":3,"theme":"vscode_dark"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::SetPaneTheme { id, pane_id, theme } => {
                assert_eq!(id, None);
                assert_eq!(pane_id, 3);
                assert_eq!(theme, "vscode_dark");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn request_set_pane_font_size_parses() {
        // Patch 0040: the per-pane font-size request parses an
        // absolute size (float), with and without a correlation id.
        let json =
            r#"{"type":"set_pane_font_size","id":6,"pane_id":12,"size":18.5}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::SetPaneFontSize { id, pane_id, size } => {
                assert_eq!(id, Some(6));
                assert_eq!(pane_id, 12);
                assert!((size - 18.5).abs() < f64::EPSILON);
            }
            _ => panic!("wrong variant"),
        }
        let json = r#"{"type":"set_pane_font_size","pane_id":1,"size":14}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::SetPaneFontSize { id, pane_id, size } => {
                assert_eq!(id, None);
                assert_eq!(pane_id, 1);
                assert!((size - 14.0).abs() < f64::EPSILON);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn set_pane_theme_unknown_id_returns_error() {
        // Patch 0040: an unknown theme id returns an Error body
        // (mirrors `set_theme_unknown_id_returns_error`).
        let req = Request::SetPaneTheme {
            id: Some(10),
            pane_id: 0,
            theme: "totally-not-a-theme".to_string(),
        };
        let cb: ApplyCallback = Box::new(|_f| {});
        let resp = handle_request(req, &cb);
        match resp.body {
            ResponseBody::Error { error } => {
                assert!(error.contains("totally-not-a-theme"));
            }
            _ => panic!("expected Error body"),
        }
    }

    #[test]
    fn response_ok_serializes() {
        let resp = Response {
            id: Some(1),
            body: ResponseBody::Ok { ok: true },
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"ok\":true"));
        assert!(s.contains("\"id\":1"));
    }

    #[test]
    fn response_snapshot_serializes() {
        let resp = Response {
            id: Some(2),
            body: ResponseBody::Snapshot {
                snapshot: ConfigSnapshot {
                    protocol_version: PROTOCOL_VERSION,
                    wezterm_pid: 1,
                    base_font_size: 12.0,
                    default_theme: None,
                    tabs: vec![],
                    themes: vec![],
                    panes: vec![],
                },
            },
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"snapshot\""));
        assert!(s.contains("\"protocol_version\":1"));
    }

    #[test]
    fn palette_from_theme_id_known_values() {
        assert!(palette_from_theme_id("vscode_light").is_some());
        assert!(palette_from_theme_id("vscode_dark").is_some());
        assert!(palette_from_theme_id("windows_terminal_dark").is_some());
        assert!(palette_from_theme_id("default").is_some());
        // Patch 0038: an unknown id now falls through to the
        // downloaded-theme lookup. A slug that cannot exist on disk
        // (it has characters `slugify` would never emit) must still
        // resolve to `None`.
        assert!(palette_from_theme_id("!!definitely-not-a-real-theme!!").is_none());
    }

    #[test]
    fn ping_request_handled_as_ok() {
        let req = Request::Ping { id: Some(7) };
        let called = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let called_clone = called.clone();
        let cb: ApplyCallback = Box::new(move |_f| {
            called_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        });
        let resp = handle_request(req, &cb);
        assert_eq!(resp.id, Some(7));
        match resp.body {
            ResponseBody::Ok { ok } => assert!(ok),
            _ => panic!("expected Ok body"),
        }
        // ping should NOT call notify_apply.
        assert_eq!(called.load(std::sync::atomic::Ordering::Relaxed), 0);
    }

    #[test]
    fn set_theme_request_handled_as_ok() {
        let req = Request::SetTheme {
            id: Some(8),
            tab_id: 999_999, // bogus tab
            theme: "vscode_dark".to_string(),
        };
        let called = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let called_clone = called.clone();
        let cb: ApplyCallback = Box::new(move |f| {
            // The inner closure is what would run
            // on the GUI thread. We do NOT invoke
            // it here because `apply_theme_to_tab`
            // with a bogus tab_id would panic (the
            // mux has no tab 999_999). The test
            // just verifies the outer dispatch
            // happens and the response is `Ok`.
            let _ = f;
            called_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        });
        let resp = handle_request(req, &cb);
        assert_eq!(resp.id, Some(8));
        match resp.body {
            ResponseBody::Ok { ok } => assert!(ok),
            _ => panic!("expected Ok body"),
        }
        // The callback was invoked.
        assert_eq!(called.load(std::sync::atomic::Ordering::Relaxed), 1);
    }

    #[test]
    fn set_theme_unknown_id_returns_error() {
        let req = Request::SetTheme {
            id: Some(9),
            tab_id: 0,
            theme: "totally-not-a-theme".to_string(),
        };
        let cb: ApplyCallback = Box::new(|_f| {});
        let resp = handle_request(req, &cb);
        match resp.body {
            ResponseBody::Error { error } => {
                assert!(error.contains("totally-not-a-theme"));
            }
            _ => panic!("expected Error body"),
        }
    }

    #[test]
    fn request_set_default_theme_parses() {
        let json = r#"{"type":"set_default_theme","id":10,"theme":"dracula"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::SetDefaultTheme { id, theme, .. } => {
                assert_eq!(id, Some(10));
                assert_eq!(theme, "dracula");
            }
            _ => panic!("wrong variant"),
        }
        let json = r#"{"type":"set_default_theme","theme":"vscode_dark"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        match req {
            Request::SetDefaultTheme { id, theme, .. } => {
                assert_eq!(id, None);
                assert_eq!(theme, "vscode_dark");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn set_default_theme_unknown_id_returns_error() {
        let req = Request::SetDefaultTheme {
            id: Some(11),
            theme: "totally-not-a-theme".to_string(),
            font_family: None,
            font_size: None,
            font_bold: None,
            font_italic: None,
        };
        let cb: ApplyCallback = Box::new(|_f| {});
        let resp = handle_request(req, &cb);
        match resp.body {
            ResponseBody::Error { error } => {
                assert!(error.contains("totally-not-a-theme"));
            }
            _ => panic!("expected Error body"),
        }
    }
}
