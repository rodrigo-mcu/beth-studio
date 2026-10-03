use config::keyassignment::SpawnTabDomain;
use mux::domain::SplitSource;
use mux::tab::{SplitDirection, SplitRequest, SplitSize};
use mux::window::WindowId;
use mux::Mux;
use portable_pty::CommandBuilder;
use smol::Timer;
use wezterm_term::TerminalSize;

/// WezTerminator (patch 0079): load + restore after the OS window is
/// shown. A hung AppData read must not delay `window.show()`.
pub fn start_startup_restore(window_id: WindowId, terminal_size: TerminalSize) {
    if !wtinator::session::claim_startup_restore() {
        return;
    }
    match wtinator::session::load() {
        Ok(Some(session)) => {
            let (applied_tabs, applied_panes, skipped) = wtinator::session::apply(&session);
            log::info!(
                "wezterminator: applied metadata to {} tab(s) and {} pane header(s), \
                 skipped {} (not in mux)",
                applied_tabs,
                applied_panes,
                skipped
            );
            // Patches 0121/0123: the host owns the shells. Spawning
            // from session.json onto ClientDomain panics
            // (`primary window to be valid`) and would duplicate
            // panes after reconnect. Metadata only.
            if skip_host_session_respawn() {
                log::info!(
                    "bethterm-host: skip session respawn; panes live on the host"
                );
                wtinator::host_meta::apply_to_mux();
                return;
            }
            if session.tabs.len() > applied_tabs {
                let session_tabs = session.tabs.len();
                let session_panes = session.panes.len();
                promise::spawn::spawn(async move {
                    let restore = restore_session(&session, window_id, terminal_size);
                    let timeout = async {
                        Timer::at(
                            std::time::Instant::now() + std::time::Duration::from_secs(15),
                        )
                        .await;
                        Err(anyhow::anyhow!(
                            "session restore timed out after 15s; keeping the visible window"
                        ))
                    };
                    match smol::future::or(restore, timeout).await {
                        Ok(()) => {
                            log::info!(
                                "wezterminator: restored session with {} tab(s) and {} pane(s)",
                                session_tabs,
                                session_panes,
                            );
                        }
                        Err(e) => {
                            log::warn!("wezterminator: session restore failed: {:#}", e);
                        }
                    }
                })
                .detach();
            }
        }
        Ok(None) => {
            log::info!("wezterminator patch 0029: no session.json yet");
        }
        Err(e) => {
            log::warn!(
                "wezterminator patch 0029: failed to load session.json: {:#}",
                e
            );
        }
    }
}

/// Patch 0167: skip only when the host still had terminals (a GUI
/// restart). A host that came up empty lost them, so `session.json`
/// is respawned onto it, with each pane's saved command (0161). The
/// 0123 panic (`primary window to be valid`) is handled as a skip.
fn skip_host_session_respawn() -> bool {
    wtinator::host::host_had_existing_panes()
}

/// WezTerminator (patch 0049): a restored pane's saved cwd can point at a
/// now-unreachable network / WSL share (e.g. `\\host\mnt\...`). Spawning a
/// shell there makes Windows block for a long time resolving the path, which
/// starves the GUI executor so the window never paints (it "doesn't open").
/// Validate the cwd with a short timeout — the `is_dir` probe runs on a
/// throwaway thread so a dead UNC host can never hang us — and DROP it if it
/// isn't a reachable directory. The pane then opens in the default dir instead
/// of hanging the whole window.
fn safe_restore_cwd(cwd: Option<&str>) -> Option<String> {
    let c = cwd?.to_string();
    let probe = c.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    // Detached probe thread; if `is_dir` hangs on a dead share, the thread
    // leaks harmlessly (it unblocks when the OS network call finally times
    // out) while we move on.
    let _ = std::thread::Builder::new()
        .name("wt-cwd-probe".into())
        .spawn(move || {
            let _ = tx.send(std::path::Path::new(&probe).is_dir());
        });
    match rx.recv_timeout(std::time::Duration::from_millis(300)) {
        Ok(true) => Some(c),
        _ => {
            log::warn!(
                "wezterminator: restored cwd {:?} is unreachable or missing; \
                 opening the pane in the default directory instead",
                c
            );
            None
        }
    }
}

/// BethTerm (patch 0161): command, start directory, and argv for one
/// restored pane. A WSL pane comes back as `wsl.exe --cd <linux path>`
/// instead of the default Windows shell in the Windows home folder.
fn restore_spawn(
    entry: Option<&wtinator::session::PaneEntry>,
) -> (Option<CommandBuilder>, Option<String>, Option<Vec<String>>) {
    let Some(entry) = entry else {
        return (None, None, None);
    };
    let computer = std::env::var("COMPUTERNAME").ok();
    let plan = wtinator::wsl::restore_command(
        &entry.args,
        entry.program.as_deref(),
        entry.cwd.as_deref(),
        computer.as_deref(),
    );
    // Patch 0049: validate the cwd so an unreachable share can't hang.
    let cwd = safe_restore_cwd(plan.windows_cwd.as_deref());
    let command = plan.argv.as_ref().map(|argv| {
        let mut builder = CommandBuilder::from_argv(argv.iter().map(Into::into).collect());
        if let Some(ref cwd) = cwd {
            builder.cwd(cwd);
        }
        builder
    });
    (command, cwd, plan.argv)
}

pub async fn restore_session(
    session: &wtinator::session::Session,
    window_id: WindowId,
    terminal_size: TerminalSize,
) -> anyhow::Result<()> {
    let mux = Mux::get();

    if session.tabs.is_empty() {
        return Ok(());
    }

    // WezTerminator (patch 0055): the auto-created startup tab. The previous
    // restore REUSED this tab for tab 0 and put it back in the saved cwd by
    // writing a visible `cd <cwd>` into the shell — so the FIRST terminal came
    // up with an auto-typed `cd ...` line the user never entered. Instead we
    // spawn EVERY restored tab fresh in its own cwd (no `cd`; the same proven
    // path tabs 1+ already use) and remove this empty startup tab once the
    // restored tabs exist.
    let startup_tab_id = mux.get_active_tab_for_window(window_id).map(|t| t.tab_id());

    // Session v8 records the physical window of every tab. The first tab for
    // each additional saved window is spawned with `window_id=None`, letting
    // the established mux path create and populate that window atomically.
    let max_window_index = session
        .tabs
        .iter()
        .map(|tab| tab.window_index)
        .max()
        .unwrap_or(0);
    let mut window_ids = vec![None; max_window_index + 1];
    window_ids[0] = Some(window_id);

    // Indexed exactly like `session.tabs`; failed restores remain `None` so
    // pane metadata can never slide onto the wrong tab.
    let mut created_tabs: Vec<Option<(mux::tab::TabId, WindowId)>> =
        Vec::with_capacity(session.tabs.len());

    for (tab_index, tab_entry) in session.tabs.iter().enumerate() {
        // Patch 0163: the same filtered list for spawn, split, and
        // metadata, so saved entries stay aligned with live panes.
        let tab_panes = wtinator::session::restorable_panes(&session.panes, tab_index);

        let (command, command_dir, tab_argv) = restore_spawn(tab_panes.first().copied());

        let requested_window = window_ids
            .get(tab_entry.window_index)
            .copied()
            .flatten();
        // Patch 0167: the single host is the default domain.
        let domain = SpawnTabDomain::DefaultDomain;
        let result = mux
            .spawn_tab_or_window(
                requested_window,
                domain,
                command,
                command_dir,
                terminal_size,
                None,
                mux.active_workspace().clone(),
                None,
            )
            .await;

        match result {
            Ok((tab, pane, target_window)) => {
                wtinator::pane_cmd::record(&*pane, tab_argv.as_deref());
                log::info!(
                    "wezterminator: restored tab {} (id={})",
                    tab_index,
                    tab.tab_id()
                );
                if let Some(slot) = window_ids.get_mut(tab_entry.window_index) {
                    *slot = Some(target_window);
                }
                created_tabs.push(Some((tab.tab_id(), target_window)));
            }
            Err(e) => {
                log::warn!(
                    "wezterminator: failed to restore tab {}: {:#}",
                    tab_index,
                    e
                );
                created_tabs.push(None);
            }
        }
    }

    // WezTerminator (patch 0055): drop the empty startup tab now that the
    // restored tabs exist, so the first terminal is the freshly-spawned tab 0
    // (in its saved cwd, no `cd`) rather than the reused startup tab. Guard so
    // a fully-failed restore (nothing created) never removes the only tab and
    // leaves an empty window.
    if let Some(startup) = startup_tab_id {
        let restored_any = created_tabs.iter().any(Option::is_some);
        let startup_was_restored = created_tabs
            .iter()
            .flatten()
            .any(|(tab_id, _)| *tab_id == startup);
        if restored_any && !startup_was_restored {
            mux.remove_tab(startup);
        }
    }

    for (tab_index, created) in created_tabs.iter().enumerate() {
        let Some((new_tab_id, _target_window)) = created else {
            continue;
        };
        let tab_entry = &session.tabs[tab_index];
        if let Some(tab) = mux.get_tab(*new_tab_id) {
            tab.set_group_name(tab_entry.group_name.clone());
            if let Some(ref title) = tab_entry.tab_title {
                tab.set_title(title);
            }
            // WezTerminator (patch 0029.1): restore the per-tab
            // user title (patch 0031) onto the respawned tab —
            // previously only group_name / OSC title were
            // restored, so the user-set tab name was lost.
            if let Some(ref ut) = tab_entry.user_title {
                tab.set_user_title(Some(ut.clone()));
            }
        }

        // Patch 0163: the same filtered list for spawn, split, and
        // metadata, so saved entries stay aligned with live panes.
        let tab_panes = wtinator::session::restorable_panes(&session.panes, tab_index);

        if tab_panes.len() <= 1 {
            continue;
        }

        if let Some(tab) = mux.get_tab(*new_tab_id) {
            if let Some(root_pane) = tab.get_active_pane() {
                let mut last_pane_id = root_pane.pane_id();

                for (pane_index, pane_entry) in tab_panes.iter().enumerate().skip(1) {
                    let (command, command_dir, pane_argv) = restore_spawn(Some(*pane_entry));

                    // WezTerminator (patch 0029.2): pick the split
                    // orientation from the saved pane position. A pane
                    // offset DOWNWARD (top > 0) is a Vertical (top /
                    // bottom) split; a pane offset to the RIGHT (top
                    // == 0, left > 0) is a Horizontal (left / right)
                    // split. The previous mapping was inverted (it
                    // used `left > 0 => Vertical`), which is why
                    // restored splits came back rotated 90° from how
                    // they were saved.
                    let direction = if pane_entry.top > 0 {
                        SplitDirection::Vertical
                    } else {
                        SplitDirection::Horizontal
                    };

                    let request = SplitRequest {
                        direction,
                        target_is_second: true,
                        top_level: false,
                        // Patch 0163: from the saved sizes, not 50%.
                        size: SplitSize::Percent(wtinator::session::split_percent(
                            &tab_panes,
                            pane_index,
                            direction == SplitDirection::Horizontal,
                        )),
                    };

                    let result = mux
                        .split_pane(
                            last_pane_id,
                            request,
                            SplitSource::Spawn {
                                command,
                                command_dir,
                            },
                            // Patch 0161: the default domain is whichever
                            // window host registered last (patch 0159).
                            SpawnTabDomain::CurrentPaneDomain,
                        )
                        .await;

                    match result {
                        Ok((pane, _size)) => {
                            wtinator::pane_cmd::record(&*pane, pane_argv.as_deref());
                            log::info!(
                                "wezterminator: split pane {} in tab {}",
                                pane.pane_id(),
                                tab_index
                            );
                            last_pane_id = pane.pane_id();
                        }
                        Err(e) => {
                            log::warn!(
                                "wezterminator: failed to split pane in tab {}: {:#}",
                                tab_index,
                                e
                            );
                        }
                    }
                }
            }
        }
    }

    // WezTerminator (patch 0029.1): restore each pane's own
    // header_text (the per-terminal name). Previously the same
    // header was applied to EVERY pane of a tab; now we match the
    // saved pane entries to the live panes by their order within
    // the tab so each terminal gets its own name back.
    for (tab_index, created) in created_tabs.iter().enumerate() {
        let Some((new_tab_id, _target_window)) = created else {
            continue;
        };
        // Patch 0163: the same filtered list for spawn, split, and
        // metadata, so saved entries stay aligned with live panes.
        let tab_panes = wtinator::session::restorable_panes(&session.panes, tab_index);
        if tab_panes.is_empty() {
            continue;
        }
        if let Some(tab) = mux.get_tab(*new_tab_id) {
            let mut needs_reflow = false;
            for (pos, entry) in tab.iter_panes().iter().zip(tab_panes.iter()) {
                if let Some(ref header) = entry.header_text {
                    pos.pane.set_header_text(Some(header.clone()));
                }
                // WezTerminator (patch 0041): restore the per-pane font
                // scale; the tab is re-flowed below so the PTY grid
                // matches the restored cell size. The reflow reads
                // `font_scale` directly (family_ratio defaults to (1,1)),
                // so the size restore is exact with no extra bookkeeping.
                if let Some(scale) = entry.font_scale {
                    pos.pane.set_font_scale(scale);
                    needs_reflow = true;
                }
                // WezTerminator (patch 0043): restore the per-pane font
                // family. The mux only stores the intent; the family's
                // precise cell aspect (`family_ratio`) needs font metrics
                // (GUI) and is computed by `apply_pane_font_scale_change`,
                // which does not run in this mux-only restore path. So the
                // shaped GLYPHS are correct immediately (the renderer lays
                // out from `pane_metrics`, not the PTY grid), but the
                // grid's column count uses the window-font aspect until the
                // next apply (e.g. the user changes any per-pane font, or
                // a future GUI-side post-restore apply) corrects it.
                if let Some(ref family) = entry.font_family {
                    pos.pane.set_font_family(Some(family.clone()));
                    needs_reflow = true;
                }
                // WezTerminator (patch 0047): restore per-pane bold/italic.
                // `ensure_pane_geometry` re-derives the cell aspect on the
                // first paint (bold can be wider), same as for a family.
                if entry.font_bold {
                    pos.pane.set_font_bold(true);
                    needs_reflow = true;
                }
                if entry.font_italic {
                    pos.pane.set_font_italic(true);
                    needs_reflow = true;
                }
                // WezTerminator (patch 0041): restore the per-pane theme.
                // `notify_ipc` (which owns `palette_from_theme_id`) is
                // Windows-only, so this block is gated; the per-terminal
                // theme feature is Windows-only anyway.
                #[cfg(windows)]
                {
                    if let Some(ref theme) = entry.theme_id {
                        if let Some(palette) =
                            wtinator::notify_ipc::palette_from_theme_id(theme)
                        {
                            pos.pane.set_palette(palette);
                            pos.pane.set_theme_id(Some(theme.clone()));
                        }
                    }
                }
                // BethTerm (patch 0110): panes that never had a theme
                // pick up the persisted default instead of the window
                // fallback.
                wtinator::default_theme::apply_to_pane_if_unset(&*pos.pane);
            }
            // Re-flow so any restored font scales take effect on the
            // panes' PTY grids (mirrors `apply_pane_font_scale_change`).
            if needs_reflow {
                tab.resize(tab.get_size());
            }
        }
    }

    for entry in &session.windows {
        if let Some(Some(target_window)) = window_ids.get(entry.window_index) {
            if let Some(ref title) = entry.user_title {
                if let Some(mut window) = mux.get_window_mut(*target_window) {
                    window.set_user_title(Some(title.clone()));
                }
            }
        }
    }

    for active_pane in session.panes.iter().filter(|p| p.is_active) {
        if let Some(Some((tab_id, active_window_id))) = created_tabs.get(active_pane.tab_index) {
            let tab_ids: Vec<mux::tab::TabId> = {
                if let Some(window) = mux.get_window(*active_window_id) {
                    window.iter().map(|t| t.tab_id()).collect()
                } else {
                    Vec::new()
                }
            };
            for (idx, tid) in tab_ids.iter().enumerate() {
                if *tid == *tab_id {
                    if let Some(mut window) = mux.get_window_mut(*active_window_id) {
                        window.save_and_then_set_active(idx);
                    }
                    break;
                }
            }
        }
    }

    Ok(())
}
