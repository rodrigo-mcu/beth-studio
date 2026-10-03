// wtinator — BethTerm's delta crate (historical crate name).
//
// This is the **only** place we add new code. Everything that distinguishes
// us from upstream wezterm lives here. The product name is BethTerm; this
// crate kept the `wtinator` identifier so existing patches and call sites
// stay stable.
//
// Phase 0 (W0.2 / W0.3 of docs/IMPLEMENTATION.md): the modules below are
// declared but stubbed. They will be filled in by the sub-phases of
// Phase 1 — see docs/IMPLEMENTATION.md §1.A.

#![warn(missing_docs)]

//! BethTerm delta over upstream wezterm.
//!
//! See `docs/ARCHITECTURE.md` for the design and `docs/IMPLEMENTATION.md`
//! for the phased build plan.
//!
//! **Phase 0 caveat:** this crate is intentionally upstream-free (no
//! `mux`, `config`, etc. path deps). See `wtinator/Cargo.toml` for the
//! rationale (upstream uses `edition = "2024"` and the current stable
//! Rust 1.84 does not support it).
//!
//! **Unsafe policy:** the `unsafe_code` lint is set to `warn` at
//! the crate level (in `Cargo.toml`) and the `wtinator` delta
//! should add `#[allow(unsafe_code)]` on any module that needs
//! raw Win32 FFI. As of patch 0030, the only such module is
//! `header::win32_prompt` (the Win32 input dialog). Patch 0032
//! adds `confirm` (Win32 MessageBoxW); both use
//! `#[allow(unsafe_code)]` on the `#[cfg(windows)]` body.

/// Windows where an agent is waiting for the user (patch 0152).
pub mod agent_wait;
pub mod broadcast;
pub mod clipboard;
pub mod config_lua;
pub mod confirm;
pub mod context_menu;
pub mod cursor_anim;
pub mod cursor_color;
/// Persisted default theme for new terminals (patch 0110).
pub mod default_theme;
pub mod favorites;
pub mod file_link;
pub mod font_presets;
pub mod groups;
pub mod header;
/// Left-rail pane dashboard (patch 0124).
pub mod dashboard;
/// Persistent PTY host process (patch 0121).
pub mod host;
/// Host-pane visual sidecar (patch 0122).
pub mod host_meta;
pub mod image_paste;
pub mod layout_io;
/// Log directory pruning at GUI start (patch 0133).
pub mod log_prune;
/// BethTerm (patch 0147): restart only the GUI; terminals stay in the host.
pub mod echo_latency;
pub mod gui_restart;
pub mod menu_icons;
pub mod notify;
pub mod notify_ipc;
pub mod picker;
/// GPU or CPU drawing (patch 0155).
pub mod render_mode;
/// Native terminal window on or off (patch 0192).
pub mod native_gui;
pub mod save_scrollback;
/// Open Beth Studio SFTP window for an SSH pane (patch 0188).
pub mod sftp_window;
pub mod screenshot;
pub mod session;
pub mod split_heal;
pub mod shell_menu;
pub mod status_bar;
/// CPU / RAM / disk sampling for the system panel (patch 0112).
pub mod sysmon;
#[cfg(windows)]
/// "BethTerm - Sistema" modeless window (patch 0112).
pub mod syspanel;
/// Per-window taskbar icon color (patch 0151).
pub mod taskbar_icon;
pub mod theme_download;
pub mod themes_folder;
pub mod titlebar;
#[cfg(windows)]
pub mod tray;
/// UI thread stall detector (patch 0162).
pub mod ui_watchdog;
/// Command each host pane was started with (patch 0161).
pub mod pane_cmd;
pub mod vscode_font;
pub mod vscode_settings;
pub mod vscode_theme;
pub mod window_geom;
pub mod window_heal;
pub mod wsl;

use anyhow::Result;

/// Public product name.
pub const PRODUCT_NAME: &str = "BethTerm";
/// Directory under `%APPDATA%` / `$XDG_CONFIG_HOME` for BethTerm state.
pub const DATA_DIR_NAME: &str = "bethterm";
/// Previous WezTerminator data directory. `session_dir` migrates this.
pub const LEGACY_DATA_DIR_NAME: &str = "wezterminator";

/// True when this process should run in BethTerm (WezTerminator) mode.
pub fn is_active() -> bool {
    std::env::var_os("BETHTERM_ACTIVE").is_some() || std::env::var_os("WTINATOR_ACTIVE").is_some()
}

/// Install BethTerm into the running wezterm process.
///
/// Called once from `wezterminator/src/main.rs` after config has been
/// loaded and before the GUI starts. This function:
///
/// 1. Reads the `wtinator = { ... }` table from the active Lua config
///    (via [`config_lua::initialize`]) and stores it in a process-global
///    [`WtinatorConfig`].
/// 2. Initializes the in-process state for each enabled feature
///    (groups, broadcast, clipboard pipeline, etc.).
/// 3. Registers any sidecars into `mux::Mux` for later use by the GUI
///    hooks (added in Phase 1.B+).
///
/// Phase 0 is a no-op install that only validates the config shape.
///
/// **Note:** the upstream `wezterm` binary does not expose a library
/// entry point we can call from. The `wezterminator` binary crate
/// therefore **does not invoke this function** in Phase 0; Phase 0 only
/// proves that the workspace + this crate compile and link. The
/// `Option B` strategy from `docs/ARCHITECTURE.md` ("copy wezterm's
/// main.rs into our binary") will start calling this function as
/// soon as we copy the entry point in Phase 0.W0.4.
pub fn install() -> Result<()> {
    config_lua::initialize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_does_not_panic_with_no_features_enabled() {
        // Phase 0: install() must succeed when no BethTerm-specific
        // Lua config is present. The real test in Phase 1.A.3 will feed
        // synthetic Lua tables through config_lua::load and assert the
        // deserialized shape.
        //
        // We cannot easily construct a `ConfigHandle` here without the
        // upstream's config init, so we just check that the module
        // graph compiles and that config_lua::initialize() returns Ok.
        config_lua::initialize().expect("config_lua::initialize should succeed in Phase 0");
    }
}
