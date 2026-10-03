#![allow(clippy::range_plus_one)]
use super::renderstate::*;
use super::utilsprites::RenderMetrics;
use crate::colorease::ColorEase;
use crate::frontend::{front_end, try_front_end};
use crate::inputmap::InputMap;
use crate::overlay::{
    confirm_close_pane, confirm_close_tab, confirm_close_window, confirm_quit_program, launcher,
    start_overlay, start_overlay_pane, CopyModeParams, CopyOverlay, LauncherArgs, LauncherFlags,
    QuickSelectOverlay,
};
use crate::resize_increment_calculator::ResizeIncrementCalculator;
use crate::scripting::guiwin::GuiWin;
use crate::scrollbar::*;
use crate::selection::{Selection, SelectionCoordinate, SelectionX};
use crate::shapecache::*;
use crate::tabbar::{TabBarItem, TabBarState};
use crate::termwindow::background::{
    load_background_image, reload_background_image, LoadedBackgroundLayer,
};
use crate::termwindow::keyevent::{KeyTableArgs, KeyTableState};
use crate::termwindow::modal::Modal;
use crate::termwindow::render::paint::AllowImage;
use crate::termwindow::render::{
    CachedLineState, LineQuadCacheKey, LineQuadCacheValue, LineToEleShapeCacheKey,
    LineToElementShapeItem,
};
use crate::termwindow::webgpu::WebGpuState;
use ::wezterm_term::input::{ClickPosition, MouseButton as TMB};
use ::window::*;
use anyhow::{anyhow, ensure, Context};
use config::keyassignment::{
    Confirmation, KeyAssignment, LauncherActionArgs, PaneDirection, Pattern, PromptInputLine,
    QuickSelectArguments, RotationDirection, SpawnCommand, SplitSize,
};
use config::window::WindowLevel;
use config::{
    configuration, AudibleBell, ConfigHandle, Dimension, DimensionContext, FrontEndSelection,
    GeometryOrigin, GuiPosition, TermConfig, WindowCloseConfirmation,
};
use lfucache::*;
use mlua::{FromLua, LuaSerdeExt, UserData, UserDataFields};
use mux::pane::{
    CachePolicy, CloseReason, Pane, PaneId, Pattern as MuxPattern, PerformAssignmentResult,
};
use mux::renderable::RenderableDimensions;
use mux::tab::{
    PositionedPane, PositionedSplit, SplitDirection, SplitRequest, SplitSize as MuxSplitSize, Tab,
    TabId,
};
use mux::window::WindowId as MuxWindowId;
use mux::{Mux, MuxNotification};
use mux_lua::MuxPane;
use ordered_float::NotNan;
use smol::channel::Sender;
use smol::Timer;
use std::cell::{Cell, RefCell, RefMut};
use std::collections::{HashMap, LinkedList};
use std::ops::Add;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use termwiz::hyperlink::Hyperlink;
use termwiz::surface::SequenceNo;
use wezterm_dynamic::Value;
use wezterm_font::FontConfiguration;
use wezterm_term::color::ColorPalette;
use wezterm_term::input::LastMouseClick;
use wezterm_term::{Alert, Progress, StableRowIndex, TerminalConfiguration, TerminalSize};

pub mod background;
pub mod box_model;
pub mod charselect;
pub mod clipboard;
pub mod keyevent;
pub mod modal;
mod mouseevent;
// WezTerminator (patch 0036): named-pipe server for the
// wtinator-config companion app. Windows-only.
#[cfg(windows)]
pub mod notify_pipe;
pub mod palette;
pub mod paneselect;
mod prevcursor;
pub mod render;
pub mod resize;
mod selection;
pub mod session_restore;
pub mod spawn;
pub mod webgpu;
use crate::spawn::SpawnWhere;
use prevcursor::{CursorGlideState, PrevCursorPos};

const ATLAS_SIZE: usize = 128;

lazy_static::lazy_static! {
    static ref WINDOW_CLASS: Mutex<String> = Mutex::new(wezterm_gui_subcommands::DEFAULT_WINDOW_CLASS.to_owned());
    static ref POSITION: Mutex<Option<GuiPosition>> = Mutex::new(None);
}

pub const ICON_DATA: &'static [u8] = include_bytes!("../../../assets/icon/terminal.png");

pub fn set_window_position(pos: GuiPosition) {
    POSITION.lock().unwrap().replace(pos);
}

pub fn set_window_class(cls: &str) {
    *WINDOW_CLASS.lock().unwrap() = cls.to_owned();
}

pub fn get_window_class() -> String {
    WINDOW_CLASS.lock().unwrap().clone()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MouseCapture {
    UI,
    TerminalPane(PaneId),
}

/// Type used together with Window::notify to do something in the
/// context of the window-specific event loop
pub enum TermWindowNotif {
    InvalidateShapeCache,
    PerformAssignment {
        pane_id: PaneId,
        assignment: KeyAssignment,
        tx: Option<Sender<anyhow::Result<()>>>,
    },
    SetLeftStatus(String),
    SetRightStatus(String),
    GetDimensions(Sender<(Dimensions, WindowState)>),
    GetSelectionForPane {
        pane_id: PaneId,
        tx: Sender<String>,
    },
    GetEffectiveConfig(Sender<ConfigHandle>),
    FinishWindowEvent {
        name: String,
        again: bool,
    },
    GetConfigOverrides(Sender<wezterm_dynamic::Value>),
    SetConfigOverrides(wezterm_dynamic::Value),
    CancelOverlayForPane(PaneId),
    CancelOverlayForTab {
        tab_id: TabId,
        pane_id: Option<PaneId>,
    },
    MuxNotification(MuxNotification),
    EmitStatusUpdate,
    Apply(Box<dyn FnOnce(&mut TermWindow) + Send + Sync>),
    SwitchToMuxWindow(MuxWindowId),
    SetInnerSize {
        width: usize,
        height: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UIItemType {
    TabBar(TabBarItem),
    CloseTab(usize),
    AboveScrollThumb,
    ScrollThumb,
    BelowScrollThumb,
    Split(PositionedSplit),
    PaneHeader(PaneId),
    /// WezTerminator (patch 0065): a pane chip in the per-tab pane-tab bar.
    RailEntry { pane_id: PaneId, ordinal: usize },
    /// WezTerminator (patch 0065): the trailing "+" chip (spawns a terminal).
    PaneTabNew,
    /// BethTerm (patch 0124): a live pane in the left dashboard rail.
    DashboardEntry { pane_id: PaneId },
    /// BethTerm (patch 0124): close the dashboard rail.
    DashboardClose,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UIItem {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
    pub item_type: UIItemType,
}

impl UIItem {
    pub fn hit_test(&self, x: isize, y: isize) -> bool {
        x >= self.x as isize
            && x <= (self.x + self.width) as isize
            && y >= self.y as isize
            && y <= (self.y + self.height) as isize
    }
}

#[derive(Clone, Default)]
pub struct SemanticZoneCache {
    seqno: SequenceNo,
    zones: Vec<StableRowIndex>,
}

pub struct OverlayState {
    pub pane: Arc<dyn Pane>,
    pub key_table_state: KeyTableState,
}

#[derive(Default)]
pub struct PaneState {
    /// If is_some(), the top row of the visible screen.
    /// Otherwise, the viewport is at the bottom of the
    /// scrollback.
    viewport: Option<StableRowIndex>,
    selection: Selection,
    /// If is_some(), rather than display the actual tab
    /// contents, we're overlaying a little internal application
    /// tab.  We'll also route input to it.
    pub overlay: Option<OverlayState>,

    // WezTerminator (patch 0064): pub so paint_sidebar (a sibling render
    // submodule) can read it for the per-pane rail attention dot.
    pub bell_start: Option<Instant>,
    pub mouse_terminal_coords: Option<(ClickPosition, StableRowIndex)>,
}

/// Data used when synchronously formatting pane and window titles
#[derive(Debug, Clone)]
pub struct TabInformation {
    pub tab_id: TabId,
    pub tab_index: usize,
    pub is_active: bool,
    pub is_last_active: bool,
    pub active_pane: Option<PaneInformation>,
    pub window_id: MuxWindowId,
    /// The OSC 0/2 title set by the shell program running
    /// inside the tab. May be empty if the shell has not
    /// set one. This is the raw value exposed to Lua as
    /// `tab_title` for backwards compatibility with user
    /// `format-tab-title` callbacks.
    pub tab_title: String,
    /// WezTerminator (patch 0031): the user-set title
    /// override (set via right-click "Rename tab…"). Empty
    /// string means "no user override" (the tab falls back
    /// to `tab_title` / `pane.title`). Sticks across OSC
    /// 0/2 escapes from the shell.
    pub user_title: String,
    /// WezTerminator (patch 0063): a pane in this tab rang the bell and the tab
    /// hasn't been looked at yet — render a blinking attention dot.
    pub needs_attention: bool,
    /// WezTerminator (patch 0063): current on/off phase of the attention blink.
    pub attention_blink: bool,
}

impl UserData for TabInformation {
    fn add_fields<'lua, F: UserDataFields<'lua, Self>>(fields: &mut F) {
        fields.add_field_method_get("tab_id", |_, this| Ok(this.tab_id));
        fields.add_field_method_get("tab_index", |_, this| Ok(this.tab_index));
        fields.add_field_method_get("is_active", |_, this| Ok(this.is_active));
        fields.add_field_method_get("is_last_active", |_, this| Ok(this.is_last_active));
        fields.add_field_method_get("active_pane", |_, this| {
            if let Some(pane) = &this.active_pane {
                Ok(Some(pane.clone()))
            } else {
                Ok(None)
            }
        });
        fields.add_field_method_get("panes", |_, this| {
            let mux = Mux::get();
            let mut panes = vec![];
            if let Some(tab) = mux.get_tab(this.tab_id) {
                panes = tab
                    .iter_panes()
                    .iter()
                    .map(TermWindow::pos_pane_to_pane_info)
                    .collect();
            }
            Ok(panes)
        });
        fields.add_field_method_get("window_id", |_, this| Ok(this.window_id));
        fields.add_field_method_get("tab_title", |_, this| Ok(this.tab_title.clone()));
        // WezTerminator (patch 0031): expose the
        // user-set title override to Lua. Empty string
        // means "no user override".
        fields.add_field_method_get("user_title", |_, this| Ok(this.user_title.clone()));
        fields.add_field_method_get("window_title", |_, this| {
            let mux = Mux::get();
            let window = mux.get_window(this.window_id).ok_or_else(|| {
                mlua::Error::external(format!("window {} not found", this.window_id))
            })?;
            Ok(window.get_title().to_string())
        });
    }
}

/// Data used when synchronously formatting pane and window titles
#[derive(Debug, Clone)]
pub struct PaneInformation {
    pub pane_id: PaneId,
    pub pane_index: usize,
    pub is_active: bool,
    pub is_zoomed: bool,
    pub has_unseen_output: bool,
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
    pub pixel_width: usize,
    pub pixel_height: usize,
    pub title: String,
    pub user_vars: HashMap<String, String>,
    pub progress: Progress,
}

impl UserData for PaneInformation {
    fn add_fields<'lua, F: UserDataFields<'lua, Self>>(fields: &mut F) {
        fields.add_field_method_get("pane_id", |_, this| Ok(this.pane_id));
        fields.add_field_method_get("pane_index", |_, this| Ok(this.pane_index));
        fields.add_field_method_get("is_active", |_, this| Ok(this.is_active));
        fields.add_field_method_get("is_zoomed", |_, this| Ok(this.is_zoomed));
        fields.add_field_method_get("has_unseen_output", |_, this| Ok(this.has_unseen_output));
        fields.add_field_method_get("left", |_, this| Ok(this.left));
        fields.add_field_method_get("top", |_, this| Ok(this.top));
        fields.add_field_method_get("width", |_, this| Ok(this.width));
        fields.add_field_method_get("height", |_, this| Ok(this.height));
        fields.add_field_method_get("pixel_width", |_, this| Ok(this.pixel_width));
        fields.add_field_method_get("pixel_height", |_, this| Ok(this.pixel_height));
        fields.add_field_method_get("progress", |lua, this| lua.to_value(&this.progress));
        fields.add_field_method_get("title", |_, this| Ok(this.title.clone()));
        fields.add_field_method_get("user_vars", |_, this| Ok(this.user_vars.clone()));
        fields.add_field_method_get("foreground_process_name", |_, this| {
            let mut name = None;
            if let Some(mux) = Mux::try_get() {
                if let Some(pane) = mux.get_pane(this.pane_id) {
                    name = pane.get_foreground_process_name(CachePolicy::AllowStale);
                }
            }
            match name {
                Some(name) => Ok(name),
                None => Ok("".to_string()),
            }
        });
        fields.add_field_method_get("tty_name", |_, this| {
            let mut name = None;
            if let Some(mux) = Mux::try_get() {
                if let Some(pane) = mux.get_pane(this.pane_id) {
                    name = pane.tty_name();
                }
            }
            Ok(name)
        });
        fields.add_field_method_get("current_working_dir", |_, this| {
            if let Some(mux) = Mux::try_get() {
                if let Some(pane) = mux.get_pane(this.pane_id) {
                    return Ok(pane
                        .get_current_working_dir(CachePolicy::AllowStale)
                        .map(|url| url_funcs::Url { url }));
                }
            }
            Ok(None)
        });
        fields.add_field_method_get("domain_name", |_, this| {
            let mut name = None;
            if let Some(mux) = Mux::try_get() {
                if let Some(pane) = mux.get_pane(this.pane_id) {
                    let domain_id = pane.domain_id();
                    name = mux
                        .get_domain(domain_id)
                        .map(|dom| dom.domain_name().to_string());
                }
            }
            match name {
                Some(name) => Ok(name),
                None => Ok("".to_string()),
            }
        });
    }
}

#[derive(Default)]
pub struct TabState {
    /// If is_some(), rather than display the actual tab
    /// contents, we're overlaying a little internal application
    /// tab.  We'll also route input to it.
    pub overlay: Option<OverlayState>,
}

/// Manages the state/queue of lua based event handlers.
/// We don't want to queue more than 1 event at a time,
/// so we use this enum to allow for at most 1 executing
/// and 1 pending event.
#[derive(Copy, Clone, Debug)]
enum EventState {
    /// The event is not running
    None,
    /// The event is running
    InProgress,
    /// The event is running, and we have another one ready to
    /// run once it completes
    InProgressWithQueued(Option<PaneId>),
}

/// WezTerminator (patch 0023): merge two override passes
/// (titlebar + vscode_font) into a single `wezterm_dynamic::Value::Object`.
/// A `Null` pass is treated as "no overrides"; an `Object`
/// pass contributes its keys. Later passes win on key
/// conflicts (this matches the upstream merge order — the
/// user's own `wezterm.lua` overrides trump both, because
/// they are merged *after* the override passes).
fn merge_override_passes(
    titlebar: wezterm_dynamic::Value,
    vscode_font: wezterm_dynamic::Value,
) -> wezterm_dynamic::Value {
    use std::collections::BTreeMap;
    let mut map: BTreeMap<wezterm_dynamic::Value, wezterm_dynamic::Value> =
        BTreeMap::new();
    if let wezterm_dynamic::Value::Object(o) = titlebar {
        for (k, v) in o {
            map.insert(k, v);
        }
    }
    if let wezterm_dynamic::Value::Object(o) = vscode_font {
        for (k, v) in o {
            map.insert(k, v);
        }
    }
    if map.is_empty() {
        wezterm_dynamic::Value::Null
    } else {
        // `Object: From<BTreeMap<Value, Value>>` is implemented
        // in `wezterm-dynamic/src/object.rs`, so this collects
        // back into a `Value::Object` without needing to know
        // the exact `from_iter` signature.
        wezterm_dynamic::Value::Object(map.into())
    }
}

/// WezTerminator (patch 0037): live state of a Visual-Studio-style
/// pane dock drag. While the user drags a pane by its header, this
/// records the target pane currently under the cursor and which
/// edge zone the cursor is in, so the renderer can draw the
/// drop-zone overlay and the mouse-release can perform the dock.
#[derive(Clone, Copy, Debug)]
pub struct PaneDockHover {
    pub dragged_pane: PaneId,
    pub target_pane: PaneId,
    pub zone: wtinator::groups::DockZone,
}

/// WezTerminator (patch 0043): cache key for a per-pane font override.
/// A pane overrides the window font by SIZE (a scale relative to the
/// window's font size, patch 0039) and/or by FAMILY (a typeface name,
/// patch 0043). Both collapse into "what FontConfiguration do I need":
/// the absolute point size and the (optional) family fully determine
/// the built fonts/metrics, so they are the cache key. `font_size` is
/// the *absolute* size in points (`window_font_size * pane_scale`),
/// stored as `NotNan` so the key is `Hash + Eq`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PaneFontKey {
    pub family: Option<String>,
    pub font_size: NotNan<f64>,
    /// WezTerminator (patch 0047): per-pane bold / italic also key the
    /// built FontConfiguration cache (a styled face has its own metrics).
    pub bold: bool,
    pub italic: bool,
}

pub struct TermWindow {
    pub window: Option<Window>,
    pub config: ConfigHandle,
    pub config_overrides: wezterm_dynamic::Value,
    os_parameters: Option<parameters::Parameters>,
    /// When we most recently received keyboard focus
    pub focused: Option<Instant>,
    fonts: Rc<FontConfiguration>,
    /// Window dimensions and dpi
    pub dimensions: Dimensions,
    pub window_state: WindowState,
    pub resizes_pending: usize,
    is_repaint_pending: bool,
    pending_scale_changes: LinkedList<resize::ScaleChange>,
    /// Terminal dimensions
    terminal_size: TerminalSize,
    pub mux_window_id: MuxWindowId,
    pub mux_window_id_for_subscriptions: Arc<Mutex<MuxWindowId>>,
    pub render_metrics: RenderMetrics,
    /// WezTerminator (patch 0039 + 0043): per-pane font override support.
    /// When a pane overrides the window font — either a non-1.0 size
    /// scale (patch 0039) or a different family (patch 0043) — we need a
    /// FontConfiguration and RenderMetrics built for that override.
    /// Building those is expensive, so we cache them keyed by the
    /// (family, size) pair (`PaneFontKey`). The window default (no
    /// family, scale 1.0) is never stored here (it uses
    /// `self.fonts`/`self.render_metrics` directly).
    pane_font_cache: RefCell<HashMap<PaneFontKey, (Rc<FontConfiguration>, RenderMetrics)>>,
    render_state: Option<RenderState>,
    input_map: InputMap,
    /// If is_some, the LEADER modifier is active until the specified instant.
    leader_is_down: Option<std::time::Instant>,
    dead_key_status: DeadKeyStatus,
    key_table_state: KeyTableState,
    show_tab_bar: bool,
    show_scroll_bar: bool,
    tab_bar: TabBarState,
    fancy_tab_bar: Option<box_model::ComputedElement>,
    pub right_status: String,
    pub left_status: String,
    last_ui_item: Option<UIItem>,
    /// Tracks whether the current mouse-down event is part of click-focus.
    /// If so, we ignore mouse events until released
    is_click_to_focus_window: bool,
    last_mouse_coords: (usize, i64),
    window_drag_position: Option<MouseEvent>,
    current_mouse_event: Option<MouseEvent>,
    prev_cursor: PrevCursorPos,
    /// WezTerminator (patch 0044): rendered pixel rect of the active
    /// pane's cursor, carried across frames so it can glide (slide)
    /// from its old position to a new one instead of teleporting.
    /// `None` until the first paint or after a teleport-reset.
    cursor_glide: RefCell<Option<CursorGlideState>>,
    /// WezTerminator (patch 0044): per-paint flag set at the top of
    /// `paint_pane` for the active pane when a glide is in progress.
    /// `compute_cell_fg_bg` reads it and suppresses the normal
    /// per-line cell cursor (returns `cursor_shape: None`) so the
    /// glide overlay is the only cursor drawn that frame, avoiding a
    /// double cursor. Reset to false for every pane that isn't
    /// actively gliding.
    cursor_glide_active: Cell<bool>,
    last_scroll_info: RenderableDimensions,
    /// Patch 0119: last `physical_top` seen on PaneOutput. A change
    /// means the viewport scrolled (Enter); in-place floods (Tab
    /// completion) keep the same top and must not wipe line caches.
    last_output_phys_top: Cell<Option<(PaneId, StableRowIndex)>>,
    /// BethTerm (patch 0137): `ensure_pane_geometry` used to walk every
    /// pane on every paint. It now runs only after something that can
    /// change a pane grid: window resize, tab/pane layout change, font
    /// change, dashboard relayout.
    pane_geometry_dirty: Cell<bool>,
    /// BethTerm (patch 0194): window cols/rows last seen by
    /// `ensure_pane_geometry`. A Beth Studio resize changes the pane
    /// without changing these, and must not be snapped back.
    geometry_window_cols: Cell<usize>,
    geometry_window_rows: Cell<usize>,

    tab_state: RefCell<HashMap<TabId, TabState>>,
    pane_state: RefCell<HashMap<PaneId, PaneState>>,
    semantic_zones: HashMap<PaneId, SemanticZoneCache>,

    window_background: Vec<LoadedBackgroundLayer>,

    current_modifier_and_leds: (Modifiers, KeyboardLedStatus),
    current_mouse_buttons: Vec<MousePress>,
    current_mouse_capture: Option<MouseCapture>,

    opengl_info: Option<String>,

    /// Keeps track of double and triple clicks
    last_mouse_click: Option<LastMouseClick>,

    /// The URL over which we are currently hovering
    current_highlight: Option<Arc<Hyperlink>>,

    quad_generation: usize,
    shape_generation: usize,
    shape_cache: RefCell<LfuCache<ShapeCacheKey, anyhow::Result<Rc<Vec<ShapedInfo>>>>>,
    line_to_ele_shape_cache: RefCell<LfuCache<LineToEleShapeCacheKey, LineToElementShapeItem>>,

    line_state_cache: RefCell<LfuCacheU64<Arc<CachedLineState>>>,
    next_line_state_id: u64,

    line_quad_cache: RefCell<LfuCache<LineQuadCacheKey, LineQuadCacheValue>>,

    last_status_call: Instant,
    cursor_blink_state: RefCell<ColorEase>,
    blink_state: RefCell<ColorEase>,
    rapid_blink_state: RefCell<ColorEase>,

    palette: Option<ColorPalette>,

    ui_items: Vec<UIItem>,
    dragging: Option<(UIItem, MouseEvent)>,

    modal: RefCell<Option<Rc<dyn Modal>>>,

    event_states: HashMap<String, EventState>,
    pub current_event: Option<Value>,
    has_animation: RefCell<Option<Instant>>,
    /// We use this to attempt to do something reasonable
    /// if we run out of texture space
    allow_images: AllowImage,
    scheduled_animation: RefCell<Option<Instant>>,

    /// WezTerminator (patch 0063): tabs whose pane rang the bell and have not
    /// been looked at yet (tab_id -> when it rang). Drives the blinking
    /// attention dot; cleared when the tab is active and the window is focused.
    tab_bell_attention: RefCell<HashMap<TabId, Instant>>,
    /// WezTerminator (patch 0063): whether the blink-repaint loop is running
    /// (so we arm only one regardless of how many bells arrive).
    bell_blink_running: Arc<AtomicBool>,

    /// WezTerminator (patch 0080): suppress repeated close gestures while the
    /// delayed, two-step whole-application confirmation is in progress.
    window_close_confirmation_pending: bool,

    created: Instant,

    pub last_frame_duration: Duration,
    last_fps_check_time: Instant,
    num_frames: usize,
    pub fps: f32,

    connection_name: String,

    gl: Option<Rc<glium::backend::Context>>,
    webgpu: Option<Rc<WebGpuState>>,
    config_subscription: Option<config::ConfigSubscription>,
    /// WezTerminator (patch 0029): cancel flag for the
    /// 30-second session auto-save timer. The timer task
    /// checks this flag every tick and exits when it is
    /// set. `close_requested` /
    /// `close_requested_with_confirmation` flip it before
    /// tearing the window down.
    save_cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,

    /// WezTerminator (patch 0030.5): state for inline header
    /// renaming. When `editing_header_pane` is Some, the
    /// header of that pane is rendered as an editable text
    /// field and keyboard input goes to `header_edit_buffer`.
    editing_header_pane: Option<PaneId>,
    header_edit_buffer: String,
    /// WezTerminator (patch 0037): see [`PaneDockHover`]. `Some`
    /// only while a pane-header drag is hovering over a target
    /// pane; drives the dock drop-zone overlay and the drop.
    pane_dock_hover: Option<PaneDockHover>,
}

/// Patch 0116: skip GPU frames while the HWND is iconic or hidden
/// in the tray. PTY/mux/session keep running; only paint is paused.
fn gpu_paint_suppressed(window: &Window) -> bool {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd();
        if hwnd.is_null() {
            return false;
        }
        unsafe {
            winapi::um::winuser::IsIconic(hwnd) != 0
                || winapi::um::winuser::IsWindowVisible(hwnd) == 0
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

/// Patch 0193: drop this GUI window only. Host panes are marked so the
/// local remove does not send `KillPane`. The domain stays attached, so
/// other windows and Beth Studio keep working.
pub fn close_gui_window_keep_host(window_id: MuxWindowId) {
    let Some(mux) = mux::Mux::try_get() else {
        return;
    };
    if let Some(window) = mux.get_window(window_id) {
        for tab in window.iter() {
            for pos in tab.iter_panes_ignoring_zoom() {
                if let Some(pane) = pos.pane.downcast_ref::<wezterm_client::pane::ClientPane>() {
                    pane.ignore_next_kill();
                }
            }
        }
    }
    wtinator::host::note_life(&format!(
        "GUI window {window_id} closed; host panes were not killed"
    ));
    mux.release_window(window_id);
}

impl TermWindow {
    fn load_os_parameters(&mut self) {
        if let Some(ref window) = self.window {
            self.os_parameters = match window.get_os_parameters(&self.config, self.window_state) {
                Ok(os_parameters) => os_parameters,
                Err(err) => {
                    log::warn!("Error while getting OS parameters: {:#}", err);
                    None
                }
            };
        }
    }

    fn close_requested(&mut self, window: &Window) {
        // The title-bar X already uses the native confirmation below. Alt+F4
        // and the operating-system close gesture must receive the same guard.
        if crate::tabbar::is_wtinator_active() {
            self.close_requested_with_confirmation(window);
            return;
        }

        let mux = Mux::get();
        // WezTerminator (patch 0029): save the group
        // layout before tearing the mux window down. Any
        // error here is non-fatal — we never block the
        // close on a write failure.
        let _ = wtinator::session::save();
        // Cancel the auto-save timer so it cannot race the
        // teardown.
        if let Some(cancel) = self.save_cancel.take() {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        match self.config.window_close_confirmation {
            WindowCloseConfirmation::NeverPrompt => {
                // Immediately kill the tabs and allow the window to close
                mux.kill_window(self.mux_window_id);
                window.close();
                front_end().forget_known_window(window);
            }
            WindowCloseConfirmation::AlwaysPrompt => {
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => {
                        mux.kill_window(self.mux_window_id);
                        window.close();
                        front_end().forget_known_window(window);
                        return;
                    }
                };

                let mux_window_id = self.mux_window_id;

                let can_close = mux
                    .get_window(mux_window_id)
                    .map_or(false, |w| w.can_close_without_prompting());
                if can_close {
                    mux.kill_window(self.mux_window_id);
                    window.close();
                    front_end().forget_known_window(window);
                    return;
                }
                let window = self.window.clone().unwrap();
                let (overlay, future) = start_overlay(self, &tab, move |tab_id, term| {
                    confirm_close_window(term, mux_window_id, window, tab_id)
                });
                self.assign_overlay(tab.tab_id(), overlay);
                promise::spawn::spawn(future).detach();

                // Don't close right now; let the close happen from
                // the confirmation overlay
            }
        }
    }

    fn close_requested_with_confirmation(&mut self, window: &Window) {
        if self.window_close_confirmation_pending {
            return;
        }
        // Patch 0105/0106: the title-bar X hides to the notification
        // area (icon next to the clock). Each hidden window is stacked
        // in the tray right-click menu. PTYs keep running. Quit from
        // the tray menu marks the window and re-enters this path.
        #[cfg(windows)]
        if let Some(w) = self.window.as_ref() {
            let hwnd = w.hwnd() as isize;
            if !wtinator::tray::should_really_quit(hwnd) {
                wtinator::host::note_life(&format!(
                    "window close hid to tray hwnd={hwnd} window={}",
                    self.mux_window_id
                ));
                let mux_window_id = self.mux_window_id;
                // Do not ShowWindow/CreateWindow here: this runs inside
                // WM_CLOSE with WindowInner already borrowed. Nested
                // Win32 messages panic the GUI (process exit code 1).
                promise::spawn::spawn_into_main_thread(async move {
                    match wtinator::tray::hide_window(hwnd, mux_window_id) {
                        Ok(()) => log::info!(
                            "bethterm: window hidden to notification area"
                        ),
                        Err(e) => log::error!(
                            "bethterm: hide to tray failed ({e:#}); window stays open"
                        ),
                    }
                })
                .detach();
                return;
            }
            wtinator::host::note_life(&format!(
                "window close will really quit hwnd={hwnd} window={}",
                self.mux_window_id
            ));
        }
        let mux = Mux::get();
        // Cancel the auto-save timer; the close confirmation
        // overlay will eventually call `close_requested` (or
        // cancel) but the timer is no longer needed.
        if let Some(cancel) = self.save_cancel.take() {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => {
                let _ = wtinator::session::save();
                mux.kill_window(self.mux_window_id);
                window.close();
                front_end().forget_known_window(window);
                return;
            }
        };

        let mux_window_id = self.mux_window_id;

        self.window_close_confirmation_pending = true;

        // WezTerminator (patch 0032.2): confirm the window close
        // with a native Win32 MessageBox (Yes/No) instead of the
        // in-terminal Skia overlay ("Really kill this window…").
        // Same threading model as the per-tab / per-pane close:
        // the messagebox runs on a dedicated std::thread so a
        // frozen UI cannot block it, and the kill is posted back
        // to the GUI main thread on "Yes".
        let hwnd_isize = match self.window.as_ref() {
            Some(w) => w.hwnd() as isize,
            None => {
                // No HWND — fall back to the Skia overlay.
                let window = window.clone();
                let (overlay, future) = start_overlay(self, &tab, move |tab_id, term| {
                    confirm_close_window(term, mux_window_id, window, tab_id)
                });
                self.assign_overlay(tab.tab_id(), overlay);
                promise::spawn::spawn(future).detach();
                let _ = wtinator::session::save();
                return;
            }
        };

        let gui_window_for_notify = self.window.clone();
        let n_tabs = mux.get_window(mux_window_id).map(|w| w.len()).unwrap_or(0);
        let body = if n_tabs > 1 {
            format!(
                "Fecha só esta janela da interface.\n\n\
                 Ela tem {n_tabs} abas. O host e os terminais continuam. \
                 O Beth Studio segue podendo abri-los."
            )
        } else {
            "Fecha só esta janela da interface.\n\n\
             O host e o terminal continuam. O Beth Studio segue podendo abri-lo."
                .to_string()
        };
        std::thread::spawn(move || {
            let confirmed = wtinator::confirm::confirm_close(
                hwnd_isize,
                wtinator::confirm::ConfirmKind::Window,
                "Fechar janela?",
                &body,
            );
            if let Some(gui_window) = gui_window_for_notify {
                gui_window.notify(TermWindowNotif::Apply(Box::new(move |_tw| {
                    _tw.window_close_confirmation_pending = false;
                    if confirmed {
                        close_gui_window_keep_host(mux_window_id);
                    }
                })));
            }
        });
        // Patch 0103: snapshot after the dialog thread is running so a
        // slow AppData write cannot delay the first Task Dialog.
        let _ = wtinator::session::save();
    }

    fn focus_changed(&mut self, focused: bool, window: &Window) {
        log::trace!("Setting focus to {:?}", focused);
        self.focused = if focused { Some(Instant::now()) } else { None };
        self.quad_generation += 1;
        self.load_os_parameters();

        if self.focused.is_none() {
            self.last_mouse_click = None;
            self.current_mouse_buttons.clear();
            self.current_mouse_capture = None;
            self.is_click_to_focus_window = false;

            for state in self.pane_state.borrow_mut().values_mut() {
                state.mouse_terminal_coords.take();
            }
        }

        // Reset the cursor blink phase
        self.prev_cursor.bump();

        // force cursor to be repainted
        window.invalidate();

        if let Some(pane) = self.get_active_pane_or_overlay() {
            pane.focus_changed(focused);
        }

        self.update_title();
        self.emit_window_event("window-focus-changed", None);
    }

    /// WezTerminator (patch 0063): drive the tab attention blink. While any tab
    /// has an unacknowledged bell, repaint the tab bar every ~400ms so the dot
    /// toggles. Runs regardless of window focus (the alert matters most when the
    /// user is looking elsewhere); self-stops when no tab needs attention.
    fn arm_bell_blink(&self) {
        if self.bell_blink_running.swap(true, Ordering::SeqCst) {
            return; // a blink loop is already running
        }
        let running = self.bell_blink_running.clone();
        let window = match self.window.clone() {
            Some(w) => w,
            None => {
                running.store(false, Ordering::SeqCst);
                return;
            }
        };
        promise::spawn::spawn(async move {
            loop {
                Timer::at(Instant::now() + std::time::Duration::from_millis(400)).await;
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                window.notify(TermWindowNotif::Apply(Box::new(|tw| {
                    tw.tick_bell_blink();
                })));
            }
        })
        .detach();
    }

    /// WezTerminator (patch 0063): one blink tick — repaint the tab bar if any
    /// tab still needs attention, otherwise stop the loop.
    fn tick_bell_blink(&mut self) {
        if self.tab_bell_attention.borrow().is_empty() {
            self.bell_blink_running.store(false, Ordering::SeqCst);
        } else {
            self.update_title();
        }
    }

    /// WezTerminator (patch 0070): mark the pane's tab as needing attention.
    /// Shared by BEL and OSC 9 notifications; Codex prefers OSC 9 in its
    /// default `auto` notification mode.
    fn mark_tab_attention(&mut self, pane_id: PaneId) {
        let mux = Mux::get();
        if let Some((_, _, tab_id)) = mux.resolve_pane_id(pane_id) {
            self.tab_bell_attention
                .borrow_mut()
                .entry(tab_id)
                .or_insert_with(Instant::now);
            self.arm_bell_blink();
            self.update_title();
        }
    }

    fn created(&mut self, ctx: RenderContext) -> anyhow::Result<()> {
        self.render_state = None;

        let render_info = ctx.renderer_info();
        self.opengl_info.replace(render_info.clone());

        match RenderState::new(ctx, &self.fonts, &self.render_metrics, ATLAS_SIZE) {
            Ok(render_state) => {
                log::debug!(
                    "OpenGL initialized! {} wezterm version: {}",
                    render_info,
                    config::wezterm_version(),
                );
                self.render_state.replace(render_state);
            }
            Err(err) => {
                log::error!("failed to create RenderState: {}", err);
            }
        }

        if self.render_state.is_none() {
            panic!("No OpenGL");
        }

        Ok(())
    }
}

impl TermWindow {
    pub async fn new_window(mux_window_id: MuxWindowId) -> anyhow::Result<()> {
        // WezTerminator (patch 0020): resolve the merged config
        // *with* the WezTerminator default overrides applied
        // before creating the OS window. Without this step, the
        // upstream `Window::new_window` reads the global config
        // (which still has the native `TITLE` bit set) and the
        // OS draws the native title bar over our fancy tab bar.
        // We pass the merged config to the window creator and
        // also stash it in the term-window's `config_overrides`
        // slot so subsequent `config_was_reloaded` calls keep
        // applying the same overrides.
        //
        // WezTerminator (patch 0023): also merge in the
        // VSCode-derived font overrides, if any. These are
        // applied as a second pass on top of the titlebar
        // overrides so a user who sets both in their
        // `wezterm.lua` still wins.
        //
        // WezTerminator (patch 0024): also merge in the
        // cursor-colour override. This needs the merged
        // config's `colors.background` to decide whether the
        // background is dark or light, so it is applied in a
        // *third* pass on top of titlebar + vscode_font. The
        // user's `colors.cursor_fg` setting still wins because
        // the user-facing config has the highest priority in
        // the upstream merge order.
        let titlebar_overrides = wtinator::titlebar::default_overrides()
            .unwrap_or_else(wezterm_dynamic::Value::default);
        let vscode_font_overrides = wtinator::vscode_font::default_overrides()
            .unwrap_or_else(wezterm_dynamic::Value::default);
        let overrides = merge_override_passes(
            titlebar_overrides,
            vscode_font_overrides,
        );
        // WezTerminator (patch 0042): macOS-style smooth fade-blink
        // cursor. Merged on top of titlebar + vscode_font; it only
        // sets cursor_blink_ease_in/out + default_cursor_style +
        // cursor_blink_rate, so it does not conflict with the later
        // cursor_color (cursor_fg) pass. The user's wezterm.lua still
        // wins (user config is merged last).
        let cursor_anim_overrides = wtinator::cursor_anim::default_overrides()
            .unwrap_or_else(wezterm_dynamic::Value::default);
        let overrides = merge_override_passes(overrides, cursor_anim_overrides);
        let config = match &overrides {
            wezterm_dynamic::Value::Null => configuration(),
            _ => config::overridden_config(&overrides)
                .unwrap_or_else(|_| configuration()),
        };
        // Now apply the cursor-colour pass on top of the
        // titlebar + vscode_font overrides. The merged
        // config's `colors.background` drives the choice.
        let cursor_overrides = {
            // `Palette::background` is `Option<RgbaColor>`.
            // The `RgbaColor` is a thin wrapper around
            // `SrgbaTuple` which is a `(f32, f32, f32, f32)`;
            // we destructure the inner tuple via `Deref` via
            // `as_srgba_tuple()`.
            let bg_rgb: Option<(f32, f32, f32)> = config
                .colors
                .as_ref()
                .and_then(|p| p.background.as_ref())
                .map(|c| (c.0, c.1, c.2));
            match bg_rgb {
                Some((r, g, b)) => wtinator::cursor_color::default_overrides(r, g, b)
                    .unwrap_or_else(wezterm_dynamic::Value::default),
                None => wezterm_dynamic::Value::default(),
            }
        };
        let overrides = merge_override_passes(overrides, cursor_overrides);
        let config = match &overrides {
            wezterm_dynamic::Value::Null => config,
            _ => config::overridden_config(&overrides)
                .unwrap_or_else(|_| config.clone()),
        };
        let dpi = config.dpi.unwrap_or_else(|| ::window::default_dpi()) as usize;
        let fontconfig = Rc::new(FontConfiguration::new(Some(config.clone()), dpi)?);

        let mux = Mux::get();
        let size = match mux.get_active_tab_for_window(mux_window_id) {
            Some(tab) => tab.get_size(),
            None => {
                log::debug!("new_window has no tabs... yet?");
                Default::default()
            }
        };
        let physical_rows = size.rows as usize;
        let physical_cols = size.cols as usize;

        let render_metrics = RenderMetrics::new(&fontconfig)?;
        log::trace!("using render_metrics {:#?}", render_metrics);

        // Initially we have only a single tab, so take that into account
        // for the tab bar state.
        let show_tab_bar = config.enable_tab_bar && !config.hide_tab_bar_if_only_one_tab;
        let tab_bar_height = if show_tab_bar {
            Self::tab_bar_pixel_height_impl(&config, &fontconfig, &render_metrics)? as usize
        } else {
            0
        };

        let terminal_size = TerminalSize {
            rows: physical_rows,
            cols: physical_cols,
            pixel_width: (render_metrics.cell_size.width as usize * physical_cols),
            pixel_height: (render_metrics.cell_size.height as usize * physical_rows),
            dpi: dpi as u32,
        };

        if terminal_size != size {
            // DPI is different from the default assumed DPI when the mux
            // created the pty. We need to inform the kernel of the revised
            // pixel geometry now
            log::trace!(
                "Initial geometry was {:?} but dpi-adjusted geometry \
                        is {:?}; update the kernel pixel geometry for the ptys!",
                size,
                terminal_size,
            );
            if let Some(window) = mux.get_window(mux_window_id) {
                for tab in window.iter() {
                    tab.resize(terminal_size);
                }
            };
        }

        let h_context = DimensionContext {
            dpi: dpi as f32,
            pixel_max: terminal_size.pixel_width as f32,
            pixel_cell: render_metrics.cell_size.width as f32,
        };
        let padding_left = config.window_padding.left.evaluate_as_pixels(h_context) as usize;
        let padding_right = resize::effective_right_padding(&config, h_context) as usize;
        let v_context = DimensionContext {
            dpi: dpi as f32,
            pixel_max: terminal_size.pixel_height as f32,
            pixel_cell: render_metrics.cell_size.height as f32,
        };
        let padding_top = config.window_padding.top.evaluate_as_pixels(v_context) as usize;
        let padding_bottom = config.window_padding.bottom.evaluate_as_pixels(v_context) as usize;

        let mut dimensions = Dimensions {
            pixel_width: (terminal_size.pixel_width + padding_left + padding_right) as usize,
            pixel_height: ((terminal_size.rows * render_metrics.cell_size.height as usize)
                + padding_top
                + padding_bottom) as usize
                + tab_bar_height,
            dpi,
        };

        let border = Self::get_os_border_impl(&None, &config, &dimensions, &render_metrics);

        dimensions.pixel_height += (border.top + border.bottom).get() as usize;
        dimensions.pixel_width += (border.left + border.right).get() as usize;

        let window_background = load_background_image(&config, &dimensions, &render_metrics);

        log::trace!(
            "TermWindow::new_window called with mux_window_id {} {:?} {:?}",
            mux_window_id,
            terminal_size,
            dimensions
        );

        let render_state = None;

        let connection_name = Connection::get().unwrap().name();

        let myself = Self {
            created: Instant::now(),
            connection_name,
            last_fps_check_time: Instant::now(),
            num_frames: 0,
            last_frame_duration: Duration::ZERO,
            fps: 0.,
            config_subscription: None,
            os_parameters: None,
            gl: None,
            webgpu: None,
            // WezTerminator (patch 0029): the auto-save
            // timer cancel flag is populated in `new_window`
            // after the mux is fully wired up. `None` here
            // means "no timer is running yet" — `close_requested`
            // treats `None` as a no-op.
            save_cancel: None,
            window: None,
            window_background,
            config: config.clone(),
            // WezTerminator (patch 0020): the same merged
            // overrides we used to resolve `config` are stashed
            // here so subsequent `config_was_reloaded` calls
            // keep applying them. The user can still override
            // individual keys in their `wezterm.lua`; the merged
            // config wins.
            config_overrides: overrides,
            palette: None,
            focused: None,
            mux_window_id,
            mux_window_id_for_subscriptions: Arc::new(Mutex::new(mux_window_id)),
            fonts: Rc::clone(&fontconfig),
            render_metrics,
            pane_font_cache: RefCell::new(HashMap::new()),
            dimensions,
            window_state: WindowState::default(),
            resizes_pending: 0,
            is_repaint_pending: false,
            pending_scale_changes: LinkedList::new(),
            terminal_size,
            render_state,
            input_map: InputMap::new(&config),
            leader_is_down: None,
            dead_key_status: DeadKeyStatus::None,
            show_tab_bar,
            show_scroll_bar: config.enable_scroll_bar,
            tab_bar: TabBarState::default(),
            fancy_tab_bar: None,
            right_status: String::new(),
            left_status: String::new(),
            last_mouse_coords: (0, -1),
            window_drag_position: None,
            current_mouse_event: None,
            current_modifier_and_leds: Default::default(),
            prev_cursor: PrevCursorPos::new(),
            cursor_glide: RefCell::new(None),
            cursor_glide_active: Cell::new(false),
            last_scroll_info: RenderableDimensions::default(),
            last_output_phys_top: Cell::new(None),
            pane_geometry_dirty: Cell::new(true),
            geometry_window_cols: Cell::new(0),
            geometry_window_rows: Cell::new(0),
            tab_state: RefCell::new(HashMap::new()),
            pane_state: RefCell::new(HashMap::new()),
            current_mouse_buttons: vec![],
            current_mouse_capture: None,
            last_mouse_click: None,
            current_highlight: None,
            quad_generation: 0,
            shape_generation: 0,
            shape_cache: RefCell::new(LfuCache::new(
                "shape_cache.hit.rate",
                "shape_cache.miss.rate",
                |config| config.shape_cache_size,
                &config,
            )),
            line_state_cache: RefCell::new(LfuCacheU64::new(
                "line_state_cache.hit.rate",
                "line_state_cache.miss.rate",
                |config| config.line_state_cache_size,
                &config,
            )),
            next_line_state_id: 0,
            line_quad_cache: RefCell::new(LfuCache::new(
                "line_quad_cache.hit.rate",
                "line_quad_cache.miss.rate",
                |config| config.line_quad_cache_size,
                &config,
            )),
            line_to_ele_shape_cache: RefCell::new(LfuCache::new(
                "line_to_ele_shape_cache.hit.rate",
                "line_to_ele_shape_cache.miss.rate",
                |config| config.line_to_ele_shape_cache_size,
                &config,
            )),
            last_status_call: Instant::now(),
            cursor_blink_state: RefCell::new(ColorEase::new(
                config.cursor_blink_rate,
                config.cursor_blink_ease_in,
                config.cursor_blink_rate,
                config.cursor_blink_ease_out,
                None,
            )),
            blink_state: RefCell::new(ColorEase::new(
                config.text_blink_rate,
                config.text_blink_ease_in,
                config.text_blink_rate,
                config.text_blink_ease_out,
                None,
            )),
            rapid_blink_state: RefCell::new(ColorEase::new(
                config.text_blink_rate_rapid,
                config.text_blink_rapid_ease_in,
                config.text_blink_rate_rapid,
                config.text_blink_rapid_ease_out,
                None,
            )),
            event_states: HashMap::new(),
            current_event: None,
            has_animation: RefCell::new(None),
            scheduled_animation: RefCell::new(None),
            tab_bell_attention: RefCell::new(HashMap::new()),
            bell_blink_running: Arc::new(AtomicBool::new(false)),
            window_close_confirmation_pending: false,
            allow_images: AllowImage::Yes,
            semantic_zones: HashMap::new(),
            ui_items: vec![],
            dragging: None,
            last_ui_item: None,
            is_click_to_focus_window: false,
            key_table_state: KeyTableState::default(),
            modal: RefCell::new(None),
            opengl_info: None,
            editing_header_pane: None,
            pane_dock_hover: None,
            header_edit_buffer: String::new(),
        };

        let tw = Rc::new(RefCell::new(myself));
        let tw_event = Rc::clone(&tw);

        let mut x = None;
        let mut y = None;
        let mut origin = GeometryOrigin::default();

        if let Some(position) = mux
            .get_window(mux_window_id)
            .and_then(|window| window.get_initial_position().clone())
            .or_else(|| POSITION.lock().unwrap().take())
        {
            x.replace(position.x);
            y.replace(position.y);
            origin = position.origin;
        }

        let geometry = RequestedWindowGeometry {
            width: Dimension::Pixels(dimensions.pixel_width as f32),
            height: Dimension::Pixels(dimensions.pixel_height as f32),
            x,
            y,
            origin,
        };
        log::trace!("{:?}", geometry);

        let window = Window::new_window(
            &get_window_class(),
            "wezterm",
            geometry,
            Some(&config),
            Rc::clone(&fontconfig),
            move |event, window| {
                // BethTerm (patch 0149): a synchronous Win32 call can
                // re-enter this proc while dispatch still holds the
                // RefCell. `borrow_mut` panics the whole GUI; skip the
                // nested event instead.
                let Ok(mut tw) = tw_event.try_borrow_mut() else {
                    log::warn!("bethterm: skipped reentrant window event");
                    return;
                };
                if let Err(err) = tw.dispatch_window_event(event, window) {
                    log::error!("dispatch_window_event: {:#}", err);
                }
            },
        )
        .await?;
        tw.borrow_mut().window.replace(window.clone());

        Self::apply_icon(&window)?;

        let config_subscription = config::subscribe_to_config_reload({
            let window = window.clone();
            move || {
                window.notify(TermWindowNotif::Apply(Box::new(|tw| {
                    tw.config_was_reloaded()
                })));
                true
            }
        });

        let gl = match config.front_end {
            FrontEndSelection::WebGpu => None,
            _ => Some(window.enable_opengl().await?),
        };

        {
            let mut myself = tw.borrow_mut();
            let webgpu = match config.front_end {
                FrontEndSelection::WebGpu => Some(Rc::new(
                    WebGpuState::new(&window, dimensions, &config).await?,
                )),
                _ => None,
            };
            myself.config_subscription.replace(config_subscription);
            if config.use_resize_increments {
                window.set_resize_increments(
                    ResizeIncrementCalculator {
                        x: myself.render_metrics.cell_size.width as u16,
                        y: myself.render_metrics.cell_size.height as u16,
                        padding_left: padding_left,
                        padding_top: padding_top,
                        padding_right: padding_right,
                        padding_bottom: padding_bottom,
                        border: border,
                        tab_bar_height: tab_bar_height,
                    }
                    .into(),
                );
            }

            if let Some(gl) = gl {
                myself.gl.replace(Rc::clone(&gl));
                myself.created(RenderContext::Glium(Rc::clone(&gl)))?;
            }
            if let Some(webgpu) = webgpu {
                myself.webgpu.replace(Rc::clone(&webgpu));
                myself.created(RenderContext::WebGpu(Rc::clone(&webgpu)))?;
            }
            myself.load_os_parameters();
            // WezTerminator (patch 0029): arm the 30-second
            // auto-save timer. The cancel flag is exposed via
            // `myself.save_cancel` and flipped in
            // `close_requested` / `close_requested_with_confirmation`
            // so the timer does not run after the window
            // has begun tearing down.
            //
            // We use `smol::Timer::at` (not
            // `tokio::time::interval`) because the wezterm
            // GUI is built on `promise::spawn` / `async_task`
            // — there is no live tokio runtime, and
            // `tokio::time::interval` panics with
            // "there is no reactor running, must be called
            // from the context of a tokio 1.x runtime".
            // `smol::Timer` is what the rest of the
            // termwindow uses (see `keyevent.rs` for the
            // same pattern).
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            myself.save_cancel = Some(cancel.clone());
            let cancel_for_timer = cancel.clone();
            promise::spawn::spawn(async move {
                loop {
                    Timer::at(
                        std::time::Instant::now()
                            + std::time::Duration::from_secs(30),
                    )
                    .await;
                    if cancel_for_timer.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    if let Err(e) = wtinator::session::save_async() {
                        log::warn!(
                            "wezterminator patch 0029: auto-save failed: {:#}",
                            e
                        );
                    }
                }
            })
            .detach();
            // WezTerminator (patch 0036): start the named-pipe
            // server for the `wtinator-config` companion app. The
            // server thread owns a clone of the `window` handle so
            // it can post `TermWindowNotif::Apply` closures (for
            // `set_theme`) back to this GUI main thread. The pipe
            // name is scoped by our pid
            // (`\\.\pipe\wtinator-config-<pid>`) so multiple
            // wezterm-gui instances do not stomp on each other.
            // Windows-only (the named-pipe API is Win32).
            #[cfg(windows)]
            {
                // WezTerminator (patch 0043): enumerate the system font
                // families once and stash them in a process-global the
                // pipe server reads for `list_fonts`. We do this on the
                // GUI thread because only it owns the `wezterm-font`
                // `FontConfiguration`; the names cross to `wtinator` as
                // plain strings so that crate never depends on
                // `wezterm-font`. `OnceLock` makes repeated window
                // creation a no-op after the first.
                match myself.fonts.list_system_fonts() {
                    Ok(parsed) => {
                        let families: Vec<String> = parsed
                            .iter()
                            .map(|p| p.names().family.clone())
                            .collect();
                        wtinator::notify_ipc::set_available_fonts(families);
                    }
                    Err(e) => {
                        log::warn!(
                            "wezterminator patch 0043: list_system_fonts failed: {:#}",
                            e
                        );
                    }
                }
                crate::termwindow::notify_pipe::start(window.clone());
            }
            // BethTerm (patch 0148): a window re-created after a GUI
            // restart gets back its name and placement (keyed by the
            // host panes it shows). A window remembered as hidden in
            // the tray goes back to the tray instead of popping up.
            // Patch 0149: `SetWindowPlacement` delivers
            // WM_WINDOWPOSCHANGED before returning, and that proc
            // borrows this TermWindow. Drop `myself` first or the
            // reattach panics.
            #[cfg(windows)]
            let restored = if crate::tabbar::is_wtinator_active() {
                let hwnd = window.hwnd() as isize;
                let mux_window_id = myself.mux_window_id;
                drop(myself);
                wtinator::window_geom::register_hwnd(mux_window_id, hwnd);
                let restored =
                    wtinator::window_geom::restore_for_window(mux_window_id, hwnd);
                myself = tw.borrow_mut();
                restored
            } else {
                None
            };
            #[cfg(not(windows))]
            let restored: Option<wtinator::window_geom::Restored> = None;
            match restored {
                Some(r) if r.placement && r.hidden => {
                    let hwnd = window.hwnd() as isize;
                    let mux_window_id = myself.mux_window_id;
                    promise::spawn::spawn_into_main_thread(async move {
                        #[cfg(windows)]
                        if let Err(e) = wtinator::tray::hide_window(hwnd, mux_window_id) {
                            log::warn!("bethterm: could not re-hide restored window: {e:#}");
                        }
                        let _ = (hwnd, mux_window_id);
                    })
                    .detach();
                }
                Some(r) if r.placement => {
                    // SetWindowPlacement already showed it where it was.
                }
                _ => {
                    if crate::tabbar::is_wtinator_active() {
                        // WezTerminator (patch 0086): a new physical window inherits
                        // the source tab's cell size. Shown as SW_NORMAL, a
                        // borderless WS_POPUP of that size is centered on the
                        // full monitor (rcMonitor) and covers the taskbar.
                        // Maximize instead: SW_MAXIMIZE still shows the window,
                        // and WM_GETMINMAXINFO (patch 0066) clamps it to rcWork.
                        window.maximize();
                    } else {
                        window.show();
                    }
                }
            }
            #[cfg(windows)]
            {
                wtinator::window_heal::schedule_visibility_watchdog(window.hwnd() as isize);
            }
            // BethTerm (patch 0172): one periodic sliver-pane check for the
            // whole process; catches splits squeezed without a window
            // resize (a tray-hidden window shown again).
            if wtinator::split_heal::claim_periodic() {
                promise::spawn::spawn(async move {
                    loop {
                        smol::Timer::after(wtinator::split_heal::CHECK_EVERY).await;
                        let Some(mux) = Mux::try_get() else {
                            continue;
                        };
                        let tabs: Vec<_> = mux
                            .iter_windows()
                            .into_iter()
                            .filter_map(|id| {
                                mux.get_window(id)
                                    .map(|w| w.iter().cloned().collect::<Vec<_>>())
                            })
                            .flatten()
                            .collect();
                        for tab in tabs {
                            wtinator::split_heal::heal_tab_throttled(&tab);
                        }
                    }
                })
                .detach();
            }
            // BethTerm (patch 0111 + 0117): the notification-area icon
            // lives as long as the process, even with zero hidden
            // windows, and its menu offers "Novo terminal" (shell
            // picker → new OS window) plus restore/quit. Single owner
            // across processes: a second process stays in forward mode
            // and adds no icon.
            #[cfg(windows)]
            if crate::tabbar::is_wtinator_active() {
                wtinator::tray::init_for_gui(crate::spawn::spawn_new_window);
                wtinator::tray::register_dashboard(
                    crate::termwindow::render::dashboard::open_dashboard_from_tray,
                );
            }
            // BethTerm (patch 0124): Painel, saved default, or BETHTERM_DASHBOARD=1.
            if crate::tabbar::is_wtinator_active()
                && wtinator::dashboard::should_open_on_new_window()
            {
                wtinator::dashboard::open(myself.mux_window_id);
                let dims = myself.dimensions.clone();
                myself.apply_dimensions(&dims, None, &window);
            }
            // WezTerminator (patch 0079): restore only after the window is
            // shown so a stalled session.json cannot hide the GUI.
            crate::termwindow::session_restore::start_startup_restore(
                myself.mux_window_id,
                myself.terminal_size,
            );
            myself.subscribe_to_pane_updates();
            myself.emit_window_event("window-config-reloaded", None);
            myself.emit_status_event();
        }

        crate::update::start_update_checker();
        front_end().record_known_window(window, mux_window_id);

        Ok(())
    }

    fn dispatch_window_event(
        &mut self,
        event: WindowEvent,
        window: &Window,
    ) -> anyhow::Result<bool> {
        log::debug!("{event:?}");
        match event {
            WindowEvent::Destroyed => {
                #[cfg(windows)]
                wtinator::window_geom::unregister_hwnd(self.mux_window_id);
                // Ensure that we cancel any overlays we had running, so
                // that the mux can empty out, otherwise the mux keeps
                // the TermWindow alive via the frontend even though
                // the window is gone and we'll linger forever.
                // <https://github.com/wezterm/wezterm/issues/3522>
                self.clear_all_overlays();
                Ok(false)
            }
            WindowEvent::CloseRequested => {
                self.close_requested(window);
                Ok(true)
            }
            WindowEvent::AppearanceChanged(appearance) => {
                log::debug!("Appearance is now {:?}", appearance);
                // This is a bit fugly; we get per-window notifications
                // for appearance changes which successfully updates the
                // per-window config, but we need to explicitly tell the
                // global config to reload, otherwise things that acces
                // the config via config::configuration() will see the
                // prior version of the config.
                // What's fugly about this is that we'll reload the
                // global config here once per window, which could
                // be nasty for folks with a lot of windows.
                // <https://github.com/wezterm/wezterm/issues/2295>
                config::reload();
                self.config_was_reloaded();
                Ok(true)
            }
            WindowEvent::PerformKeyAssignment(action) => {
                if let Some(pane) = self.get_active_pane_or_overlay() {
                    self.perform_key_assignment(&pane, &action)?;
                    window.invalidate();
                }
                Ok(true)
            }
            WindowEvent::FocusChanged(focused) => {
                self.focus_changed(focused, window);
                Ok(true)
            }
            WindowEvent::MouseEvent(event) => {
                self.mouse_event_impl(event, window);
                Ok(true)
            }
            WindowEvent::MouseLeave => {
                self.mouse_leave_impl(window);
                Ok(true)
            }
            WindowEvent::Resized {
                dimensions,
                window_state,
                live_resizing,
            } => {
                self.resize(dimensions, window_state, window, live_resizing);
                Ok(true)
            }
            WindowEvent::SetInnerSizeCompleted => {
                self.resizes_pending -= 1;
                if self.is_repaint_pending {
                    self.is_repaint_pending = false;
                    if self.webgpu.is_some() {
                        self.do_paint_webgpu()?;
                    } else {
                        self.do_paint(window);
                    }
                }
                self.apply_pending_scale_changes();
                Ok(true)
            }
            WindowEvent::AdviseModifiersLedStatus(modifiers, leds) => {
                self.current_modifier_and_leds = (modifiers, leds);
                self.update_title();
                window.invalidate();
                Ok(true)
            }
            WindowEvent::RawKeyEvent(event) => {
                self.raw_key_event_impl(event, window);
                Ok(true)
            }
            WindowEvent::KeyEvent(event) => {
                self.key_event_impl(event, window);
                Ok(true)
            }
            WindowEvent::AdviseDeadKeyStatus(status) => {
                if self.config.debug_key_events {
                    log::info!("DeadKeyStatus now: {:?}", status);
                } else {
                    log::trace!("DeadKeyStatus now: {:?}", status);
                }
                self.dead_key_status = status;
                self.update_title();
                // Ensure that we repaint so that any composing
                // text is updated
                window.invalidate();
                Ok(true)
            }
            WindowEvent::NeedRepaint => {
                if self.resizes_pending > 0 {
                    self.is_repaint_pending = true;
                    Ok(true)
                } else if gpu_paint_suppressed(window) {
                    // Patch 0116: PTY/mux keep running; skip the GPU frame.
                    Ok(true)
                } else if self.webgpu.is_some() {
                    self.do_paint_webgpu()
                } else {
                    Ok(self.do_paint(window))
                }
            }
            WindowEvent::Notification(item) => {
                if let Ok(notif) = item.downcast::<TermWindowNotif>() {
                    self.dispatch_notif(*notif, window)
                        .context("dispatch_notif")?;
                }
                Ok(true)
            }
            WindowEvent::DroppedString(text) => {
                let pane = match self.get_active_pane_or_overlay() {
                    Some(pane) => pane,
                    None => return Ok(true),
                };
                pane.send_paste(text.as_str())?;
                Ok(true)
            }
            WindowEvent::DroppedUrl(urls) => {
                let pane = match self.get_active_pane_or_overlay() {
                    Some(pane) => pane,
                    None => return Ok(true),
                };
                let urls = urls
                    .iter()
                    .map(|url| self.config.quote_dropped_files.escape(&url.to_string()))
                    .collect::<Vec<_>>()
                    .join(" ")
                    + " ";
                pane.send_paste(urls.as_str())?;
                Ok(true)
            }
            WindowEvent::DroppedFile(paths) => {
                let pane = match self.get_active_pane_or_overlay() {
                    Some(pane) => pane,
                    None => return Ok(true),
                };
                let paths = paths
                    .iter()
                    .map(|path| {
                        self.config
                            .quote_dropped_files
                            .escape(&path.to_string_lossy())
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
                    + " ";
                pane.send_paste(&paths)?;
                Ok(true)
            }
            WindowEvent::DraggedFile(_) => Ok(true),
        }
    }

    fn do_paint(&mut self, window: &Window) -> bool {
        let gl = match self.gl.as_ref() {
            Some(gl) => gl,
            None => return false,
        };

        if gl.is_context_lost() {
            log::error!("opengl context was lost; should reinit");
            window.close();
            front_end().forget_known_window(window);
            return false;
        }

        let mut frame = glium::Frame::new(
            Rc::clone(&gl),
            (
                self.dimensions.pixel_width as u32,
                self.dimensions.pixel_height as u32,
            ),
        );
        self.paint_impl(&mut RenderFrame::Glium(&mut frame));
        window.finish_frame(frame).is_ok()
    }

    fn do_paint_webgpu(&mut self) -> anyhow::Result<bool> {
        self.webgpu.as_mut().unwrap().resize(self.dimensions);
        match self.do_paint_webgpu_impl() {
            Ok(ok) => Ok(ok),
            Err(err) => {
                match err.downcast_ref::<wgpu::SurfaceError>() {
                    Some(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                        self.webgpu.as_mut().unwrap().resize(self.dimensions);
                        return self.do_paint_webgpu_impl();
                    }
                    _ => {}
                }
                Err(err)
            }
        }
    }

    fn do_paint_webgpu_impl(&mut self) -> anyhow::Result<bool> {
        self.paint_impl(&mut RenderFrame::WebGpu);
        Ok(true)
    }

    fn dispatch_notif(&mut self, notif: TermWindowNotif, window: &Window) -> anyhow::Result<()> {
        fn chan_err<T>(e: smol::channel::TrySendError<T>) -> anyhow::Error {
            anyhow::anyhow!("{}", e)
        }

        match notif {
            TermWindowNotif::InvalidateShapeCache => {
                self.shape_generation += 1;
                self.shape_cache.borrow_mut().clear();
                self.invalidate_modal();
                window.invalidate();
            }
            TermWindowNotif::PerformAssignment {
                pane_id,
                assignment,
                tx,
            } => {
                let mux = Mux::get();
                let result = || -> anyhow::Result<()> {
                    // The CopyMode overlay doesn't exist in the mux, but aliases
                    // itself with the overlaid pane's pane_id.
                    // So we do a bit of fancy footwork here to resolve the overlay
                    // and use that if it has the same pane_id, but otherwise fall
                    // back to what we get from the mux.
                    // <https://github.com/wezterm/wezterm/issues/3209>
                    let active_pane = self
                        .get_active_pane_or_overlay()
                        .ok_or_else(|| anyhow!("there is no active pane!?"))?;
                    let pane = if active_pane.pane_id() == pane_id {
                        active_pane
                    } else {
                        mux.get_pane(pane_id)
                            .ok_or_else(|| anyhow!("pane id {} is not valid", pane_id))?
                    };
                    self.perform_key_assignment(&pane, &assignment)
                        .context("perform_key_assignment")?;
                    Ok(())
                }();
                window.invalidate();
                if let Some(tx) = tx {
                    tx.try_send(result).ok();
                }
            }
            TermWindowNotif::SetRightStatus(status) => {
                if status != self.right_status {
                    self.right_status = status;
                    self.update_title_post_status();
                } else {
                    self.schedule_next_status_update();
                }
            }
            TermWindowNotif::SetLeftStatus(status) => {
                if status != self.left_status {
                    self.left_status = status;
                    self.update_title_post_status();
                } else {
                    self.schedule_next_status_update();
                }
            }
            TermWindowNotif::GetDimensions(tx) => {
                tx.try_send((self.dimensions, self.window_state))
                    .map_err(chan_err)
                    .context("send GetDimensions response")?;
            }
            TermWindowNotif::GetEffectiveConfig(tx) => {
                tx.try_send(self.config.clone())
                    .map_err(chan_err)
                    .context("send GetEffectiveConfig response")?;
            }
            TermWindowNotif::FinishWindowEvent { name, again } => {
                self.finish_window_event(&name, again);
            }
            TermWindowNotif::GetConfigOverrides(tx) => {
                tx.try_send(self.config_overrides.clone())
                    .map_err(chan_err)
                    .context("send GetConfigOverrides response")?;
            }
            TermWindowNotif::SetConfigOverrides(value) => {
                if value != self.config_overrides {
                    self.config_overrides = value;
                    self.config_was_reloaded();
                }
            }
            TermWindowNotif::CancelOverlayForPane(pane_id) => {
                self.cancel_overlay_for_pane(pane_id);
            }
            TermWindowNotif::CancelOverlayForTab { tab_id, pane_id } => {
                self.cancel_overlay_for_tab(tab_id, pane_id);
            }
            TermWindowNotif::MuxNotification(n) => match n {
                MuxNotification::Alert {
                    alert: Alert::SetUserVar { name, value },
                    pane_id,
                } => {
                    self.emit_user_var_event(pane_id, name, value);
                }
                MuxNotification::WindowTitleChanged { .. }
                | MuxNotification::Alert {
                    alert:
                        Alert::OutputSinceFocusLost
                        | Alert::CurrentWorkingDirectoryChanged
                        | Alert::WindowTitleChanged(_)
                        | Alert::TabTitleChanged(_)
                        | Alert::IconTitleChanged(_)
                        | Alert::Progress(_),
                    ..
                } => {
                    self.update_title();
                }
                MuxNotification::Alert {
                    alert: Alert::PaletteChanged,
                    pane_id,
                } => {
                    // Shape cache includes color information, so
                    // ensure that we invalidate that as part of
                    // this overall invalidation for the palette
                    self.dispatch_notif(TermWindowNotif::InvalidateShapeCache, window)?;
                    self.mux_pane_output_event(pane_id);
                }
                MuxNotification::Alert {
                    alert: Alert::Bell,
                    pane_id,
                } => {
                    if !self.window_contains_pane(pane_id) {
                        return Ok(());
                    }

                    match self.config.audible_bell {
                        AudibleBell::SystemBeep => {
                            Connection::get().expect("on main thread").beep();
                        }
                        AudibleBell::Disabled => {}
                    }

                    log::trace!("Ding! (this is the bell) in pane {}", pane_id);
                    self.emit_window_event("bell", Some(pane_id));

                    {
                        let mut per_pane = self.pane_state(pane_id);
                        per_pane.bell_start.replace(Instant::now());
                    }
                    window.invalidate();

                    // WezTerminator (patch 0063): flag the belling pane's TAB so
                    // it shows a blinking attention dot (e.g. Claude waiting via
                    // the terminal_bell channel). Cleared when the tab is active
                    // and the window is focused; `or_insert` keeps the blink phase
                    // stable across repeated bells.
                    self.mark_tab_attention(pane_id);
                }
                MuxNotification::Alert {
                    alert: Alert::ToastNotification { title, body, .. },
                    pane_id,
                } => {
                    // WezTerminator (patch 0070): Codex CLI's `auto`
                    // notification method prefers OSC 9 over BEL for
                    // `agent-turn-complete` and `approval-requested`. Treat
                    // that terminal notification exactly like the existing
                    // agent bell attention signal.
                    if self.window_contains_pane(pane_id) {
                        log::debug!(
                            "terminal notification in pane {}: title={:?} body={:?}",
                            pane_id,
                            title,
                            body
                        );
                        self.mark_tab_attention(pane_id);
                    }
                }
                MuxNotification::TabAddedToWindow {
                    window_id: _,
                    tab_id,
                } => {
                    self.pane_geometry_dirty.set(true);
                    let mux = Mux::get();
                    let mut size = self.terminal_size;
                    if let Some(tab) = mux.get_tab(tab_id) {
                        // If we attached to a remote domain and loaded in
                        // a tab async, we need to fixup its size, either
                        // by resizing it or resizes ourselves.
                        // The strategy here is to adjust both by taking
                        // the maximal size in both horizontal and vertical
                        // dimensions and applying that. In practice that
                        // means that a new local client will resize larger
                        // to adjust to the size of an existing client.
                        let tab_size = tab.get_size();
                        size.rows = size.rows.max(tab_size.rows);
                        size.cols = size.cols.max(tab_size.cols);

                        if size.rows != self.terminal_size.rows
                            || size.cols != self.terminal_size.cols
                            || size.pixel_width != self.terminal_size.pixel_width
                            || size.pixel_height != self.terminal_size.pixel_height
                        {
                            self.set_window_size(size, window)?;
                        } else if tab_size.dpi == 0 {
                            log::debug!("fixup dpi in newly added tab");
                            tab.resize(self.terminal_size);
                        }
                    }
                }
                MuxNotification::PaneOutput(pane_id) => {
                    self.mux_pane_output_event(pane_id);
                }
                MuxNotification::WindowInvalidated(_) => {
                    self.pane_geometry_dirty.set(true);
                    window.invalidate();
                    self.update_title_post_status();
                }
                MuxNotification::WindowRemoved(_window_id) => {
                    // Handled by frontend
                }
                MuxNotification::AssignClipboard { .. } => {
                    // Handled by frontend
                }
                MuxNotification::SaveToDownloads { .. } => {
                    // Handled by frontend
                }
                MuxNotification::PaneFocused(_) => {
                    // Also handled by clientpane
                    self.update_title_post_status();
                }
                MuxNotification::TabResized(_) => {
                    // Also handled by wezterm-client
                    self.pane_geometry_dirty.set(true);
                    self.update_title_post_status();
                }
                MuxNotification::TabTitleChanged { .. } => {
                    self.update_title_post_status();
                }
                MuxNotification::PaneAdded(_) | MuxNotification::PaneRemoved(_) => {
                    self.pane_geometry_dirty.set(true);
                }
                MuxNotification::WorkspaceRenamed { .. }
                | MuxNotification::WindowWorkspaceChanged(_)
                | MuxNotification::ActiveWorkspaceChanged(_)
                | MuxNotification::Empty
                | MuxNotification::WindowCreated(_) => {}
            },
            TermWindowNotif::EmitStatusUpdate => {
                self.emit_status_event();
            }
            TermWindowNotif::GetSelectionForPane { pane_id, tx } => {
                let mux = Mux::get();
                let pane = mux
                    .get_pane(pane_id)
                    .ok_or_else(|| anyhow!("pane id {} is not valid", pane_id))?;

                tx.try_send(self.selection_text(&pane))
                    .map_err(chan_err)
                    .context("send GetSelectionForPane response")?;
            }
            TermWindowNotif::Apply(func) => {
                func(self);
            }
            TermWindowNotif::SwitchToMuxWindow(mux_window_id) => {
                self.mux_window_id = mux_window_id;
                *self.mux_window_id_for_subscriptions.lock().unwrap() = mux_window_id;

                self.clear_all_overlays();
                self.current_highlight.take();
                self.invalidate_fancy_tab_bar();
                self.invalidate_modal();

                let mux = Mux::get();
                if let Some(window) = mux.get_window(self.mux_window_id) {
                    for tab in window.iter() {
                        tab.resize(self.terminal_size);
                    }
                };
                self.update_title();
                window.invalidate();
            }
            TermWindowNotif::SetInnerSize { width, height } => {
                self.set_inner_size(window, width, height);
            }
        }

        Ok(())
    }

    fn set_inner_size(&mut self, window: &Window, width: usize, height: usize) {
        self.resizes_pending += 1;
        window.set_inner_size(width, height);
    }

    /// Take care to remove our panes from the mux, otherwise
    /// we can leave the mux with no windows but some panes
    /// and it won't believe that we are empty.
    fn clear_all_overlays(&mut self) {
        let overlay_panes_to_cancel = self
            .pane_state
            .borrow()
            .iter()
            .filter_map(|(_, state)| state.overlay.as_ref().map(|overlay| overlay.pane.pane_id()))
            .collect::<Vec<_>>();

        for pane_id in overlay_panes_to_cancel {
            self.cancel_overlay_for_pane(pane_id);
        }

        let tab_overlays_to_cancel = self
            .tab_state
            .borrow()
            .iter()
            .filter_map(|(tab_id, state)| state.overlay.as_ref().map(|_| *tab_id))
            .collect::<Vec<_>>();

        for tab_id in tab_overlays_to_cancel {
            self.cancel_overlay_for_tab(tab_id, None);
        }

        self.pane_state.borrow_mut().clear();
        self.tab_state.borrow_mut().clear();
    }

    fn apply_icon(window: &Window) -> anyhow::Result<()> {
        let image = image::load_from_memory(ICON_DATA)?.into_rgba8();
        let (width, height) = image.dimensions();
        window.set_icon(Image::with_rgba32(
            width as usize,
            height as usize,
            width as usize * 4,
            image.as_raw(),
        ));
        Ok(())
    }

    fn schedule_status_update(&self) {
        if let Some(window) = self.window.as_ref() {
            window.notify(TermWindowNotif::EmitStatusUpdate);
        }
    }

    fn is_pane_visible(&mut self, pane_id: PaneId) -> bool {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return false,
        };

        let tab_id = tab.tab_id();
        if let Some(tab_overlay) = self
            .tab_state(tab_id)
            .overlay
            .as_ref()
            .map(|overlay| overlay.pane.clone())
        {
            return tab_overlay.pane_id() == pane_id;
        }

        tab.contains_pane(pane_id)
    }

    fn mux_pane_output_event(&mut self, pane_id: PaneId) {
        metrics::histogram!("mux.pane_output_event.rate").record(1.);
        if !self.is_pane_visible(pane_id) {
            return;
        }

        // Patch 0119: Tab completion (and other in-place floods) fire
        // PaneOutput many times per frame. Wiping every line cache on
        // each chunk (0073–0075) forced a full reshape + GPU pass and
        // froze the window. Line caches are keyed by shape_hash and
        // pixel Y, so changed rows miss on their own. Keep the Enter-
        // scroll wipe only when physical_top actually moves.
        let scrolled = Mux::get()
            .get_pane(pane_id)
            .map(|pane| {
                let top = pane.get_dimensions().physical_top;
                let prev = self.last_output_phys_top.get();
                let same_pane = prev.map(|(id, _)| id == pane_id).unwrap_or(false);
                let moved = prev.map(|(_, t)| t != top).unwrap_or(false);
                self.last_output_phys_top.set(Some((pane_id, top)));
                same_pane && moved
            })
            .unwrap_or(false);

        if scrolled {
            self.quad_generation = self.quad_generation.wrapping_add(1);
            self.line_state_cache.borrow_mut().clear();
            self.line_to_ele_shape_cache.borrow_mut().clear();
            self.line_quad_cache.borrow_mut().clear();
        }

        if let Some(ref win) = self.window {
            if !gpu_paint_suppressed(win) {
                win.invalidate();
            }
        }
    }

    fn mux_pane_output_event_callback(
        n: MuxNotification,
        window: &Window,
        mux_window_id: MuxWindowId,
        dead: &Arc<AtomicBool>,
    ) -> bool {
        if dead.load(Ordering::Relaxed) {
            // Subscription cancelled asynchronously
            return false;
        }

        match n {
            MuxNotification::Alert {
                pane_id,
                alert:
                    Alert::OutputSinceFocusLost
                    | Alert::CurrentWorkingDirectoryChanged
                    | Alert::WindowTitleChanged(_)
                    | Alert::TabTitleChanged(_)
                    | Alert::IconTitleChanged(_)
                    | Alert::Progress(_)
                    | Alert::SetUserVar { .. }
                    | Alert::Bell
                    | Alert::ToastNotification { .. },
            }
            | MuxNotification::PaneFocused(pane_id)
            | MuxNotification::PaneRemoved(pane_id)
            | MuxNotification::PaneOutput(pane_id) => {
                // Ideally we'd check to see if pane_id is part of this window,
                // but overlays may not be 100% associated with the window
                // in the mux and we don't want to lose the invalidation
                // signal for that case, so we just check window validity
                // here and propagate to the window event handler that
                // will then do the check with full context.
                let mux = Mux::get();
                if mux.get_window(mux_window_id).is_none() {
                    // Something inconsistent: cancel subscription
                    log::debug!(
                        "PaneOutput: wanted mux_window_id={} from mux, but \
                         was not found, cancel mux subscription",
                        mux_window_id
                    );
                    return false;
                }
                let _ = pane_id;
            }
            MuxNotification::PaneAdded(_pane_id) => {
                // If some other client spawns a pane inside this window, this
                // gives us an opportunity to attach it to the clipboard.
                let mux = Mux::get();
                return mux.get_window(mux_window_id).is_some();
            }
            MuxNotification::TabAddedToWindow { window_id, .. }
            | MuxNotification::WindowTitleChanged { window_id, .. }
            | MuxNotification::WindowInvalidated(window_id) => {
                if window_id != mux_window_id {
                    return true;
                }
            }
            MuxNotification::WindowRemoved(window_id) => {
                if window_id != mux_window_id {
                    return true;
                }
                // Set the window as dead to unsubscribe from further notifications
                dead.store(true, Ordering::Relaxed);
                return false;
            }
            MuxNotification::TabResized(tab_id)
            | MuxNotification::TabTitleChanged { tab_id, .. } => {
                let mux = Mux::get();
                if mux.window_containing_tab(tab_id) == Some(mux_window_id) {
                    // fall through
                } else {
                    return true;
                }
            }
            MuxNotification::AssignClipboard { .. }
            | MuxNotification::SaveToDownloads { .. }
            | MuxNotification::WindowCreated(_)
            | MuxNotification::ActiveWorkspaceChanged(_)
            | MuxNotification::WorkspaceRenamed { .. }
            | MuxNotification::Empty
            | MuxNotification::WindowWorkspaceChanged(_) => return true,
            MuxNotification::Alert {
                alert: Alert::PaletteChanged { .. },
                ..
            } => {
                // fall through
            }
        }

        window.notify(TermWindowNotif::MuxNotification(n));

        true
    }

    fn subscribe_to_pane_updates(&self) {
        let window = self.window.clone().expect("window to be valid on startup");
        let mux_window_id = Arc::clone(&self.mux_window_id_for_subscriptions);
        let mux = Mux::get();
        let dead = Arc::new(AtomicBool::new(false));
        // Patch 0119: one GUI hop is enough for a burst of PaneOutput.
        // The mux already has the latest cells; extra hops just stall Tab.
        let output_pending = Arc::new(AtomicBool::new(false));
        mux.subscribe(move |n| {
            if dead.load(Ordering::Relaxed) {
                return false;
            }
            if matches!(n, MuxNotification::PaneOutput(_)) {
                if output_pending.swap(true, Ordering::Relaxed) {
                    return true;
                }
            }
            let mux_window_id = *mux_window_id.lock().unwrap();
            let window = window.clone();
            let dead = dead.clone();
            let output_pending = output_pending.clone();
            promise::spawn::spawn_into_main_thread(async move {
                if matches!(n, MuxNotification::PaneOutput(_)) {
                    output_pending.store(false, Ordering::Relaxed);
                }
                Self::mux_pane_output_event_callback(n, &window, mux_window_id, &dead)
            })
            .detach();
            true
        });
    }

    fn emit_status_event(&mut self) {
        self.emit_window_event("update-right-status", None);
        self.emit_window_event("update-status", None);
    }

    fn schedule_window_event(&mut self, name: &str, pane_id: Option<PaneId>) {
        let window = GuiWin::new(self);
        let pane = match pane_id {
            Some(pane_id) => Mux::get().get_pane(pane_id),
            None => None,
        };
        let pane = match pane {
            Some(pane) => pane,
            None => match self.get_active_pane_or_overlay() {
                Some(pane) => pane,
                None => return,
            },
        };
        let pane = MuxPane(pane.pane_id());
        let name = name.to_string();

        async fn do_event(
            lua: Option<Rc<mlua::Lua>>,
            name: String,
            window: GuiWin,
            pane: MuxPane,
        ) -> anyhow::Result<()> {
            let again = if let Some(lua) = lua {
                let args = lua.pack_multi((window.clone(), pane))?;

                if let Err(err) = config::lua::emit_event(&lua, (name.clone(), args)).await {
                    log::error!("while processing {} event: {:#}", name, err);
                }
                true
            } else {
                false
            };

            window
                .window
                .notify(TermWindowNotif::FinishWindowEvent { name, again });

            Ok(())
        }

        promise::spawn::spawn(config::with_lua_config_on_main_thread(move |lua| {
            do_event(lua, name, window, pane)
        }))
        .detach();
    }

    /// Called as part of finishing up a callout to lua.
    /// If again==false it means that there isn't a lua config
    /// to execute against, so we should just mark as done.
    /// Otherwise, if there is a queued item, schedule it now.
    fn finish_window_event(&mut self, name: &str, again: bool) {
        let state = self
            .event_states
            .entry(name.to_string())
            .or_insert(EventState::None);
        if again {
            match state {
                EventState::InProgress => {
                    *state = EventState::None;
                }
                EventState::InProgressWithQueued(pane) => {
                    let pane = *pane;
                    *state = EventState::InProgress;
                    self.schedule_window_event(name, pane);
                }
                EventState::None => {}
            }
        } else {
            *state = EventState::None;
        }
    }

    pub fn emit_window_event(&mut self, name: &str, pane_id: Option<PaneId>) {
        if self.get_active_pane_or_overlay().is_none() || self.window.is_none() {
            return;
        }

        let state = self
            .event_states
            .entry(name.to_string())
            .or_insert(EventState::None);
        match state {
            EventState::InProgress => {
                // Flag that we want to run again when the currently
                // executing event calls finish_window_event().
                *state = EventState::InProgressWithQueued(pane_id);
                return;
            }
            EventState::InProgressWithQueued(other_pane) => {
                // We've already got one copy executing and another
                // pending dispatch, so don't queue another.
                if pane_id != *other_pane {
                    log::warn!(
                        "Cannot queue {} event for pane {:?}, as \
                         there is already an event queued for pane {:?} \
                         in the same window",
                        name,
                        pane_id,
                        other_pane
                    );
                }
                return;
            }
            EventState::None => {
                // Nothing pending, so schedule a call now
                *state = EventState::InProgress;
                self.schedule_window_event(name, pane_id);
            }
        }
    }

    fn check_for_dirty_lines_and_invalidate_selection(&mut self, pane: &Arc<dyn Pane>) {
        let dims = pane.get_dimensions();
        let viewport = self
            .get_viewport(pane.pane_id())
            .unwrap_or(dims.physical_top);
        let visible_range = viewport..viewport + dims.viewport_rows as StableRowIndex;
        let seqno = self.selection(pane.pane_id()).seqno;
        let dirty = pane.get_changed_since(visible_range, seqno);

        if dirty.is_empty() {
            return;
        }
        if pane.downcast_ref::<CopyOverlay>().is_none()
            && pane.downcast_ref::<QuickSelectOverlay>().is_none()
        {
            // If any of the changed lines intersect with the
            // selection, then we need to clear the selection, but not
            // when the search overlay is active; the search overlay
            // marks lines as dirty to force invalidate them for
            // highlighting purpose but also manipulates the selection
            // and we want to allow it to retain the selection it made!

            let clear_selection =
                if let Some(selection_range) = self.selection(pane.pane_id()).range.as_ref() {
                    let selection_rows = selection_range.rows();
                    selection_rows.into_iter().any(|row| dirty.contains(row))
                } else {
                    false
                };

            if clear_selection {
                self.selection(pane.pane_id()).range.take();
                self.selection(pane.pane_id()).origin.take();
                self.selection(pane.pane_id()).seqno = pane.get_current_seqno();
            }
        }
    }
}

impl TermWindow {
    fn palette(&mut self) -> &ColorPalette {
        if self.palette.is_none() {
            self.palette
                .replace(config::TermConfig::new().color_palette());
        }
        self.palette.as_ref().unwrap()
    }

    /// WezTerminator (patch 0016.2 + 0016.3): replace the current
    /// color palette at runtime. Used by the right-click "Theme"
    /// submenu to switch between the built-in schemes without
    /// requiring a `wezterm.reload_configuration()`.
    ///
    /// Two palette caches are involved:
    ///   1. `self.palette` — used by the tab bar, status line, and
    ///      any window-chrome rendering. Replaced directly.
    ///   2. The `Pane` palette — used by the terminal content
    ///      renderer. Replaced via `Pane::set_palette` on the
    ///      active pane (and the focused overlay pane, if any).
    pub fn set_color_scheme(&mut self, scheme: ColorPalette) {
        let bg = scheme.background;
        let fg = scheme.foreground;
        // (1) Window chrome.
        self.palette = Some(scheme.clone());
        self.shape_generation += 1;
        self.shape_cache.borrow_mut().clear();
        // (2) Active pane content. If a search/copy overlay is
        // open, also push the new palette to that overlay's
        // pane (otherwise the overlay stays on the old colors
        // until it is closed and re-opened).
        if let Some(pane) = self.get_active_pane_or_overlay() {
            pane.set_palette(scheme);
        }
        log::info!(
            "wezterminator: set_color_scheme applied; new bg={:?} fg={:?}",
            bg,
            fg
        );
    }

    pub fn config_was_reloaded(&mut self) {
        log::debug!(
            "config was reloaded, overrides: {:?}",
            self.config_overrides
        );
        self.key_table_state.clear_stack();
        self.connection_name = Connection::get().unwrap().name();
        let config = match config::overridden_config(&self.config_overrides) {
            Ok(config) => config,
            Err(err) => {
                log::error!(
                    "Failed to apply config overrides to window: {:#}: {:?}",
                    err,
                    self.config_overrides
                );
                configuration()
            }
        };
        self.config = config.clone();
        self.palette.take();

        let mux = Mux::get();
        let window = match mux.get_window(self.mux_window_id) {
            Some(window) => window,
            _ => return,
        };
        if window.len() == 1 {
            self.show_tab_bar = config.enable_tab_bar && !config.hide_tab_bar_if_only_one_tab;
        } else {
            self.show_tab_bar = config.enable_tab_bar;
        }
        *self.cursor_blink_state.borrow_mut() = ColorEase::new(
            config.cursor_blink_rate,
            config.cursor_blink_ease_in,
            config.cursor_blink_rate,
            config.cursor_blink_ease_out,
            None,
        );
        *self.blink_state.borrow_mut() = ColorEase::new(
            config.text_blink_rate,
            config.text_blink_ease_in,
            config.text_blink_rate,
            config.text_blink_ease_out,
            None,
        );
        *self.rapid_blink_state.borrow_mut() = ColorEase::new(
            config.text_blink_rate_rapid,
            config.text_blink_rapid_ease_in,
            config.text_blink_rate_rapid,
            config.text_blink_rapid_ease_out,
            None,
        );

        self.show_scroll_bar = config.enable_scroll_bar;
        self.shape_generation += 1;
        {
            let mut shape_cache = self.shape_cache.borrow_mut();
            shape_cache.update_config(&config);
            shape_cache.clear();
        }
        self.line_state_cache.borrow_mut().update_config(&config);
        self.line_quad_cache.borrow_mut().update_config(&config);
        self.line_to_ele_shape_cache
            .borrow_mut()
            .update_config(&config);
        self.fancy_tab_bar.take();
        self.invalidate_fancy_tab_bar();
        self.invalidate_modal();
        self.input_map = InputMap::new(&config);
        self.leader_is_down = None;
        self.render_state.as_mut().map(|rs| rs.config_changed());
        let dimensions = self.dimensions;

        if let Err(err) = self.fonts.config_changed(&config) {
            log::error!("Failed to load font configuration: {:#}", err);
        }

        if let Some(window) = mux.get_window(self.mux_window_id) {
            let term_config: Arc<dyn TerminalConfiguration> =
                Arc::new(TermConfig::with_config(config.clone()));
            for tab in window.iter() {
                for pane in tab.iter_panes_ignoring_zoom() {
                    pane.pane.set_config(Arc::clone(&term_config));
                }
            }
            for state in self.pane_state.borrow().values() {
                if let Some(overlay) = &state.overlay {
                    overlay.pane.set_config(Arc::clone(&term_config));
                }
            }
            for state in self.tab_state.borrow().values() {
                if let Some(overlay) = &state.overlay {
                    overlay.pane.set_config(Arc::clone(&term_config));
                }
            }
        }

        if let Some(window) = self.window.as_ref().map(|w| w.clone()) {
            self.load_os_parameters();
            self.apply_scale_change(&dimensions, self.fonts.get_font_scale());
            self.apply_dimensions(&dimensions, None, &window);
            window.config_did_change(&config);
            window.invalidate();
        }

        // Do this after we've potentially adjusted scaling based on config/padding
        // and window size
        self.window_background = reload_background_image(
            &config,
            &self.window_background,
            &self.dimensions,
            &self.render_metrics,
        );

        self.invalidate_modal();
        self.emit_window_event("window-config-reloaded", None);
    }

    fn invalidate_modal(&mut self) {
        if let Some(modal) = self.get_modal() {
            modal.reconfigure(self);
            if let Some(window) = self.window.as_ref() {
                window.invalidate();
            }
        }
    }

    /// WezTerminator (patch 0039 + 0043): after changing a pane's
    /// per-pane font (size scale and/or family), invalidate the render
    /// caches that bake in cell geometry, re-apply the active tab's size
    /// (so the mux reflows every pane's PTY to its override cell grid
    /// via `scale_size` in mux/src/tab.rs), and request a repaint.
    ///
    /// Patch 0043: the line/shape caches ARE cleared here. For a pure
    /// SIZE change the geometry-derived keys already differ (patch
    /// 0039), but a same-SIZE FAMILY change does not move those keys, so
    /// without an explicit clear the old font's shaped glyphs would
    /// linger. Clearing on every apply is cheap and keeps both paths
    /// correct. The `pane_font_cache` is NOT cleared: it is keyed by
    /// (family, size), so new overrides add fresh entries and old ones
    /// stay valid.
    ///
    /// Crucially, BEFORE reflowing we recompute each pane's FAMILY aspect
    /// ratio from its current (scale, family) using the GUI's font metrics
    /// (`fonts_and_metrics_for_pane_font`). This is the SOLE writer of
    /// `family_ratio` — the render path no longer pushes it (that made it
    /// a second writer racing this one, which regressed the size path).
    /// The mux cannot compute a family's cell aspect (it has no font
    /// metrics), so the GUI does it here, on the thread that owns
    /// `wezterm-font`. A window-font pane is forced to (1.0, 1.0) so its
    /// reflow reduces EXACTLY to the proven patch-0039 size path; only a
    /// real family override yields a non-(1,1) ratio.
    fn apply_pane_font_scale_change(&mut self) {
        self.pane_geometry_dirty.set(true);
        // Mirror the cache invalidation done on a config reload / atlas
        // recreate (see render/paint.rs and recreate_texture_atlas).
        self.shape_generation += 1;
        self.quad_generation += 1;
        self.line_to_ele_shape_cache.borrow_mut().clear();
        self.line_quad_cache.borrow_mut().clear();

        let mux = Mux::get();
        if let Some(tab) = mux.get_active_tab_for_window(self.mux_window_id) {
            // WezTerminator (patch 0043): refresh each pane's FAMILY aspect
            // ratio (relative to the size-scaled window cell) before the
            // reflow. Window-font panes are forced to (1.0, 1.0) rather
            // than computed, so rounding can never perturb the size-only
            // reflow — `tab::scale_size(size, scale*1, scale*1)` is then
            // byte-identical to patch 0039.
            let base_w = self.render_metrics.cell_size.width as f64;
            let base_h = self.render_metrics.cell_size.height as f64;
            for pos in tab.iter_panes() {
                let scale = pos.pane.get_font_scale();
                let family = pos.pane.get_font_family();
                let bold = pos.pane.get_font_bold();
                let italic = pos.pane.get_font_italic();
                // A family OR a bold/italic style can change the cell
                // aspect; a pure size change (or no override) does not.
                let styled = family.is_some() || bold || italic;
                let (rw, rh) = if styled && base_w > 0.0 && base_h > 0.0 && scale > 0.0 {
                    let (_fonts, metrics) = self.fonts_and_metrics_for_pane_font(
                        scale,
                        family.as_deref(),
                        bold,
                        italic,
                    );
                    // `metrics.cell ÷ base_cell` is the styled cell at THIS
                    // size scale; dividing by `scale` factors the size back
                    // out, leaving only the style aspect relative to the
                    // size-scaled window cell.
                    let w = (metrics.cell_size.width as f64 / base_w) / scale;
                    let h = (metrics.cell_size.height as f64 / base_h) / scale;
                    (w, h)
                } else {
                    (1.0, 1.0)
                };
                pos.pane.set_family_ratio(rw, rh);
            }
            // Re-distribute the tab size to the panes. `Tab::resize` walks
            // the split tree and calls
            // `pane.resize(scale_size(size, scale*rw, scale*rh))` on each
            // leaf, so this is what makes the override pane's PTY actually
            // change its row/col count.
            tab.resize(tab.get_size());
        }

        // WezTerminator (patch 0087): re-sync the tab to the live window
        // pixel size. A move-to-new-window maximize or a font change can
        // leave the mux grid at the previous cell count, so the name bar
        // and content occupy only a corner of the pane.
        if let Some(window) = self.window.clone() {
            let dims = self.dimensions;
            self.apply_dimensions(&dims, None, &window);
        }

        if let Some(window) = self.window.as_ref() {
            window.invalidate();
        }
    }

    /// WezTerminator (patch 0043): self-healing per-pane font geometry.
    /// For each pane in the active tab, recompute its FAMILY aspect ratio
    /// from the GUI's font metrics (the mux has none) and, if the pane's
    /// PTY column count no longer matches what its current font wants in
    /// its pixel rectangle, reflow the tab. This is the safety net for
    /// the paths that reflow the mux WITHOUT calling
    /// `apply_pane_font_scale_change` — session restore, split creation,
    /// window resize — which otherwise leave a pane's grid stale so its
    /// content overflows into the neighbour. Called once per paint pass:
    /// the per-pane metrics are cached (cheap), it only reflows on an
    /// actual mismatch, and the target column count below uses the EXACT
    /// same identity-shortcut + floor as `mux::tab::scale_size`, so a
    /// correctly-reflowed pane matches and it converges in one frame
    /// (no oscillation). Only columns are checked (the overflow is
    /// horizontal); the reflow it triggers fixes rows too.
    fn ensure_pane_geometry(&mut self) {
        // Patch 0137: skip the walk unless something changed. A stale
        // pane below calls `tab.resize`, which emits `TabResized` and
        // re-arms the flag, so a real mismatch is re-checked next paint.
        if !self.pane_geometry_dirty.get() {
            return;
        }
        self.pane_geometry_dirty.set(false);
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(t) => t,
            None => return,
        };
        let base_w = self.render_metrics.cell_size.width as f64;
        let base_h = self.render_metrics.cell_size.height as f64;
        if !(base_w > 0.0 && base_h > 0.0) {
            return;
        }
        let mut stale = false;
        for pos in tab.iter_panes() {
            let scale = pos.pane.get_font_scale();
            let s = if scale > 0.0 { scale } else { 1.0 };
            let family = pos.pane.get_font_family();
            let bold = pos.pane.get_font_bold();
            let italic = pos.pane.get_font_italic();
            let styled = family.is_some() || bold || italic;
            // The pane's cell size (pixels) for its current font, and the
            // style aspect ratio relative to the size-scaled window cell.
            let (cell_w, cell_h, rw, rh) = if styled {
                let (_f, m) =
                    self.fonts_and_metrics_for_pane_font(s, family.as_deref(), bold, italic);
                let cw = m.cell_size.width as f64;
                let ch = m.cell_size.height as f64;
                (cw, ch, (cw / base_w) / s, (ch / base_h) / s)
            } else {
                (base_w * s, base_h * s, 1.0, 1.0)
            };
            pos.pane.set_family_ratio(rw, rh);

            // Target column/row count for this pane's pixel rectangle
            // (`pos.width`/`pos.height` are in BASE cells). Rows subtract
            // the reserved header line, matching `reserve_pane_header_row`
            // + `scale_size`.
            let wf = cell_w / base_w;
            let hf = cell_h / base_h;
            let target_cols = if (wf - 1.0).abs() < 0.0001 {
                pos.width
            } else {
                ((pos.width as f64 / wf).floor() as usize).max(1)
            };
            let content_rows = if pos.height <= 1 {
                pos.height
            } else {
                pos.height - 1
            };
            let target_rows = if (hf - 1.0).abs() < 0.0001 {
                content_rows
            } else {
                ((content_rows as f64 / hf).floor() as usize).max(1)
            };
            let dims = pos.pane.get_dimensions();
            if dims.cols != target_cols || dims.viewport_rows != target_rows {
                stale = true;
            }
        }

        let tab_size = tab.get_size();
        let tab_tracks_window =
            tab_size.rows == self.terminal_size.rows && tab_size.cols == self.terminal_size.cols;
        // Patch 0194: Beth Studio sizes a pane to its column. That pane is
        // its own host tab (not a split in this window), so the tab grid
        // and the window grid diverge. Snapping it back here is what
        // breaks the text in the Studio column. Only push the window size
        // when this window's grid changed, or when the tab already tracks
        // the window and a per-pane font is stale.
        let window_changed = self.geometry_window_cols.get() != self.terminal_size.cols
            || self.geometry_window_rows.get() != self.terminal_size.rows;
        self.geometry_window_cols.set(self.terminal_size.cols);
        self.geometry_window_rows.set(self.terminal_size.rows);

        if (window_changed && !tab_tracks_window) || (tab_tracks_window && stale) {
            // Mirror apply_pane_font_scale_change's cache invalidation so
            // re-wrapped lines re-shape at the corrected grid.
            self.shape_generation += 1;
            self.quad_generation += 1;
            self.line_to_ele_shape_cache.borrow_mut().clear();
            self.line_quad_cache.borrow_mut().clear();
            tab.resize(self.terminal_size);
        }
    }

    pub fn cancel_modal(&self) {
        self.modal.borrow_mut().take();
        if let Some(window) = self.window.as_ref() {
            window.invalidate();
        }
    }

    pub fn set_modal(&self, modal: Rc<dyn Modal>) {
        self.modal.borrow_mut().replace(modal);
        if let Some(window) = self.window.as_ref() {
            window.invalidate();
        }
    }

    fn get_modal(&self) -> Option<Rc<dyn Modal>> {
        self.modal.borrow().as_ref().map(|m| Rc::clone(&m))
    }

    fn update_scrollbar(&mut self) {
        if !self.show_scroll_bar {
            return;
        }

        let tab = match self.get_active_pane_or_overlay() {
            Some(tab) => tab,
            None => return,
        };

        let render_dims = tab.get_dimensions();
        if render_dims == self.last_scroll_info {
            return;
        }

        self.last_scroll_info = render_dims;

        if let Some(window) = self.window.as_ref() {
            window.invalidate();
        }
    }

    /// Called by various bits of code to update the title bar.
    /// Let's also trigger the status event so that it can choose
    /// to update the right-status.
    fn update_title(&mut self) {
        self.schedule_status_update();
        self.update_title_impl();
    }

    fn window_contains_pane(&mut self, pane_id: PaneId) -> bool {
        let mux = Mux::get();

        let (_domain, window_id, _tab_id) = match mux.resolve_pane_id(pane_id) {
            Some(tuple) => tuple,
            None => return false,
        };

        return window_id == self.mux_window_id;
    }

    fn emit_user_var_event(&mut self, pane_id: PaneId, name: String, value: String) {
        if !self.window_contains_pane(pane_id) {
            return;
        }

        let mux = Mux::get();
        let window = GuiWin::new(self);
        let pane = match mux.get_pane(pane_id) {
            Some(pane) => mux_lua::MuxPane(pane.pane_id()),
            None => return,
        };

        async fn do_event(
            lua: Option<Rc<mlua::Lua>>,
            name: String,
            value: String,
            window: GuiWin,
            pane: MuxPane,
        ) -> anyhow::Result<()> {
            if let Some(lua) = lua {
                let args = lua.pack_multi((window.clone(), pane, name, value))?;
                if let Err(err) =
                    config::lua::emit_event(&lua, ("user-var-changed".to_string(), args)).await
                {
                    log::error!("while processing user-var-changed event: {:#}", err);
                }
            }

            window
                .window
                .notify(TermWindowNotif::Apply(Box::new(move |term_window| {
                    term_window.update_title();
                })));

            Ok(())
        }

        promise::spawn::spawn(config::with_lua_config_on_main_thread(move |lua| {
            do_event(lua, name, value, window, pane)
        }))
        .detach();
    }

    /// Called by window:set_right_status after the status has
    /// been updated; let's update the bar
    pub fn update_title_post_status(&mut self) {
        self.update_title_impl();
    }

    fn update_title_impl(&mut self) {
        let mux = Mux::get();
        let window = match mux.get_window(self.mux_window_id) {
            Some(window) => window,
            _ => return,
        };
        let tabs = self.get_tab_information();
        let panes = self.get_pane_information();
        let active_tab = tabs.iter().find(|t| t.is_active).cloned();
        let active_pane = panes.iter().find(|p| p.is_active).cloned();

        let border = self.get_os_border();
        let tab_bar_height = self.tab_bar_pixel_height().unwrap_or(0.);
        let tab_bar_y = if self.config.tab_bar_at_bottom {
            ((self.dimensions.pixel_height as f32) - (tab_bar_height + border.bottom.get() as f32))
                .max(0.)
        } else {
            border.top.get() as f32
        };

        let tab_bar_height = self.tab_bar_pixel_height().unwrap_or(0.);

        let hovering_in_tab_bar = match &self.current_mouse_event {
            Some(event) => {
                let mouse_y = event.coords.y as f32;
                mouse_y >= tab_bar_y as f32 && mouse_y < tab_bar_y as f32 + tab_bar_height
            }
            None => false,
        };

        let hide_tabs = crate::tabbar::is_wtinator_active()
            && wtinator::dashboard::is_open(self.mux_window_id);
        let dash_title;
        let bar_left = if hide_tabs {
            dash_title = wtinator::dashboard::selected_pane(self.mux_window_id)
                .and_then(|id| {
                    panes
                        .iter()
                        .find(|p| p.pane_id == id)
                        .map(|p| p.title.clone())
                })
                .or_else(|| active_pane.as_ref().map(|p| p.title.clone()))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Painel".to_string());
            dash_title.as_str()
        } else {
            &self.left_status
        };
        let new_tab_bar = TabBarState::new(
            self.dimensions.pixel_width / self.render_metrics.cell_size.width as usize,
            if hovering_in_tab_bar {
                Some(self.last_mouse_coords.0)
            } else {
                None
            },
            &tabs,
            &panes,
            self.config.resolved_palette.tab_bar.as_ref(),
            &self.config,
            bar_left,
            &self.right_status,
            hide_tabs,
        );
        if new_tab_bar != self.tab_bar {
            self.tab_bar = new_tab_bar;
            self.invalidate_fancy_tab_bar();
            self.invalidate_modal();
            if let Some(window) = self.window.as_ref() {
                window.invalidate();
            }
        }

        let num_tabs = window.len();
        if num_tabs == 0 {
            return;
        }
        drop(window);

        let title = match config::run_immediate_with_lua_config(|lua| {
            if let Some(lua) = lua {
                let tabs = lua.create_sequence_from(tabs.clone().into_iter())?;
                let panes = lua.create_sequence_from(panes.clone().into_iter())?;

                let v = config::lua::emit_sync_callback(
                    &*lua,
                    (
                        "format-window-title".to_string(),
                        (
                            active_tab.clone(),
                            active_pane.clone(),
                            tabs,
                            panes,
                            (*self.config).clone(),
                        ),
                    ),
                )?;
                match &v {
                    mlua::Value::Nil => Ok(None),
                    _ => Ok(Some(String::from_lua(v, &*lua)?)),
                }
            } else {
                Ok(None)
            }
        }) {
            Ok(s) => s,
            Err(err) => {
                log::warn!("format-window-title: {}", err);
                None
            }
        };

        let title = match title {
            Some(title) => title,
            None => {
                if let (Some(pos), Some(tab)) = (active_pane, active_tab) {
                    if num_tabs == 1 {
                        format!("{}{}", if pos.is_zoomed { "[Z] " } else { "" }, pos.title)
                    } else {
                        format!(
                            "{}[{}/{}] {}",
                            if pos.is_zoomed { "[Z] " } else { "" },
                            tab.tab_index + 1,
                            num_tabs,
                            pos.title
                        )
                    }
                } else {
                    "".to_string()
                }
            }
        };

        // WezTerminator: a user-chosen window name wins over the auto/OSC
        // title so each physical window stays identifiable in the taskbar,
        // Alt+Tab, and the "Move tab to" destination list.
        let title = {
            let mux = Mux::get();
            match mux
                .get_window(self.mux_window_id)
                .and_then(|window| window.get_user_title())
            {
                Some(user) if !user.is_empty() => user,
                _ => title,
            }
        };

        if let Some(window) = self.window.as_ref() {
            window.set_title(&title);

            let show_tab_bar = if num_tabs == 1 {
                self.config.enable_tab_bar && !self.config.hide_tab_bar_if_only_one_tab
            } else {
                self.config.enable_tab_bar
            };

            // If the number of tabs changed and caused the tab bar to
            // hide/show, then we'll need to resize things.  It is simplest
            // to piggy back on the config reloading code for that, so that
            // is what we're doing.
            if show_tab_bar != self.show_tab_bar {
                self.config_was_reloaded();
            }
        }
        self.publish_agent_wait(&tabs, &panes);
        self.schedule_next_status_update();
    }

    /// WezTerminator (patch 0152): the same "agent is waiting" signal the
    /// tab dot uses, on this window's taskbar icon and the tray icon.
    fn publish_agent_wait(&self, tabs: &[TabInformation], panes: &[PaneInformation]) {
        let waiting = tabs.iter().any(|tab| tab.needs_attention)
            || panes.iter().any(|pane| {
                pane.user_vars
                    .iter()
                    .any(|(name, value)| wtinator::agent_wait::user_var_is_waiting(name, value))
            });
        let Some(window) = self.window.as_ref() else {
            return;
        };
        let hwnd = window.hwnd() as isize;
        let was = wtinator::agent_wait::hwnd_is_waiting(hwnd);
        let any_changed = wtinator::agent_wait::set_hwnd(hwnd, waiting);
        if was != waiting {
            wtinator::taskbar_icon::set_waiting(hwnd, waiting);
        }
        if any_changed {
            wtinator::tray::refresh_attention();
        }
    }

    fn schedule_next_status_update(&mut self) {
        if let Some(window) = self.window.as_ref() {
            let now = Instant::now();
            if self.last_status_call <= now {
                let interval = Duration::from_millis(self.config.status_update_interval);
                let target = now + interval;
                self.last_status_call = target;

                let window = window.clone();
                promise::spawn::spawn(async move {
                    Timer::at(target).await;
                    window.notify(TermWindowNotif::EmitStatusUpdate);
                })
                .detach();
            }
        }
    }

    fn update_text_cursor(&mut self, pos: &PositionedPane) {
        if let Some(win) = self.window.as_ref() {
            let cursor = pos.pane.get_cursor_position();
            let top = pos.pane.get_dimensions().physical_top;
            let tab_bar_height = if self.show_tab_bar && !self.config.tab_bar_at_bottom {
                self.tab_bar_pixel_height().unwrap()
            } else {
                0.0
            };
            let (padding_left, padding_top) = self.padding_left_top();

            let r = Rect::new(
                Point::new(
                    (((cursor.x + pos.left) as isize).max(0) * self.render_metrics.cell_size.width)
                        .add(padding_left as isize),
                    ((cursor.y + pos.top as isize - top).max(0)
                        * self.render_metrics.cell_size.height)
                        .add(tab_bar_height as isize)
                        .add(padding_top as isize),
                ),
                self.render_metrics.cell_size,
            );
            win.set_text_cursor_position(r);
        }
    }

    fn activate_window(&mut self, window_idx: usize) -> anyhow::Result<()> {
        let windows = front_end().gui_windows();
        if let Some(win) = windows.get(window_idx) {
            win.window.focus();
        }
        Ok(())
    }

    fn activate_window_relative(&mut self, delta: isize, wrap: bool) -> anyhow::Result<()> {
        let windows = front_end().gui_windows();
        let my_idx = windows
            .iter()
            .position(|w| Some(&w.window) == self.window.as_ref())
            .ok_or_else(|| anyhow!("I'm not in the window list!?"))?;

        let idx = my_idx as isize + delta;

        let idx = if wrap {
            let idx = if idx < 0 {
                windows.len() as isize + idx
            } else {
                idx
            };
            idx as usize % windows.len()
        } else {
            if idx < 0 {
                0
            } else if idx >= windows.len() as isize {
                windows.len().saturating_sub(1)
            } else {
                idx as usize
            }
        };

        if let Some(win) = windows.get(idx) {
            win.window.focus();
        }

        Ok(())
    }

    fn activate_tab(&mut self, tab_idx: isize) -> anyhow::Result<()> {
        let mux = Mux::get();
        let mut window = mux
            .get_window_mut(self.mux_window_id)
            .ok_or_else(|| anyhow!("no such window"))?;

        // This logic is coupled with the CliSubCommand::ActivateTab
        // logic in wezterm/src/main.rs. If you update this, update that!
        let max = window.len();

        let tab_idx = if tab_idx < 0 {
            max.saturating_sub(tab_idx.abs() as usize)
        } else {
            tab_idx as usize
        };

        if tab_idx < max {
            window.save_and_then_set_active(tab_idx);

            drop(window);

            // The tab the person just selected in this window fills it.
            // A Beth Studio column that is not the selected tab keeps the
            // size Studio set (patch 0194).
            let size = self.terminal_size;
            if let Some(tab) = mux.get_active_tab_for_window(self.mux_window_id) {
                let cur = tab.get_size();
                if cur.cols != size.cols || cur.rows != size.rows {
                    tab.resize(size);
                }
            }

            if let Some(tab) = self.get_active_pane_or_overlay() {
                tab.focus_changed(true);
            }

            self.update_title();
            self.update_scrollbar();
        }
        Ok(())
    }

    fn activate_tab_relative(&mut self, delta: isize, wrap: bool) -> anyhow::Result<()> {
        let mux = Mux::get();
        let window = mux
            .get_window(self.mux_window_id)
            .ok_or_else(|| anyhow!("no such window"))?;

        let max = window.len();
        ensure!(max > 0, "no more tabs");

        // This logic is coupled with the CliSubCommand::ActivateTab
        // logic in wezterm/src/main.rs. If you update this, update that!
        let active = window.get_active_idx() as isize;
        let tab = active + delta;
        let tab = if wrap {
            let tab = if tab < 0 { max as isize + tab } else { tab };
            (tab as usize % max) as isize
        } else {
            if tab < 0 {
                0
            } else if tab >= max as isize {
                max as isize - 1
            } else {
                tab
            }
        };
        drop(window);
        self.activate_tab(tab)
    }

    fn activate_last_tab(&mut self) -> anyhow::Result<()> {
        let mux = Mux::get();
        let window = mux
            .get_window(self.mux_window_id)
            .ok_or_else(|| anyhow!("no such window"))?;

        let last_idx = window.get_last_active_idx();
        drop(window);
        match last_idx {
            Some(idx) => self.activate_tab(idx as isize),
            None => Ok(()),
        }
    }

    fn move_tab(&mut self, tab_idx: usize) -> anyhow::Result<()> {
        let mux = Mux::get();
        let mut window = mux
            .get_window_mut(self.mux_window_id)
            .ok_or_else(|| anyhow!("no such window"))?;

        let max = window.len();
        ensure!(max > 0, "no more tabs");

        let active = window.get_active_idx();

        ensure!(tab_idx < max, "cannot move a tab out of range");

        let tab_inst = window.remove_by_idx(active);
        window.insert(tab_idx, &tab_inst);
        window.set_active_without_saving(tab_idx);

        drop(window);
        self.update_title();
        self.update_scrollbar();

        Ok(())
    }

    // WezTerminator patch 0035: move a tab from one index to another
    // (used by drag-and-drop tab reordering in the tab bar).
    fn move_tab_from_to(&mut self, from: usize, to: usize) -> anyhow::Result<()> {
        let mux = Mux::get();
        let mut window = mux
            .get_window_mut(self.mux_window_id)
            .ok_or_else(|| anyhow!("no such window"))?;
        let max = window.len();
        anyhow::ensure!(max > 0, "no more tabs");
        anyhow::ensure!(from < max && to < max, "tab index out of range");
        if from == to {
            return Ok(());
        }
        let tab_inst = window.remove_by_idx(from);
        window.insert(to, &tab_inst);
        window.set_active_without_saving(to);
        drop(window);
        self.update_title();
        self.update_scrollbar();
        Ok(())
    }

    fn show_input_selector(&mut self, args: &config::keyassignment::InputSelector) {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return,
        };

        // Ignore any current overlay: we're going to cancel it out below
        // and we don't want this new one to reference that cancelled pane
        let pane = match self.get_active_pane_no_overlay() {
            Some(pane) => pane,
            None => return,
        };

        let args = args.clone();

        let gui_win = GuiWin::new(self);
        let pane = MuxPane(pane.pane_id());

        let (overlay, future) = start_overlay(self, &tab, move |_tab_id, term| {
            crate::overlay::selector::selector(term, args, gui_win, pane)
        });
        self.assign_overlay(tab.tab_id(), overlay);
        promise::spawn::spawn(future).detach();
    }

    fn show_prompt_input_line(&mut self, args: &PromptInputLine) {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return,
        };

        let pane = match self.get_active_pane_or_overlay() {
            Some(pane) => pane,
            None => return,
        };

        let args = args.clone();

        let gui_win = GuiWin::new(self);
        let pane = MuxPane(pane.pane_id());

        let (overlay, future) = start_overlay(self, &tab, move |_tab_id, term| {
            crate::overlay::prompt::show_line_prompt_overlay(term, args, gui_win, pane)
        });
        self.assign_overlay(tab.tab_id(), overlay);
        promise::spawn::spawn(future).detach();
    }

    fn show_confirmation(&mut self, args: &Confirmation) {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return,
        };

        let pane = match self.get_active_pane_or_overlay() {
            Some(pane) => pane,
            None => return,
        };

        let args = args.clone();

        let gui_win = GuiWin::new(self);
        let pane = MuxPane(pane.pane_id());

        let (overlay, future) = start_overlay(self, &tab, move |_tab_id, term| {
            crate::overlay::confirm::show_confirmation_overlay(term, args, gui_win, pane)
        });
        self.assign_overlay(tab.tab_id(), overlay);
        promise::spawn::spawn(future).detach();
    }

    fn show_debug_overlay(&mut self) {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return,
        };

        let gui_win = GuiWin::new(self);

        let opengl_info = self.opengl_info.as_deref().unwrap_or("Unknown").to_string();
        let connection_info = self.connection_name.clone();

        let (overlay, future) = start_overlay(self, &tab, move |_tab_id, term| {
            crate::overlay::show_debug_overlay(term, gui_win, opengl_info, connection_info)
        });
        self.assign_overlay(tab.tab_id(), overlay);
        promise::spawn::spawn(future).detach();
    }

    fn show_tab_navigator(&mut self) {
        let mux = Mux::get();
        let active_tab_idx = match mux.get_window(self.mux_window_id) {
            Some(mux_window) => mux_window.get_active_idx(),
            None => return,
        };
        let title = "Tab Navigator".to_string();
        let args = LauncherActionArgs {
            title: Some(title),
            flags: LauncherFlags::TABS,
            help_text: None,
            fuzzy_help_text: None,
            alphabet: None,
        };
        self.show_launcher_impl(args, active_tab_idx);
    }

    fn show_launcher(&mut self) {
        let title = "Launcher".to_string();
        let args = LauncherActionArgs {
            title: Some(title),
            flags: LauncherFlags::LAUNCH_MENU_ITEMS
                | LauncherFlags::WORKSPACES
                | LauncherFlags::DOMAINS
                | LauncherFlags::KEY_ASSIGNMENTS
                | LauncherFlags::COMMANDS,
            help_text: None,
            fuzzy_help_text: None,
            alphabet: None,
        };
        self.show_launcher_impl(args, 0);
    }

    fn show_launcher_impl(&mut self, args: LauncherActionArgs, initial_choice_idx: usize) {
        let mux_window_id = self.mux_window_id;
        let window = self.window.as_ref().unwrap().clone();

        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return,
        };

        let pane = match self.get_active_pane_or_overlay() {
            Some(pane) => pane,
            None => return,
        };

        let domain_id_of_current_pane = tab
            .get_active_pane()
            .expect("tab has no panes!")
            .domain_id();
        let pane_id = pane.pane_id();
        let tab_id = tab.tab_id();
        let title = args.title.unwrap();
        let flags = args.flags;
        let help_text = args.help_text.unwrap_or(
            "Select an item and press Enter=launch  \
             Esc=cancel  /=filter"
                .to_string(),
        );
        let fuzzy_help_text = args
            .fuzzy_help_text
            .unwrap_or("Fuzzy matching: ".to_string());

        let config = &self.config;
        let alphabet = args.alphabet.unwrap_or(config.launcher_alphabet.clone());

        promise::spawn::spawn(async move {
            let args = LauncherArgs::new(
                &title,
                flags,
                mux_window_id,
                pane_id,
                domain_id_of_current_pane,
                &help_text,
                &fuzzy_help_text,
                &alphabet,
            )
            .await;

            let win = window.clone();
            win.notify(TermWindowNotif::Apply(Box::new(move |term_window| {
                let mux = Mux::get();
                if let Some(tab) = mux.get_tab(tab_id) {
                    let window = window.clone();
                    let (overlay, future) =
                        start_overlay(term_window, &tab, move |_tab_id, term| {
                            launcher(args, term, window, initial_choice_idx)
                        });

                    term_window.assign_overlay(tab_id, overlay);
                    promise::spawn::spawn(future).detach();
                }
            })));
        })
        .detach();
    }

    /// Returns the Prompt semantic zones
    fn get_semantic_prompt_zones(&mut self, pane: &Arc<dyn Pane>) -> &[StableRowIndex] {
        let cache = self
            .semantic_zones
            .entry(pane.pane_id())
            .or_insert_with(SemanticZoneCache::default);

        let seqno = pane.get_current_seqno();
        if cache.seqno != seqno {
            let zones = pane.get_semantic_zones().unwrap_or_else(|_| vec![]);
            let mut zones: Vec<StableRowIndex> = zones
                .into_iter()
                .filter_map(|zone| {
                    if zone.semantic_type == wezterm_term::SemanticType::Prompt {
                        Some(zone.start_y)
                    } else {
                        None
                    }
                })
                .collect();
            // dedup to avoid issues where both left and right prompts are
            // defined: we only care if there were 1+ prompts on a line,
            // not about how many prompts are on a line.
            // <https://github.com/wezterm/wezterm/issues/1121>
            zones.dedup();
            cache.zones = zones;
            cache.seqno = seqno;
        }
        &cache.zones
    }

    fn scroll_to_prompt(&mut self, amount: isize, pane: &Arc<dyn Pane>) -> anyhow::Result<()> {
        let dims = pane.get_dimensions();
        let position = self
            .get_viewport(pane.pane_id())
            .unwrap_or(dims.physical_top);
        let zone = {
            let zones = self.get_semantic_prompt_zones(&pane);
            let idx = match zones.binary_search(&position) {
                Ok(idx) | Err(idx) => idx,
            };
            let idx = ((idx as isize) + amount).max(0) as usize;
            zones.get(idx).cloned()
        };
        if let Some(zone) = zone {
            self.set_viewport(pane.pane_id(), Some(zone), dims);
        }

        if let Some(win) = self.window.as_ref() {
            win.invalidate();
        }
        Ok(())
    }

    fn scroll_by_page(&mut self, amount: f64, pane: &Arc<dyn Pane>) -> anyhow::Result<()> {
        let dims = pane.get_dimensions();
        let position = self
            .get_viewport(pane.pane_id())
            .unwrap_or(dims.physical_top) as f64
            + (amount * dims.viewport_rows as f64);
        self.set_viewport(pane.pane_id(), Some(position as isize), dims);
        if let Some(win) = self.window.as_ref() {
            win.invalidate();
        }
        Ok(())
    }

    fn scroll_by_current_event_wheel_delta(&mut self, pane: &Arc<dyn Pane>) -> anyhow::Result<()> {
        if let Some(event) = &self.current_mouse_event {
            let amount = match event.kind {
                MouseEventKind::VertWheel(amount) => -amount,
                _ => return Ok(()),
            };
            self.scroll_by_line(amount.into(), pane)?;
        }
        Ok(())
    }

    fn scroll_by_line(&mut self, amount: isize, pane: &Arc<dyn Pane>) -> anyhow::Result<()> {
        let dims = pane.get_dimensions();
        let position = self
            .get_viewport(pane.pane_id())
            .unwrap_or(dims.physical_top)
            .saturating_add(amount);
        self.set_viewport(pane.pane_id(), Some(position), dims);
        if let Some(win) = self.window.as_ref() {
            win.invalidate();
        }
        Ok(())
    }

    fn move_tab_relative(&mut self, delta: isize) -> anyhow::Result<()> {
        let mux = Mux::get();
        let window = mux
            .get_window(self.mux_window_id)
            .ok_or_else(|| anyhow!("no such window"))?;

        let max = window.len();
        ensure!(max > 0, "no more tabs");

        let active = window.get_active_idx();
        let tab = active as isize + delta;
        let tab = if tab < 0 {
            0usize
        } else if tab >= max as isize {
            max - 1
        } else {
            tab as usize
        };

        drop(window);
        self.move_tab(tab)
    }

    pub fn perform_key_assignment(
        &mut self,
        pane: &Arc<dyn Pane>,
        assignment: &KeyAssignment,
    ) -> anyhow::Result<PerformAssignmentResult> {
        use KeyAssignment::*;

        if let Some(modal) = self.get_modal() {
            if modal.perform_assignment(assignment, self) {
                return Ok(PerformAssignmentResult::Handled);
            }
        }

        match pane.perform_assignment(assignment) {
            PerformAssignmentResult::Unhandled => {}
            result => return Ok(result),
        }

        let window = self.window.as_ref().map(|w| w.clone());

        match assignment {
            ActivateKeyTable {
                name,
                timeout_milliseconds,
                replace_current,
                one_shot,
                until_unknown,
                prevent_fallback,
            } => {
                anyhow::ensure!(
                    self.input_map.has_table(name),
                    "ActivateKeyTable: no key_table named {}",
                    name
                );
                self.key_table_state.activate(KeyTableArgs {
                    name,
                    timeout_milliseconds: *timeout_milliseconds,
                    replace_current: *replace_current,
                    one_shot: *one_shot,
                    until_unknown: *until_unknown,
                    prevent_fallback: *prevent_fallback,
                });
                self.update_title();
            }
            PopKeyTable => {
                self.key_table_state.pop();
                self.update_title();
            }
            ClearKeyTableStack => {
                self.key_table_state.clear_stack();
                self.update_title();
            }
            Multiple(actions) => {
                for a in actions {
                    self.perform_key_assignment(pane, a)?;
                }
            }
            SpawnTab(spawn_where) => {
                self.spawn_tab(spawn_where);
            }
            SpawnWindow => {
                self.spawn_command(&SpawnCommand::default(), SpawnWhere::NewWindow);
            }
            SpawnCommandInNewTab(spawn) => {
                self.spawn_command(spawn, SpawnWhere::NewTab);
            }
            SpawnCommandInNewWindow(spawn) => {
                self.spawn_command(spawn, SpawnWhere::NewWindow);
            }
            SplitHorizontal(spawn) => {
                log::trace!("SplitHorizontal {:?}", spawn);
                self.spawn_command(
                    spawn,
                    SpawnWhere::SplitPane(SplitRequest {
                        direction: SplitDirection::Horizontal,
                        target_is_second: true,
                        size: MuxSplitSize::Percent(50),
                        top_level: false,
                    }),
                );
                // WezTerminator (patch 0065): in list mode, leave zoom so the
                // new pane shows side by side (staying zoomed looked like a new
                // tab instead of a split).
                if let Some(tab) = Mux::get().get_active_tab_for_window(self.mux_window_id) {
                    if tab.list_mode() {
                        tab.set_zoomed(false);
                    }
                }
            }
            SplitVertical(spawn) => {
                log::trace!("SplitVertical {:?}", spawn);
                self.spawn_command(
                    spawn,
                    SpawnWhere::SplitPane(SplitRequest {
                        direction: SplitDirection::Vertical,
                        target_is_second: true,
                        size: MuxSplitSize::Percent(50),
                        top_level: false,
                    }),
                );
                // WezTerminator (patch 0065): in list mode, leave zoom so the
                // new pane shows side by side instead of staying 1-up.
                if let Some(tab) = Mux::get().get_active_tab_for_window(self.mux_window_id) {
                    if tab.list_mode() {
                        tab.set_zoomed(false);
                    }
                }
            }
            ToggleFullScreen => {
                self.window.as_ref().unwrap().toggle_fullscreen();
            }
            ToggleAlwaysOnTop => {
                let window = self.window.clone().unwrap();
                let current_level = self.window_state.as_window_level();

                match current_level {
                    WindowLevel::AlwaysOnTop => {
                        window.set_window_level(WindowLevel::Normal);
                    }
                    WindowLevel::AlwaysOnBottom | WindowLevel::Normal => {
                        window.set_window_level(WindowLevel::AlwaysOnTop);
                    }
                }
            }
            ToggleAlwaysOnBottom => {
                let window = self.window.clone().unwrap();
                let current_level = self.window_state.as_window_level();

                match current_level {
                    WindowLevel::AlwaysOnBottom => {
                        window.set_window_level(WindowLevel::Normal);
                    }
                    WindowLevel::AlwaysOnTop | WindowLevel::Normal => {
                        window.set_window_level(WindowLevel::AlwaysOnBottom);
                    }
                }
            }
            SetWindowLevel(level) => {
                let window = self.window.clone().unwrap();
                window.set_window_level(level.clone());
            }
            CopyTo(dest) => {
                // WezTerminator (patch 0027.1): only consume the
                // Ctrl+C keystroke when the user actually has a
                // selection. If they don't, return Unhandled so
                // that the upstream fall-through at the bottom of
                // `process_key` (keyevent.rs:328-425) sends the
                // keypress to the pane — which delivers ETX
                // (0x03) to the shell and aborts the running
                // process. Without this fall-through, pressing
                // Ctrl+C in a shell does nothing because the
                // binding copies an empty string and consumes the
                // keystroke before the shell ever sees it.
                let text = self.selection_text(pane);
                if text.is_empty() {
                    return Ok(PerformAssignmentResult::Unhandled);
                }
                self.copy_to_clipboard(*dest, text);
            }
            CopyTextTo { text, destination } => {
                self.copy_to_clipboard(*destination, text.clone());
            }
            PasteFrom(source) => {
                self.paste_from_clipboard(pane, *source);
            }
            ActivateTabRelative(n) => {
                self.activate_tab_relative(*n, true)?;
            }
            ActivateTabRelativeNoWrap(n) => {
                self.activate_tab_relative(*n, false)?;
            }
            ActivateLastTab => self.activate_last_tab()?,
            DecreaseFontSize => self.decrease_font_size(),
            IncreaseFontSize => self.increase_font_size(),
            ResetFontSize => self.reset_font_size(),
            ResetFontAndWindowSize => {
                if let Some(w) = window.as_ref() {
                    self.reset_font_and_window_size(&w)?
                }
            }
            // WezTerminator (patch 0039): per-pane font scale. Adjust
            // the active pane's scale, then invalidate the render caches
            // and re-apply the tab size so the mux reflows the pane's
            // PTY to the new (scaled) cell grid.
            IncreasePaneFontSize => {
                let s = pane.get_font_scale();
                pane.set_font_scale(s * 1.1);
                self.apply_pane_font_scale_change();
            }
            DecreasePaneFontSize => {
                let s = pane.get_font_scale();
                pane.set_font_scale(s / 1.1);
                self.apply_pane_font_scale_change();
            }
            ResetPaneFontSize => {
                pane.set_font_scale(1.0);
                self.apply_pane_font_scale_change();
            }
            ActivateTab(n) => {
                self.activate_tab(*n)?;
            }
            ActivateWindow(n) => {
                self.activate_window(*n)?;
            }
            ActivateWindowRelative(n) => {
                self.activate_window_relative(*n, true)?;
            }
            ActivateWindowRelativeNoWrap(n) => {
                self.activate_window_relative(*n, false)?;
            }
            SendString(s) => pane.writer().write_all(s.as_bytes())?,
            SendKey(key) => {
                use keyevent::Key;
                let mods = key.mods;
                if let Key::Code(key) = self.win_key_code_to_termwiz_key_code(
                    &key.key.resolve(self.config.key_map_preference),
                ) {
                    pane.key_down(key, mods)?;
                }
            }
            Hide => {
                if let Some(w) = window.as_ref() {
                    w.hide();
                }
            }
            Show => {
                if let Some(w) = window.as_ref() {
                    w.show();
                }
            }
            CloseCurrentTab { confirm } => self.close_current_tab(*confirm),
            CloseCurrentPane { confirm } => self.close_current_pane(*confirm),
            Nop | DisableDefaultAssignment => {}
            ReloadConfiguration => config::reload(),
            MoveTab(n) => self.move_tab(*n)?,
            MoveTabRelative(n) => self.move_tab_relative(*n)?,
            ScrollByPage(n) => self.scroll_by_page(**n, pane)?,
            ScrollByLine(n) => self.scroll_by_line(*n, pane)?,
            ScrollByCurrentEventWheelDelta => self.scroll_by_current_event_wheel_delta(pane)?,
            ScrollToPrompt(n) => self.scroll_to_prompt(*n, pane)?,
            ScrollToTop => self.scroll_to_top(pane),
            ScrollToBottom => self.scroll_to_bottom(pane),
            ShowTabNavigator => self.show_tab_navigator(),
            ShowDebugOverlay => self.show_debug_overlay(),
            ShowLauncher => self.show_launcher(),
            ShowLauncherArgs(args) => {
                let title = args.title.clone().unwrap_or("Launcher".to_string());
                let args = LauncherActionArgs {
                    title: Some(title),
                    flags: args.flags,
                    help_text: args.help_text.clone(),
                    fuzzy_help_text: args.fuzzy_help_text.clone(),
                    alphabet: args.alphabet.clone(),
                };
                self.show_launcher_impl(args, 0);
            }
            HideApplication => {
                let con = Connection::get().expect("call on gui thread");
                con.hide_application();
            }
            QuitApplication => {
                let mux = Mux::get();
                let config = &self.config;
                log::info!("QuitApplication over here (window)");

                match config.window_close_confirmation {
                    WindowCloseConfirmation::NeverPrompt => {
                        let con = Connection::get().expect("call on gui thread");
                        con.terminate_message_loop();
                    }
                    WindowCloseConfirmation::AlwaysPrompt => {
                        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                            Some(tab) => tab,
                            None => anyhow::bail!("no active tab!?"),
                        };

                        let window = self.window.clone().unwrap();
                        let (overlay, future) = start_overlay(self, &tab, move |tab_id, term| {
                            confirm_quit_program(term, window, tab_id)
                        });
                        self.assign_overlay(tab.tab_id(), overlay);
                        promise::spawn::spawn(future).detach();
                    }
                }
            }
            SelectTextAtMouseCursor(mode) => self.select_text_at_mouse_cursor(*mode, pane),
            ExtendSelectionToMouseCursor(mode) => {
                self.extend_selection_at_mouse_cursor(*mode, pane)
            }
            ClearSelection => {
                self.clear_selection(pane);
            }
            SelectAll => {
                // WezTerminator (patch 0014): select every line from the
                // top of the scrollback to the last viewport row.
                let dims = pane.get_dimensions();
                let last_row =
                    dims.physical_top + (dims.viewport_rows as isize).saturating_sub(1);
                let mut sel = self.selection(pane.pane_id());
                sel.range = Some(crate::selection::SelectionRange {
                    start: SelectionCoordinate {
                        x: SelectionX::Cell(0),
                        y: dims.scrollback_top,
                    },
                    end: SelectionCoordinate {
                        x: SelectionX::Cell(usize::MAX),
                        y: last_row,
                    },
                });
                sel.origin = None;
                sel.rectangular = false;
            }
            StartWindowDrag => {
                self.window_drag_position = self.current_mouse_event.clone();
            }
            OpenLinkAtMouseCursor => {
                self.do_open_link_at_mouse_cursor(pane);
            }
            EmitEvent(name) => {
                self.emit_window_event(name, None);
            }
            CompleteSelectionOrOpenLinkAtMouseCursor(dest) => {
                let text = self.selection_text(pane);
                if !text.is_empty() {
                    self.copy_to_clipboard(*dest, text);
                    let window = self.window.as_ref().unwrap();
                    window.invalidate();
                } else {
                    self.do_open_link_at_mouse_cursor(pane);
                }
            }
            CompleteSelection(dest) => {
                let text = self.selection_text(pane);
                if !text.is_empty() {
                    self.copy_to_clipboard(*dest, text);
                    let window = self.window.as_ref().unwrap();
                    window.invalidate();
                }
            }
            ClearScrollback(erase_mode) => {
                pane.erase_scrollback(*erase_mode);
                let window = self.window.as_ref().unwrap();
                window.invalidate();
            }
            Search(pattern) => {
                if let Some(pane) = self.get_active_pane_or_overlay() {
                    let mut replace_current = false;
                    if let Some(existing) = pane.downcast_ref::<CopyOverlay>() {
                        let mut params = existing.get_params();
                        params.editing_search = true;
                        if !pattern.is_empty() {
                            params.pattern = self.resolve_search_pattern(pattern.clone(), &pane);
                        }
                        existing.apply_params(params);
                        replace_current = true;
                    } else {
                        let search = CopyOverlay::with_pane(
                            self,
                            &pane,
                            CopyModeParams {
                                pattern: self.resolve_search_pattern(pattern.clone(), &pane),
                                editing_search: true,
                            },
                        )?;
                        self.assign_overlay_for_pane(pane.pane_id(), search);
                    }
                    self.pane_state(pane.pane_id())
                        .overlay
                        .as_mut()
                        .map(|overlay| {
                            overlay.key_table_state.activate(KeyTableArgs {
                                name: "search_mode",
                                timeout_milliseconds: None,
                                replace_current,
                                one_shot: false,
                                until_unknown: false,
                                prevent_fallback: false,
                            });
                        });
                }
            }
            QuickSelect => {
                if let Some(pane) = self.get_active_pane_no_overlay() {
                    let qa = QuickSelectOverlay::with_pane(
                        self,
                        &pane,
                        &QuickSelectArguments::default(),
                    );
                    self.assign_overlay_for_pane(pane.pane_id(), qa);
                }
            }
            QuickSelectArgs(args) => {
                if let Some(pane) = self.get_active_pane_no_overlay() {
                    let qa = QuickSelectOverlay::with_pane(self, &pane, args);
                    self.assign_overlay_for_pane(pane.pane_id(), qa);
                }
            }
            ActivateCopyMode => {
                if let Some(pane) = self.get_active_pane_or_overlay() {
                    let mut replace_current = false;
                    if let Some(existing) = pane.downcast_ref::<CopyOverlay>() {
                        let mut params = existing.get_params();
                        params.editing_search = false;
                        existing.apply_params(params);
                        replace_current = true;
                    } else {
                        let copy = CopyOverlay::with_pane(
                            self,
                            &pane,
                            CopyModeParams {
                                pattern: MuxPattern::default(),
                                editing_search: false,
                            },
                        )?;
                        self.assign_overlay_for_pane(pane.pane_id(), copy);
                    }
                    self.pane_state(pane.pane_id())
                        .overlay
                        .as_mut()
                        .map(|overlay| {
                            overlay.key_table_state.activate(KeyTableArgs {
                                name: "copy_mode",
                                timeout_milliseconds: None,
                                replace_current,
                                one_shot: false,
                                until_unknown: false,
                                prevent_fallback: false,
                            });
                        });
                }
            }
            AdjustPaneSize(direction, amount) => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };

                let tab_id = tab.tab_id();

                if self.tab_state(tab_id).overlay.is_none() {
                    tab.adjust_pane_size(*direction, *amount);
                }
            }
            ActivatePaneByIndex(index) => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };

                let tab_id = tab.tab_id();

                if self.tab_state(tab_id).overlay.is_none() {
                    let panes = tab.iter_panes();
                    if panes.iter().position(|p| p.index == *index).is_some() {
                        tab.set_active_idx(*index);
                    }
                }
            }
            ActivatePaneDirection(direction) => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };

                let tab_id = tab.tab_id();

                if self.tab_state(tab_id).overlay.is_none() {
                    tab.activate_pane_direction(*direction);
                }
            }
            TogglePaneZoomState => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };
                tab.toggle_zoom();
            }
            SetPaneZoomState(zoomed) => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };
                tab.set_zoomed(*zoomed);
            }
            // WezTerminator (patch 0065): list mode key assignments.
            ToggleListMode => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };
                tab.toggle_list_mode();
                // WezTerminator (patch 0065): re-run the layout so the pane-tab
                // strip's reserved height is applied (terminal rows shrink/grow
                // and content moves below it), not just on the next resize.
                if let Some(window) = self.window.clone() {
                    let dims = self.dimensions.clone();
                    self.apply_dimensions(&dims, None, &window);
                }
                if let Some(window_id) = mux.window_containing_tab(tab.tab_id()) {
                    mux.notify(mux::MuxNotification::WindowInvalidated(window_id));
                }
            }
            SetListSlots(count) => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };
                tab.set_list_slot_count(*count as usize);
                if let Some(window_id) = mux.window_containing_tab(tab.tab_id()) {
                    mux.notify(mux::MuxNotification::WindowInvalidated(window_id));
                }
            }
            ActivateListSlotPane(ordinal) => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };
                let panes = tab.iter_panes_ignoring_zoom();
                if let Some(pp) = panes.get(*ordinal) {
                    let pane_id = pp.pane.pane_id();
                    let slots = tab.list_slots();
                    if let Some(slot) = slots.iter().position(|id| *id == pane_id) {
                        tab.set_list_focused_slot(slot);
                    } else {
                        tab.load_pane_into_slot(tab.list_focused_slot(), pane_id);
                    }
                }
                if let Some(window_id) = mux.window_containing_tab(tab.tab_id()) {
                    mux.notify(mux::MuxNotification::WindowInvalidated(window_id));
                }
            }
            SwitchWorkspaceRelative(delta) => {
                let mux = Mux::get();
                let workspace = mux.active_workspace();
                let workspaces = mux.iter_workspaces();
                let idx = workspaces.iter().position(|w| *w == workspace).unwrap_or(0);
                let new_idx = idx as isize + delta;
                let new_idx = if new_idx < 0 {
                    workspaces.len() as isize + new_idx
                } else {
                    new_idx
                };
                let new_idx = new_idx as usize % workspaces.len();
                if let Some(w) = workspaces.get(new_idx) {
                    front_end().switch_workspace(w);
                }
            }
            SwitchToWorkspace { name, spawn } => {
                let activity = crate::Activity::new();
                let mux = Mux::get();
                let name = name
                    .as_ref()
                    .map(|name| name.to_string())
                    .unwrap_or_else(|| mux.generate_workspace_name());
                let switcher = crate::frontend::WorkspaceSwitcher::new(&name);
                mux.set_active_workspace(&name);

                if mux.iter_windows_in_workspace(&name).is_empty() {
                    let spawn = spawn.as_ref().map(|s| s.clone()).unwrap_or_default();
                    let size = self.terminal_size;
                    let term_config = Arc::new(TermConfig::with_config(self.config.clone()));
                    let src_window_id = self.mux_window_id;

                    promise::spawn::spawn(async move {
                        if let Err(err) = crate::spawn::spawn_command_internal(
                            spawn,
                            SpawnWhere::NewWindow,
                            size,
                            Some(src_window_id),
                            term_config,
                        )
                        .await
                        {
                            log::error!("Failed to spawn: {:#}", err);
                        }
                        switcher.do_switch();
                        drop(activity);
                    })
                    .detach();
                } else {
                    switcher.do_switch();
                }
            }
            DetachDomain(domain) => {
                let domain = Mux::get().resolve_spawn_tab_domain(Some(pane.pane_id()), domain)?;
                domain.detach()?;
            }
            AttachDomain(domain) => {
                let window = self.mux_window_id;
                let domain = domain.to_string();
                let dpi = self.dimensions.dpi as u32;

                promise::spawn::spawn(async move {
                    let mux = Mux::get();
                    let domain = mux
                        .get_domain_by_name(&domain)
                        .ok_or_else(|| anyhow!("{} is not a valid domain name", domain))?;
                    domain.attach(Some(window)).await?;

                    let have_panes_in_domain = mux
                        .iter_panes()
                        .iter()
                        .any(|p| p.domain_id() == domain.domain_id());

                    if !have_panes_in_domain {
                        let config = config::configuration();
                        let _tab = domain
                            .spawn(
                                config.initial_size(
                                    dpi,
                                    Some(crate::cell_pixel_dims(&config, dpi as f64)?),
                                ),
                                None,
                                None,
                                window,
                            )
                            .await?;
                    }

                    Result::<(), anyhow::Error>::Ok(())
                })
                .detach();
            }
            CopyMode(_) => {
                // NOP here; handled by the overlay directly
            }
            RotatePanes(direction) => {
                let mux = Mux::get();
                let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
                    Some(tab) => tab,
                    None => return Ok(PerformAssignmentResult::Handled),
                };
                match direction {
                    RotationDirection::Clockwise => tab.rotate_clockwise(),
                    RotationDirection::CounterClockwise => tab.rotate_counter_clockwise(),
                }
            }
            SplitPane(split) => {
                log::trace!("SplitPane {:?}", split);
                self.spawn_command(
                    &split.command,
                    SpawnWhere::SplitPane(SplitRequest {
                        direction: match split.direction {
                            PaneDirection::Down | PaneDirection::Up => SplitDirection::Vertical,
                            PaneDirection::Left | PaneDirection::Right => {
                                SplitDirection::Horizontal
                            }
                            PaneDirection::Next | PaneDirection::Prev => {
                                log::error!(
                                    "Invalid direction {:?} for SplitPane",
                                    split.direction
                                );
                                return Ok(PerformAssignmentResult::Handled);
                            }
                        },
                        target_is_second: match split.direction {
                            PaneDirection::Down | PaneDirection::Right => true,
                            PaneDirection::Up | PaneDirection::Left => false,
                            PaneDirection::Next | PaneDirection::Prev => unreachable!(),
                        },
                        size: match split.size {
                            SplitSize::Percent(n) => MuxSplitSize::Percent(n),
                            SplitSize::Cells(n) => MuxSplitSize::Cells(n),
                        },
                        top_level: split.top_level,
                    }),
                );
            }
            PaneSelect(args) => {
                let modal = crate::termwindow::paneselect::PaneSelector::new(self, args);
                self.set_modal(Rc::new(modal));
            }
            CharSelect(args) => {
                let modal = crate::termwindow::charselect::CharSelector::new(self, args);
                self.set_modal(Rc::new(modal));
            }
            ResetTerminal => {
                pane.perform_actions(vec![termwiz::escape::Action::Esc(
                    termwiz::escape::Esc::Code(termwiz::escape::EscCode::FullReset),
                )]);
            }
            OpenUri(link) => {
                wezterm_open_url::open_url(link);
            }
            ActivateCommandPalette => {
                let modal = crate::termwindow::palette::CommandPalette::new(self);
                self.set_modal(Rc::new(modal));
            }
            PromptInputLine(args) => self.show_prompt_input_line(args),
            InputSelector(args) => self.show_input_selector(args),
            Confirmation(args) => self.show_confirmation(args),
        };
        Ok(PerformAssignmentResult::Handled)
    }

    fn do_open_link_at_mouse_cursor(&self, pane: &Arc<dyn Pane>) {
        // They clicked on a link, so let's open it!
        // We need to ensure that we spawn the `open` call outside of the context
        // of our window loop; on Windows it can cause a panic due to
        // triggering our WndProc recursively.
        // We get that assurance for free as part of the async dispatch that we
        // perform below; here we allow the user to define an `open-uri` event
        // handler that can bypass the normal `open_url` functionality.
        if let Some(link) = self.current_highlight.as_ref().cloned() {
            let window = GuiWin::new(self);
            let pane_id = pane.pane_id();
            let pane = MuxPane(pane_id);

            async fn open_uri(
                lua: Option<Rc<mlua::Lua>>,
                window: GuiWin,
                pane: MuxPane,
                pane_id: PaneId,
                link: String,
            ) -> anyhow::Result<()> {
                if link.starts_with("file://") {
                    if wtinator::file_link::open_file_link(&link, pane_id) {
                        return Ok(());
                    }
                }
                let default_click = match lua {
                    Some(lua) => {
                        let args = lua.pack_multi((window, pane, link.clone()))?;
                        config::lua::emit_event(&lua, ("open-uri".to_string(), args))
                            .await
                            .map_err(|e| {
                                log::error!("while processing open-uri event: {:#}", e);
                                e
                            })?
                    }
                    None => true,
                };
                if default_click {
                    log::info!("clicking {}", link);
                    wezterm_open_url::open_url(&link);
                }
                Ok(())
            }

            promise::spawn::spawn(config::with_lua_config_on_main_thread(move |lua| {
                open_uri(lua, window, pane, pane_id, link.uri().to_string())
            }))
            .detach();
        }
    }
    fn close_current_pane(&mut self, confirm: bool) {
        let mux_window_id = self.mux_window_id;
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(mux_window_id) {
            Some(tab) => tab,
            None => return,
        };
        let pane = match tab.get_active_pane() {
            Some(p) => p,
            None => return,
        };

        let pane_id = pane.pane_id();

        // No prompt needed (fresh / empty pane, or caller asked
        // to skip): close immediately.
        if !confirm || pane.can_close_without_prompting(CloseReason::Pane) {
            mux.remove_pane(pane_id);
            return;
        }

        // WezTerminator (patch 0032.1): confirm the pane close with
        // a real Win32 native MessageBox (Yes/No) instead of the
        // in-terminal Skia overlay. Same threading model as the
        // per-tab close (patch 0032): the messagebox runs on a
        // dedicated std::thread so a frozen pane cannot block the
        // prompt, and the actual close is posted back to the GUI
        // main thread on "Yes".
        let hwnd_isize = match self.window.as_ref() {
            Some(w) => w.hwnd() as isize,
            None => {
                // No HWND — fall back to the Skia overlay so the
                // user still gets a confirmation.
                let window = self.window.clone().unwrap();
                let (overlay, future) = start_overlay_pane(self, &pane, move |pane_id, term| {
                    confirm_close_pane(pane_id, term, mux_window_id, window)
                });
                self.assign_overlay_for_pane(pane_id, overlay);
                promise::spawn::spawn(future).detach();
                return;
            }
        };

        let gui_window_for_notify = self.window.clone();
        std::thread::spawn(move || {
            let confirmed = wtinator::confirm::confirm_close(
                hwnd_isize,
                wtinator::confirm::ConfirmKind::Pane,
                "Close terminal?",
                "Really close this terminal?\n\n\
                 The program running in it will be killed and will \
                 not get a chance to clean up.",
            );
            if !confirmed {
                return;
            }
            if let Some(gui_window) = gui_window_for_notify {
                gui_window.notify(TermWindowNotif::Apply(Box::new(move |_tw| {
                    if let Some(mux) = mux::Mux::try_get() {
                        mux.remove_pane(pane_id);
                    }
                })));
            }
        });
    }

    fn close_specific_tab(&mut self, tab_idx: usize, confirm: bool) {
        let mux = Mux::get();
        let mux_window_id = self.mux_window_id;
        let mux_window = match mux.get_window(mux_window_id) {
            Some(w) => w,
            None => return,
        };

        let tab = match mux_window.get_by_idx(tab_idx) {
            Some(tab) => Arc::clone(tab),
            None => return,
        };
        drop(mux_window);

        let tab_id = tab.tab_id();
        if confirm && !tab.can_close_without_prompting(CloseReason::Tab) {
            if self.activate_tab(tab_idx as isize).is_err() {
                return;
            }

            let window = self.window.clone().unwrap();
            let (overlay, future) = start_overlay(self, &tab, move |tab_id, term| {
                confirm_close_tab(tab_id, term, mux_window_id, window)
            });
            self.assign_overlay(tab_id, overlay);
            promise::spawn::spawn(future).detach();
        } else {
            mux.remove_tab(tab_id);
        }
    }

    /// WezTerminator (patch 0032): close a tab with a
    /// Win32-native confirmation dialog. Differs from
    /// `close_specific_tab(idx, true)` only in the
    /// confirmation backend — the Skia overlay is
    /// replaced by a `MessageBoxW` call on a dedicated
    /// `std::thread`, so a frozen terminal UI thread
    /// does not block the prompt.
    ///
    /// Behaviour:
    /// 1. If the tab can be closed silently
    ///    (`can_close_without_prompting` returns `true`),
    ///    close it directly with no prompt.
    /// 2. Otherwise, show a real Windows native
    ///    `MessageBoxW` (title "Close tab?", body
    ///    "Really close \"<user_title>\"?"). The
    ///    user clicks Yes or No. On Yes, the tab
    ///    is removed via a `TermWindowNotif::Apply`
    ///    posted back to the main thread.
    /// 3. If we cannot get an HWND for some reason,
    ///    fall back to the Skia confirmation path
    ///    (`close_specific_tab`) so the user still
    ///    gets some confirmation.
    fn close_specific_tab_with_win32_confirm(&mut self, tab_idx: usize) {
        let mux = Mux::get();
        let mux_window_id = self.mux_window_id;

        let tab = match mux
            .get_window(mux_window_id)
            .and_then(|w| w.get_by_idx(tab_idx).cloned())
        {
            Some(t) => t,
            None => return,
        };
        let tab_id = tab.tab_id();

        // WezTerminator: closing a tab with the mouse must ALWAYS ask
        // for confirmation — never close silently. We deliberately do
        // NOT honour the upstream `can_close_without_prompting`
        // optimization here (which would let a fresh/empty tab close
        // without a prompt); the user asked that the close-X never
        // "simplesmente encerrar". So we always fall through to the
        // Win32 confirmation messagebox below.

        // Get the parent HWND. We use the existing
        // `Window::hwnd()` getter from patch 0025 so
        // we do not have to call `GetForegroundWindow`
        // (which is racy when the messagebox is on a
        // different thread).
        let hwnd_isize = match self.window.as_ref() {
            Some(w) => w.hwnd() as isize,
            None => {
                log::warn!(
                    "wezterminator patch 0032: no HWND available, falling back to Skia confirm"
                );
                self.close_specific_tab(tab_idx, true);
                return;
            }
        };

        // Build the dialog text. We use the tab's
        // user-set title (via `effective_title` from
        // patch 0031) so the user can identify which
        // tab they are about to close. Fall back to
        // "Tab #N" if the user has not set a title.
        let tab_label = tab.effective_title();
        let tab_label = if tab_label.is_empty() {
            format!("Tab #{}", tab_idx + 1)
        } else {
            format!("\"{}\"", tab_label)
        };
        let title = "Close tab?";
        let text = format!(
            "Really close {}?\n\n\
             All panes in this tab will be killed. The \
             shell program running in each pane will \
             not get a chance to clean up.",
            tab_label,
        );

        let gui_window_for_notify = self.window.clone();
        std::thread::spawn(move || {
            let confirmed = wtinator::confirm::confirm_close(
                hwnd_isize,
                wtinator::confirm::ConfirmKind::Tab,
                title,
                &text,
            );
            if !confirmed {
                return;
            }
            if let Some(gui_window) = gui_window_for_notify {
                gui_window.notify(TermWindowNotif::Apply(Box::new(move |_tw| {
                    if let Some(mux) = mux::Mux::try_get() {
                        mux.remove_tab(tab_id);
                    }
                })));
            }
        });
    }

    fn close_current_tab(&mut self, confirm: bool) {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return,
        };
        let tab_id = tab.tab_id();
        let mux_window_id = self.mux_window_id;
        if confirm && !tab.can_close_without_prompting(CloseReason::Tab) {
            let window = self.window.clone().unwrap();
            let (overlay, future) = start_overlay(self, &tab, move |tab_id, term| {
                confirm_close_tab(tab_id, term, mux_window_id, window)
            });
            self.assign_overlay(tab_id, overlay);
            promise::spawn::spawn(future).detach();
        } else {
            mux.remove_tab(tab_id);
        }
    }

    pub fn pane_state(&self, pane_id: PaneId) -> RefMut<'_, PaneState> {
        RefMut::map(self.pane_state.borrow_mut(), |state| {
            state.entry(pane_id).or_insert_with(PaneState::default)
        })
    }

    pub fn tab_state(&self, tab_id: TabId) -> RefMut<'_, TabState> {
        RefMut::map(self.tab_state.borrow_mut(), |state| {
            state.entry(tab_id).or_insert_with(TabState::default)
        })
    }

    /// Resize overlays to match their corresponding tab/pane dimensions
    pub fn resize_overlays(&self) {
        let mux = Mux::get();
        for (_, state) in self.tab_state.borrow().iter() {
            if let Some(overlay) = state.overlay.as_ref().map(|o| &o.pane) {
                overlay.resize(self.terminal_size).ok();
            }
        }
        for (pane_id, state) in self.pane_state.borrow().iter() {
            if let Some(overlay) = state.overlay.as_ref().map(|o| &o.pane) {
                if let Some(pane) = mux.get_pane(*pane_id) {
                    let dims = pane.get_dimensions();
                    overlay
                        .resize(TerminalSize {
                            cols: dims.cols,
                            rows: dims.viewport_rows,
                            dpi: self.terminal_size.dpi,
                            pixel_height: (self.terminal_size.pixel_height
                                / self.terminal_size.rows)
                                * dims.viewport_rows,
                            pixel_width: (self.terminal_size.pixel_width / self.terminal_size.cols)
                                * dims.cols,
                        })
                        .ok();
                }
            }
        }
    }

    pub fn get_viewport(&self, pane_id: PaneId) -> Option<StableRowIndex> {
        self.pane_state(pane_id).viewport
    }

    pub fn set_viewport(
        &mut self,
        pane_id: PaneId,
        position: Option<StableRowIndex>,
        dims: RenderableDimensions,
    ) {
        let pos = match position {
            Some(pos) => {
                // Drop out of scrolling mode if we're off the bottom
                if pos >= dims.physical_top {
                    None
                } else {
                    Some(pos.max(dims.scrollback_top))
                }
            }
            None => None,
        };

        let mut state = self.pane_state(pane_id);
        if pos != state.viewport {
            state.viewport = pos;

            // This is a bit gross.  If we add other overlays that need this information,
            // this should get extracted out into a trait
            if let Some(overlay) = state.overlay.as_ref() {
                if let Some(copy) = overlay.pane.downcast_ref::<CopyOverlay>() {
                    copy.viewport_changed(pos);
                } else if let Some(qs) = overlay.pane.downcast_ref::<QuickSelectOverlay>() {
                    qs.viewport_changed(pos);
                }
            }
        }
        self.window.as_ref().unwrap().invalidate();
    }

    fn maybe_scroll_to_bottom_for_input(&mut self, pane: &Arc<dyn Pane>) {
        if self.config.scroll_to_bottom_on_input {
            self.scroll_to_bottom(pane);
        }
    }

    fn scroll_to_top(&mut self, pane: &Arc<dyn Pane>) {
        let dims = pane.get_dimensions();
        self.set_viewport(pane.pane_id(), Some(dims.scrollback_top), dims);
    }

    fn scroll_to_bottom(&mut self, pane: &Arc<dyn Pane>) {
        self.pane_state(pane.pane_id()).viewport = None;
    }

    fn get_active_pane_no_overlay(&self) -> Option<Arc<dyn Pane>> {
        let mux = Mux::get();
        mux.get_active_tab_for_window(self.mux_window_id)
            .and_then(|tab| tab.get_active_pane())
    }

    /// Returns a Pane that we can interact with; this will typically be
    /// the active tab for the window, but if the window has a tab-wide
    /// overlay (such as the launcher / tab navigator),
    /// then that will be returned instead.  Otherwise, if the pane has
    /// an active overlay (such as search or copy mode) then that will
    /// be returned.
    pub fn get_active_pane_or_overlay(&self) -> Option<Arc<dyn Pane>> {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return None,
        };

        let tab_id = tab.tab_id();

        if let Some(tab_overlay) = self
            .tab_state(tab_id)
            .overlay
            .as_ref()
            .map(|overlay| overlay.pane.clone())
        {
            Some(tab_overlay)
        } else {
            let pane = tab.get_active_pane()?;
            let pane_id = pane.pane_id();
            self.pane_state(pane_id)
                .overlay
                .as_ref()
                .map(|overlay| overlay.pane.clone())
                .or_else(|| Some(pane))
        }
    }

    fn get_splits(&mut self) -> Vec<PositionedSplit> {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return vec![],
        };

        let tab_id = tab.tab_id();

        if self.tab_state(tab_id).overlay.is_some() {
            vec![]
        } else {
            tab.iter_splits()
        }
    }

    fn pos_pane_to_pane_info(pos: &PositionedPane) -> PaneInformation {
        PaneInformation {
            pane_id: pos.pane.pane_id(),
            pane_index: pos.index,
            is_active: pos.is_active,
            is_zoomed: pos.is_zoomed,
            has_unseen_output: pos.pane.has_unseen_output(),
            left: pos.left,
            top: pos.top,
            width: pos.width,
            height: pos.height,
            pixel_width: pos.pixel_width,
            pixel_height: pos.pixel_height,
            title: pos.pane.get_title(),
            user_vars: pos.pane.copy_user_vars(),
            progress: pos.pane.get_progress(),
        }
    }

    fn get_tab_information(&mut self) -> Vec<TabInformation> {
        let mux = Mux::get();
        let window = match mux.get_window(self.mux_window_id) {
            Some(window) => window,
            _ => return vec![],
        };
        let tab_index = window.get_active_idx();

        window
            .iter()
            .enumerate()
            .map(|(idx, tab)| {
                let panes = self.get_pos_panes_for_tab(tab);

                // WezTerminator (patch 0063): bell attention + blink phase.
                // Clear it once the user is looking at this tab (it is active
                // and the window is focused). The blink toggles every 400ms.
                let tab_id = tab.tab_id();
                let is_active = tab_index == idx;
                if is_active && self.focused.is_some() {
                    self.tab_bell_attention.borrow_mut().remove(&tab_id);
                }
                let attention_start =
                    self.tab_bell_attention.borrow().get(&tab_id).copied();
                let needs_attention = attention_start.is_some();
                let attention_blink = attention_start
                    .map(|s| (s.elapsed().as_millis() / 400) % 2 == 0)
                    .unwrap_or(false);

                TabInformation {
                    tab_index: idx,
                    tab_id,
                    is_active,
                    is_last_active: window
                        .get_last_active_idx()
                        .map(|last_active| last_active == idx)
                        .unwrap_or(false),
                    window_id: self.mux_window_id,
                    // WezTerminator (patch 0031): keep the raw
                    // OSC 0/2 title in `tab_title` for Lua
                    // backwards compatibility, and add a
                    // separate `user_title` for the user-set
                    // override. The tab-bar renderer prefers
                    // the user title when it is set.
                    tab_title: tab.get_title(),
                    user_title: tab.get_user_title().unwrap_or_default(),
                    active_pane: panes
                        .iter()
                        .find(|p| p.is_active)
                        .map(Self::pos_pane_to_pane_info),
                    needs_attention,
                    attention_blink,
                }
            })
            .collect()
    }

    fn get_pane_information(&self) -> Vec<PaneInformation> {
        self.get_panes_to_render()
            .iter()
            .map(Self::pos_pane_to_pane_info)
            .collect()
    }

    fn get_pos_panes_for_tab(&self, tab: &Arc<Tab>) -> Vec<PositionedPane> {
        let tab_id = tab.tab_id();

        if let Some(pane) = self
            .tab_state(tab_id)
            .overlay
            .as_ref()
            .map(|overlay| overlay.pane.clone())
        {
            let size = tab.get_size();
            return vec![PositionedPane {
                index: 0,
                is_active: true,
                is_zoomed: false,
                left: 0,
                top: 0,
                width: size.cols as _,
                height: size.rows as _,
                pixel_width: size.cols as usize * self.render_metrics.cell_size.width as usize,
                pixel_height: size.rows as usize * self.render_metrics.cell_size.height as usize,
                pane,
            }];
        }

        let mut panes = tab.iter_panes();
        for p in &mut panes {
            if let Some(overlay) = self.pane_state(p.pane.pane_id()).overlay.as_ref() {
                p.pane = Arc::clone(&overlay.pane);
            }
        }
        panes
    }

    fn get_panes_to_render(&self) -> Vec<PositionedPane> {
        let mux = Mux::get();
        let tab = match mux.get_active_tab_for_window(self.mux_window_id) {
            Some(tab) => tab,
            None => return vec![],
        };

        self.get_pos_panes_for_tab(&tab)
    }

    fn pane_has_header(&self, pane: &Arc<dyn Pane>) -> bool {
        if crate::tabbar::is_wtinator_active() && !pane.is_alt_screen_active() {
            return true;
        }
        let mux = Mux::get();
        if let Some(window) = mux.get_window(self.mux_window_id) {
            if let Some(tab) = window.get_active() {
                return wtinator::header::should_render_for_pane(&tab, pane);
            }
        }
        false
    }

    /// if pane_id.is_none(), removes any overlay for the specified tab.
    /// Otherwise: if the overlay is the specified pane for that tab, remove it.
    fn cancel_overlay_for_tab(&mut self, tab_id: TabId, pane_id: Option<PaneId>) {
        if pane_id.is_some() {
            let current = self
                .tab_state(tab_id)
                .overlay
                .as_ref()
                .map(|o| o.pane.pane_id());
            if current != pane_id {
                return;
            }
        }
        if let Some(overlay) = self.tab_state(tab_id).overlay.take() {
            Mux::get().remove_pane(overlay.pane.pane_id());
        }
        if let Some(window) = self.window.as_ref() {
            window.invalidate();
        }
    }

    pub fn schedule_cancel_overlay(window: Window, tab_id: TabId, pane_id: Option<PaneId>) {
        window.notify(TermWindowNotif::CancelOverlayForTab { tab_id, pane_id });
    }

    fn cancel_overlay_for_pane(&mut self, pane_id: PaneId) {
        if let Some(overlay) = self.pane_state(pane_id).overlay.take() {
            // Ungh, when I built the CopyOverlay, its pane doesn't get
            // added to the mux and instead it reports the overlaid
            // pane id.  Take care to avoid killing ourselves off
            // when closing the CopyOverlay
            if pane_id != overlay.pane.pane_id() {
                Mux::get().remove_pane(overlay.pane.pane_id());
            }
        }
        if let Some(window) = self.window.as_ref() {
            window.invalidate();
        }
    }

    pub fn schedule_cancel_overlay_for_pane(window: Window, pane_id: PaneId) {
        window.notify(TermWindowNotif::CancelOverlayForPane(pane_id));
    }

    pub fn assign_overlay_for_pane(&mut self, pane_id: PaneId, pane: Arc<dyn Pane>) {
        self.cancel_overlay_for_pane(pane_id);
        self.pane_state(pane_id).overlay.replace(OverlayState {
            pane,
            key_table_state: KeyTableState::default(),
        });
        self.update_title();
    }

    pub fn assign_overlay(&mut self, tab_id: TabId, overlay: Arc<dyn Pane>) {
        self.cancel_overlay_for_tab(tab_id, None);
        self.tab_state(tab_id).overlay.replace(OverlayState {
            pane: overlay,
            key_table_state: KeyTableState::default(),
        });
        self.update_title();
    }

    fn resolve_search_pattern(&self, pattern: Pattern, pane: &Arc<dyn Pane>) -> MuxPattern {
        match pattern {
            Pattern::CaseSensitiveString(s) => MuxPattern::CaseSensitiveString(s),
            Pattern::CaseInSensitiveString(s) => MuxPattern::CaseInSensitiveString(s),
            Pattern::Regex(s) => MuxPattern::Regex(s),
            Pattern::CurrentSelectionOrEmptyString => {
                let text = self.selection_text(pane);
                let first_line = text
                    .lines()
                    .next()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                MuxPattern::CaseSensitiveString(first_line)
            }
        }
    }
}

impl Drop for TermWindow {
    fn drop(&mut self) {
        self.clear_all_overlays();
        if let Some(window) = self.window.take() {
            if let Some(fe) = try_front_end() {
                fe.forget_known_window(&window);
            }
        }
    }
}
