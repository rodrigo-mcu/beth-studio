use crate::tabbar::TabBarItem;
use crate::termwindow::{
    GuiWin, MouseCapture, PositionedSplit, ScrollHit, TermWindowNotif, UIItem, UIItemType, TMB,
};
use ::window::{
    MouseButtons as WMB, MouseCursor, MouseEvent, MouseEventKind as WMEK, MousePress,
    WindowDecorations, WindowOps, WindowState,
};
use config::keyassignment::{KeyAssignment, MouseEventTrigger};
use config::MouseEventAltScreen;
use mux::pane::{Pane, PaneId, WithPaneLines};
use mux::tab::SplitDirection;
use mux::Mux;
use mux_lua::MuxPane;
use std::convert::TryInto;
use std::ops::Sub;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use termwiz::hyperlink::Hyperlink;
use termwiz::surface::Line;
use wezterm_dynamic::ToDynamic;
use wezterm_term::color::ColorPalette;
use wezterm_term::input::{MouseButton, MouseEventKind as TMEK};
use wezterm_term::{ClickPosition, LastMouseClick, StableRowIndex};

impl super::TermWindow {
    fn resolve_ui_item(&self, event: &MouseEvent) -> Option<UIItem> {
        let x = event.coords.x;
        let y = event.coords.y;
        self.ui_items
            .iter()
            .rev()
            .find(|item| item.hit_test(x, y))
            .cloned()
    }

    fn leave_ui_item(&mut self, item: &UIItem) {
        match item.item_type {
            UIItemType::TabBar(_) => {
                self.update_title_post_status();
            }
            UIItemType::CloseTab(_)
            | UIItemType::AboveScrollThumb
            | UIItemType::BelowScrollThumb
            | UIItemType::ScrollThumb
            | UIItemType::Split(_)
            | UIItemType::PaneHeader(_)
            | UIItemType::RailEntry { .. }
            | UIItemType::PaneTabNew
            | UIItemType::DashboardEntry { .. }
            | UIItemType::DashboardClose => {}
        }
    }

    fn enter_ui_item(&mut self, item: &UIItem) {
        match item.item_type {
            UIItemType::TabBar(_) => {}
            UIItemType::CloseTab(_)
            | UIItemType::AboveScrollThumb
            | UIItemType::BelowScrollThumb
            | UIItemType::ScrollThumb
            | UIItemType::Split(_)
            | UIItemType::PaneHeader(_)
            | UIItemType::RailEntry { .. }
            | UIItemType::PaneTabNew
            | UIItemType::DashboardEntry { .. }
            | UIItemType::DashboardClose => {}
        }
    }

    fn commit_header_edit(&mut self, context: &dyn WindowOps) {
        if let Some(pane_id) = self.editing_header_pane.take() {
            let text = wtinator::header::normalize_header_text(&self.header_edit_buffer)
                .ok()
                .flatten();
            if let Some(pane) = Mux::try_get().and_then(|m| m.get_pane(pane_id)) {
                pane.set_header_text(text);
            }
            self.header_edit_buffer.clear();
            context.invalidate();
        }
    }

    pub fn mouse_event_impl(&mut self, event: MouseEvent, context: &dyn WindowOps) {
        log::trace!("{:?}", event);
        let pane = match self.get_active_pane_or_overlay() {
            Some(pane) => pane,
            None => return,
        };

        // WezTerminator patch 0030.5: if we are editing a header and
        // the click lands outside the PaneHeader UI item, commit the
        // edit before processing the click. This handles clicks on the
        // terminal area, other panes, tab bar, etc.
        if self.editing_header_pane.is_some() && matches!(event.kind, WMEK::Press(_)) {
            let ui_item = self.resolve_ui_item(&event);
            if !matches!(ui_item, Some(UIItem { item_type: UIItemType::PaneHeader(_), .. })) {
                self.commit_header_edit(context);
            }
        }

        self.current_mouse_event.replace(event.clone());

        let border = self.get_os_border();

        // Match paint_pane / resize.rs: tab bar + list-mode pane strip +
        // OS border. Missing the strip made selection land several rows
        // away whenever list mode was on (patch 0090).
        let first_line_offset = if self.show_tab_bar && !self.config.tab_bar_at_bottom {
            self.tab_bar_pixel_height().unwrap_or(0.) as isize
        } else {
            0
        } + self.pane_strip_pixel_height() as isize
            + border.top.get() as isize;

        let (padding_left, padding_top) = self.padding_left_top();

        // WezTerminator (patch 0039): the (x, y) computed here are
        // WINDOW-level cell coords in the BASE cell size — correct for
        // *finding* which pane the cursor is over (pane rectangles are
        // laid out in base cells). The per-pane font scale is applied
        // later, in `mouse_event_terminal`, when the window-level cell
        // is converted to the pane-LOCAL content cell (base-local cells
        // ÷ scale), so clicks/selection land on the right cell inside a
        // scaled pane.
        let y = (event
            .coords
            .y
            .sub(padding_top as isize)
            .sub(first_line_offset)
            .max(0)
            / self.render_metrics.cell_size.height) as i64;

        let x = (event
            .coords
            .x
            .sub((padding_left + border.left.get() as f32) as isize)
            .max(0) as f32)
            / self.render_metrics.cell_size.width as f32;
        let x = if !pane.is_mouse_grabbed() {
            // Round the x coordinate so that we're a bit more forgiving of
            // the horizontal position when selecting cells
            x.round()
        } else {
            x
        }
        .trunc() as usize;

        let mut y_pixel_offset = event
            .coords
            .y
            .sub(padding_top as isize)
            .sub(first_line_offset);
        if y > 0 {
            y_pixel_offset = y_pixel_offset.max(0) % self.render_metrics.cell_size.height;
        }

        let mut x_pixel_offset = event
            .coords
            .x
            .sub((padding_left + border.left.get() as f32) as isize);
        if x > 0 {
            x_pixel_offset = x_pixel_offset.max(0) % self.render_metrics.cell_size.width;
        }

        self.last_mouse_coords = (x, y);

        let mut capture_mouse = false;

        match event.kind {
            WMEK::Release(ref press) => {
                self.current_mouse_capture = None;
                self.current_mouse_buttons.retain(|p| p != press);
                if press == &MousePress::Left && self.window_drag_position.take().is_some() {
                    // Completed a window drag
                    return;
                }
                if press == &MousePress::Left {
                    // WezTerminator patch 0035: completing a drag may be a
                    // tab reorder or a pane-move drop.
                    if let Some((drag_item, _start)) = self.dragging.take() {
                        self.complete_drag_drop(drag_item, &event, context);
                        return;
                    }
                }
            }

            WMEK::Press(ref press) => {
                capture_mouse = true;

                // Perform click counting
                let button = mouse_press_to_tmb(press);

                let click_position = ClickPosition {
                    column: x,
                    row: y,
                    x_pixel_offset,
                    y_pixel_offset,
                };

                let click = match self.last_mouse_click.take() {
                    None => LastMouseClick::new(button, click_position),
                    Some(click) => click.add(button, click_position),
                };
                self.last_mouse_click = Some(click);
                self.current_mouse_buttons.retain(|p| p != press);
                self.current_mouse_buttons.push(*press);
            }

            WMEK::Move => {
                if let Some(start) = self.window_drag_position.as_ref() {
                    // Dragging the window
                    // Compute the distance since the initial event
                    let delta_x = start.screen_coords.x - event.screen_coords.x;
                    let delta_y = start.screen_coords.y - event.screen_coords.y;

                    // Now compute a new window position.
                    // We don't have a direct way to get the position,
                    // but we can infer it by comparing the mouse coords
                    // with the screen coords in the initial event.
                    // This computes the original top_left position,
                    // and applies the total drag delta to it.
                    let top_left = ::window::ScreenPoint::new(
                        (start.screen_coords.x - start.coords.x) - delta_x,
                        (start.screen_coords.y - start.coords.y) - delta_y,
                    );
                    // and now tell the window to go there
                    context.set_window_position(top_left);
                    return;
                }

                if let Some((item, start_event)) = self.dragging.take() {
                    self.drag_ui_item(item, start_event, x, y, event, context);
                    return;
                }
            }
            _ => {}
        }

        let prior_ui_item = self.last_ui_item.clone();

        let ui_item = if matches!(self.current_mouse_capture, None | Some(MouseCapture::UI)) {
            let ui_item = self.resolve_ui_item(&event);

            match (self.last_ui_item.take(), &ui_item) {
                (Some(prior), Some(item)) => {
                    if prior != *item || !self.config.use_fancy_tab_bar {
                        self.leave_ui_item(&prior);
                        self.enter_ui_item(item);
                        context.invalidate();
                    }
                }
                (Some(prior), None) => {
                    self.leave_ui_item(&prior);
                    context.invalidate();
                }
                (None, Some(item)) => {
                    self.enter_ui_item(item);
                    context.invalidate();
                }
                (None, None) => {}
            }

            ui_item
        } else {
            None
        };

        if let Some(item) = ui_item.clone() {
            if capture_mouse {
                self.current_mouse_capture = Some(MouseCapture::UI);
            }
            self.mouse_event_ui_item(item, pane, y, event, context);
        } else if matches!(
            self.current_mouse_capture,
            None | Some(MouseCapture::TerminalPane(_))
        ) {
            self.mouse_event_terminal(
                pane,
                ClickPosition {
                    column: x,
                    row: y,
                    x_pixel_offset,
                    y_pixel_offset,
                },
                event,
                context,
                capture_mouse,
            );
        }

        if prior_ui_item != ui_item {
            self.update_title_post_status();
        }
    }

    pub fn mouse_leave_impl(&mut self, context: &dyn WindowOps) {
        self.current_mouse_event = None;
        // WezTerminator (patch 0037): clear any dock drop-zone overlay
        // if the cursor leaves the window mid-drag, so it can't get
        // stuck on screen.
        if self.pane_dock_hover.take().is_some() {
            context.invalidate();
        }
        self.update_title();
        context.set_cursor(Some(MouseCursor::Arrow));
        context.invalidate();
    }

    fn drag_split(
        &mut self,
        mut item: UIItem,
        split: PositionedSplit,
        start_event: MouseEvent,
        x: usize,
        y: i64,
        context: &dyn WindowOps,
    ) {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return,
        };
        let delta = match split.direction {
            SplitDirection::Horizontal => (x as isize).saturating_sub(split.left as isize),
            SplitDirection::Vertical => (y as isize).saturating_sub(split.top as isize),
        };

        if delta != 0 {
            tab.resize_split_by(split.index, delta);
            if let Some(split) = tab.iter_splits().into_iter().nth(split.index) {
                item.item_type = UIItemType::Split(split);
                context.invalidate();
            }
        }
        self.dragging.replace((item, start_event));
    }

    fn drag_scroll_thumb(
        &mut self,
        item: UIItem,
        start_event: MouseEvent,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        let pane = match self.get_active_pane_or_overlay() {
            Some(pane) => pane,
            None => return,
        };

        let dims = pane.get_dimensions();
        let current_viewport = self.get_viewport(pane.pane_id());

        let tab_bar_height = if self.show_tab_bar {
            self.tab_bar_pixel_height().unwrap_or(0.)
        } else {
            0.
        };
        let (top_bar_height, bottom_bar_height) = if self.config.tab_bar_at_bottom {
            (0.0, tab_bar_height)
        } else {
            (tab_bar_height, 0.0)
        };

        let border = self.get_os_border();
        let y_offset = top_bar_height + border.top.get() as f32;

        let from_top = start_event.coords.y.saturating_sub(item.y as isize);
        let effective_thumb_top = event
            .coords
            .y
            .saturating_sub(y_offset as isize + from_top)
            .max(0) as usize;

        // Convert thumb top into a row index by reversing the math
        // in ScrollHit::thumb
        let row = ScrollHit::thumb_top_to_scroll_top(
            effective_thumb_top,
            &*pane,
            current_viewport,
            self.dimensions.pixel_height.saturating_sub(
                y_offset as usize + border.bottom.get() + bottom_bar_height as usize,
            ),
            self.min_scroll_bar_height() as usize,
        );
        self.set_viewport(pane.pane_id(), Some(row), dims);
        context.invalidate();
        self.dragging.replace((item, start_event));
    }

    fn drag_ui_item(
        &mut self,
        item: UIItem,
        start_event: MouseEvent,
        x: usize,
        y: i64,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        match item.item_type {
            UIItemType::Split(split) => {
                self.drag_split(item, split, start_event, x, y, context);
            }
            UIItemType::ScrollThumb => {
                self.drag_scroll_thumb(item, start_event, event, context);
            }
            // WezTerminator patch 0035: tab reorder and pane-move drags
            // are handled on release in complete_drag_drop; while dragging
            // just show a hand cursor. We MUST re-arm the drag state here
            // (like drag_split does at the end of its handler) because the
            // Move handler took `self.dragging` before calling us — without
            // re-arming, the drag state is gone by the time the button is
            // released, so complete_drag_drop never fires and the
            // tab-reorder / pane-move never happens (patch 0035.1 fix).
            // WezTerminator patch 0035: tab reorder drag — handled on
            // release in complete_drag_drop. Re-arm the drag state
            // (the Move handler took it before calling us).
            UIItemType::TabBar(_) => {
                context.set_cursor(Some(MouseCursor::Hand));
                self.dragging.replace((item, start_event));
            }
            // WezTerminator patch 0037: pane dock drag (VS-style).
            // While dragging a pane header, track which pane the
            // cursor is over and which edge zone, so the renderer
            // draws the drop-zone overlay and the release docks the
            // pane. Re-arm the drag state for the release.
            UIItemType::PaneHeader(dragged_pane_id) => {
                context.set_cursor(Some(MouseCursor::Hand));
                // WezTerminator patch 0037.1: spring-loaded tabs.
                // If the cursor is over a tab in the tab strip while
                // dragging, switch to that tab so the user can then
                // move down into its panes and dock there. This lets
                // a pane be dragged into another tab AND positioned
                // (above/below/left/right of a target pane) in one
                // gesture.
                let over_tab = match self.resolve_ui_item(&event) {
                    Some(UIItem {
                        item_type: UIItemType::TabBar(TabBarItem::Tab { tab_idx, .. }),
                        ..
                    }) => Some(tab_idx),
                    _ => None,
                };
                if let Some(tab_idx) = over_tab {
                    let active = Mux::get()
                        .get_window(self.mux_window_id)
                        .map(|w| w.get_active_idx());
                    if active != Some(tab_idx) {
                        self.activate_tab(tab_idx as isize).ok();
                    }
                    // Over the tab bar, not a pane: no dock zone.
                    self.pane_dock_hover = None;
                } else {
                    self.update_pane_dock_hover(dragged_pane_id, x, y);
                }
                context.invalidate();
                self.dragging.replace((item, start_event));
            }
            _ => {
                log::error!("drag not implemented for {:?}", item);
            }
        }
    }

    /// WezTerminator (patch 0037): during a pane-header drag, find
    /// the pane under the cursor (in the active tab) and the edge
    /// zone (Left/Right/Up/Down/Center), and stash it in
    /// `self.pane_dock_hover` for the renderer + the drop handler.
    /// `x`/`y` are cell coordinates (column/row).
    fn update_pane_dock_hover(&mut self, dragged_pane_id: PaneId, x: usize, y: i64) {
        use wtinator::groups::DockZone;
        let row = y.max(0) as usize;
        let mux = Mux::get();
        let hover = mux.get_active_tab_for_window(self.mux_window_id).and_then(|tab| {
            for p in tab.iter_panes() {
                if p.pane.pane_id() == dragged_pane_id {
                    continue;
                }
                if x >= p.left
                    && x < p.left + p.width
                    && row >= p.top
                    && row < p.top + p.height
                {
                    let rx = (x - p.left) as f32 / (p.width.max(1)) as f32;
                    let ry = (row - p.top) as f32 / (p.height.max(1)) as f32;
                    // Center region (middle ~40%) => swap; otherwise
                    // pick the nearest edge.
                    let zone = if (0.30..0.70).contains(&rx) && (0.30..0.70).contains(&ry) {
                        DockZone::Center
                    } else {
                        let (dl, dr, dt, db) = (rx, 1.0 - rx, ry, 1.0 - ry);
                        let m = dl.min(dr).min(dt).min(db);
                        if m == dl {
                            DockZone::Left
                        } else if m == dr {
                            DockZone::Right
                        } else if m == dt {
                            DockZone::Up
                        } else {
                            DockZone::Down
                        }
                    };
                    return Some(super::PaneDockHover {
                        dragged_pane: dragged_pane_id,
                        target_pane: p.pane.pane_id(),
                        zone,
                    });
                }
            }
            None
        });
        self.pane_dock_hover = hover;
    }

    fn mouse_event_ui_item(
        &mut self,
        item: UIItem,
        pane: Arc<dyn Pane>,
        _y: i64,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        self.last_ui_item.replace(item.clone());
        // WezTerminator patch 0035: keep a clone of the outer UIItem so we
        // can stash it as drag state even though the match below moves
        // `item.item_type`.
        let item_clone = item.clone();
        match item.item_type {
            // WezTerminator (patch 0065): a pane chip in the pane-tab bar.
            // Hover shows a Hand cursor; left-click makes that pane the one
            // shown full-area (1-up, like clicking a top tab).
            UIItemType::RailEntry { pane_id, ordinal: _ } => {
                context.set_cursor(Some(MouseCursor::Hand));
                if let WMEK::Press(MousePress::Left) = event.kind {
                    let mux = mux::Mux::get();
                    if let Some(tab) = mux.get_active_tab_for_window(self.mux_window_id) {
                        let panes = tab.iter_panes_ignoring_zoom();
                        let active_id =
                            panes.iter().find(|p| p.is_active).map(|p| p.pane.pane_id());
                        if tab.is_zoomed() && active_id == Some(pane_id) {
                            // Clicking the already-zoomed pane's chip reveals the
                            // full split again.
                            tab.set_zoomed(false);
                        } else if let Some(p) =
                            panes.into_iter().find(|p| p.pane.pane_id() == pane_id)
                        {
                            // Show this terminal full-area (zoom), like a tab.
                            tab.set_active_pane(&p.pane);
                            tab.set_zoomed(true);
                        }
                        if let Some(window_id) = mux.window_containing_tab(tab.tab_id()) {
                            mux.notify(mux::MuxNotification::WindowInvalidated(window_id));
                        }
                    }
                    context.invalidate();
                }
                // WezTerminator (patch 0065): right-click a chip → the SAME
                // existing native menu, targeting that terminal (Split / new /
                // Close pane / Toggle list mode — everything by mouse, no keys).
                if let WMEK::Release(MousePress::Right) = event.kind {
                    #[cfg(windows)]
                    show_native_full_menu(self, pane_id);
                }
            }
            // WezTerminator (patch 0065): the "+" chip — spawn a new terminal
            // (a split of the active pane; it shows up as a new chip).
            UIItemType::DashboardEntry { pane_id } => {
                context.set_cursor(Some(MouseCursor::Hand));
                // Navigate only: switch the terminal on the right. Never split.
                if let WMEK::Press(MousePress::Left) = event.kind {
                    if let Err(err) = wtinator::dashboard::activate(self.mux_window_id, pane_id)
                    {
                        log::error!("bethterm dashboard activate: {err:#}");
                    }
                    context.invalidate();
                }
                if let WMEK::Release(MousePress::Right) = event.kind {
                    #[cfg(windows)]
                    show_native_full_menu(self, pane_id);
                }
            }
            UIItemType::DashboardClose => {
                context.set_cursor(Some(MouseCursor::Hand));
                if let WMEK::Press(MousePress::Left) = event.kind {
                    wtinator::dashboard::close(self.mux_window_id);
                    self.relayout_after_dashboard();
                }
            }
            UIItemType::PaneTabNew => {
                context.set_cursor(Some(MouseCursor::Hand));
                if let WMEK::Press(MousePress::Left) = event.kind {
                    let _ = self.perform_key_assignment(
                        &pane,
                        &config::keyassignment::KeyAssignment::SplitHorizontal(
                            config::keyassignment::SpawnCommand {
                                args: None,
                                ..Default::default()
                            },
                        ),
                    );
                    context.invalidate();
                }
                // WezTerminator (patch 0065): right-click the "+" → the same
                // existing native menu.
                if let WMEK::Release(MousePress::Right) = event.kind {
                    #[cfg(windows)]
                    show_native_full_menu(self, pane.pane_id());
                }
            }
            UIItemType::TabBar(tab_item) => {
                // WezTerminator patch 0035: pressing on a tab arms a drag
                // so it can be reordered (completed in complete_drag_drop).
                if let (WMEK::Press(MousePress::Left), TabBarItem::Tab { .. }) =
                    (&event.kind, &tab_item)
                {
                    self.dragging = Some((item_clone.clone(), event.clone()));
                }
                self.mouse_event_tab_bar(tab_item, event, context);
            }
            UIItemType::AboveScrollThumb => {
                self.mouse_event_above_scroll_thumb(item, pane, event, context);
            }
            UIItemType::ScrollThumb => {
                self.mouse_event_scroll_thumb(item, pane, event, context);
            }
            UIItemType::BelowScrollThumb => {
                self.mouse_event_below_scroll_thumb(item, pane, event, context);
            }
            UIItemType::Split(split) => {
                self.mouse_event_split(item, split, event, context);
            }
            UIItemType::CloseTab(idx) => {
                self.mouse_event_close_tab(idx, event, context);
            }
            UIItemType::PaneHeader(_header_pane_id) => {
                // WezTerminator patch 0036.5: show a Hand cursor while
                // hovering the header bar so the user discovers it is
                // draggable (drag it onto a tab to move the terminal).
                context.set_cursor(Some(MouseCursor::Hand));
                // WezTerminator patch 0030.5: double-click on header
                // enters inline edit mode.
                if let WMEK::Press(MousePress::Left) = event.kind {
                    if let Some(click) = self.last_mouse_click.as_ref() {
                        if click.streak >= 2 {
                            // Double-click detected - enter edit mode
                            self.editing_header_pane = Some(pane.pane_id());
                            self.header_edit_buffer = pane.get_header_text().unwrap_or_default();
                            context.invalidate();
                            return;
                        }
                    }
                    // WezTerminator patch 0035: a single left-press on the
                    // header arms a drag so the pane can be dropped onto a
                    // tab (completed in complete_drag_drop).
                    self.dragging = Some((item_clone.clone(), event.clone()));
                }
            }
        }
    }

    // WezTerminator patch 0035: finish a drag started in mouse_event_ui_item.
    // (A) a tab dropped onto another tab / new-tab button is reordered;
    // (B) a pane header dropped onto a tab moves the pane into that tab.
    fn complete_drag_drop(
        &mut self,
        drag_item: UIItem,
        release_event: &MouseEvent,
        context: &dyn WindowOps,
    ) {
        use crate::tabbar::TabBarItem;
        let drop_target = self.resolve_ui_item(release_event);
        log::info!(
            "wezterminator patch 0035: complete_drag_drop src={:?} drop_target={:?}",
            drag_item.item_type,
            drop_target.as_ref().map(|i| &i.item_type)
        );
        match drag_item.item_type {
            UIItemType::TabBar(TabBarItem::Tab { tab_idx: from, .. }) => {
                // WezTerminator: dropping a tab outside the tab strip detaches
                // the same live Tab into a new physical window. The mux move
                // retains every pane and PTY; no process is restarted.
                let dropped_on_tab_strip = matches!(
                    drop_target.as_ref().map(|item| &item.item_type),
                    Some(UIItemType::TabBar(_)) | Some(UIItemType::CloseTab(_))
                );
                if !dropped_on_tab_strip {
                    let tab_id = mux::Mux::get()
                        .get_window(self.mux_window_id)
                        .and_then(|window| window.get_by_idx(from).map(|tab| tab.tab_id()));
                    if let Some(tab_id) = tab_id {
                        match mux::Mux::get().move_tab_to_window(tab_id, None) {
                            Ok(window_id) => {
                                log::info!(
                                    "wezterminator: detached tab {} into window {}",
                                    tab_id,
                                    window_id
                                );
                                #[cfg(windows)]
                                if let Some(gui_window) = self.window.clone() {
                                    let hwnd = gui_window.hwnd() as isize;
                                    std::thread::spawn(move || {
                                        let result = wtinator::header::prompt_window_title(
                                            hwnd, None,
                                        );
                                        if let Some(name) = result {
                                            gui_window.notify(TermWindowNotif::Apply(
                                                Box::new(move |_| {
                                                    wtinator::header::apply_window_user_title(
                                                        window_id, name,
                                                    );
                                                }),
                                            ));
                                        }
                                    });
                                }
                            }
                            Err(err) => log::warn!(
                                "wezterminator: failed to detach tab {}: {:#}",
                                tab_id,
                                err
                            ),
                        }
                    }
                    context.invalidate();
                    return;
                }
                // Resolve the destination index. Prefer the tab
                // directly under the cursor; if the release lands
                // on the new-tab button, the tab-bar background, or
                // anywhere else on the tab strip, fall back to the
                // nearest tab by X so a slightly-off drop still
                // reorders (patch 0035.1: the strict match made
                // most drops no-op).
                let to = match drop_target.as_ref().map(|i| i.item_type.clone()) {
                    Some(UIItemType::TabBar(TabBarItem::Tab { tab_idx, .. })) => tab_idx,
                    _ => {
                        // Fall back: hit-test the release X against
                        // every tab UI item; pick the nearest. If
                        // none, drop at the end.
                        let rx = release_event.coords.x;
                        let mux = mux::Mux::get();
                        let last = mux
                            .get_window(self.mux_window_id)
                            .map(|w| w.len().saturating_sub(1))
                            .unwrap_or(from);
                        let mut best: Option<(usize, i64)> = None;
                        for it in self.ui_items.iter() {
                            if let UIItemType::TabBar(TabBarItem::Tab { tab_idx, .. }) =
                                it.item_type
                            {
                                let center = it.x as i64 + (it.width as i64) / 2;
                                let dist = (center - rx as i64).abs();
                                if best.map_or(true, |(_, d)| dist < d) {
                                    best = Some((tab_idx, dist));
                                }
                            }
                        }
                        best.map(|(idx, _)| idx).unwrap_or(last)
                    }
                };
                log::info!(
                    "wezterminator patch 0035: reorder tab {} -> {}",
                    from,
                    to
                );
                if let Err(e) = self.move_tab_from_to(from, to) {
                    log::warn!("wezterminator patch 0035: move_tab_from_to failed: {:#}", e);
                }
                context.invalidate();
            }
            UIItemType::PaneHeader(pane_id) => {
                // (0) WezTerminator patch 0037: VS-style dock. If the
                // drag was hovering a target pane + edge zone, dock the
                // pane there (split the target in that direction, or
                // swap for Center). This takes precedence over the
                // tab-drop / swap paths below.
                if let Some(hover) = self.pane_dock_hover.take() {
                    if hover.dragged_pane == pane_id {
                        log::info!(
                            "wezterminator patch 0037: dock pane {} onto {} zone {:?}",
                            pane_id,
                            hover.target_pane,
                            hover.zone
                        );
                        match wtinator::groups::dock_pane_to_pane(
                            pane_id,
                            hover.target_pane,
                            hover.zone,
                        ) {
                            Ok(_) => {
                                let mux = mux::Mux::get();
                                if let Some(window_id) =
                                    mux.window_containing_tab(
                                        mux.resolve_pane_id(hover.target_pane)
                                            .map(|(_, _, t)| t)
                                            .unwrap_or(0),
                                    )
                                {
                                    mux.notify(mux::MuxNotification::WindowInvalidated(window_id));
                                }
                                context.invalidate();
                            }
                            Err(e) => log::warn!(
                                "wezterminator patch 0037: dock_pane_to_pane failed: {:#}",
                                e
                            ),
                        }
                        return;
                    }
                }
                match drop_target.as_ref().map(|i| i.item_type.clone()) {
                    // (A) Dropped on a TAB → move the pane into that tab.
                    Some(UIItemType::TabBar(TabBarItem::Tab { tab_idx, .. })) => {
                        let mux = mux::Mux::get();
                        let target_tab_id = mux
                            .get_window(self.mux_window_id)
                            .and_then(|w| w.get_by_idx(tab_idx).map(|t| t.tab_id()));
                        if let Some(target_tab_id) = target_tab_id {
                            match wtinator::groups::move_pane_to_tab(pane_id, target_tab_id) {
                                Ok(_) => {
                                    if let Some(window_id) =
                                        mux.window_containing_tab(target_tab_id)
                                    {
                                        mux.notify(mux::MuxNotification::WindowInvalidated(
                                            window_id,
                                        ));
                                    }
                                }
                                Err(e) => log::warn!(
                                    "wezterminator patch 0035: move_pane_to_tab failed: {:#}",
                                    e
                                ),
                            }
                        }
                    }
                    // (B) WezTerminator patch 0036.7: dropped on ANOTHER
                    // pane's header in the same tab → swap the two panes
                    // (reposition within the same tab). The header is
                    // only rendered for the active tab's panes, so both
                    // panes are in the active tab.
                    Some(UIItemType::PaneHeader(target_pane_id))
                        if target_pane_id != pane_id =>
                    {
                        let mux = mux::Mux::get();
                        if let Some(tab) = mux.get_active_tab_for_window(self.mux_window_id) {
                            let panes = tab.iter_panes();
                            let src_idx = panes
                                .iter()
                                .find(|p| p.pane.pane_id() == pane_id)
                                .map(|p| p.index);
                            let dst_idx = panes
                                .iter()
                                .find(|p| p.pane.pane_id() == target_pane_id)
                                .map(|p| p.index);
                            log::info!(
                                "wezterminator patch 0035: swap pane {} (idx {:?}) <-> {} (idx {:?})",
                                pane_id,
                                src_idx,
                                target_pane_id,
                                dst_idx
                            );
                            if let (Some(s), Some(d)) = (src_idx, dst_idx) {
                                tab.set_active_idx(s);
                                tab.swap_active_with_index(d, true);
                                if let Some(window_id) =
                                    mux.window_containing_tab(tab.tab_id())
                                {
                                    mux.notify(mux::MuxNotification::WindowInvalidated(
                                        window_id,
                                    ));
                                }
                                context.invalidate();
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    pub fn mouse_event_close_tab(
        &mut self,
        idx: usize,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        match event.kind {
            WMEK::Press(MousePress::Left) => {
                log::debug!(
                    "Should close tab {} (wezterminator patch 0032: Win32 confirm)",
                    idx
                );
                // WezTerminator patch 0032: route through
                // the Win32-native `MessageBoxW` confirmation
                // instead of the Skia overlay. The Win32
                // path is guaranteed to respond even when
                // the terminal UI thread is busy (frozen
                // tab) — the user's report on 2026-06-12
                // was that the Skia overlay would not come
                // up in that state.
                self.close_specific_tab_with_win32_confirm(idx);
            }
            _ => {}
        }
        context.set_cursor(Some(MouseCursor::Arrow));
    }

    fn do_new_tab_button_click(&mut self, button: MousePress) {
        let pane = match self.get_active_pane_or_overlay() {
            Some(pane) => pane,
            None => return,
        };

        // WezTerminator local patch (2026-06-06): see PATCHES.md patch 0006.
        // The `+` button on the tab bar is the primary entry point for
        // "I want a new terminal" in our UX. To make it friendly, the
        // left-click on `+` opens the WezTerminator **native shell
        // picker** (a real Win32 HMENU popup menu, not a Skia overlay).
        // Right-click on `+` opens the full menu (shells + splits +
        // close pane).
        let action = match button {
            MousePress::Left => {
                show_native_shell_picker(self);
                return;
            }
            MousePress::Right => {
                let pane = match self.get_active_pane_or_overlay() {
                    Some(pane) => pane,
                    None => return,
                };
                show_native_full_menu(self, pane.pane_id());
                return;
            }
            MousePress::Middle => None,
        };

        async fn dispatch_new_tab_button(
            lua: Option<Rc<mlua::Lua>>,
            window: GuiWin,
            pane: MuxPane,
            button: MousePress,
            action: Option<KeyAssignment>,
        ) -> anyhow::Result<()> {
            let default_action = match lua {
                Some(lua) => {
                    let args = lua.pack_multi((
                        window.clone(),
                        pane,
                        format!("{button:?}"),
                        action.clone(),
                    ))?;
                    config::lua::emit_event(&lua, ("new-tab-button-click".to_string(), args))
                        .await
                        .map_err(|e| {
                            log::error!("while processing new-tab-button-click event: {:#}", e);
                            e
                        })?
                }
                None => true,
            };
            if let (true, Some(assignment)) = (default_action, action) {
                window.window.notify(TermWindowNotif::PerformAssignment {
                    pane_id: pane.0,
                    assignment,
                    tx: None,
                });
            }
            Ok(())
        }
        let window = GuiWin::new(self);
        let pane = MuxPane(pane.pane_id());
        promise::spawn::spawn(config::with_lua_config_on_main_thread(move |lua| {
            dispatch_new_tab_button(lua, window, pane, button, action)
        }))
        .detach();
    }

    pub fn mouse_event_tab_bar(
        &mut self,
        item: TabBarItem,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        match event.kind {
            WMEK::Press(MousePress::Left) => match item {
                TabBarItem::Tab { tab_idx, .. } => {
                    self.activate_tab(tab_idx as isize).ok();
                }
                TabBarItem::NewTabButton { .. } => {
                    self.do_new_tab_button_click(MousePress::Left);
                }
                TabBarItem::LeftStatus | TabBarItem::RightStatus => {
                    // WezTerminator local patch (2026-06-06): see PATCHES.md
                    // patch 0009. The `LeftStatus` and `RightStatus` areas
                    // of the tab bar are normally inert text. We
                    // repurpose them as a "Split" affordance for mouse
                    // users: a single left-click on the status area
                    // opens the **native** split picker.
                    show_native_split_picker(self);
                    return;
                }
                TabBarItem::None => {
                    let maximized = self
                        .window_state
                        .intersects(WindowState::MAXIMIZED | WindowState::FULL_SCREEN);
                    if let Some(ref window) = self.window {
                        if self.config.window_decorations
                            == WindowDecorations::INTEGRATED_BUTTONS | WindowDecorations::RESIZE
                        {
                            if self.last_mouse_click.as_ref().map(|c| c.streak) == Some(2) {
                                if maximized {
                                    window.restore();
                                } else {
                                    window.maximize();
                                }
                            }
                        }
                    }
                    // Potentially starting a drag by the tab bar
                    if !maximized {
                        self.window_drag_position.replace(event.clone());
                    }
                    context.request_drag_move();
                }
                TabBarItem::WindowButton(button) => {
                    use window::IntegratedTitleButton as Button;
                    if let Some(ref window) = self.window {
                        match button {
                            Button::Hide => {
                                wtinator::host::note_life(&format!(
                                    "titlebar Hide window={}",
                                    self.mux_window_id
                                ));
                                window.hide();
                            }
                            Button::Maximize => {
                                let maximized = self
                                    .window_state
                                    .intersects(WindowState::MAXIMIZED | WindowState::FULL_SCREEN);
                                wtinator::host::note_life(&format!(
                                    "titlebar {} window={}",
                                    if maximized { "Restore" } else { "Maximize" },
                                    self.mux_window_id
                                ));
                                if maximized {
                                    window.restore();
                                } else {
                                    window.maximize();
                                }
                            }
                            Button::Close => {
                                wtinator::host::note_life(&format!(
                                    "titlebar Close window={}",
                                    self.mux_window_id
                                ));
                                self.close_requested_with_confirmation(&window.clone())
                            }
                        }
                    }
                }
            },
            WMEK::Press(MousePress::Middle) => match item {
                TabBarItem::Tab { tab_idx, .. } => {
                    self.close_specific_tab(tab_idx, true);
                }
                TabBarItem::NewTabButton { .. } => {
                    self.do_new_tab_button_click(MousePress::Middle);
                }
                TabBarItem::None
                | TabBarItem::LeftStatus
                | TabBarItem::RightStatus
                | TabBarItem::WindowButton(_) => {}
            },
            WMEK::Press(MousePress::Right) => match item {
                TabBarItem::Tab { tab_idx, .. } => {
                    // WezTerminator patch 0031: in WezTerminator
                    // mode, right-click on a tab opens the
                    // WezTerminator native right-click menu
                    // (which now includes "Rename tab…"),
                    // exactly like right-click on the
                    // terminal pane. The upstream
                    // `show_tab_navigator` Skia overlay would
                    // otherwise eat the right-click and
                    // block access to the per-tab rename.
                    //
                    // In plain wezterm, the original
                    // `show_tab_navigator` behaviour is
                    // preserved so non-WezTerminator users
                    // still get the tab-list overlay.
                    if crate::tabbar::is_wtinator_active() {
                        show_native_tab_menu(self, tab_idx);
                    } else {
                        self.show_tab_navigator();
                    }
                }
                TabBarItem::NewTabButton { .. } => {
                    self.do_new_tab_button_click(MousePress::Right);
                }
                TabBarItem::None
                | TabBarItem::LeftStatus
                | TabBarItem::RightStatus
                | TabBarItem::WindowButton(_) => {}
            },
            WMEK::Move => match item {
                TabBarItem::None | TabBarItem::LeftStatus | TabBarItem::RightStatus => {
                    context.set_window_drag_position(event.screen_coords);
                }
                TabBarItem::WindowButton(window::IntegratedTitleButton::Maximize) => {
                    let item = self.last_ui_item.clone().unwrap();
                    let bounds: ::window::ScreenRect = euclid::rect(
                        item.x as isize - (event.coords.x as isize - event.screen_coords.x),
                        item.y as isize - (event.coords.y as isize - event.screen_coords.y),
                        item.width as isize,
                        item.height as isize,
                    );
                    context.set_maximize_button_position(bounds);
                }
                TabBarItem::WindowButton(_)
                | TabBarItem::Tab { .. }
                | TabBarItem::NewTabButton { .. } => {}
            },
            WMEK::VertWheel(n) => {
                if self.config.mouse_wheel_scrolls_tabs {
                    self.activate_tab_relative(if n < 1 { 1 } else { -1 }, true)
                        .ok();
                }
            }
            _ => {}
        }
        context.set_cursor(Some(MouseCursor::Arrow));
    }

    pub fn mouse_event_above_scroll_thumb(
        &mut self,
        _item: UIItem,
        pane: Arc<dyn Pane>,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        if let WMEK::Press(MousePress::Left) = event.kind {
            let dims = pane.get_dimensions();
            let current_viewport = self.get_viewport(pane.pane_id());
            // Page up
            self.set_viewport(
                pane.pane_id(),
                Some(
                    current_viewport
                        .unwrap_or(dims.physical_top)
                        .saturating_sub(self.terminal_size.rows.try_into().unwrap()),
                ),
                dims,
            );
            context.invalidate();
        }
        context.set_cursor(Some(MouseCursor::Arrow));
    }

    pub fn mouse_event_below_scroll_thumb(
        &mut self,
        _item: UIItem,
        pane: Arc<dyn Pane>,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        if let WMEK::Press(MousePress::Left) = event.kind {
            let dims = pane.get_dimensions();
            let current_viewport = self.get_viewport(pane.pane_id());
            // Page down
            self.set_viewport(
                pane.pane_id(),
                Some(
                    current_viewport
                        .unwrap_or(dims.physical_top)
                        .saturating_add(self.terminal_size.rows.try_into().unwrap()),
                ),
                dims,
            );
            context.invalidate();
        }
        context.set_cursor(Some(MouseCursor::Arrow));
    }

    pub fn mouse_event_scroll_thumb(
        &mut self,
        item: UIItem,
        _pane: Arc<dyn Pane>,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        if let WMEK::Press(MousePress::Left) = event.kind {
            // Start a scroll drag
            // self.scroll_drag_start = Some(from_top);
            self.dragging = Some((item, event));
        }
        context.set_cursor(Some(MouseCursor::Arrow));
    }

    pub fn mouse_event_split(
        &mut self,
        item: UIItem,
        split: PositionedSplit,
        event: MouseEvent,
        context: &dyn WindowOps,
    ) {
        context.set_cursor(Some(match &split.direction {
            SplitDirection::Horizontal => MouseCursor::SizeLeftRight,
            SplitDirection::Vertical => MouseCursor::SizeUpDown,
        }));

        if event.kind == WMEK::Press(MousePress::Left) {
            self.dragging.replace((item, event));
        }
    }

    fn mouse_event_terminal(
        &mut self,
        mut pane: Arc<dyn Pane>,
        position: ClickPosition,
        event: MouseEvent,
        context: &dyn WindowOps,
        capture_mouse: bool,
    ) {
        let mut is_click_to_focus_pane = false;
        let mut show_full_menu = false;

        // WezTerminator patch 0010: consume right-button down so the
        // terminal app does not see it, but show the native Win32 menu
        // only after button up. Showing an HMENU while the right button
        // is still held can make the release select the item under the
        // cursor; near the bottom of the screen that can be "Close pane".
        match event.kind {
            WMEK::Press(MousePress::Right) => return,
            WMEK::Release(MousePress::Right) => {
                // Don't show menu yet; wait until we detect which pane
                // was clicked (after the pane detection loop below).
                show_full_menu = true;
            }
            _ => {}
        }

        let ClickPosition {
            mut column,
            mut row,
            mut x_pixel_offset,
            mut y_pixel_offset,
        } = position;

        log::debug!(
            "wezterminator selection diag: mouse_event_terminal kind={:?} window_cell=({}, {}) pixel_offset=({:?},{:?})",
            event.kind, column, row, x_pixel_offset, y_pixel_offset
        );

        let is_already_captured = matches!(
            self.current_mouse_capture,
            Some(MouseCapture::TerminalPane(_))
        );

        // WezTerminator (patch 0058): track which pane the mouse is physically
        // over, so the hyperlink hover-highlight is resolved against *that* pane
        // rather than the active one (see the highlight block further below).
        let mut hover_pane: Option<Arc<dyn Pane>> = None;

        for pos in self.get_panes_to_render() {
            if !is_already_captured
                && row >= pos.top as i64
                && row <= (pos.top + pos.height) as i64
                && column >= pos.left
                && column <= pos.left + pos.width
            {
                if pane.pane_id() != pos.pane.pane_id() {
                    // We're over a pane that isn't active
                    match &event.kind {
                        WMEK::Press(_) => {
                            let mux = Mux::get();
                            mux.get_active_tab_for_window(self.mux_window_id)
                                .map(|tab| tab.set_active_idx(pos.index));

                            pane = Arc::clone(&pos.pane);
                            is_click_to_focus_pane = true;
                        }
                        WMEK::Move => {
                            if self.config.pane_focus_follows_mouse {
                                let mux = Mux::get();
                                mux.get_active_tab_for_window(self.mux_window_id)
                                    .map(|tab| tab.set_active_idx(pos.index));

                                pane = Arc::clone(&pos.pane);
                                context.invalidate();
                            }
                        }
                        WMEK::Release(_) | WMEK::HorzWheel(_) => {}
                        WMEK::VertWheel(_) => {
                            // Let wheel events route to the hovered pane,
                            // even if it doesn't have focus
                            pane = Arc::clone(&pos.pane);
                            context.invalidate();
                        }
                    }
                }
                let mapped = self.map_pixel_click_to_pane_cell(&event, &pos);
                column = mapped.0;
                row = mapped.1;
                x_pixel_offset = mapped.2;
                y_pixel_offset = mapped.3;
                hover_pane = Some(Arc::clone(&pos.pane));
                break;
            } else if is_already_captured && pane.pane_id() == pos.pane.pane_id() {
                let mapped = self.map_pixel_click_to_pane_cell(&event, &pos);
                column = mapped.0;
                row = mapped.1;
                x_pixel_offset = mapped.2;
                y_pixel_offset = mapped.3;

                hover_pane = Some(Arc::clone(&pos.pane));
                break;
            }
        }

        // WezTerminator (patch 0033): if the user
        // right-clicked on a non-active pane, the
        // pane-detection loop above (line 798-823)
        // only updates `pane` on `Press` (which is
        // consumed for right-button by patch 0010 —
        // see line 768). On `Release(Right)`, `pane`
        // would otherwise stay as the active pane
        // and the right-click menu's `pane_id` would
        // point to the wrong pane — so a subsequent
        // "open in new tab" entry would inherit
        // cwd / domain from the active tab instead
        // of the right-clicked tab. The user
        // reported this on 2026-06-12 as "as vezes
        // ele abre novo terminal em relacao ao
        // terminal ativo ao inves de respeitar
        // onde o usuario clicou com o menu".
        //
        // Re-run the pane detection now, against
        // the same `column` / `row`, and update
        // `pane` to the right-clicked pane so it
        // flows through to `show_full_menu` below.
        if show_full_menu {
            for pos in self.get_panes_to_render() {
                let col = position.column;
                let r = position.row;
                if r >= pos.top as i64
                    && r <= (pos.top + pos.height) as i64
                    && col >= pos.left
                    && col <= pos.left + pos.width
                {
                    pane = Arc::clone(&pos.pane);
                    break;
                }
            }
        }

        if show_full_menu {
            show_native_full_menu(self, pane.pane_id());
            return;
        }

        if capture_mouse {
            self.current_mouse_capture = Some(MouseCapture::TerminalPane(pane.pane_id()));
        }

        let is_focused = if let Some(focused) = self.focused.as_ref() {
            !self.config.swallow_mouse_click_on_window_focus
                || (focused.elapsed() > Duration::from_millis(200))
        } else {
            false
        };

        if self.focused.is_some() && !is_focused {
            if matches!(&event.kind, WMEK::Press(_))
                && self.config.swallow_mouse_click_on_window_focus
            {
                // Entering click to focus state
                self.is_click_to_focus_window = true;
                context.invalidate();
                log::trace!("enter click to focus");
                return;
            }
        }
        if self.is_click_to_focus_window && matches!(&event.kind, WMEK::Release(_)) {
            // Exiting click to focus state
            self.is_click_to_focus_window = false;
            context.invalidate();
            log::trace!("exit click to focus");
            return;
        }

        let allow_action = if self.is_click_to_focus_window || !is_focused {
            matches!(&event.kind, WMEK::VertWheel(_) | WMEK::HorzWheel(_))
        } else {
            true
        };

        log::trace!(
            "is_focused={} allow_action={} event={:?}",
            is_focused,
            allow_action,
            event
        );

        let dims = pane.get_dimensions();
        let stable_row = self
            .get_viewport(pane.pane_id())
            .unwrap_or(dims.physical_top)
            + row as StableRowIndex;

        log::debug!(
            "wezterminator selection diag: pane={} has_header={} local_cell=({}, {}) stable_row={} viewport_rows={}",
            pane.pane_id(),
            self.pane_has_header(&pane),
            column,
            row,
            stable_row,
            dims.viewport_rows
        );

        self.pane_state(pane.pane_id())
            .mouse_terminal_coords
            .replace((
                ClickPosition {
                    column,
                    row,
                    x_pixel_offset,
                    y_pixel_offset,
                },
                stable_row,
            ));

        struct FindCurrentLink {
            current: Option<Arc<Hyperlink>>,
            stable_row: StableRowIndex,
            column: usize,
        }

        impl WithPaneLines for FindCurrentLink {
            fn with_lines_mut(&mut self, stable_top: StableRowIndex, lines: &mut [&mut Line]) {
                if stable_top == self.stable_row {
                    if let Some(line) = lines.get(0) {
                        if let Some(cell) = line.get_cell(self.column) {
                            self.current = cell.attrs().hyperlink().cloned();
                        }
                    }
                }
            }
        }

        // WezTerminator (patch 0058): resolve the hovered hyperlink against the
        // pane the mouse is physically over (`hover_pane`), not the active pane.
        // `column`/`row` were already translated into that pane's local coordinate
        // space by the detection loop above, so we recompute a matching stable row
        // from the hovered pane's own viewport. Previously this ran against `pane`
        // (the active pane), which lit up a link in the focused split while the
        // mouse hovered a *different* split. When the mouse is not over any pane,
        // `hover_pane` is None and the highlight is cleared.
        let new_highlight = if let Some(hover_pane) = hover_pane.as_ref() {
            let hover_dims = hover_pane.get_dimensions();
            let hover_stable_row = self
                .get_viewport(hover_pane.pane_id())
                .unwrap_or(hover_dims.physical_top)
                + row as StableRowIndex;
            hover_pane.apply_hyperlinks(
                hover_stable_row..hover_stable_row + 1,
                &self.config.hyperlink_rules,
            );
            let mut find_link = FindCurrentLink {
                current: None,
                stable_row: hover_stable_row,
                column,
            };
            hover_pane.with_lines_mut(hover_stable_row..hover_stable_row + 1, &mut find_link);
            find_link.current
        } else {
            None
        };

        match (self.current_highlight.as_ref(), new_highlight) {
            (Some(old_link), Some(new_link)) if Arc::ptr_eq(&old_link, &new_link) => {
                // Unchanged
            }
            (None, None) => {
                // Unchanged
            }
            (_, rhs) => {
                // We're hovering over a different URL, so invalidate and repaint
                // so that we render the underline correctly
                self.current_highlight = rhs;
                context.invalidate();
            }
        };

        let outside_window = event.coords.x < 0
            || event.coords.x as usize > self.dimensions.pixel_width
            || event.coords.y < 0
            || event.coords.y as usize > self.dimensions.pixel_height;

        context.set_cursor(Some(
            // WezTerminator (patch 0058): only show the clickable Hand cursor while
            // Ctrl is held, because links now open with Ctrl+click. The hover
            // underline (driven by current_highlight) still shows without Ctrl, so
            // links stay discoverable.
            if self.current_highlight.is_some()
                && event.modifiers.contains(::window::Modifiers::CTRL)
            {
                MouseCursor::Hand
            } else if pane.is_mouse_grabbed() || outside_window {
                MouseCursor::Arrow
            } else {
                MouseCursor::Text
            },
        ));

        let event_trigger_type = match &event.kind {
            WMEK::Press(press) => {
                let press = mouse_press_to_tmb(press);
                match self.last_mouse_click.as_ref() {
                    Some(LastMouseClick { streak, button, .. }) if *button == press => {
                        Some(MouseEventTrigger::Down {
                            streak: *streak,
                            button: press,
                        })
                    }
                    _ => None,
                }
            }
            WMEK::Release(press) => {
                let press = mouse_press_to_tmb(press);
                match self.last_mouse_click.as_ref() {
                    Some(LastMouseClick { streak, button, .. }) if *button == press => {
                        Some(MouseEventTrigger::Up {
                            streak: *streak,
                            button: press,
                        })
                    }
                    _ => None,
                }
            }
            WMEK::Move => {
                if !self.current_mouse_buttons.is_empty() {
                    if let Some(LastMouseClick { streak, button, .. }) =
                        self.last_mouse_click.as_ref()
                    {
                        if Some(*button)
                            == self.current_mouse_buttons.last().map(mouse_press_to_tmb)
                        {
                            Some(MouseEventTrigger::Drag {
                                streak: *streak,
                                button: *button,
                            })
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            WMEK::VertWheel(amount) => Some(match *amount {
                0 => return,
                1.. => MouseEventTrigger::Down {
                    streak: 1,
                    button: MouseButton::WheelUp(*amount as usize),
                },
                _ => MouseEventTrigger::Down {
                    streak: 1,
                    button: MouseButton::WheelDown(-amount as usize),
                },
            }),
            WMEK::HorzWheel(amount) => Some(match *amount {
                0 => return,
                1.. => MouseEventTrigger::Down {
                    streak: 1,
                    button: MouseButton::WheelLeft(*amount as usize),
                },
                _ => MouseEventTrigger::Down {
                    streak: 1,
                    button: MouseButton::WheelRight(-amount as usize),
                },
            }),
        };

        if allow_action {
            if let Some(mut event_trigger_type) = event_trigger_type {
                self.current_event = Some(event_trigger_type.to_dynamic());
                let mut modifiers = event.modifiers;

                // Since we use shift to force assessing the mouse bindings, pretend
                // that shift is not one of the mods when the mouse is grabbed.
                let mut mouse_reporting = pane.is_mouse_grabbed();
                if mouse_reporting {
                    if modifiers.contains(self.config.bypass_mouse_reporting_modifiers) {
                        modifiers.remove(self.config.bypass_mouse_reporting_modifiers);
                        mouse_reporting = false;
                    }
                }

                if mouse_reporting {
                    // If they were scrolled back prior to launching an
                    // application that captures the mouse, then mouse based
                    // scrolling assignments won't have any effect.
                    // Ensure that we scroll to the bottom if they try to
                    // use the mouse so that things are less surprising
                    self.scroll_to_bottom(&pane);
                }

                // normalize delta and streak to make mouse assignment
                // easier to wrangle
                match event_trigger_type {
                    MouseEventTrigger::Down {
                        ref mut streak,
                        button:
                            MouseButton::WheelUp(ref mut delta)
                            | MouseButton::WheelDown(ref mut delta)
                            | MouseButton::WheelLeft(ref mut delta)
                            | MouseButton::WheelRight(ref mut delta),
                    }
                    | MouseEventTrigger::Up {
                        ref mut streak,
                        button:
                            MouseButton::WheelUp(ref mut delta)
                            | MouseButton::WheelDown(ref mut delta)
                            | MouseButton::WheelLeft(ref mut delta)
                            | MouseButton::WheelRight(ref mut delta),
                    }
                    | MouseEventTrigger::Drag {
                        ref mut streak,
                        button:
                            MouseButton::WheelUp(ref mut delta)
                            | MouseButton::WheelDown(ref mut delta)
                            | MouseButton::WheelLeft(ref mut delta)
                            | MouseButton::WheelRight(ref mut delta),
                    } => {
                        *streak = 1;
                        *delta = 1;
                    }
                    _ => {}
                };

                let mouse_mods = config::MouseEventTriggerMods {
                    mods: modifiers,
                    mouse_reporting,
                    alt_screen: if pane.is_alt_screen_active() {
                        MouseEventAltScreen::True
                    } else {
                        MouseEventAltScreen::False
                    },
                };

                if let Some(action) = self.input_map.lookup_mouse(event_trigger_type, mouse_mods) {
                    log::debug!(
                        "wezterminator selection diag: mouse action triggered={:?}",
                        action
                    );
                    self.perform_key_assignment(&pane, &action).ok();
                    return;
                }
            }
        }

        let mouse_event = wezterm_term::MouseEvent {
            kind: match event.kind {
                WMEK::Move => TMEK::Move,
                WMEK::VertWheel(_) | WMEK::HorzWheel(_) | WMEK::Press(_) => TMEK::Press,
                WMEK::Release(_) => TMEK::Release,
            },
            button: match event.kind {
                WMEK::Release(ref press) | WMEK::Press(ref press) => mouse_press_to_tmb(press),
                WMEK::Move => {
                    if event.mouse_buttons == WMB::LEFT {
                        TMB::Left
                    } else if event.mouse_buttons == WMB::RIGHT {
                        TMB::Right
                    } else if event.mouse_buttons == WMB::MIDDLE {
                        TMB::Middle
                    } else {
                        TMB::None
                    }
                }
                WMEK::VertWheel(amount) => {
                    if amount > 0 {
                        TMB::WheelUp(amount as usize)
                    } else {
                        TMB::WheelDown((-amount) as usize)
                    }
                }
                WMEK::HorzWheel(amount) => {
                    if amount > 0 {
                        TMB::WheelLeft(amount as usize)
                    } else {
                        TMB::WheelRight((-amount) as usize)
                    }
                }
            },
            x: column,
            y: row,
            x_pixel_offset,
            y_pixel_offset,
            modifiers: event.modifiers,
        };

        if allow_action
            && !(self.config.swallow_mouse_click_on_pane_focus && is_click_to_focus_pane)
        {
            pane.mouse_event(mouse_event).ok();
        }

        match event.kind {
            WMEK::Move => {}
            _ => {
                context.invalidate();
            }
        }
    }
}

fn mouse_press_to_tmb(press: &MousePress) -> TMB {
    match press {
        MousePress::Left => TMB::Left,
        MousePress::Right => TMB::Right,
        MousePress::Middle => TMB::Middle,
    }
}

// =============================================================================
// WezTerminator local patch (2026-06-06): see PATCHES.md patch 0009.
// Native Win32 menu helpers. These build a real Win32 HMENU popup and
// show it via TrackPopupMenuEx. The result is a real Windows context
// menu (the same widget you see when you right-click on any Windows
// application) — not a Skia overlay inside wezterm-gui. This makes
// the menu always visible and always themed by the OS, which fixes
// the "overlay does not show" issue some users reported.
//
// On non-Windows targets these are stubs; the upstream `InputSelector`
// overlay path is used instead.
// =============================================================================

#[cfg(windows)]
fn show_native_shell_picker(window: &mut super::TermWindow) {
    let pane = match window.get_active_pane_or_overlay() {
        Some(pane) => pane,
        None => return,
    };
    let items = wtinator::context_menu::platform::shell_picker_items();
    schedule_native_menu(window, items, pane.pane_id());
}

#[cfg(windows)]
fn show_native_split_picker(window: &mut super::TermWindow) {
    let pane = match window.get_active_pane_or_overlay() {
        Some(pane) => pane,
        None => return,
    };
    let items = wtinator::context_menu::platform::split_picker_items();
    schedule_native_menu(window, items, pane.pane_id());
}

impl super::TermWindow {
    /// Pixel origin of the mux cell grid, matching `paint_pane` /
    /// `resize.rs`: tab bar (if at top) + list-mode pane strip +
    /// padding + OS border.
    fn terminal_grid_origin_pixels(&self) -> (f32, f32) {
        let (padding_left, padding_top) = self.padding_left_top();
        let border = self.get_os_border();
        let tab_bar_height = if self.show_tab_bar {
            self.tab_bar_pixel_height().unwrap_or(0.)
        } else {
            0.
        };
        let top_bar = if self.config.tab_bar_at_bottom {
            0.0
        } else {
            tab_bar_height
        };
        (
            padding_left + border.left.get() as f32,
            top_bar + self.pane_strip_pixel_height() + padding_top + border.top.get() as f32,
        )
    }

    /// Map a window pixel click to the pane's *content* cell, using the
    /// same origin and header reservation as painting, and that pane's
    /// own cell metrics (per-pane font scale/family). Integer-dividing
    /// window cells then `/ scale` missed the list-mode strip and drifted
    /// inside scaled panes (patch 0090).
    fn map_pixel_click_to_pane_cell(
        &self,
        event: &MouseEvent,
        pos: &mux::tab::PositionedPane,
    ) -> (usize, i64, isize, isize) {
        let (origin_x, origin_y) = self.terminal_grid_origin_pixels();
        let base_w = self.render_metrics.cell_size.width as f32;
        let base_h = self.render_metrics.cell_size.height as f32;
        let local_x = event.coords.x as f32 - origin_x - (pos.left as f32 * base_w);
        let mut local_y = event.coords.y as f32 - origin_y - (pos.top as f32 * base_h);
        if self.pane_has_header(&pos.pane) {
            local_y -= base_h;
        }
        let (_, pane_metrics) = self.fonts_and_metrics_for_pane_font(
            pos.pane.get_font_scale(),
            pos.pane.get_font_family().as_deref(),
            pos.pane.get_font_bold(),
            pos.pane.get_font_italic(),
        );
        let pane_w = pane_metrics.cell_size.width as f32;
        let pane_h = pane_metrics.cell_size.height as f32;
        let mut col = if pane_w > 0.0 { local_x / pane_w } else { 0.0 };
        if !pos.pane.is_mouse_grabbed() {
            col = col.round();
        }
        let column = col.max(0.0).trunc() as usize;
        let row = if pane_h > 0.0 {
            (local_y / pane_h).floor() as i64
        } else {
            0
        };
        let x_pixel_offset = if pane_w > 0.0 {
            (local_x - column as f32 * pane_w) as isize
        } else {
            0
        };
        let y_pixel_offset = if pane_h > 0.0 {
            (local_y - row.max(0) as f32 * pane_h) as isize
        } else {
            0
        };
        (column, row.max(0), x_pixel_offset, y_pixel_offset)
    }
}

#[cfg(windows)]
fn show_native_full_menu(window: &mut super::TermWindow, pane_id: PaneId) {
    let items = wtinator::context_menu::platform::full_menu_items();
    schedule_native_menu(window, items, pane_id);
}

#[cfg(windows)]
fn show_native_tab_menu(window: &mut super::TermWindow, tab_idx: usize) {
    let pane_id = {
        let mux = mux::Mux::get();
        let Some(mux_window) = mux.get_window(window.mux_window_id) else {
            return;
        };
        let Some(tab) = mux_window.get_by_idx(tab_idx) else {
            return;
        };
        let Some(pane) = tab.get_active_pane() else {
            return;
        };
        pane.pane_id()
    };
    let items =
        wtinator::context_menu::platform::tab_menu_items(window.mux_window_id);
    schedule_native_menu(window, items, pane_id);
}

#[cfg(windows)]
fn schedule_native_menu(
    window: &mut super::TermWindow,
    items: Vec<wtinator::context_menu::MenuEntry>,
    pane_id: PaneId,
) {
    use windows_sys::Win32::Foundation::HWND;

    if items.is_empty() {
        return;
    }

    let _pane = match mux::Mux::get().get_pane(pane_id) {
        Some(pane) => pane,
        None => return,
    };
    let (gui_window, hwnd_value) = match window.window.as_ref() {
        Some(window) => (window.clone(), window.hwnd() as isize),
        None => return,
    };
    let mux_window_id = window.mux_window_id;

    log::info!("wezterminator patch 0010: deferring native menu to main thread");

    // TrackPopupMenuEx runs a nested Win32 modal loop. Do not run that
    // loop inside dispatch_window_event, because Win32 can re-enter WndProc
    // while window::WindowInner is already mutably borrowed. Defer to the
    // main thread so the current mouse/window callback can return first,
    // but still show the HMENU from the UI thread that owns the window.
    promise::spawn::spawn_into_main_thread(async move {
        let hwnd: HWND = hwnd_value as HWND;
        if hwnd.is_null() {
            log::warn!("wezterminator patch 0010: window hwnd is null");
            return;
        }

        log::info!("wezterminator patch 0010: main thread is showing HMENU");
        wtinator::host::note_life(&format!(
            "right-click menu opened hwnd={hwnd_value} window={mux_window_id}"
        ));
        let wid = unsafe { wtinator::context_menu::platform::show_at(hwnd, 0, 0, &items) };
        if let Some(wid) = wid {
            let chosen = wtinator::context_menu::classify(wid);
            wtinator::host::note_life(&format!(
                "right-click menu chose {} hwnd={hwnd_value}",
                chosen
                    .as_ref()
                    .map(wtinator::context_menu::describe_action)
                    .unwrap_or_else(|| format!("wid {wid:#x}"))
            ));
            match chosen {
                Some(wtinator::context_menu::DispatchAction::Assignment(assignment)) => {
                    gui_window.notify(TermWindowNotif::PerformAssignment {
                        pane_id,
                        assignment,
                        tx: None,
                    });
                }
                Some(wtinator::context_menu::DispatchAction::SaveScrollback) => {
                    // Patch 0015: read the pane's scrollback, show the
                    // native Save-As dialog, and write the file in a
                    // background thread. Requires the live `MuxPane`,
                    // which is fetched from the global `Mux`.
                    if let Some(pane) = mux::Mux::get().get_pane(pane_id) {
                        if let Err(e) = wtinator::save_scrollback::save_to_file(pane, hwnd as isize)
                        {
                            log::error!("wezterminator patch 0015: save failed: {:#}", e);
                        }
                    } else {
                        log::warn!(
                            "wezterminator patch 0015: pane {} no longer exists",
                            pane_id
                        );
                    }
                }
                Some(wtinator::context_menu::DispatchAction::OpenSftp) => {
                    // Patch 0188: open bethterm-web.exe --sftp <hostId>
                    // for a saved SSH pane (argv bethterm-tool --ssh).
                    if let Some(pane) = mux::Mux::get().get_pane(pane_id) {
                        if let Err(e) = wtinator::sftp_window::open_for_pane(&pane) {
                            log::error!("bethterm sftp: {:#}", e);
                        }
                    } else {
                        log::warn!("bethterm sftp: pane {} no longer exists", pane_id);
                    }
                }
                Some(wtinator::context_menu::DispatchAction::SetTheme(theme)) => {
                    // Patch 0016 + 0017: build the matching
                    // ColorPalette and post a TermWindowNotif::Apply
                    // closure to the GUI thread. The closure calls
                    // `set_color_scheme`, which swaps the palette in
                    // place and drops the shape cache.
                    let palette: ColorPalette = theme.build_palette();
                    log::info!("wezterminator patch 0017: applying theme {:?}", theme);
                    gui_window.notify(TermWindowNotif::Apply(Box::new(move |tw| {
                        tw.set_color_scheme(palette);
                    })));
                }
                Some(wtinator::context_menu::DispatchAction::OpenThemesFolder) => {
                    // Patch 0017: open the user's wezterm config
                    // directory in the OS file manager. On Windows
                    // that is `explorer.exe`; on macOS it is
                    // `open`; on Linux it is `xdg-open`. The
                    // resolution is done in `wtinator::themes_folder`
                    // so the policy lives in one place.
                    if let Err(e) = wtinator::themes_folder::open_in_file_manager() {
                        log::error!(
                            "wezterminator patch 0017: failed to open themes folder: {:#}",
                            e
                        );
                    }
                }
                Some(wtinator::context_menu::DispatchAction::PasteImage) => {
                    // Patch 0022: paste the clipboard image as
                    // an iTerm2 inline-image escape (OSC 1337)
                    // on the focused pane. We need the live
                    // MuxPane to write the escape bytes to, so
                    // we look it up by the same pane_id the
                    // user clicked from.
                    match mux::Mux::get().get_pane(pane_id) {
                        Some(pane) => match wtinator::image_paste::paste_image_to_pane(&pane) {
                            Ok(Some(n)) => {
                                log::info!(
                                    "wezterminator patch 0022: pasted image ({} bytes) to pane {}",
                                    n,
                                    pane_id
                                );
                            }
                            Ok(None) => {
                                log::warn!(
                                    "wezterminator patch 0022: clipboard has no image; ignoring"
                                );
                            }
                            Err(e) => {
                                log::error!(
                                    "wezterminator patch 0022: failed to paste image: {:#}",
                                    e
                                );
                            }
                        },
                        None => {
                            log::warn!(
                                "wezterminator patch 0022: pane {} no longer exists",
                                pane_id
                            );
                        }
                    }
                }
                Some(wtinator::context_menu::DispatchAction::ScreenshotSave) => {
                    // Patch 0025: capture the current terminal
                    // window and write it as JPEG through a native
                    // Save-As dialog.
                    match wtinator::screenshot::save_jpeg_with_dialog(hwnd, hwnd as isize) {
                        Ok(Some(path)) => {
                            log::info!(
                                "wezterminator patch 0025: saved screenshot to {}",
                                path.display()
                            );
                        }
                        Ok(None) => {
                            log::info!("wezterminator patch 0025: screenshot save cancelled");
                        }
                        Err(e) => {
                            log::error!(
                                "wezterminator patch 0025: failed to save screenshot: {:#}",
                                e
                            );
                        }
                    }
                }
                Some(wtinator::context_menu::DispatchAction::ScreenshotCopy) => {
                    // Patch 0025: copy the current terminal window
                    // capture to the Windows clipboard as CF_DIB.
                    match wtinator::screenshot::copy_to_clipboard(hwnd) {
                        Ok(()) => {
                            log::info!("wezterminator patch 0025: copied screenshot to clipboard");
                        }
                        Err(e) => {
                            log::error!(
                                "wezterminator patch 0025: failed to copy screenshot: {:#}",
                                e
                            );
                        }
                    }
                }
                Some(wtinator::context_menu::DispatchAction::MoveTabToWindow(destination)) => {
                    let mux = mux::Mux::get();
                    let Some((_domain, _source_window, tab_id)) = mux.resolve_pane_id(pane_id)
                    else {
                        log::warn!("could not resolve tab for pane {}", pane_id);
                        return;
                    };
                    if destination.is_none() {
                        // Creating a window: ask for a name first so the
                        // destination list and taskbar can show it. Cancel
                        // aborts the move; empty input still creates an
                        // unnamed window.
                        let hwnd_isize = hwnd as isize;
                        let gui_window_for_notify = gui_window.clone();
                        std::thread::spawn(move || {
                            let result =
                                wtinator::header::prompt_window_title(hwnd_isize, None);
                            let Some(name) = result else {
                                log::info!(
                                    "wezterminator: new-window move cancelled at name prompt"
                                );
                                return;
                            };
                            gui_window_for_notify.notify(TermWindowNotif::Apply(Box::new(
                                move |_| {
                                    let mux = mux::Mux::get();
                                    match mux.move_tab_to_window(tab_id, None) {
                                        Ok(window_id) => {
                                            log::info!(
                                                "wezterminator: moved tab {} to new window {}",
                                                tab_id,
                                                window_id
                                            );
                                            wtinator::header::apply_window_user_title(
                                                window_id, name,
                                            );
                                        }
                                        Err(err) => log::error!(
                                            "wezterminator: failed to move tab {} to a new window: {:#}",
                                            tab_id,
                                            err
                                        ),
                                    }
                                },
                            )));
                        });
                        return;
                    }
                    match mux.move_tab_to_window(tab_id, destination) {
                        Ok(window_id) => log::info!(
                            "wezterminator: moved tab {} to window {} without restarting panes",
                            tab_id,
                            window_id
                        ),
                        Err(err) => log::error!(
                            "wezterminator: failed to move tab {} to {:?}: {:#}",
                            tab_id,
                            destination,
                            err
                        ),
                    }
                }
                Some(wtinator::context_menu::DispatchAction::MovePaneToGroup(target)) => {
                    // Patch 0028: move the focused pane into a
                    // new tab belonging to the target group
                    // (`None` = the default / ungrouped bucket).
                    // The actual work lives in
                    // `wtinator::groups::move_pane_to_group`
                    // so the mux-side logic stays out of the
                    // wezterm-gui crate.
                    match wtinator::groups::move_pane_to_group(pane_id, target.as_deref()) {
                        Ok(wtinator::groups::MoveOutcome::MovedToNewTab {
                            new_tab_id,
                            window_id: _,
                        }) => {
                            log::info!(
                                "wezterminator patch 0028: moved pane {} to new tab {} in group {:?}",
                                pane_id,
                                new_tab_id,
                                target
                            );
                        }
                        // Patch 0035 added `MovedToTab` / `NoOp`
                        // variants for the drag-to-tab path; they
                        // cannot be produced by `move_pane_to_group`
                        // but the match must stay exhaustive.
                        Ok(other) => {
                            log::debug!(
                                "wezterminator patch 0028: move_pane_to_group returned {:?}",
                                other
                            );
                        }
                        Err(e) => {
                            log::warn!(
                                "wezterminator patch 0028: failed to move pane {} to group {:?}: {:#}",
                                pane_id,
                                target,
                                e
                            );
                        }
                    }
                }
                Some(wtinator::context_menu::DispatchAction::RenameTerminal) => {
                    // Patch 0030: open the Win32 input prompt
                    // for the per-terminal header text.
                    //
                    // **Threading model**: the dialog has its
                    // own `GetMessageW` message loop, which
                    // would **block the wezterm main message
                    // loop** if run there. We therefore spawn
                    // a dedicated `std::thread` for the
                    // dialog, and post a `TermWindowNotif`
                    // back to the main thread when the user
                    // picks OK / Cancel. The wezterm window
                    // remains responsive while the dialog is
                    // open (paint events, key input, focus
                    // changes, etc. all still flow through
                    // the main thread's `PeekMessageW`).
                    let mux = mux::Mux::get();
                    let pane = match mux.get_pane(pane_id) {
                        Some(p) => p,
                        None => {
                            log::warn!(
                                "wezterminator patch 0030: pane {} not found",
                                pane_id
                            );
                            return;
                        }
                    };
                    let current = pane.get_header_text();
                    let hwnd_isize = hwnd as isize;
                    let gui_window_for_notify = gui_window.clone();
                    let pane_id_for_log = pane_id;
                    std::thread::spawn(move || {
                        let result =
                            wtinator::header::prompt_rename(hwnd_isize, current.as_deref());
                        log::info!(
                            "wezterminator patch 0030: dialog returned {:?} for pane {}",
                            result,
                            pane_id_for_log
                        );
                        if let Some(new_text) = result {
                            let pane_id_local = pane_id;
                            gui_window_for_notify.notify(TermWindowNotif::Apply(
                                Box::new(move |tw| {
                                    if let Some(mux) = mux::Mux::try_get() {
                                        if let Some(p) = mux.get_pane(pane_id_local) {
                                            p.set_header_text(new_text.clone());
                                            let _ = tw;
                                        }
                                    }
                                }),
                            ));
                        }
                    });
                }
                Some(wtinator::context_menu::DispatchAction::RenameTab) => {
                    // Patch 0031: open the Win32 input prompt
                    // for the per-tab user title. Same
                    // threading model as `RenameTerminal`
                    // (patch 0030.5) — the dialog runs on a
                    // dedicated `std::thread`; the result
                    // comes back to the main thread via
                    // `gui_window.notify(TermWindowNotif::Apply)`.
                    //
                    // The user title is a sticky override
                    // of the OSC 0/2 title; the shell's
                    // escapes cannot clobber it. We set it on
                    // the `Tab` (via `tab_id` derived from
                    // the focused pane) and then post a
                    // `WindowInvalidated` notification so the
                    // tab-bar repaints with the new title
                    // immediately.
                    let mux = mux::Mux::get();
                    let tab_id = match mux.resolve_pane_id(pane_id) {
                        Some((_domain, _window, tab_id)) => tab_id,
                        None => {
                            log::warn!(
                                "wezterminator patch 0031: could not resolve tab for pane {}",
                                pane_id
                            );
                            return;
                        }
                    };
                    let tab = match mux.get_tab(tab_id) {
                        Some(t) => t,
                        None => {
                            log::warn!(
                                "wezterminator patch 0031: tab {} not found",
                                tab_id
                            );
                            return;
                        }
                    };
                    let current = tab.get_user_title();
                    let hwnd_isize = hwnd as isize;
                    let gui_window_for_notify = gui_window.clone();
                    let tab_id_for_log = tab_id;
                    std::thread::spawn(move || {
                        let result = wtinator::header::prompt_user_title(
                            hwnd_isize,
                            current.as_deref(),
                        );
                        log::info!(
                            "wezterminator patch 0031: dialog returned {:?} for tab {}",
                            result,
                            tab_id_for_log
                        );
                        if let Some(new_title) = result {
                            let tab_id_local = tab_id;
                            gui_window_for_notify.notify(TermWindowNotif::Apply(
                                Box::new(move |tw| {
                                    if let Some(mux) = mux::Mux::try_get() {
                                        if let Some(tab) = mux.get_tab(tab_id_local) {
                                            tab.set_user_title(new_title.clone());
                                            // Trigger a redraw so
                                            // the new title appears
                                            // in the tab bar
                                            // immediately. The
                                            // tab-bar reads
                                            // `effective_title()` on
                                            // every paint, so a
                                            // window invalidation is
                                            // enough.
                                            if let Some(window_id) =
                                                mux.window_containing_tab(tab_id_local)
                                            {
                                                mux.notify(
                                                    mux::MuxNotification::WindowInvalidated(
                                                        window_id,
                                                    ),
                                                );
                                            }
                                            let _ = tw;
                                        }
                                    }
                                }),
                            ));
                        }
                    });
                }
                Some(wtinator::context_menu::DispatchAction::SetTaskbarIcon(slot)) => {
                    wtinator::taskbar_icon::apply_slot(mux_window_id, hwnd as isize, slot);
                }
                Some(wtinator::context_menu::DispatchAction::RenameWindow) => {
                    let mux = mux::Mux::get();
                    let window_id = match mux.resolve_pane_id(pane_id) {
                        Some((_domain, window_id, _tab_id)) => window_id,
                        None => {
                            log::warn!(
                                "wezterminator: could not resolve window for pane {}",
                                pane_id
                            );
                            return;
                        }
                    };
                    let current = mux
                        .get_window(window_id)
                        .and_then(|window| window.get_user_title());
                    let hwnd_isize = hwnd as isize;
                    let gui_window_for_notify = gui_window.clone();
                    std::thread::spawn(move || {
                        let result = wtinator::header::prompt_window_title(
                            hwnd_isize,
                            current.as_deref(),
                        );
                        log::info!(
                            "wezterminator: rename-window dialog returned {:?} for window {}",
                            result,
                            window_id
                        );
                        if let Some(new_title) = result {
                            gui_window_for_notify.notify(TermWindowNotif::Apply(Box::new(
                                move |_| {
                                    wtinator::header::apply_window_user_title(
                                        window_id, new_title,
                                    );
                                },
                            )));
                        }
                    });
                }
                Some(wtinator::context_menu::DispatchAction::OpenConfigApp) => {
                    // Launch next to this GUI on the UI thread. A helper
                    // thread used to hide the "not found" dialog, and the
                    // settings exe was often missing from the release dir.
                    let hwnd_isize = hwnd as isize;
                    let pane_id_for_log = pane_id;
                    let our_pid = std::process::id();
                    let candidate = std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                        .and_then(|dir| {
                            ["wtinator-config.exe", "bethterm-config.exe"]
                                .iter()
                                .map(|name| dir.join(name))
                                .find(|p| p.is_file())
                        });
                    match candidate {
                        Some(path) => {
                            let mut cmd = std::process::Command::new(&path);
                            cmd.arg("--wezterm-pid")
                                .arg(our_pid.to_string())
                                .arg("--pane-id")
                                .arg(pane_id_for_log.to_string());
                            if let Some(dir) = path.parent() {
                                cmd.current_dir(dir);
                            }
                            #[cfg(windows)]
                            {
                                use std::os::windows::process::CommandExt;
                                const DETACHED_PROCESS: u32 = 0x0000_0008;
                                const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
                                cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
                            }
                            match cmd.spawn() {
                                Ok(_) => {
                                    log::info!(
                                        "bethterm: launched {} --wezterm-pid {} --pane-id {}",
                                        path.display(),
                                        our_pid,
                                        pane_id_for_log
                                    );
                                }
                                Err(e) => {
                                    log::warn!("bethterm: failed to launch settings app: {e}");
                                    let body = format!(
                                        "Could not start BethTerm Settings.\n\nError: {e}"
                                    );
                                    let _ = wtinator::confirm::confirm_close(
                                        hwnd_isize,
                                        wtinator::confirm::ConfirmKind::Window,
                                        "BethTerm Settings — launch failed",
                                        &body,
                                    );
                                }
                            }
                        }
                        None => {
                            log::warn!(
                                "bethterm: wtinator-config.exe not found next to current exe"
                            );
                            let _ = wtinator::confirm::confirm_close(
                                hwnd_isize,
                                wtinator::confirm::ConfirmKind::Window,
                                "BethTerm Settings not found",
                                "The settings app (wtinator-config.exe) was not \
                                 found next to this executable.\n\n\
                                 Build it with:\n\
                                 cargo +nightly build --release -p wtinator-config\n\n\
                                 and keep it beside bethterm-gui.exe.",
                            );
                        }
                    }
                }
                None => {}
            }
        } else {
            wtinator::host::note_life(&format!(
                "right-click menu dismissed hwnd={hwnd_value}"
            ));
        }
    })
    .detach();
}

#[cfg(not(windows))]
fn show_native_shell_picker(_window: &mut super::TermWindow) {}

#[cfg(not(windows))]
fn show_native_split_picker(_window: &mut super::TermWindow) {}

#[cfg(not(windows))]
fn show_native_full_menu(_window: &mut super::TermWindow, _pane_id: mux::pane::PaneId) {}

#[cfg(not(windows))]
fn show_native_tab_menu(_window: &mut super::TermWindow, _tab_idx: usize) {}
