// wtinator::ui_watchdog — patch 0162.
//
// When the UI thread stops pumping messages, Windows swaps the window
// for a "Not responding" ghost: the BethTerm title bar disappears and
// nothing repaints. The GUI log is written from that same thread, so
// it goes silent and leaves no trace.
//
// A separate thread sends WM_NULL to one of our windows with a
// timeout. Modal loops (window drag, native menus, TaskDialog) still
// answer sent messages, so only a real stall is reported. On a stall
// it writes a line to `host-life.log` with the message the UI thread
// was handling, and once per stall a minidump with every thread's
// stack under `%LOCALAPPDATA%\bethterm\hang-dumps`.

/// `(last window message, wnd_proc nesting depth)` from the window
/// crate.
pub type WndProcState = fn() -> (u32, u32);

/// Start the watchdog thread (once per GUI process).
pub fn start(wndproc_state: WndProcState) {
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static STARTED: AtomicBool = AtomicBool::new(false);
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = std::thread::Builder::new()
            .name("bethterm-ui-watchdog".into())
            .spawn(move || imp::run(wndproc_state));
    }
    #[cfg(not(windows))]
    {
        let _ = wndproc_state;
    }
}

/// Readable name for the messages most likely to be in flight.
pub fn message_name(msg: u32) -> &'static str {
    match msg {
        0x0000 => "WM_NULL",
        0x0003 => "WM_MOVE",
        0x0005 => "WM_SIZE",
        0x0006 => "WM_ACTIVATE",
        0x0007 => "WM_SETFOCUS",
        0x0008 => "WM_KILLFOCUS",
        0x000F => "WM_PAINT",
        0x0010 => "WM_CLOSE",
        0x0018 => "WM_SHOWWINDOW",
        0x001A => "WM_SETTINGCHANGE",
        0x0024 => "WM_GETMINMAXINFO",
        0x0046 => "WM_WINDOWPOSCHANGING",
        0x0047 => "WM_WINDOWPOSCHANGED",
        0x0081 => "WM_NCCREATE",
        0x0083 => "WM_NCCALCSIZE",
        0x0084 => "WM_NCHITTEST",
        0x0086 => "WM_NCACTIVATE",
        0x00A0 => "WM_NCMOUSEMOVE",
        0x00A1 => "WM_NCLBUTTONDOWN",
        0x0100 => "WM_KEYDOWN",
        0x0102 => "WM_CHAR",
        0x0112 => "WM_SYSCOMMAND",
        0x0113 => "WM_TIMER",
        0x0200 => "WM_MOUSEMOVE",
        0x0201 => "WM_LBUTTONDOWN",
        0x0202 => "WM_LBUTTONUP",
        0x0204 => "WM_RBUTTONDOWN",
        0x0205 => "WM_RBUTTONUP",
        0x020A => "WM_MOUSEWHEEL",
        0x0214 => "WM_SIZING",
        0x0216 => "WM_MOVING",
        0x0231 => "WM_ENTERSIZEMOVE",
        0x0232 => "WM_EXITSIZEMOVE",
        0x02A3 => "WM_MOUSELEAVE",
        0x02E0 => "WM_DPICHANGED",
        _ => "?",
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod imp {
    use super::{message_name, WndProcState};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsWindow, SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_NORMAL, WM_NULL,
    };

    const PROBE_TIMEOUT_MS: u32 = 5_000;
    const DUMP_AFTER: Duration = Duration::from_secs(10);
    const KEEP_DUMPS: usize = 3;

    pub fn run(wndproc_state: WndProcState) {
        let mut stalled_since: Option<Instant> = None;
        let mut dumped = false;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let Some(hwnd) = crate::window_geom::any_hwnd() else {
                continue;
            };
            if unsafe { IsWindow(hwnd as HWND) } == 0 {
                continue;
            }
            let sent_at = Instant::now();
            let mut result = 0usize;
            let ok = unsafe {
                SendMessageTimeoutW(
                    hwnd as HWND,
                    WM_NULL,
                    0,
                    0,
                    SMTO_NORMAL | SMTO_ABORTIFHUNG,
                    PROBE_TIMEOUT_MS,
                    &mut result,
                )
            };
            if ok != 0 {
                if let Some(since) = stalled_since.take() {
                    crate::host::note_life(&format!(
                        "ui watchdog: UI thread answered again after {:.1}s",
                        since.elapsed().as_secs_f64()
                    ));
                }
                dumped = false;
                continue;
            }
            let since = *stalled_since.get_or_insert(sent_at);
            let (msg, depth) = wndproc_state();
            if since == sent_at {
                // depth=0: stuck outside any window message, i.e. in a
                // task on the main-thread executor; `msg` is then only
                // the last message handled before it.
                let place = if depth == 0 {
                    "outside wnd_proc (main-thread task)"
                } else {
                    "inside wnd_proc"
                };
                crate::host::note_life(&format!(
                    "ui watchdog: UI thread is not answering (5s), {place}; \
                     last window message {:#06x} {} depth={depth}",
                    msg,
                    message_name(msg)
                ));
            }
            if !dumped && since.elapsed() >= DUMP_AFTER {
                dumped = true;
                match write_dump() {
                    Ok(path) => crate::host::note_life(&format!(
                        "ui watchdog: still stuck on {:#06x} {} depth={depth}; dump {}",
                        msg,
                        message_name(msg),
                        path.display()
                    )),
                    Err(err) => crate::host::note_life(&format!(
                        "ui watchdog: still stuck; dump failed: {err:#}"
                    )),
                }
            }
        }
    }

    fn dump_dir() -> PathBuf {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("bethterm")
            .join("hang-dumps")
    }

    fn prune(dir: &std::path::Path) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut dumps: Vec<(std::time::SystemTime, PathBuf)> = rd
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "dmp"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        dumps.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in dumps.into_iter().skip(KEEP_DUMPS) {
            let _ = std::fs::remove_file(path);
        }
    }

    fn write_dump() -> anyhow::Result<PathBuf> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Diagnostics::Debug::{
            MiniDumpWithThreadInfo, MiniDumpWithUnloadedModules, MiniDumpWriteDump,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let dir = dump_dir();
        std::fs::create_dir_all(&dir)?;
        prune(&dir);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!(
            "bethterm-gui-{}-{stamp}.dmp",
            std::process::id()
        ));
        let file = std::fs::File::create(&path)?;
        let ok = unsafe {
            MiniDumpWriteDump(
                GetCurrentProcess(),
                std::process::id(),
                file.as_raw_handle() as _,
                MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        anyhow::ensure!(ok != 0, "MiniDumpWriteDump failed ({})", std::io::Error::last_os_error());
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::message_name;

    #[test]
    fn names_common_messages() {
        assert_eq!(message_name(0x0047), "WM_WINDOWPOSCHANGED");
        assert_eq!(message_name(0x0232), "WM_EXITSIZEMOVE");
        assert_eq!(message_name(0xBEEF), "?");
    }
}
