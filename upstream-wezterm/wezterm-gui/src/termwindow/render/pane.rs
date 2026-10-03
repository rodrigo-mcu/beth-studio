use crate::quad::{HeapQuadAllocator, QuadTrait, TripleLayerQuadAllocator};
use crate::selection::SelectionRange;
use crate::termwindow::box_model::*;
use crate::termwindow::render::{
    same_hyperlink, CursorProperties, LineQuadCacheKey, LineQuadCacheValue, LineToEleShapeCacheKey,
    RenderScreenLineParams,
};
use crate::termwindow::prevcursor::{
    CursorGlideState, GLIDE_DURATION_MS, GLIDE_MAX_CELLS, GLIDE_SETTLE_PX,
};
use crate::termwindow::{ScrollHit, UIItem, UIItemType};
use crate::utilsprites::RenderMetrics;
use ::termwiz::surface::{CursorShape, CursorVisibility};
use ::window::bitmaps::TextureRect;
use ::window::{DeadKeyStatus, RectF};
use anyhow::Context;
use config::VisualBellTarget;
use mux::pane::{PaneId, WithPaneLines};
use mux::renderable::{RenderableDimensions, StableCursorPosition};
use mux::tab::PositionedPane;
use ordered_float::NotNan;
use std::rc::Rc;
use std::time::Instant;
use wezterm_dynamic::Value;
use wezterm_term::color::{ColorAttribute, ColorPalette};
use wezterm_term::{Line, StableRowIndex};
use window::color::LinearRgba;

impl crate::TermWindow {
    fn paint_pane_box_model(&mut self, pos: &PositionedPane) -> anyhow::Result<()> {
        let computed = self.build_pane(pos)?;
        let mut ui_items = computed.ui_items();
        self.ui_items.append(&mut ui_items);
        let gl_state = self.render_state.as_ref().unwrap();
        self.render_element(&computed, gl_state, None)
    }

    pub fn paint_pane(
        &mut self,
        pos: &PositionedPane,
        layers: &mut TripleLayerQuadAllocator,
    ) -> anyhow::Result<()> {
        if self.config.use_box_model_render {
            return self.paint_pane_box_model(pos);
        }

        self.check_for_dirty_lines_and_invalidate_selection(&pos.pane);
        /*
        let zone = {
            let dims = pos.pane.get_dimensions();
            let position = self
                .get_viewport(pos.pane.pane_id())
                .unwrap_or(dims.physical_top);

            let zones = self.get_semantic_zones(&pos.pane);
            let idx = match zones.binary_search_by(|zone| zone.start_y.cmp(&position)) {
                Ok(idx) | Err(idx) => idx,
            };
            let idx = ((idx as isize) - 1).max(0) as usize;
            zones.get(idx).cloned()
        };
        */

        let global_cursor_fg = self.palette().cursor_fg;
        let global_cursor_bg = self.palette().cursor_bg;
        let config = self.config.clone();
        let palette = pos.pane.palette();

        // WezTerminator (patch 0039 + 0043): per-pane font override. The
        // pane's POSITION/RECT is laid out in the window's BASE cell
        // metrics (self.render_metrics), but the pane's CONTENT grid is
        // drawn at its own override cell metrics. `pane_metrics`/
        // `pane_fonts` are the override metrics for this pane (== window
        // metrics when there is no size scale AND no family override).
        // The background/divider/outline math below keeps using BASE
        // metrics; only the line content uses pane_metrics.
        let pane_scale = pos.pane.get_font_scale();
        let pane_family = pos.pane.get_font_family();
        let pane_bold = pos.pane.get_font_bold();
        let pane_italic = pos.pane.get_font_italic();
        let (pane_fonts, pane_metrics) = self.fonts_and_metrics_for_pane_font(
            pane_scale,
            pane_family.as_deref(),
            pane_bold,
            pane_italic,
        );
        // NOTE (patch 0043): the render path no longer pushes the pane's
        // family ratio back to the mux. Doing it every paint made the
        // ratio a second writer racing the GUI's authoritative
        // `apply_pane_font_scale_change`, which regressed the size path.
        // The ratio is now computed and stored in ONE place (on apply /
        // in `ensure_pane_geometry`), so paint is read-only with respect
        // to pane geometry.

        let (padding_left, padding_top) = self.padding_left_top();

        let tab_bar_height = if self.show_tab_bar {
            self.tab_bar_pixel_height()
                .context("tab_bar_pixel_height")?
        } else {
            0.
        };
        let (top_bar_height, bottom_bar_height) = if self.config.tab_bar_at_bottom {
            (0.0, tab_bar_height)
        } else {
            (tab_bar_height, 0.0)
        };

        let border = self.get_os_border();
        // WezTerminator (patch 0065): push content below the pane-tab strip.
        let top_pixel_y =
            top_bar_height + self.pane_strip_pixel_height() + padding_top + border.top.get() as f32;

        let cursor = pos.pane.get_cursor_position();
        if pos.is_active {
            self.prev_cursor.update(&cursor);
        }

        let pane_id = pos.pane.pane_id();
        let current_viewport = self.get_viewport(pane_id);
        let dims = pos.pane.get_dimensions();

        let gl_state = self.render_state.as_ref().unwrap();

        let cursor_border_color = palette.cursor_border.to_linear();
        let foreground = palette.foreground.to_linear();
        let white_space = gl_state.util_sprites.white_space.texture_coords();
        let filled_box = gl_state.util_sprites.filled_box.texture_coords();

        let window_is_transparent =
            !self.window_background.is_empty() || config.window_background_opacity != 1.0;

        let default_bg = palette
            .resolve_bg(ColorAttribute::Default)
            .to_linear()
            .mul_alpha(if window_is_transparent {
                0.
            } else {
                config.text_background_opacity
            });

        let cell_width = self.render_metrics.cell_size.width as f32;
        let cell_height = self.render_metrics.cell_size.height as f32;
        let background_rect = {
            // We want to fill out to the edges of the splits
            let (x, width_delta) = if pos.left == 0 {
                (
                    0.,
                    padding_left + border.left.get() as f32 + (cell_width / 2.0),
                )
            } else {
                (
                    padding_left + border.left.get() as f32 - (cell_width / 2.0)
                        + (pos.left as f32 * cell_width),
                    cell_width,
                )
            };

            let (y, height_delta) = if pos.top == 0 {
                (
                    (top_pixel_y - padding_top),
                    padding_top + (cell_height / 2.0),
                )
            } else {
                (
                    top_pixel_y + (pos.top as f32 * cell_height) - (cell_height / 2.0),
                    cell_height,
                )
            };
            euclid::rect(
                x,
                y,
                // Go all the way to the right edge if we're right-most
                if pos.left + pos.width >= self.terminal_size.cols as usize {
                    self.dimensions.pixel_width as f32 - x
                } else {
                    (pos.width as f32 * cell_width) + width_delta
                },
                // Go all the way to the bottom if we're bottom-most
                if pos.top + pos.height >= self.terminal_size.rows as usize {
                    self.dimensions.pixel_height as f32 - y
                } else {
                    (pos.height as f32 * cell_height) + height_delta as f32
                },
            )
        };

        if self.window_background.is_empty() {
            // Per-pane, palette-specified background

            let mut quad = self
                .filled_rectangle(
                    layers,
                    0,
                    background_rect,
                    palette
                        .background
                        .to_linear()
                        .mul_alpha(config.window_background_opacity),
                )
                .context("filled_rectangle")?;
            quad.set_hsv(if pos.is_active {
                None
            } else {
                Some(config.inactive_pane_hsb)
            });
        }

        {
            // If the bell is ringing, we draw another background layer over the
            // top of this in the configured bell color
            if let Some(intensity) = self.get_intensity_if_bell_target_ringing(
                &pos.pane,
                &config,
                VisualBellTarget::BackgroundColor,
            ) {
                // target background color
                let LinearRgba(r, g, b, _) = config
                    .resolved_palette
                    .visual_bell
                    .as_deref()
                    .unwrap_or(&palette.foreground)
                    .to_linear();

                let background = if window_is_transparent {
                    // for transparent windows, we fade in the target color
                    // by adjusting its alpha
                    LinearRgba::with_components(r, g, b, intensity)
                } else {
                    // otherwise We'll interpolate between the background color
                    // and the target color
                    let (r1, g1, b1, a) = palette
                        .background
                        .to_linear()
                        .mul_alpha(config.window_background_opacity)
                        .tuple();
                    LinearRgba::with_components(
                        r1 + (r - r1) * intensity,
                        g1 + (g - g1) * intensity,
                        b1 + (b - b1) * intensity,
                        a,
                    )
                };
                log::trace!("bell color is {:?}", background);

                let mut quad = self
                    .filled_rectangle(layers, 0, background_rect, background)
                    .context("filled_rectangle")?;

                quad.set_hsv(if pos.is_active {
                    None
                } else {
                    Some(config.inactive_pane_hsb)
                });
            }
        }

        // TODO: we only have a single scrollbar in a single position.
        // We only update it for the active pane, but we should probably
        // do a per-pane scrollbar.  That will require more extensive
        // changes to ScrollHit, mouse positioning, PositionedPane
        // and tab size calculation.
        if pos.is_active && self.show_scroll_bar {
            let thumb_y_offset = top_bar_height as usize + border.top.get();

            let min_height = self.min_scroll_bar_height();

            let info = ScrollHit::thumb(
                &*pos.pane,
                current_viewport,
                self.dimensions.pixel_height.saturating_sub(
                    thumb_y_offset + border.bottom.get() + bottom_bar_height as usize,
                ),
                min_height as usize,
            );
            let abs_thumb_top = thumb_y_offset + info.top;
            let thumb_size = info.height;
            let color = palette.scrollbar_thumb.to_linear();

            // Adjust the scrollbar thumb position
            let config = &self.config;
            let padding = self.effective_right_padding(&config) as f32;

            let thumb_x = self.dimensions.pixel_width - padding as usize - border.right.get();

            // Register the scroll bar location
            self.ui_items.push(UIItem {
                x: thumb_x,
                width: padding as usize,
                y: thumb_y_offset,
                height: info.top,
                item_type: UIItemType::AboveScrollThumb,
            });
            self.ui_items.push(UIItem {
                x: thumb_x,
                width: padding as usize,
                y: abs_thumb_top,
                height: thumb_size,
                item_type: UIItemType::ScrollThumb,
            });
            self.ui_items.push(UIItem {
                x: thumb_x,
                width: padding as usize,
                y: abs_thumb_top + thumb_size,
                height: self
                    .dimensions
                    .pixel_height
                    .saturating_sub(abs_thumb_top + thumb_size),
                item_type: UIItemType::BelowScrollThumb,
            });

            self.filled_rectangle(
                layers,
                2,
                euclid::rect(
                    thumb_x as f32,
                    abs_thumb_top as f32,
                    padding,
                    thumb_size as f32,
                ),
                color,
            )
            .context("filled_rectangle")?;
        }

        let (selrange, rectangular) = {
            let sel = self.selection(pos.pane.pane_id());
            (sel.range.clone(), sel.rectangular)
        };
        if selrange.is_some() {
            log::debug!(
                "wezterminator selection diag: paint_pane pane={} selrange={:?}",
                pos.pane.pane_id(),
                selrange
            );
        }

        let start = Instant::now();
        let selection_fg = palette.selection_fg.to_linear();
        let selection_bg = palette.selection_bg.to_linear();
        let cursor_fg = palette.cursor_fg.to_linear();
        let cursor_bg = palette.cursor_bg.to_linear();
        let cursor_is_default_color =
            palette.cursor_fg == global_cursor_fg && palette.cursor_bg == global_cursor_bg;

        // Check if header should be shown and get header text
        let is_editing_this_pane = self.editing_header_pane == Some(pos.pane.pane_id());
        let header_text = {
            let mux = mux::Mux::get();
            let window = mux.get_window(self.mux_window_id);
            if let Some(window) = window {
                let tab = window.get_active();
                if let Some(tab) = tab {
                    let tab_idx = window.idx_by_id(tab.tab_id()).unwrap_or(0);
                    let should_show = wtinator::header::should_render_for_pane(&tab, &pos.pane)
                        || crate::tabbar::is_wtinator_active();
                    if should_show && !pos.pane.is_alt_screen_active() {
                        if is_editing_this_pane {
                            // In edit mode: show only the edit buffer, no prefix
                            Some(self.header_edit_buffer.clone())
                        } else {
                            let pane_header = pos.pane.get_header_text();
                            Some(wtinator::header::build_header(&tab, tab_idx, pane_header.as_deref()))
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };

        // WezTerminator (patch 0087): always reserve one BASE cell for the
        // name bar while it is shown, even after a per-pane font scale.
        // Using the scaled cell height here made the bar vanish and left
        // an unused band in the pane.
        let header_offset = if header_text.is_some() { cell_height } else { 0.0 };

        // WezTerminator (patch 0044): cursor glide. Compute the cursor's
        // target pixel rect and advance/seed the glide state for the
        // ACTIVE pane only, BEFORE the per-line render below — because
        // the line render (via compute_cell_fg_bg) reads
        // `self.cursor_glide_active` to decide whether to suppress the
        // normal cell cursor. While gliding we suppress the cell cursor
        // and draw an overlay block (stashed here, drawn after the lines
        // so it sits on top on layer 2). When settled we leave the cell
        // cursor alone (it blinks/fades via patch 0042).
        // The glide overlay follows the FONT colour (foreground), not the
        // theme cursor colour, and respects the cursor SHAPE so the
        // INSERT/overwrite differentiation (block vs underline/bar)
        // survives the slide.
        let glide_cursor_shape = config.default_cursor_style.effective_shape(cursor.shape);
        let glide_overlay = self.update_cursor_glide(
            pos,
            &cursor,
            &palette,
            foreground,
            glide_cursor_shape,
            current_viewport,
            &dims,
            top_pixel_y,
            header_offset,
            padding_left,
            border.left.get() as f32,
            &pane_metrics,
            cell_width,
            cell_height,
        );

        {
            let content_top_pixel_y = top_pixel_y + header_offset;

            if let Some(ref text) = header_text {
                let header_y = top_pixel_y + (pos.top as f32 * cell_height);
                let header_x = padding_left + border.left.get() as f32
                    + (pos.left as f32 * cell_width);
                let header_pixel_width = pos.width as f32 * cell_width;

                // Theme-aware header colours derived from the pane's
                // palette so the bar blends with whatever theme is in
                // use instead of the hardcoded grey defaults.
                //   bg: pane background nudged 15% toward the foreground
                //       so it reads as a subtly distinct band.
                //   fg: pane foreground dimmed toward the background so
                //       the title text is legible but not loud (~75%).
                let header_bg_srgb = palette
                    .background
                    .interpolate(palette.foreground, 0.15);
                let header_fg_srgb = palette
                    .foreground
                    .interpolate(palette.background, 0.25);

                let (edit_fg_srgb, edit_bg_srgb) =
                    wtinator::header::header_edit_colors(palette.background);
                let header_bg = if is_editing_this_pane {
                    edit_bg_srgb.to_linear()
                } else {
                    header_bg_srgb.to_linear()
                };
                self.filled_rectangle(
                    layers,
                    0,
                    euclid::rect(
                        header_x,
                        header_y,
                        header_pixel_width,
                        cell_height,
                    ),
                    header_bg,
                )
                .context("header filled_rectangle")?;

                let header_cursor = if is_editing_this_pane {
                    StableCursorPosition {
                        x: text.chars().count().min(pos.width.saturating_sub(1)),
                        y: 0,
                        shape: CursorShape::BlinkingBar,
                        visibility: CursorVisibility::Visible,
                    }
                } else {
                    StableCursorPosition::default()
                };

                let header_line = if is_editing_this_pane {
                    wtinator::header::build_header_edit_line_themed(
                        text,
                        pos.width,
                        edit_fg_srgb,
                        edit_bg_srgb,
                    )
                } else {
                    wtinator::header::build_header_line_themed(
                        text,
                        pos.width,
                        header_fg_srgb,
                        header_bg_srgb,
                    )
                };
                let mut header_dims = dims.clone();
                header_dims.cols = pos.width;
                // Pane reverse-video would swap the edit ink onto the
                // header fill, making typed text the same colour as the bar.
                header_dims.reverse_video = false;

                let header_fg = if is_editing_this_pane {
                    edit_fg_srgb.to_linear()
                } else {
                    header_fg_srgb.to_linear()
                };
                // `compute_cell_fg_bg` panics if a cursor is drawn with
                // `pane: None`. Passing the pane + a real line index also
                // makes the blinking caret show in the white field.
                let header_cursor_line = if is_editing_this_pane { Some(0) } else { None };
                let header_pane = if is_editing_this_pane {
                    Some(&pos.pane)
                } else {
                    None
                };
                let edit_ink = edit_fg_srgb.to_linear();
                let (header_cursor_fg, header_cursor_bg, header_cursor_border) =
                    if is_editing_this_pane {
                        (header_bg, edit_ink, edit_ink)
                    } else {
                        (cursor_fg, cursor_bg, cursor_border_color)
                    };

                self.render_screen_line(
                    RenderScreenLineParams {
                        top_pixel_y: header_y,
                        left_pixel_x: header_x,
                        pixel_width: header_pixel_width,
                        stable_line_idx: header_cursor_line,
                        line: &header_line,
                        selection: 0..0,
                        cursor: &header_cursor,
                        palette: &palette,
                        dims: &header_dims,
                        config: &self.config,
                        cursor_border_color: header_cursor_border,
                        foreground: header_fg,
                        is_active: pos.is_active,
                        pane: header_pane,
                        selection_fg,
                        selection_bg,
                        cursor_fg: header_cursor_fg,
                        cursor_bg: header_cursor_bg,
                        cursor_is_default_color: false,
                        white_space,
                        filled_box,
                        window_is_transparent,
                        default_bg: header_bg,
                        font: None,
                        style: None,
                        use_pixel_positioning: self.config.experimental_pixel_positioning,
                        render_metrics: self.render_metrics,
                        shape_key: None,
                        password_input: false,
                    },
                    layers,
                )
                .context("header render_screen_line")?;

                self.ui_items.push(UIItem {
                    x: header_x as usize,
                    y: header_y as usize,
                    width: header_pixel_width as usize,
                    height: cell_height as usize,
                    item_type: UIItemType::PaneHeader(pos.pane.pane_id()),
                });
            }

            let stable_range = match current_viewport {
                Some(top) => top..top + dims.viewport_rows as StableRowIndex,
                None => dims.physical_top..dims.physical_top + dims.viewport_rows as StableRowIndex,
            };

            pos.pane
                .apply_hyperlinks(stable_range.clone(), &self.config.hyperlink_rules);

            struct LineRender<'a, 'b> {
                term_window: &'a mut crate::TermWindow,
                selrange: Option<SelectionRange>,
                rectangular: bool,
                dims: RenderableDimensions,
                top_pixel_y: f32,
                left_pixel_x: f32,
                // WezTerminator (patch 0039): per-pane scaled cell
                // metrics, plus the BASE (window) cell size. The pane's
                // rectangle origin is in BASE cells (so `pos.top`/
                // `pos.left` multiply base_cell_*), while the within-pane
                // line index and column layout use the SCALED pane
                // metrics. `pane_metrics` is also what render_screen_line
                // receives so glyph rasterization happens at the scaled
                // cell size. (The horizontal base origin `pos.left *
                // base_cell_width` is already baked into `left_pixel_x`
                // at construction, so only the base cell HEIGHT needs to
                // be carried for the per-line vertical origin term.)
                pane_metrics: RenderMetrics,
                base_cell_height: f32,
                // WezTerminator (patch 0043): the BASE (window) cell
                // width, used ONLY to clamp the per-line `pixel_width`
                // (the render's right-edge clip) to the pane's true pixel
                // rectangle (`pos.width * base_cell_width`). Without this
                // cap, a pane whose content is wider than its rectangle
                // (e.g. lines printed at a smaller font before a size
                // increase, not yet re-wrapped) would draw straight
                // across the divider into the neighbouring pane.
                base_cell_width: f32,
                // WezTerminator (patch 0039): clamped pane font scale,
                // used as part of the line-shape cache key so two panes
                // at different scales never share a shaped-line entry.
                pane_font_scale: NotNan<f64>,
                // WezTerminator (patch 0043): pane font family, also part
                // of the line-shape cache key so a same-size family
                // change never reuses another font's shaped glyphs.
                pane_font_family: Option<String>,
                // WezTerminator (patch 0051): pane bold / italic, also
                // part of the line-shape cache key (closing the patch
                // 0047 gap) so a same-family/same-size weight or slant
                // change never reuses another pane's shaped line.
                pane_font_bold: bool,
                pane_font_italic: bool,
                // Physical number of scaled rows that fit in the pane frame.
                max_visible_rows: usize,
                pos: &'a PositionedPane,
                pane_id: PaneId,
                cursor: &'a StableCursorPosition,
                palette: &'a ColorPalette,
                default_bg: LinearRgba,
                cursor_border_color: LinearRgba,
                selection_fg: LinearRgba,
                selection_bg: LinearRgba,
                cursor_fg: LinearRgba,
                cursor_bg: LinearRgba,
                foreground: LinearRgba,
                cursor_is_default_color: bool,
                white_space: TextureRect,
                filled_box: TextureRect,
                window_is_transparent: bool,
                layers: &'a mut TripleLayerQuadAllocator<'b>,
                error: Option<anyhow::Error>,
            }

            // BASE (window) cell metrics: the pane's rectangle origin
            // (left_pixel_x and the pos.top contribution to top_pixel_y)
            // are computed in these so the pane sits in the right place.
            let base_cell_width = self.render_metrics.cell_size.width as f32;
            let base_cell_height = self.render_metrics.cell_size.height as f32;

            let left_pixel_x =
                padding_left + border.left.get() as f32 + (pos.left as f32 * base_cell_width);

            // WezTerminator (patch 0039 + 0043): for the duration of this
            // pane's line-content render, scoped-swap BOTH `self.fonts`
            // and `self.render_metrics` to the pane's override values. The
            // shaper reads `self.fonts.match_style` and `&self.render_metrics`
            // (see render/screen_line.rs) with no per-pane parameter, so
            // this swap is how the glyphs get shaped/rasterized with the
            // override family/size. The LineRender origin fields
            // (base_cell_*, left_pixel_x) were already captured ABOVE
            // from the un-swapped base metrics, and the per-line offset
            // math uses the explicit `pane_metrics` field, so positioning
            // stays correct regardless of the swap. The restore happens
            // on BOTH the ok and error paths below (panic-safe via the
            // saved originals + std::mem::replace).
            //
            // Gate on whether the override actually produced *different*
            // fonts than the window: `fonts_and_metrics_for_pane_font`
            // returns the very same `Rc` as `self.fonts` for the window
            // default (and on any font-load fallback). This is what makes
            // a *family* change at the same size swap correctly (patch
            // 0039 only had to check `pane_scale != 1.0`, but a family
            // override can leave the size scale at 1.0).
            let swap_active = !Rc::ptr_eq(&pane_fonts, &self.fonts);
            let saved_fonts = if swap_active {
                Some(std::mem::replace(&mut self.fonts, Rc::clone(&pane_fonts)))
            } else {
                None
            };
            let saved_render_metrics = if swap_active {
                Some(std::mem::replace(
                    &mut self.render_metrics,
                    pane_metrics.clone(),
                ))
            } else {
                None
            };
            // WezTerminator (patch 0052): ALSO swap the window config to the
            // pane's override config for the content render. The glyph
            // FAMILY / weight / slant are chosen by
            // `match_style(params.config)` (render/screen_line.rs), which
            // reads `params.config` (== `self.config`), NOT `self.fonts`.
            // Swapping only `self.fonts` therefore changed the cell
            // METRICS (size) but left `match_style` returning the WINDOW
            // style, so a per-pane family / bold / italic never reached the
            // shaped glyphs — size worked, typeface/weight/slant did not.
            // `pane_fonts.config()` is the `with_font_override` config whose
            // PRIMARY font carries the family + BOLD + Italic, so
            // `match_style` now returns it and the glyphs resolve correctly.
            // It is a clone of the window config (same `generation`, only
            // the font differs), so caches don't churn and a size-only pane
            // is unaffected (its override config keeps the window font).
            let saved_config = if swap_active {
                Some(std::mem::replace(&mut self.config, pane_fonts.config()))
            } else {
                None
            };

            let window_pixel_height = self.dimensions.pixel_height as f32;
            let terminal_rows = self.terminal_size.rows as usize;

            let mut render = LineRender {                term_window: self,
                selrange,
                rectangular,
                dims,
                top_pixel_y: content_top_pixel_y,
                left_pixel_x,
                pane_metrics: pane_metrics.clone(),
                base_cell_height,
                base_cell_width,
                pane_font_scale: NotNan::new(pane_scale)
                    .unwrap_or_else(|_| NotNan::new(1.0).unwrap()),
                pane_font_family: pane_family.clone(),
                pane_font_bold: pane_bold,
                pane_font_italic: pane_italic,
                max_visible_rows: {
                    let pane_top = top_pixel_y + (pos.top as f32 * base_cell_height);
                    let pane_bottom = (pane_top + pos.height as f32 * base_cell_height)
                        .min(window_pixel_height);
                    let content_height = (pane_bottom - (pane_top + header_offset)).max(0.0);
                    // The bottom-most pane is clipped by the client/window
                    // boundary, so include a final row whose top edge is
                    // still visible. A pane above an internal split must
                    // remain conservative: a partial extra row there could
                    // bleed into the pane below.
                    let reaches_window_bottom = pos.top + pos.height >= terminal_rows;
                    if reaches_window_bottom {
                        // The PTY's viewport is authoritative for the pane
                        // that reaches the client bottom. Window metrics can
                        // be a few pixels shorter after the custom tab/header
                        // bars are accounted for; deriving a row count from
                        // that clipped height hid the final cursor row after
                        // Enter scrolled the screen.
                        dims.viewport_rows as usize
                    } else {
                        let row_count = content_height / pane_metrics.cell_size.height as f32;
                        (row_count.floor() as usize).min(dims.viewport_rows as usize)
                    }
                },
                pos,
                pane_id,
                cursor: &cursor,
                palette: &palette,
                cursor_border_color,
                selection_fg,
                selection_bg,
                cursor_fg,
                default_bg,
                cursor_bg,
                foreground,
                cursor_is_default_color,
                white_space,
                filled_box,
                window_is_transparent,
                layers,
                error: None,
            };

            impl<'a, 'b> LineRender<'a, 'b> {
                fn render_line(
                    &mut self,
                    stable_top: StableRowIndex,
                    line_idx: usize,
                    line: &&mut Line,
                ) -> anyhow::Result<()> {
                    let stable_row = stable_top + line_idx as StableRowIndex;
                    if line_idx >= self.max_visible_rows {
                        return Ok(())
                    }
                    let selrange = self
                        .selrange
                        .map_or(0..0, |sel| sel.cols_for_row(stable_row, self.rectangular));
                    // Constrain to the pane width!
                    let selrange = selrange.start..selrange.end.min(self.dims.cols);

                    let (cursor, composing, password_input) = if self.cursor.y == stable_row {
                        (
                            Some(CursorProperties {
                                position: StableCursorPosition {
                                    y: 0,
                                    ..*self.cursor
                                },
                                dead_key_or_leader: self.term_window.dead_key_status
                                    != DeadKeyStatus::None
                                    || self.term_window.leader_is_active(),
                                cursor_fg: self.cursor_fg,
                                cursor_bg: self.cursor_bg,
                                cursor_border_color: self.cursor_border_color,
                                cursor_is_default_color: self.cursor_is_default_color,
                            }),
                            match (self.pos.is_active, &self.term_window.dead_key_status) {
                                (true, DeadKeyStatus::Composing(composing)) => {
                                    Some(composing.to_string())
                                }
                                _ => None,
                            },
                            if self.term_window.config.detect_password_input {
                                match self.pos.pane.get_metadata() {
                                    Value::Object(obj) => {
                                        match obj.get(&Value::String("password_input".to_string()))
                                        {
                                            Some(Value::Bool(b)) => *b,
                                            _ => false,
                                        }
                                    }
                                    _ => false,
                                }
                            } else {
                                false
                            },
                        )
                    } else {
                        (None, None, false)
                    };

                    let shape_hash = self.term_window.shape_hash_for_line(line);

                    let quad_key = LineQuadCacheKey {
                        pane_id: self.pane_id,
                        password_input,
                        pane_is_active: self.pos.is_active,
                        config_generation: self.term_window.config.generation(),
                        shape_generation: self.term_window.shape_generation,
                        quad_generation: self.term_window.quad_generation,
                        composing: composing.clone(),
                        selection: selrange.clone(),
                        cursor,
                        shape_hash,
                        // WezTerminator (patch 0039): the pane's vertical
                        // origin contribution (`pos.top`) is in BASE cells
                        // so the pane sits in its base-metrics rectangle,
                        // but each line within the pane advances by the
                        // SCALED (pane) cell height. We use the explicit
                        // `base_cell_height`/`pane_metrics` fields rather
                        // than `self.term_window.render_metrics` because
                        // the latter is scoped-swapped to the scaled
                        // metrics around this render — relying on it for
                        // the base term would double-apply the scale.
                        top_pixel_y: NotNan::new(self.top_pixel_y).unwrap()
                            + NotNan::new(self.pos.top as f32 * self.base_cell_height).unwrap()
                            + NotNan::new(
                                line_idx as f32 * self.pane_metrics.cell_size.height as f32,
                            )
                            .unwrap(),
                        left_pixel_x: NotNan::new(self.left_pixel_x).unwrap(),
                        pixel_width: NotNan::new(
                            (self.dims.cols as f32 * self.pane_metrics.cell_size.width as f32)
                                .min(self.pos.width as f32 * self.base_cell_width),
                        )
                        .unwrap(),
                        phys_line_idx: line_idx,
                        // WezTerminator (patch 0044): keep the suppressed
                        // and non-suppressed renders of the cursor row in
                        // distinct cache slots. Only meaningful on the
                        // active pane's cursor row; harmless elsewhere.
                        cursor_glide_suppressed: self.term_window.cursor_glide_active.get()
                            && self.pos.is_active,
                        reverse_video: self.dims.reverse_video,
                    };

                    if let Some(cached_quad) =
                        self.term_window.line_quad_cache.borrow_mut().get(&quad_key)
                    {
                        let expired = cached_quad
                            .expires
                            .map(|i| Instant::now() >= i)
                            .unwrap_or(false);
                        let hover_changed = if cached_quad.invalidate_on_hover_change {
                            !same_hyperlink(
                                cached_quad.current_highlight.as_ref(),
                                self.term_window.current_highlight.as_ref(),
                            )
                        } else {
                            false
                        };
                        if !expired && !hover_changed {
                            cached_quad
                                .layers
                                .apply_to(self.layers)
                                .context("cached_quad.layers.apply_to")?;
                            self.term_window.update_next_frame_time(cached_quad.expires);
                            return Ok(());
                        }
                    }

                    let mut buf = HeapQuadAllocator::default();
                    let next_due = self.term_window.has_animation.borrow_mut().take();

                    let shape_key = LineToEleShapeCacheKey {
                        shape_hash,
                        shape_generation: quad_key.shape_generation,
                        pane_font_scale: self.pane_font_scale,
                        pane_font_family: self.pane_font_family.clone(),
                        pane_font_bold: self.pane_font_bold,
                        pane_font_italic: self.pane_font_italic,
                        composing: if self.cursor.y == stable_row && self.pos.is_active {
                            if let DeadKeyStatus::Composing(composing) =
                                &self.term_window.dead_key_status
                            {
                                Some((self.cursor.x, composing.to_string()))
                            } else {
                                None
                            }
                        } else {
                            None
                        },
                    };

                    let render_result = self
                        .term_window
                        .render_screen_line(
                            RenderScreenLineParams {
                                top_pixel_y: *quad_key.top_pixel_y,
                                left_pixel_x: self.left_pixel_x,
                                // Columns lay out at the SCALED pane cell
                                // width (patch 0039). WezTerminator (patch
                                // 0043): clamp the right-edge clip to the
                                // pane's pixel RECTANGLE so content wider
                                // than the pane (e.g. lines printed at a
                                // smaller font before a size increase, not
                                // yet re-wrapped) is clipped at the divider
                                // instead of bleeding into the neighbour.
                                pixel_width: (self.dims.cols as f32
                                    * self.pane_metrics.cell_size.width as f32)
                                    .min(self.pos.width as f32 * self.base_cell_width),
                                stable_line_idx: Some(stable_row),
                                line: &line,
                                selection: selrange.clone(),
                                cursor: &self.cursor,
                                palette: &self.palette,
                                dims: &self.dims,
                                config: &self.term_window.config,
                                cursor_border_color: self.cursor_border_color,
                                foreground: self.foreground,
                                is_active: self.pos.is_active,
                                pane: Some(&self.pos.pane),
                                selection_fg: self.selection_fg,
                                selection_bg: self.selection_bg,
                                cursor_fg: self.cursor_fg,
                                cursor_bg: self.cursor_bg,
                                cursor_is_default_color: self.cursor_is_default_color,
                                white_space: self.white_space,
                                filled_box: self.filled_box,
                                window_is_transparent: self.window_is_transparent,
                                default_bg: self.default_bg,
                                font: None,
                                style: None,
                                use_pixel_positioning: self
                                    .term_window
                                    .config
                                    .experimental_pixel_positioning,
                                // Glyphs rasterize at the scaled pane cell
                                // size (patch 0039).
                                render_metrics: self.pane_metrics.clone(),
                                shape_key: Some(shape_key),
                                password_input,
                            },
                            &mut TripleLayerQuadAllocator::Heap(&mut buf),
                        )
                        .context("render_screen_line")?;

                    let expires = self.term_window.has_animation.borrow().as_ref().cloned();
                    self.term_window.update_next_frame_time(next_due);

                    buf.apply_to(self.layers)
                        .context("HeapQuadAllocator::apply_to")?;

                    let quad_value = LineQuadCacheValue {
                        layers: buf,
                        expires,
                        invalidate_on_hover_change: render_result.invalidate_on_hover_change,
                        current_highlight: if render_result.invalidate_on_hover_change {
                            self.term_window.current_highlight.clone()
                        } else {
                            None
                        },
                    };

                    self.term_window
                        .line_quad_cache
                        .borrow_mut()
                        .put(quad_key, quad_value);

                    Ok(())
                }
            }

            impl<'a, 'b> WithPaneLines for LineRender<'a, 'b> {
                fn with_lines_mut(&mut self, stable_top: StableRowIndex, lines: &mut [&mut Line]) {
                    for (line_idx, line) in lines.iter().enumerate() {
                        if let Err(err) = self.render_line(stable_top, line_idx, line) {
                            self.error.replace(err);
                            return;
                        }
                    }
                }
            }

            pos.pane.with_lines_mut(stable_range.clone(), &mut render);
            // Capture the render error, then drop `render`'s borrow of
            // `self` so we can restore the swapped fonts/metrics. The
            // restore runs unconditionally (ok or error) so a failure
            // mid-render never leaves the window with a pane's scaled
            // metrics installed.
            let render_error = render.error.take();
            // `render` still borrows `self` until here; this is its last
            // use, so the borrow ends and we may touch `self` again.
            if let Some(saved) = saved_fonts {
                self.fonts = saved;
            }
            if let Some(saved) = saved_render_metrics {
                self.render_metrics = saved;
            }
            // WezTerminator (patch 0052): restore the window config swapped
            // in above (runs on both the ok and error paths, like the fonts
            // / metrics restore, so a mid-render failure never leaves the
            // override config installed for the rest of the frame).
            if let Some(saved) = saved_config {
                self.config = saved;
            }
            if let Some(error) = render_error {
                return Err(error).context("error while calling with_lines_mut");
            }
        }

        // WezTerminator (patch 0044): draw the gliding cursor overlay
        // block on top of the just-rendered cells (layer 2). Only set
        // while the cursor is mid-slide; once settled this is None and
        // the normal cell cursor (suppressed above only while gliding)
        // takes over. The cell cursor was suppressed for this frame via
        // `self.cursor_glide_active`, so there is no double cursor.
        if let Some((rect, color)) = glide_overlay {
            self.filled_rectangle(layers, 2, rect, color)
                .context("cursor glide overlay")?;
        }

        /*
        if let Some(zone) = zone {
            // TODO: render a thingy to jump to prior prompt
        }
        */

        // Patch: subtle focus outline around the active pane.
        // Only drawn when the tab is split (more than one pane) — a
        // lone pane needs no focus hint. The outline is a soft,
        // theme-matching line that sits exactly on the pane's outer
        // edge so it never covers content or shifts any viewport math.
        if pos.is_active && self.get_panes_to_render().len() > 1 {
            // WezTerminator (patch 0036.14): frame the pane's ENTIRE
            // visible rectangle — the exact filled area wezterm draws as
            // this pane's background (its "Tab #N" title bar AND its
            // cells), out to the pane's outer edge. The user drew the
            // desired frame in green: it wraps the whole pane (title
            // INCLUDED) and sits on the pane's outer boundary — NOT
            // inset by the padding, NOT below the header. `background_rect`
            // (computed above for the pane fill) is precisely that
            // rectangle, so reusing it makes the outline coincide
            // pixel-for-pixel with the visible pane and reach the pane
            // edge / window edge / divider boundary. The far edges are
            // clamped 1px inside the window so the right/bottom lines
            // stay on-screen; the 1px lines (below) are drawn just inside
            // this rect.
            let win_w = self.dimensions.pixel_width as f32;
            let win_h = self.dimensions.pixel_height as f32;
            // Edges:
            //  - TOP: 1px ABOVE the pane's title bar. `background_rect`'s
            //    top runs up to the window-padding / tab-bar boundary for
            //    TOP-ROW panes, where the line was invisible (the user
            //    saw "top terminals missing the top line"). `content_y`
            //    is the header's top (`top_pixel_y + pos.top*cell_h`), so
            //    we draw 1px above it — hugging the "Tab #N" title on
            //    every pane consistently.
            //  - LEFT: 1px inside the fill boundary so a RIGHT-hand pane's
            //    left edge clears the divider to its left (at the raw
            //    boundary it sat exactly ON the splitter and vanished).
            //  - RIGHT / BOTTOM: the fill boundary (window edge / divider),
            //    already drawn 1px inside via the line thickness `t`.
            let inset = 1.0_f32;
            let content_y = top_pixel_y + (pos.top as f32 * cell_height);
            let pane_x = background_rect.min_x().max(0.0) + inset;
            // 3px above the title bar (user fine-tune: "sobe 2 pixels"
            // from the earlier content_y - 1).
            let pane_y = (content_y - 3.0).max(0.0);
            let right = background_rect.max_x().min(win_w - 1.0);
            let bottom = background_rect.max_y().min(win_h - 1.0);
            let pane_w = (right - pane_x).max(0.0);
            let pane_h = (bottom - pane_y).max(0.0);

            // WezTerminator (patch 0036.2): a crisp blue accent
            // outline (the user asked for blue, "tipo azul para
            // dar destaque"). A bright azure that reads clearly
            // on both light and dark themes; near-opaque so it
            // looks intentional rather than a dim band. Drawn
            // exactly on the pane's pixel edge as a thin 1px line
            // so it hugs the terminal instead of sitting "muito
            // pra dentro".
            let outline = wezterm_term::color::SrgbaTuple(0.16, 0.51, 0.96, 1.0)
                .to_linear()
                .mul_alpha(0.95);

            // 1px thick edges — thin and tight.
            let t = 1.0_f32;

            // Top edge
            self.filled_rectangle(
                layers,
                2,
                euclid::rect(pane_x, pane_y, pane_w, t),
                outline,
            )
            .context("focus outline top")?;
            // Bottom edge
            self.filled_rectangle(
                layers,
                2,
                euclid::rect(pane_x, pane_y + pane_h - t, pane_w, t),
                outline,
            )
            .context("focus outline bottom")?;
            // Left edge
            self.filled_rectangle(
                layers,
                2,
                euclid::rect(pane_x, pane_y, t, pane_h),
                outline,
            )
            .context("focus outline left")?;
            // Right edge
            self.filled_rectangle(
                layers,
                2,
                euclid::rect(pane_x + pane_w - t, pane_y, t, pane_h),
                outline,
            )
            .context("focus outline right")?;
        }

        // WezTerminator (patch 0037): Visual-Studio-style dock drop
        // zone overlay. While a pane-header drag is hovering this
        // pane, draw a translucent blue highlight on the HALF where
        // the dragged pane will dock (or the whole pane for Center),
        // plus a solid border, so the user sees where it will land.
        if let Some(hover) = self.pane_dock_hover {
            if hover.target_pane == pos.pane.pane_id() {
                use wtinator::groups::DockZone;
                let px = padding_left + border.left.get() as f32 + (pos.left as f32 * cell_width);
                let py = top_pixel_y + (pos.top as f32 * cell_height);
                let pw = pos.width as f32 * cell_width;
                // include the header row so the overlay covers the
                // pane's full visible height.
                // pos.height already includes the pane-header row.
                let ph = pos.height as f32 * cell_height;

                let (zx, zy, zw, zh) = match hover.zone {
                    DockZone::Left => (px, py, pw / 2.0, ph),
                    DockZone::Right => (px + pw / 2.0, py, pw / 2.0, ph),
                    DockZone::Up => (px, py, pw, ph / 2.0),
                    DockZone::Down => (px, py + ph / 2.0, pw, ph / 2.0),
                    DockZone::Center => (px, py, pw, ph),
                };
                let fill = wezterm_term::color::SrgbaTuple(0.16, 0.51, 0.96, 1.0)
                    .to_linear()
                    .mul_alpha(0.30);
                self.filled_rectangle(layers, 2, euclid::rect(zx, zy, zw, zh), fill)
                    .context("dock zone fill")?;

                // Solid blue border around the whole target pane.
                let edge = wezterm_term::color::SrgbaTuple(0.16, 0.51, 0.96, 1.0)
                    .to_linear()
                    .mul_alpha(0.95);
                let t = 2.0_f32;
                self.filled_rectangle(layers, 2, euclid::rect(px, py, pw, t), edge)
                    .context("dock border top")?;
                self.filled_rectangle(layers, 2, euclid::rect(px, py + ph - t, pw, t), edge)
                    .context("dock border bottom")?;
                self.filled_rectangle(layers, 2, euclid::rect(px, py, t, ph), edge)
                    .context("dock border left")?;
                self.filled_rectangle(layers, 2, euclid::rect(px + pw - t, py, t, ph), edge)
                    .context("dock border right")?;
            }
        }

        metrics::histogram!("paint_pane.lines").record(start.elapsed());
        log::trace!("lines elapsed {:?}", start.elapsed());

        Ok(())
    }

    /// WezTerminator (patch 0044): macOS / modern-editor style cursor
    /// glide. Maintains the active pane's *rendered* cursor pixel rect
    /// across frames and slides it toward the cell the cursor actually
    /// occupies, instead of teleporting. Returns `Some((rect, color))`
    /// when the cursor is mid-slide (the caller draws an overlay block
    /// and the per-cell cursor was suppressed for this frame via the
    /// `cursor_glide_active` flag set here), or `None` when settled /
    /// teleported / not applicable (the normal cell cursor renders and
    /// blinks).
    ///
    /// Geometry is computed to match the per-line cell render exactly:
    /// the pane rectangle origin uses BASE (window) cell metrics
    /// (`base_cell_*`, multiplying `pos.top`/`pos.left`), while the cell
    /// *size* and the within-pane row/column advance use the pane's
    /// SCALED metrics (`pane_metrics`, patch 0039). The row offset uses
    /// the viewport top (`current_viewport`) so it tracks the same
    /// stable-row -> pixel mapping the lines use.
    fn update_cursor_glide(
        &self,
        pos: &PositionedPane,
        cursor: &StableCursorPosition,
        _palette: &ColorPalette,
        overlay_color: LinearRgba,
        cursor_shape: CursorShape,
        current_viewport: Option<StableRowIndex>,
        dims: &RenderableDimensions,
        top_pixel_y: f32,
        header_offset: f32,
        padding_left: f32,
        border_left: f32,
        pane_metrics: &RenderMetrics,
        base_cell_width: f32,
        base_cell_height: f32,
    ) -> Option<(RectF, LinearRgba)> {
        // Default: no glide this frame. Non-active panes never glide and
        // must clear the flag so their own line render draws the normal
        // cell cursor.
        self.cursor_glide_active.set(false);

        // Patch 0114: glide interpolates the cursor for ~110 ms and
        // requests extra GPU frames on every key. Off by default so
        // typing stays fluid. Set BETHTERM_CURSOR_GLIDE=1 to restore.
        if std::env::var_os("BETHTERM_CURSOR_GLIDE").is_none() {
            return None;
        }

        if !pos.is_active {
            return None;
        }

        // WezTerminator (patch 0043 + 0053): the glide's pixel interpolation
        // was tuned for the uniform WINDOW cell. A pane with ANY per-pane
        // font override — a different size scale, family, OR bold/italic
        // (bold widens the cell, italic skews it) — has a different cell
        // size/shape, which makes the old→new position glide unstable: the
        // cursor briefly shoots to the middle of the screen (the
        // "where did the cursor go" bug). For any such pane we skip the
        // glide entirely and let the normal cell cursor render (it already
        // uses the pane's scaled metrics, so it lands exactly on the cell).
        // The glide still runs for panes on the window font. NOTE (0053):
        // bold/italic were missing from this guard (patch 0047 added them
        // to the pane but not here) — the same "styled" set used by
        // `apply_pane_font_scale_change`.
        if (pos.pane.get_font_scale() - 1.0).abs() > 0.0001
            || pos.pane.get_font_family().is_some()
            || pos.pane.get_font_bold()
            || pos.pane.get_font_italic()
        {
            return None;
        }

        let pane_id = pos.pane.pane_id();
        let focused = self.focused.is_some();
        let cursor_visible = cursor.visibility == CursorVisibility::Visible;

        // Scaled cell size for the block + within-pane advance.
        let cell_w = pane_metrics.cell_size.width as f32;
        let cell_h = pane_metrics.cell_size.height as f32;

        // Viewport top row: the stable row that maps to the first content
        // line. Lines advance from here, so the cursor's pixel-y must too.
        let viewport_top = current_viewport.unwrap_or(dims.physical_top);

        // Target top-left in window pixels (see method doc for the
        // base-vs-scaled split — identical to the per-line math).
        let content_top_pixel_y = top_pixel_y + header_offset;
        let left_pixel_x = padding_left + border_left + (pos.left as f32 * base_cell_width);
        let target_x = left_pixel_x + (cursor.x as f32 * cell_w);
        let target_y = content_top_pixel_y
            + (pos.top as f32 * base_cell_height)
            + ((cursor.y - viewport_top) as f32 * cell_h);

        // Clamp the target into the pane's visible rect so a cursor that
        // is briefly out of range (e.g. mid-resize) can't park the block
        // off in the padding.
        let pane_min_x = left_pixel_x;
        let pane_max_x = left_pixel_x + (pos.width as f32 * base_cell_width) - cell_w;
        let pane_min_y = content_top_pixel_y + (pos.top as f32 * base_cell_height);
        let pane_height = (pos.height as f32 * base_cell_height - header_offset).max(0.0);
        let pane_max_y = pane_min_y + pane_height - cell_h;
        let target_x = target_x.clamp(pane_min_x, pane_max_x.max(pane_min_x));
        let target_y = target_y.clamp(pane_min_y, pane_max_y.max(pane_min_y));

        let now = Instant::now();

        // Reasons to TELEPORT (snap state to target, no glide, no
        // overlay, let the cell cursor render): unfocused window, hidden
        // cursor, no prior state, active pane changed, or viewport
        // scrolled. We still seed/refresh the state so the NEXT real
        // cursor move glides from the correct spot.
        let mut prev = self.cursor_glide.borrow_mut();

        let teleport_reason = !focused
            || !cursor_visible
            || match prev.as_ref() {
                None => true,
                Some(s) => s.pane_id != pane_id || s.viewport_top != viewport_top,
            };

        if teleport_reason {
            *prev = Some(CursorGlideState {
                rendered_x: target_x,
                rendered_y: target_y,
                width: cell_w,
                height: cell_h,
                pane_id,
                viewport_top,
                last_update: now,
            });
            return None;
        }

        // We have a compatible prior state: glide from it toward target.
        let state = prev.as_mut().unwrap();

        // If the cell size changed (font scale change), snap dimensions
        // so the block matches the current cells immediately.
        state.width = cell_w;
        state.height = cell_h;

        let dx = target_x - state.rendered_x;
        let dy = target_y - state.rendered_y;

        // Large jump (cls / full redraw / big paste): teleport so the
        // block doesn't fly across the screen.
        let dist_cells_x = if cell_w > 0.0 { dx.abs() / cell_w } else { 0.0 };
        let dist_cells_y = if cell_h > 0.0 { dy.abs() / cell_h } else { 0.0 };
        let dist_cells = (dist_cells_x * dist_cells_x + dist_cells_y * dist_cells_y).sqrt();
        if dist_cells > GLIDE_MAX_CELLS {
            state.rendered_x = target_x;
            state.rendered_y = target_y;
            state.viewport_top = viewport_top;
            state.last_update = now;
            return None;
        }

        // Already at the target -> settle: clear state pos to target,
        // draw NO overlay, let the cell cursor (which blinks/fades) show.
        if dx.abs() <= GLIDE_SETTLE_PX && dy.abs() <= GLIDE_SETTLE_PX {
            state.rendered_x = target_x;
            state.rendered_y = target_y;
            state.viewport_top = viewport_top;
            state.last_update = now;
            return None;
        }

        // Time-based ease-out, frame-rate independent. We model the
        // approach as exponential decay of the remaining distance with a
        // time constant derived from GLIDE_DURATION_MS (~3 time constants
        // ~= the full glide). alpha is the fraction of the remaining gap
        // to close THIS frame given the elapsed dt; for tiny/zero dt it
        // is ~0 (no movement) and for large dt it saturates toward 1.
        let dt = now.duration_since(state.last_update).as_secs_f32();
        let tau = (GLIDE_DURATION_MS / 1000.0) / 3.0;
        let alpha = if tau > 0.0 {
            1.0 - (-dt / tau).exp()
        } else {
            1.0
        };
        let alpha = alpha.clamp(0.0, 1.0);

        state.rendered_x += dx * alpha;
        state.rendered_y += dy * alpha;
        state.viewport_top = viewport_top;
        state.last_update = now;

        // Shape-aware overlay: a block fills the cell; an underline is a
        // thin strip at the bottom; a bar is a thin strip at the left.
        // This preserves the INSERT/overwrite cursor differentiation
        // (cmd toggles block <-> underline) even while the cursor glides.
        let rect = match cursor_shape {
            CursorShape::BlinkingUnderline | CursorShape::SteadyUnderline => {
                let t = (state.height * 0.18).max(2.0);
                euclid::rect(
                    state.rendered_x,
                    state.rendered_y + state.height - t,
                    state.width,
                    t,
                )
            }
            CursorShape::BlinkingBar | CursorShape::SteadyBar => {
                let t = (state.width * 0.18).max(2.0);
                euclid::rect(state.rendered_x, state.rendered_y, t, state.height)
            }
            // Block (and Default): the whole cell.
            _ => euclid::rect(state.rendered_x, state.rendered_y, state.width, state.height),
        };

        // Suppress the per-cell cursor for this pane this frame and ask
        // for another frame so the slide continues (~60fps).
        self.cursor_glide_active.set(true);
        self.update_next_frame_time(Some(now + std::time::Duration::from_millis(16)));

        // The overlay follows the FONT colour (foreground) passed by the
        // caller, matching the reverse-video cell cursor (patch 0044).
        Some((rect, overlay_color))
    }

    pub fn build_pane(&mut self, pos: &PositionedPane) -> anyhow::Result<ComputedElement> {
        // First compute the bounds for the pane background

        let cell_width = self.render_metrics.cell_size.width as f32;
        let cell_height = self.render_metrics.cell_size.height as f32;
        let (padding_left, padding_top) = self.padding_left_top();
        let tab_bar_height = if self.show_tab_bar {
            self.tab_bar_pixel_height()?
        } else {
            0.
        };
        let (top_bar_height, _bottom_bar_height) = if self.config.tab_bar_at_bottom {
            (0.0, tab_bar_height)
        } else {
            (tab_bar_height, 0.0)
        };

        let border = self.get_os_border();
        let top_pixel_y = top_bar_height + padding_top + border.top.get() as f32;

        // We want to fill out to the edges of the splits
        let (x, width_delta) = if pos.left == 0 {
            (
                0.,
                padding_left + border.left.get() as f32 + (cell_width / 2.0),
            )
        } else {
            (
                padding_left + border.left.get() as f32 - (cell_width / 2.0)
                    + (pos.left as f32 * cell_width),
                cell_width,
            )
        };

        let (y, height_delta) = if pos.top == 0 {
            (
                (top_pixel_y - padding_top),
                padding_top + (cell_height / 2.0),
            )
        } else {
            (
                top_pixel_y + (pos.top as f32 * cell_height) - (cell_height / 2.0),
                cell_height,
            )
        };

        let background_rect = euclid::rect(
            x,
            y,
            // Go all the way to the right edge if we're right-most
            if pos.left + pos.width >= self.terminal_size.cols as usize {
                self.dimensions.pixel_width as f32 - x
            } else {
                (pos.width as f32 * cell_width) + width_delta
            },
            // Go all the way to the bottom if we're bottom-most
            if pos.top + pos.height >= self.terminal_size.rows as usize {
                self.dimensions.pixel_height as f32 - y
            } else {
                (pos.height as f32 * cell_height) + height_delta as f32
            },
        );

        // Bounds for the terminal cells
        let content_rect = euclid::rect(
            padding_left + border.left.get() as f32 - (cell_width / 2.0)
                + (pos.left as f32 * cell_width),
            top_pixel_y + (pos.top as f32 * cell_height) - (cell_height / 2.0),
            pos.width as f32 * cell_width,
            pos.height as f32 * cell_height,
        );

        let palette = pos.pane.palette();

        // TODO: visual bell background layer
        // TODO: scrollbar

        Ok(ComputedElement {
            item_type: None,
            zindex: 0,
            bounds: background_rect,
            border: PixelDimension::default(),
            border_rect: background_rect,
            border_corners: None,
            colors: ElementColors {
                border: BorderColor::default(),
                bg: if self.window_background.is_empty() {
                    palette
                        .background
                        .to_linear()
                        .mul_alpha(self.config.window_background_opacity)
                        .into()
                } else {
                    InheritableColor::Inherited
                },
                text: InheritableColor::Inherited,
            },
            hover_colors: None,
            padding: background_rect,
            content_rect,
            baseline: 1.0,
            content: ComputedElementContent::Children(vec![]),
        })
    }
}
