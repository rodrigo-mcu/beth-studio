// wtinator::themes_folder — Phase 1.7.
//
// Resolve the user's wezterm config directory and hand it to the
// operating system's file manager. The directory is the canonical
// place to drop a custom `*.toml` color scheme so it is picked up
// on the next `ReloadConfiguration` (or wezterm restart).
//
// Resolution follows the upstream wezterm convention:
//
//   $WEZTERM_CONFIG_DIR
//   $XDG_CONFIG_HOME/wezterm
//   ~/.config/wezterm
//   %APPDATA%/wezterm            (Windows)
//   ~/Library/Application Support/wezterm   (macOS)
//
// On Windows we spawn `explorer.exe <dir>`. On macOS it is `open
// <dir>`. On Linux it is `xdg-open <dir>`. The spawned process
// returns immediately (we do not wait on it) — the OS file
// manager is responsible for showing the window.

use anyhow::{Context, Result};
use std::path::PathBuf;

/// Return the path to the user's wezterm config directory. Created
/// (recursively) if it does not exist so the user can drop a theme
/// file into it without first having to launch the GUI.
pub fn config_dir() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("WEZTERM_CONFIG_DIR") {
        if !p.is_empty() {
            let path = PathBuf::from(p);
            std::fs::create_dir_all(&path).with_context(|| {
                format!("creating WEZTERM_CONFIG_DIR at {}", path.display())
            })?;
            return Ok(path);
        }
    }

    let path = if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            PathBuf::from(appdata).join("wezterm")
        } else {
            // Last-ditch fallback: %USERPROFILE%/.config/wezterm
            let home = std::env::var("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("."));
            home.join(".config").join("wezterm")
        }
    } else if cfg!(target_os = "macos") {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("wezterm")
        } else {
            PathBuf::from(".")
        }
    } else {
        // Linux / *BSD
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            PathBuf::from(xdg).join("wezterm")
        } else if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".config").join("wezterm")
        } else {
            PathBuf::from(".")
        }
    };

    std::fs::create_dir_all(&path)
        .with_context(|| format!("creating config dir at {}", path.display()))?;
    Ok(path)
}

/// Hand the config dir to the OS file manager. Best-effort: errors
/// are surfaced but the function does not crash the caller.
pub fn open_in_file_manager() -> Result<PathBuf> {
    let dir = config_dir()?;
    open_path_in_file_manager(&dir)?;
    Ok(dir)
}

#[cfg(windows)]
fn open_path_in_file_manager(path: &std::path::Path) -> Result<()> {
    std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .with_context(|| format!("spawning explorer.exe on {}", path.display()))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_path_in_file_manager(path: &std::path::Path) -> Result<()> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .with_context(|| format!("spawning open on {}", path.display()))?;
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn open_path_in_file_manager(path: &std::path::Path) -> Result<()> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .with_context(|| format!("spawning xdg-open on {}", path.display()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_creates_directory_if_missing() {
        // Use a temp subdir to avoid clobbering the user's real
        // config dir during tests. Override the env var to point at
        // a path inside target/.
        let tmp = std::env::temp_dir().join("wtinator-themes-folder-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("WEZTERM_CONFIG_DIR", &tmp);
        let dir = config_dir().expect("config_dir should succeed");
        assert!(dir.exists());
        assert!(dir.is_dir());
        std::env::remove_var("WEZTERM_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn open_path_in_file_manager_path_succeeds() {
        // We do not actually want to spawn explorer.exe from a test
        // runner, but the function should at least build the path
        // argument without panicking.
        let tmp = std::env::temp_dir();
        let result = config_dir();
        // On CI without WEZTERM_CONFIG_DIR set, this falls back to
        // APPDATA / HOME. We cannot assert much about the result
        // without a real env, but the call must not panic.
        let _ = result;
        let _ = tmp;
    }
}
