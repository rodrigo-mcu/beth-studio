//! GPU or CPU drawing (patch 0155).
//!
//! OpenGL on the graphics card is the default. CPU uses the Mesa
//! software renderer next to `bethterm-gui.exe`. The choice is read
//! when each window is created, so changing it restarts only the
//! interface. The host and the shells stay.

use anyhow::Result;
use std::path::PathBuf;

const FILE_NAME: &str = "render-mode";

/// Where the terminal cells are drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderMode {
    /// OpenGL on the graphics card.
    Gpu,
    /// Mesa `opengl32.dll` from the `mesa` folder, on the CPU.
    Cpu,
}

impl RenderMode {
    pub fn label(self) -> &'static str {
        match self {
            RenderMode::Gpu => "GPU",
            RenderMode::Cpu => "CPU",
        }
    }

    fn token(self) -> &'static str {
        match self {
            RenderMode::Gpu => "gpu",
            RenderMode::Cpu => "cpu",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "gpu" => Some(RenderMode::Gpu),
            "cpu" => Some(RenderMode::Cpu),
            _ => None,
        }
    }

    fn front_end(self) -> config::FrontEndSelection {
        match self {
            RenderMode::Gpu => config::FrontEndSelection::OpenGL,
            RenderMode::Cpu => config::FrontEndSelection::Software,
        }
    }
}

pub fn current() -> RenderMode {
    load().unwrap_or(RenderMode::Gpu)
}

/// Remember `mode` and make this process use it. Existing windows keep
/// the renderer they were opened with.
pub fn select(mode: RenderMode) -> Result<()> {
    save(mode)?;
    apply();
    log::info!("bethterm: render mode set to {}", mode.label());
    Ok(())
}

/// Apply the saved choice to the live config. Call once before the
/// first window is created.
pub fn apply() {
    let mode = current();
    let handle = config::configuration();
    if handle.front_end == mode.front_end() {
        return;
    }
    let mut cfg = (*handle).clone();
    cfg.front_end = mode.front_end();
    config::use_this_configuration(cfg);
    log::info!("bethterm: drawing with {}", mode.label());
}

fn path() -> Result<PathBuf> {
    Ok(crate::session::session_dir()?.join(FILE_NAME))
}

fn load() -> Option<RenderMode> {
    let path = path().ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    RenderMode::parse(&text)
}

fn save(mode: RenderMode) -> Result<()> {
    let path = path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, mode.token())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip() {
        assert_eq!(RenderMode::parse("gpu"), Some(RenderMode::Gpu));
        assert_eq!(RenderMode::parse("cpu"), Some(RenderMode::Cpu));
        assert_eq!(RenderMode::parse("nope"), None);
        assert_eq!(RenderMode::Gpu.token(), "gpu");
        assert_eq!(RenderMode::Cpu.token(), "cpu");
    }
}
