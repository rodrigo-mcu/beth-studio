use anyhow::{anyhow, bail, Context};
use config::keyassignment::SpawnCommand;
use config::TermConfig;
use mux::activity::Activity;
use mux::domain::SplitSource;
use mux::tab::SplitRequest;
use mux::window::WindowId as MuxWindowId;
use mux::Mux;
use portable_pty::CommandBuilder;
use std::sync::Arc;
use wezterm_term::TerminalSize;

#[derive(Copy, Debug, Clone, Eq, PartialEq)]
pub enum SpawnWhere {
    NewWindow,
    NewTab,
    SplitPane(SplitRequest),
}

/// BethTerm (patch 0111 + 0117 + 0118): spawn a terminal in a brand-new
/// OS window without a `TermWindow` at hand. Called from the tray
/// "Novo terminal" submenu. The tray owner thread must not call
/// `promise::spawn::spawn` (`spawn_local`) or build fonts — that
/// panicked on the GUI thread and closed the whole app (WSL and any
/// other shell). Hop to the main executor first.
/// `None` uses the default program; `Some(args)` is the chosen shell.
pub fn spawn_new_window(args: Option<Vec<String>>) {
    promise::spawn::spawn_into_main_thread(async move {
        spawn_new_window_on_main(args);
    })
    .detach();
}

fn spawn_new_window_on_main(args: Option<Vec<String>>) {
    let config = config::configuration();
    let dpi = config.dpi.unwrap_or_else(::window::default_dpi);
    let size = config.initial_size(dpi as u32, crate::cell_pixel_dims(&config, dpi).ok());
    let term_config = Arc::new(config::TermConfig::with_config(config));
    let spawn = SpawnCommand {
        args,
        ..Default::default()
    };

    spawn_command_impl(&spawn, SpawnWhere::NewWindow, size, None, term_config)
}

pub fn spawn_command_impl(
    spawn: &SpawnCommand,
    spawn_where: SpawnWhere,
    size: TerminalSize,
    src_window_id: Option<MuxWindowId>,
    term_config: Arc<TermConfig>,
) {
    let spawn = spawn.clone();

    promise::spawn::spawn(async move {
        if let Err(err) =
            spawn_command_internal(spawn, spawn_where, size, src_window_id, term_config).await
        {
            log::error!("Failed to spawn: {:#}", err);
        }
    })
    .detach();
}

pub async fn spawn_command_internal(
    spawn: SpawnCommand,
    spawn_where: SpawnWhere,
    size: TerminalSize,
    src_window_id: Option<MuxWindowId>,
    term_config: Arc<TermConfig>,
) -> anyhow::Result<()> {
    let mux = Mux::get();
    let activity = Activity::new();

    let current_pane_id = match src_window_id {
        Some(window_id) => {
            if let Some(tab) = mux.get_active_tab_for_window(window_id) {
                tab.get_active_pane().map(|p| p.pane_id())
            } else {
                None
            }
        }
        None => None,
    };

    let cwd = if let Some(cwd) = spawn.cwd.as_ref() {
        Some(cwd.to_str().map(|s| s.to_owned()).ok_or_else(|| {
            anyhow!(
                "Domain::spawn requires that the cwd be unicode in {:?}",
                cwd
            )
        })?)
    } else {
        None
    };

    let cmd_builder = match (
        spawn.args.as_ref(),
        spawn.cwd.as_ref(),
        spawn.set_environment_variables.is_empty(),
    ) {
        (None, None, true) => None,
        _ => {
            let mut builder = spawn
                .args
                .as_ref()
                .map(|args| CommandBuilder::from_argv(args.iter().map(Into::into).collect()))
                .unwrap_or_else(CommandBuilder::new_default_prog);
            for (k, v) in spawn.set_environment_variables.iter() {
                builder.env(k, v);
            }
            if let Some(cwd) = &spawn.cwd {
                builder.cwd(cwd);
            }
            Some(builder)
        }
    };

    let workspace = mux.active_workspace().clone();

    match spawn_where {
        SpawnWhere::SplitPane(direction) => {
            let src_window_id = match src_window_id {
                Some(id) => id,
                None => anyhow::bail!("no src window when splitting a pane?"),
            };
            if let Some(tab) = mux.get_active_tab_for_window(src_window_id) {
                let src_pane = tab
                    .get_active_pane()
                    .ok_or_else(|| anyhow!("tab to have a pane"))?;

                // WezTerminator (patch 0054): a split should INHERIT the look
                // of the pane it grew from ("herdar o tema de onde clicou").
                // Capture the source pane's per-pane THEME — only when it has
                // an explicit override, so a default pane splits into a
                // default pane that keeps following the window theme — and its
                // per-pane FONT (size / family / bold / italic), BEFORE the
                // split, then copy them onto the new pane below. The next
                // paint's `ensure_pane_geometry` reflows the new pane to the
                // inherited font; its palette is read directly on paint.
                let inherit_theme = src_pane.get_theme_id();
                let inherit_palette = inherit_theme.as_ref().map(|_| src_pane.palette());
                let inherit_scale = src_pane.get_font_scale();
                let inherit_family = src_pane.get_font_family();
                let inherit_bold = src_pane.get_font_bold();
                let inherit_italic = src_pane.get_font_italic();

                log::trace!("doing split_pane");
                let (pane, _size) = mux
                    .split_pane(
                        // tab.tab_id(),
                        src_pane.pane_id(),
                        direction,
                        SplitSource::Spawn {
                            command: cmd_builder,
                            command_dir: cwd,
                        },
                        spawn.domain,
                    )
                    .await
                    .context("split_pane")?;
                pane.set_config(term_config);
                // BethTerm (patch 0161): remember `wsl.exe -d ...` etc.
                wtinator::pane_cmd::record(&*pane, spawn.args.as_deref());

                // WezTerminator (patch 0054): apply the inherited look to the
                // freshly-split pane.
                if let Some(theme) = inherit_theme {
                    pane.set_theme_id(Some(theme));
                }
                if let Some(palette) = inherit_palette {
                    pane.set_palette(palette);
                }
                pane.set_font_scale(inherit_scale);
                pane.set_font_family(inherit_family);
                pane.set_font_bold(inherit_bold);
                pane.set_font_italic(inherit_italic);
            } else {
                bail!("there is no active tab while splitting pane!?");
            }
        }
        _ => {
            // Patch 0167: every window uses the single host again.
            let domain = spawn.domain.clone();
            let (_tab, pane, window_id) = mux
                .spawn_tab_or_window(
                    match spawn_where {
                        SpawnWhere::NewWindow => None,
                        _ => src_window_id,
                    },
                    domain,
                    cmd_builder,
                    cwd,
                    size,
                    current_pane_id,
                    workspace,
                    spawn.position,
                )
                .await
                .context("spawn_tab_or_window")?;
            wtinator::pane_cmd::record(&*pane, spawn.args.as_deref());

            // If it was created in this window, it copies our handlers.
            // Otherwise, we'll pick them up when we later respond to
            // the new window being created.
            if Some(window_id) == src_window_id {
                pane.set_config(term_config);
            }

            // BethTerm (patch 0110): a brand-new tab/window with no
            // explicit per-pane theme picks up the persisted default.
            // Splits (the branch above) keep inheriting the source pane.
            wtinator::default_theme::apply_to_pane_if_unset(&*pane);
        }
    };

    drop(activity);

    Ok(())
}
