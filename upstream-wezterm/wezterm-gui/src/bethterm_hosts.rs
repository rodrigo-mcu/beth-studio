//! The persistent PTY host (patch 0121). Patch 0167 returns to one
//! `bethterm-host.exe` for every window; patch 0159 had run one per
//! window, which brought restore, split, and tray bugs.

use ::window::{Connection, ConnectionOps};
use mux::domain::Domain;
use mux::Mux;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wezterm_client::domain::{ClientDomain, ClientDomainConfig, BETHTERM_HOSTS_LOST_WITH_PANES};

/// Patch 0167: at most this many automatic host restarts per window of
/// time, so a host that dies at start cannot loop forever.
const MAX_RECOVERIES: usize = 3;
const RECOVERY_WINDOW: Duration = Duration::from_secs(600);

/// The mux has no pane left. Closing windows during teardown fires
/// this once per window, so repeats within 3 s are ignored.
pub fn on_mux_empty() {
    if wtinator::tray::quit_requested() {
        promise::spawn::spawn_into_main_thread(async move {
            if mux::activity::Activity::count() == 0 {
                wtinator::host::note_life("GUI quitting: tray Sair/Encerrar asked for it");
                Connection::get().unwrap().terminate_message_loop();
            }
        })
        .detach();
        return;
    }
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
            return;
        }
        *last = Some(Instant::now());
    }
    let lost = BETHTERM_HOSTS_LOST_WITH_PANES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if wtinator::host::any_died_with_panes(&lost) {
        promise::spawn::spawn(recover()).detach();
        return;
    }
    // Patch 0165: the user closed every terminal. The last auto-save
    // still lists them; the next start must not bring them back.
    if wtinator::session::startup_restore_claimed() {
        match wtinator::session::save() {
            Ok(_) => wtinator::host::note_life("every terminal was closed; session.json cleared"),
            Err(e) => log::warn!("bethterm: clearing session failed: {e:#}"),
        }
    }
    wtinator::host::note_life("last window closed; BethTerm stays in the tray");
}

/// Patch 0167: the host went away with terminals in it (crash, kill,
/// update, or an unknown quit request). Start it again and restore
/// `session.json` into a new window, as a fresh start would.
async fn recover() {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    static HISTORY: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    {
        let mut h = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
        h.retain(|t| t.elapsed() < RECOVERY_WINDOW);
        if h.len() >= MAX_RECOVERIES {
            wtinator::host::note_life(
                "host died again; not restarting it automatically (3 times in 10 min). \
                 session.json is kept; open a terminal from the tray to try again",
            );
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
        h.push(Instant::now());
    }
    wtinator::host::note_life("host went away with terminals; restarting it and restoring the session");
    BETHTERM_HOSTS_LOST_WITH_PANES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    if let Err(err) =
        promise::spawn::spawn_into_new_thread(|| wtinator::host::ensure_running()).await
    {
        wtinator::host::note_life(&format!("recovery: host did not start: {err:#}"));
        RUNNING.store(false, Ordering::SeqCst);
        return;
    }
    if let Some(domain) = Mux::get().get_domain_by_name(wtinator::host::DOMAIN_NAME) {
        if let Err(err) = domain.attach(None).await {
            wtinator::host::note_life(&format!("recovery: attach failed: {err:#}"));
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    }
    #[cfg(windows)]
    wtinator::host::watch_host_exit();
    wtinator::host::note_host_had_existing_panes(false);
    wtinator::session::rearm_startup_restore();
    // The new window's `created` hook runs the startup restore.
    crate::spawn::spawn_new_window(None);
    wtinator::host::note_life("recovery: host restarted; restoring session.json");
    RUNNING.store(false, Ordering::SeqCst);
}

/// Register the single host as the default domain. Window hosts left
/// over from 0159 builds are attached too (not as default), so their
/// terminals stay reachable until they are closed.
pub fn attach() {
    wtinator::host::prune_stale_host_files();
    let mux = Mux::get();
    for id in wtinator::host::running_ids() {
        let unix = wtinator::host::unix_domain_for(id.as_deref());
        let name = unix.name.clone();
        if mux.get_domain_by_name(&name).is_none() {
            let domain: Arc<dyn Domain> =
                Arc::new(ClientDomain::new(ClientDomainConfig::Unix(unix)));
            mux.add_domain(&domain);
            if id.is_some() {
                wtinator::host::note_life(&format!(
                    "GUI attached leftover window host {name} (from a 0159 build)"
                ));
            }
        }
    }
    if let Some(domain) = mux.get_domain_by_name(wtinator::host::DOMAIN_NAME) {
        mux.set_default_domain(&domain);
        log::info!("bethterm-host: default domain is {}", wtinator::host::DOMAIN_NAME);
    }
}
