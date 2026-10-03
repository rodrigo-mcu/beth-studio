// wtinator::header — Phase 1.E (patch 0030).
//
// A per-terminal status header that is rendered as the first
// line of every pane. The header is a small grey bar with
// white text and rolls with the scrollback (so it is part
// of the visible viewport, not a fixed widget on the window
// chrome).
//
// The header is composed of three optional fields:
//   - `header_text` (custom title from "Rename terminal…")
//   - `group_name`  (from patch 0028's "Move pane to…")
//   - the tab index (always present, gives a stable
//     per-window identifier)
//
// ## Module layout
//
// - `header/mod.rs` (this file): the data model, the
//   string formatting, the input validator, and the
//   `prompt_rename` re-export.
// - `header/win32_prompt.rs`: the actual Win32 input
//   dialog implementation. This is the **only** module
//   in the `wtinator` crate that uses `unsafe` — the
//   crate-level `#![deny(unsafe_code)]` is locally
//   relaxed to `allow` only inside that file so the
//   rest of the delta stays safe-by-default.

use mux::pane::Pane;
use mux::tab::Tab;
use std::sync::Arc;
use wezterm_term::color::ColorAttribute;
use wezterm_term::{CellAttributes, Intensity, Line};
use wezterm_color_types::SrgbaTuple;

#[allow(unsafe_code)]
pub mod win32_prompt;

/// Maximum length of a user-supplied header title.
pub const MAX_HEADER_TEXT_LEN: usize = 80;

/// Separator used between header fields. `·` (U+00B7
/// MIDDLE DOT) renders as a single column in a typical
/// monospace font and is widely used for this kind of
/// breadcrumb.
const HEADER_SEPARATOR: &str = " · ";

/// Normalize a user-supplied header title.
pub fn normalize_header_text(raw: &str) -> anyhow::Result<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().any(|c| c.is_control() || c == '\n' || c == '\r') {
        anyhow::bail!("header text contains control characters or newlines");
    }
    if trimmed.chars().count() > MAX_HEADER_TEXT_LEN {
        anyhow::bail!("header text is longer than {} chars", MAX_HEADER_TEXT_LEN);
    }
    Ok(Some(trimmed.to_string()))
}

/// Decide whether the header should be rendered for the
/// given tab (used for group name check).
pub fn should_render(tab: &Arc<Tab>) -> bool {
    if let Some(g) = tab.get_group_name() {
        if !g.is_empty() {
            return true;
        }
    }
    true
}

/// Build the rendered header string from tab + optional pane header text.
pub fn build_header(tab: &Arc<Tab>, tab_index: usize, pane_header_text: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(3);
    parts.push(format!("Tab #{}", tab_index + 1));
    if let Some(group) = tab.get_group_name() {
        if !group.is_empty() {
            parts.push(format!("group: {}", group));
        }
    }
    if let Some(text) = pane_header_text {
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }
    parts.join(HEADER_SEPARATOR)
}

/// Check whether the header overlay should be rendered
/// for a given pane. Returns false when the pane's
/// alternate screen is active (vim, htop, etc.) so the
/// header does not obscure TUI applications.
pub fn should_render_for_pane(tab: &Arc<Tab>, pane: &Arc<dyn Pane>) -> bool {
    if pane.is_alt_screen_active() {
        return false;
    }
    // Show header if tab has group or pane has custom header text
    if let Some(g) = tab.get_group_name() {
        if !g.is_empty() {
            return true;
        }
    }
    if let Some(text) = pane.get_header_text() {
        if !text.is_empty() {
            return true;
        }
    }
    true
}

/// Background colour for the header bar (dark grey).
pub const HEADER_BG: SrgbaTuple = SrgbaTuple(0.18, 0.18, 0.20, 1.0);

/// Foreground (text) colour for the header bar.
pub const HEADER_FG: SrgbaTuple = SrgbaTuple(0.70, 0.70, 0.73, 1.0);

/// Edit-mode field fill: opaque white, like a Windows text box.
/// A navy band made typed glyphs the same colour as the bar once
/// `render_screen_line` honoured reverse-video.
pub const HEADER_EDIT_BG: SrgbaTuple = SrgbaTuple(1.0, 1.0, 1.0, 1.0);

/// Edit-mode ink: opaque black on [`HEADER_EDIT_BG`].
pub const HEADER_EDIT_FG: SrgbaTuple = SrgbaTuple(0.0, 0.0, 0.0, 1.0);

/// Edit-mode colours: always black ink on a white field.
/// The pane background is ignored so a dark theme cannot pick navy
/// again, and reverse-video cannot swap two similar darks.
pub fn header_edit_colors(_pane_bg: SrgbaTuple) -> (SrgbaTuple, SrgbaTuple) {
    (HEADER_EDIT_FG, HEADER_EDIT_BG)
}

/// Build a `Line` suitable for rendering by
/// `render_screen_line`. The line is padded to `width`
/// columns with spaces so the header background covers
/// the full pane width.
pub fn build_header_line(text: &str, width: usize) -> Line {
    build_header_line_themed(text, width, HEADER_FG, HEADER_BG)
}

/// Build a header `Line` with caller-supplied theme colours.
///
/// This is the theme-aware variant of [`build_header_line`].
/// The renderer derives `fg`/`bg` from the active pane's
/// colour palette so the bar blends with whatever theme is
/// in use instead of the hardcoded grey defaults. The plain
/// [`build_header_line`] delegates here with the legacy
/// constants for any caller that does not have a palette.
pub fn build_header_line_themed(
    text: &str,
    width: usize,
    fg: SrgbaTuple,
    bg: SrgbaTuple,
) -> Line {
    let fg = ColorAttribute::TrueColorWithDefaultFallback(fg);
    let bg = ColorAttribute::TrueColorWithDefaultFallback(bg);
    let attrs = CellAttributes::default()
        .set_foreground(fg)
        .set_background(bg)
        .clone();
    let padded = if text.len() < width {
        let mut s = text.to_string();
        let remaining = width.saturating_sub(text.chars().count());
        for _ in 0..remaining {
            s.push(' ');
        }
        s
    } else {
        text.to_string()
    };
    Line::from_text(&padded, &attrs, 0, None)
}

/// Build a `Line` for the header in edit mode.  Uses the
/// edit-mode colours and shows only the raw buffer text
/// (no "Tab #N · " prefix) so the user can clearly see
/// what they are typing.
pub fn build_header_edit_line(buffer: &str, width: usize) -> Line {
    build_header_edit_line_themed(buffer, width, HEADER_EDIT_FG, HEADER_EDIT_BG)
}

/// Edit-mode header line with explicit colours (light vs dark pane).
pub fn build_header_edit_line_themed(
    buffer: &str,
    width: usize,
    fg: SrgbaTuple,
    bg: SrgbaTuple,
) -> Line {
    let fg = ColorAttribute::TrueColorWithDefaultFallback(fg);
    let bg = ColorAttribute::TrueColorWithDefaultFallback(bg);
    let attrs = CellAttributes::default()
        .set_foreground(fg)
        .set_background(bg)
        .set_reverse(false)
        .set_intensity(Intensity::Bold)
        .clone();
    let char_count = buffer.chars().count();
    let padded = if char_count < width {
        let mut s = buffer.to_string();
        for _ in 0..width.saturating_sub(char_count) {
            s.push(' ');
        }
        s
    } else {
        buffer.to_string()
    };
    Line::from_text(&padded, &attrs, 0, None)
}

/// Pop the Win32 input dialog and return the user's
/// choice. Thin re-export of `win32_prompt::run` so the
/// dispatcher in `wezterm-gui` does not need to know
/// about the `header::win32_prompt` sub-module.
///
/// Returns:
/// - `Some(Some(text))` — user accepted with non-empty text
/// - `Some(None)` — user accepted with empty input
/// - `None` — user cancelled
pub fn prompt_rename(hwnd: isize, current: Option<&str>) -> Option<Option<String>> {
    win32_prompt::run(hwnd, current, "Rename terminal", "Nome da aba")
}

/// Patch 0031: thin wrapper for the per-tab user title
/// rename. Calls the same `win32_prompt::run` dialog as
/// `prompt_rename`; the only difference is the call site
/// (right-click "Rename tab…" instead of "Rename
/// terminal…"). Kept as a separate function for symmetry
/// with the patch 0030.5 call site and so future
/// per-tab-specific tweaks (e.g. a different label or a
/// different input validator) can land here without
/// touching the per-pane path.
///
/// Same return contract as `prompt_rename`:
/// - `Some(Some(text))` — user accepted with non-empty text
/// - `Some(None)` — user accepted with empty input
/// - `None` — user cancelled
pub fn prompt_user_title(hwnd: isize, current: Option<&str>) -> Option<Option<String>> {
    win32_prompt::run(hwnd, current, "Rename tab", "Nome da aba")
}

/// Prompt for a sticky per-window name. Used by "Rename window…" and
/// by "Move tab to → New window" / drag-out, so each physical window
/// can be identified in the destination list, taskbar and Alt+Tab.
///
/// Same return contract as [`prompt_rename`]:
/// - `Some(Some(text))` — user accepted with non-empty text
/// - `Some(None)` — user accepted with empty input
/// - `None` — user cancelled
pub fn prompt_window_title(hwnd: isize, current: Option<&str>) -> Option<Option<String>> {
    let title = if current.map(|s| !s.trim().is_empty()).unwrap_or(false) {
        "Rename window"
    } else {
        "Name window"
    };
    win32_prompt::run(hwnd, current, title, "Nome da janela")
}

/// Apply a user-chosen name to a mux window. Empty / `None` clears
/// the override so the auto/OSC title is used again.
pub fn apply_window_user_title(window_id: mux::window::WindowId, title: Option<String>) {
    let Some(mux) = mux::Mux::try_get() else {
        return;
    };
    let Some(mut window) = mux.get_window_mut(window_id) else {
        return;
    };
    window.set_user_title(title);
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_header_text_trims_whitespace() {
        assert_eq!(
            normalize_header_text("  build-watch  ").unwrap(),
            Some("build-watch".to_string())
        );
        assert_eq!(normalize_header_text("").unwrap(), None);
        assert_eq!(normalize_header_text("   ").unwrap(), None);
    }

    #[test]
    fn normalize_header_text_rejects_control_chars() {
        assert!(normalize_header_text("foo\nbar").is_err());
        assert!(normalize_header_text("foo\x00bar").is_err());
        assert!(normalize_header_text("foo\r\nbar").is_err());
    }

    #[test]
    fn normalize_header_text_caps_length() {
        let long = "a".repeat(MAX_HEADER_TEXT_LEN + 1);
        assert!(normalize_header_text(&long).is_err());
        let just_right = "a".repeat(MAX_HEADER_TEXT_LEN);
        assert_eq!(
            normalize_header_text(&just_right).unwrap().unwrap().len(),
            MAX_HEADER_TEXT_LEN
        );
    }

    #[test]
    fn header_separator_is_a_middle_dot() {
        assert_eq!(HEADER_SEPARATOR, " · ");
    }

    /// The pure-string formatting helper used by the
    /// tests; mirrors what `build_header` does but
    /// without needing a live `Tab`.
    fn build_header_format_isolated(
        group: Option<&str>,
        header_text: Option<&str>,
        tab_index: usize,
    ) -> String {
        let mut parts: Vec<String> = Vec::with_capacity(3);
        parts.push(format!("Tab #{}", tab_index + 1));
        if let Some(g) = group {
            if !g.is_empty() {
                parts.push(format!("group: {}", g));
            }
        }
        if let Some(t) = header_text {
            if !t.is_empty() {
                parts.push(t.to_string());
            }
        }
        parts.join(HEADER_SEPARATOR)
    }

    #[test]
    fn build_header_format_with_group_and_text() {
        assert_eq!(
            build_header_format_isolated(Some("frontend"), Some("build-watch"), 2),
            "Tab #3 · group: frontend · build-watch"
        );
    }

    #[test]
    fn build_header_format_without_group() {
        assert_eq!(
            build_header_format_isolated(None, Some("db-shell"), 0),
            "Tab #1 · db-shell"
        );
    }

    #[test]
    fn build_header_format_with_only_index() {
        assert_eq!(build_header_format_isolated(None, None, 4), "Tab #5");
    }

    #[test]
    fn build_header_format_skips_empty_group() {
        assert_eq!(
            build_header_format_isolated(Some(""), Some("x"), 0),
            "Tab #1 · x"
        );
    }

    fn relative_luminance(c: SrgbaTuple) -> f32 {
        0.2126 * c.0 + 0.7152 * c.1 + 0.0722 * c.2
    }

    #[test]
    fn header_edit_colors_are_black_on_white() {
        let dark_pane = SrgbaTuple(0.08, 0.10, 0.18, 1.0);
        let light_pane = SrgbaTuple(0.96, 0.96, 0.94, 1.0);
        let (fg_dark, bg_dark) = header_edit_colors(dark_pane);
        let (fg_light, bg_light) = header_edit_colors(light_pane);
        assert_eq!(fg_dark, HEADER_EDIT_FG);
        assert_eq!(bg_dark, HEADER_EDIT_BG);
        assert_eq!(fg_dark, fg_light);
        assert_eq!(bg_dark, bg_light);
        assert!(relative_luminance(fg_dark) < 0.1);
        assert!(relative_luminance(bg_dark) > 0.9);
        assert!(relative_luminance(bg_dark) - relative_luminance(fg_dark) > 0.8);
    }

    #[test]
    fn header_edit_line_keeps_black_on_white_without_reverse() {
        let line = build_header_edit_line("nome", 16);
        let cell = line.get_cell(0).expect("first edit cell");
        assert!(!cell.attrs().reverse());
        match cell.attrs().foreground() {
            ColorAttribute::TrueColorWithDefaultFallback(c) => {
                assert!(relative_luminance(c) < 0.1, "fg {c:?}");
            }
            other => panic!("expected true-color fg, got {other:?}"),
        }
        match cell.attrs().background() {
            ColorAttribute::TrueColorWithDefaultFallback(c) => {
                assert!(relative_luminance(c) > 0.9, "bg {c:?}");
            }
            other => panic!("expected true-color bg, got {other:?}"),
        }
    }
}
