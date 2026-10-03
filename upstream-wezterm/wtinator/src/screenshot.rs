// wtinator::screenshot — Phase 2.4 (patch 0025).
//
// Capture the rendered client area of a wezterm window as a
// bitmap and emit it as JPEG to disk or to the Windows
// clipboard. The capture uses the Win32 `PrintWindow` API
// (`PW_RENDERFULLCONTENT` flag, which captures even layered
// / non-default rendered windows). This is the same API that
// PowerToys and other screenshot utilities use; it works for
// the wezterminator because the wezterm renderer draws via
// OpenGL inside a normal WS_POPUP window, so PrintWindow +
// BitBlt into a memory DC is sufficient to read the pixels.
//
// ## Why `PrintWindow` and not a renderer hook
//
// The wezterm GUI renders via glium + WebGPU; the framebuffer
// is double-buffered and there is no public "render to
// bitmap" hook. The cleanest way to grab the visible pixels
// is to ask the OS to do it for us. `PrintWindow` sends a
// `WM_PRINT` message to the target, which the wezterm
// renderer handles (the upstream windows module installs
// the message hook for this very purpose).
//
// ## Why no Skia or wezterm-font dep
//
// We only convert `BITMAPINFO` RGBA to a plain `Vec<u8>` and
// hand it to the `image` crate for JPEG encoding. No glyph
// rendering, no atlas upload, no font metrics. The cost is
// the same as taking a screenshot with Snipping Tool.
//
// ## Threading
//
// The whole flow runs on the main thread (the right-click
// handler already runs on the main thread per patch 0010).
// `PrintWindow` is a fast blocking call (a few ms for a
// 1080p window). JPEG encoding is the slowest part at
// 30-100ms for a full-screen capture, but it is also
// short and the menu stays responsive because we return
// from the click handler before the next event-loop tick.

#![cfg(windows)]
#![allow(unsafe_code)]

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
// `PrintWindow` lives in the XPS storage module of windows-sys
// 0.61 (because the function is documented in the same
// Win32 header as the rest of the XPS print pipeline).
use windows_sys::Win32::Storage::Xps::PrintWindow;

/// What to do with the captured bitmap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenshotDestination {
    /// Encode as JPEG and write to a file at the given path.
    /// The path's extension does not need to be `.jpg`; the
    /// encoder writes JPEG bytes regardless.
    SaveJpegToFile(std::path::PathBuf),
    /// Encode as JPEG, then hand the JPEG bytes to the
    /// caller (typically the dispatcher in `mouseevent.rs`
    /// for the "Copy to clipboard" menu entry).
    ReturnJpegBytes,
}

/// Result of a successful capture.
pub enum ScreenshotResult {
    /// JPEG bytes ready to write to a file or hand to the
    /// clipboard.
    Jpeg(Vec<u8>),
    /// The user cancelled the save dialog (when
    /// `ScreenshotDestination::SaveJpegToFile` is used via
    /// a `GetSaveFileNameW` dialog and the user dismisses).
    Cancelled,
}

/// Capture the client area of `hwnd` as JPEG bytes. The
/// caller is responsible for choosing what to do with the
/// resulting `Vec<u8>` (write to file, copy to clipboard, ...).
///
/// `hwnd` is the raw Win32 HWND obtained from
/// `Window::hwnd()` (patch 0025's new accessor on the
/// `window` crate).
///
/// `quality` is the JPEG quality 1..=100; 85 is a sensible
/// default for terminal captures.
pub fn capture_to_jpeg(hwnd: HWND, quality: u8) -> Result<Vec<u8>> {
    capture_to_jpeg_impl(hwnd, quality)
}

/// Capture `hwnd`, ask the user for a `.jpg` file path, and write
/// the JPEG bytes in the background. Returns `Ok(None)` when the
/// user cancels the native dialog.
pub fn save_jpeg_with_dialog(hwnd: HWND, parent_hwnd: isize) -> Result<Option<PathBuf>> {
    if hwnd.is_null() {
        anyhow::bail!("screenshot::save_jpeg_with_dialog: hwnd is null");
    }
    let Some(path) = pick_jpeg_path(parent_hwnd, &suggest_filename())? else {
        return Ok(None);
    };
    let jpeg = capture_to_jpeg(hwnd, 85)?;
    write_in_background(jpeg, path.clone());
    Ok(Some(path))
}

/// Capture `hwnd` and copy the bitmap to the Windows clipboard as
/// `CF_DIB`. This is more widely accepted than a custom JPEG
/// clipboard format.
pub fn copy_to_clipboard(hwnd: HWND) -> Result<()> {
    if hwnd.is_null() {
        anyhow::bail!("screenshot::copy_to_clipboard: hwnd is null");
    }
    let (width, height) = query_client_size(hwnd)?;
    let rgba = render_window_to_rgba(hwnd, width, height)?;
    let dib = rgba_to_cf_dib(&rgba, width as u32, height as u32);
    set_clipboard_dib(&dib)
}

fn capture_to_jpeg_impl(hwnd: HWND, quality: u8) -> Result<Vec<u8>> {
    if hwnd.is_null() {
        anyhow::bail!("screenshot::capture_to_jpeg: hwnd is null");
    }

    // Step 1: get the window's client area dimensions.
    let (width, height) = query_client_size(hwnd)?;

    // Step 2: build a memory DC + bitmap, PrintWindow into
    // it, and extract the bits.
    let pixels = render_window_to_rgba(hwnd, width, height)?;

    // Step 3: JPEG-encode the RGBA buffer.
    encode_rgba_to_jpeg(pixels, width, height, quality)
}

/// Query the dimensions of the window's client area. Returns
/// `(width, height)` in pixels.
fn query_client_size(hwnd: HWND) -> Result<(i32, i32)> {
    let mut client_rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut client_rect)
    };
    if ok == 0 {
        anyhow::bail!("GetClientRect returned 0");
    }
    let width = (client_rect.right - client_rect.left).max(1);
    let height = (client_rect.bottom - client_rect.top).max(1);
    Ok((width, height))
}

/// Draw `hwnd` into a fresh memory DC and return the bitmap
/// bits as a 32-bpp RGBA buffer of length `width * height * 4`
/// (in top-down row order). Caller owns the buffer; this
/// function releases all GDI handles before returning.
fn render_window_to_rgba(hwnd: HWND, width: i32, height: i32) -> Result<Vec<u8>> {
    // `PW_RENDERFULLCONTENT` is the documented flag for
    // capturing layered / DWM-composed windows on Windows
    // 8.1+. We OR it in unconditionally because the wezterm
    // rendering pipeline benefits from the full-composition
    // path.
    const PW_RENDERFULLCONTENT: u32 = 0x02;
    let screen = unsafe { GetDC(std::ptr::null_mut()) };
    if screen.is_null() {
        anyhow::bail!("GetDC returned NULL");
    }
    let mem_dc = unsafe { CreateCompatibleDC(screen) };
    if mem_dc.is_null() {
        unsafe { ReleaseDC(std::ptr::null_mut(), screen) };
        anyhow::bail!("CreateCompatibleDC returned NULL");
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen, width, height) };
    if bitmap.is_null() {
        unsafe {
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        anyhow::bail!("CreateCompatibleBitmap returned NULL");
    }
    let prev = unsafe { SelectObject(mem_dc, bitmap as windows_sys::Win32::Foundation::HANDLE) };
    if prev.is_null() {
        unsafe {
            DeleteObject(bitmap as windows_sys::Win32::Foundation::HANDLE);
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        anyhow::bail!("SelectObject returned NULL");
    }

    // The PrintWindow call itself.
    let pw_result = unsafe { PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT) };
    if pw_result == 0 {
        // Fall back to a plain BitBlt from the screen DC
        // (works for visible top-level windows).
        let mut window_rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let rect_ok = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut window_rect)
        };
        if rect_ok == 0 {
            unsafe {
                SelectObject(mem_dc, prev);
                DeleteObject(bitmap as windows_sys::Win32::Foundation::HANDLE);
                DeleteDC(mem_dc);
                ReleaseDC(std::ptr::null_mut(), screen);
            }
            anyhow::bail!("PrintWindow failed and GetWindowRect returned 0");
        }
        let srccopy = SRCCOPY as u32;
        let ok = unsafe {
            BitBlt(
                mem_dc,
                0,
                0,
                width,
                height,
                screen,
                window_rect.left,
                window_rect.top,
                srccopy,
            )
        };
        if ok == 0 {
            unsafe {
                SelectObject(mem_dc, prev);
                DeleteObject(bitmap as windows_sys::Win32::Foundation::HANDLE);
                DeleteDC(mem_dc);
                ReleaseDC(std::ptr::null_mut(), screen);
            }
            anyhow::bail!("PrintWindow and BitBlt both failed");
        }
    }

    // Step 3: extract the bitmap bits as 32-bpp BGRA via
    // GetDIBits. We use the top-down DIB (negative
    // `biHeight`) so row 0 is the top of the image; the bytes
    // are in BGRA order. We swap the B and R channels below
    // to produce a true RGBA buffer.
    let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let stride = (width as usize) * 4;
    let mut pixels: Vec<u8> = vec![0; stride * height as usize];
    let scanlines = unsafe {
        GetDIBits(
            mem_dc,
            bitmap as windows_sys::Win32::Foundation::HANDLE,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    if scanlines == 0 {
        unsafe {
            SelectObject(mem_dc, prev);
            DeleteObject(bitmap as windows_sys::Win32::Foundation::HANDLE);
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        anyhow::bail!("GetDIBits returned 0 scanlines");
    }

    // BGRA -> RGBA.
    for chunk in pixels.chunks_exact_mut(4) {
        let b = chunk[0];
        let r = chunk[2];
        chunk[0] = r;
        chunk[2] = b;
        chunk[3] = 0xFF;
    }

    // Cleanup the GDI handles.
    unsafe {
        SelectObject(mem_dc, prev);
        DeleteObject(bitmap as windows_sys::Win32::Foundation::HANDLE);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen);
    }

    Ok(pixels)
}

fn rgba_to_cf_dib(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let stride = (width as usize) * 4;
    let mut out = Vec::with_capacity(40 + stride * height as usize);
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    // Negative height means top-down DIB, matching the RGBA buffer.
    out.extend_from_slice(&(-(height as i32)).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&BI_RGB.to_le_bytes());
    out.extend_from_slice(&((stride * height as usize) as u32).to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    for chunk in rgba.chunks_exact(4) {
        out.push(chunk[2]);
        out.push(chunk[1]);
        out.push(chunk[0]);
        out.push(chunk[3]);
    }
    out
}

#[allow(unsafe_code)]
fn set_clipboard_dib(dib: &[u8]) -> Result<()> {
    let opened = unsafe { OpenClipboard(std::ptr::null_mut()) };
    if opened == 0 {
        anyhow::bail!("OpenClipboard failed");
    }

    let result = (|| -> Result<()> {
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, dib.len()) };
        if handle.is_null() {
            anyhow::bail!("GlobalAlloc failed");
        }
        let ptr = unsafe { GlobalLock(handle) };
        if ptr.is_null() {
            anyhow::bail!("GlobalLock failed");
        }
        unsafe {
            std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr as *mut u8, dib.len());
            let _ = GlobalUnlock(handle);
        }

        unsafe {
            if EmptyClipboard() == 0 {
                anyhow::bail!("EmptyClipboard failed");
            }
            const CF_DIB: u32 = 8;
            if SetClipboardData(CF_DIB, handle).is_null() {
                anyhow::bail!("SetClipboardData(CF_DIB) failed");
            }
        }
        Ok(())
    })();

    unsafe {
        CloseClipboard();
    }
    result
}

fn default_pictures_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    let pictures = PathBuf::from(home).join("Pictures");
    pictures.is_dir().then_some(pictures)
}

fn format_screenshot_filename(stamp: &str) -> String {
    format!("{}-screenshot-{}.jpg", crate::DATA_DIR_NAME, stamp)
}

fn suggest_filename() -> String {
    format_screenshot_filename(&crate::save_scrollback::utc_filename_stamp())
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn pick_jpeg_path(parent_hwnd: isize, suggested_name: &str) -> Result<Option<PathBuf>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OPENFILENAMEW,
    };

    let mut buf: Vec<u16> = suggested_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    buf.resize(32 * 1024, 0);
    let filter: Vec<u16> = "JPEG image\0*.jpg;*.jpeg\0All files\0*.*\0\0"
        .encode_utf16()
        .collect();
    let title: Vec<u16> = "Save screenshot as JPEG\0".encode_utf16().collect();
    let def_ext: Vec<u16> = "jpg\0".encode_utf16().collect();
    let initial_dir_w: Option<Vec<u16>> = default_pictures_dir().map(|p| {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    });

    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: parent_hwnd as HWND,
        hInstance: std::ptr::null_mut(),
        lpstrFilter: filter.as_ptr(),
        lpstrCustomFilter: std::ptr::null_mut(),
        nMaxCustFilter: 0,
        nFilterIndex: 1,
        lpstrFile: buf.as_mut_ptr(),
        nMaxFile: buf.len() as u32,
        lpstrFileTitle: std::ptr::null_mut(),
        nMaxFileTitle: 0,
        lpstrInitialDir: initial_dir_w
            .as_ref()
            .map(|v| v.as_ptr())
            .unwrap_or(std::ptr::null()),
        lpstrTitle: title.as_ptr(),
        Flags: OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR,
        nFileOffset: 0,
        nFileExtension: 0,
        lpstrDefExt: def_ext.as_ptr(),
        lCustData: 0,
        lpfnHook: None,
        lpTemplateName: std::ptr::null(),
        pvReserved: std::ptr::null_mut(),
        dwReserved: 0,
        FlagsEx: 0,
    };

    if unsafe { GetSaveFileNameW(&mut ofn) } == 0 {
        return Ok(None);
    }

    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let path_str =
        String::from_utf16(&buf[..len]).context("GetSaveFileNameW returned non-UTF-16 path")?;
    Ok(Some(PathBuf::from(path_str)))
}

fn write_in_background(bytes: Vec<u8>, path: PathBuf) {
    std::thread::Builder::new()
        .name("wtinator-save-screenshot".into())
        .spawn(move || {
            if let Err(e) = write_binary_file(&path, &bytes) {
                log::error!(
                    "wtinator: failed to save screenshot to {}: {:#}",
                    path.display(),
                    e
                );
            } else {
                log::info!(
                    "wtinator: saved screenshot ({} bytes) to {}",
                    bytes.len(),
                    path.display()
                );
            }
        })
        .expect("failed to spawn screenshot write thread");
}

fn write_binary_file(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)
        .with_context(|| format!("writing screenshot to {}", path.display()))?;
    Ok(())
}

/// Encode the RGBA buffer as JPEG bytes.
fn encode_rgba_to_jpeg(pixels: Vec<u8>, width: i32, height: i32, quality: u8) -> Result<Vec<u8>> {
    let img = image::RgbaImage::from_raw(width as u32, height as u32, pixels)
        .context("creating RgbaImage from screenshot")?;
    let mut jpeg_bytes: Vec<u8> = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut jpeg_bytes,
            quality.clamp(1, 100),
        );
        encoder
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .context("encoding JPEG")?;
    }
    Ok(jpeg_bytes)
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_to_jpeg_with_null_hwnd_errors() {
        // A null HWND must produce a clean error rather than
        // crashing the GUI.
        let result = capture_to_jpeg(std::ptr::null_mut(), 85);
        assert!(result.is_err());
    }

    #[test]
    fn rgba_to_cf_dib_writes_top_down_bgra() {
        let dib = rgba_to_cf_dib(&[0x33, 0x22, 0x11, 0x44], 1, 1);
        assert_eq!(&dib[0..4], &40u32.to_le_bytes());
        assert_eq!(&dib[4..8], &1i32.to_le_bytes());
        assert_eq!(&dib[8..12], &(-1i32).to_le_bytes());
        assert_eq!(&dib[40..44], &[0x11, 0x22, 0x33, 0x44]);
    }

    #[test]
    fn screenshot_filename_is_bethterm_with_civil_stamp() {
        let name = format_screenshot_filename("20260906-142738");
        assert_eq!(name, "bethterm-screenshot-20260906-142738.jpg");
        assert!(!name.contains("wezterm"));
        let live = suggest_filename();
        assert!(
            live.starts_with("bethterm-screenshot-") && live.ends_with(".jpg"),
            "{live}"
        );
        let stamp = live
            .trim_start_matches("bethterm-screenshot-")
            .trim_end_matches(".jpg");
        assert_eq!(stamp.len(), 15, "{live}");
        assert_eq!(stamp.as_bytes()[8], b'-');
        assert!(stamp.chars().all(|c| c.is_ascii_digit() || c == '-'), "{live}");
    }
}
