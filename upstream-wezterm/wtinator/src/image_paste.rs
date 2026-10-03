// wtinator::image_paste — Phase 2.1 (patch 0022).
//
// Read an image from the Windows clipboard, save it as a PNG,
// and paste a Markdown link to the focused pane.
// The paste text is visible and points at a real file, which is
// more reliable for CLI tools than sending terminal image protocol
// bytes as stdin.
//
// ## Why not OSC 1337 as input?
//
// The upstream `wezterm-escape-parser/src/osc.rs` already
// understands OSC 1337 (the iTerm2 "File Upload" protocol) and
// the upstream renderer already blits the image into the
// terminal at the current cursor position. We don't need a
// new `KeyAssignment::PasteImage` — we can just write the
// escape bytes to the PTY. The parser picks them up, hands
// the image to the renderer, and Claude Code sees the
// attachment.
//
// The protocol (iTerm2 "File Upload", documented at
// https://iterm2.com/documentation-escape-codes.html):
//
//     ESC ] 1337 ; File = [k=v pairs] : [base64 payload] BEL
//
// We emit the canonical inline-image form:
//
//     ESC ] 1337 ; File = name=<sha-png>;size=<N>;width=auto;
//                    height=auto;preserveAspectRatio=1;inline=1
//                    : <base64 PNG> BEL
//
// The chosen `k=v` set matches what the VSCode terminal sends:
// `name=...`, `size=...`, `width=auto`, `height=auto`,
// `preserveAspectRatio=1`, `inline=1`. The receiver decides
// the on-screen size.
//
// ## Why PNG and not the raw CF_DIB?
//
// The upstream escape parser expects an image container
// format (PNG, JPEG, GIF). CF_DIB is a Windows-specific
// 32-bit DIB (no header, just raw pixels + a small
// BITMAPINFOHEADER). The escape parser would not know what
// to do with it. We do the encoding here.
//
// We use the `image` crate (already a transitive dependency
// of `wezterm-gui` via `wezterm-font`) to decode the DIB to
// RGBA8 and re-encode to PNG. This adds no new build
// dependency.
//
// ## Threading
//
// The whole flow runs on the main thread (the right-click
// handler already runs on the main thread per patch 0010).
// Reading the clipboard and decoding the DIB are both
// short, blocking operations (< 100ms for a 4K image on
// a modern CPU). We do them inline; the menu stays
// responsive because we return from the click handler
// before the `show_at` modal loop re-arms.

#![cfg(windows)]
#![allow(unsafe_code)]

use anyhow::{Context, Result};
use mux::pane::Pane;
use std::sync::Arc;
use windows_sys::Win32::Foundation::HLOCAL;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
};
use windows_sys::Win32::System::Memory::{LocalLock, LocalSize, LocalUnlock};

// Standard Win32 clipboard format IDs. `CF_DIB = 8`,
// `CF_DIBV5 = 17` — these are defined in `<wingdi.h>` and
// re-stated here because `windows-sys` 0.61 does not export
// them via the `Win32_System_DataExchange` feature.
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

/// Result of inspecting the clipboard. We don't paste if the
/// clipboard is text-only — that's the upstream's job (the
/// `Paste` menu item).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardImageKind {
    /// `CF_DIB` (the older 32-bit DIB format)
    Dib,
    /// `CF_DIBV5` (the extended 32-bit DIB format with the
    /// BITMAPV5HEADER)
    DibV5,
}

/// Check whether the Windows clipboard currently holds an
/// image that we can paste as OSC 1337.
///
/// Returns `Some(kind)` if an image is available, `None`
/// otherwise (text clipboard, or empty).
pub fn clipboard_has_image() -> Option<ClipboardImageKind> {
    unsafe {
        if IsClipboardFormatAvailable(CF_DIBV5) != 0 {
            Some(ClipboardImageKind::DibV5)
        } else if IsClipboardFormatAvailable(CF_DIB) != 0 {
            Some(ClipboardImageKind::Dib)
        } else {
            None
        }
    }
}

/// Read the clipboard image bytes (CF_DIB or CF_DIBV5) and
/// return RGBA8 + dimensions. The caller converts to PNG.
unsafe fn read_clipboard_rgba(kind: ClipboardImageKind) -> Result<(Vec<u8>, u32, u32)> {
    let format = match kind {
        ClipboardImageKind::Dib => CF_DIB,
        ClipboardImageKind::DibV5 => CF_DIBV5,
    };
    let handle = GetClipboardData(format);
    if handle.is_null() {
        anyhow::bail!("GetClipboardData returned NULL");
    }

    let ptr = LocalLock(handle as HLOCAL);
    if ptr.is_null() {
        anyhow::bail!("LocalLock returned NULL");
    }

    let result = (|| -> Result<(Vec<u8>, u32, u32)> {
        let len = LocalSize(handle as HLOCAL);
        if len < 40 {
            anyhow::bail!("clipboard DIB is too small: {} bytes", len);
        }
        let bytes = std::slice::from_raw_parts(ptr as *const u8, len);
        dib_bytes_to_rgba(bytes)
    })();

    let _ = LocalUnlock(handle as HLOCAL);
    result
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset + 2;
    let raw = bytes.get(offset..end).context("short DIB header")?;
    Ok(u16::from_le_bytes([raw[0], raw[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset + 4;
    let raw = bytes.get(offset..end).context("short DIB header")?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

fn read_i32(bytes: &[u8], offset: usize) -> Result<i32> {
    Ok(read_u32(bytes, offset)? as i32)
}

/// Convert a packed Windows DIB to top-down RGBA8. Handles the
/// common formats produced by screenshot tools: 32-bpp BGRA and
/// 24-bpp BGR, both top-down and bottom-up.
fn dib_bytes_to_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;

    let header_size = read_u32(bytes, 0)? as usize;
    if header_size < 40 || header_size > bytes.len() {
        anyhow::bail!("unsupported DIB header size {}", header_size);
    }

    let width_i32 = read_i32(bytes, 4)?;
    let height_i32 = read_i32(bytes, 8)?;
    let planes = read_u16(bytes, 12)?;
    let bpp = read_u16(bytes, 14)?;
    let compression = read_u32(bytes, 16)?;
    if planes != 1 || width_i32 <= 0 || height_i32 == 0 {
        anyhow::bail!("invalid DIB header");
    }
    if compression != BI_RGB && compression != BI_BITFIELDS {
        anyhow::bail!("unsupported DIB compression {}", compression);
    }
    if bpp != 32 && bpp != 24 {
        anyhow::bail!("unsupported DIB bit depth {}", bpp);
    }

    let width = width_i32 as usize;
    let height = height_i32.unsigned_abs() as usize;
    let top_down = height_i32 < 0;
    let bytes_per_pixel = (bpp / 8) as usize;
    let stride = ((width * bytes_per_pixel + 3) / 4) * 4;
    let pixel_offset = if header_size == 40 && compression == BI_BITFIELDS {
        52
    } else {
        header_size
    };
    let needed = pixel_offset + stride * height;
    if bytes.len() < needed {
        anyhow::bail!(
            "DIB pixel data is short: got {} bytes, need {}",
            bytes.len(),
            needed
        );
    }

    let mut rgba = vec![0; width * height * 4];
    let pixels = &bytes[pixel_offset..];
    for y in 0..height {
        let src_y = if top_down { y } else { height - 1 - y };
        let src_row = &pixels[src_y * stride..src_y * stride + width * bytes_per_pixel];
        let dst_row = &mut rgba[y * width * 4..(y + 1) * width * 4];
        for x in 0..width {
            let src = &src_row[x * bytes_per_pixel..];
            let dst = &mut dst_row[x * 4..x * 4 + 4];
            dst[0] = src[2];
            dst[1] = src[1];
            dst[2] = src[0];
            dst[3] = if bpp == 32 { src[3] } else { 0xFF };
        }
    }

    Ok((rgba, width as u32, height as u32))
}

/// Encode RGBA bytes as a PNG using the `image` crate.
fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .context("creating RgbaImage from clipboard pixels")?;
    let mut out = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut out);
        encoder
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .context("encoding PNG")?;
    }
    Ok(out)
}

/// Construct the OSC 1337 escape sequence for the given PNG
/// bytes. Uses a 1-character name derived from the image
/// content to keep the escape ASCII-safe.
///
/// Patch 0025 moved image paste to a file-path flow; this builder is
/// kept (and unit-tested) for the inline-image fallback.
#[cfg_attr(not(test), allow(dead_code))]
fn build_osc_1337(png: &[u8], name: &str) -> String {
    use base64::Engine;
    // Encode to base64. Use the URL-safe alphabet (no padding
    // removed) — iTerm2 accepts both. `base64` is already a
    // transitive dependency of wezterm-gui.
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    // Replace anything outside the safe filename charset
    // *before* appending the extension, so the final name
    // stays a single token.
    let safe_name: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // The `size` argument is the length of the raw (binary)
    // payload, not the base64. iTerm2 expects both; some
    // implementations infer the size from the encoded data
    // but we pass it explicitly to be safe.
    let payload = format!(
        "\x1b]1337;File=name={}.png;size={};width=auto;height=auto;preserveAspectRatio=1;inline=1:{}\x07",
        safe_name,
        png.len(),
        encoded,
    );
    payload
}

fn temp_image_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let codex_readable_tmp = std::path::PathBuf::from(r"C:\tmp");
        if codex_readable_tmp.is_dir() {
            return codex_readable_tmp
                .join("bethterm")
                .join("clipboard-images");
        }
    }
    std::env::temp_dir()
        .join("bethterm")
        .join("clipboard-images")
}

fn save_png_to_temp(png: &[u8], width: u32, height: u32) -> Result<std::path::PathBuf> {
    let dir = temp_image_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("clipboard-{}x{}-{}.png", width, height, millis));
    std::fs::write(&path, png).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

fn markdown_image_link(path: &std::path::Path, wsl: bool) -> String {
    let mut link = path.to_string_lossy().replace('\\', "/");
    if wsl {
        link = windows_path_to_wsl_mount(&link);
    }
    format!("![image]({})", link)
}

/// Convert a Windows path (`C:\tmp\x` or `C:/tmp/x`) to its WSL2
/// `/mnt/<drive>/...` form so a program running inside WSL can open it.
/// Anything that doesn't start with a `<drive>:` is returned unchanged
/// (with backslashes normalised to forward slashes).
///
/// This assumes the default WSL automount root (`/mnt`). The temp images we
/// generate always live on a drive letter (see `temp_image_dir`), so the
/// simple drive-letter rewrite is sufficient and avoids shelling out to
/// `wslpath` on every paste.
fn windows_path_to_wsl_mount(path: &str) -> String {
    crate::wsl::windows_path_to_wsl_mount(path)
}

/// Read the clipboard image, save it as PNG, and paste a Markdown
/// image link to the given pane. Returns `Ok(Some(bytes_written))` on success,
/// `Ok(None)` if the clipboard has no image (so the caller
/// can fall through to the text paste path), or
/// `Err(_)` on a real error.
pub fn paste_image_to_pane(pane: &Arc<dyn Pane>) -> Result<Option<usize>> {
    let Some(kind) = clipboard_has_image() else {
        return Ok(None);
    };
    // Open the clipboard for the duration of the read.
    //
    // SAFETY: OpenClipboard returns BOOL; we treat failure as
    // a non-fatal "nothing to paste" condition.
    let opened = unsafe { OpenClipboard(std::ptr::null_mut()) };
    if opened == 0 {
        return Ok(None);
    }

    let result = (|| -> Result<Option<usize>> {
        let (rgba, width, height) = unsafe { read_clipboard_rgba(kind) }?;
        let png = rgba_to_png(&rgba, width, height)?;
        // The image name is derived from the size so the
        // receiver can disambiguate multiple pastes in the
        // same session. It is purely cosmetic — iTerm2 ignores
        // it if `inline=1` is set.
        let path = save_png_to_temp(&png, width, height)?;
        let text = markdown_image_link(&path, crate::wsl::pane_is_wsl(pane));
        let written = text.len();
        pane.send_paste(&text)?;
        Ok(Some(written))
    })();

    unsafe {
        CloseClipboard();
    }
    result
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_osc_1337_produces_valid_header() {
        // 1x1 transparent PNG (smallest possible valid PNG).
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0x50, 0x0F, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xFF, 0x03,
            0x00, 0x20, 0x2D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60,
            0x82,
        ];
        let osc = build_osc_1337(png, "test-image");
        // The '-' character is preserved by the sanitiser;
        // the '.png' suffix is added afterwards. The iTerm2
        // receiver treats the name as cosmetic and ignores
        // it when 'inline=1' is set.
        assert!(
            osc.starts_with("\x1b]1337;File=name=test-image.png;"),
            "expected OSC 1337 header, got: {:?}",
            osc
        );
        assert!(osc.contains(";width=auto;height=auto;"));
        assert!(osc.ends_with('\x07'));
        // The base64 of the 67-byte PNG is around 92 chars; we
        // don't pin the exact value, but we do check the
        // length is reasonable.
        assert!(osc.len() > 100);
    }

    #[test]
    fn build_osc_1337_sanitises_name() {
        let png: &[u8] = &[];
        let osc = build_osc_1337(png, "héllo world!.png");
        // Non-ASCII chars, spaces, and '!' become underscores.
        // The '.' between 'world' and 'png' is also sanitised.
        // The build_osc_1337 function then appends '.png'
        // after the sanitised base, so the OSC shows
        // 'h_llo_world__png.png'.
        assert!(
            osc.contains("name=h_llo_world__png.png;"),
            "expected sanitised name, got: {:?}",
            osc
        );
    }

    #[test]
    fn markdown_image_link_uses_forward_slashes() {
        let path = std::path::Path::new("C:\\tmp\\bethterm\\clipboard-images\\x.png");
        assert_eq!(
            markdown_image_link(path, false),
            "![image](C:/tmp/bethterm/clipboard-images/x.png)"
        );
    }

    #[test]
    fn markdown_image_link_rewrites_wsl_paths() {
        let path = std::path::Path::new("C:\\tmp\\bethterm\\clipboard-images\\x.png");
        assert_eq!(
            markdown_image_link(path, true),
            "![image](/mnt/c/tmp/bethterm/clipboard-images/x.png)"
        );
    }

    #[test]
    fn windows_path_to_wsl_mount_maps_drive_letters() {
        assert_eq!(windows_path_to_wsl_mount("C:/tmp/x.png"), "/mnt/c/tmp/x.png");
        assert_eq!(windows_path_to_wsl_mount("D:\\a\\b"), "/mnt/d/a/b");
        // Non-drive paths pass through (slashes normalised).
        assert_eq!(windows_path_to_wsl_mount("/already/unix"), "/already/unix");
    }

    #[test]
    fn dib_bytes_to_rgba_handles_bottom_up_bgra() {
        let mut dib = Vec::new();
        dib.extend_from_slice(&40u32.to_le_bytes());
        dib.extend_from_slice(&1i32.to_le_bytes());
        dib.extend_from_slice(&1i32.to_le_bytes());
        dib.extend_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&32u16.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&4u32.to_le_bytes());
        dib.extend_from_slice(&0i32.to_le_bytes());
        dib.extend_from_slice(&0i32.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&[0x11, 0x22, 0x33, 0x44]);

        let (rgba, width, height) = dib_bytes_to_rgba(&dib).unwrap();
        assert_eq!((width, height), (1, 1));
        assert_eq!(rgba, vec![0x33, 0x22, 0x11, 0x44]);
    }
}
