// wtinator::header::win32_prompt — Phase 1.E (patch 0030).
//
// The Win32 input dialog for the per-terminal header
// rename. This module is the **only** place in the
// `wtinator` crate that uses `unsafe` — it wraps the
// hand-rolled `CreateWindowExW` + `EDIT` + button
// dialog. The crate-level `#![deny(unsafe_code)]` is
// relaxed to `allow` only for this file so the rest of
// the delta stays safe-by-default.
//
// The dialog flow:
// 1. Register a window class with a custom `wndproc`.
// 2. Open a top-level popup centered on the parent HWND
//    (or 100,100 if no parent).
// 3. Add an `EDIT` child control, prefilled with the
//    current header text, plus OK and Cancel buttons.
// 4. Run a local message loop until the user picks
//    OK (commit) or Cancel/Esc (abort) or closes the
//    window (abort).
// 5. Return the user's input through a `thread_local!`
//    stashed by the `wndproc`.

#![allow(unsafe_code)]

// -----------------------------------------------------------------------
// Module-level state
// -----------------------------------------------------------------------

/// `OnceLock` guard around the `RegisterClassExW` call.
/// The window class is registered exactly once for the
/// process lifetime; the `wndproc` callback needs to
/// outlive any single `run` call, so it lives at the
/// module level rather than inside `run` (where it would
/// be a fresh closure on every invocation and could not
/// be referenced from the `WNDCLASSEXW::lpfnWndProc`
/// field).
static CLASS_REGISTERED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

/// Register the dialog window class exactly once for
/// the process lifetime. `RegisterClassExW` returns 0
/// if the class is already registered — the pre-2026-06-08
/// check treated that as "registration failed → abort",
/// which made the second `Rename terminal…` click do
/// nothing. `OnceLock` makes the first call register;
/// subsequent calls hit the cached `Ok(())` and no-op.
fn register_window_class_once() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::WNDCLASSEXW;

    CLASS_REGISTERED.get_or_init(|| {
        let class_name: Vec<u16> = std::ffi::OsStr::new("WtinatorHeaderPrompt")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: std::ptr::null_mut(),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            // WezTerminator (patch 0050): match the dialog background to
            // the controls' background (`dialog_brush`) so there is no
            // faint colour-mismatch box around the static label / edit.
            hbrBackground: dialog_brush(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        // `RegisterClassExW` will return 0 if the class
        // already exists; that is fine here because
        // `OnceLock` guarantees we only call it once per
        // process. We deliberately do not check the
        // return value — there is nothing useful to do
        // on failure (the only way to recover would be
        // to prompt the user to restart the app, and
        // the user would just hit "Rename" again).
        let _ = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::RegisterClassExW(&wc)
        };
    });
}

/// Encode the dialog window class name as a
/// null-terminated UTF-16 vector. Lives at module
/// level (rather than inside `run`) so the lifetime
/// matches the static `CLASS_REGISTERED` guard.
fn class_name_wide() -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new("WtinatorHeaderPrompt")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Lazily-create the off-white background brush used
/// by `WM_CTLCOLOREDIT` / `WM_CTLCOLORSTATIC` /
/// `WM_CTLCOLORBTN`. The brush is owned by the OS and
/// lives for the process lifetime; we do not call
/// `DeleteObject` on it.
///
/// Note: `HBRUSH` is a `*mut c_void` newtype that is
/// NOT `Send + Sync`, so it cannot be stored directly
/// in a `OnceLock<HBRUSH>`. We store the handle as
/// a raw `usize` and cast back to `HBRUSH` at the
/// call site. The handle is a process-wide OS
/// resource so the cast is safe even though the
/// raw pointer type is not `Sync` per se.
fn dialog_brush() -> windows_sys::Win32::Graphics::Gdi::HBRUSH {
    use windows_sys::Win32::Graphics::Gdi::{CreateSolidBrush, HBRUSH};

    let raw = *DIALOG_BRUSH.get_or_init(|| unsafe {
        CreateSolidBrush(rgb(250, 250, 250)) as usize
    });
    raw as HBRUSH
}

fn edit_brush() -> windows_sys::Win32::Graphics::Gdi::HBRUSH {
    use windows_sys::Win32::Graphics::Gdi::{CreateSolidBrush, HBRUSH};

    let raw = *EDIT_BRUSH.get_or_init(|| unsafe {
        CreateSolidBrush(rgb(255, 255, 255)) as usize
    });
    raw as HBRUSH
}

static DIALOG_BRUSH: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
static EDIT_BRUSH: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

/// Build a `COLORREF` (0x00BBGGRR) from three 8-bit
/// RGB values. The `RGB` macro is a classic Win32
/// macro that the `windows-sys` crate does not expose,
/// so we provide a thin inline equivalent. The returned
/// value is what `SetTextColor` / `SetBkColor` /
/// `CreateSolidBrush` expect.
const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (b as u32) << 16 | (g as u32) << 8 | r as u32
}

/// Lazily-create the Segoe UI 9pt font used for every
/// control in the dialog. The font handle is cached
/// for the process lifetime; we do not call
/// `DeleteObject` on it. Stored as `usize` for the
/// same `Send + Sync` reason as `DIALOG_BRUSH` above.
fn dialog_font() -> windows_sys::Win32::Graphics::Gdi::HFONT {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateFontW, FW_NORMAL, HFONT, OUT_DEFAULT_PRECIS, FF_DONTCARE,
    };

    let raw = *FONT.get_or_init(|| unsafe {
        // Negative `nHeight` means "use points". The
        // `lfFaceName` is set to "Segoe UI" which is
        // the standard Windows UI font on Win10/11; on
        // older Windows it falls back to Tahoma /
        // MS Sans Serif via the font substitution
        // table. `FW_NORMAL` weight + the default
        // precision values are the standard modern-UI
        // combination.
        CreateFontW(
            -16, // 10pt Segoe UI: clearer, modern dialog typography
            0, // width (auto)
            0, // escapement
            0, // orientation
            FW_NORMAL as i32,
            0, // italic off
            0, // underline off
            0, // strikeout off
            0, // default charset
            OUT_DEFAULT_PRECIS as u32,
            0, // clip precision
            0, // quality (default = whatever Windows picks)
            FF_DONTCARE as u32,
            windows_sys::w!("Segoe UI"),
        ) as usize
    });
    raw as HFONT
}

static FONT: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

/// The dialog's window procedure. Lives at module level
/// (not nested inside `run`) so the function pointer is
/// stable across calls and `WNDCLASSEXW::lpfnWndProc`
/// can reference it.
unsafe extern "system" fn wndproc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::Foundation::LRESULT;
    use windows_sys::Win32::Graphics::Gdi::{SetBkColor, SetTextColor};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, DestroyWindow, GetDlgItem, GetWindowTextW, IDCANCEL, IDOK, PostQuitMessage,
        WM_CLOSE, WM_COMMAND, WM_CTLCOLORBTN, WM_CTLCOLOREDIT, WM_CTLCOLORSTATIC, WM_DESTROY,
    };

    match msg {
        WM_COMMAND => {
            let id = (wparam & 0xffff) as i32;
            if id == IDOK {
                let edit = GetDlgItem(hwnd, 0x100);
                let mut buf = [0u16; 256];
                let n = unsafe { GetWindowTextW(edit, buf.as_mut_ptr(), buf.len() as i32) };
                let text = if n > 0 {
                    String::from_utf16_lossy(&buf[..n as usize])
                } else {
                    String::new()
                };
                let normalized = match super::normalize_header_text(&text) {
                    Ok(n) => n,
                    Err(_) => None,
                };
                write_result(Some(normalized));
                unsafe { DestroyWindow(hwnd) };
            } else if id == IDCANCEL {
                write_result(None);
                unsafe { DestroyWindow(hwnd) };
            }
            0
        }
        WM_CLOSE => {
            write_result(None);
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            0
        }
        // Styling: paint the EDIT, the static label,
        // and the buttons with a softer palette than
        // the Win32 defaults. The Win32 default EDIT is
        // a small white field with a heavy 3D sunken
        // border that looks out of place next to a
        // modern app; these three handlers swap the
        // background to a light off-white and the text
        // to a soft near-black. The brush is created
        // once in `dialog_brush()` (a `OnceLock`) and
        // shared across all `WM_CTLCOLOR*` calls — Win32
        // owns the brush for the lifetime of the
        // dialog, so we do not delete it.
        WM_CTLCOLOREDIT => {
            // Visual styles (Explorer theme + Windows dark mode) ignore
            // CTLCOLOR and can paint dark-on-dark. We disable the theme
            // on the EDIT and force opaque near-black ink on off-white.
            let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            unsafe {
                windows_sys::Win32::Graphics::Gdi::SetBkMode(
                    hdc,
                    windows_sys::Win32::Graphics::Gdi::OPAQUE as i32,
                );
                SetTextColor(hdc, rgb(20, 20, 20));
                SetBkColor(hdc, rgb(255, 255, 255));
            };
            return edit_brush() as isize as LRESULT;
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            unsafe { SetTextColor(hdc, rgb(96, 96, 96)) }; // #606060 label
            unsafe { SetBkColor(hdc, rgb(250, 250, 250)) };
            return dialog_brush() as isize as LRESULT;
        }
        WM_CTLCOLORBTN => {
            let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            unsafe { SetTextColor(hdc, rgb(31, 31, 31)) };
            unsafe { SetBkColor(hdc, rgb(250, 250, 250)) };
            return dialog_brush() as isize as LRESULT;
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

thread_local! {
    /// Stashed result of the last OK / Cancel click.
    /// Cleared on entry to `run` and read on exit. The
    /// `thread_local!` is required because the `wndproc`
    /// runs on the dialog thread and `run` needs to read
    /// the value from the same thread.
    static RESULT: std::cell::RefCell<Option<Option<String>>> =
        const { std::cell::RefCell::new(None) };
}

fn write_result(value: Option<Option<String>>) {
    RESULT.with(|r| *r.borrow_mut() = value);
}

fn read_and_clear_result() -> Option<Option<String>> {
    RESULT.with(|r| r.borrow_mut().take())
}

// -----------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------

#[cfg(windows)]
pub fn run(
    hwnd: isize,
    current: Option<&str>,
    title: &str,
    label: &str,
) -> Option<Option<String>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::UI::Controls::{SetWindowTheme, WC_BUTTON, WC_EDIT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BS_DEFPUSHBUTTON, CreateWindowExW, DispatchMessageW, ES_AUTOHSCROLL, GetClientRect,
        GetMessageW, IDCANCEL, IDOK, IsDialogMessageW, MSG, SendMessageW, SetDlgItemTextW,
        TranslateMessage, WM_SETFONT, WS_CAPTION, WS_CHILD, WS_EX_TOPMOST, WS_OVERLAPPED,
        WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
    };

    // Reset the result for this dialog run.
    write_result(None);

    // Register the window class exactly once for the
    // lifetime of the process (see `register_window_class_once`
    // for why this matters — the pre-2026-06-08 version
    // called `RegisterClassExW` on every `run` and the
    // second call returned 0, which we used to treat as
    // "failed → abort", silently killing the second
    // rename).
    register_window_class_once();

    let (mut x, mut y) = (100i32, 100i32);
    if hwnd != 0 {
        let mut r: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetClientRect(hwnd as HWND, &mut r) } != 0 {
            // Center the dialog on the parent window.
            // The dialog is 520×170; offset by half so
            // the center of the dialog aligns with the
            // center of the parent.
            let cx = ((r.right - r.left) / 2) - 260;
            let cy = ((r.bottom - r.top) / 2) - 75;
            x = if cx < 0 { 0 } else { cx };
            y = if cy < 0 { 0 } else { cy };
        }
    }

    // Dialog dimensions:
    // - width:  520 px (was 320 — the v1 dialog was
    //   wide enough only for short titles; 80-char
    //   headers were truncated to "…" by the EDIT
    //   control's display)
    // - height: 170 px (was 100 — the v1 dialog had
    //   no label and the buttons sat awkwardly below
    //   the EDIT)
    // The +5/+20 inset below the chrome compensates
    // for the non-client area (caption + frame) so
    // the EDIT and the buttons land where we want
    // them in the client area.
    // WezTerminator (patch 0050): tightened layout — the v2 dialog had a
    // ~42px dead gap between the edit and the buttons and excess height.
    const DIALOG_W: i32 = 520;
    const DIALOG_H: i32 = 184;
    const LABEL_X: i32 = 24;
    const LABEL_Y: i32 = 20;
    const LABEL_W: i32 = 300;
    const LABEL_H: i32 = 18;
    const EDIT_X: i32 = 24;
    const EDIT_Y: i32 = 48;
    const EDIT_W: i32 = 472; // DIALOG_W - 2*24
    const EDIT_H: i32 = 32;
    const BUTTON_W: i32 = 108;
    const BUTTON_H: i32 = 34;
    const BUTTON_Y: i32 = 106;
    const CANCEL_X: i32 = DIALOG_W - BUTTON_W - 24;
    const OK_X: i32 = CANCEL_X - BUTTON_W - 12;

    // WS_EX_DLGMODALFRAME = 0x00000001 — gives the
    // dialog a proper double-border modal frame so
    // it looks like a real dialog and not a generic
    // window. Hard-coded because the constant is not
    // exposed by the `windows-sys` crate version we
    // depend on.
    const WS_EX_DLGMODALFRAME: u32 = 0x0000_0001;
    // WS_EX_CLIENTEDGE = 0x00000200 — sunken 3D border
    // around the EDIT so it reads as an input field.
    const WS_EX_CLIENTEDGE: u32 = 0x0000_0200;

    // WezTerminator (patch 0035.2): the window title is now
    // caller-supplied so "Rename tab…" shows "Rename tab" and
    // "Rename terminal…" shows "Rename terminal" (previously
    // both showed the hardcoded "Rename terminal").
    let title_w: Vec<u16> = std::ffi::OsStr::new(title)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let hwnd_dlg = unsafe {
        let class_name = class_name_wide();
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_DLGMODALFRAME,
            class_name.as_ptr(),
            title_w.as_ptr(),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
            x,
            y,
            DIALOG_W,
            DIALOG_H,
            hwnd as HWND,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if hwnd_dlg.is_null() {
        return None;
    }

    let _ = POINT { x: 0, y: 0 }; // satisfy unused-import lint on older toolchains

    // Static label above the EDIT. We use the
    // standard "STATIC" window class (provided by
    // USER32) so we don't have to register a new
    // class for it. The label is caller-supplied so
    // "Rename window" can say "Nome da janela".
    let label_w: Vec<u16> = std::ffi::OsStr::new(label)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let _ = unsafe {
        CreateWindowExW(
            0,
            windows_sys::w!("STATIC"),
            label_w.as_ptr(),
            WS_CHILD | WS_VISIBLE,
            LABEL_X,
            LABEL_Y,
            LABEL_W,
            LABEL_H,
            hwnd_dlg,
            0x101 as _,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };

    let edit_hwnd = unsafe {
        CreateWindowExW(
            WS_EX_CLIENTEDGE,
            WC_EDIT,
            std::ptr::null(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | (ES_AUTOHSCROLL as u32),
            EDIT_X,
            EDIT_Y,
            EDIT_W,
            EDIT_H,
            hwnd_dlg,
            0x100 as _,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if let Some(cur) = current {
        let cur_w: Vec<u16> = std::ffi::OsStr::new(cur)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe { SetDlgItemTextW(hwnd_dlg, 0x100, cur_w.as_ptr()) };
    }
    let _ = edit_hwnd;

    // Apply a Segoe UI 9pt font (the standard Windows
    // UI font) to every control in the dialog. The
    // default Win32 font is a 8-pt MS Shell Dlg that
    // looks fuzzy and out of place next to a modern
    // app. We use `WM_SETFONT` to apply the font; the
    // `lparam` is `TRUE` to trigger an immediate
    // repaint. The font is created from
    // `dialog_font()` (a `OnceLock<HANDLE>`) so it
    // lives for the process lifetime.
    let font = dialog_font();
    unsafe {
        let _ = SendMessageW(
            hwnd_dlg,
            WM_SETFONT as u32,
            font as usize,
            1,
        );
        let _ = SendMessageW(edit_hwnd, WM_SETFONT as u32, font as usize, 1);
        // Use the current Windows visual style rather than the dated classic
        // common-control rendering for the text field and action buttons.
        // Empty theme so WM_CTLCOLOREDIT is honoured (Explorer + dark
        // mode otherwise paints a dark field with our dark ink).
        let _ = SetWindowTheme(edit_hwnd, windows_sys::w!(""), windows_sys::w!(""));
    }

    let save_button = unsafe {
        CreateWindowExW(
            0,
            WC_BUTTON,
            windows_sys::w!("Salvar"),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | (BS_DEFPUSHBUTTON as u32),
            OK_X,
            BUTTON_Y,
            BUTTON_W,
            BUTTON_H,
            hwnd_dlg,
            IDOK as _,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };

    let cancel_button = unsafe {
        CreateWindowExW(
            0,
            WC_BUTTON,
            windows_sys::w!("Cancelar"),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            CANCEL_X,
            BUTTON_Y,
            BUTTON_W,
            BUTTON_H,
            hwnd_dlg,
            IDCANCEL as _,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    unsafe {
        let _ = SendMessageW(save_button, WM_SETFONT as u32, font as usize, 1);
        let _ = SendMessageW(cancel_button, WM_SETFONT as u32, font as usize, 1);
        let _ = SetWindowTheme(save_button, windows_sys::w!("Explorer"), std::ptr::null());
        let _ = SetWindowTheme(cancel_button, windows_sys::w!("Explorer"), std::ptr::null());
    }

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {
        if unsafe { IsDialogMessageW(hwnd_dlg, &msg) } == 0 {
            unsafe { TranslateMessage(&msg) };
            unsafe { DispatchMessageW(&msg) };
        }
    }

    read_and_clear_result()
}

#[cfg(not(windows))]
pub fn run(
    _hwnd: isize,
    _current: Option<&str>,
    _title: &str,
    _label: &str,
) -> Option<Option<String>> {
    None
}
