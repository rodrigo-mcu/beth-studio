// wtinator::cursor_anim — patch 0042.
//
// macOS-style typing cursor: a smooth FADE blink.
//
// Upstream wezterm defaults the cursor-blink easing to `Linear` (a
// hard, linear fade) and the cursor style to `SteadyBlock` (no blink
// at all). The macOS Terminal / system text caret blinks with a soft
// ease-in / ease-out fade — the cursor melts out and back in instead
// of snapping on and off. This module returns config overrides that
// install that feel by default.
//
// It is applied as one of the WezTerminator config-override passes in
// `TermWindow::new_window` (alongside titlebar / vscode_font /
// cursor_color). The user's own `wezterm.lua` still wins, because the
// user config is merged on top of these defaults.

use wezterm_dynamic::{Object, Value};

/// Blink period in milliseconds. ~600ms reads as a calm, deliberate
/// pulse close to the macOS caret cadence; the easing below keeps each
/// transition soft rather than abrupt.
const CURSOR_BLINK_RATE_MS: u64 = 600;

/// Build the cursor-animation config overrides:
///
/// ```json
/// {
///   "default_cursor_style": "BlinkingBlock",
///   "cursor_blink_ease_in":  "Constant",
///   "cursor_blink_ease_out": "Constant",
///   "cursor_blink_rate": 600,
///   "max_fps": 60,
///   "animation_fps": 1
/// }
/// ```
///
/// `BlinkingBlock` keeps a visible caret. Constant easing is a cheap
/// on/off (patch 0114) instead of a GPU fade. `EasingFunction` and
/// `DefaultCursorStyle` deserialize from their name string.
pub fn default_overrides() -> Option<Value> {
    let mut map = Object::default();
    map.insert(
        Value::String("default_cursor_style".to_string()),
        Value::String("BlinkingBlock".to_string()),
    );
    // Patch 0114: Constant easing is a 1-frame on/off, not a 10 fps
    // fade. EaseInOut scheduled a GPU frame for the whole blink
    // period and made typing hitch on Windows.
    map.insert(
        Value::String("cursor_blink_ease_in".to_string()),
        Value::String("Constant".to_string()),
    );
    map.insert(
        Value::String("cursor_blink_ease_out".to_string()),
        Value::String("Constant".to_string()),
    );
    map.insert(
        Value::String("cursor_blink_rate".to_string()),
        Value::U64(CURSOR_BLINK_RATE_MS),
    );
    map.insert(
        Value::String("max_fps".to_string()),
        Value::U64(60),
    );
    map.insert(
        Value::String("animation_fps".to_string()),
        Value::U64(1),
    );
    // Patch 0119: spend a little RAM/latency so ConPTY floods (Tab
    // completion) become one paint, not dozens of full reshapes.
    map.insert(
        Value::String("mux_output_parser_coalesce_delay_ms".to_string()),
        Value::U64(12),
    );
    map.insert(
        Value::String("line_quad_cache_size".to_string()),
        Value::U64(4096),
    );
    map.insert(
        Value::String("line_state_cache_size".to_string()),
        Value::U64(4096),
    );
    map.insert(
        Value::String("line_to_ele_shape_cache_size".to_string()),
        Value::U64(4096),
    );
    // WezTerminator (patch 0044): the cursor follows the FONT colour
    // (reverse-video) instead of a fixed theme cursor colour — the block
    // shows the cell's foreground and the glyph under it the background.
    // The glide overlay matches by drawing in `foreground`.
    map.insert(
        Value::String("force_reverse_video_cursor".to_string()),
        Value::Bool(true),
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
    fn default_overrides_is_an_object() {
        let v = default_overrides().expect("returns Some");
        assert!(matches!(v, Value::Object(_)));
    }

    #[test]
    fn default_overrides_sets_smooth_blinking_block() {
        let v = default_overrides().unwrap();
        let Value::Object(map) = v else {
            panic!("expected Value::Object");
        };
        assert_eq!(
            map.get_by_str("default_cursor_style"),
            Some(&Value::String("BlinkingBlock".to_string()))
        );
        assert_eq!(
            map.get_by_str("cursor_blink_ease_in"),
            Some(&Value::String("Constant".to_string()))
        );
        assert_eq!(
            map.get_by_str("cursor_blink_ease_out"),
            Some(&Value::String("Constant".to_string()))
        );
        assert_eq!(
            map.get_by_str("cursor_blink_rate"),
            Some(&Value::U64(CURSOR_BLINK_RATE_MS))
        );
        assert_eq!(map.get_by_str("max_fps"), Some(&Value::U64(60)));
        assert_eq!(map.get_by_str("animation_fps"), Some(&Value::U64(1)));
    }
}
