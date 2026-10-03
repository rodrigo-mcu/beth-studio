// wtinator::favorites — persisted favourite theme PRESETS for the config app
// (patches 0060 + 0062).
//
// The WezTerminator Settings app (wtinator-config) loads its HTML via
// `WebViewBuilder::with_html(...)`, which gives the page a `null` origin;
// WebView2 does not persist `localStorage` for a null origin, so favourites are
// kept on disk here instead, as a JSON array at
//
//   %APPDATA%\wezterminator\theme-favorites.json     (Windows)
//   ~/.config/wezterminator/theme-favorites.json     (other)
//
// (the same directory as `session.json`). Each entry is a *preset* — a theme id
// plus the font to apply with it (size / family / bold / italic). The exact
// shape is owned by the config frontend; this module stores the array opaquely
// (as `serde_json::Value`), so the preset format can evolve without touching
// the host. The frontend loads/saves over the existing IPC bridge
// (get_favorites / save_favorites).

use anyhow::{Context, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

const FILENAME: &str = "theme-favorites.json";

/// Absolute path to the favourites file (under the WezTerminator config dir).
fn favorites_path() -> Result<PathBuf> {
    Ok(crate::session::session_dir()?.join(FILENAME))
}

/// Load the saved favourites as a JSON array. A missing, empty, or unparseable
/// file yields an empty array — favourites are non-critical UI state, so a
/// corrupt file must never break the config app.
pub fn load() -> Result<Value> {
    load_from(&favorites_path()?)
}

/// Persist the favourites array (overwrites the file). `items` must be a JSON
/// array; anything else is rejected.
pub fn save(items: &Value) -> Result<()> {
    save_to(&favorites_path()?, items)
}

fn load_from(path: &Path) -> Result<Value> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) if v.is_array() => Ok(v),
        // Corrupt or unexpected shape: start empty rather than fail the UI.
        _ => Ok(empty()),
    }
}

fn save_to(path: &Path, items: &Value) -> Result<()> {
    anyhow::ensure!(items.is_array(), "favorites must be a JSON array");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let json = serde_json::to_vec_pretty(items).context("serializing favorites")?;
    std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn empty() -> Value {
    Value::Array(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn unique_temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("wezterminator-favorites-tests");
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[test]
    fn load_from_missing_file_is_empty_array() {
        let path = unique_temp("missing.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load_from(&path).unwrap(), json!([]));
    }

    #[test]
    fn save_then_load_roundtrips_presets() {
        let path = unique_temp("roundtrip.json");
        let items = json!([
            { "id": "vscode_dark", "fontSize": 14, "fontFamily": "Cascadia Code", "bold": false, "italic": false },
            { "id": "gogh_tokyo_night", "fontSize": 12, "fontFamily": "", "bold": true, "italic": false }
        ]);
        save_to(&path, &items).unwrap();
        assert_eq!(load_from(&path).unwrap(), items);
        save_to(&path, &json!([])).unwrap();
        assert_eq!(load_from(&path).unwrap(), json!([]));
    }

    #[test]
    fn load_from_corrupt_or_non_array_is_empty() {
        let path = unique_temp("corrupt.json");
        std::fs::write(&path, b"{ not valid json").unwrap();
        assert_eq!(load_from(&path).unwrap(), json!([]));
        std::fs::write(&path, b"\"a string\"").unwrap();
        assert_eq!(load_from(&path).unwrap(), json!([]));
    }

    #[test]
    fn save_rejects_non_array() {
        let path = unique_temp("reject.json");
        assert!(save_to(&path, &json!({ "not": "array" })).is_err());
    }

    #[test]
    fn save_creates_missing_parent_dir() {
        let path = unique_temp("nested/deeper/favs.json");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        save_to(&path, &json!([{ "id": "a" }])).unwrap();
        assert_eq!(load_from(&path).unwrap(), json!([{ "id": "a" }]));
    }
}
