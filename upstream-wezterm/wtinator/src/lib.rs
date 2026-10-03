// wtinator — Beth Studio's delta crate (historical crate name).
//
// This is the **only** place we add new code. Everything that distinguishes
// us from upstream wezterm lives here. The product name is Beth Studio; this
// crate kept the `wtinator` identifier so existing patches and call sites
// stay stable.
//
// Phase 0 (W0.2 / W0.3 of docs/IMPLEMENTATION.md): the modules below are
// declared but stubbed. They will be filled in by the sub-phases of
// Phase 1 — see docs/IMPLEMENTATION.md §1.A.

#![warn(missing_docs)]

//! Beth Studio delta over upstream wezterm.
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
pub mod config_lua;
/// Persisted default theme for new terminals (patch 0110).
pub mod default_theme;
pub mod groups;
/// Persistent PTY host process (patch 0121).
pub mod host;
/// Echo latency probe used by the client pane.
pub mod echo_latency;
pub mod notify;
pub mod notify_ipc;
pub mod session;
pub mod shells;
/// Per-window taskbar icon color (patch 0151).
pub mod taskbar_icon;
pub mod theme_download;
/// Command each host pane was started with (patch 0161).
pub mod pane_cmd;
pub mod vscode_theme;
pub mod window_geom;

use anyhow::Result;

/// Public product name.
pub const PRODUCT_NAME: &str = "Beth Studio";
/// Directory under `%APPDATA%` / `$XDG_CONFIG_HOME` for Beth Studio state.
pub const DATA_DIR_NAME: &str = "bethstudio";
/// Previous WezTerminator data directory. `session_dir` migrates this.
pub const LEGACY_DATA_DIR_NAME: &str = "wezterminator";

/// True when this process should run in Beth Studio (WezTerminator) mode.
pub fn is_active() -> bool {
    std::env::var_os("BETHSTUDIO_ACTIVE").is_some() || std::env::var_os("WTINATOR_ACTIVE").is_some()
}

/// Install Beth Studio into the running wezterm process.
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
        // Phase 0: install() must succeed when no BethStudio-specific
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
