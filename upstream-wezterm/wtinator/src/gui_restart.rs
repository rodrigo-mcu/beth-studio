//! BethTerm (patch 0147): restart only the GUI process.
//!
//! Since patch 0121 the PTYs live in `bethterm-host.exe`, so killing
//! `bethterm-gui.exe` and starting it again loses nothing: the new GUI
//! reattaches every terminal. This is the cure for a GUI whose tray
//! icon vanished or whose native menus stopped appearing.
//!
//! Used by `bethterm gui-restart [--wait-pid N]` and by the tray entry
//! "Reiniciar a janela nativa", which spawns that command against its own
//! pid and then quits cleanly.

#![allow(unsafe_code)]

use anyhow::{Context, Result};
use std::path::PathBuf;

/// Wait this long for a cleanly quitting GUI before terminating it.
const WAIT_SECS: u32 = 15;

/// Path of `bethterm-gui.exe` next to the current executable
/// (fallback: the upstream `wezterm-gui.exe` name).
pub fn gui_exe() -> Result<PathBuf> {
    let dir = std::env::current_exe()
        .context("current_exe")?
        .parent()
        .context("exe has no parent dir")?
        .to_path_buf();
    let primary = dir.join("bethterm-gui.exe");
    if primary.is_file() {
        return Ok(primary);
    }
    let legacy = dir.join("wezterm-gui.exe");
    anyhow::ensure!(
        legacy.is_file(),
        "bethterm-gui.exe not found next to {}",
        dir.display()
    );
    Ok(legacy)
}

/// Restart the GUI. `wait_pid`: a GUI that is quitting on its own; wait
/// for it (then terminate it if it hangs). `None`: terminate every
/// `bethterm-gui.exe` except the caller. Never touches the host.
/// Returns a one-line description of what happened.
#[cfg(windows)]
pub fn run(wait_pid: Option<u32>) -> Result<String> {
    let mut what = Vec::new();
    match wait_pid {
        Some(pid) => match wait_or_terminate(pid) {
            WaitOutcome::Gone => what.push(format!("GUI {pid} had already exited")),
            WaitOutcome::Exited => what.push(format!("GUI {pid} exited")),
            WaitOutcome::Terminated => what.push(format!("GUI {pid} did not exit in {WAIT_SECS}s; terminated")),
        },
        None => {
            let n = terminate_gui_processes();
            what.push(format!("terminated {n} bethterm-gui.exe process(es)"));
        }
    }
    let exe = gui_exe()?;
    launch_detached(&exe)?;
    what.push(format!("started {}", exe.display()));
    Ok(what.join("; "))
}

#[cfg(not(windows))]
pub fn run(_wait_pid: Option<u32>) -> Result<String> {
    anyhow::bail!("gui-restart is Windows-only")
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
enum WaitOutcome {
    Gone,
    Exited,
    Terminated,
}

#[cfg(windows)]
fn wait_or_terminate(pid: u32) -> WaitOutcome {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject,
    };
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_TERMINATE: u32 = 0x0001;
    let handle = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        return WaitOutcome::Gone;
    }
    let rc = unsafe { WaitForSingleObject(handle, WAIT_SECS * 1000) };
    let outcome = if rc == WAIT_OBJECT_0 {
        WaitOutcome::Exited
    } else {
        log::warn!("bethterm gui-restart: pid {pid} still alive after {WAIT_SECS}s; terminating");
        unsafe {
            TerminateProcess(handle, 1);
            WaitForSingleObject(handle, 3000);
        }
        WaitOutcome::Terminated
    };
    unsafe {
        CloseHandle(handle);
    }
    outcome
}

/// Terminate every `bethterm-gui.exe` (not the host, not ourselves).
#[cfg(windows)]
fn terminate_gui_processes() -> usize {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject,
    };
    const PROCESS_TERMINATE: u32 = 0x0001;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let me = std::process::id();
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap.is_null() || snap == (-1isize as HANDLE) {
        return 0;
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut n = 0usize;
    let mut ok = unsafe { Process32FirstW(snap, &mut entry) };
    while ok != 0 {
        let end = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase();
        if is_gui_exe_name(&name) && entry.th32ProcessID != me {
            let proc = unsafe {
                OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, entry.th32ProcessID)
            };
            if !proc.is_null() {
                unsafe {
                    if TerminateProcess(proc, 1) != 0 {
                        n += 1;
                        WaitForSingleObject(proc, 3000);
                    }
                    CloseHandle(proc);
                }
            }
        }
        ok = unsafe { Process32NextW(snap, &mut entry) };
    }
    unsafe {
        CloseHandle(snap);
    }
    n
}

/// Only the GUI image names; the host must survive a GUI restart.
fn is_gui_exe_name(lower: &str) -> bool {
    lower == "bethterm-gui.exe" || lower == "wezterm-gui.exe"
}

#[cfg(windows)]
fn launch_detached(exe: &std::path::Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let mut cmd = std::process::Command::new(exe);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.env("BETHTERM_ACTIVE", "1");
    cmd.env("WTINATOR_ACTIVE", "1");
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.spawn()
        .with_context(|| format!("launching {}", exe.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_gui_images_are_targets() {
        assert!(is_gui_exe_name("bethterm-gui.exe"));
        assert!(is_gui_exe_name("wezterm-gui.exe"));
        assert!(!is_gui_exe_name("bethterm-host.exe"));
        assert!(!is_gui_exe_name("bethterm.exe"));
        assert!(!is_gui_exe_name("openconsole.exe"));
    }
}
