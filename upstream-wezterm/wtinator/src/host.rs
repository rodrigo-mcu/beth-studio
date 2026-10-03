// wtinator::host — patch 0121.
//
// Long-lived PTY owner (`bethterm-host.exe`). The GUI attaches over a
// unix-domain socket and can exit or be replaced; shells and agents
// stay in this process.

#![allow(unsafe_code)]

use anyhow::{Context, Result};
use config::UnixDomain;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static HOST_HAD_EXISTING_PANES: AtomicBool = AtomicBool::new(false);

/// Mux domain name used by the GUI ClientDomain.
pub const DOMAIN_NAME: &str = "bethterm-host";

const MUTEX_NAME: &str = "Local\\BethTermHost";
const QUIT_EVENT_NAME: &str = "Local\\BethTermHostQuit";

static HOST_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// This process's window-host id, from `BETHTERM_HOST_ID`. Empty means
/// the legacy single host (`host.sock`).
pub fn adopt_id_from_env() {
    if let Ok(raw) = std::env::var("BETHTERM_HOST_ID") {
        let id = sanitize_id(&raw);
        if !id.is_empty() {
            let _ = HOST_ID.set(id);
        }
    }
}

fn current_id() -> Option<&'static str> {
    HOST_ID.get().map(|s| s.as_str())
}

pub fn sanitize_id(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect()
}

pub fn alloc_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!("w{}-{n}", std::process::id())
}

pub fn domain_name_for(id: Option<&str>) -> String {
    match id {
        Some(id) if !id.is_empty() => format!("{DOMAIN_NAME}-{id}"),
        _ => DOMAIN_NAME.to_string(),
    }
}

fn data_dir() -> PathBuf {
    crate::session::session_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join(crate::DATA_DIR_NAME))
}

/// Socket for one window host. `None` is the legacy single host.
pub fn socket_for(id: Option<&str>) -> PathBuf {
    match id {
        Some(id) if !id.is_empty() => data_dir().join("hosts").join(format!("{id}.sock")),
        _ => data_dir().join("host.sock"),
    }
}

/// Socket under `%APPDATA%\bethterm` for this process.
pub fn socket_path() -> PathBuf {
    socket_for(current_id())
}

pub fn unix_domain_for(id: Option<&str>) -> UnixDomain {
    UnixDomain {
        name: domain_name_for(id),
        socket_path: Some(socket_for(id)),
        connect_automatically: true,
        no_serve_automatically: true,
        serve_command: Some(vec![host_exe().display().to_string()]),
        skip_permissions_check: true,
        ..Default::default()
    }
}

/// Unix domain the GUI uses to reach the host.
pub fn unix_domain() -> UnixDomain {
    unix_domain_for(current_id())
}

fn mutex_name_for(id: Option<&str>) -> String {
    match id {
        Some(id) if !id.is_empty() => format!("{MUTEX_NAME}-{id}"),
        _ => MUTEX_NAME.to_string(),
    }
}

fn quit_event_name_for(id: Option<&str>) -> String {
    match id {
        Some(id) if !id.is_empty() => format!("{QUIT_EVENT_NAME}-{id}"),
        _ => QUIT_EVENT_NAME.to_string(),
    }
}

/// True when this process is `bethterm-host` / `bethterm-host.exe`.
pub fn is_host_exe() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()))
        .map(|n| n == "bethterm-host.exe" || n == "bethterm-host")
        .unwrap_or(false)
}

fn host_exe() -> PathBuf {
    std::env::current_exe()
        .ok()
        .map(|p| p.with_file_name("bethterm-host.exe"))
        .unwrap_or_else(|| PathBuf::from("bethterm-host.exe"))
}

/// Path used to stage a host update while the live host still holds
/// the running `bethterm-host.exe` image.
pub fn pending_host_exe() -> PathBuf {
    host_exe().with_file_name("bethterm-host.exe.new")
}

/// Files the running host keeps locked. An installer that finds the
/// host up stages each of them as `<name>.new`; the next host start
/// applies them here (patch 0141 added the ConPTY pair to patch 0128's
/// host exe).
pub const HOST_LOCKED_FILES: [&str; 3] = ["bethterm-host.exe", "OpenConsole.exe", "conpty.dll"];

/// If the host is not running, replace every host-locked file with its
/// staged `.new` from the last GUI/setup update.
pub fn apply_pending_binary() {
    if instance_running() {
        return;
    }
    for name in HOST_LOCKED_FILES {
        let target = host_exe().with_file_name(name);
        let pending = host_exe().with_file_name(format!("{name}.new"));
        if !pending.is_file() {
            continue;
        }
        // Patch 0144: a `.new` left behind by an older install must not
        // overwrite a file the setup already replaced in place.
        let newer = match (
            std::fs::metadata(&pending).and_then(|m| m.modified()),
            std::fs::metadata(&target).and_then(|m| m.modified()),
        ) {
            (Ok(p), Ok(t)) => p > t,
            (Ok(_), Err(_)) => true,
            _ => false,
        };
        if !newer {
            log::info!(
                "bethterm-host: discarding stale staged {} (older than the installed file)",
                pending.display()
            );
            let _ = std::fs::remove_file(&pending);
            continue;
        }
        let bak = host_exe().with_file_name(format!("{name}.bak"));
        let _ = std::fs::remove_file(&bak);
        if target.is_file() {
            if std::fs::rename(&target, &bak).is_err() {
                let _ = std::fs::copy(&target, &bak);
                let _ = std::fs::remove_file(&target);
            }
        }
        if std::fs::rename(&pending, &target).is_err() {
            if let Err(err) = std::fs::copy(&pending, &target) {
                log::warn!("bethterm-host: pending swap copy of {name} failed: {err}");
                continue;
            }
            let _ = std::fs::remove_file(&pending);
        }
        log::info!("bethterm-host: applied staged {}", target.display());
    }
}

/// Start the legacy single host if that is what the caller still wants.
pub fn ensure_running() -> Result<()> {
    start_id(None)
}

/// Start the host that owns one window. `None` is the legacy host.
pub fn start_id(id: Option<&str>) -> Result<()> {
    apply_pending_binary();
    if id_running(id) {
        return wait_id(id);
    }
    if let Some(id) = id {
        if !id.is_empty() {
            std::fs::create_dir_all(data_dir().join("hosts"))?;
        }
    }
    let exe = host_exe();
    anyhow::ensure!(
        exe.is_file(),
        "bethterm-host.exe not found next to the GUI ({})",
        exe.display()
    );
    let mut cmd = std::process::Command::new(&exe);
    cmd.env("BETHTERM_ACTIVE", "1");
    cmd.env("WTINATOR_ACTIVE", "1");
    if let Some(id) = id {
        if !id.is_empty() {
            cmd.env("BETHTERM_HOST_ID", id);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
    }
    cmd.spawn()
        .with_context(|| format!("spawn {}", exe.display()))?;
    match id {
        Some(id) => note_life(&format!("spawned window host {id} (0159 layout)")),
        None => note_life("spawned the host (bethterm-host.exe)"),
    }
    wait_id(id)
}

fn wait_id(id: Option<&str>) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if id_running(id) && socket_for(id).exists() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    anyhow::bail!(
        "bethterm-host {} did not come up within 8s",
        id.unwrap_or("legacy")
    )
}

/// Hosts whose mutex is still held. `None` is the legacy single host.
pub fn running_ids() -> Vec<Option<String>> {
    let mut out = Vec::new();
    if id_running(None) {
        out.push(None);
    }
    let dir = data_dir().join("hosts");
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".sock") {
                let id = sanitize_id(id);
                if !id.is_empty() && id_running(Some(&id)) {
                    out.push(Some(id));
                }
            }
        }
    }
    out
}

/// True when the host mutex already exists (process is alive).
pub fn instance_running() -> bool {
    id_running(current_id())
}

fn id_running(id: Option<&str>) -> bool {
    #[cfg(windows)]
    {
        host_mutex_exists(id)
    }
    #[cfg(not(windows))]
    {
        socket_for(id).exists()
    }
}

/// True unless `domain_name` is a BethTerm host whose process is gone.
pub fn domain_host_running(domain_name: &str) -> bool {
    match domain_name.strip_prefix(DOMAIN_NAME) {
        Some("") => id_running(None),
        Some(rest) => match rest.strip_prefix('-') {
            Some(id) => id_running(Some(id)),
            None => true,
        },
        None => true,
    }
}

/// Patch 0165: a window host (0159) exits once its last terminal has
/// closed. Without this every closed window left an empty host behind
/// for good. The legacy single host keeps running as before.
pub fn exit_when_emptied(mux: &mux::Mux) {
    use std::sync::atomic::{AtomicBool, Ordering};
    if current_id().is_none() {
        return;
    }
    static HAD_PANES: AtomicBool = AtomicBool::new(false);
    static EXITING: AtomicBool = AtomicBool::new(false);
    mux.subscribe(|n| {
        match n {
            mux::MuxNotification::PaneAdded(_) => HAD_PANES.store(true, Ordering::SeqCst),
            mux::MuxNotification::Empty
                if HAD_PANES.load(Ordering::SeqCst) && !EXITING.swap(true, Ordering::SeqCst) =>
            {
                // Give the GUI time to drop the pane first, so the
                // socket closing is not read as "host died with panes".
                let _ = std::thread::Builder::new()
                    .name("bethterm-host-empty".into())
                    .spawn(|| {
                        std::thread::sleep(Duration::from_secs(2));
                        let empty = mux::Mux::try_get()
                            .map(|m| m.iter_panes().is_empty())
                            .unwrap_or(true);
                        if empty {
                            note_life("last terminal closed; window host exiting");
                            let _ = std::fs::remove_file(socket_path());
                            let _ = std::fs::remove_file(pid_path_for(current_id()));
                            std::process::exit(0);
                        }
                        EXITING.store(false, Ordering::SeqCst);
                    });
            }
            _ => {}
        }
        true
    });
}

/// Patch 0165: did any of these hosts die with terminals in it? A
/// window host that exits because it became empty removes its pid
/// file first; a crash, a kill, or Encerrar BethTerm leaves it.
pub fn any_died_with_panes(domain_names: &[String]) -> bool {
    domain_names.iter().any(|name| {
        let id = match name.strip_prefix(DOMAIN_NAME) {
            Some("") => None,
            Some(rest) => match rest.strip_prefix('-') {
                Some(id) => Some(id),
                None => return false,
            },
            None => return false,
        };
        pid_path_for(id).exists()
    })
}

/// Patch 0168: log every terminal the host opens or closes, with the
/// running count, so a vanished terminal can be matched to an event.
pub fn log_pane_changes(mux: &mux::Mux) {
    use std::sync::atomic::AtomicUsize;
    static PANES: AtomicUsize = AtomicUsize::new(0);
    mux.subscribe(|n| {
        match n {
            mux::MuxNotification::PaneAdded(id) => {
                let count = PANES.fetch_add(1, Ordering::SeqCst) + 1;
                note_life(&format!("pane {id} opened (panes={count})"));
            }
            mux::MuxNotification::PaneRemoved(id) => {
                let count = PANES.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
                note_life(&format!("pane {id} closed (panes={count})"));
            }
            _ => {}
        }
        true
    });
}

/// Patch 0168: from the GUI, wait on the host process and log how it
/// ended: the exit code tells a clean quit (0) from a kill or a crash.
#[cfg(windows)]
pub fn watch_host_exit() {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const SYNCHRONIZE: u32 = 0x0010_0000;
    static WATCHED: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());
    let Some(pid) = std::fs::read_to_string(pid_path_for(None))
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
    else {
        return;
    };
    {
        let mut w = WATCHED.lock().unwrap_or_else(|e| e.into_inner());
        if w.contains(&pid) {
            return;
        }
        w.push(pid);
    }
    let handle = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        note_life(&format!("GUI could not open host pid {pid} to watch it"));
        return;
    }
    note_life(&format!("GUI attached to host pid {pid}; watching it"));
    let bits = handle as isize;
    let _ = std::thread::Builder::new()
        .name("bethterm-host-watch".into())
        .spawn(move || {
            let handle = bits as windows_sys::Win32::Foundation::HANDLE;
            if unsafe { WaitForSingleObject(handle, u32::MAX) } == WAIT_OBJECT_0 {
                let mut code = 0u32;
                unsafe { GetExitCodeProcess(handle, &mut code) };
                note_life(&format!(
                    "GUI saw host pid {pid} end with exit code {code:#x} ({})",
                    exit_code_meaning(code)
                ));
            }
            unsafe { CloseHandle(handle) };
        });
}

/// Patch 0168: plain meaning of common Windows exit codes.
pub fn exit_code_meaning(code: u32) -> &'static str {
    match code {
        0 => "clean exit",
        1 => "error exit, or killed by taskkill /F / Task Manager / TerminateProcess(1)",
        0xC000_0005 => "CRASH: access violation",
        0xC000_0409 => "CRASH: Rust panic abort or stack buffer overrun",
        0xC000_00FD => "CRASH: stack overflow",
        0xC000_0017 => "CRASH: out of memory",
        0xC000_013A => "Ctrl+C / console closed",
        0x4001_0004 => "killed when the session ended or by a debugger",
        _ => "unexpected code: a crash or an external kill",
    }
}

/// Remove `.sock` / `.pid` files of window hosts that are gone.
pub fn prune_stale_host_files() {
    let dir = data_dir().join("hosts");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(sanitize_id) else {
            continue;
        };
        if !id.is_empty() && !id_running(Some(&id)) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Patch 0162: `<socket>.pid`, so a stuck host can be killed alone.
fn pid_path_for(id: Option<&str>) -> PathBuf {
    socket_for(id).with_extension("pid")
}

/// After taking the mutex, watch for Encerrar host.
pub fn start_quit_watcher() {
    #[cfg(windows)]
    {
        note_life(&format!(
            "host process became the PTY owner; {}; started by {}",
            describe_exe(),
            describe_parent()
        ));
        let _ = std::fs::write(pid_path_for(current_id()), std::process::id().to_string());
        // Patch 0168: a request left by an earlier stop is not ours.
        let _ = std::fs::remove_file(quit_request_path(current_id()));
        if let Err(err) = spawn_quit_watcher() {
            note_life(&format!("quit watcher failed: {err:#}"));
            log::warn!("bethterm-host: quit watcher: {err:#}");
        }
        spawn_alive_heartbeat();
    }
}

/// Append one line to `%APPDATA%\bethterm\host-life.log` and flush it
/// to disk. `process::exit` and `TerminateProcess` skip the normal
/// logger, so this file is the record of why the host ended.
pub fn note_life(message: &str) {
    let pid = std::process::id();
    let line = format!("{} pid={pid} {} {message}\n", life_stamp(), life_role());
    let Ok(dir) = crate::session::session_dir() else {
        return;
    };
    let path = dir.join("host-life.log");
    // Patch 0168: keep the log bounded; one previous file is kept.
    if std::fs::metadata(&path).map(|m| m.len() > LIFE_LOG_MAX).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("host-life.1.log"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
        let _ = file.sync_all();
    }
    log::info!("bethterm life: {message}");
}

const LIFE_LOG_MAX: u64 = 4 * 1024 * 1024;

/// Patch 0168: who writes a `host-life.log` line: `host`,
/// `host[<id>]` (a 0159 window host), `gui`, `cli`, or the exe name.
fn life_role() -> String {
    if is_host_exe() {
        return match current_id() {
            Some(id) => format!("host[{id}]"),
            None => "host".to_string(),
        };
    }
    let stem = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();
    match stem.as_str() {
        "bethterm-gui" | "wezterm-gui" => "gui".to_string(),
        "bethterm" | "wezterm" => "cli".to_string(),
        "" => "?".to_string(),
        other => other.to_string(),
    }
}

/// Patch 0168: `name (pid N)` for a running process, via ToolHelp.
#[cfg(windows)]
pub fn describe_process(pid: u32) -> String {
    match process_entry(pid) {
        Some((name, _)) => format!("{name} (pid {pid})"),
        None => format!("pid {pid} (gone)"),
    }
}

/// Patch 0168: this process's parent, e.g. `explorer.exe (pid 812)`.
#[cfg(windows)]
pub fn describe_parent() -> String {
    match process_entry(std::process::id()) {
        Some((_, ppid)) => describe_process(ppid),
        None => "unknown".to_string(),
    }
}

#[cfg(windows)]
fn process_entry(pid: u32) -> Option<(String, u32)> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap.is_null() || snap == (-1isize as HANDLE) {
        return None;
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut found = None;
    let mut ok = unsafe { Process32FirstW(snap, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID == pid {
            let end = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            found = Some((
                String::from_utf16_lossy(&entry.szExeFile[..end]),
                entry.th32ParentProcessID,
            ));
            break;
        }
        ok = unsafe { Process32NextW(snap, &mut entry) };
    }
    unsafe { CloseHandle(snap) };
    found
}

/// Patch 0168: `exe path, built <mtime>` for the life log.
pub fn describe_exe() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return "exe unknown".to_string();
    };
    let built = std::fs::metadata(&exe)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    format!("{} (built {built})", exe.display())
}

/// Patch 0168: `<socket>.quit-request`. Whoever signals the quit event
/// first writes who it is and why; the host logs it when it exits, so
/// a stop is never anonymous again.
fn quit_request_path(id: Option<&str>) -> PathBuf {
    socket_for(id).with_extension("quit-request")
}

/// Patch 0168: record who is about to stop host `id`.
pub fn write_quit_request(id: Option<&str>, reason: &str) {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let text = format!(
        "{} pid={} exe={exe} reason={reason}",
        life_stamp(),
        std::process::id()
    );
    let _ = std::fs::write(quit_request_path(id), text);
}

/// Signal the host to exit (kills every PTY it owns).
pub fn request_stop() -> Result<()> {
    request_stop_all()
}

/// Stop every window host. The tray "Encerrar BethTerm" uses this.
pub fn request_stop_all() -> Result<()> {
    let ids = running_ids();
    if ids.is_empty() {
        note_life("Encerrar host: no window host was running");
        return Ok(());
    }
    for id in &ids {
        let _ = request_stop_id(id.as_deref());
    }
    Ok(())
}

fn request_stop_id(id: Option<&str>) -> Result<()> {
    #[cfg(windows)]
    {
        let label = id.unwrap_or("legacy");
        note_life(&format!(
            "Encerrar host confirmed by pid {}; signaling quit for {label}",
            std::process::id()
        ));
        write_quit_request(id, "tray Encerrar BethTerm (user confirmed)");
        signal_quit_event_for(id);
        let deadline = Instant::now() + Duration::from_secs(5);
        while id_running(id) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if id_running(id) {
            note_life(&format!(
                "quit event did not stop host {label} within 5s; TerminateProcess"
            ));
            terminate_host_process(id);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while id_running(id) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = std::fs::remove_file(socket_for(id));
        // Keep the pid file: it tells the GUI this host was stopped
        // with terminals in it (patch 0165). `prune_stale_host_files`
        // removes it on the next start.
        if id_running(id) {
            anyhow::bail!("bethterm-host {label} did not exit");
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = std::fs::remove_file(socket_path());
        Ok(())
    }
}

/// Create the single-instance mutex. `Ok(false)` means another host lives.
pub fn try_become_owner() -> Result<bool> {
    #[cfg(windows)]
    {
        take_host_mutex()
    }
    #[cfg(not(windows))]
    {
        Ok(true)
    }
}

/// Record whether attach imported panes that already lived on the host.
pub fn note_host_had_existing_panes(had: bool) {
    HOST_HAD_EXISTING_PANES.store(had, Ordering::SeqCst);
}

/// True when the last attach found host panes (do not respawn session.json).
pub fn host_had_existing_panes() -> bool {
    HOST_HAD_EXISTING_PANES.load(Ordering::SeqCst)
}

/// Domain name of the host that already owns panes in this mux window.
pub fn domain_name_of_window(mux: &mux::Mux, window_id: mux::window::WindowId) -> Option<String> {
    let window = mux.get_window(window_id)?;
    for tab in window.iter() {
        for pos in tab.iter_panes_ignoring_zoom() {
            let domain = mux.get_domain(pos.pane.domain_id())?;
            let name = domain.domain_name().to_string();
            if name.starts_with(DOMAIN_NAME) {
                return Some(name);
            }
        }
    }
    None
}

/// True when the GUI mux already has panes from the host domain.
pub fn mux_already_has_host_panes() -> bool {
    let Some(mux) = mux::Mux::try_get() else {
        return false;
    };
    mux.iter_panes().iter().any(|pane| {
        mux.get_domain(pane.domain_id())
            .map(|d| d.domain_name().starts_with(DOMAIN_NAME))
            .unwrap_or(false)
    })
}

#[cfg(windows)]
fn wide(name: &str) -> Vec<u16> {
    name.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn host_mutex_exists(id: Option<&str>) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenMutexW;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let name = wide(&mutex_name_for(id));
    let handle = unsafe { OpenMutexW(SYNCHRONIZE, 0, name.as_ptr()) };
    if handle.is_null() {
        return false;
    }
    unsafe {
        CloseHandle(handle);
    }
    true
}

#[cfg(windows)]
fn take_host_mutex() -> Result<bool> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name = wide(&mutex_name_for(current_id()));
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() {
        anyhow::bail!("CreateMutexW BethTermHost failed ({})", unsafe {
            GetLastError()
        });
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Ok(false);
    }
    let _ = handle;
    Ok(true)
}

#[cfg(windows)]
fn quit_event_wide() -> Vec<u16> {
    wide(&quit_event_name_for(current_id()))
}

#[cfg(windows)]
fn spawn_quit_watcher() -> Result<()> {
    use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    let name = quit_event_wide();
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
    if handle.is_null() {
        anyhow::bail!("CreateEventW BethTermHostQuit failed");
    }
    let handle_bits = handle as isize;
    let _ = std::thread::Builder::new()
        .name("bethterm-host-quit".into())
        .spawn(move || {
            let handle = handle_bits as HANDLE;
            let started = Instant::now();
            let rc = unsafe { WaitForSingleObject(handle, u32::MAX) };
            if rc == WAIT_OBJECT_0 {
                let when = if started.elapsed() < Duration::from_secs(2) {
                    "quit event was already signaled when this host started"
                } else {
                    "quit event signaled"
                };
                // Patch 0168: name whoever asked. BethTerm (tray, setup)
                // always writes the request before signaling.
                let path = quit_request_path(current_id());
                let who = match std::fs::read_to_string(&path) {
                    Ok(text) => format!("requested by: {}", text.trim()),
                    Err(_) => "requester UNKNOWN: no quit-request file, so it was not \
                               the BethTerm tray or setup (another program or an agent \
                               script set the event)"
                        .to_string(),
                };
                let _ = std::fs::remove_file(&path);
                let panes = mux::Mux::try_get().map(|m| m.iter_panes().len()).unwrap_or(0);
                note_life(&format!(
                    "{when}; host exiting on purpose (no crash), closing {panes} pane(s); {who}"
                ));
                std::process::exit(0);
            }
            note_life(&format!("quit watcher wait ended rc={rc}; host not exiting"));
        });
    Ok(())
}

#[cfg(windows)]
fn spawn_alive_heartbeat() {
    let _ = std::thread::Builder::new()
        .name("bethterm-host-alive".into())
        .spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(60));
                let panes = mux::Mux::try_get().map(|m| m.iter_panes().len()).unwrap_or(0);
                note_life(&format!("alive panes={panes}"));
            }
        });
}

pub(crate) fn life_stamp() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::SYSTEMTIME;
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        unsafe {
            let mut st: SYSTEMTIME = std::mem::zeroed();
            GetLocalTime(&mut st);
            return format!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
                st.wYear,
                st.wMonth,
                st.wDay,
                st.wHour,
                st.wMinute,
                st.wSecond,
                st.wMilliseconds
            );
        }
    }
    #[cfg(not(windows))]
    {
        "now".to_string()
    }
}

#[cfg(windows)]
fn signal_quit_event_for(id: Option<&str>) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenEventW, SetEvent};
    const EVENT_MODIFY_STATE: u32 = 0x0002;
    let name = wide(&quit_event_name_for(id));
    let handle = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
    if handle.is_null() {
        note_life("Encerrar host could not open the quit event; host was not signaled");
        return;
    }
    unsafe {
        SetEvent(handle);
        CloseHandle(handle);
    }
}

/// Patch 0162: kill only the host `id`, found by its pid file. The old
/// version killed every `bethterm-host.exe`, so one stuck window host
/// took every other window's terminals with it.
#[cfg(windows)]
fn terminate_host_process(id: Option<&str>) {
    let label = id.unwrap_or("legacy");
    let pid = std::fs::read_to_string(pid_path_for(id))
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    match pid {
        Some(pid) => terminate_host_pid(pid),
        None => note_life(&format!(
            "host {label} has no pid file; not killing it (other hosts stay up)"
        )),
    }
}

#[cfg(windows)]
fn terminate_host_pid(pid: u32) {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess};
    const PROCESS_TERMINATE: u32 = 0x0001;
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap.is_null() || snap == (-1isize as HANDLE) {
        return;
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut ok = unsafe { Process32FirstW(snap, &mut entry) };
    while ok != 0 {
        let name = String::from_utf16_lossy(
            &entry.szExeFile[..entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len())],
        )
        .to_ascii_lowercase();
        // Match the name too: a stale pid file may name a reused pid.
        if entry.th32ProcessID == pid && name == "bethterm-host.exe" {
            note_life(&format!("TerminateProcess host pid {pid}"));
            let proc = unsafe { OpenProcess(PROCESS_TERMINATE, 0, entry.th32ProcessID) };
            if !proc.is_null() {
                unsafe {
                    TerminateProcess(proc, 0);
                    CloseHandle(proc);
                }
            }
        }
        ok = unsafe { Process32NextW(snap, &mut entry) };
    }
    unsafe {
        CloseHandle(snap);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_name_is_stable() {
        assert_eq!(DOMAIN_NAME, "bethterm-host");
        assert_eq!(unix_domain().name, DOMAIN_NAME);
        assert!(unix_domain().connect_automatically);
        assert_eq!(domain_name_for(Some("w1")), "bethterm-host-w1");
        assert_eq!(sanitize_id("a/b c"), "abc");
    }
}
