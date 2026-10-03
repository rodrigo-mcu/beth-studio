// wtinator::notify — Phase 1.G (patch 0034).
//
// Read-only view of the mux state for the
// `wtinator-config` companion app. The config app
// runs as a separate process and reads this
// snapshot over the named pipe to populate its UI.
//
// The snapshot is intentionally small: a list of
// tabs (id, index, title, group, current theme,
// active pane id) and a list of themes (id, name,
// kind, palette, preview text). The config app
// uses the palette to render a 16-color ANSI
// preview; the preview_text is a short Rust code
// snippet that exercises the 16 ANSI colors + a
// few bright variants.
//
// This module is **read-only** — it never mutates
// the mux. The IPC server in
// `wezterm-gui/src/termwindow/notify_ipc.rs` is the
// write side (handles the `set_theme` message from
// the config app and calls `pane.set_palette` on
// the main thread).

use mux::tab::Tab;
use std::sync::Arc;

/// A serializable snapshot of one tab in the mux.
/// Field order is part of the IPC contract; do not
/// reorder without bumping the protocol version.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct TabSnapshot {
    pub tab_id: usize,
    pub tab_index: usize,
    pub title: String,
    pub group_name: Option<String>,
    /// The theme id currently applied to the tab's
    /// active pane. We use the theme id (a string
    /// like "vscode_dark") rather than the palette
    /// itself so the wire format stays small and the
    /// config app can show "you are on VSCode Dark"
    /// without re-deriving the palette.
    pub current_theme: String,
    pub active_pane_id: usize,
    /// WezTerminator (patch 0043): the font family override on the tab's
    /// active pane (`None` = the window font). Lets the per-terminal
    /// config app default its family picker to the pane's current
    /// typeface. Additive; defaults to `None` for back-compat.
    #[serde(default)]
    pub active_pane_font_family: Option<String>,
}

/// Beth Studio (patch 0131): the visual state of one live pane, so the
/// Settings app opens showing what the terminal already uses (theme,
/// family, size, bold, italic) instead of blank controls.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct PaneSnapshot {
    pub pane_id: usize,
    pub tab_id: usize,
    /// Theme id explicitly applied to this pane (`None` = window/default).
    pub theme_id: Option<String>,
    /// Font family override (`None` = window font).
    pub font_family: Option<String>,
    /// Font size scale relative to `base_font_size` (1.0 = base).
    pub font_scale: f64,
    pub font_bold: bool,
    pub font_italic: bool,
}

/// Distinguishes baked-in themes (compiled into the
/// binary) from user-downloaded ones (saved as JSON
/// in `%APPDATA%\wezterminator\themes\`).
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub enum ThemeKind {
    /// A theme baked into the binary
    /// (`wtinator::vscode_theme::ThemeId`).
    BuiltIn,
    /// A theme loaded from
    /// `%APPDATA%\wezterminator\themes\<name>.json`.
    /// (Patch 0035 — not present in patch 0034.)
    UserDownloaded,
}

/// A serializable snapshot of one theme.
///
/// The palette is included so the React app can
/// render a live preview without round-tripping to
/// the config app for every preview frame. The
/// `preview_text` is a short Rust snippet that
/// exercises the 16 ANSI colors + bold + bright
/// variants — the React app renders it in a
/// monospace font using the palette's colors.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThemeSnapshot {
    pub id: String,
    pub name: String,
    pub kind: ThemeKind,
    /// A representation of the palette in a form
    /// that survives JSON serialization. The React
    /// app consumes this to render the preview.
    ///
    /// We use the 16-color ANSI palette as 16 RGB
    /// hex strings rather than the full 256-color
    /// `ColorPalette` (which is hard to serialize
    /// cleanly and 10x larger on the wire). The
    /// preview only needs the 16 ANSI colors
    /// anyway; the 240-cube + 24-grey are derived
    /// from those at render time on the React side.
    pub ansi: [String; 16],
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    pub selection_fg: String,
    pub selection_bg: String,
    /// A short Rust snippet that exercises the 16
    /// ANSI colors + bold + bright. The React app
    /// renders it inside the `ThemePreview` component.
    pub preview_text: String,
}

/// The full snapshot sent to the config app on
/// startup. Field order is part of the IPC
/// contract.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConfigSnapshot {
    /// IPC protocol version. The config app sends
    /// its own version on connect; the server
    /// rejects mismatched versions with a clear
    /// error.
    pub protocol_version: u32,
    /// A short identifier for the running
    /// wezterm-gui instance (the PID is enough — the
    /// config app uses it to scope the named-pipe
    /// connection so two instances don't talk over
    /// each other).
    pub wezterm_pid: u32,
    /// WezTerminator (patch 0040): the window's base font
    /// size (points), from `config::configuration().font_size`.
    /// The per-terminal config window uses this as the
    /// initial / default value of its absolute font-size
    /// control (a pane that has never been resized reports
    /// scale 1.0, i.e. this size). Additive field — it does
    /// not bump `PROTOCOL_VERSION`.
    #[serde(default)]
    pub base_font_size: f64,
    /// Beth Studio (patch 0110): theme id to stamp on new terminals and
    /// to show as the "default" badge in the Settings app. `None` when
    /// the user has not chosen a default. Additive — does not bump
    /// `PROTOCOL_VERSION`.
    #[serde(default)]
    pub default_theme: Option<String>,
    pub tabs: Vec<TabSnapshot>,
    pub themes: Vec<ThemeSnapshot>,
    /// Beth Studio (patch 0131): every live pane's visual state. Additive.
    #[serde(default)]
    pub panes: Vec<PaneSnapshot>,
}

/// Current IPC protocol version. Bump this on
/// breaking changes to the message types above.
pub const PROTOCOL_VERSION: u32 = 1;

/// A short Rust snippet that exercises the 16 ANSI
/// colors + bold + bright. Used as the preview
/// text in the React app.
pub const DEFAULT_PREVIEW_TEXT: &str = r#"fn main() {
    // The 16 ANSI colors + a few bright variants.
    println!("\x1b[30mblack\x1b[0m  \x1b[31mred\x1b[0m  \x1b[32mgreen\x1b[0m  \x1b[33myellow\x1b[0m");
    println!("\x1b[34mblue\x1b[0m  \x1b[35mmagenta\x1b[0m  \x1b[36mcyan\x1b[0m  \x1b[37mwhite\x1b[0m");
    println!("\x1b[1;30mbright black\x1b[0m  \x1b[1;31mbright red\x1b[0m  \x1b[1;32mbright green\x1b[0m");
    println!("\x1b[1;33mbright yellow\x1b[0m  \x1b[1;34mbright blue\x1b[0m  \x1b[1;35mbright magenta\x1b[0m");
    println!("\x1b[1;36mbright cyan\x1b[0m  \x1b[1;37mbright white\x1b[0m");
}
"#;

/// Format an `SrgbaTuple` as a `#rrggbb` hex
/// string. The `SrgbaTuple` is 4 floats in 0..1;
/// we multiply by 255 and round to the nearest
/// integer.
fn srgba_to_hex(c: wezterm_color_types::SrgbaTuple) -> String {
    let r = (c.0 * 255.0).round() as u8;
    let g = (c.1 * 255.0).round() as u8;
    let b = (c.2 * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

/// Build a `ThemeSnapshot` from a theme id + name
/// + kind + palette. The palette is the full
/// `ColorPalette`; we project it down to the 16
/// ANSI colors + fg/bg/cursor/selection for the
/// wire format.
pub fn snapshot_theme(
    id: impl Into<String>,
    name: impl Into<String>,
    kind: ThemeKind,
    palette: &wezterm_term::color::ColorPalette,
) -> ThemeSnapshot {
    let mut ansi: [String; 16] = Default::default();
    for (i, c) in palette.colors.0.iter().take(16).enumerate() {
        ansi[i] = srgba_to_hex(*c);
    }
    ThemeSnapshot {
        id: id.into(),
        name: name.into(),
        kind,
        ansi,
        foreground: srgba_to_hex(palette.foreground),
        background: srgba_to_hex(palette.background),
        // `wezterm_term::color::ColorPalette` has
        // separate `cursor_fg` and `cursor_bg`
        // fields. The `cursor` we use in the wire
        // format is the foreground (the visible
        // cursor block fill) — that matches the
        // patch 0024-fix semantics and the patch
        // 0027 dark-theme fix.
        cursor: srgba_to_hex(palette.cursor_fg),
        selection_fg: srgba_to_hex(palette.selection_fg),
        selection_bg: srgba_to_hex(palette.selection_bg),
        preview_text: DEFAULT_PREVIEW_TEXT.to_string(),
    }
}

/// Map a downloaded `theme_download::SavedTheme` straight into a
/// `ThemeSnapshot` (kind = `UserDownloaded`). The `SavedTheme`
/// already stores the 16 ANSI hex strings + fg/bg/cursor/selection
/// in the exact wire shape, so this is a field-for-field move (no
/// `ColorPalette` round-trip). The preview text is the shared
/// `DEFAULT_PREVIEW_TEXT`. (Patch 0038.)
pub fn saved_theme_to_snapshot(saved: crate::theme_download::SavedTheme) -> ThemeSnapshot {
    ThemeSnapshot {
        id: saved.id,
        name: saved.name,
        kind: ThemeKind::UserDownloaded,
        ansi: saved.ansi,
        foreground: saved.foreground,
        background: saved.background,
        cursor: saved.cursor,
        selection_fg: saved.selection_fg,
        selection_bg: saved.selection_bg,
        preview_text: DEFAULT_PREVIEW_TEXT.to_string(),
    }
}

/// Build a `TabSnapshot` for a single tab. The
/// `current_theme` is the theme id string
/// (`"vscode_dark"` etc.); for tabs that have
/// never had an explicit theme set, it defaults
/// to the upstream wezterm default
/// (which we represent as `"default"`).
pub fn snapshot_tab(tab: &Arc<Tab>, tab_index: usize) -> TabSnapshot {
    // We don't yet have a "per-tab theme" data
    // field — that lands in patch 0034.5 (a small
    // follow-up). For now, every tab reports the
    // upstream default; the React app shows
    // "(default theme)" for tabs that have not
    // been customised.
    let active_pane = tab.get_active_pane();
    // Beth Studio (patch 0131): report the theme the active pane really
    // has, so the Settings app can mark it as applied.
    let current_theme = active_pane
        .as_ref()
        .and_then(|p| p.get_theme_id())
        .unwrap_or_else(|| "default".to_string());
    let active_pane_id = active_pane.as_ref().map(|p| p.pane_id()).unwrap_or(0);
    // WezTerminator (patch 0043): report the active pane's font family
    // override so the config app can pre-select it in the picker.
    let active_pane_font_family =
        active_pane.as_ref().and_then(|p| p.get_font_family());
    TabSnapshot {
        tab_id: tab.tab_id(),
        tab_index,
        title: tab.effective_title(),
        group_name: tab.get_group_name(),
        current_theme,
        active_pane_id,
        active_pane_font_family,
    }
}

/// Build the full `ConfigSnapshot` for the current
/// mux state. Returns an empty snapshot if the
/// mux is not initialized (the config app launched
/// before wezterm-gui started, etc.).
pub fn snapshot_for_config() -> ConfigSnapshot {
    use mux::Mux;
    let mut tabs = Vec::new();
    let mut themes = Vec::new();

    // Themes: enumerate the 3 built-in themes
    // (patch 0034 — user-downloaded themes come in
    // patch 0035). We pull each through the
    // existing `wtinator::vscode_theme::build_palette`
    // API so any future tweaks to the palette
    // derivation (cursor color, ANSI bright
    // variants, etc.) are picked up automatically.
    crate::theme_download::ensure_local_themes();
    for theme_id in crate::vscode_theme::ThemeId::iter() {
        let palette = theme_id.build_palette();
        let name = theme_id.display_name().to_string();
        let id = theme_id.id_str().to_string();
        themes.push(snapshot_theme(id, name, ThemeKind::BuiltIn, &palette));
    }

    // WezTerminator (patch 0038): append every downloaded theme
    // (cached under `%APPDATA%\wezterminator\themes\`) as a
    // `UserDownloaded` snapshot. The `SavedTheme` already carries
    // the same hex fields as `ThemeSnapshot`, so we map them
    // straight across (no palette round-trip needed). De-dup by id
    // — a built-in with the same slug wins (the built-ins are
    // pushed first, so we skip any downloaded theme whose id is
    // already present).
    for saved in crate::theme_download::load_saved_themes() {
        if themes.iter().any(|t| t.id == saved.id) {
            continue;
        }
        themes.push(saved_theme_to_snapshot(saved));
    }

    // Tabs: enumerate the active mux.
    let mut panes = Vec::new();
    if let Some(mux) = Mux::try_get() {
        for window_id in mux.iter_windows() {
            if let Some(window) = mux.get_window(window_id) {
                for (tab_index, tab) in window.iter().enumerate() {
                    tabs.push(snapshot_tab(tab, tab_index));
                    // Beth Studio (patch 0131): per-pane visual state.
                    for pos in tab.iter_panes_ignoring_zoom() {
                        panes.push(PaneSnapshot {
                            pane_id: pos.pane.pane_id(),
                            tab_id: tab.tab_id(),
                            theme_id: pos.pane.get_theme_id(),
                            font_family: pos.pane.get_font_family(),
                            font_scale: pos.pane.get_font_scale(),
                            font_bold: pos.pane.get_font_bold(),
                            font_italic: pos.pane.get_font_italic(),
                        });
                    }
                }
            }
        }
    }

    ConfigSnapshot {
        protocol_version: PROTOCOL_VERSION,
        wezterm_pid: std::process::id(),
        // WezTerminator (patch 0040): the window's base font
        // size, used as the default for the per-pane size control.
        base_font_size: config::configuration().font_size,
        default_theme: crate::default_theme::load(),
        tabs,
        themes,
        panes,
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use wezterm_term::color::ColorPalette;

    #[test]
    fn srgba_to_hex_is_lowercase() {
        let c = wezterm_color_types::SrgbaTuple(1.0, 0.0, 0.0, 1.0);
        assert_eq!(srgba_to_hex(c), "#ff0000");
        let c = wezterm_color_types::SrgbaTuple(0.0, 1.0, 0.0, 1.0);
        assert_eq!(srgba_to_hex(c), "#00ff00");
        let c = wezterm_color_types::SrgbaTuple(0.0, 0.0, 1.0, 1.0);
        assert_eq!(srgba_to_hex(c), "#0000ff");
    }

    #[test]
    fn snapshot_theme_projects_palette_to_16_ansi() {
        // Use the default palette as a stand-in.
        let palette = ColorPalette::default();
        let snap = snapshot_theme(
            "test",
            "Test Theme",
            ThemeKind::BuiltIn,
            &palette,
        );
        assert_eq!(snap.id, "test");
        assert_eq!(snap.name, "Test Theme");
        assert_eq!(snap.kind, ThemeKind::BuiltIn);
        // 16 hex strings, each starting with '#'.
        for c in snap.ansi.iter() {
            assert!(c.starts_with('#'), "ansi color missing #: {}", c);
            assert_eq!(c.len(), 7, "ansi color wrong width: {}", c);
        }
        assert!(snap.foreground.starts_with('#'));
        assert!(snap.background.starts_with('#'));
        assert!(snap.cursor.starts_with('#'));
    }

    #[test]
    fn config_snapshot_serializes_to_json() {
        let snap = ConfigSnapshot {
            protocol_version: PROTOCOL_VERSION,
            wezterm_pid: 1234,
            base_font_size: 12.0,
            default_theme: None,
            tabs: vec![],
            themes: vec![],
            panes: vec![],
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"protocol_version\":1"));
        assert!(json.contains("\"wezterm_pid\":1234"));
        // Round-trip
        let parsed: ConfigSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.protocol_version, PROTOCOL_VERSION);
        assert_eq!(parsed.wezterm_pid, 1234);
    }

    #[test]
    fn protocol_version_is_one() {
        // Bump on breaking changes to the message
        // types above.
        assert_eq!(PROTOCOL_VERSION, 1);
    }

    #[test]
    fn snapshot_for_config_with_no_mux_is_empty() {
        // No Mux initialized in the test process —
        // the snapshot is valid but has no tabs.
        let snap = snapshot_for_config();
        assert_eq!(snap.protocol_version, PROTOCOL_VERSION);
        assert!(snap.tabs.is_empty());
        // Themes are always populated with at least the 3 built-ins.
        // Patch 0038: the count can be higher if the dev machine
        // running the tests has downloaded themes cached under
        // `%APPDATA%\wezterminator\themes\`, so we assert `>= 3` and
        // that the 3 built-ins are present (pushed first, so they
        // are at the front of the list).
        assert!(
            snap.themes.len() >= 3,
            "expected at least 3 built-in themes, got {}",
            snap.themes.len()
        );
        let built_in_ids: Vec<&str> = snap
            .themes
            .iter()
            .filter(|t| t.kind == ThemeKind::BuiltIn)
            .map(|t| t.id.as_str())
            .collect();
        assert!(built_in_ids.contains(&"vscode_light"));
        assert!(built_in_ids.contains(&"vscode_dark"));
        assert!(built_in_ids.contains(&"windows_terminal_dark"));
    }

    #[test]
    fn saved_theme_maps_to_user_downloaded_snapshot() {
        // Patch 0038: a `SavedTheme` maps field-for-field into a
        // `UserDownloaded` snapshot.
        let ansi: [String; 16] =
            std::array::from_fn(|i| format!("#{:02x}0000", i * 16));
        let saved = crate::theme_download::SavedTheme {
            id: "dracula".to_string(),
            name: "Dracula".to_string(),
            ansi: ansi.clone(),
            foreground: "#f8f8f2".to_string(),
            background: "#282a36".to_string(),
            cursor: "#f8f8f2".to_string(),
            selection_fg: "#f8f8f2".to_string(),
            selection_bg: "#44475a".to_string(),
        };
        let snap = saved_theme_to_snapshot(saved);
        assert_eq!(snap.id, "dracula");
        assert_eq!(snap.name, "Dracula");
        assert_eq!(snap.kind, ThemeKind::UserDownloaded);
        assert_eq!(snap.ansi, ansi);
        assert_eq!(snap.background, "#282a36");
        assert_eq!(snap.selection_bg, "#44475a");
        assert!(!snap.preview_text.is_empty());
    }
}
