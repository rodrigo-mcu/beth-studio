//! BethTerm (patch 0124): left-rail list of every live pane.

use crate::quad::TripleLayerQuadAllocator;
use crate::termwindow::render::RenderScreenLineParams;
use crate::termwindow::{UIItem, UIItemType};
use mux::renderable::RenderableDimensions;
use mux::window::WindowId as MuxWindowId;
use termwiz::color::SrgbaTuple;
use window::color::LinearRgba;
use ::window::WindowOps;

impl crate::TermWindow {
    /// Reserved left inset for the dashboard rail (0 when closed).
    pub fn dashboard_sidebar_width(&self) -> usize {
        if crate::tabbar::is_wtinator_active() {
            wtinator::dashboard::width_px(self.mux_window_id)
        } else {
            0
        }
    }

    /// Recompute cols after the rail opens or closes.
    pub fn relayout_after_dashboard(&mut self) {
        if let Some(window) = self.window.clone() {
            let dims = self.dimensions.clone();
            self.apply_dimensions(&dims, None, &window);
            self.update_title_post_status();
            window.restore();
            window.show();
            window.focus();
            window.invalidate();
        }
    }

    /// Open the rail on this window and resize the PTY beside it.
    pub fn open_dashboard(&mut self) {
        wtinator::dashboard::open(self.mux_window_id);
        self.relayout_after_dashboard();
    }

    pub fn paint_dashboard(
        &mut self,
        layers: &mut TripleLayerQuadAllocator,
    ) -> anyhow::Result<()> {
        let width = self.dashboard_sidebar_width() as f32;
        if width <= 0. {
            return Ok(());
        }

        let border = self.get_os_border();
        let left = border.left.get() as f32;
        let top = border.top.get() as f32;
        let height = self.dimensions.pixel_height as f32 - top - border.bottom.get() as f32;
        let cell_width = self.render_metrics.cell_size.width as f32;
        let cell_height = self.render_metrics.cell_size.height as f32;
        let header_h = wtinator::dashboard::HEADER_PX as f32;
        let row_h = wtinator::dashboard::ROW_PX as f32;

        let palette = self.palette().clone();
        let fg = palette.foreground;
        let bg = palette.background;
        let rail_bg = lerp(bg, fg, 0.06);
        let sep = lerp(bg, fg, 0.22);
        let header_bg = lerp(bg, fg, 0.12);
        let active_bg = palette.selection_bg;
        let active_fg = palette.selection_fg;
        let wait_fg = palette.colors.0[3];

        self.filled_rectangle(
            layers,
            0,
            euclid::rect(left, top, width, height),
            rail_bg.to_linear(),
        )?;
        self.filled_rectangle(
            layers,
            1,
            euclid::rect(left + width - 1.5, top, 1.5, height),
            sep.to_linear(),
        )?;
        self.filled_rectangle(
            layers,
            0,
            euclid::rect(left, top, width, header_h),
            header_bg.to_linear(),
        )?;

        let title_cols = ((width - 36.0) / cell_width).max(4.0) as usize;
        self.paint_dashboard_label(
            layers,
            left + 10.0,
            top + ((header_h - cell_height) / 2.0).max(0.0),
            title_cols,
            "Painel",
            fg,
            header_bg,
        )?;

        let close_w = 28.0_f32;
        let close_x = left + width - close_w - 6.0;
        self.paint_dashboard_label(
            layers,
            close_x,
            top + ((header_h - cell_height) / 2.0).max(0.0),
            2,
            "×",
            fg,
            header_bg,
        )?;
        self.ui_items.push(UIItem {
            x: close_x as usize,
            y: top as usize,
            width: close_w as usize,
            height: header_h as usize,
            item_type: UIItemType::DashboardClose,
        });

        let selected = wtinator::dashboard::selected_pane(self.mux_window_id);
        let active_id = mux::Mux::try_get()
            .and_then(|m| m.get_active_tab_for_window(self.mux_window_id))
            .and_then(|t| t.get_active_pane())
            .map(|p| p.pane_id());

        let entries = wtinator::dashboard::collect();
        let label_cols = ((width - 20.0) / cell_width).max(6.0) as usize;
        let mut y = top + header_h;
        for entry in entries {
            if y + row_h > top + height {
                break;
            }
            let is_active = selected == Some(entry.pane_id)
                || (selected.is_none()
                    && Some(entry.pane_id) == active_id
                    && entry.window_id == self.mux_window_id);
            let row_bg = if is_active {
                active_bg
            } else {
                rail_bg
            };
            let row_fg = if is_active { active_fg } else { fg };
            self.filled_rectangle(
                layers,
                0,
                euclid::rect(left, y, width - 1.5, row_h),
                row_bg.to_linear(),
            )?;

            let mut title = wtinator::dashboard::clip_label(&entry.title, label_cols);
            if entry.waiting {
                title = format!("● {title}");
            }
            let text_y = y + 6.0;
            self.paint_dashboard_label(
                layers,
                left + 10.0,
                text_y,
                label_cols,
                &title,
                if entry.waiting && !is_active {
                    wait_fg
                } else {
                    row_fg
                },
                row_bg,
            )?;
            if !entry.detail.is_empty() {
                let detail = wtinator::dashboard::clip_label(&entry.detail, label_cols);
                self.paint_dashboard_label(
                    layers,
                    left + 10.0,
                    text_y + cell_height,
                    label_cols,
                    &detail,
                    lerp(row_fg, row_bg, 0.35),
                    row_bg,
                )?;
            }

            self.ui_items.push(UIItem {
                x: left as usize,
                y: y as usize,
                width: (width - 1.5).max(1.0) as usize,
                height: row_h as usize,
                item_type: UIItemType::DashboardEntry {
                    pane_id: entry.pane_id,
                },
            });
            y += row_h;
        }

        Ok(())
    }

    fn paint_dashboard_label(
        &mut self,
        layers: &mut TripleLayerQuadAllocator,
        x: f32,
        y: f32,
        cols: usize,
        text: &str,
        fg: SrgbaTuple,
        bg: SrgbaTuple,
    ) -> anyhow::Result<()> {
        let cell_width = self.render_metrics.cell_size.width as f32;
        let cell_height = self.render_metrics.cell_size.height as f32;
        let line = wtinator::header::build_header_line_themed(text, cols, fg, bg);
        let palette = self.palette().clone();
        let gl_state = self.render_state.as_ref().unwrap();
        let white_space = gl_state.util_sprites.white_space.texture_coords();
        let filled_box = gl_state.util_sprites.filled_box.texture_coords();
        let window_is_transparent =
            !self.window_background.is_empty() || self.config.window_background_opacity != 1.0;
        let dims = RenderableDimensions {
            cols,
            physical_top: 0,
            scrollback_rows: 0,
            scrollback_top: 0,
            viewport_rows: 1,
            dpi: self.terminal_size.dpi,
            pixel_height: cell_height as usize,
            pixel_width: (cols as f32 * cell_width) as usize,
            reverse_video: false,
        };
        self.render_screen_line(
            RenderScreenLineParams {
                top_pixel_y: y,
                left_pixel_x: x,
                pixel_width: cols as f32 * cell_width,
                stable_line_idx: None,
                line: &line,
                selection: 0..0,
                cursor: &Default::default(),
                palette: &palette,
                dims: &dims,
                config: &self.config,
                cursor_border_color: LinearRgba::default(),
                foreground: fg.to_linear(),
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
                default_bg: bg.to_linear(),
                style: None,
                font: None,
                use_pixel_positioning: self.config.experimental_pixel_positioning,
                render_metrics: self.render_metrics,
                shape_key: None,
                password_input: false,
            },
            layers,
        )?;
        Ok(())
    }
}

fn lerp(a: SrgbaTuple, b: SrgbaTuple, t: f32) -> SrgbaTuple {
    SrgbaTuple(
        a.0 + (b.0 - a.0) * t,
        a.1 + (b.1 - a.1) * t,
        a.2 + (b.2 - a.2) * t,
        1.0,
    )
}

/// Tray "Painel": show the rail on a live window, or spawn one.
pub fn open_dashboard_from_tray() {
    promise::spawn::spawn_into_main_thread(async {
        open_dashboard_on_main();
    })
    .detach();
}

fn open_dashboard_on_main() {
    if !wtinator::native_gui::enabled() {
        log::info!("bethterm: Painel ignored; native GUI is off");
        return;
    }
    let Some(fe) = crate::frontend::try_front_end() else {
        wtinator::dashboard::request_open_on_next_window();
        crate::spawn::spawn_new_window(None);
        return;
    };
    let mux = mux::Mux::get();
    let mut target: Option<MuxWindowId> = None;
    for wid in mux.iter_windows() {
        if wtinator::dashboard::is_open(wid) {
            target = Some(wid);
            break;
        }
    }
    if target.is_none() {
        target = mux.iter_windows().into_iter().next();
    }
    if let Some(wid) = target {
        if let Some(gui) = fe.gui_window_for_mux_window(wid) {
            gui.window.notify(crate::termwindow::TermWindowNotif::Apply(Box::new(
                |tw| {
                    tw.open_dashboard();
                },
            )));
            return;
        }
    }
    wtinator::dashboard::request_open_on_next_window();
    crate::spawn::spawn_new_window(None);
}
