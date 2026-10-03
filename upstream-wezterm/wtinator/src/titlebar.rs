// wtinator::titlebar — Phase 2.0 (patch 0020).
//
// The WezTerminator default UI replaces the native Win32 window
// title bar with a custom-drawn one that hosts the terminal tabs.
// The upstream `wezterm-gui` already implements the custom
// title bar via the `fancy_tab_bar` renderer — it is gated on
// `config.window_decorations = "INTEGRATED_BUTTONS"` (and is
// the default when `use_fancy_tab_bar = true`).
//
// This module owns the **default config overrides** that the
// WezTerminator binary applies to the user's config when no
// override is present. The overrides do two things:
//
//   1. Strip the native title bar (`window_decorations` is
//      reduced to `RESIZE` + `INTEGRATED_BUTTONS`, removing the
//      `TITLE` bit).
//   2. Force `use_fancy_tab_bar = true` so the upstream renders
//      the custom title bar + tabs as a single block.
//
// The user can override either of these in their `wezterm.lua`
// by setting `config.window_decorations = ...` or
// `config.use_fancy_tab_bar = false`. The overrides are
// "default-only": if the user already set a value, we leave
// their setting alone (we apply the override to the **merged**
// config in `wezterm-gui`).
//
// ## Why the `RESIZE` + `INTEGRATED_BUTTONS` combination
//
//   - `TITLE` (bit 0x01) gives you a native Windows title bar
//     that draws over our fancy tab bar.
//   - `RESIZE` (bit 0x02) keeps the OS resize border.
//   - `INTEGRATED_BUTTONS` (bit 0x10) signals to the upstream
//     that the close/min/max buttons are drawn into the
//     fancy tab bar instead of the OS chrome.
//   - `NONE` (0x00) gives you a truly borderless window — useful
//     but unusual; we leave it to the user to opt in.

use wezterm_dynamic::{Array, Object, Value};

/// The default WezTerminator config overrides.
///
/// Returned as `Some(Value)` from `install()` and applied by the
/// patched upstream `TermWindow::new_window` to the freshly
/// created window's `config_overrides` slot. The user can
/// override by setting the corresponding `config` keys in their
/// `wezterm.lua`.
pub fn default_overrides() -> Option<Value> {
    let mut map = Object::default();

    // WindowDecorations accepts a pipe-separated string of
    // names (parsed by `TryFrom<String>` in
    // `wezterm-input-types/src/lib.rs`). We do **not** pass a
    // bit-packed integer because the upstream
    // `#[derive(FromDynamic)]` on `WindowDecorations` does not
    // accept numbers — the parser would fail and the override
    // would be silently dropped.
    //
    // The combined set is:
    //   TITLE              (drop — we want no native title bar)
    //   RESIZE             (keep — we want a resize border)
    //   INTEGRATED_BUTTONS (add  — wezterm draws the buttons)
    map.insert(
        Value::String("window_decorations".to_string()),
        Value::String("RESIZE|INTEGRATED_BUTTONS".to_string()),
    );

    // Force the fancy tab bar even if the user disabled it. The
    // user can still override by setting `use_fancy_tab_bar =
    // false` *after* `wtinator::install()` runs (the user's
    // setting takes precedence over the override applied here).
    map.insert(
        Value::String("use_fancy_tab_bar".to_string()),
        Value::Bool(true),
    );

    map.insert(
        Value::String("integrated_title_button_alignment".to_string()),
        Value::String("Right".to_string()),
    );
    map.insert(
        Value::String("integrated_title_button_style".to_string()),
        Value::String("Windows".to_string()),
    );
    map.insert(
        Value::String("integrated_title_buttons".to_string()),
        Value::Array(Array::from(vec![
            Value::String("Hide".to_string()),
            Value::String("Maximize".to_string()),
            Value::String("Close".to_string()),
        ])),
    );

    // WezTerminator (patch 0032): force the per-tab
    // close X to be visible in the fancy tab bar. The
    // upstream default is `true` but pinning it here
    // makes the WezTerminator intent explicit and
    // protects against a user config that turns it
    // off. The user can still override via
    // wezterm.lua (user config wins in the merge
    // order) so this is opt-out rather than opt-in.
    //
    // Why this matters: if a terminal ever freezes
    // (the user reported a case on 2026-06-12 where
    // they could not close a hung tab), the X close
    // button on the tab is the only way to kill the
    // tab from the mouse without reaching for the
    // task manager. The click handler shows a real
    // Win32 messagebox (see wtinator::confirm) so
    // the confirmation is guaranteed to respond even
    // when the UI thread is busy.
    map.insert(
        Value::String("show_close_tab_button_in_tabs".to_string()),
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
        let v = default_overrides().expect("default_overrides returns Some");
        match v {
            Value::Object(_) => {}
            _ => panic!("expected Value::Object, got {:?}", v),
        }
    }

    #[test]
    fn default_overrides_has_window_decorations() {
        let v = default_overrides().unwrap();
        if let Value::Object(map) = v {
            let value = map
                .get_by_str("window_decorations")
                .expect("window_decorations key present");
            // `WindowDecorations` is parsed from a pipe-separated
            // string of names (see `wezterm-input-types`'s
            // `TryFrom<String> for WindowDecorations`). The
            // expected value combines `RESIZE` and
            // `INTEGRATED_BUTTONS` while omitting `TITLE`.
            match value {
                Value::String(s) if s == "RESIZE|INTEGRATED_BUTTONS" => {}
                _ => panic!(
                    "expected window_decorations=\"RESIZE|INTEGRATED_BUTTONS\", got {:?}",
                    value
                ),
            }
        } else {
            unreachable!()
        }
    }

    #[test]
    fn default_overrides_enables_fancy_tab_bar() {
        let v = default_overrides().unwrap();
        if let Value::Object(map) = v {
            let value = map
                .get_by_str("use_fancy_tab_bar")
                .expect("use_fancy_tab_bar key present");
            assert_eq!(*value, Value::Bool(true));
        } else {
            unreachable!()
        }
    }

    #[test]
    fn default_overrides_enables_right_side_window_buttons() {
        let v = default_overrides().unwrap();
        if let Value::Object(map) = v {
            assert_eq!(
                *map.get_by_str("integrated_title_button_alignment")
                    .expect("integrated_title_button_alignment key present"),
                Value::String("Right".to_string())
            );
            assert_eq!(
                *map.get_by_str("integrated_title_button_style")
                    .expect("integrated_title_button_style key present"),
                Value::String("Windows".to_string())
            );
            match map
                .get_by_str("integrated_title_buttons")
                .expect("integrated_title_buttons key present")
            {
                Value::Array(buttons) => {
                    let names: Vec<_> = buttons
                        .iter()
                        .map(|button| match button {
                            Value::String(name) => name.as_str(),
                            other => panic!("expected button name string, got {:?}", other),
                        })
                        .collect();
                    assert_eq!(names, vec!["Hide", "Maximize", "Close"]);
                }
                other => panic!("expected integrated_title_buttons array, got {:?}", other),
            }
        } else {
            unreachable!()
        }
    }

    /// WezTerminator (patch 0032): the per-tab close
    /// X must be visible so the user can close a
    /// frozen terminal from the mouse. The upstream
    /// default is `true`; we pin it explicitly so
    /// the intent is documented and so a user config
    /// flip cannot silently regress it.
    #[test]
    fn default_overrides_pins_close_tab_button_on() {
        let v = default_overrides().unwrap();
        if let Value::Object(map) = v {
            assert_eq!(
                *map.get_by_str("show_close_tab_button_in_tabs")
                    .expect("show_close_tab_button_in_tabs key present"),
                Value::Bool(true)
            );
        } else {
            unreachable!()
        }
    }
}
