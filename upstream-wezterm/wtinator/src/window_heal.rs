// wtinator::window_heal — patch 0079.
//
// After a Windows freeze (disk full, hung I/O), wezterm-gui can stay in
// the process list with no usable window: HWND never shown, off-screen
// WS_POPUP, or a live mux socket whose GUI thread is stuck.
//
// This module heals that without the user hunting Task Manager:
//   * skip attaching to an existing GUI that has no on-screen window
//     (so a new process can create a visible one);
//   * on a dedicated OS thread, ShowWindow + move onto the work area
//     if our HWND is hidden or off-screen (does not need the GUI
//     executor, which may itself be blocked on AppData).

/// True when a new process should ignore the published gui-sock and
/// create its own window. On non-Windows this is always false.
pub fn should_start_fresh() -> bool {
    #[cfg(windows)]
    {
        !existing_gui_is_usable()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Repeatedly try to make `hwnd` visible and on a monitor.
///
/// Runs off the GUI thread so a blocked executor cannot prevent the
/// window from appearing.
pub fn schedule_visibility_watchdog(hwnd: isize) {
    #[cfg(windows)]
    {
        if hwnd == 0 {
            return;
        }
        let _ = std::thread::Builder::new()
            .name("wt-window-heal".into())
            .spawn(move || {
                for ms in [400_u64, 2_000, 8_000] {
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                    // Patch 0148: a window restored hidden in the tray is
                    // hidden on purpose.
                    if crate::window_geom::is_keep_hidden(hwnd) {
                        return;
                    }
                    if heal_hwnd(hwnd) {
                        log::info!(
                            "wezterminator: window heal brought HWND {:#x} on-screen",
                            hwnd
                        );
                        return;
                    }
                }
                log::warn!(
                    "wezterminator: HWND {:#x} still not a usable on-screen window",
                    hwnd
                );
            });
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn existing_gui_is_usable() -> bool {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;

    struct Scan {
        usable: bool,
        windows: usize,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let scan = &mut *(lparam as *mut Scan);
        if !is_wezterm_hwnd(hwnd) {
            return 1;
        }
        scan.windows += 1;
        if window_is_usable(hwnd) {
            scan.usable = true;
        } else {
            heal_hwnd_raw(hwnd);
            if window_is_usable(hwnd) {
                scan.usable = true;
            }
        }
        1
    }

    let mut scan = Scan {
        usable: false,
        windows: 0,
    };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), &mut scan as *mut Scan as LPARAM);
    }
    // Patch 0165: after the last window closes the GUI stays in the
    // tray with no terminal window at all. Attach to it instead of
    // starting a second process with a second tray icon.
    scan.usable || (scan.windows == 0 && crate::tray::owner_exists())
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn is_wezterm_hwnd(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&buf[..n as usize]).to_ascii_lowercase();
    class.contains("wezterm")
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn window_is_usable(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{MonitorFromRect, MONITOR_DEFAULTTONULL};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsIconic, IsWindowVisible,
    };

    unsafe {
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return false;
        }
        let mut rc = RECT::default();
        if GetWindowRect(hwnd, &mut rc) == 0 {
            return false;
        }
        if rc.right - rc.left < 80 || rc.bottom - rc.top < 80 {
            return false;
        }
        let mon = MonitorFromRect(&rc, MONITOR_DEFAULTTONULL);
        !mon.is_null()
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn heal_hwnd(hwnd: isize) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    let hwnd = hwnd as HWND;
    if hwnd.is_null() {
        return false;
    }
    // Patch 0148: only move a window that is actually broken. Healing
    // every new window pushed each one to the same corner and undid the
    // restored placement (and the default maximize).
    if window_is_usable(hwnd) {
        return true;
    }
    heal_hwnd_raw(hwnd);
    window_is_usable(hwnd)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn heal_hwnd_raw(hwnd: windows_sys::Win32::Foundation::HWND) {
    use std::mem::size_of;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, SetWindowPos, ShowWindow, HWND_TOP, SWP_SHOWWINDOW, SW_RESTORE,
        SW_SHOW,
    };

    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if mon.is_null() {
            return;
        }
        let mut mi = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return;
        }
        let work = mi.rcWork;
        let width = (work.right - work.left).clamp(800, 1600);
        let height = (work.bottom - work.top).clamp(500, 1000);
        let x = work.left + 24;
        let y = work.top + 24;
        let _ = SetWindowPos(
            hwnd,
            HWND_TOP,
            x,
            y,
            width,
            height,
            SWP_SHOWWINDOW,
        );
        let _ = SetForegroundWindow(hwnd);
    }
}
