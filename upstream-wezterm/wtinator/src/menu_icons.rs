// wtinator::menu_icons — Phase 1.8 (patch 0018).
//
// Render the right-click menu's small icons (16x16 RGBA bitmaps)
// using the Windows GDI API. Each icon is a flat monochrome
// silhouette drawn into a 16x16 32-bpp DIB section; the resulting
// `HBITMAP` is set as the `hbmpItem` field of `MENUITEMINFOW`
// so the OS draws it to the left of the menu item label.
//
// ## Why GDI (and not bundled PNGs or Skia)
//
//   - No new dependencies. `windows-sys` already has every GDI
//     primitive we need.
//   - The icons pick up the system menu colour automatically
//     (we read COLOR_MENUTEXT at render time), so dark mode
//     works without us doing anything.
//   - Drawing 18 icons with primitives is ~300 lines and ~0 KiB
//     of binary weight; bundling PNGs would cost several KiB per
//     icon and require a decode pass.
//
// ## Threading
//
// Icons are rendered lazily on the first call (which happens on
// the GUI thread inside `show_at`). The resulting `HBITMAP`
// handles are cached in a `Mutex<HashMap<MenuIconId, HBITMAP>>`
// and live for the process lifetime (16x16 32-bpp = 1 KiB
// per icon).

#![cfg(windows)]
// The crate-level `#![deny(unsafe_code)]` does not apply to the
// Windows-only drawing code; this module needs Win32 calls.
#![allow(unsafe_code)]

use std::collections::HashMap;
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{COLORREF, HANDLE};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateCompatibleBitmap, CreatePen, CreateSolidBrush, DeleteDC,
    DeleteObject, Ellipse, GetDC, GetSysColor, LineTo, MoveToEx, Rectangle, RoundRect,
    SelectObject, SetBkMode, SetDCBrushColor, SetDCPenColor, SetTextColor, PS_SOLID,
    TRANSPARENT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXMENUCHECK, SM_CYMENUCHECK};

/// Identifies a small icon drawn next to a menu item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MenuIconId {
    // Shells
    Cmd,
    PowerShell,
    PowerShell7,
    WslDefault,
    WslUbuntu,
    GitBash,
    // Clipboard / content
    Copy,
    Paste,
    SelectAll,
    SaveScrollback,
    // Layout
    SplitRight,
    SplitDown,
    ClosePane,
    // Theme
    ThemePaint,
    OpenFolder,
    ThemeVscodeLight,
    ThemeVscodeDark,
    ThemeWindowsTerminal,
    // WezTerminator (patch 0022): right-click "Paste image"
    // entry icon. Drawn as a small "landscape" silhouette
    // (mountain + sun) to evoke the photo metaphor.
    PasteImage,
    // WezTerminator (patch 0031): right-click "Rename tab…"
    // entry icon. Drawn as a small tab silhouette with a
    // diagonal pencil mark to evoke the rename metaphor.
    RenameTab,
    // WezTerminator (patch 0039): "Font size" submenu icon —
    // a blocky capital "A" to evoke text/font sizing.
    FontSize,
}

/// `HBITMAP` is a raw pointer (`*mut c_void`) which is not
/// `Send` by default. We never move the handle between threads
/// (it is always rendered and consumed on the GUI thread), so we
/// store the handle as an `isize` (which IS `Send`) and convert
/// back to the raw pointer at the call site.
type RawHandle = isize;

static ICON_CACHE: Mutex<Option<HashMap<MenuIconId, RawHandle>>> = Mutex::new(None);

/// Return the cached `HBITMAP` for `id`, rendering it on the
/// first call. Returns `None` on a render failure (in which case
/// the caller emits the item without an icon).
pub fn handle(id: MenuIconId) -> Option<RawHandle> {
    let mut guard = ICON_CACHE.lock().ok()?;
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    let cache = guard.as_mut().unwrap();
    if let Some(&h) = cache.get(&id) {
        return Some(h);
    }
    let h = render(id)?;
    cache.insert(id, h);
    Some(h)
}

fn render(id: MenuIconId) -> Option<RawHandle> {
    render_impl(id)
}

#[allow(unused_assignments)]
fn render_impl(id: MenuIconId) -> Option<RawHandle> {
    // The whole body is `unsafe` because we call Win32 GDI
    // functions. We wrap the body in a single `unsafe { }`
    // block; the `draw_*` helpers below are also `unsafe { }`
    // blocks for the same reason.
    render_unsafe(id)
}

fn render_unsafe(id: MenuIconId) -> Option<RawHandle> {
    // The whole body is `unsafe` because we call Win32 GDI
    // functions. We wrap the body in a single `unsafe { }`
    // block; the `draw_*` helpers below are also wrapped in
    // `unsafe { }` blocks for the same reason.
    unsafe {
        let fg = GetSysColor(13 /* COLOR_MENUTEXT */);
        let bg = GetSysColor(4 /* COLOR_MENU */);

        // Use the system's standard small-icon size (16 on most
        // DPI settings; 20 on high-DPI displays). Reading the actual
        // metrics keeps the icons crisp without hardcoding 16.
        let w = GetSystemMetrics(SM_CXMENUCHECK).max(16);
        let h = GetSystemMetrics(SM_CYMENUCHECK).max(16);

        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return None;
        }
        let mem_h = CreateCompatibleDC(screen);
        if mem_h.is_null() {
            return None;
        }
        let bmp = CreateCompatibleBitmap(screen, w, h);
        if bmp.is_null() {
            DeleteDC(mem_h);
            return None;
        }
        let old_bmp = SelectObject(mem_h, bmp);

        // Paint the background with the menu colour.
        SetDCBrushColor(mem_h, bg);
        SetDCPenColor(mem_h, fg);
        SetBkMode(mem_h, TRANSPARENT as i32);
        SetTextColor(mem_h, fg);
        let _ = Rectangle(mem_h, 0, 0, w, h);

        // Draw the icon glyph with the foreground colour. The
        // draw helpers take `isize` (so the file does not need to
        // import `HANDLE` everywhere); we cast the raw pointer at
        // the call site.
        let mem: isize = mem_h as isize;
        match id {
            MenuIconId::Cmd => draw_cmd(mem, w, h, fg),
            MenuIconId::PowerShell => draw_powershell(mem, w, h, fg),
            MenuIconId::PowerShell7 => draw_powershell7(mem, w, h, fg),
            MenuIconId::WslDefault => draw_wsl(mem, w, h, fg),
            MenuIconId::WslUbuntu => draw_wsl_ubuntu(mem, w, h, fg),
            MenuIconId::GitBash => draw_git_bash(mem, w, h, fg),
            MenuIconId::Copy => draw_copy(mem, w, h, fg),
            MenuIconId::Paste => draw_paste(mem, w, h, fg),
            MenuIconId::SelectAll => draw_select_all(mem, w, h, fg),
            MenuIconId::SaveScrollback => draw_save(mem, w, h, fg),
            MenuIconId::SplitRight => draw_split_right(mem, w, h, fg),
            MenuIconId::SplitDown => draw_split_down(mem, w, h, fg),
            MenuIconId::ClosePane => draw_close(mem, w, h, fg),
            MenuIconId::ThemePaint => draw_theme(mem, w, h, fg),
            MenuIconId::OpenFolder => draw_open_folder(mem, w, h, fg),
            MenuIconId::ThemeVscodeLight => draw_theme_vscode_light(mem, w, h, fg),
            MenuIconId::ThemeVscodeDark => draw_theme_vscode_dark(mem, w, h, fg),
            MenuIconId::ThemeWindowsTerminal => draw_theme_wt_dark(mem, w, h, fg),
            MenuIconId::PasteImage => draw_paste_image(mem, w, h, fg),
            MenuIconId::RenameTab => draw_rename_tab(mem, w, h, fg),
            MenuIconId::FontSize => draw_font_size(mem, w, h, fg),
        }

        SelectObject(mem_h, old_bmp);
        let _ = DeleteDC(mem_h);
        let _ = DeleteDC(screen);

        Some(bmp as isize)
    }
}

// ---------------------------------------------------------------------------
// Per-icon draw helpers
// ---------------------------------------------------------------------------
//
// Each helper takes a memory DC, the bitmap size, and the
// foreground colour. They draw using Rectangle / RoundRect /
// Ellipse / LineTo. Coordinates are in pixels; the helpers scale
// to the bitmap size (most icons are designed for 16x16 but
// RoundRect + scaling keeps them readable at 20x20 too).

#[inline]
fn s(w: i32, n: i32) -> i32 {
    // Scale a 0..16 design coordinate to the actual bitmap size.
    (w * n + 8) / 16
}

fn draw_cmd(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // "C:\" letterform on the left, underscore on the right.
        let s = |n| s(w.max(h), n);
        // C-shape
        let _ = RoundRect(mem as HANDLE, s(2), s(3), s(7), s(11), s(3), s(3));
        let _ = Rectangle(mem as HANDLE, s(2), s(3), s(4), s(4)); // top
        let _ = Rectangle(mem as HANDLE, s(2), s(3), s(3), s(11)); // left
        let _ = Rectangle(mem as HANDLE, s(2), s(10), s(4), s(11)); // bottom
        // : (two dots)
        let _ = Rectangle(mem as HANDLE, s(7), s(5), s(8), s(6));
        let _ = Rectangle(mem as HANDLE, s(7), s(8), s(8), s(9));
        // \ diagonal (approximated with rectangles)
        for i in 0..3 {
            let _ = Rectangle(mem as HANDLE, s(8 + i), s(5 + i), s(9 + i), s(6 + i));
        }
        // _ cursor
        let _ = Rectangle(mem as HANDLE, s(7), s(12), s(13), s(13));
    }
}

fn draw_powershell(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        let s = |n| s(w.max(h), n);
        // Bold P
        let _ = Rectangle(mem as HANDLE, s(3), s(3), s(5), s(13));
        let _ = RoundRect(mem as HANDLE, s(5), s(3), s(9), s(8), s(1), s(1));
        // Bold S (simplified)
        let _ = Rectangle(mem as HANDLE, s(10), s(3), s(13), s(5));
        let _ = Rectangle(mem as HANDLE, s(10), s(3), s(11), s(8));
        let _ = Rectangle(mem as HANDLE, s(10), s(7), s(13), s(9));
        let _ = Rectangle(mem as HANDLE, s(12), s(9), s(13), s(13));
        let _ = Rectangle(mem as HANDLE, s(10), s(12), s(13), s(13));
    }
}

fn draw_powershell7(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        draw_powershell(mem, w, h, _fg);
        // Small "7" above
        let s = |n| s(w.max(h), n);
        let _ = Rectangle(mem as HANDLE, s(3), s(1), s(7), s(2));
        let _ = Rectangle(mem as HANDLE, s(6), s(1), s(7), s(4));
    }
}

fn draw_wsl(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Stylized Tux: head + body.
        let s = |n| s(w.max(h), n);
        let _ = Ellipse(mem as HANDLE, s(5), s(2), s(11), s(8));
        let _ = RoundRect(mem as HANDLE, s(4), s(7), s(12), s(13), s(1), s(1));
        // Eyes (negative space — leave them background-coloured)
        let _ = Rectangle(mem as HANDLE, s(7), s(4), s(8), s(5));
        let _ = Rectangle(mem as HANDLE, s(9), s(4), s(10), s(5));
    }
}

fn draw_wsl_ubuntu(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Ubuntu "Circle of Friends" — 3 heads, one in the middle.
        let s = |n| s(w.max(h), n);
        let _ = Ellipse(mem as HANDLE, s(1), s(2), s(7), s(8));
        let _ = Ellipse(mem as HANDLE, s(9), s(2), s(15), s(8));
        let _ = Ellipse(mem as HANDLE, s(5), s(8), s(11), s(14));
    }
}

fn draw_git_bash(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Trunk + branch with three commit dots.
        let s = |n| s(w.max(h), n);
        let _ = Rectangle(mem as HANDLE, s(3), s(2), s(4), s(14));
        let _ = Ellipse(mem as HANDLE, s(2), s(2), s(5), s(5));
        let _ = Ellipse(mem as HANDLE, s(2), s(11), s(5), s(14));
        let _ = Rectangle(mem as HANDLE, s(4), s(6), s(11), s(7));
        let _ = Ellipse(mem as HANDLE, s(10), s(6), s(13), s(9));
    }
}

fn draw_copy(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Two stacked rectangles.
        let s = |n| s(w.max(h), n);
        let _ = Rectangle(mem as HANDLE, s(2), s(2), s(9), s(9));
        let _ = Rectangle(mem as HANDLE, s(6), s(6), s(13), s(13));
        // Hollow the front one a touch
        let _ = Rectangle(mem as HANDLE, s(7), s(7), s(12), s(12));
    }
}

fn draw_font_size(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // A blocky capital "A": two legs stepping outward from an
        // apex, plus a crossbar. Reads as "font/text size".
        let s = |n| s(w.max(h), n);
        // Apex
        let _ = Rectangle(mem as HANDLE, s(6), s(3), s(10), s(5));
        // Left leg (top -> bottom, stepping left)
        let _ = Rectangle(mem as HANDLE, s(5), s(4), s(7), s(8));
        let _ = Rectangle(mem as HANDLE, s(4), s(7), s(6), s(11));
        let _ = Rectangle(mem as HANDLE, s(3), s(10), s(5), s(13));
        // Right leg (top -> bottom, stepping right)
        let _ = Rectangle(mem as HANDLE, s(9), s(4), s(11), s(8));
        let _ = Rectangle(mem as HANDLE, s(10), s(7), s(12), s(11));
        let _ = Rectangle(mem as HANDLE, s(11), s(10), s(13), s(13));
        // Crossbar
        let _ = Rectangle(mem as HANDLE, s(5), s(8), s(11), s(10));
    }
}

fn draw_paste(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Clipboard.
        let s = |n| s(w.max(h), n);
        let _ = Rectangle(mem as HANDLE, s(5), s(2), s(10), s(5));
        let _ = Rectangle(mem as HANDLE, s(3), s(5), s(12), s(14));
        let _ = Rectangle(mem as HANDLE, s(5), s(7), s(10), s(11));
    }
}

fn draw_select_all(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Four corner brackets (dashed) + a check mark in the middle.
        let s = |n| s(w.max(h), n);
        // Top-left bracket
        let _ = Rectangle(mem as HANDLE, s(2), s(2), s(7), s(3));
        let _ = Rectangle(mem as HANDLE, s(2), s(2), s(3), s(6));
        // Top-right
        let _ = Rectangle(mem as HANDLE, s(9), s(2), s(14), s(3));
        let _ = Rectangle(mem as HANDLE, s(13), s(2), s(14), s(6));
        // Bottom-left
        let _ = Rectangle(mem as HANDLE, s(2), s(13), s(7), s(14));
        let _ = Rectangle(mem as HANDLE, s(2), s(10), s(3), s(14));
        // Bottom-right
        let _ = Rectangle(mem as HANDLE, s(9), s(13), s(14), s(14));
        let _ = Rectangle(mem as HANDLE, s(13), s(10), s(14), s(14));
        // Check mark
        let _ = Rectangle(mem as HANDLE, s(5), s(8), s(6), s(9));
        let _ = Rectangle(mem as HANDLE, s(6), s(9), s(7), s(10));
        let _ = Rectangle(mem as HANDLE, s(7), s(10), s(8), s(11));
        let _ = Rectangle(mem as HANDLE, s(8), s(9), s(9), s(10));
        let _ = Rectangle(mem as HANDLE, s(9), s(8), s(10), s(9));
    }
}

fn draw_save(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Floppy disk.
        let s = |n| s(w.max(h), n);
        let _ = Rectangle(mem as HANDLE, s(3), s(2), s(13), s(14));
        let _ = Rectangle(mem as HANDLE, s(3), s(2), s(13), s(5));
        let _ = Rectangle(mem as HANDLE, s(5), s(3), s(7), s(4));
        let _ = Rectangle(mem as HANDLE, s(5), s(8), s(11), s(12));
    }
}

fn draw_split_right(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // WezTerminator (patch 0048): a terminal OUTLINE with a single
        // VERTICAL divider toward the right — the new pane appears on the
        // right. (Replaces the old filled-block + arrow.)
        let s = |n| s(w.max(h), n);
        let _ = Rectangle(mem as HANDLE, s(2), s(3), s(14), s(4)); // top edge
        let _ = Rectangle(mem as HANDLE, s(2), s(12), s(14), s(13)); // bottom
        let _ = Rectangle(mem as HANDLE, s(2), s(3), s(3), s(13)); // left edge
        let _ = Rectangle(mem as HANDLE, s(13), s(3), s(14), s(13)); // right edge
        // Vertical divider, right of centre.
        let _ = Rectangle(mem as HANDLE, s(9), s(3), s(10), s(13));
    }
}

fn draw_split_down(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // WezTerminator (patch 0048): a terminal OUTLINE with a single
        // HORIZONTAL divider toward the bottom — the new pane appears
        // below. (Replaces the old filled-block + arrow.)
        let s = |n| s(w.max(h), n);
        let _ = Rectangle(mem as HANDLE, s(2), s(3), s(14), s(4)); // top edge
        let _ = Rectangle(mem as HANDLE, s(2), s(12), s(14), s(13)); // bottom
        let _ = Rectangle(mem as HANDLE, s(2), s(3), s(3), s(13)); // left edge
        let _ = Rectangle(mem as HANDLE, s(13), s(3), s(14), s(13)); // right edge
        // Horizontal divider, below centre.
        let _ = Rectangle(mem as HANDLE, s(2), s(9), s(14), s(10));
    }
}

fn draw_close(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // X — two diagonals.
        let scale = |n| s(w.max(h), n);
        let pen = CreatePen(PS_SOLID, scale(1).max(1), _fg);
        if !pen.is_null() {
            let old = SelectObject(mem as HANDLE, pen as HANDLE);
            let _ = MoveToEx(mem as HANDLE, scale(3), scale(3), std::ptr::null_mut());
            let _ = LineTo(mem as HANDLE, scale(12), scale(12));
            let _ = MoveToEx(mem as HANDLE, scale(12), scale(3), std::ptr::null_mut());
            let _ = LineTo(mem as HANDLE, scale(3), scale(12));
            SelectObject(mem as HANDLE, old);
            let _ = DeleteObject(pen as HANDLE);
        }
    }
}

fn draw_theme(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Paint palette (large rounded body + thumb hole + 4 colour
        // dots).
        let s = |n| s(w.max(h), n);
        let _ = Ellipse(mem as HANDLE, s(1), s(2), s(13), s(14));
        // Thumb hole (background-coloured, drawn over the ellipse)
        let _ = Rectangle(mem as HANDLE, s(6), s(9), s(9), s(12));
        // 4 small colour dots around the rim
        let _ = Rectangle(mem as HANDLE, s(3), s(1), s(5), s(3));
        let _ = Rectangle(mem as HANDLE, s(10), s(1), s(12), s(3));
        let _ = Rectangle(mem as HANDLE, s(0), s(5), s(2), s(7));
        let _ = Rectangle(mem as HANDLE, s(13), s(5), s(15), s(7));
    }
}

fn draw_open_folder(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        let s = |n| s(w.max(h), n);
        let _ = Rectangle(mem as HANDLE, s(1), s(4), s(7), s(6));
        let _ = Rectangle(mem as HANDLE, s(1), s(5), s(15), s(14));
    }
}

fn draw_theme_vscode_light(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Sun above horizontal baseline.
        let s = |n| s(w.max(h), n);
        let _ = Ellipse(mem as HANDLE, s(5), s(2), s(11), s(8));
        // Sun rays
        for i in 0..2 {
            let _ = Rectangle(mem as HANDLE, s(3), s(3 + i), s(4), s(4 + i));
            let _ = Rectangle(mem as HANDLE, s(12), s(3 + i), s(13), s(4 + i));
            let _ = Rectangle(mem as HANDLE, s(7), s(1 + i), s(9), s(2 + i));
        }
        // Horizon
        let _ = Rectangle(mem as HANDLE, s(1), s(9), s(15), s(10));
        // Ground
        let _ = Rectangle(mem as HANDLE, s(2), s(11), s(14), s(14));
    }
}

fn draw_theme_vscode_dark(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Crescent moon.
        let s = |n| s(w.max(h), n);
        let _ = Ellipse(mem as HANDLE, s(2), s(2), s(14), s(14));
        // Carve the crescent by overdrawing a bg-coloured disc offset
        // to the right.
        let bg = GetSysColor(4);
        let old_brush = SelectObject(mem as HANDLE, CreateSolidBrush(bg) as HANDLE);
        let _ = Ellipse(mem as HANDLE, s(5), s(2), s(15), s(12));
        let _ = DeleteObject(SelectObject(mem as HANDLE, old_brush) as HANDLE);
        // Stars
        let _ = Rectangle(mem as HANDLE, s(0), s(6), s(1), s(7));
        let _ = Rectangle(mem as HANDLE, s(14), s(10), s(15), s(11));
        let _ = Rectangle(mem as HANDLE, s(13), s(3), s(14), s(4));
    }
}

fn draw_theme_wt_dark(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    unsafe {
        // Chevrons stacked (Windows Terminal prompt).
        let s = |n| s(w.max(h), n);
        for i in 0..3 {
            let _ = Rectangle(mem as HANDLE, s(1 + i), s(4 + i * 2), s(15 - i), s(5 + i * 2));
        }
        // Cursor underscore
        let _ = Rectangle(mem as HANDLE, s(1), s(12), s(7), s(13));
    }
}

fn draw_paste_image(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    // A small "landscape" silhouette: a sun arc at the top
    // and two mountains at the bottom. Drawn with rectangles
    // and a 1-pixel outline so it reads at 16x16.
    let s = |n| s(w.max(h), n);
    unsafe {
        // Sun disc (top-right).
        let _ = Ellipse(mem as HANDLE, s(8), s(2), s(13), s(7));
        // Back mountain (taller, on the right).
        let _ = Rectangle(mem as HANDLE, s(6), s(7), s(14), s(13));
        // Front mountain (shorter, on the left).
        let _ = Rectangle(mem as HANDLE, s(2), s(9), s(9), s(13));
        // Ground line across the bottom.
        let _ = Rectangle(mem as HANDLE, s(1), s(13), s(15), s(14));
    }
}

fn draw_rename_tab(mem: isize, w: i32, h: i32, _fg: COLORREF) {
    // A small "tab + pencil" silhouette: a tab outline (the
    // WezTerminator tab bar metaphor) with a short diagonal
    // "pencil tip" mark on the top-right corner to evoke the
    // "rename" verb. Drawn with rectangles and a 1-pixel
    // outline so it reads at 16x16.
    let s = |n| s(w.max(h), n);
    unsafe {
        // Tab body: an outer rectangle.
        let _ = Rectangle(mem as HANDLE, s(1), s(4), s(11), s(13));
        // Tab top fold (a smaller rectangle on the top-right
        // that gives the silhouette a "tab with corner cut"
        // look).
        let _ = Rectangle(mem as HANDLE, s(8), s(2), s(13), s(5));
        let _ = Rectangle(mem as HANDLE, s(11), s(5), s(13), s(8));
        // Diagonal pencil: three short rectangles stepping
        // up-and-right to suggest a pencil mark crossing
        // the tab.
        for i in 0..3 {
            let _ = Rectangle(
                mem as HANDLE,
                s(2 + i),
                s(5 + i),
                s(3 + i),
                s(6 + i),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn all_icons_have_unique_ids() {
        let ids = [
            MenuIconId::Cmd,
            MenuIconId::PowerShell,
            MenuIconId::PowerShell7,
            MenuIconId::WslDefault,
            MenuIconId::WslUbuntu,
            MenuIconId::GitBash,
            MenuIconId::Copy,
            MenuIconId::Paste,
            MenuIconId::SelectAll,
            MenuIconId::SaveScrollback,
            MenuIconId::SplitRight,
            MenuIconId::SplitDown,
            MenuIconId::ClosePane,
            MenuIconId::ThemePaint,
            MenuIconId::OpenFolder,
            MenuIconId::ThemeVscodeLight,
            MenuIconId::ThemeVscodeDark,
            MenuIconId::ThemeWindowsTerminal,
            MenuIconId::PasteImage,
            MenuIconId::RenameTab,
            MenuIconId::FontSize,
        ];
        let mut seen = HashSet::new();
        for id in ids {
            assert!(seen.insert(id), "duplicate id: {:?}", id);
        }
    }

    #[test]
    fn hash_eq_impls_compile() {
        let mut s: HashSet<MenuIconId> = HashSet::new();
        s.insert(MenuIconId::Copy);
        s.insert(MenuIconId::Copy);
        s.insert(MenuIconId::Paste);
        assert_eq!(s.len(), 2);
    }
}
