//! Open the Beth Studio SFTP window for a saved SSH host (patch 0188).
//!
//! Launches `bethterm-web.exe --sftp <hostId>` from the same folder as
//! this GUI. The host id comes from the pane argv
//! (`bethterm-tool.exe --ssh <16 hex>`).

use anyhow::{bail, Context, Result};
use mux::pane::Pane;
use std::path::PathBuf;
use std::sync::Arc;

/// 16 lowercase hex digits (same rule as bethterm-web / bridge spawn_tool).
fn valid_host_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn tool_base(name: &str) -> &str {
    let n = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let n = n.strip_suffix(".old").unwrap_or(n);
    n.strip_suffix(".exe").unwrap_or(n)
}

/// Extract `--ssh <id>` from a pane command line.
pub fn ssh_host_id_from_argv(argv: &[String]) -> Option<String> {
    if argv.is_empty() {
        return None;
    }
    match tool_base(&argv[0]) {
        "bethterm-tool" | "bethterm-web" => {}
        _ => return None,
    }
    let mut i = 1;
    while i + 1 < argv.len() {
        if argv[i] == "--ssh" && valid_host_id(&argv[i + 1]) {
            return Some(argv[i + 1].clone());
        }
        i += 1;
    }
    None
}

fn web_exe() -> Result<PathBuf> {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .context("cannot locate GUI directory")?;
    let web = dir.join("bethterm-web.exe");
    if !web.is_file() {
        bail!("bethterm-web.exe não encontrado em {}", dir.display());
    }
    Ok(web)
}

/// Open a separate SFTP window for the focused SSH pane (saved host).
pub fn open_for_pane(pane: &Arc<dyn Pane>) -> Result<()> {
    let argv = crate::pane_cmd::lookup(pane.as_ref())
        .context("este terminal não tem comando gravado (não é um SSH salvo?)")?;
    let id = ssh_host_id_from_argv(&argv)
        .context("este terminal não é um SSH de host salvo (bethterm-tool --ssh)")?;
    let web = web_exe()?;
    let mut cmd = std::process::Command::new(&web);
    cmd.arg("--sftp").arg(&id);
    if let Some(dir) = web.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let child = cmd.spawn().with_context(|| format!("iniciar {}", web.display()))?;
    log::info!(
        "bethterm sftp: opened window for host {id} (web pid {:?})",
        child.id()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_argv() {
        let argv = vec![
            r"C:\Users\Public\BethTerm\bethterm-tool.exe".into(),
            "--ssh".into(),
            "9263ae68ac129132".into(),
        ];
        assert_eq!(
            ssh_host_id_from_argv(&argv).as_deref(),
            Some("9263ae68ac129132")
        );
    }

    #[test]
    fn parses_renamed_old_tool() {
        let argv = vec![
            r"C:\x\bethterm-tool.exe.old".into(),
            "--ssh".into(),
            "abcdef0123456789".into(),
        ];
        assert_eq!(
            ssh_host_id_from_argv(&argv).as_deref(),
            Some("abcdef0123456789")
        );
    }

    #[test]
    fn rejects_plain_ssh() {
        let argv = vec!["ssh.exe".into(), "root@host".into()];
        assert!(ssh_host_id_from_argv(&argv).is_none());
    }
}
