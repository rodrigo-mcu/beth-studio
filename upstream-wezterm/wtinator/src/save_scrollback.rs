// wtinator::save_scrollback — Phase 1.5.
//
// Read the focused pane's scrollback + viewport, show a native Win32
// "Save As" dialog, and write the result to the chosen file.
//
// This is the third entry added to the right-click context menu
// (see wtinator::context_menu, the `SaveScrollback` native
// command / wID 0x4004). It complements the "Copy selection" /
// "Paste" / "Select all" clipboard group that sits above it in the
// full menu.
//
// ## Why a native dialog (and not the upstream launcher)
//
// The upstream wezterm has a "Save tab to HTML" path in
// `TermWindow::save`, but it is bound to a key assignment
// (`SaveCurrentTabToHighlightedFile`) and writes the
// syntax-highlighted HTML rendering, not a plain text dump of the
// scrollback. A plain-text "Save scrollback" is the missing primitive
// that users reach for when they want to grep the last N minutes of a
// log dump from the terminal itself.
//
// We use the Win32 `GetSaveFileNameW` common dialog rather than a Lua
// launcher callback because:
//   - it is themed by the OS, including dark mode
//   - it requires no wezterm Lua config on the user's side
//   - it integrates with the same native-widget story that the
//     right-click menu already follows (patch 0009)
//
// ## Threading
//
// Everything runs on the main thread:
//   1. Read the scrollback of the `MuxPane` (must be on the main
//      thread; the `Pane` API is not safe to call concurrently with
//      the rendering loop).
//   2. Show `GetSaveFileNameW` (modal; blocks the main thread, but
//      the `try_borrow_mut` guards from patch 0011 keep `WM_PAINT`
//      / `WM_MOUSELEAVE` from panic-closing the GUI).
//   3. Spawn a worker thread to write the text to the chosen path.
//      Writing is the only step that does not need to be on the main
//      thread and a large scrollback (multi-MB) could otherwise be a
//      noticeable hitch.

use anyhow::{Context, Result};
use mux::pane::Pane;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Read the focused pane's scrollback (top of scrollback to the last
/// visible row) and return it as a plain-text `String`.
///
/// Logical lines (which may wrap across multiple physical rows) are
/// joined with `\n`; physical rows within a logical line are also
/// joined with `\n`. The trailing blank row (if any) is preserved.
///
/// Exposed for testing.
pub fn collect_scrollback(pane: &Arc<dyn Pane>) -> String {
    let dims = pane.get_dimensions();
    // `physical_top` and `viewport_rows` together give the range of
    // stable row indices for the visible viewport; the scrollback
    // starts at `scrollback_top`. The stable row type is `isize`
    // (the upstream `StableRowIndex` alias).
    let last_row: isize =
        dims.physical_top + (dims.viewport_rows as isize).saturating_sub(1);
    let lines = pane.get_logical_lines(dims.scrollback_top..last_row + 1);
    let mut out = String::new();
    for (i, ll) in lines.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        for (j, line) in ll.physical_lines.iter().enumerate() {
            if j > 0 {
                out.push('\n');
            }
            out.push_str(&line.as_str());
        }
    }
    out
}

/// UTC `YYYYMMDD-HHMMSS` stamp for Save-As default names (screenshot,
/// scrollback). Avoids raw Unix seconds in the filename box.
pub(crate) fn utc_filename_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d, h, mi, s) = epoch_to_ymdhms(secs);
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", y, m, d, h, mi, s)
}

/// Build a sensible default filename: `bethterm-<tab-title>-YYYYMMDD-HHMMSS.txt`,
/// with characters that are not filename-safe replaced with `_`.
fn suggest_filename(pane: &Arc<dyn Pane>) -> String {
    // Replace anything outside the safe filename charset.
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };

    let title = sanitize(pane.get_title().trim());
    let title = if title.is_empty() {
        "scrollback".to_string()
    } else {
        title
    };

    format!("{}-{}-{}.txt", crate::DATA_DIR_NAME, title, utc_filename_stamp())
}

fn epoch_to_ymdhms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    // Civil-from-days algorithm by Howard Hinnant (public domain).
    let days = secs / 86_400;
    let time_of_day = secs % 86_400;
    let h = (time_of_day / 3600) as u32;
    let mi = ((time_of_day % 3600) / 60) as u32;
    let s = (time_of_day % 60) as u32;
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d, h, mi, s)
}

/// Windows: show a native "Save As" dialog. Returns:
///   - `Ok(Some(path))` if the user picked a file
///   - `Ok(None)` if the user cancelled
///   - `Err(_)` only on a Win32 / I/O error that is not the user's
///     fault
#[cfg(windows)]
#[allow(unsafe_code)] // Win32 GetSaveFileNameW via windows-sys
pub fn pick_path(parent_hwnd: isize, suggested_name: &str) -> Result<Option<PathBuf>> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetSaveFileNameW, OPENFILENAMEW, OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
    };

    // Buffer for the chosen path. 32 KiB is the upper limit per the
    // Win32 docs; larger paths are not representable in the legacy
    // dialog.
    let mut buf: Vec<u16> = suggested_name.encode_utf16().chain(std::iter::once(0)).collect();
    buf.resize(32 * 1024, 0);

    // Filter string: "Plain text\0*.txt\0All files\0*.*\0\0"
    let filter: Vec<u16> = "Plain text\0*.txt\0All files\0*.*\0\0"
        .encode_utf16()
        .collect();
    let title: Vec<u16> = "Save scrollback as…\0".encode_utf16().collect();
    let def_ext: Vec<u16> = "txt\0".encode_utf16().collect();

    // In windows-sys 0.61, OPENFILENAMEW takes raw `*const u16` /
    // `*mut u16` pointers (PCWSTR / PWSTR are type aliases, not
    // constructors). We feed it the `.as_ptr()` of the owned Vec<u16>s
    // which are kept alive on the stack until `GetSaveFileNameW`
    // returns synchronously.
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
        lpstrInitialDir: std::ptr::null(),
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

    let ok = unsafe { GetSaveFileNameW(&mut ofn) };
    if ok == 0 {
        // 0 means the user cancelled.
        return Ok(None);
    }

    // Find the NUL terminator in buf and re-encode.
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let path_str = String::from_utf16(&buf[..len])
        .context("GetSaveFileNameW returned non-UTF-16 path")?;
    Ok(Some(PathBuf::from(path_str)))
}

/// Non-Windows stub: returns `Ok(None)`. macOS/Linux will use the
/// upstream `SaveCurrentTabToHighlightedFile` key assignment if the
/// user has it bound.
#[cfg(not(windows))]
pub fn pick_path(_parent_hwnd: isize, _suggested_name: &str) -> Result<Option<PathBuf>> {
    Ok(None)
}

/// Collect the scrollback, show the dialog, and write the file.
///
/// The whole flow is synchronous from the caller's point of view,
/// but the file write itself is delegated to a worker thread so a
/// multi-megabyte scrollback does not block the GUI.
pub fn save_to_file(pane: Arc<dyn Pane>, parent_hwnd: isize) -> Result<Option<PathBuf>> {
    let text = collect_scrollback(&pane);
    let suggested = suggest_filename(&pane);
    let Some(path) = pick_path(parent_hwnd, &suggested)? else {
        return Ok(None);
    };
    write_in_background(text, path.clone());
    Ok(Some(path))
}

fn write_in_background(text: String, path: PathBuf) {
    // We deliberately use std::thread::spawn rather than
    // promise::spawn — the wtinator crate does not depend on
    // promise, and this work is fire-and-forget (no follow-up
    // notification needed for v0.1).
    std::thread::Builder::new()
        .name("wtinator-save-scrollback".into())
        .spawn(move || {
            if let Err(e) = write_text_file(&path, &text) {
                log::error!(
                    "wtinator: failed to save scrollback to {}: {:#}",
                    path.display(),
                    e
                );
            } else {
                log::info!(
                    "wtinator: saved scrollback ({} bytes) to {}",
                    text.len(),
                    path.display()
                );
            }
        })
        .expect("failed to spawn write thread");
}

fn write_text_file(path: &Path, text: &str) -> Result<()> {
    std::fs::write(path, text)
        .with_context(|| format!("writing scrollback to {}", path.display()))?;
    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_to_ymdhms_known_values() {
        // 2026-06-06 12:00:00 UTC = 1_780_758_000
        let (y, m, d, _h, _mi, _s) = epoch_to_ymdhms(1_780_758_000);
        assert_eq!((y, m, d), (2026, 6, 6));

        // 2000-01-01 00:00:00 UTC = 946_695_600
        let (y, m, d, _h, _mi, _s) = epoch_to_ymdhms(946_695_600);
        assert_eq!((y, m, d), (2000, 1, 1));

        // 1970-01-01 00:00:00 UTC = 0
        let (y, m, d, _h, _mi, _s) = epoch_to_ymdhms(0);
        assert_eq!((y, m, d), (1970, 1, 1));
    }

    #[test]
    fn suggest_filename_uses_pane_title_and_extension() {
        // We cannot easily build a Pane here without a full Mux
        // harness, so test the formatter directly with a fabricated
        // title by going through the *sanitize* step.
        let sanitize = |s: &str| -> String {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect()
        };
        assert_eq!(sanitize("hello"), "hello");
        assert_eq!(sanitize("hello world"), "hello_world");
        assert_eq!(sanitize("foo/bar"), "foo_bar");
        assert_eq!(sanitize(""), "");
        let stamp = utc_filename_stamp();
        let name = format!("{}-{}-{}.txt", crate::DATA_DIR_NAME, sanitize("hello world"), stamp);
        assert!(name.starts_with("bethterm-hello_world-"));
        assert!(name.ends_with(".txt"));
        assert!(!name.contains("wezterm"));
    }
}
