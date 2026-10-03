// wtinator-config — the standalone BethTerm Settings app
// (patch 0036).
//
// A native Windows WebView2 window hosting a React frontend. The
// app:
//
//   1. Builds the THEME list locally from
//      `wtinator::vscode_theme::ThemeId::iter()` (works without a
//      mux — `wtinator::notify::snapshot_theme` is pub and pure).
//   2. Optionally connects to a running wezterm-gui over the named
//      pipe `\\.\pipe\wtinator-config-<pid>` (pid from the
//      `--wezterm-pid <PID>` CLI arg) to list its tabs and to apply
//      a theme to a tab's active pane.
//
// The React side talks to us via `window.ipc.postMessage(json)`
// (wry's IPC bridge). We reply by calling
// `window.__wtinator_reply(json)` via `evaluate_script` on the
// event-loop thread.
//
// Threading model: the wry WebView is `!Send`, so it lives on the
// main (event-loop) thread. The IPC handler closure (which runs on
// the main thread) forwards each request to the event loop as a
// `UserEvent::Ipc(String)` via an `EventLoopProxy` (the pipe
// round-trip is fast and synchronous; we keep it on the main thread
// for simplicity and to avoid `Send` gymnastics with the WebView).

// On Windows, hide the console window for the release GUI build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Result;
use serde_json::json;

#[cfg(windows)]
mod ipc_client;

use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
#[cfg(windows)]
use tao::platform::windows::WindowExtWindows;
use wry::WebViewBuilder;

/// The embedded Vite-built frontend. `rust-embed` reads
/// `frontend/dist` at compile time. We only need `index.html`
/// because the frontend is built as a single self-contained file
/// (vite-plugin-singlefile inlines all JS/CSS/assets).
#[derive(rust_embed::RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/frontend/dist"]
struct Frontend;

/// User events posted to the event loop. `Ipc` carries a raw JSON
/// request string from the React side (forwarded by the wry IPC
/// handler, which runs on the main thread but cannot borrow the
/// WebView).
enum UserEvent {
    Ipc(String),
}

/// Parse `--wezterm-pid <PID>` from argv. Returns `None` if absent
/// or unparseable (the app then runs in "themes only" mode).
fn parse_wezterm_pid() -> Option<u32> {
    parse_arg_u64("--wezterm-pid").map(|v| v as u32)
}

/// WezTerminator (patch 0040): parse `--pane-id <ID>` from argv.
/// Returns `None` if absent or unparseable; in that case the config
/// app runs in the legacy tab-based mode (left rail of tabs). When
/// present, the app runs in **pane mode**: it configures the single
/// pane the user right-clicked (theme + exact font size for that pane
/// only). Mirrors `parse_wezterm_pid`.
fn parse_pane_id() -> Option<usize> {
    parse_arg_u64("--pane-id").map(|v| v as usize)
}

/// Shared helper: find `--<name> <value>` or `--<name>=<value>` in
/// argv and parse it as a `u64`. Returns `None` if absent / bad.
fn parse_arg_u64(name: &str) -> Option<u64> {
    let eq_prefix = format!("{}=", name);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == name {
            return args.next().and_then(|v| v.parse::<u64>().ok());
        }
        if let Some(rest) = a.strip_prefix(&eq_prefix) {
            return rest.parse::<u64>().ok();
        }
    }
    None
}

/// Build the theme list locally (no mux needed). Mirrors the theme
/// half of `wtinator::notify::snapshot_for_config`: the 3 baked-in
/// themes followed by every downloaded theme (patch 0038), de-duped
/// by id (built-ins win).
fn local_themes() -> Vec<wtinator::notify::ThemeSnapshot> {
    wtinator::theme_download::ensure_local_themes();
    let mut themes = Vec::new();
    for theme_id in wtinator::vscode_theme::ThemeId::iter() {
        let palette = theme_id.build_palette();
        themes.push(wtinator::notify::snapshot_theme(
            theme_id.id_str(),
            theme_id.display_name(),
            wtinator::notify::ThemeKind::BuiltIn,
            &palette,
        ));
    }
    // WezTerminator (patch 0038): append downloaded themes cached
    // under `%APPDATA%\wezterminator\themes\`. The standalone config
    // app reads them directly from disk (it does not need the GUI
    // for this), so the grid shows them even when launched without
    // `--wezterm-pid`.
    for saved in wtinator::theme_download::load_saved_themes() {
        if themes.iter().any(|t| t.id == saved.id) {
            continue;
        }
        themes.push(wtinator::notify::saved_theme_to_snapshot(saved));
    }
    themes
}

/// Handle one `download_themes` request from the React side. We
/// download the Gogh catalog directly in this process (the config
/// app has no tokio runtime, so `theme_download::download_catalog`
/// uses `reqwest::blocking`). The reply tells the UI to re-issue
/// `list_tabs` so the grid re-renders with the new
/// `UserDownloaded` cards. (Patch 0038.)
///
/// Note: we download locally rather than asking the connected
/// wezterm-gui over the pipe — this keeps the feature working in
/// standalone mode, and the cached JSON files are shared (the GUI
/// reads the same `%APPDATA%\wezterminator\themes\` dir).
fn handle_download_themes() -> serde_json::Value {
    match wtinator::theme_download::download_catalog() {
        Ok(result) => {
            let source = match result.source {
                wtinator::theme_download::CatalogSource::Network => "network",
                wtinator::theme_download::CatalogSource::Bundled => "bundled",
            };
            json!({
                "type": "download_themes_result",
                "ok": true,
                "count": result.count,
                "source": source,
                "error": serde_json::Value::Null,
            })
        }
        Err(e) => json!({
            "type": "download_themes_result",
            "ok": false,
            "count": 0,
            "source": serde_json::Value::Null,
            "error": format!("{:#}", e),
        }),
    }
}

/// Handle one `list_tabs` request. Always returns the local theme
/// list; if a pid is known and the pipe is reachable, also returns
/// the live tab list (and the server's pid). Otherwise returns an
/// empty tab list + a `connected: false` flag so the UI can show a
/// "not connected to a terminal" notice.
fn handle_list_tabs(pid: Option<u32>, pane_id: Option<usize>) -> serde_json::Value {
    let themes = local_themes();
    let themes_json = serde_json::to_value(&themes).unwrap_or(json!([]));

    let mut tabs_json = json!([]);
    let mut connected = false;
    let mut notice = String::new();
    let mut server_pid = pid.unwrap_or(0);
    // Patch 0040: the window's base font size. We learn it from the
    // live snapshot when connected; otherwise fall back to a typical
    // default so the size control still has a sane initial value in
    // standalone / disconnected mode.
    let mut base_font_size: f64 = 12.0;
    // Patch 0110: persisted default theme. Seed from disk so the badge
    // works even when launched standalone; the live snapshot overrides
    // it when the GUI is connected.
    let mut default_theme: Option<String> = wtinator::default_theme::load();
    // Patch 0131: per-pane visual state (theme, family, scale, bold,
    // italic) so the UI opens pre-filled for the right-clicked terminal.
    let mut panes_json = json!([]);

    match pid {
        None => {
            notice =
                "Launched standalone (no --wezterm-pid). Showing themes only; \
                 open this from a terminal's right-click menu to apply themes."
                    .to_string();
        }
        Some(pid) => {
            #[cfg(windows)]
            {
                let req = json!({"type":"list_tabs","id":1}).to_string();
                match ipc_client::round_trip(pid, &req) {
                    Ok(resp) => {
                        match serde_json::from_str::<serde_json::Value>(&resp) {
                            Ok(v) => {
                                if let Some(snap) = v.get("snapshot") {
                                    if let Some(tabs) = snap.get("tabs") {
                                        tabs_json = tabs.clone();
                                    }
                                    if let Some(panes) = snap.get("panes") {
                                        panes_json = panes.clone();
                                    }
                                    if let Some(sp) =
                                        snap.get("wezterm_pid").and_then(|p| p.as_u64())
                                    {
                                        server_pid = sp as u32;
                                    }
                                    // Patch 0040: pick up the window's
                                    // base font size for the size control.
                                    if let Some(bfs) = snap
                                        .get("base_font_size")
                                        .and_then(|p| p.as_f64())
                                    {
                                        if bfs > 0.0 {
                                            base_font_size = bfs;
                                        }
                                    }
                                    // Patch 0110: prefer the GUI's view of
                                    // the default (same file, but live).
                                    if let Some(dt) = snap.get("default_theme") {
                                        default_theme = dt.as_str().map(|s| s.to_string());
                                    }
                                    connected = true;
                                } else if let Some(err) =
                                    v.get("error").and_then(|e| e.as_str())
                                {
                                    notice = format!("Terminal returned an error: {}", err);
                                } else {
                                    notice =
                                        "Unexpected response from terminal.".to_string();
                                }
                            }
                            Err(e) => {
                                notice = format!("Could not parse terminal response: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        notice = format!(
                            "Not connected to a terminal (pid {}): {}",
                            pid, e
                        );
                    }
                }
            }
            #[cfg(not(windows))]
            {
                let _ = pid;
                notice = "Named-pipe IPC is only supported on Windows.".to_string();
            }
        }
    }

    json!({
        "type": "snapshot",
        "connected": connected,
        "wezterm_pid": server_pid,
        "notice": notice,
        "tabs": tabs_json,
        "themes": themes_json,
        "protocol_version": wtinator::notify::PROTOCOL_VERSION,
        // Patch 0040: `pane_id` is non-null when the app was launched
        // from a terminal's right-click menu (`--pane-id`). The React
        // UI switches to "pane mode" (configure this one terminal:
        // theme + exact font size) when it is non-null, and stays in
        // the legacy tab-based mode when null. `base_font_size` is the
        // initial value of the size control.
        "pane_id": pane_id,
        "base_font_size": base_font_size,
        // Patch 0110: theme id used as the default for all terminals.
        "default_theme": default_theme,
        // Patch 0131: every live pane's current visual state.
        "panes": panes_json,
    })
}

/// Handle one `set_theme` request by forwarding it over the pipe.
fn handle_set_theme(pid: Option<u32>, tab_id: u64, theme: &str) -> serde_json::Value {
    match pid {
        None => json!({
            "type": "set_theme_result",
            "ok": false,
            "tab_id": tab_id,
            "theme": theme,
            "error": "no terminal connected (launched without --wezterm-pid)"
        }),
        Some(pid) => {
            #[cfg(windows)]
            {
                let req = json!({
                    "type":"set_theme","id":2,"tab_id":tab_id,"theme":theme
                })
                .to_string();
                match ipc_client::round_trip(pid, &req) {
                    Ok(resp) => {
                        let ok = serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
                            .unwrap_or(false);
                        let error = serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .and_then(|v| {
                                v.get("error").and_then(|e| e.as_str()).map(String::from)
                            });
                        json!({
                            "type": "set_theme_result",
                            "ok": ok,
                            "tab_id": tab_id,
                            "theme": theme,
                            "error": error,
                        })
                    }
                    Err(e) => json!({
                        "type": "set_theme_result",
                        "ok": false,
                        "tab_id": tab_id,
                        "theme": theme,
                        "error": format!("pipe error: {}", e),
                    }),
                }
            }
            #[cfg(not(windows))]
            {
                let _ = (pid, tab_id, theme);
                json!({
                    "type": "set_theme_result",
                    "ok": false,
                    "tab_id": tab_id,
                    "theme": theme,
                    "error": "named-pipe IPC is only supported on Windows"
                })
            }
        }
    }
}

/// WezTerminator (patch 0040): forward a `set_pane_theme` request
/// over the pipe (per-terminal theme). Mirrors `handle_set_theme`
/// exactly but targets one exact pane by id.
fn handle_set_pane_theme(pid: Option<u32>, pane_id: u64, theme: &str) -> serde_json::Value {
    match pid {
        None => json!({
            "type": "set_pane_theme_result",
            "ok": false,
            "pane_id": pane_id,
            "theme": theme,
            "error": "no terminal connected (launched without --wezterm-pid)"
        }),
        Some(pid) => {
            #[cfg(windows)]
            {
                let req = json!({
                    "type":"set_pane_theme","id":3,"pane_id":pane_id,"theme":theme
                })
                .to_string();
                match ipc_client::round_trip(pid, &req) {
                    Ok(resp) => {
                        let ok = serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
                            .unwrap_or(false);
                        let error = serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .and_then(|v| {
                                v.get("error").and_then(|e| e.as_str()).map(String::from)
                            });
                        json!({
                            "type": "set_pane_theme_result",
                            "ok": ok,
                            "pane_id": pane_id,
                            "theme": theme,
                            "error": error,
                        })
                    }
                    Err(e) => json!({
                        "type": "set_pane_theme_result",
                        "ok": false,
                        "pane_id": pane_id,
                        "theme": theme,
                        "error": format!("pipe error: {}", e),
                    }),
                }
            }
            #[cfg(not(windows))]
            {
                let _ = (pid, pane_id, theme);
                json!({
                    "type": "set_pane_theme_result",
                    "ok": false,
                    "pane_id": pane_id,
                    "theme": theme,
                    "error": "named-pipe IPC is only supported on Windows"
                })
            }
        }
    }
}

/// WezTerminator (patch 0040): forward a `set_pane_font_size` request
/// over the pipe (per-terminal absolute font size in points).
/// Mirrors `handle_set_theme` for the round-trip + error handling.
fn handle_set_pane_font_size(pid: Option<u32>, pane_id: u64, size: f64) -> serde_json::Value {
    match pid {
        None => json!({
            "type": "set_pane_font_size_result",
            "ok": false,
            "pane_id": pane_id,
            "size": size,
            "error": "no terminal connected (launched without --wezterm-pid)"
        }),
        Some(pid) => {
            #[cfg(windows)]
            {
                let req = json!({
                    "type":"set_pane_font_size","id":4,"pane_id":pane_id,"size":size
                })
                .to_string();
                match ipc_client::round_trip(pid, &req) {
                    Ok(resp) => {
                        let ok = serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
                            .unwrap_or(false);
                        let error = serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .and_then(|v| {
                                v.get("error").and_then(|e| e.as_str()).map(String::from)
                            });
                        json!({
                            "type": "set_pane_font_size_result",
                            "ok": ok,
                            "pane_id": pane_id,
                            "size": size,
                            "error": error,
                        })
                    }
                    Err(e) => json!({
                        "type": "set_pane_font_size_result",
                        "ok": false,
                        "pane_id": pane_id,
                        "size": size,
                        "error": format!("pipe error: {}", e),
                    }),
                }
            }
            #[cfg(not(windows))]
            {
                let _ = (pid, pane_id, size);
                json!({
                    "type": "set_pane_font_size_result",
                    "ok": false,
                    "pane_id": pane_id,
                    "size": size,
                    "error": "named-pipe IPC is only supported on Windows"
                })
            }
        }
    }
}

/// WezTerminator (patch 0043): forward a `set_pane_font_family` request
/// over the pipe (per-terminal typeface). `family` is `None` to clear
/// the override (back to the window font). Mirrors
/// `handle_set_pane_font_size` for the round-trip + error handling.
fn handle_set_pane_font_family(
    pid: Option<u32>,
    pane_id: u64,
    family: Option<&str>,
) -> serde_json::Value {
    let family_json = match family {
        Some(f) => serde_json::Value::String(f.to_string()),
        None => serde_json::Value::Null,
    };
    match pid {
        None => json!({
            "type": "set_pane_font_family_result",
            "ok": false,
            "pane_id": pane_id,
            "family": family_json,
            "error": "no terminal connected (launched without --wezterm-pid)"
        }),
        Some(pid) => {
            #[cfg(windows)]
            {
                let req = json!({
                    "type":"set_pane_font_family",
                    "id":5,
                    "pane_id":pane_id,
                    "family":family_json,
                })
                .to_string();
                match ipc_client::round_trip(pid, &req) {
                    Ok(resp) => {
                        let ok = serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
                            .unwrap_or(false);
                        let error = serde_json::from_str::<serde_json::Value>(&resp)
                            .ok()
                            .and_then(|v| {
                                v.get("error").and_then(|e| e.as_str()).map(String::from)
                            });
                        json!({
                            "type": "set_pane_font_family_result",
                            "ok": ok,
                            "pane_id": pane_id,
                            "family": family_json,
                            "error": error,
                        })
                    }
                    Err(e) => json!({
                        "type": "set_pane_font_family_result",
                        "ok": false,
                        "pane_id": pane_id,
                        "family": family_json,
                        "error": format!("pipe error: {}", e),
                    }),
                }
            }
            #[cfg(not(windows))]
            {
                let _ = (pid, pane_id);
                json!({
                    "type": "set_pane_font_family_result",
                    "ok": false,
                    "pane_id": pane_id,
                    "family": family_json,
                    "error": "named-pipe IPC is only supported on Windows"
                })
            }
        }
    }
}

/// WezTerminator (patch 0047): forward a `set_pane_font_style` request
/// over the pipe (per-terminal bold / italic).
fn handle_set_pane_font_style(
    pid: Option<u32>,
    pane_id: u64,
    bold: bool,
    italic: bool,
) -> serde_json::Value {
    match pid {
        None => json!({
            "type": "set_pane_font_style_result",
            "ok": false,
            "pane_id": pane_id,
            "bold": bold,
            "italic": italic,
            "error": "no terminal connected (launched without --wezterm-pid)"
        }),
        Some(pid) => {
            #[cfg(windows)]
            {
                let req = json!({
                    "type":"set_pane_font_style",
                    "id":9,
                    "pane_id":pane_id,
                    "bold":bold,
                    "italic":italic,
                })
                .to_string();
                match ipc_client::round_trip(pid, &req) {
                    Ok(resp) => {
                        let parsed =
                            serde_json::from_str::<serde_json::Value>(&resp).ok();
                        let ok = parsed
                            .as_ref()
                            .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
                            .unwrap_or(false);
                        let error = parsed.as_ref().and_then(|v| {
                            v.get("error").and_then(|e| e.as_str()).map(String::from)
                        });
                        json!({
                            "type": "set_pane_font_style_result",
                            "ok": ok,
                            "pane_id": pane_id,
                            "bold": bold,
                            "italic": italic,
                            "error": error,
                        })
                    }
                    Err(e) => json!({
                        "type": "set_pane_font_style_result",
                        "ok": false,
                        "pane_id": pane_id,
                        "bold": bold,
                        "italic": italic,
                        "error": format!("pipe error: {}", e),
                    }),
                }
            }
            #[cfg(not(windows))]
            {
                let _ = (pid, pane_id, bold, italic);
                json!({
                    "type": "set_pane_font_style_result",
                    "ok": false,
                    "pane_id": pane_id,
                    "bold": bold,
                    "italic": italic,
                    "error": "named-pipe IPC is only supported on Windows"
                })
            }
        }
    }
}

/// WezTerminator (patch 0043): fetch the list of font family names the
/// connected terminal can load (for the family picker). The list lives
/// on the GUI host (it owns `wezterm-font`), so we must be connected;
/// in standalone mode we return an empty list and let the UI offer just
/// "window default".
fn handle_list_fonts(pid: Option<u32>) -> serde_json::Value {
    match pid {
        None => json!({
            "type": "list_fonts_result",
            "fonts": [],
            "error": "no terminal connected (launched without --wezterm-pid)"
        }),
        Some(pid) => {
            #[cfg(windows)]
            {
                let req = json!({"type":"list_fonts","id":6}).to_string();
                match ipc_client::round_trip(pid, &req) {
                    Ok(resp) => match serde_json::from_str::<serde_json::Value>(&resp) {
                        Ok(v) => {
                            let fonts = v
                                .get("fonts")
                                .cloned()
                                .unwrap_or_else(|| json!([]));
                            json!({
                                "type": "list_fonts_result",
                                "fonts": fonts,
                                "error": serde_json::Value::Null,
                            })
                        }
                        Err(e) => json!({
                            "type": "list_fonts_result",
                            "fonts": [],
                            "error": format!("could not parse fonts reply: {}", e),
                        }),
                    },
                    Err(e) => json!({
                        "type": "list_fonts_result",
                        "fonts": [],
                        "error": format!("pipe error: {}", e),
                    }),
                }
            }
            #[cfg(not(windows))]
            {
                let _ = pid;
                json!({
                    "type": "list_fonts_result",
                    "fonts": [],
                    "error": "named-pipe IPC is only supported on Windows"
                })
            }
        }
    }
}

/// Dispatch a raw JSON request from the React side to a JSON reply.
// WezTerminator (patch 0060): theme favourites are persisted on disk by the
// Rust host. The WebView loads its HTML via `with_html`, which gives the page a
// null origin, and WebView2 does not persist localStorage for a null origin —
// so the favourites are kept in %APPDATA%\wezterminator\theme-favorites.json
// (see wtinator::favorites) and shuttled over IPC instead.
fn handle_get_favorites() -> serde_json::Value {
    match wtinator::favorites::load() {
        Ok(items) => json!({ "type": "favorites", "items": items }),
        Err(e) => json!({ "type": "error", "error": format!("load favorites: {e:#}") }),
    }
}

fn handle_save_favorites(items: serde_json::Value) -> serde_json::Value {
    match wtinator::favorites::save(&items) {
        Ok(()) => json!({ "type": "save_favorites_result", "ok": true, "error": null }),
        Err(e) => {
            json!({ "type": "save_favorites_result", "ok": false, "error": format!("{e:#}") })
        }
    }
}

/// BethTerm (patch 0110): persist the default theme and, when a GUI
/// is connected, apply it to every live pane.
fn handle_set_default_theme(
    pid: Option<u32>,
    theme: &str,
    font: &serde_json::Value,
) -> serde_json::Value {
    let cleaned = theme.trim();
    if !cleaned.is_empty() && wtinator::default_theme::palette_for(cleaned).is_none() {
        return json!({
            "type": "set_default_theme_result",
            "ok": false,
            "theme": theme,
            "error": format!("unknown theme: {cleaned}"),
        });
    }
    // Patch 0132: when no GUI is connected, persist the font fields
    // here (the GUI does the same, with the live base size, when it is).
    let save_result = if pid.is_some() || cleaned.is_empty() {
        let save_arg = if cleaned.is_empty() { None } else { Some(cleaned) };
        wtinator::default_theme::save(save_arg)
    } else {
        let mut style = wtinator::default_theme::load_style().unwrap_or_default();
        style.theme = Some(cleaned.to_string());
        if let Some(fam) = font.get("font_family").and_then(|f| f.as_str()) {
            let fam = fam.trim();
            style.font_family = if fam.is_empty() { None } else { Some(fam.to_string()) };
        }
        if let Some(b) = font.get("font_bold").and_then(|b| b.as_bool()) {
            style.font_bold = b;
        }
        if let Some(i) = font.get("font_italic").and_then(|b| b.as_bool()) {
            style.font_italic = i;
        }
        wtinator::default_theme::save_style(&style)
    };
    if let Err(e) = save_result {
        return json!({
            "type": "set_default_theme_result",
            "ok": false,
            "theme": theme,
            "error": format!("save default theme: {e:#}"),
        });
    }
    match pid {
        None => json!({
            "type": "set_default_theme_result",
            "ok": true,
            "theme": theme,
            "error": serde_json::Value::Null,
        }),
        Some(pid) => {
            #[cfg(windows)]
            {
                let req = json!({
                    "type":"set_default_theme","id":10,"theme":theme,
                    "font_family": font.get("font_family").cloned().unwrap_or(serde_json::Value::Null),
                    "font_size": font.get("font_size").cloned().unwrap_or(serde_json::Value::Null),
                    "font_bold": font.get("font_bold").cloned().unwrap_or(serde_json::Value::Null),
                    "font_italic": font.get("font_italic").cloned().unwrap_or(serde_json::Value::Null),
                })
                .to_string();
                match ipc_client::round_trip(pid, &req) {
                    Ok(resp) => {
                        let parsed = serde_json::from_str::<serde_json::Value>(&resp).ok();
                        let ok = parsed
                            .as_ref()
                            .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
                            .unwrap_or(false);
                        let error = parsed.and_then(|v| {
                            v.get("error").and_then(|e| e.as_str()).map(String::from)
                        });
                        json!({
                            "type": "set_default_theme_result",
                            "ok": ok,
                            "theme": theme,
                            "error": error,
                        })
                    }
                    Err(e) => json!({
                        "type": "set_default_theme_result",
                        "ok": true,
                        "theme": theme,
                        "error": format!("saved as default, but could not apply to open terminals: {}", e),
                    }),
                }
            }
            #[cfg(not(windows))]
            {
                let _ = pid;
                json!({
                    "type": "set_default_theme_result",
                    "ok": true,
                    "theme": theme,
                    "error": serde_json::Value::Null,
                })
            }
        }
    }
}

fn dispatch(pid: Option<u32>, pane_id: Option<usize>, raw: &str) -> serde_json::Value {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            return json!({"type":"error","error": format!("bad request JSON: {}", e)});
        }
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("list_tabs") => handle_list_tabs(pid, pane_id),
        Some("set_theme") => {
            let tab_id = v.get("tab_id").and_then(|t| t.as_u64()).unwrap_or(0);
            let theme = v.get("theme").and_then(|t| t.as_str()).unwrap_or("");
            handle_set_theme(pid, tab_id, theme)
        }
        // WezTerminator (patch 0040): per-terminal theme + font size.
        // The pane id comes from the React request body (the UI knows
        // it from the snapshot's `pane_id`).
        Some("set_pane_theme") => {
            let req_pane_id = v.get("pane_id").and_then(|t| t.as_u64()).unwrap_or(0);
            let theme = v.get("theme").and_then(|t| t.as_str()).unwrap_or("");
            handle_set_pane_theme(pid, req_pane_id, theme)
        }
        Some("set_pane_font_size") => {
            let req_pane_id = v.get("pane_id").and_then(|t| t.as_u64()).unwrap_or(0);
            let size = v.get("size").and_then(|t| t.as_f64()).unwrap_or(0.0);
            handle_set_pane_font_size(pid, req_pane_id, size)
        }
        // WezTerminator (patch 0043): per-terminal font family + the
        // font enumeration the picker is populated from.
        Some("set_pane_font_family") => {
            let req_pane_id = v.get("pane_id").and_then(|t| t.as_u64()).unwrap_or(0);
            // `family` absent or null => clear the override.
            let family = v.get("family").and_then(|t| t.as_str());
            handle_set_pane_font_family(pid, req_pane_id, family)
        }
        Some("set_pane_font_style") => {
            let req_pane_id = v.get("pane_id").and_then(|t| t.as_u64()).unwrap_or(0);
            let bold = v.get("bold").and_then(|t| t.as_bool()).unwrap_or(false);
            let italic = v.get("italic").and_then(|t| t.as_bool()).unwrap_or(false);
            handle_set_pane_font_style(pid, req_pane_id, bold, italic)
        }
        Some("list_fonts") => handle_list_fonts(pid),
        // WezTerminator (patch 0038): the Download themes button.
        Some("download_themes") => handle_download_themes(),
        // WezTerminator (patch 0060): persisted theme favourites.
        Some("get_favorites") => handle_get_favorites(),
        Some("save_favorites") => {
            let items = v
                .get("items")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            handle_save_favorites(items)
        }
        Some("set_default_theme") => {
            let theme = v.get("theme").and_then(|t| t.as_str()).unwrap_or("");
            handle_set_default_theme(pid, theme, &v)
        }
        other => json!({
            "type":"error",
            "error": format!("unknown request type: {:?}", other)
        }),
    }
}

fn index_html() -> String {
    match Frontend::get("index.html") {
        Some(f) => String::from_utf8_lossy(f.data.as_ref()).into_owned(),
        None => {
            // The frontend was not built. Show a clear placeholder so
            // the window still opens (and the build is still usable
            // for the pipe-server side).
            "<!doctype html><html><head><meta charset=\"utf-8\">\
             <title>BethTerm Settings</title></head>\
             <body style=\"font-family:sans-serif;background:#1e1e1e;color:#ddd;\
             padding:2rem\"><h1>BethTerm Settings</h1>\
             <p>The frontend bundle was not embedded at build time.</p>\
             <p>Build it with:</p>\
             <pre>cd wtinator-config/frontend\nnpm install\nnpm run build</pre>\
             <p>then rebuild this binary.</p></body></html>"
                .to_string()
        }
    }
}

fn run() -> Result<()> {
    let pid = parse_wezterm_pid();
    let pane_id = parse_pane_id();
    log::info!(
        "wtinator-config starting; wezterm pid = {:?}, pane id = {:?}",
        pid,
        pane_id
    );

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("BethTerm Settings")
        .with_inner_size(tao::dpi::LogicalSize::new(960.0, 680.0))
        .build(&event_loop)?;

    let html = index_html();

    let webview = WebViewBuilder::new()
        .with_html(html)
        .with_ipc_handler(move |req: wry::http::Request<String>| {
            // Runs on the main thread, but cannot borrow the WebView
            // here — forward to the event loop as a user event.
            let body = req.into_body();
            let _ = proxy.send_event(UserEvent::Ipc(body));
        })
        .build(&window)?;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
            }
            // Close when the user clicks outside (or Alt+Tabs away).
            // Focused(false) also fires when keyboard focus moves into
            // the WebView2 child HWND — only exit when this top-level
            // window is no longer the foreground one.
            Event::WindowEvent {
                event: WindowEvent::Focused(false),
                ..
            } => {
                #[cfg(windows)]
                {
                    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
                    let hwnd = window.hwnd() as *mut _;
                    let foreground = unsafe { GetForegroundWindow() };
                    if foreground != hwnd {
                        *control_flow = ControlFlow::Exit;
                    }
                }
                #[cfg(not(windows))]
                {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(UserEvent::Ipc(raw)) => {
                let reply = dispatch(pid, pane_id, &raw);
                let reply_str = reply.to_string();
                // Pass the reply to the React side. We JSON-encode the
                // string again so it is a safe JS string literal, then
                // the React side `JSON.parse`s it.
                let encoded = serde_json::to_string(&reply_str)
                    .unwrap_or_else(|_| "\"{}\"".to_string());
                let script = format!(
                    "window.__wtinator_reply && window.__wtinator_reply({});",
                    encoded
                );
                if let Err(e) = webview.evaluate_script(&script) {
                    log::warn!("evaluate_script failed: {}", e);
                }
            }
            _ => {}
        }
    });
}

fn show_fatal(msg: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK,
        };
        let title: Vec<u16> = std::ffi::OsStr::new("BethTerm Settings")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let body: Vec<u16> = std::ffi::OsStr::new(msg)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("{msg}");
    }
}

fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .init();
    if let Err(e) = run() {
        let msg = format!("BethTerm Settings could not start.\n\n{e:#}");
        log::error!("wtinator-config fatal: {e:#}");
        show_fatal(&msg);
        std::process::exit(1);
    }
}
