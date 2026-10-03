// wtinator::vscode_theme — Phase 1.5 (patch 0016.1).
//
// Three color schemes baked into the binary, inspired by current
// (2026) defaults from Visual Studio Code and Windows Terminal:
//
//   - `vscode_light`           — VS Code "Default Light Modern"
//                                (light background, dark text, dark
//                                ANSI palette tuned for light mode).
//   - `vscode_dark`            — VS Code "Default Dark Modern"
//                                (dark background, light text).
//   - `windows_terminal_dark`  — Windows Terminal "Campbell
//                                Powershell" colors (the dark
//                                default on Windows 11).
//
// Each scheme returns a fully-populated `term::color::ColorPalette`
// so that `TermWindow::set_color_scheme(palette)` (added in patch
// 0016.2) can install it without further derivation. The 16-color
// ANSI palette + foreground/background/cursor/selection colors
// are derived from the published color tables of each product; the
// 240 indexed colors (16..255) are a 6×6×6 RGB cube interpolated
// from the 16 ANSI colors per the xterm default, which is what all
// three products use in practice.
//
// Why bake them in (and not read from the user config): the menu
// entry needs to be a single click with no config reload. Reading
// the user's `~/.wezterm.lua` color_schemes at click time is
// possible but adds 100ms+ to the menu open (file parse + Lua
// callback). The baked-in schemes cover the user's request ("one
// that looks like VSCode light, one that looks like my Windows
// Terminal dark") at zero config cost; user-defined schemes remain
// available via `config.color_schemes` in their wezterm.lua.

use wezterm_term::color::{ColorPalette, Palette256, SrgbaTuple};

/// Convert 8-bit RGB to a normalised `SrgbaTuple`.
#[inline]
fn srgba(r: u8, g: u8, b: u8) -> SrgbaTuple {
    SrgbaTuple(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0)
}

/// Build the 256-color palette (16 ANSI + 240 cube + 24 greys)
/// used by all three schemes. The 6×6×6 RGB cube and 24-step grey
/// ramp are the xterm default.
///
/// `pub(crate)` since patch 0038: the theme downloader
/// (`theme_download::palette_for_saved`) reuses this exact 240-cube
/// + 24-grey derivation so a downloaded theme's indexed colours
/// match the baked-in themes.
pub(crate) fn palette256(ansi: [SrgbaTuple; 16]) -> Palette256 {
    let mut colors = vec![srgba(0, 0, 0); 256];

    // ANSI 0..15
    for (i, c) in ansi.iter().enumerate() {
        colors[i] = *c;
    }

    // 6×6×6 colour cube (indices 16..231)
    let levels: [u8; 6] = [0, 95, 135, 175, 215, 255];
    for r in 0..6 {
        for g in 0..6 {
            for b in 0..6 {
                let idx = 16 + 36 * r + 6 * g + b;
                colors[idx] = srgba(levels[r], levels[g], levels[b]);
            }
        }
    }

    // 24-step greyscale ramp (232..255)
    for i in 0..24 {
        let v = (8 + 10 * i) as u8;
        colors[232 + i] = srgba(v, v, v);
    }

    Palette256(colors.try_into().expect("256 elements"))
}

/// Build a 16-color ANSI palette from 8 base + 8 bright colors.
///
/// `pub(crate)` since patch 0038: see `palette256` above.
pub(crate) fn ansi_16(normal: [SrgbaTuple; 8], bright: [SrgbaTuple; 8]) -> [SrgbaTuple; 16] {
    let mut out: [SrgbaTuple; 16] = [srgba(0, 0, 0); 16];
    for (i, c) in normal.iter().enumerate() {
        out[i] = *c;
    }
    for (i, c) in bright.iter().enumerate() {
        out[8 + i] = *c;
    }
    out
}

// ---------------------------------------------------------------------------
// VSCode Light (Default Light Modern, 2026)
// ---------------------------------------------------------------------------

/// VS Code "Default Light Modern" (2026). Approximates the
/// published token colors of the official Light+ theme:
///   background `#FFFFFF`, foreground `#1F1F1F`,
///   cursor `#1F1F1F`, selection bg `#ADD6FF`.
pub fn vscode_light() -> ColorPalette {
    let fg = srgba(31, 31, 31);
    let bg = srgba(255, 255, 255);
    let cursor = srgba(0, 0, 0);
    let sel_fg = srgba(0, 0, 0);
    let sel_bg = srgba(173, 214, 255);

    // 8 normal ANSI — Light+ palette (saturated for visibility on white)
    let normal = [
        srgba(0, 0, 0),       // black
        srgba(205, 49, 49),   // red
        srgba(0, 128, 0),     // green
        srgba(184, 134, 11),  // yellow
        srgba(38, 79, 120),   // blue
        srgba(128, 0, 128),   // magenta
        srgba(0, 128, 128),   // cyan
        srgba(85, 85, 85),    // white
    ];
    // 8 bright ANSI
    let bright = [
        srgba(128, 128, 128), // bright black
        srgba(241, 76, 76),   // bright red
        srgba(0, 200, 0),     // bright green
        srgba(229, 181, 103), // bright yellow
        srgba(86, 156, 214),  // bright blue
        srgba(200, 110, 200), // bright magenta
        srgba(0, 188, 188),   // bright cyan
        srgba(180, 180, 180), // bright white
    ];
    let ansi = ansi_16(normal, bright);

    ColorPalette {
        colors: palette256(ansi),
        foreground: fg,
        background: bg,
        cursor_fg: bg,
        cursor_bg: cursor,
        cursor_border: cursor,
        selection_fg: sel_fg,
        selection_bg: sel_bg,
        scrollbar_thumb: srgba(200, 200, 200),
        split: srgba(200, 200, 200),
    }
}

// ---------------------------------------------------------------------------
// VSCode Dark (Default Dark Modern, 2026)
// ---------------------------------------------------------------------------

/// VS Code "Default Dark Modern" (2026). Approximates the
/// published token colors of the official Dark+ theme:
///   background `#1F1F1F`, foreground `#D4D4D4`,
///   cursor `#AEAFAD`, selection bg `#264F78`.
pub fn vscode_dark() -> ColorPalette {
    let fg = srgba(212, 212, 212);
    let bg = srgba(30, 30, 30);
    let cursor = srgba(174, 175, 173);
    let sel_fg = srgba(255, 255, 255);
    let sel_bg = srgba(38, 79, 120);

    // 8 normal ANSI — Dark+ palette (saturated for dark BG)
    let normal = [
        srgba(0, 0, 0),       // black
        srgba(205, 49, 49),   // red
        srgba(0, 176, 80),    // green
        srgba(229, 229, 16),  // yellow
        srgba(0, 112, 221),   // blue
        srgba(188, 63, 188),  // magenta
        srgba(0, 176, 240),   // cyan
        srgba(212, 212, 212), // white
    ];
    // 8 bright ANSI
    let bright = [
        srgba(128, 128, 128),  // bright black
        srgba(255, 99, 99),    // bright red
        srgba(0, 226, 110),    // bright green
        srgba(255, 244, 119),  // bright yellow
        srgba(99, 178, 255),   // bright blue
        srgba(255, 119, 255),  // bright magenta
        srgba(99, 215, 255),   // bright cyan
        srgba(255, 255, 255),  // bright white
    ];
    let ansi = ansi_16(normal, bright);

    ColorPalette {
        colors: palette256(ansi),
        foreground: fg,
        background: bg,
        // Patch 0024-fix: `cursor_bg` was set to `bg` here, which made
        // the default BlinkingBlock cursor invisible — wezterm paints
        // the whole cell with `cursor_bg` and the block then has the
        // same colour as the cells around it, so the cursor effectively
        // disappears (especially when blinking "off"). The patch 0024
        // `cursor_fg` override only fixes the foreground text, not the
        // block fill, so the bug survived the override.
        //
        // The fix mirrors what `vscode_light()` does: set `cursor_bg`
        // to the same value as `cursor` (the VSCode Default Dark
        // Modern cursor colour `#AEAFAD`) so the block is a visible
        // light-grey rectangle against the dark background. This is
        // also what VSCode itself paints for the editor cursor.
        cursor_fg: cursor,
        cursor_bg: cursor,
        cursor_border: cursor,
        selection_fg: sel_fg,
        selection_bg: sel_bg,
        scrollbar_thumb: srgba(80, 80, 80),
        split: srgba(80, 80, 80),
    }
}

// ---------------------------------------------------------------------------
// Windows Terminal Dark (Campbell Powershell — Windows 11 default)
// ---------------------------------------------------------------------------

/// Windows Terminal "Campbell Powershell" (the dark default that
/// ships with Windows Terminal 1.18+). Background `#0C0C0C`,
/// foreground `#CCCCCC`, cursor `#FFFFFF`, selection bg `#063462`.
pub fn windows_terminal_dark() -> ColorPalette {
    let fg = srgba(204, 204, 204);
    let bg = srgba(12, 12, 12);
    let cursor = srgba(255, 255, 255);
    let sel_fg = srgba(255, 255, 255);
    let sel_bg = srgba(6, 52, 98);

    // 8 normal ANSI — Campbell (the historical Windows console palette)
    let normal = [
        srgba(12, 12, 12),     // black
        srgba(197, 15, 31),    // red
        srgba(19, 161, 14),    // green
        srgba(193, 156, 0),    // yellow
        srgba(0, 0, 240),      // blue
        srgba(136, 23, 152),   // magenta
        srgba(58, 150, 221),   // cyan
        srgba(204, 204, 204),  // white
    ];
    // 8 bright ANSI — Campbell bright (slightly lighter)
    let bright = [
        srgba(118, 118, 118),  // bright black
        srgba(231, 72, 86),    // bright red
        srgba(22, 198, 12),    // bright green
        srgba(249, 241, 165),  // bright yellow
        srgba(59, 120, 255),   // bright blue
        srgba(180, 0, 158),    // bright magenta
        srgba(97, 214, 214),   // bright cyan
        srgba(242, 242, 242),  // bright white
    ];
    let ansi = ansi_16(normal, bright);

    ColorPalette {
        colors: palette256(ansi),
        foreground: fg,
        background: bg,
        // Patch 0024-fix (sibling of vscode_dark): the original
        // value was `cursor_bg = bg` which made the BlinkingBlock
        // cursor invisible (wezterm paints the whole cell with
        // `cursor_bg`). Set it to `cursor` (white `#FFFFFF`) so the
        // cursor block is visible against the dark `#0C0C0C`
        // background. The test `cursor_bg_must_contrast_with_background`
        // guards both dark themes against this regression.
        cursor_fg: cursor,
        cursor_bg: cursor,
        cursor_border: cursor,
        selection_fg: sel_fg,
        selection_bg: sel_bg,
        scrollbar_thumb: srgba(80, 80, 80),
        split: srgba(80, 80, 80),
    }
}

/// Identifier of a built-in theme. Returned to the upstream
/// caller so it can pick the right `ColorPalette` factory.
///
/// The numeric values are also the offset into the `0x5001..=0x5003`
/// `wID` range used by the right-click "Theme" submenu — do not
/// reorder without also updating `NativeCommand::SetTheme(theme) as u16`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum ThemeId {
    VsCodeLight = 0,
    VsCodeDark = 1,
    WindowsTerminalDark = 2,
}

impl ThemeId {
    /// Construct the matching `ColorPalette`.
    pub fn build_palette(self) -> ColorPalette {
        match self {
            ThemeId::VsCodeLight => vscode_light(),
            ThemeId::VsCodeDark => vscode_dark(),
            ThemeId::WindowsTerminalDark => windows_terminal_dark(),
        }
    }

    /// Human-readable name (used in the menu and in logs).
    pub fn name(self) -> &'static str {
        match self {
            ThemeId::VsCodeLight => "VSCode Light",
            ThemeId::VsCodeDark => "VSCode Dark",
            ThemeId::WindowsTerminalDark => "Windows Terminal Dark",
        }
    }

    /// Alias for `name()` (used by `wtinator::notify`).
    pub fn display_name(self) -> &'static str {
        self.name()
    }

    /// Stable string id used as the wire-format
    /// theme id (matches the `id_str` field of
    /// `wtinator::notify::ThemeSnapshot`). Used by
    /// the named-pipe IPC contract.
    pub fn id_str(self) -> &'static str {
        match self {
            ThemeId::VsCodeLight => "vscode_light",
            ThemeId::VsCodeDark => "vscode_dark",
            ThemeId::WindowsTerminalDark => "windows_terminal_dark",
        }
    }

    /// All built-in themes, in the same order as
    /// the `0x5001..=0x5003` wID range. Used by
    /// `wtinator::notify::snapshot_for_config` to
    /// enumerate the theme list sent to the config
    /// app on startup.
    pub fn iter() -> impl Iterator<Item = ThemeId> {
        [
            ThemeId::VsCodeLight,
            ThemeId::VsCodeDark,
            ThemeId::WindowsTerminalDark,
        ]
        .into_iter()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette256_contains_256_entries() {
        let p = palette256([srgba(0, 0, 0); 16]);
        assert_eq!(p.0.len(), 256);
    }

    #[test]
    fn ansi_16_includes_8_bright() {
        let normal = [srgba(0, 0, 0); 8];
        let bright = std::array::from_fn(|i| srgba(i as u8 * 30, 0, 0));
        let out = ansi_16(normal, bright);
        for i in 0..8 {
            assert_eq!(out[i], srgba(0, 0, 0));
        }
        for i in 0..8 {
            assert_eq!(out[8 + i], srgba(i as u8 * 30, 0, 0));
        }
    }

    #[test]
    fn all_three_schemes_have_distinct_backgrounds() {
        let light = vscode_light();
        let dark = vscode_dark();
        let wt = windows_terminal_dark();
        assert_ne!(light.background, dark.background);
        assert_ne!(dark.background, wt.background);
        assert_ne!(light.background, wt.background);
    }

    #[test]
    fn theme_id_build_palette_round_trip() {
        // Building via the enum should give the same result as the
        // direct constructor for each variant.
        assert_eq!(
            ThemeId::VsCodeLight.build_palette().background,
            vscode_light().background
        );
        assert_eq!(
            ThemeId::VsCodeDark.build_palette().foreground,
            vscode_dark().foreground
        );
        assert_eq!(
            ThemeId::WindowsTerminalDark.build_palette().cursor_border,
            windows_terminal_dark().cursor_border
        );
    }

    #[test]
    fn srgba_conversion_is_in_unit_range() {
        let c = srgba(0, 0, 0);
        assert_eq!(c, SrgbaTuple(0.0, 0.0, 0.0, 1.0));
        let c = srgba(255, 255, 255);
        assert_eq!(c, SrgbaTuple(1.0, 1.0, 1.0, 1.0));
        let c = srgba(128, 64, 32);
        assert_eq!(
            c,
            SrgbaTuple(128.0 / 255.0, 64.0 / 255.0, 32.0 / 255.0, 1.0)
        );
    }

    /// Regression test for the "invisible cursor on VSCode Dark"
    /// bug: wezterm renders the BlinkingBlock cursor by painting
    /// the whole cell with `cursor_bg`, so if `cursor_bg` equals
    /// `background` the cursor is the same colour as the cells
    /// around it and the user can no longer find it. The fix in
    /// `vscode_dark()` sets `cursor_bg = cursor` (the VSCode Dark
    /// Modern cursor colour `#AEAFAD`) so the block stays
    /// visible. Both dark schemes must satisfy this property.
    #[test]
    fn cursor_bg_must_contrast_with_background() {
        let dark = vscode_dark();
        let wt = windows_terminal_dark();
        assert_ne!(
            dark.cursor_bg, dark.background,
            "vscode_dark: cursor_bg == background would make the BlinkingBlock cursor invisible"
        );
        assert_ne!(
            wt.cursor_bg, wt.background,
            "windows_terminal_dark: cursor_bg == background would make the BlinkingBlock cursor invisible"
        );
    }
}
