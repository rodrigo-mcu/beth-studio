// wtinator::syspanel — "BethTerm — Sistema" modeless window with
// CPU / RAM / disk usage, refreshed once a second.
//
// A plain Win32 `WS_OVERLAPPED` window (caption + close box, no
// resize border) painted with GDI in system colors, so it follows
// light/dark mode with no theming code. It is created and pumped on
// the tray owner thread, which already runs a message loop; the tray
// menu's "Sistema" entry toggles it via [`toggle_panel`].
//
// Data comes from [`crate::sysmon`]; this module only draws.

#![allow(unsafe_code)]

use crate::sysmon::{fmt_gb, sample};
use std::sync::atomic::{AtomicIsize, Ordering};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, GetSysColor, InvalidateRect,
    SetBkMode, SetTextColor, TextOutW, COLOR_BTNFACE, COLOR_HIGHLIGHT, COLOR_WINDOW,
    COLOR_WINDOWTEXT, PAINTSTRUCT, TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, IsWindow, KillTimer, RegisterClassExW,
    SetForegroundWindow, SetTimer, ShowWindow, CW_USEDEFAULT, SW_SHOW, WM_CREATE, WM_DESTROY,
    WM_PAINT, WM_TIMER, WS_CAPTION, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WNDCLASSEXW,
};

const CLASS_NAME: &str = "BethTermSysPanel";
const WINDOW_TITLE: &str = "BethTerm \u{2014} Sistema";
const PANEL_TIMER_ID: usize = 1;
const PANEL_WIDTH: i32 = 340;
const PAD: i32 = 14;
const TEXT_H: i32 = 20;
const BAR_H: i32 = 14;
const SECTION_GAP: i32 = 10;

static PANEL_HWND: AtomicIsize = AtomicIsize::new(0);

fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Show the system panel, or bring it to the front when already open.
/// Must be called on the tray owner thread (the tray menu runs there).
pub fn toggle_panel() {
    let hwnd = PANEL_HWND.load(Ordering::SeqCst);
    if hwnd != 0 && unsafe { IsWindow(hwnd as HWND) } != 0 {
        unsafe {
            ShowWindow(hwnd as HWND, SW_SHOW);
            SetForegroundWindow(hwnd as HWND);
        }
        return;
    }
    PANEL_HWND.store(0, Ordering::SeqCst);
    create_panel();
}

fn create_panel() {
    let class_name = wide(CLASS_NAME);
    let window_title = wide(WINDOW_TITLE);
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(panel_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        // Re-registering an existing class fails; that is fine.
        let _ = RegisterClassExW(&wc);
        // Size the window from the live disk count (CPU + RAM + disks).
        let sections = 2 + sample().disks.len() as i32;
        let height = 70 + sections * (TEXT_H + BAR_H + SECTION_GAP);
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            window_title.as_ptr(),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            PANEL_WIDTH,
            height,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            log::error!("bethterm syspanel: CreateWindowExW failed");
            return;
        }
        PANEL_HWND.store(hwnd as isize, Ordering::SeqCst);
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
    }
}

unsafe extern "system" fn panel_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            SetTimer(hwnd, PANEL_TIMER_ID, 1000, None);
            0
        }
        WM_TIMER => {
            if wparam == PANEL_TIMER_ID {
                InvalidateRect(hwnd, std::ptr::null(), 1);
            }
            0
        }
        WM_PAINT => {
            paint_panel(hwnd);
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, PANEL_TIMER_ID);
            PANEL_HWND.store(0, Ordering::SeqCst);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn clamp_pct(pct: f32) -> f32 {
    if pct < 0.0 {
        0.0
    } else if pct > 100.0 {
        100.0
    } else {
        pct
    }
}

fn paint_panel(hwnd: HWND) {
    let stats = sample();
    let mut rows: Vec<(String, f32)> = vec![
        (format!("CPU  {:.0}%", clamp_pct(stats.cpu_pct)), stats.cpu_pct),
        (
            format!(
                "RAM  {} / {}  ({:.0}%)",
                fmt_gb(stats.ram_used_bytes),
                fmt_gb(stats.ram_total_bytes),
                clamp_pct(stats.ram_pct())
            ),
            stats.ram_pct(),
        ),
    ];
    for disk in &stats.disks {
        rows.push((
            format!(
                "{}  {} / {}  ({:.0}%)",
                disk.label,
                fmt_gb(disk.used_bytes),
                fmt_gb(disk.total_bytes),
                clamp_pct(disk.pct())
            ),
            disk.pct(),
        ));
    }

    unsafe {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);
        if hdc.is_null() {
            return;
        }
        let mut client = std::mem::zeroed::<RECT>();
        GetClientRect(hwnd, &mut client);
        let bg = CreateSolidBrush(GetSysColor(COLOR_WINDOW));
        let bar_bg = CreateSolidBrush(GetSysColor(COLOR_BTNFACE));
        let bar_fill = CreateSolidBrush(GetSysColor(COLOR_HIGHLIGHT));
        FillRect(hdc, &client, bg);
        SetTextColor(hdc, GetSysColor(COLOR_WINDOWTEXT));
        SetBkMode(hdc, TRANSPARENT as i32);

        let bar_left = PAD;
        let bar_right = client.right - PAD;
        let mut y = PAD;
        for (label, pct) in &rows {
            let text = wide(label);
            // `wide` appends a NUL for menu APIs; TextOutW takes a count.
            TextOutW(hdc, PAD, y, text.as_ptr(), text.len() as i32 - 1);
            y += TEXT_H;
            let bar = RECT {
                left: bar_left,
                top: y,
                right: bar_right,
                bottom: y + BAR_H,
            };
            FillRect(hdc, &bar, bar_bg);
            let width = bar_right - bar_left;
            let filled = (width as f32 * clamp_pct(*pct) / 100.0) as i32;
            if filled > 0 {
                let fill = RECT {
                    left: bar_left,
                    top: y,
                    right: bar_left + filled,
                    bottom: y + BAR_H,
                };
                FillRect(hdc, &fill, bar_fill);
            }
            y += BAR_H + SECTION_GAP;
        }

        DeleteObject(bg as _);
        DeleteObject(bar_bg as _);
        DeleteObject(bar_fill as _);
        EndPaint(hwnd, &ps);
    }
}
