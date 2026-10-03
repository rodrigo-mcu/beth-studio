//! Per-window taskbar icon color (patch 0151).
//!
//! Every BethTerm window otherwise shares the executable icon, so a
//! row of taskbar buttons all looks the same. The right-click menu
//! picks a color; `WM_SETICON` puts that color on this window's
//! taskbar button, Alt+Tab entry and thumbnail. The choice is stored
//! in `host-windows.json` next to the window name.

use std::collections::HashMap;
use std::sync::Mutex;

/// One swatch in the "Cor do ícone" menu. `rgb` is `0x00RRGGBB`.
pub struct Swatch {
    pub id: &'static str,
    pub label: &'static str,
    pub rgb: u32,
}

/// Menu order. Slot 0 in the command ids is "Padrão", not a swatch.
pub const SWATCHES: &[Swatch] = &[
    Swatch { id: "blue", label: "Azul", rgb: 0x3B82F6 },
    Swatch { id: "green", label: "Verde", rgb: 0x22C55E },
    Swatch { id: "orange", label: "Laranja", rgb: 0xF97316 },
    Swatch { id: "red", label: "Vermelho", rgb: 0xEF4444 },
    Swatch { id: "purple", label: "Roxo", rgb: 0xA855F7 },
    Swatch { id: "yellow", label: "Amarelo", rgb: 0xEAB308 },
    Swatch { id: "cyan", label: "Ciano", rgb: 0x06B6D4 },
    Swatch { id: "pink", label: "Rosa", rgb: 0xEC4899 },
];

/// `0x6820` is the default icon. `0x6821 + i` is [`SWATCHES`][i].
pub const WID_BASE: u16 = 0x6820;

/// What `host-windows.json` should do with a window's saved color.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SavedColor {
    /// The user has not touched the color this session. Keep the file.
    Keep,
    /// The user picked "Padrão".
    Clear,
    /// The user picked a swatch.
    Set(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Choice {
    Default,
    Color(String),
}

fn choices() -> std::sync::MutexGuard<'static, HashMap<Vec<usize>, Choice>> {
    static CHOICES: std::sync::OnceLock<Mutex<HashMap<Vec<usize>, Choice>>> =
        std::sync::OnceLock::new();
    CHOICES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn swatch_by_id(id: &str) -> Option<&'static Swatch> {
    SWATCHES.iter().find(|s| s.id == id)
}

/// `slot` 0 restores the application icon. `slot` 1.. is a swatch.
pub fn apply_slot(mux_window_id: usize, hwnd: isize, slot: u8) {
    let color = if slot == 0 {
        None
    } else {
        SWATCHES.get((slot as usize).saturating_sub(1)).map(|s| s.id)
    };
    remember(mux_window_id, color);
    store_color(hwnd, color);
    #[cfg(windows)]
    apply_hwnd(hwnd, color, crate::agent_wait::hwnd_is_waiting(hwnd));
    #[cfg(not(windows))]
    {
        let _ = hwnd;
    }
}

/// Re-apply a color read from `host-windows.json` and remember it so
/// the next save does not drop it.
pub fn restore_saved(mux_window_id: usize, hwnd: isize, color_id: &str) {
    if swatch_by_id(color_id).is_none() {
        return;
    }
    remember(mux_window_id, Some(color_id));
    store_color(hwnd, Some(color_id));
    #[cfg(windows)]
    apply_hwnd(hwnd, Some(color_id), crate::agent_wait::hwnd_is_waiting(hwnd));
    #[cfg(not(windows))]
    {
        let _ = hwnd;
    }
}

/// Redraw this window's taskbar icon with or without the waiting dot.
pub fn set_waiting(hwnd: isize, waiting: bool) {
    #[cfg(windows)]
    apply_hwnd(hwnd, stored_color(hwnd).as_deref(), waiting);
    #[cfg(not(windows))]
    {
        let _ = (hwnd, waiting);
    }
}

/// Notification-area icon: the app icon, with a red dot when any
/// window has an agent waiting.
///
/// Patch 0169: both variants are built once and reused. The tray
/// watchdog calls this every 15 s; a fresh `LoadImageW` / badged icon
/// per call leaked ~3 GDI objects each time until the process hit the
/// 10000 limit and no menu or icon could be created any more.
#[cfg(windows)]
#[allow(unsafe_code)]
pub fn tray_icon() -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static PLAIN: AtomicUsize = AtomicUsize::new(0);
    static BADGED: AtomicUsize = AtomicUsize::new(0);
    let (slot, make): (&AtomicUsize, fn(i32) -> _) = if crate::agent_wait::any_waiting() {
        (&BADGED, badged_app_icon)
    } else {
        (&PLAIN, app_icon)
    };
    let cached = slot.load(Ordering::Acquire);
    if cached != 0 {
        return cached as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
    }
    // A failed load (0) is not cached; the next tick tries again.
    let fresh = make(32) as usize;
    if fresh == 0 {
        return std::ptr::null_mut();
    }
    match slot.compare_exchange(0, fresh, Ordering::AcqRel, Ordering::Acquire) {
        Ok(_) => fresh as windows_sys::Win32::UI::WindowsAndMessaging::HICON,
        Err(winner) => {
            // Another thread cached one first; drop ours.
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(
                    fresh as windows_sys::Win32::UI::WindowsAndMessaging::HICON,
                );
            }
            winner as windows_sys::Win32::UI::WindowsAndMessaging::HICON
        }
    }
}

pub fn choice_for_save(ids: &[usize]) -> SavedColor {
    match choices().get(ids) {
        None => SavedColor::Keep,
        Some(Choice::Default) => SavedColor::Clear,
        Some(Choice::Color(id)) => SavedColor::Set(id.clone()),
    }
}

fn colors() -> std::sync::MutexGuard<'static, HashMap<isize, Option<String>>> {
    static COLORS: std::sync::OnceLock<Mutex<HashMap<isize, Option<String>>>> =
        std::sync::OnceLock::new();
    COLORS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn store_color(hwnd: isize, color: Option<&str>) {
    if hwnd == 0 {
        return;
    }
    colors().insert(hwnd, color.map(str::to_string));
}

fn stored_color(hwnd: isize) -> Option<String> {
    colors().get(&hwnd).cloned().flatten()
}

fn remember(mux_window_id: usize, color: Option<&str>) {
    let Some(mux) = mux::Mux::try_get() else {
        return;
    };
    let ids = crate::window_geom::remote_pane_ids_of_window(&mux, mux_window_id);
    if ids.is_empty() {
        return;
    }
    let choice = match color {
        Some(id) => Choice::Color(id.to_string()),
        None => Choice::Default,
    };
    choices().insert(ids, choice);
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn apply_hwnd(hwnd: isize, color: Option<&str>, waiting: bool) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageW, ICON_BIG, ICON_SMALL, WM_SETICON,
    };
    if hwnd == 0 {
        return;
    }
    let hwnd = hwnd as HWND;
    let (big, small) = match color.and_then(swatch_by_id) {
        Some(swatch) => (
            color_icon(32, swatch.rgb, waiting),
            color_icon(16, swatch.rgb, waiting),
        ),
        None if waiting => (badged_app_icon(32), badged_app_icon(16)),
        None => (app_icon(32), app_icon(16)),
    };
    unsafe {
        if !big.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, big as isize);
        }
        if !small.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, small as isize);
        }
    }
    retain_icons(hwnd as isize, big, small);
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn color_icon(
    size: i32,
    rgb: u32,
    badge: bool,
) -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, ICONINFO};
    unsafe {
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size,
            biHeight: -size,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let color = CreateDIBSection(
            std::ptr::null_mut(),
            &bmi,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        if color.is_null() || bits.is_null() {
            return std::ptr::null_mut();
        }
        let b = (rgb & 0xff) as u8;
        let g = ((rgb >> 8) & 0xff) as u8;
        let r = ((rgb >> 16) & 0xff) as u8;
        let px = bits as *mut u8;
        for y in 0..size {
            for x in 0..size {
                let edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
                let (bb, gg, rr) = if edge { (255, 255, 255) } else { (b, g, r) };
                let i = ((y * size + x) * 4) as isize;
                *px.offset(i) = bb;
                *px.offset(i + 1) = gg;
                *px.offset(i + 2) = rr;
                *px.offset(i + 3) = 255;
            }
        }
        if badge {
            paint_wait_badge(px, size);
        }
        let row = (((size + 31) / 32) * 4) as usize;
        let mask_bits = vec![0u8; row * size as usize];
        let mask = CreateBitmap(size, size, 1, 1, mask_bits.as_ptr() as *const _);
        let info = ICONINFO {
            fIcon: 1,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = CreateIconIndirect(&info);
        if !color.is_null() {
            DeleteObject(color);
        }
        if !mask.is_null() {
            DeleteObject(mask);
        }
        icon
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn paint_wait_badge(px: *mut u8, size: i32) {
    let r = (size / 5).max(2);
    let cx = size - r - 1;
    let cy = size - r - 1;
    let r2 = r * r;
    let inner = (r - 1).max(1);
    let inner2 = inner * inner;
    for y in (cy - r).max(0)..(cy + r + 1).min(size) {
        for x in (cx - r).max(0)..(cx + r + 1).min(size) {
            let dx = x - cx;
            let dy = y - cy;
            let d = dx * dx + dy * dy;
            if d > r2 {
                continue;
            }
            let i = ((y * size + x) * 4) as isize;
            unsafe {
                if d > inner2 {
                    *px.offset(i) = 255;
                    *px.offset(i + 1) = 255;
                    *px.offset(i + 2) = 255;
                } else {
                    *px.offset(i) = 32;
                    *px.offset(i + 1) = 32;
                    *px.offset(i + 2) = 220;
                }
                *px.offset(i + 3) = 255;
            }
        }
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn badged_app_icon(size: i32) -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateBitmap, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, DestroyIcon, DrawIconEx, ICONINFO, DI_NORMAL,
    };
    unsafe {
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size,
            biHeight: -size,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let color = CreateDIBSection(
            std::ptr::null_mut(),
            &bmi,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        if color.is_null() || bits.is_null() {
            return std::ptr::null_mut();
        }
        let src = app_icon(size);
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        if !dc.is_null() {
            let prev = SelectObject(dc, color);
            if !src.is_null() {
                DrawIconEx(dc, 0, 0, src, size, size, 0, std::ptr::null_mut(), DI_NORMAL);
                DestroyIcon(src);
            }
            SelectObject(dc, prev);
            DeleteDC(dc);
        }
        paint_wait_badge(bits as *mut u8, size);
        let row = (((size + 31) / 32) * 4) as usize;
        let mask_bits = vec![0u8; row * size as usize];
        let mask = CreateBitmap(size, size, 1, 1, mask_bits.as_ptr() as *const _);
        let info = ICONINFO {
            fIcon: 1,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = CreateIconIndirect(&info);
        if !color.is_null() {
            DeleteObject(color);
        }
        if !mask.is_null() {
            DeleteObject(mask);
        }
        icon
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn app_icon(size: i32) -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{LoadImageW, IMAGE_ICON};
    // Same resource the window class uses (`assets/windows/resource.rc`).
    // MAKEINTRESOURCEW is a cast of the resource id to a string pointer.
    const ICON_RES: usize = 0x101;
    unsafe {
        LoadImageW(
            GetModuleHandleW(std::ptr::null()),
            ICON_RES as *const u16,
            IMAGE_ICON,
            size,
            size,
            0,
        ) as windows_sys::Win32::UI::WindowsAndMessaging::HICON
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn retain_icons(
    hwnd: isize,
    big: windows_sys::Win32::UI::WindowsAndMessaging::HICON,
    small: windows_sys::Win32::UI::WindowsAndMessaging::HICON,
) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};
    static OWNED: std::sync::OnceLock<Mutex<HashMap<isize, (usize, usize)>>> =
        std::sync::OnceLock::new();
    let mut guard = OWNED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((old_big, old_small)) = guard.insert(hwnd, (big as usize, small as usize)) {
        unsafe {
            if old_big != 0 {
                DestroyIcon(old_big as HICON);
            }
            if old_small != 0 {
                DestroyIcon(old_small as HICON);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swatches_have_unique_ids_and_menu_slots() {
        let mut ids = std::collections::HashSet::new();
        for (i, swatch) in SWATCHES.iter().enumerate() {
            assert!(ids.insert(swatch.id), "duplicate {}", swatch.id);
            assert!(swatch_by_id(swatch.id).is_some());
            let wid = WID_BASE + 1 + i as u16;
            assert!(wid > WID_BASE);
            assert!(wid < 0x6830);
        }
        assert!(swatch_by_id("nope").is_none());
    }
}
