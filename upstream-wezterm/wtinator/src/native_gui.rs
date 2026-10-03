//! Native terminal window on or off (patch 0192).
//!
//! The OpenGL window is created only when a terminal window is opened.
//! Off keeps this process alive so the tray icon stays, and never
//! creates that window, so the renderer does not start. The host,
//! the shells, and Beth Studio keep running. The choice is
//! `%APPDATA%\bethterm\native-gui` (`on` or `off`). Missing or
//! anything else means on.

use anyhow::Result;
use std::path::PathBuf;

const FILE_NAME: &str = "native-gui";

/// Whether terminal windows (and their renderer) should be created.
///
/// Missing file, unreadable file, or any token other than `off` means
/// on, so a broken file cannot hide the interface.
pub fn enabled() -> bool {
    load().unwrap_or(true)
}

/// Remember the choice. Takes effect on the next GUI start.
pub fn set_enabled(on: bool) -> Result<()> {
    save(on)?;
    log::info!(
        "bethterm: native GUI {}",
        if on { "on" } else { "off" }
    );
    Ok(())
}

fn token(on: bool) -> &'static str {
    if on {
        "on"
    } else {
        "off"
    }
}

fn parse(text: &str) -> Option<bool> {
    match text.trim() {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

fn path() -> Result<PathBuf> {
    Ok(crate::session::session_dir()?.join(FILE_NAME))
}

fn load() -> Option<bool> {
    let path = path().ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    parse(&text)
}

fn save(on: bool) -> Result<()> {
    let path = path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, token(on))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip() {
        assert_eq!(parse("on"), Some(true));
        assert_eq!(parse("off"), Some(false));
        assert_eq!(parse(" off\n"), Some(false));
        assert_eq!(parse("nope"), None);
        assert_eq!(parse(""), None);
        assert_eq!(token(true), "on");
        assert_eq!(token(false), "off");
    }
}
