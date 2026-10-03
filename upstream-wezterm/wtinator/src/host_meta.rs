// wtinator::host_meta — patch 0122.
//
// Visual overrides (header, theme, font) for panes that live on
// `bethterm-host`. The GUI `ClientPane` does not keep them across
// reconnect; this sidecar is keyed by the host's pane id, which
// does survive.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use wezterm_client::pane::ClientPane;

const FILENAME: &str = "host-panes.json";

/// One pane's GUI-only look, stored under the remote (host) pane id.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PaneVisual {
    /// Remote / host pane id.
    pub remote_pane_id: usize,
    /// Per-pane header label.
    #[serde(default)]
    pub header_text: Option<String>,
    /// Theme id from Settings / right-click.
    #[serde(default)]
    pub theme_id: Option<String>,
    /// Font size scale (1.0 = window default).
    #[serde(default = "default_scale")]
    pub font_scale: f64,
    /// Font family override.
    #[serde(default)]
    pub font_family: Option<String>,
    /// Bold override.
    #[serde(default)]
    pub font_bold: bool,
    /// Italic override.
    #[serde(default)]
    pub font_italic: bool,
}

fn default_scale() -> f64 {
    1.0
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    panes: BTreeMap<String, PaneVisual>,
}

fn store_path() -> Result<PathBuf> {
    Ok(crate::session::session_dir()?.join(FILENAME))
}

fn load_store() -> Store {
    let Ok(path) = store_path() else {
        return Store::default();
    };
    let Ok(bytes) = fs::read(&path) else {
        return Store::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_store(store: &Store) -> Result<()> {
    let path = store_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .with_context(|| format!("create {}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(store)?;
    fs::write(&tmp, bytes).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path).with_context(|| format!("rename {}", path.display()))?;
    Ok(())
}

/// Persist one pane after the GUI changes its look.
pub fn persist(visual: &wezterm_client::pane::BethTermVisual) {
    let mut store = load_store();
    let key = visual.remote_pane_id.to_string();
    store.panes.insert(
        key,
        PaneVisual {
            remote_pane_id: visual.remote_pane_id,
            header_text: visual.header_text.clone(),
            theme_id: visual.theme_id.clone(),
            font_scale: visual.font_scale,
            font_family: visual.font_family.clone(),
            font_bold: visual.font_bold,
            font_italic: visual.font_italic,
        },
    );
    if let Err(err) = save_store(&store) {
        log::warn!("bethterm-host: persist pane visual failed: {err:#}");
    }
}

/// Register the ClientPane persist hook (once per GUI process).
pub fn install_visual_hook() {
    let _ = wezterm_client::pane::BETHTERM_VISUAL_CHANGED.set(persist);
}

/// Apply stored visuals onto attached `ClientPane`s (by host pane id).
pub fn apply_to_mux() -> usize {
    let Some(mux) = mux::Mux::try_get() else {
        return 0;
    };
    let store = load_store();
    if store.panes.is_empty() {
        return 0;
    }
    let mut applied = 0usize;
    let live: std::collections::HashSet<usize> = mux
        .iter_panes()
        .iter()
        .filter_map(|pane| {
            pane.downcast_ref::<ClientPane>()
                .map(|cp| cp.remote_pane_id)
        })
        .collect();
    for pane in mux.iter_panes() {
        let Some(cp) = pane.downcast_ref::<ClientPane>() else {
            continue;
        };
        let Some(meta) = store.panes.get(&cp.remote_pane_id.to_string()) else {
            continue;
        };
        apply_one(&*pane, meta);
        applied += 1;
    }
    if applied > 0 {
        log::info!("bethterm-host: restored visual metadata on {applied} pane(s)");
    }
    let before = store.panes.len();
    let mut pruned = store;
    pruned.panes.retain(|_, v| live.contains(&v.remote_pane_id));
    if pruned.panes.len() != before {
        let _ = save_store(&pruned);
    }
    applied
}

fn apply_one(pane: &dyn mux::pane::Pane, meta: &PaneVisual) {
    pane.set_header_text(meta.header_text.clone());
    if meta.font_scale != 1.0 {
        pane.set_font_scale(meta.font_scale);
    }
    pane.set_font_family(meta.font_family.clone());
    pane.set_font_bold(meta.font_bold);
    pane.set_font_italic(meta.font_italic);
    #[cfg(windows)]
    {
        if let Some(ref theme) = meta.theme_id {
            if let Some(palette) = crate::notify_ipc::palette_from_theme_id(theme) {
                pane.set_palette(palette);
                pane.set_theme_id(Some(theme.clone()));
            }
        }
    }
    #[cfg(not(windows))]
    {
        pane.set_theme_id(meta.theme_id.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visual_roundtrip_json() {
        let v = PaneVisual {
            remote_pane_id: 7,
            header_text: Some("build".into()),
            theme_id: Some("vscode_dark".into()),
            font_scale: 1.25,
            font_family: Some("Consolas".into()),
            font_bold: true,
            font_italic: false,
        };
        let bytes = serde_json::to_vec(&v).expect("json");
        let back: PaneVisual = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(v, back);
    }
}
