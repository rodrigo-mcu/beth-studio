use mux::pane::PaneId;
use mux::renderable::StableCursorPosition;
use std::time::Instant;
use wezterm_term::StableRowIndex;

#[derive(Clone)]
pub struct PrevCursorPos {
    pos: StableCursorPosition,
    when: Instant,
}

impl PrevCursorPos {
    pub fn new() -> Self {
        PrevCursorPos {
            pos: StableCursorPosition::default(),
            when: Instant::now(),
        }
    }

    /// Make the cursor look like it moved
    pub fn bump(&mut self) {
        self.when = Instant::now();
    }

    /// Update the cursor position if its different
    pub fn update(&mut self, newpos: &StableCursorPosition) {
        if &self.pos != newpos {
            self.pos = *newpos;
            self.when = Instant::now();
        }
    }

    /// When did the cursor last move?
    pub fn last_cursor_movement(&self) -> Instant {
        self.when
    }
}

// WezTerminator (patch 0044): cursor glide tuning knobs. The lead
// will adjust these visually.
//
/// Time-based ease duration for the glide, in milliseconds. The
/// rendered cursor interpolates from its old pixel rect to the new
/// one over this window. Frame-rate independent (we sample elapsed
/// time, not a per-frame lerp). ~110ms reads as a quick, smooth
/// slide like modern editors.
pub const GLIDE_DURATION_MS: f32 = 110.0;

/// If the cursor jumps more than this many cells (Euclidean, in
/// cells) in a single update, teleport instead of gliding so the
/// block doesn't fly across the screen on a `cls`/full-screen
/// redraw / large paste. Set high to effectively disable; tune down
/// if long jumps look distracting.
pub const GLIDE_MAX_CELLS: f32 = 40.0;

/// Distance (in pixels) within which the rendered rect is considered
/// to have reached the target. Below this we "settle": stop drawing
/// the glide overlay and let the normal per-line cell cursor render
/// (which blinks/fades via patch 0042).
pub const GLIDE_SETTLE_PX: f32 = 1.0;

/// WezTerminator (patch 0044): tracks the cursor's *rendered* pixel
/// rectangle (window coords) for the focused/active pane across
/// frames so it can smoothly slide from its old position to a new
/// target instead of teleporting.
///
/// Only the active pane's cursor glides. The state is reset/teleported
/// (snapped to the target with no animation) when the active pane
/// changes, the window loses focus, the viewport scrolls, or the jump
/// exceeds `GLIDE_MAX_CELLS`.
#[derive(Clone)]
pub struct CursorGlideState {
    /// Current rendered top-left of the cursor block, in window pixels.
    pub rendered_x: f32,
    pub rendered_y: f32,
    /// Cell size used for the rendered block (pane-scaled metrics).
    pub width: f32,
    pub height: f32,
    /// The pane this glide state belongs to; if the active pane changes
    /// we teleport rather than glide between unrelated panes.
    pub pane_id: PaneId,
    /// The viewport top row at the last update. A change means the
    /// content scrolled; we teleport (cursor row->pixel mapping shifted
    /// for reasons unrelated to a cursor move).
    pub viewport_top: StableRowIndex,
    /// When `rendered_*` was last advanced; used for the time-based ease.
    pub last_update: Instant,
}
