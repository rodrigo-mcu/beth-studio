//! BethTerm native Win32 installer / updater.
//!
//! Native Win32 window (no WebView). The zstd tar is **embedded in this
//! executable**: `pack-bethterm-setup` appends `BethTerm.pkg.zst` plus a
//! trailer (`u64` size + `BTZSTPKG`) onto the GUI stub.

#![cfg_attr(windows, windows_subsystem = "windows")]

use anyhow::{bail, Context, Result};
use std::fs;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Trailer magic written by `pack-bethterm-setup.ps1` after the zstd blob.
const PKG_MAGIC: &[u8; 8] = b"BTZSTPKG";
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

fn main() {
    if let Err(e) = ui::run_window() {
        ui::error(&format!("{e:#}"));
        std::process::exit(1);
    }
}

fn build_stamp() -> String {
    let secs: u64 = include_str!(concat!(env!("OUT_DIR"), "/build_stamp.txt"))
        .trim()
        .parse()
        .unwrap_or(0);
    if secs == 0 {
        return "sem data".to_string();
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
        use windows_sys::Win32::System::Time::{
            FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime,
        };
        let ticks = (secs + 11_644_473_600) * 10_000_000;
        let ft = FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        };
        unsafe {
            let mut utc = std::mem::zeroed::<SYSTEMTIME>();
            let mut local = std::mem::zeroed::<SYSTEMTIME>();
            if FileTimeToSystemTime(&ft, &mut utc) != 0
                && SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) != 0
            {
                return format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}",
                    local.wYear, local.wMonth, local.wDay, local.wHour, local.wMinute
                );
            }
        }
    }
    format!("unix {secs}")
}

fn suggested_install_dir() -> PathBuf {
    public_folder().join("BethTerm")
}

/// Windows Public folder for this machine / version — not a hardcoded
/// `C:\Users\Public`. Vista+ uses `SHGetKnownFolderPath(FOLDERID_Public)`;
/// older Windows falls back to the parent of Common Documents (All Users).
fn public_folder() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(p) = win_public::known_folder_public() {
            return p;
        }
        if let Some(p) = std::env::var_os("PUBLIC").map(PathBuf::from) {
            if p.is_dir() {
                return p;
            }
        }
        if let Some(p) = win_public::common_documents_parent() {
            return p;
        }
        if let Some(root) = std::env::var_os("SystemDrive") {
            let vista = PathBuf::from(&root).join(r"Users\Public");
            if vista.is_dir() {
                return vista;
            }
            let xp = PathBuf::from(&root).join(r"Documents and Settings\All Users");
            if xp.is_dir() {
                return xp;
            }
        }
    }
    PathBuf::from(r"C:\Users\Public")
}

#[cfg(windows)]
mod win_public {
    use super::*;
    use std::os::windows::ffi::OsStringExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::MAX_PATH;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        SHGetFolderPathW, SHGetKnownFolderPath, CSIDL_COMMON_DOCUMENTS, FOLDERID_Public,
    };

    pub fn known_folder_public() -> Option<PathBuf> {
        unsafe {
            let mut psz = null_mut();
            let hr = SHGetKnownFolderPath(&FOLDERID_Public, 0, null_mut(), &mut psz);
            if hr < 0 || psz.is_null() {
                return None;
            }
            let path = pwstr_to_path(psz);
            CoTaskMemFree(psz.cast());
            path.filter(|p| !p.as_os_str().is_empty())
        }
    }

    pub fn common_documents_parent() -> Option<PathBuf> {
        let mut buf = [0u16; MAX_PATH as usize];
        let hr = unsafe {
            SHGetFolderPathW(
                null_mut(),
                CSIDL_COMMON_DOCUMENTS as i32,
                null_mut(),
                0,
                buf.as_mut_ptr(),
            )
        };
        if hr < 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        if len == 0 {
            return None;
        }
        let docs = PathBuf::from(std::ffi::OsString::from_wide(&buf[..len]));
        docs.parent().map(Path::to_path_buf)
    }

    unsafe fn pwstr_to_path(psz: *const u16) -> Option<PathBuf> {
        if psz.is_null() {
            return None;
        }
        let mut len = 0usize;
        while *psz.add(len) != 0 {
            len += 1;
            if len > 32_768 {
                return None;
            }
        }
        let slice = std::slice::from_raw_parts(psz, len);
        Some(PathBuf::from(std::ffi::OsString::from_wide(slice)))
    }
}

fn is_forbidden_dest(dest: &Path) -> bool {
    dest.to_string_lossy()
        .to_ascii_lowercase()
        .contains(r"\app\tools\wezterminator")
}

fn is_existing_install(dest: &Path) -> bool {
    dest.join("bethterm-web.exe").is_file() || dest.join("bethterm.exe").is_file()
}

fn load_payload() -> Result<Vec<u8>> {
    let exe = std::env::current_exe().context("current_exe")?;
    load_embedded_zst(&exe).with_context(|| {
        format!(
            "este setup não contém o pacote zstd embutido em {}\n\
             Gere o instalador com pack-bethterm-setup.cmd",
            exe.display()
        )
    })
}

fn load_embedded_zst(exe: &Path) -> Result<Vec<u8>> {
    let mut f = fs::File::open(exe).with_context(|| format!("abrir {}", exe.display()))?;
    let len = f.metadata()?.len();
    anyhow::ensure!(len > 16, "executável demasiado pequeno");
    f.seek(SeekFrom::End(-16))?;
    let mut tail = [0u8; 16];
    f.read_exact(&mut tail)?;
    anyhow::ensure!(&tail[8..] == PKG_MAGIC, "trailer BTZSTPKG em falta");
    let size = u64::from_le_bytes(tail[..8].try_into().unwrap());
    let start = len
        .checked_sub(16)
        .and_then(|end| end.checked_sub(size))
        .context("tamanho do pacote inválido")?;
    anyhow::ensure!(start >= 64, "pacote sobrepõe o cabeçalho PE");
    f.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; size as usize];
    f.read_exact(&mut buf)
        .context("ler pacote zstd embutido")?;
    anyhow::ensure!(
        buf.len() >= 4 && buf[..4] == ZSTD_MAGIC,
        "pacote zstd corrompido"
    );
    Ok(buf)
}

struct ExtractOutcome {
    count: usize,
    /// `bethterm-host.exe` was running, so the new image is
    /// `bethterm-host.exe.new` and is applied the next time the host starts.
    staged_host: bool,
}

fn file_in_use(err: &std::io::Error) -> bool {
    // ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION.
    matches!(err.raw_os_error(), Some(5 | 32 | 33))
}

/// Patch 0168: `%APPDATA%\bethterm`, shared with the GUI and host.
fn data_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("bethterm"))
}

fn local_stamp() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        let st = unsafe {
            let mut st = std::mem::zeroed();
            GetLocalTime(&mut st);
            st
        };
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
        )
    }
    #[cfg(not(windows))]
    {
        "now".to_string()
    }
}

/// Patch 0168: the setup writes to the same `host-life.log` as the GUI
/// and host, so a host it stops is never a mystery.
fn life(message: &str) {
    use std::io::Write;
    let Some(dir) = data_dir() else {
        return;
    };
    let _ = fs::create_dir_all(&dir);
    let line = format!(
        "{} pid={} setup {message}\n",
        local_stamp(),
        std::process::id()
    );
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("host-life.log"))
    {
        let _ = f.write_all(line.as_bytes());
        let _ = f.sync_all();
    }
}

/// Hosts have no window. One process per window uses
/// `Local\BethTermHost-<id>`; the old single host uses
/// `Local\BethTermHost`. This crate does not depend on wtinator.
mod host {
    const MUTEX_NAME: &str = "Local\\BethTermHost";
    const QUIT_EVENT_NAME: &str = "Local\\BethTermHostQuit";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn mutex_held(name: &str) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::OpenMutexW;
        const SYNCHRONIZE: u32 = 0x0010_0000;
        let name = wide(name);
        let handle = unsafe { OpenMutexW(SYNCHRONIZE, 0, name.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        unsafe {
            CloseHandle(handle);
        }
        true
    }

    /// `None` is the legacy single host. `Some` is one window host.
    fn running() -> Vec<Option<String>> {
        let mut out = Vec::new();
        if mutex_held(MUTEX_NAME) {
            out.push(None);
        }
        let Some(base) = std::env::var_os("APPDATA").map(std::path::PathBuf::from) else {
            return out;
        };
        let dir = base.join("bethterm").join("hosts");
        let Ok(rd) = std::fs::read_dir(dir) else {
            return out;
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".sock") else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            if mutex_held(&format!("{MUTEX_NAME}-{id}")) {
                out.push(Some(id.to_string()));
            }
        }
        out
    }

    pub fn any_running() -> bool {
        !running().is_empty()
    }

    /// Patch 0168: same file the host reads when it exits
    /// (`wtinator::host::write_quit_request`).
    fn write_quit_request(id: Option<&str>, reason: &str) {
        let Some(dir) = crate::data_dir() else {
            return;
        };
        let path = match id {
            Some(id) if !id.is_empty() => dir.join("hosts").join(format!("{id}.quit-request")),
            _ => dir.join("host.quit-request"),
        };
        let exe = std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let _ = std::fs::write(
            path,
            format!(
                "{} pid={} exe={exe} reason={reason}",
                crate::local_stamp(),
                std::process::id()
            ),
        );
    }

    fn signal(id: Option<&str>, reason: &str) {
        write_quit_request(id, reason);
        crate::life(&format!(
            "signaling quit for host {} ({reason})",
            id.unwrap_or("bethterm-host")
        ));
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenEventW, SetEvent};
        const EVENT_MODIFY_STATE: u32 = 0x0002;
        let name = match id {
            Some(id) if !id.is_empty() => format!("{QUIT_EVENT_NAME}-{id}"),
            _ => QUIT_EVENT_NAME.to_string(),
        };
        let name = wide(&name);
        let handle = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
        if handle.is_null() {
            return;
        }
        unsafe {
            SetEvent(handle);
            CloseHandle(handle);
        }
    }

    /// Ask every running window host to exit. Returns false on timeout.
    pub fn request_quit_and_wait(timeout: std::time::Duration, reason: &str) -> bool {
        for id in running() {
            signal(id.as_deref(), reason);
        }
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if !any_running() {
                std::thread::sleep(std::time::Duration::from_millis(400));
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        false
    }
}

/// Patch 0164: "Encerrar tudo antes de instalar". Stops every BethTerm
/// process that runs from the install folder: first the interface, so
/// it cannot start a host again, then every window host (quit event
/// first, `TerminateProcess` after 10 s).
#[cfg(windows)]
mod stop_all {
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    const SYNCHRONIZE: u32 = 0x0010_0000;
    // inclui os nomes da janela nativa antiga: uma atualização por cima precisa fechá-los
    const INTERFACE: &[&str] = &[
        "bethterm-web.exe",
        "bethterm-gui.exe",
        "bethterm.exe",
        "wtinator-config.exe",
        "wezterm-gui.exe",
    ];
    const HOSTS: &[&str] = &["bethterm-host.exe", "wezterm-mux-server.exe"];

    fn exe_name(entry: &PROCESSENTRY32W) -> String {
        let end = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase()
    }

    fn image_path(proc: HANDLE) -> Option<PathBuf> {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }

    fn same_dir(a: &Path, b: &Path) -> bool {
        let norm = |p: &Path| {
            p.to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .replace('/', "\\")
                .to_ascii_lowercase()
        };
        norm(a) == norm(b)
    }

    /// Kill processes named in `names` whose image lives in `dir`.
    /// Returns how many were stopped.
    fn kill_in(dir: &Path, names: &[&str]) -> usize {
        let me = std::process::id();
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return 0;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..unsafe { std::mem::zeroed() }
        };
        let mut handles = Vec::new();
        let mut ok = unsafe { Process32FirstW(snap, &mut entry) };
        while ok != 0 {
            let pid = entry.th32ProcessID;
            if pid != me && names.contains(&exe_name(&entry).as_str()) {
                let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE;
                let proc = unsafe { OpenProcess(access, 0, pid) };
                if !proc.is_null() {
                    let in_dir = image_path(proc)
                        .and_then(|p| p.parent().map(|d| same_dir(d, dir)))
                        .unwrap_or(false);
                    if in_dir && unsafe { TerminateProcess(proc, 0) } != 0 {
                        crate::life(&format!(
                            "Encerrar tudo: terminated {} (pid {pid})",
                            exe_name(&entry)
                        ));
                        handles.push(proc);
                    } else {
                        unsafe { CloseHandle(proc) };
                    }
                }
            }
            ok = unsafe { Process32NextW(snap, &mut entry) };
        }
        unsafe { CloseHandle(snap) };
        let n = handles.len();
        for h in handles {
            unsafe {
                WaitForSingleObject(h, 5_000);
                CloseHandle(h);
            }
        }
        n
    }

    /// Stop the interface, then every host. Returns a line for the
    /// status text.
    pub fn run(dir: &Path) -> String {
        let gui = kill_in(dir, INTERFACE);
        let quit = crate::host::request_quit_and_wait(
            std::time::Duration::from_secs(10),
            "setup: Encerrar tudo antes de instalar (user confirmed)",
        );
        let forced = if quit { 0 } else { kill_in(dir, HOSTS) };
        // Let Windows drop the image locks before extraction.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let mut out = format!("Interface: {gui} processo(s) encerrado(s). ");
        if quit {
            out.push_str("Hosts encerrados pelo pedido normal.");
        } else {
            out.push_str(&format!(
                "Hosts não saíram em 10 s; {forced} encerrado(s) à força."
            ));
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::same_dir;
        use std::path::Path;

        #[test]
        fn dir_match_ignores_case_and_trailing_slash() {
            assert!(same_dir(
                Path::new(r"C:\Users\Public\BethTerm"),
                Path::new(r"c:\users\public\bethterm\")
            ));
            assert!(!same_dir(
                Path::new(r"C:\Users\Public\BethTerm"),
                Path::new(r"C:\Users\Public\BethTerm2")
            ));
        }
    }
}

/// Put `tmp` at `out`. A running image cannot be truncated; rename it
/// aside and drop the new file in its place. The live host is the
/// exception: renaming it would not load the new code, so stage
/// `bethterm-host.exe.new` for `apply_pending_binary`.
fn place_extracted(tmp: &Path, out: &Path) -> Result<bool> {
    // Patch 0144: a direct replace makes any earlier staged `.new`
    // obsolete; without this the next start "applied" the old file on
    // top of the new one.
    let drop_stale_staged = |out: &Path| {
        if let Some(name) = out.file_name().and_then(|n| n.to_str()) {
            let _ = fs::remove_file(out.with_file_name(format!("{name}.new")));
        }
    };
    if !out.exists() {
        fs::rename(tmp, out).with_context(|| format!("mover {}", out.display()))?;
        drop_stale_staged(out);
        return Ok(false);
    }
    match fs::remove_file(out) {
        Ok(()) => {
            fs::rename(tmp, out).with_context(|| format!("mover {}", out.display()))?;
            drop_stale_staged(out);
            return Ok(false);
        }
        Err(err) if file_in_use(&err) => {}
        Err(err) => {
            let _ = fs::remove_file(tmp);
            return Err(err).with_context(|| format!("substituir {}", out.display()));
        }
    }

    let name = out
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name == "bethterm-host.exe" {
        let staged = out.with_file_name("bethterm-host.exe.new");
        let _ = fs::remove_file(&staged);
        fs::rename(tmp, &staged).with_context(|| {
            format!(
                "o host está em execução e não deu para gravar {}",
                staged.display()
            )
        })?;
        return Ok(true);
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let aside = out.with_file_name(format!("{name}.{stamp}.running"));
    if let Err(err) = fs::rename(out, &aside) {
        let _ = fs::remove_file(tmp);
        return Err(err).with_context(|| {
            format!(
                "{} está em uso. Feche essa janela (ou Encerre o host na bandeja) e atualize de novo.",
                out.display()
            )
        });
    }
    if let Err(err) = fs::rename(tmp, out) {
        let _ = fs::rename(&aside, out);
        return Err(err).with_context(|| format!("mover {}", out.display()));
    }
    Ok(false)
}

const HOST_TIED: &[&str] = &["bethterm-host.exe", "OpenConsole.exe", "conpty.dll"];

fn payload_entry(bytes: &[u8], name: &str) -> Result<Option<Vec<u8>>> {
    let decoder = zstd::Decoder::new(Cursor::new(bytes)).context("abrir zstd")?;
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().context("ler tar")? {
        let mut entry = entry.context("entrada tar")?;
        let path = entry.path().context("path tar")?.into_owned();
        if path == std::path::Path::new(name) {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).context("ler host do pacote")?;
            return Ok(Some(buf));
        }
    }
    Ok(None)
}

/// True when the packaged host executable is not the one already installed.
fn host_payload_differs(payload: &[u8], installed: &Path) -> Result<bool> {
    let Some(packed) = payload_entry(payload, "bethterm-host.exe")? else {
        return Ok(false);
    };
    if !installed.is_file() {
        return Ok(true);
    }
    let on_disk = fs::read(installed).unwrap_or_default();
    Ok(packed != on_disk)
}

fn extract_zstd_tar(
    bytes: &[u8],
    dest: &Path,
    cancel: &AtomicBool,
    skip_host_files: bool,
) -> Result<ExtractOutcome> {
    let decoder = zstd::Decoder::new(Cursor::new(bytes)).context("abrir zstd")?;
    let mut archive = tar::Archive::new(decoder);
    let mut count = 0usize;
    let mut staged_host = false;
    for entry in archive.entries().context("ler tar")? {
        if cancel.load(Ordering::Relaxed) {
            bail!("cancelado");
        }
        let mut entry = entry.context("entrada tar")?;
        let path = entry.path().context("path tar")?.into_owned();
        if path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
            || path.is_absolute()
        {
            bail!("entrada tar recusada: {}", path.display());
        }
        let out = dest.join(&path);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        if entry.header().entry_type().is_dir() {
            entry
                .unpack(&out)
                .with_context(|| format!("extrair {}", path.display()))?;
            count += 1;
            continue;
        }
        let tmp_name = format!(
            ".{}.installing",
            out.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("ficheiro")
        );
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if skip_host_files && HOST_TIED.iter().any(|n| *n == file_name) {
            let mut sink = std::io::sink();
            std::io::copy(&mut entry, &mut sink)
                .with_context(|| format!("ignorar {}", path.display()))?;
            continue;
        }
        let tmp = out.with_file_name(tmp_name);
        let _ = fs::remove_file(&tmp);
        entry
            .unpack(&tmp)
            .with_context(|| format!("extrair {}", path.display()))?;
        match place_extracted(&tmp, &out) {
            Ok(staged) => staged_host |= staged,
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return Err(err);
            }
        }
        count += 1;
    }
    anyhow::ensure!(count > 0, "arquivo zstd vazio");
    Ok(ExtractOutcome {
        count,
        staged_host,
    })
}

mod shortcut {
    use super::*;

    pub fn create_desktop(exe: &Path, workdir: &Path) -> Result<()> {
        #[cfg(windows)]
        {
            let desktop = std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Desktop")
                .join("BethTerm.lnk");
            native_lnk::write(&desktop, exe, workdir)
        }
        #[cfg(not(windows))]
        {
            let _ = (exe, workdir);
            Ok(())
        }
    }

    pub fn create_start_menu(exe: &Path, workdir: &Path) -> Result<()> {
        #[cfg(windows)]
        {
            let dir = PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default())
                .join(r"Microsoft\Windows\Start Menu\Programs");
            fs::create_dir_all(&dir)?;
            native_lnk::write(&dir.join("BethTerm.lnk"), exe, workdir)
        }
        #[cfg(not(windows))]
        {
            let _ = (exe, workdir);
            Ok(())
        }
    }

    /// On update, rewrite existing shortcuts so they drop `--always-new-process`
    /// even if the user left the shortcut checkbox off.
    pub fn refresh_or_create(exe: &Path, workdir: &Path, create_if_missing: bool) -> Result<()> {
        #[cfg(windows)]
        {
            let desktop = std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Desktop")
                .join("BethTerm.lnk");
            let start = PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default())
                .join(r"Microsoft\Windows\Start Menu\Programs\BethTerm.lnk");
            if create_if_missing || desktop.is_file() {
                create_desktop(exe, workdir)?;
            }
            if create_if_missing || start.is_file() {
                create_start_menu(exe, workdir)?;
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (exe, workdir, create_if_missing);
            Ok(())
        }
    }
}

#[cfg(windows)]
mod native_lnk {
    use super::*;

    fn ps_literal(path: &Path) -> String {
        path.to_string_lossy().replace('\'', "''")
    }

    pub fn write(lnk: &Path, exe: &Path, workdir: &Path) -> Result<()> {
        // Always shortcut the Studio binary. `bethterm.exe` is a console CLI
        // (like wezterm.exe); launching it from a .lnk opens a console and
        // dumps logs into it.
        let gui = workdir.join("bethterm-web.exe");
        let target = if gui.is_file() { &gui } else { exe };
        let script = format!(
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{}'); \
             $s.TargetPath = '{}'; \
             $s.WorkingDirectory = '{}'; \
             $s.Arguments = ''; \
             $s.WindowStyle = 1; \
             $s.IconLocation = '{},0'; \
             $s.Description = 'BethTerm'; \
             $s.Save()",
            ps_literal(lnk),
            ps_literal(target),
            ps_literal(workdir),
            ps_literal(target),
        );
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .context("atalho")?;
        anyhow::ensure!(status.success(), "falhou a criar atalho {}", lnk.display());
        Ok(())
    }
}

#[cfg(windows)]
mod ui {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, MAX_PATH, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
        GetStockObject, GetSysColorBrush, SelectObject, SetBkColor, SetBkMode, SetTextColor,
        UpdateWindow, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, COLOR_WINDOW, DEFAULT_CHARSET,
        DEFAULT_GUI_FONT, DEFAULT_PITCH, DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER,
        FF_DONTCARE, FW_BOLD, OUT_TT_PRECIS, PAINTSTRUCT, TRANSPARENT,
    };
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Controls::{
        InitCommonControlsEx, IsDlgButtonChecked, SetWindowTheme, BST_CHECKED, ICC_PROGRESS_CLASS,
        ICC_STANDARD_CLASSES, INITCOMMONCONTROLSEX, PBM_SETPOS, PBM_SETRANGE32, PBS_SMOOTH,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
    use windows_sys::Win32::UI::Shell::{
        ILFree, SHBrowseForFolderW, SHGetPathFromIDListW, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS,
        BROWSEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AdjustWindowRectEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, DrawIconEx,
        GetClientRect, GetMessageW, GetWindowTextLengthW, GetWindowTextW, IsDialogMessageW,
        LoadCursorW, LoadImageW, MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassW,
        SendMessageW, SetWindowTextW, ShowWindow, SystemParametersInfoW, TranslateMessage,
        BM_SETCHECK, BS_AUTOCHECKBOX, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CS_HREDRAW, CS_VREDRAW,
        DI_NORMAL, ES_AUTOHSCROLL, IDC_ARROW, IDCANCEL, IDOK, IMAGE_ICON, LR_DEFAULTCOLOR,
        MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MSG, SPI_GETWORKAREA, SW_SHOW, WM_CLOSE,
        WM_COMMAND, WM_CREATE, WM_CTLCOLORSTATIC, WM_DESTROY, WM_PAINT, WM_SETFONT, WNDCLASSW,
        WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_EX_CLIENTEDGE, WS_OVERLAPPED, WS_SYSMENU,
        WS_TABSTOP, WS_VISIBLE,
    };

    const IDC_PATH: i32 = 101;
    const IDC_BROWSE: i32 = 102;
    const IDC_SHORTCUT: i32 = 103;
    const IDC_PROGRESS: i32 = 104;
    const IDC_STATUS: i32 = 105;
    const IDC_INSTALL: i32 = 106;
    const IDC_CANCEL: i32 = 107;
    const IDC_OPEN: i32 = 108;
    const IDC_STOP_ALL: i32 = 109;
    const WM_DONE: u32 = 0x0400 + 1;
    const IDI_APP: u16 = 0x101;
    const HEADER_H: i32 = 76;
    const FOOTER_H: i32 = 56;
    const CLIENT_W: i32 = 520;
    const CLIENT_H: i32 = 420;
    const SS_NOPREFIX: u32 = 128;
    const TRUST_TEXT: &str = "\
Os ficheiros ficam só nesta pasta, visível no Explorador.\r\n\
Não escreve no Registo e não usa AppData nem pastas ocultas.\r\n\
Para remover, apague a pasta (e os atalhos, se os criou).";

    static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);
    static CANCEL: AtomicBool = AtomicBool::new(false);
    static HWNDS: Mutex<Hwnds> = Mutex::new(Hwnds {
        frame: 0,
        path: 0,
        browse: 0,
        shortcut: 0,
        progress: 0,
        status: 0,
        install: 0,
        cancel: 0,
        open: 0,
        stop_all: 0,
    });
    static RESOURCES: Mutex<Resources> = Mutex::new(Resources {
        font_ui: 0,
        font_title: 0,
        font_sub: 0,
        font_small: 0,
        brush_header: 0,
        brush_footer: 0,
        brush_rule: 0,
        icon: 0,
    });

    #[derive(Default, Clone, Copy)]
    #[allow(dead_code)]
    struct Hwnds {
        frame: isize,
        path: isize,
        browse: isize,
        shortcut: isize,
        progress: isize,
        status: isize,
        install: isize,
        cancel: isize,
        open: isize,
        stop_all: isize,
    }

    #[derive(Default, Clone, Copy)]
    struct Resources {
        font_ui: isize,
        font_title: isize,
        font_sub: isize,
        font_small: isize,
        brush_header: isize,
        brush_footer: isize,
        brush_rule: isize,
        icon: isize,
    }

    fn rgb(r: u8, g: u8, b: u8) -> u32 {
        r as u32 | ((g as u32) << 8) | ((b as u32) << 16)
    }

    fn make_font(pt_px: i32, weight: i32) -> isize {
        let face = wide("Segoe UI");
        unsafe {
            CreateFontW(
                -pt_px,
                0,
                0,
                0,
                weight,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_TT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                DEFAULT_PITCH as u32 | ((FF_DONTCARE as u32) << 4),
                face.as_ptr(),
            ) as isize
        }
    }

    fn int_resource(id: u16) -> windows_sys::core::PCWSTR {
        id as usize as windows_sys::core::PCWSTR
    }

    pub fn run_window() -> Result<()> {
        unsafe {
            CoInitializeEx(null_mut(), COINIT_APARTMENTTHREADED as u32);
            let mut icc = INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES,
            };
            InitCommonControlsEx(&mut icc);

            let instance = GetModuleHandleW(null_mut());
            let icon = LoadImageW(
                instance,
                int_resource(IDI_APP),
                IMAGE_ICON,
                48,
                48,
                LR_DEFAULTCOLOR,
            );
            RESOURCES.lock().unwrap().icon = icon as isize;

            let class = wide("BethTermSetup");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: icon as _,
                hCursor: LoadCursorW(null_mut(), IDC_ARROW),
                hbrBackground: GetSysColorBrush(COLOR_WINDOW),
                lpszMenuName: null_mut(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);

            let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE | WS_CLIPCHILDREN;
            let mut wr = RECT {
                left: 0,
                top: 0,
                right: CLIENT_W,
                bottom: CLIENT_H,
            };
            AdjustWindowRectEx(&mut wr, style, 0, 0);
            let win_w = wr.right - wr.left;
            let win_h = wr.bottom - wr.top;

            let mut work = RECT::default();
            SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                &mut work as *mut RECT as *mut _,
                0,
            );
            let x = work.left + (work.right - work.left - win_w).max(0) / 2;
            let y = work.top + (work.bottom - work.top - win_h).max(0) / 2;

            let title = wide("BethTerm");
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                style,
                x,
                y,
                win_w,
                win_h,
                null_mut(),
                null_mut(),
                instance,
                null_mut(),
            );
            if hwnd.is_null() {
                bail!("não foi possível criar a janela do instalador");
            }
            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);

            let mut msg = std::mem::zeroed::<MSG>();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                if IsDialogMessageW(hwnd, &msg) == 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
        if let Some(err) = LAST_ERROR.lock().ok().and_then(|g| g.clone()) {
            bail!("{err}");
        }
        Ok(())
    }

    pub fn error(msg: &str) {
        message(msg, true);
    }

    /// Yes = close every window host and update them.
    /// No = update only the GUI and leave the hosts running.
    /// Cancel = do not update.
    fn ask_close_host() -> Option<bool> {
        const MB_YESNOCANCEL: u32 = 0x0000_0003;
        const MB_ICONQUESTION: u32 = 0x0000_0020;
        const IDYES: i32 = 6;
        const IDNO: i32 = 7;
        let title = wide("BethTerm");
        let body = wide(&format!(
            "Build {}.\n\n\
             O executável do host mudou e há terminais rodando.\n\
             Atualizar o host encerra esses terminais.\n\n\
             Sim: encerrar os hosts e atualizar tudo.\n\
             Não: atualizar só a interface. Os hosts e os terminais continuam.\n\
             Cancelar: não atualizar.",
            crate::build_stamp()
        ));
        let rc = unsafe {
            MessageBoxW(
                null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_YESNOCANCEL | MB_ICONQUESTION,
            )
        };
        match rc {
            IDYES => Some(true),
            IDNO => Some(false),
            _ => None,
        }
    }

    /// Patch 0164: last check before "Encerrar tudo" closes terminals.
    fn confirm_stop_all() -> bool {
        const MB_OKCANCEL: u32 = 0x0000_0001;
        const MB_ICONWARNING: u32 = 0x0000_0030;
        const MB_DEFBUTTON2: u32 = 0x0000_0100;
        let title = wide("BethTerm");
        let body = wide(
            "Encerrar tudo fecha todas as janelas do BethTerm e encerra\n\
             todos os terminais (o que estiver rodando neles será perdido).\n\n\
             Depois a instalação atualiza tudo, incluindo o host.\n\n\
             OK: encerrar tudo e instalar.\n\
             Cancelar: não fazer nada.",
        );
        let rc = unsafe {
            MessageBoxW(
                null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
            )
        };
        rc == IDOK
    }

    fn message(text: &str, is_error: bool) {
        let title = wide("BethTerm");
        let body = wide(text);
        let flags = MB_OK
            | if is_error {
                MB_ICONERROR
            } else {
                MB_ICONINFORMATION
            };
        unsafe {
            MessageBoxW(null_mut(), body.as_ptr(), title.as_ptr(), flags);
        }
    }

    fn as_hwnd(v: isize) -> HWND {
        v as HWND
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    fn set_text(hwnd: HWND, s: &str) {
        let w = wide(s);
        unsafe {
            SetWindowTextW(hwnd, w.as_ptr());
        }
    }

    fn get_text(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd) as usize + 1;
            let mut buf = vec![0u16; len.max(2)];
            GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            from_wide(&buf)
        }
    }

    fn child(
        class: &str,
        text: &str,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: HWND,
        id: i32,
    ) -> HWND {
        let class_w = wide(class);
        let text_w = wide(text);
        unsafe {
            let hwnd = CreateWindowExW(
                if class == "EDIT" { WS_EX_CLIENTEDGE } else { 0 },
                class_w.as_ptr(),
                text_w.as_ptr(),
                WS_CHILD | WS_VISIBLE | style,
                x,
                y,
                w,
                h,
                parent,
                id as _,
                GetModuleHandleW(null_mut()),
                null_mut(),
            );
            let font = {
                let ui = RESOURCES.lock().unwrap().font_ui;
                if ui != 0 {
                    ui as _
                } else {
                    GetStockObject(DEFAULT_GUI_FONT)
                }
            };
            SendMessageW(hwnd, WM_SETFONT, font as usize, 1);
            if class == "BUTTON" || class == "EDIT" {
                let theme = wide("Explorer");
                let _ = SetWindowTheme(hwnd, theme.as_ptr(), null_mut());
            }
            hwnd
        }
    }

    fn paint_header(hwnd: HWND) {
        unsafe {
            let mut ps = std::mem::zeroed::<PAINTSTRUCT>();
            let hdc = BeginPaint(hwnd, &mut ps);
            let mut client = RECT::default();
            GetClientRect(hwnd, &mut client);
            let res = *RESOURCES.lock().unwrap();
            let header = RECT {
                left: 0,
                top: 0,
                right: client.right,
                bottom: HEADER_H,
            };
            FillRect(hdc, &header, res.brush_header as _);
            let footer = RECT {
                left: 0,
                top: client.bottom - FOOTER_H,
                right: client.right,
                bottom: client.bottom,
            };
            FillRect(hdc, &footer, res.brush_footer as _);
            let rule = RECT {
                left: 0,
                top: footer.top,
                right: client.right,
                bottom: footer.top + 1,
            };
            FillRect(hdc, &rule, res.brush_rule as _);
            if res.icon != 0 {
                DrawIconEx(
                    hdc,
                    22,
                    14,
                    res.icon as _,
                    48,
                    48,
                    0,
                    null_mut(),
                    DI_NORMAL,
                );
            }
            SetBkMode(hdc, TRANSPARENT as i32);
            let mut title_rc = RECT {
                left: 82,
                top: 14,
                right: client.right - 16,
                bottom: 44,
            };
            let title = wide("BethTerm");
            SelectObject(hdc, res.font_title as _);
            SetTextColor(hdc, rgb(255, 255, 255));
            DrawTextW(
                hdc,
                title.as_ptr(),
                -1,
                &mut title_rc,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
            );
            let mut sub_rc = RECT {
                left: 82,
                top: 42,
                right: client.right - 16,
                bottom: 66,
            };
            let sub = wide(&format!("Build {}  ·  portátil", crate::build_stamp()));
            SelectObject(hdc, res.font_sub as _);
            SetTextColor(hdc, rgb(186, 220, 255));
            DrawTextW(
                hdc,
                sub.as_ptr(),
                -1,
                &mut sub_rc,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
            );
            EndPaint(hwnd, &ps);
        }
    }

    fn browse_folder(owner: HWND) -> Option<PathBuf> {
        unsafe {
            CoInitializeEx(null_mut(), COINIT_APARTMENTTHREADED as u32);
        }
        let title = wide("Pasta de instalação do BethTerm");
        let mut display = [0u16; MAX_PATH as usize];
        let mut info = unsafe { std::mem::zeroed::<BROWSEINFOW>() };
        info.hwndOwner = owner;
        info.pszDisplayName = display.as_mut_ptr();
        info.lpszTitle = title.as_ptr();
        info.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
        let pidl = unsafe { SHBrowseForFolderW(&info) };
        if pidl.is_null() {
            return None;
        }
        let mut path = [0u16; MAX_PATH as usize];
        let ok = unsafe { SHGetPathFromIDListW(pidl, path.as_mut_ptr()) };
        unsafe {
            ILFree(pidl);
        }
        if ok == 0 {
            return None;
        }
        Some(PathBuf::from(from_wide(&path)))
    }

    fn refresh_action_label() {
        let h = *HWNDS.lock().unwrap();
        let dest = PathBuf::from(get_text(as_hwnd(h.path)));
        let label = if is_existing_install(&dest) {
            "Atualizar"
        } else {
            "Instalar"
        };
        set_text(as_hwnd(h.install), label);
        let can_open = dest.join("bethterm-web.exe").is_file();
        unsafe {
            EnableWindow(as_hwnd(h.open), if can_open { 1 } else { 0 });
        }
    }

    fn launch_installed() {
        let h = *HWNDS.lock().unwrap();
        let dest = PathBuf::from(get_text(as_hwnd(h.path)).trim());
        let gui = dest.join("bethterm-web.exe");
        if !gui.is_file() {
            message(
                "Não encontrei bethterm-web.exe nessa pasta.\nInstale ou atualize primeiro.",
                true,
            );
            return;
        }
        let mut cmd = std::process::Command::new(&gui);
        cmd.current_dir(&dest);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        match cmd.spawn() {
            Ok(_) => unsafe { PostQuitMessage(0) },
            Err(e) => message(&format!("Não foi possível abrir o BethTerm.\n{e}"), true),
        }
    }

    fn start_install() {
        let h0 = *HWNDS.lock().unwrap();
        let dest = PathBuf::from(get_text(as_hwnd(h0.path)).trim());
        let want_shortcut =
            unsafe { IsDlgButtonChecked(as_hwnd(h0.frame), IDC_SHORTCUT) } == BST_CHECKED;
        let stop_all =
            unsafe { IsDlgButtonChecked(as_hwnd(h0.frame), IDC_STOP_ALL) } == BST_CHECKED;
        let frame = h0.frame;
        if dest.as_os_str().is_empty() {
            message("Indique a pasta de instalação.", true);
            return;
        }
        if is_forbidden_dest(&dest) {
            message(
                &format!(
                    "Essa pasta é a cópia em uso do WezTerminator.\nEscolha outra, por exemplo {}.",
                    suggested_install_dir().display()
                ),
                true,
            );
            return;
        }

        // Only a changed host binary may stop running terminals, and
        // only after the user says yes. A GUI-only update leaves them.
        let hosts_running = crate::host::any_running();
        let host_changed = match load_payload().and_then(|payload| {
            host_payload_differs(&payload, &dest.join("bethterm-host.exe"))
        }) {
            Ok(changed) => changed,
            Err(e) => {
                message(&format!("{e:#}"), true);
                return;
            }
        };
        if stop_all && !confirm_stop_all() {
            return;
        }
        // "Encerrar tudo" already stops every host before extraction.
        let close_host = if stop_all {
            false
        } else if hosts_running && host_changed {
            match ask_close_host() {
                Some(v) => v,
                None => return,
            }
        } else {
            false
        };
        let skip_host_files = hosts_running && !close_host && !stop_all;
        crate::life(&format!(
            "install started: build {} from {} to {}; hosts_running={hosts_running} \
             host_changed={host_changed} stop_all={stop_all} close_host={close_host}",
            crate::build_stamp(),
            std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            dest.display()
        ));

        unsafe {
            EnableWindow(as_hwnd(h0.install), 0);
            EnableWindow(as_hwnd(h0.path), 0);
            EnableWindow(as_hwnd(h0.browse), 0);
            EnableWindow(as_hwnd(h0.open), 0);
            SendMessageW(as_hwnd(h0.progress), PBM_SETRANGE32, 0, 100);
            SendMessageW(as_hwnd(h0.progress), PBM_SETPOS, 10, 0);
        }
        set_text(as_hwnd(h0.status), "A ler pacote zstd…");
        CANCEL.store(false, Ordering::Relaxed);

        std::thread::spawn(move || {
            let result = (|| -> Result<String> {
                let payload = load_payload()?;
                let mut host_closed = false;
                let mut stop_note = String::new();
                if stop_all {
                    set_text(as_hwnd(h0.status), "A encerrar o BethTerm e todos os terminais…");
                    stop_note = format!("\n\n{}", crate::stop_all::run(&dest));
                    host_closed = !crate::host::any_running();
                }
                if close_host {
                    set_text(as_hwnd(h0.status), "A encerrar o host…");
                    host_closed =
                        crate::host::request_quit_and_wait(
                            std::time::Duration::from_secs(10),
                            "setup: host binary changed, user answered Sim",
                        );
                    if !host_closed {
                        message(
                            "O host não encerrou em 10 s. O executável novo fica preparado\n\
                             e entra na próxima abertura.",
                            false,
                        );
                    }
                }
                set_text(as_hwnd(h0.status), "A extrair…");
                unsafe {
                    SendMessageW(as_hwnd(h0.progress), PBM_SETPOS, 40, 0);
                }
                fs::create_dir_all(&dest)
                    .with_context(|| format!("criar {}", dest.display()))?;
                let extracted = extract_zstd_tar(&payload, &dest, &CANCEL, skip_host_files)?;
                unsafe {
                    SendMessageW(as_hwnd(h0.progress), PBM_SETPOS, 80, 0);
                }
                let exe = dest.join("bethterm.exe");
                let gui = dest.join("bethterm-web.exe");
                anyhow::ensure!(exe.is_file(), "falhou a extração: falta bethterm.exe");
                anyhow::ensure!(gui.is_file(), "falhou a extração: falta bethterm-web.exe");
                shortcut::refresh_or_create(&gui, &dest, want_shortcut)?;
                let host_note = if skip_host_files && host_changed {
                    "\n\nA interface foi atualizada. Os hosts continuam com o executável anterior, como você pediu."
                } else if skip_host_files {
                    "\n\nSó a interface mudou. Os hosts não foram encerrados."
                } else if extracted.staged_host {
                    "\n\nO host ainda estava aberto, por isso o executável novo ficou em bethterm-host.exe.new.\nEncerre o host na bandeja e abra o BethTerm outra vez para ele entrar."
                } else if host_closed {
                    "\n\nO host foi encerrado e atualizado. Clique em Abrir para voltar ao BethTerm."
                } else {
                    ""
                };
                Ok(format!(
                    "BethTerm está em:\n{}\n\n\
                     Instalação portátil: não foi escrito nada no Registo do Windows.\n\
                     Os ficheiros do programa estão só nesta pasta (visível, não oculta).\n{}{}{}",
                    dest.display(),
                    if want_shortcut {
                        "Atalhos criados no Ambiente de Trabalho e no Menu Iniciar."
                    } else {
                        "Sem atalhos."
                    },
                    host_note,
                    stop_note
                ))
            })();
            match &result {
                Ok(_) => crate::life("install finished"),
                Err(e) => crate::life(&format!("install failed: {e:#}")),
            }
            let msg = match result {
                Ok(s) => s,
                Err(e) => {
                    if let Ok(mut g) = LAST_ERROR.lock() {
                        *g = Some(format!("{e:#}"));
                    }
                    format!("{e:#}")
                }
            };
            let wide_len = msg.len();
            let _ = wide_len;
            unsafe {
                SendMessageW(as_hwnd(h0.progress), PBM_SETPOS, 100, 0);
                PostMessageW(as_hwnd(frame), WM_DONE, 0, 0);
            }
            set_text(as_hwnd(h0.status), &msg);
        });
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CREATE => {
                {
                    let mut res = RESOURCES.lock().unwrap();
                    res.font_ui = make_font(15, 400);
                    if res.font_ui == 0 {
                        res.font_ui = GetStockObject(DEFAULT_GUI_FONT) as isize;
                    }
                    res.font_title = make_font(22, FW_BOLD as i32);
                    res.font_sub = make_font(13, 400);
                    res.font_small = make_font(13, 400);
                    res.brush_header = unsafe { CreateSolidBrush(rgb(18, 62, 104)) } as isize;
                    res.brush_footer = unsafe { CreateSolidBrush(rgb(243, 243, 243)) } as isize;
                    res.brush_rule = unsafe { CreateSolidBrush(rgb(218, 218, 218)) } as isize;
                }
                let mut client = RECT::default();
                GetClientRect(hwnd, &mut client);
                let cw = client.right;
                let ch = client.bottom;
                let suggested = suggested_install_dir();
                let _label = child(
                    "STATIC",
                    "Pasta",
                    SS_NOPREFIX,
                    20,
                    HEADER_H + 14,
                    cw - 40,
                    18,
                    hwnd,
                    0,
                );
                let path = child(
                    "EDIT",
                    &suggested.to_string_lossy(),
                    ES_AUTOHSCROLL as u32 | WS_TABSTOP,
                    20,
                    HEADER_H + 34,
                    cw - 148,
                    26,
                    hwnd,
                    IDC_PATH,
                );
                let browse = child(
                    "BUTTON",
                    "Procurar…",
                    BS_PUSHBUTTON as u32 | WS_TABSTOP,
                    cw - 120,
                    HEADER_H + 32,
                    100,
                    30,
                    hwnd,
                    IDC_BROWSE,
                );
                let trust = child(
                    "STATIC",
                    TRUST_TEXT,
                    SS_NOPREFIX,
                    20,
                    HEADER_H + 76,
                    cw - 40,
                    58,
                    hwnd,
                    0,
                );
                let small = RESOURCES.lock().unwrap().font_small;
                if small != 0 {
                    SendMessageW(trust, WM_SETFONT, small as usize, 1);
                }
                let shortcut = child(
                    "BUTTON",
                    "Criar atalhos no Ambiente de Trabalho e no Menu Iniciar",
                    BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
                    20,
                    HEADER_H + 142,
                    cw - 40,
                    22,
                    hwnd,
                    IDC_SHORTCUT,
                );
                SendMessageW(shortcut, BM_SETCHECK, BST_CHECKED as usize, 0);
                // Patch 0164: off by default; it closes every terminal.
                let stop_all = child(
                    "BUTTON",
                    "Encerrar tudo antes de instalar (fecha o BethTerm e todos os terminais)",
                    BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
                    20,
                    HEADER_H + 168,
                    cw - 40,
                    22,
                    hwnd,
                    IDC_STOP_ALL,
                );
                let progress = child(
                    "msctls_progress32",
                    "",
                    PBS_SMOOTH,
                    20,
                    HEADER_H + 202,
                    cw - 40,
                    8,
                    hwnd,
                    IDC_PROGRESS,
                );
                let status = child(
                    "STATIC",
                    "Baseado no WezTerm.",
                    SS_NOPREFIX,
                    20,
                    HEADER_H + 218,
                    cw - 40,
                    36,
                    hwnd,
                    IDC_STATUS,
                );
                if small != 0 {
                    SendMessageW(status, WM_SETFONT, small as usize, 1);
                }
                let action = if is_existing_install(&suggested) {
                    "Atualizar"
                } else {
                    "Instalar"
                };
                let by = ch - FOOTER_H + 12;
                let open = child(
                    "BUTTON",
                    "Abrir",
                    BS_PUSHBUTTON as u32 | WS_TABSTOP,
                    cw - 348,
                    by,
                    100,
                    30,
                    hwnd,
                    IDC_OPEN,
                );
                let install = child(
                    "BUTTON",
                    action,
                    BS_DEFPUSHBUTTON as u32 | WS_TABSTOP,
                    cw - 240,
                    by,
                    108,
                    30,
                    hwnd,
                    IDC_INSTALL,
                );
                let cancel = child(
                    "BUTTON",
                    "Cancelar",
                    BS_PUSHBUTTON as u32 | WS_TABSTOP,
                    cw - 124,
                    by,
                    104,
                    30,
                    hwnd,
                    IDC_CANCEL,
                );
                let _ = (browse, cancel, shortcut);
                *HWNDS.lock().unwrap() = Hwnds {
                    frame: hwnd as isize,
                    path: path as isize,
                    browse: browse as isize,
                    shortcut: shortcut as isize,
                    progress: progress as isize,
                    status: status as isize,
                    install: install as isize,
                    cancel: cancel as isize,
                    open: open as isize,
                    stop_all: stop_all as isize,
                };
                refresh_action_label();
                0
            }
            WM_CTLCOLORSTATIC => {
                let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
                SetBkColor(hdc, rgb(255, 255, 255));
                SetTextColor(hdc, rgb(55, 55, 55));
                SetBkMode(hdc, TRANSPARENT as i32);
                GetSysColorBrush(COLOR_WINDOW) as isize
            }
            WM_PAINT => {
                paint_header(hwnd);
                0
            }
            WM_COMMAND => {
                let id = (wparam as u32) & 0xFFFF;
                match id as i32 {
                    IDC_BROWSE => {
                        if let Some(dir) = browse_folder(hwnd) {
                            let dest = if dir.file_name().and_then(|n| n.to_str()) == Some("BethTerm")
                            {
                                dir
                            } else {
                                dir.join("BethTerm")
                            };
                            let path_hwnd = as_hwnd(HWNDS.lock().unwrap().path);
                            set_text(path_hwnd, &dest.to_string_lossy());
                            refresh_action_label();
                        }
                    }
                    IDC_INSTALL | IDOK => start_install(),
                    IDC_OPEN => launch_installed(),
                    IDC_CANCEL | IDCANCEL => {
                        CANCEL.store(true, Ordering::Relaxed);
                        unsafe { PostQuitMessage(0) };
                    }
                    _ => {}
                }
                0
            }
            WM_DONE => {
                let h = *HWNDS.lock().unwrap();
                unsafe {
                    EnableWindow(as_hwnd(h.install), 1);
                    EnableWindow(as_hwnd(h.path), 1);
                    EnableWindow(as_hwnd(h.browse), 1);
                }
                refresh_action_label();
                if let Some(err) = LAST_ERROR.lock().ok().and_then(|g| g.clone()) {
                    message(&err, true);
                    if let Ok(mut g) = LAST_ERROR.lock() {
                        *g = None;
                    }
                } else {
                    set_text(as_hwnd(h.cancel), "Fechar");
                    set_text(as_hwnd(h.open), "Abrir");
                    unsafe {
                        EnableWindow(as_hwnd(h.open), 1);
                    }
                }
                0
            }
            WM_CLOSE => {
                unsafe { PostQuitMessage(0) };
                0
            }
            WM_DESTROY => {
                let res = *RESOURCES.lock().unwrap();
                unsafe {
                    if res.font_ui != 0 {
                        DeleteObject(res.font_ui as _);
                    }
                    if res.font_title != 0 {
                        DeleteObject(res.font_title as _);
                    }
                    if res.font_sub != 0 {
                        DeleteObject(res.font_sub as _);
                    }
                    if res.font_small != 0 {
                        DeleteObject(res.font_small as _);
                    }
                    if res.brush_header != 0 {
                        DeleteObject(res.brush_header as _);
                    }
                    if res.brush_footer != 0 {
                        DeleteObject(res.brush_footer as _);
                    }
                    if res.brush_rule != 0 {
                        DeleteObject(res.brush_rule as _);
                    }
                    PostQuitMessage(0);
                }
                0
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }
}

#[cfg(not(windows))]
mod ui {
    use super::*;
    pub fn run_window() -> Result<()> {
        bail!("instalador só no Windows")
    }
    pub fn error(msg: &str) {
        eprintln!("{msg}");
    }
}
