// wtinator::cursor_color — Phase 2.3 (patch 0024).
//
// Pick a cursor foreground colour that has enough contrast
// against the current `colors.background`:
//
//   - dark theme (background luminance < 0.5) → white cursor
//   - light theme (background luminance >= 0.5) → black cursor
//
// This mirrors the user-visible behaviour of `wezterm-macos`
// and of the integrated `WS_POPUP` title bar: a cursor that
// "wants" to be the inverse of the background so the user can
// always find it. The user can always override in `wezterm.lua`
// (`config.colors.cursor_fg = '...'`).
//
// ## How the override is applied
//
// `default_overrides()` returns a `Value::Object` with a single
// `colors` key. The value is a sub-Object with `cursor_fg` set
// to `#FFFFFF` or `#000000` depending on the theme. The
// patched upstream `TermWindow::new_window` (patch 0020 fix
// #1) reads this function before calling `Window::new_window`
// and applies the merged config so the first paint of every
// window already uses the cursor colour.
//
// We do **not** read the upstream color-scheme at config-load
// time (it would require hooking into the same `overridden_config`
// path the titlebar patch uses). The simplest correct
// behaviour is to look at the *current* merged `ConfigHandle`
// and decide based on its `colors.background`. This is a
// pure function of the config so it is safe to call from any
// thread.

use wezterm_color_types::SrgbaTuple;
use wezterm_dynamic::{Object, Value};

/// Decide the cursor foreground colour for a given background
/// RGB. Returns `Some((r, g, b, a))` for white on dark, or
/// black on light. Returns `None` if the background is exactly
/// the threshold luminance (no preference — leave it to upstream).
///
/// The luminance is computed with the standard ITU-R BT.601
/// weights because that is what the upstream wezterm `RgbaColor`
/// uses internally for `colors.foreground` defaults. A small
/// dead-band ([0.45, 0.55]) around 0.5 means that mid-grey
/// backgrounds defer to the upstream default and we don't
/// override a working cursor.
pub fn choose_cursor_color(bg_r: f32, bg_g: f32, bg_b: f32) -> Option<SrgbaTuple> {
    // Average the three channels; treat sRGB as 8-bit and use
    // the BT.601 luminance weights so the threshold sits at
    // 0.5 (mid-grey) in the perceptual sense.
    let r = (bg_r.clamp(0.0, 1.0) * 255.0) as u32;
    let g = (bg_g.clamp(0.0, 1.0) * 255.0) as u32;
    let b = (bg_b.clamp(0.0, 1.0) * 255.0) as u32;
    let luminance = (299 * r + 587 * g + 114 * b) as f64 / 255_000.0;
    if luminance < 0.45 {
        // Dark background → white cursor.
        Some(SrgbaTuple(1.0, 1.0, 1.0, 1.0))
    } else if luminance > 0.55 {
        // Light background → black cursor.
        Some(SrgbaTuple(0.0, 0.0, 0.0, 1.0))
    } else {
        // The background is mid-grey; both options have
        // acceptable contrast. Don't override.
        None
    }
}

/// Convert a `SrgbaTuple` to a `#RRGGBB` string in the format
/// the upstream `FromDynamic` accepts.
fn srgba_to_hex(c: SrgbaTuple) -> String {
    let r = (c.0.clamp(0.0, 1.0) * 255.0) as u32;
    let g = (c.1.clamp(0.0, 1.0) * 255.0) as u32;
    let b = (c.2.clamp(0.0, 1.0) * 255.0) as u32;
    format!("#{:02X}{:02X}{:02X}", r, g, b)
}

/// Build a `Value::Object` override that sets `colors.cursor_fg`
/// to the contrast-correct colour for the given background
/// RGB channels. Returns `None` if the background is mid-grey
/// (in which case we defer to the upstream default).
///
/// The override is shaped as a nested `colors` Object so the
/// upstream `overridden_config` merge path can pick it up
/// alongside the titlebar + vscode_font overrides:
/// ```json
/// {
///   "colors": {
///     "cursor_fg": "#FFFFFF"
///   }
/// }
/// ```
pub fn default_overrides(bg_r: f32, bg_g: f32, bg_b: f32) -> Option<Value> {
    let cursor = choose_cursor_color(bg_r, bg_g, bg_b)?;
    let hex = srgba_to_hex(cursor);

    let mut colors_map = Object::default();
    colors_map.insert(
        Value::String("cursor_fg".to_string()),
        Value::String(hex),
    );
    let mut map = Object::default();
    map.insert(
        Value::String("colors".to_string()),
        Value::Object(colors_map),
    );
    Some(Value::Object(map))
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_background_picks_white_cursor() {
        // Pure black background.
        let cursor = choose_cursor_color(0.0, 0.0, 0.0).unwrap();
        assert_eq!(cursor.0, 1.0);
        assert_eq!(cursor.1, 1.0);
        assert_eq!(cursor.2, 1.0);
    }

    #[test]
    fn light_background_picks_black_cursor() {
        // Pure white background.
        let cursor = choose_cursor_color(1.0, 1.0, 1.0).unwrap();
        assert_eq!(cursor.0, 0.0);
        assert_eq!(cursor.1, 0.0);
        assert_eq!(cursor.2, 0.0);
    }

    #[test]
    fn dark_blue_picks_white_cursor() {
        // The wezterminator "VSCode Dark" background is #1F1F1F
        // (0.122, 0.122, 0.122 in sRGB) — clearly dark.
        let cursor = choose_cursor_color(0.122, 0.122, 0.122).unwrap();
        assert_eq!(cursor.0, 1.0);
    }

    #[test]
    fn light_grey_picks_black_cursor() {
        // The wezterminator "VSCode Light" background is #FFFFFF
        // (1.0, 1.0, 1.0). Use a near-white background to be
        // just above the threshold.
        let cursor = choose_cursor_color(0.93, 0.93, 0.93).unwrap();
        assert_eq!(cursor.0, 0.0);
    }

    #[test]
    fn mid_grey_returns_none() {
        // A mid-grey background (~50% luminance) gets no
        // override so the upstream default takes over.
        assert!(choose_cursor_color(0.5, 0.5, 0.5).is_none());
    }

    #[test]
    fn srgba_to_hex_white() {
        let hex = srgba_to_hex(SrgbaTuple(1.0, 1.0, 1.0, 1.0));
        assert_eq!(hex, "#FFFFFF");
    }

    #[test]
    fn srgba_to_hex_black() {
        let hex = srgba_to_hex(SrgbaTuple(0.0, 0.0, 0.0, 1.0));
        assert_eq!(hex, "#000000");
    }

    #[test]
    fn default_overrides_emits_correct_shape() {
        let v = default_overrides(0.0, 0.0, 0.0).unwrap();
        // Top-level keys: only "colors".
        if let Value::Object(map) = &v {
            let key = Value::String("colors".to_string());
            let colors_value = map.get(&key).expect("colors key present");
            if let Value::Object(colors_map) = colors_value {
                let key = Value::String("cursor_fg".to_string());
                let cursor_value = colors_map
                    .get(&key)
                    .expect("cursor_fg key present");
                match cursor_value {
                    Value::String(s) if s == "#FFFFFF" => {}
                    _ => panic!("expected cursor_fg=#FFFFFF, got {:?}", cursor_value),
                }
            } else {
                panic!("expected Value::Object for colors, got {:?}", colors_value);
            }
        } else {
            panic!("expected Value::Object at top, got {:?}", v);
        }
    }

    #[test]
    fn default_overrides_returns_none_for_mid_grey() {
        // 0.5 sits in the mid-grey band — the function should
        // return None and let the upstream default take over.
        assert!(default_overrides(0.5, 0.5, 0.5).is_none());
    }
}
