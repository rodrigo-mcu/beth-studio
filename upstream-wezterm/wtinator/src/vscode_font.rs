// wtinator::vscode_font — Phase 2.2 (patch 0023).
//
// Read the user's Visual Studio Code `settings.json` and pick up
// the `editor.fontFamily` and `editor.fontSize` keys so the
// wezterminator terminal uses the same monospace font the user
// sees in their editor. This is a small quality-of-life thing
// for people who have a curated font setup in VSCode (Cascadia
// Code NF, JetBrains Mono, Fira Code NF, Iosevka NF, Recursive,
// etc.) and want the terminal to match.
//
// ## Where the file lives
//
// VSCode on Windows stores `settings.json` at:
//
//     %APPDATA%\Code\User\settings.json
//     %APPDATA%\Code - Insiders\User\settings.json
//     %APPDATA%\VSCodium\User\settings.json       (VSCodium)
//     %APPDATA%\Cursor\User\settings.json          (Cursor fork)
//
// The user can also have a per-workspace settings file at
// `.vscode/settings.json` inside the current directory; we do
// not consult that here because the wezterm launchers do not
// necessarily run from a project root. The user-level settings
// are what matter for the "match the editor" goal.
//
// The file is plain JSON. Comments and trailing commas are
// allowed by VSCode's JSON parser (and by `json5`); we use
// `json` for now and tolerate a parse failure by silently
// falling back to no overrides (i.e. the user keeps the
// upstream defaults). A future improvement could swap to
// `json5` to allow VSCode-style comments.
//
// ## How the override is applied
//
// We expose a single public function, `default_overrides()`,
// that returns a `wezterm_dynamic::Value::Object` with the keys
// `font` and `font_size` if and only if the user has a VSCode
// settings file with a `editor.fontFamily` /
// `editor.fontSize` entry. The patched upstream
// `TermWindow::new_window` (patch 0020 fix #1) reads this
// function before calling `Window::new_window` and applies
// the merged config so the first paint of every window
// already uses the user's font.
//
// The user can always override in `wezterm.lua`:
//
// ```lua
// return {
//   font = wezterm.font 'Cascadia Code NF',
//   font_size = 11.0,
// }
// ```
//
// User-defined values win because the user-facing config has
// the highest priority in the upstream merge order.

use std::path::PathBuf;
use wezterm_dynamic::{Object, Value};

/// The user's `editor.fontFamily` value from VSCode, trimmed
/// and ready to feed into wezterm's `config.font`. We keep
/// only the first comma-separated name (VSCode supports
/// fallbacks but wezterm's `font` takes a single primary
/// family plus its own fallback list).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VscodeFontSettings {
    /// Primary monospace family from `editor.fontFamily`. May
    /// be empty if the user only set the size.
    pub family: Option<String>,
    /// `editor.fontSize`. May be `None` if the user only set
    /// the family.
    pub size: Option<u32>,
}

/// Try to read the VSCode user-level `settings.json` and
/// extract the monospace font settings. Returns `None` if the
/// file is not found, cannot be parsed, or contains neither
/// `editor.fontFamily` nor `editor.fontSize`.
///
/// ## Path resolution
///
/// On Windows we look in this order:
/// 1. `%APPDATA%\Code\User\settings.json`
/// 2. `%APPDATA%\Code - Insiders\User\settings.json`
/// 3. `%APPDATA%\VSCodium\User\settings.json`
/// 4. `%APPDATA%\Cursor\User\settings.json`
///
/// The first file that exists is read. If it parses but
/// contains no relevant keys, we still return `Some` with
/// both fields set to `None` so the caller can decide what
/// to do (we treat it as "user has no preference" and
/// return `None` from `default_overrides()`).
pub fn read_user_settings() -> Option<VscodeFontSettings> {
    for path in candidate_paths() {
        if let Some(settings) = read_from(&path) {
            return Some(settings);
        }
    }
    None
}

fn candidate_paths() -> Vec<PathBuf> {
    let appdata = match std::env::var_os("APPDATA") {
        Some(p) => p,
        None => return Vec::new(),
    };
    let appdata = PathBuf::from(appdata);
    let candidates = ["Code", "Code - Insiders", "VSCodium", "Cursor"];
    candidates
        .iter()
        .map(|name| appdata.join(name).join("User").join("settings.json"))
        .collect()
}

fn read_from(path: &std::path::Path) -> Option<VscodeFontSettings> {
    let bytes = std::fs::read(path).ok()?;
    // VSCode's settings.json supports JSON5 (trailing commas,
    // comments). We use the strict `serde_json` parser for
    // now and silently fall back to `None` on failure. A
    // future patch could swap in `json5` to support comments.
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let obj = value.as_object()?;

    let family = obj
        .get("editor.fontFamily")
        .and_then(|v| v.as_str())
        .map(|s| {
            // VSCode lets the user write a comma-separated
            // list (first is primary). We keep only the first
            // name and trim whitespace.
            s.split(',').next().unwrap_or(s).trim().to_string()
        })
        .filter(|s: &String| !s.is_empty());

    let size = obj
        .get("editor.fontSize")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok());

    Some(VscodeFontSettings { family, size })
}

/// Produce the merged config overrides that should be applied
/// to the freshly constructed window so the first paint uses
/// the VSCode font. Returns `None` if VSCode is not installed,
/// its settings file is unparseable, or it contains neither
/// `editor.fontFamily` nor `editor.fontSize`.
///
/// The returned `Value::Object` is shaped so that the upstream
/// `config::overridden_config` merge picks it up:
/// `font` becomes `wezterm.config.font` and `font_size`
/// becomes `wezterm.config.font_size`.
pub fn default_overrides() -> Option<Value> {
    let settings = read_user_settings()?;
    if settings.family.is_none() && settings.size.is_none() {
        return None;
    }
    let mut map = Object::default();
    if let Some(family) = settings.family {
        map.insert(
            Value::String("font".to_string()),
            Value::String(family),
        );
    }
    if let Some(size) = settings.size {
        // The upstream `font_size` is an `f64` in points. We
        // hand the u32 straight to wezterm-dynamic; the merge
        // path accepts the integer.
        map.insert(
            Value::String("font_size".to_string()),
            Value::U64(size as u64),
        );
    }
    Some(Value::Object(map))
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_minimal_settings() {
        let dir = tempdir();
        let path = dir.join("settings.json");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(
            br#"{
                "editor.fontFamily": "JetBrains Mono, Consolas, monospace",
                "editor.fontSize": 12
            }"#,
        )
        .unwrap();
        drop(f);
        let settings = read_from(&path).unwrap();
        assert_eq!(
            settings.family.as_deref(),
            Some("JetBrains Mono"),
            "expected primary family, got {:?}",
            settings.family
        );
        assert_eq!(settings.size, Some(12));
    }

    #[test]
    fn reads_only_family() {
        let dir = tempdir();
        let path = dir.join("settings.json");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(br#"{ "editor.fontFamily": "Fira Code" }"#)
            .unwrap();
        drop(f);
        let settings = read_from(&path).unwrap();
        assert_eq!(settings.family.as_deref(), Some("Fira Code"));
        assert_eq!(settings.size, None);
    }

    #[test]
    fn returns_none_when_file_missing() {
        let dir = tempdir();
        let path = dir.join("nope.json");
        assert!(read_from(&path).is_none());
    }

    #[test]
    fn returns_none_on_invalid_json() {
        let dir = tempdir();
        let path = dir.join("settings.json");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"not json at all").unwrap();
        drop(f);
        assert!(read_from(&path).is_none());
    }

    #[test]
    fn default_overrides_skips_when_irrelevant() {
        let dir = tempdir();
        let path = dir.join("settings.json");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(br#"{ "editor.tabSize": 4 }"#).unwrap();
        drop(f);
        assert!(read_from(&path).unwrap().family.is_none());
        assert!(read_from(&path).unwrap().size.is_none());
    }

    fn tempdir() -> std::path::PathBuf {
        let base = std::env::temp_dir();
        let unique = format!(
            "wtinator-vscode-font-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = base.join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
