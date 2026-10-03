// wtinator::default_theme — persisted global default theme (patch 0110).
//
// The Settings app can mark one theme as the default for every terminal.
// That choice is stored next to session.json:
//
//   %APPDATA%\bethstudio\default-theme.json     (Windows)
//   ~/.config/bethstudio/default-theme.json     (other)
//
// Shape: `{ "theme": "dracula" }` or `{ "theme": null }` to clear.
// New tabs/windows with no explicit per-pane theme stamp this id;
// splits keep inheriting the source pane (patch 0054).
//
// Beth Studio (patch 0132): the file also carries the default FONT
// (`font_family`, `font_scale`, `font_bold`, `font_italic`). A new
// terminal that has no font override of its own picks these up too.

use anyhow::{Context, Result};
use mux::pane::Pane;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use wezterm_term::color::ColorPalette;

const FILENAME: &str = "default-theme.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
struct Store {
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    font_family: Option<String>,
    #[serde(default)]
    font_scale: Option<f64>,
    #[serde(default)]
    font_bold: bool,
    #[serde(default)]
    font_italic: bool,
}

/// Beth Studio (patch 0132): everything a new terminal inherits by default.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DefaultStyle {
    pub theme: Option<String>,
    /// `None` = window font.
    pub font_family: Option<String>,
    /// Scale relative to the window base size; `None` = 1.0.
    pub font_scale: Option<f64>,
    pub font_bold: bool,
    pub font_italic: bool,
}

impl DefaultStyle {
    /// True when any font field differs from the window font.
    pub fn has_font(&self) -> bool {
        self.font_family.is_some()
            || self.font_scale.map(|s| (s - 1.0).abs() > 0.0001).unwrap_or(false)
            || self.font_bold
            || self.font_italic
    }
}

fn clean(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(|s| s.to_string())
}

impl From<Store> for DefaultStyle {
    fn from(st: Store) -> Self {
        DefaultStyle {
            theme: clean(st.theme.as_deref()),
            font_family: clean(st.font_family.as_deref()),
            font_scale: st.font_scale.filter(|s| s.is_finite() && *s > 0.0),
            font_bold: st.font_bold,
            font_italic: st.font_italic,
        }
    }
}

impl From<&DefaultStyle> for Store {
    fn from(d: &DefaultStyle) -> Self {
        Store {
            theme: clean(d.theme.as_deref()),
            font_family: clean(d.font_family.as_deref()),
            font_scale: d.font_scale.filter(|s| s.is_finite() && *s > 0.0),
            font_bold: d.font_bold,
            font_italic: d.font_italic,
        }
    }
}

/// Absolute path to the default-theme file (under the Beth Studio config dir).
fn default_theme_path() -> Result<PathBuf> {
    Ok(crate::session::session_dir()?.join(FILENAME))
}

/// Load the persisted default theme id. A missing, empty, or unparseable
/// file yields `None` — this is non-critical UI state.
pub fn load() -> Option<String> {
    load_from(&default_theme_path().ok()?)
}

/// Beth Studio (patch 0132): load the whole default style (theme + font).
pub fn load_style() -> Option<DefaultStyle> {
    load_style_from(&default_theme_path().ok()?)
}

/// Persist (or clear) the default theme id. The saved default font, if
/// any, is kept.
pub fn save(theme: Option<&str>) -> Result<()> {
    save_to(&default_theme_path()?, theme)
}

/// Beth Studio (patch 0132): persist the whole default style.
pub fn save_style(style: &DefaultStyle) -> Result<()> {
    save_style_to(&default_theme_path()?, style)
}

fn load_style_from(path: &Path) -> Option<DefaultStyle> {
    let bytes = std::fs::read(path).ok()?;
    let store: Store = serde_json::from_slice(&bytes).ok()?;
    Some(store.into())
}

fn load_from(path: &Path) -> Option<String> {
    load_style_from(path)?.theme
}

fn save_style_to(path: &Path, style: &DefaultStyle) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let store: Store = style.into();
    let json = serde_json::to_vec_pretty(&store).context("serializing default theme")?;
    std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn save_to(path: &Path, theme: Option<&str>) -> Result<()> {
    let mut style = load_style_from(path).unwrap_or_default();
    style.theme = clean(theme);
    save_style_to(path, &style)
}

/// Resolve a theme id (built-in slug or downloaded Gogh id) to a palette.
pub fn palette_for(id: &str) -> Option<ColorPalette> {
    use crate::vscode_theme::ThemeId;
    match id {
        "vscode_light" => Some(ThemeId::VsCodeLight.build_palette()),
        "vscode_dark" => Some(ThemeId::VsCodeDark.build_palette()),
        "windows_terminal_dark" => Some(ThemeId::WindowsTerminalDark.build_palette()),
        "default" => Some(ThemeId::VsCodeDark.build_palette()),
        other => crate::theme_download::palette_for_saved(other),
    }
}

/// Stamp the persisted default onto a pane that has no explicit theme yet.
/// No-op when the pane already has a theme_id or no default is saved.
/// Beth Studio (patch 0132): the default font is stamped as well, but only
/// on a pane that has no font override of its own.
pub fn apply_to_pane_if_unset(pane: &dyn Pane) {
    let Some(style) = load_style() else {
        return;
    };
    if pane.get_theme_id().is_none() {
        if let Some(palette) = style.theme.as_deref().and_then(palette_for) {
            pane.set_theme_id(style.theme.clone());
            pane.set_palette(palette);
        }
    }
    if style.has_font() && pane_font_is_untouched(pane) {
        apply_font_to_pane(pane, &style);
    }
}

/// True when the pane still uses the window font (no family, size,
/// bold or italic override).
pub fn pane_font_is_untouched(pane: &dyn Pane) -> bool {
    pane.get_font_family().is_none()
        && (pane.get_font_scale() - 1.0).abs() < 0.0001
        && !pane.get_font_bold()
        && !pane.get_font_italic()
}

/// Beth Studio (patch 0132): copy the default font fields onto a pane. The
/// GUI reflows the pane grid on its next paint (`ensure_pane_geometry`).
pub fn apply_font_to_pane(pane: &dyn Pane, style: &DefaultStyle) {
    pane.set_font_family(style.font_family.clone());
    pane.set_font_scale(style.font_scale.unwrap_or(1.0));
    pane.set_font_bold(style.font_bold);
    pane.set_font_italic(style.font_italic);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn unique_temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("bethstudio-default-theme-tests");
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[test]
    fn load_from_missing_file_is_none() {
        let path = unique_temp("missing.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load_from(&path), None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let path = unique_temp("roundtrip.json");
        save_to(&path, Some("dracula")).unwrap();
        assert_eq!(load_from(&path).as_deref(), Some("dracula"));
        save_to(&path, None).unwrap();
        assert_eq!(load_from(&path), None);
        save_to(&path, Some("  ")).unwrap();
        assert_eq!(load_from(&path), None);
    }

    #[test]
    fn load_from_corrupt_is_none() {
        let path = unique_temp("corrupt.json");
        std::fs::write(&path, b"{ not valid").unwrap();
        assert_eq!(load_from(&path), None);
        std::fs::write(&path, b"\"a string\"").unwrap();
        assert_eq!(load_from(&path), None);
    }

    #[test]
    fn save_creates_missing_parent_dir() {
        let path = unique_temp("nested/deeper/default-theme.json");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        save_to(&path, Some("vscode_dark")).unwrap();
        assert_eq!(load_from(&path).as_deref(), Some("vscode_dark"));
        let parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed["theme"], json!("vscode_dark"));
    }

    #[test]
    fn style_roundtrips_and_theme_save_keeps_font() {
        let path = unique_temp("style.json");
        let style = DefaultStyle {
            theme: Some("dracula".into()),
            font_family: Some("Cascadia Code".into()),
            font_scale: Some(1.25),
            font_bold: true,
            font_italic: false,
        };
        save_style_to(&path, &style).unwrap();
        assert_eq!(load_style_from(&path), Some(style.clone()));
        assert!(style.has_font());
        // Changing only the theme keeps the font.
        save_to(&path, Some("nord")).unwrap();
        let again = load_style_from(&path).unwrap();
        assert_eq!(again.theme.as_deref(), Some("nord"));
        assert_eq!(again.font_family.as_deref(), Some("Cascadia Code"));
        assert!(again.font_bold);
        // Old-format file (theme only) still loads, with no font.
        std::fs::write(&path, br#"{ "theme": "vscode_dark" }"#).unwrap();
        let old = load_style_from(&path).unwrap();
        assert_eq!(old.theme.as_deref(), Some("vscode_dark"));
        assert!(!old.has_font());
    }

    #[test]
    fn palette_for_known_builtins() {
        assert!(palette_for("vscode_light").is_some());
        assert!(palette_for("vscode_dark").is_some());
        assert!(palette_for("windows_terminal_dark").is_some());
        assert!(palette_for("default").is_some());
        assert!(palette_for("!!definitely-not-a-real-theme!!").is_none());
    }
}
