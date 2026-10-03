// wtinator::pane_cmd — patch 0161.
//
// The command line each host pane was started with (for example
// `wsl.exe -d Debian`). A `ClientPane` cannot report its foreground
// process, so without this sidecar `session.json` never knew a pane
// was WSL, and a restore after a host exit brought every terminal back
// as the default Windows shell.
//
// Keyed by `<host domain>#<remote pane id>`: pane ids restart at 1 in
// every window host (patch 0159). Entries of hosts that are no longer
// running are dropped on the next write; by then `session.json`
// already holds the command.

use anyhow::{Context, Result};
use mux::pane::Pane;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use wezterm_client::pane::ClientPane;

const FILENAME: &str = "pane-commands.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    panes: BTreeMap<String, Vec<String>>,
}

static CACHE: Mutex<Option<Store>> = Mutex::new(None);

fn store_path() -> Result<PathBuf> {
    Ok(crate::session::session_dir()?.join(FILENAME))
}

fn load() -> Store {
    let Ok(path) = store_path() else {
        return Store::default();
    };
    std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(store: &Store) -> Result<()> {
    let path = store_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(store)?)
        .with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("rename {}", path.display()))?;
    Ok(())
}

fn key_of(pane: &dyn Pane) -> Option<String> {
    let cp = pane.downcast_ref::<ClientPane>()?;
    let mux = mux::Mux::try_get()?;
    let domain = mux.get_domain(pane.domain_id())?;
    Some(key(domain.domain_name(), cp.remote_pane_id))
}

fn key(domain: &str, remote_pane_id: usize) -> String {
    format!("{domain}#{remote_pane_id}")
}

fn domain_of_key(key: &str) -> &str {
    key.rsplit_once('#').map(|(d, _)| d).unwrap_or(key)
}

/// Remember the command `pane` was spawned with. `None` (the default
/// shell) forgets any earlier entry for that pane.
pub fn record(pane: &dyn Pane, argv: Option<&[String]>) {
    let Some(key) = key_of(pane) else {
        return;
    };
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let store = guard.get_or_insert_with(load);
    match argv {
        Some(argv) if !argv.is_empty() => {
            store.panes.insert(key, argv.to_vec());
        }
        _ => {
            if store.panes.remove(&key).is_none() {
                return;
            }
        }
    }
    store
        .panes
        .retain(|k, _| crate::host::domain_host_running(domain_of_key(k)));
    if let Err(err) = save(store) {
        log::warn!("bethstudio: saving {FILENAME} failed: {err:#}");
    }
}

/// The command `pane` was spawned with, if it was not the default shell.
pub fn lookup(pane: &dyn Pane) -> Option<Vec<String>> {
    let key = key_of(pane)?;
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(load).panes.get(&key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_keeps_host_and_pane_apart() {
        let k = key("bethstudio-host-w12-3", 4);
        assert_eq!(k, "bethstudio-host-w12-3#4");
        assert_eq!(domain_of_key(&k), "bethstudio-host-w12-3");
        assert_ne!(key("bethstudio-host-w1-1", 1), key("bethstudio-host-w1-2", 1));
    }

    #[test]
    fn store_roundtrips() {
        let mut store = Store::default();
        store.panes.insert(
            key("bethstudio-host", 7),
            vec!["wsl.exe".into(), "-d".into(), "Debian".into()],
        );
        let bytes = serde_json::to_vec(&store).expect("json");
        let back: Store = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(back.panes, store.panes);
    }
}
