//! WezTerminator (patch 0065): the per-tab "pane tab bar".
//!
//! A SECOND tab bar — same height as the top one — drawn directly below it. It
//! RESERVES its own vertical space (see `pane_strip_pixel_height`, consumed by
//! `resize.rs` to shrink terminal rows and by `render/pane.rs` to push content
//! down), so the terminal sits below it and is never covered. One chip per pane
//! in the active tab (header text), the active one highlighted, plus a trailing
//! "+" chip. Left-click a chip → show that terminal full-area (zoom); click it
//! again → back to the split. Right-click a chip → the normal context menu for
//! that terminal. "+" → new terminal.

use crate::quad::TripleLayerQuadAllocator;
use crate::termwindow::render::RenderScreenLineParams;
use crate::termwindow::{UIItem, UIItemType};
use mux::renderable::RenderableDimensions;
use mux::tab::Tab;
use std::sync::Arc;
use termwiz::color::SrgbaTuple;
use window::color::LinearRgba;

impl crate::TermWindow {
    /// Reserved height (pixels) of the pane-tab strip — matches the top tab bar
    /// height when the active tab is in list mode, else 0. SINGLE source of
    /// truth used by `resize.rs`, `render/pane.rs` and the renderer below.
    pub fn pane_strip_pixel_height(&self) -> f32 {
        // BethTerm (patch 0124): the dashboard is the navigator; hide the
        // list-mode split strip so the right side is one terminal.
        if crate::tabbar::is_wtinator_active()
            && wtinator::dashboard::is_open(self.mux_window_id)
        {
            return 0.;
        }
        let on = mux::Mux::try_get()
            .and_then(|m| m.get_active_tab_for_window(self.mux_window_id))
            .map(|t| t.list_mode())
            .unwrap_or(false);
        if on {
            self.tab_bar_pixel_height()
                .unwrap_or(self.render_metrics.cell_size.height as f32)
        } else {
            0.
        }
    }

    /// True when the active tab is in list mode (the pane-tab bar is shown).
    pub fn is_list_mode_active(&self, tab: &Arc<Tab>) -> bool {
        tab.list_mode()
    }

    pub fn paint_pane_tabs(&mut self, layers: &mut TripleLayerQuadAllocator) -> anyhow::Result<()> {
        let mux = mux::Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(t) => t,
            None => return Ok(()),
        };
        if !self.is_list_mode_active(&tab) {
            return Ok(());
        }
        let strip_h = self.pane_strip_pixel_height();
        if strip_h <= 0. {
            return Ok(());
        }

        let panes = tab.iter_panes_ignoring_zoom();
        let active_id = panes
            .iter()
            .find(|p| p.is_active)
            .or_else(|| panes.first())
            .map(|p| p.pane.pane_id());

        let border = self.get_os_border();
        let cell_width = self.render_metrics.cell_size.width as f32;
        let cell_height = self.render_metrics.cell_size.height as f32;

        let real_tab_bar = if self.show_tab_bar && !self.config.tab_bar_at_bottom {
            self.tab_bar_pixel_height().unwrap_or(0.)
        } else {
            0.
        };
        let left0 = border.left.get() as f32;
        let strip_y = border.top.get() as f32 + real_tab_bar;
        let strip_w = self.dimensions.pixel_width as f32;
        let text_y = strip_y + ((strip_h - cell_height) / 2.0).max(0.0);

        let palette = self.palette().clone();
        let fg = palette.foreground;
        let bg = palette.background;
        let sel_fg = palette.selection_fg;
        let sel_bg = palette.selection_bg;
        let strip_bg = lerp(bg, fg, 0.08);
        let sep = lerp(bg, fg, 0.25);

        // strip background (full width) + a separator line at the bottom.
        self.filled_rectangle(
            layers,
            0,
            euclid::rect(left0, strip_y, strip_w, strip_h),
            strip_bg.to_linear(),
        )?;
        self.filled_rectangle(
            layers,
            1,
            euclid::rect(left0, strip_y + strip_h - 1.5, strip_w, 1.5),
            sep.to_linear(),
        )?;

        struct Chip {
            text: String,
            x: f32,
            w: f32,
            cols: usize,
            fg: SrgbaTuple,
            bg: SrgbaTuple,
            item: UIItemType,
        }
        let gap = 2.0_f32;
        let mut chips: Vec<Chip> = Vec::new();
        let mut x = left0;
        for (i, pp) in panes.iter().enumerate() {
            let pane_id = pp.pane.pane_id();
            let is_active = Some(pane_id) == active_id;
            let has_bell = self.pane_state(pane_id).bell_start.is_some();
            let raw = pp
                .pane
                .get_header_text()
                .unwrap_or_else(|| format!("term {}", i + 1));
            let label: String = raw.chars().take(20).collect();
            let dot = if has_bell { "\u{25cf} " } else { "" };
            let text = format!("  {}{}  ", dot, label);
            let cols = text.chars().count().max(3);
            let w = cols as f32 * cell_width;
            if x + w > strip_w {
                break;
            }
            let (cfg, cbg) = if is_active {
                (sel_fg, sel_bg)
            } else {
                (fg, strip_bg)
            };
            chips.push(Chip {
                text,
                x,
                w,
                cols,
                fg: cfg,
                bg: cbg,
                item: UIItemType::RailEntry { pane_id, ordinal: i },
            });
            x += w + gap;
        }
        {
            let text = "  +  ".to_string();
            let cols = text.chars().count();
            let w = cols as f32 * cell_width;
            if x + w <= strip_w {
                chips.push(Chip {
                    text,
                    x,
                    w,
                    cols,
                    fg,
                    bg: strip_bg,
                    item: UIItemType::PaneTabNew,
                });
            }
        }

        let window_is_transparent =
            !self.window_background.is_empty() || self.config.window_background_opacity != 1.0;
        let gl_state = self.render_state.as_ref().unwrap();
        let white_space = gl_state.util_sprites.white_space.texture_coords();
        let filled_box = gl_state.util_sprites.filled_box.texture_coords();

        for chip in &chips {
            // chip background fills the full strip height (tab-segment look).
            self.filled_rectangle(
                layers,
                0,
                euclid::rect(chip.x, strip_y, (chip.w - gap).max(1.0), strip_h),
                chip.bg.to_linear(),
            )?;
            let line =
                wtinator::header::build_header_line_themed(&chip.text, chip.cols, chip.fg, chip.bg);
            let dims = RenderableDimensions {
                cols: chip.cols,
                physical_top: 0,
                scrollback_rows: 0,
                scrollback_top: 0,
                viewport_rows: 1,
                dpi: self.terminal_size.dpi,
                pixel_height: cell_height as usize,
                pixel_width: chip.w as usize,
                reverse_video: false,
            };
            self.render_screen_line(
                RenderScreenLineParams {
                    top_pixel_y: text_y,
                    left_pixel_x: chip.x,
                    pixel_width: chip.w,
                    stable_line_idx: None,
                    line: &line,
                    selection: 0..0,
                    cursor: &Default::default(),
                    palette: &palette,
                    dims: &dims,
                    config: &self.config,
                    cursor_border_color: LinearRgba::default(),
                    foreground: chip.fg.to_linear(),
                    pane: None,
                    is_active: true,
                    selection_fg: LinearRgba::default(),
                    selection_bg: LinearRgba::default(),
                    cursor_fg: LinearRgba::default(),
                    cursor_bg: LinearRgba::default(),
                    cursor_is_default_color: true,
                    white_space,
                    filled_box,
                    window_is_transparent,
                    default_bg: chip.bg.to_linear(),
                    style: None,
                    font: None,
                    use_pixel_positioning: self.config.experimental_pixel_positioning,
                    render_metrics: self.render_metrics,
                    shape_key: None,
                    password_input: false,
                },
                layers,
            )?;
            self.ui_items.push(UIItem {
                x: chip.x as usize,
                y: strip_y as usize,
                width: (chip.w - gap).max(1.0) as usize,
                height: strip_h as usize,
                item_type: chip.item.clone(),
            });
        }

        Ok(())
    }
}

/// Linear blend from `a` to `b` by `t` (0..1), in srgb space.
fn lerp(a: SrgbaTuple, b: SrgbaTuple, t: f32) -> SrgbaTuple {
    SrgbaTuple(
        a.0 + (b.0 - a.0) * t,
        a.1 + (b.1 - a.1) * t,
        a.2 + (b.2 - a.2) * t,
        1.0,
    )
}
