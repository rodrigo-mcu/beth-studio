// wtinator::context_menu — Phase 1.B/D (v2: native Win32 menu).
//
// Mouse-friendly entry points to terminal-management actions.
//
// ## Why native Win32 menu (and not a Skia overlay)
//
// We initially used wezterm's `config::keyassignment::InputSelector`
// overlay, which renders a Skia popup inside the wezterm-gui window.
// The user reported that the overlay did not appear for them in some
// Windows sessions (likely an overlay-rendering issue specific to
// their graphics environment). To work around that, this module now
// builds a **native Win32 popup menu** (HMENU) using
// `CreatePopupMenu` + `AppendMenuW` and shows it via
// `TrackPopupMenuEx`. The resulting menu is:
//
//   - A real, native Windows menu — the same widget you see when
//     you right-click on any Win32 application
//   - Themed by the OS (light/dark/high-contrast — your choice)
//   - Always on top, never occluded by the wezterm window
//   - Positioned automatically at the cursor
//   - Disposed of correctly when the user clicks elsewhere
//
// The menu items are organized into three "pickers" that correspond
// to the mouse-driven UX:
//
//   - `build_shell_picker()` — what to open in a new tab
//     (cmd.exe / PowerShell 5.1 / PowerShell 7+ / WSL default /
//     WSL Ubuntu / Git Bash).
//   - `build_split_picker()` — how to split the current pane
//     (right / down).
//   - `build_full_menu()` — kitchen sink (shells + splits + close pane).
//
// Each item has a stable `wID` (a `u16`) that we use to dispatch the
// right `KeyAssignment` after the user clicks.

use crate::vscode_theme::ThemeId;
use config::keyassignment::{
    ClipboardCopyDestination, ClipboardPasteSource, KeyAssignment, SpawnCommand,
};

/// One shell entry for the "New tab" picker.
pub struct ShellEntry {
    pub id: &'static str,
    pub label: &'static str,
    /// Full command line: program + args. Stored as `Vec<String>` because
    /// `config::keyassignment::SpawnCommand::args` takes `Vec<String>`.
    pub args: Vec<String>,
}

/// Default shells offered in the "New tab" picker.
///
/// On Windows, the available shells are:
///   - `cmd.exe` (the Windows console)
///   - `powershell.exe` (Windows PowerShell 5.1)
///   - `pwsh.exe` (PowerShell 7+)
///   - `wsl.exe` (WSL2 — default distro)
///   - `wsl.exe -d <DistroName>` (named WSL distros)
///   - Git Bash (if installed)
pub fn default_shells() -> Vec<ShellEntry> {
    let mut shells = vec![
        ShellEntry {
            id: "cmd",
            label: "cmd.exe",
            args: vec!["cmd.exe".to_string()],
        },
        ShellEntry {
            id: "powershell",
            label: "PowerShell 5.1",
            args: vec!["powershell.exe".to_string(), "-NoLogo".to_string()],
        },
        ShellEntry {
            id: "pwsh",
            label: "PowerShell 7+",
            args: vec!["pwsh.exe".to_string(), "-NoLogo".to_string()],
        },
        ShellEntry {
            id: "wsl.default",
            label: "WSL (default distro)",
            args: vec!["wsl.exe".to_string()],
        },
        ShellEntry {
            id: "wsl.ubuntu",
            label: "WSL — Ubuntu",
            args: vec![
                "wsl.exe".to_string(),
                "-d".to_string(),
                "Ubuntu".to_string(),
            ],
        },
        ShellEntry {
            id: "gitbash",
            label: "Git Bash",
            args: vec![
                "C:\\Program Files\\Git\\bin\\bash.exe".to_string(),
                "--login".to_string(),
            ],
        },
    ];

    if let Some(path) = moba_local_bash_path() {
        shells.push(ShellEntry {
            id: "mobaxterm.local",
            label: "MobaXterm local bash",
            args: vec![path, "--login".to_string()],
        });
    }

    // Patch 0183: user-defined entries from %APPDATA%\bethterm\shells.json.
    shells.extend(custom_shells());

    shells
}

fn moba_local_bash_path() -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        candidates.push(format!(
            "{}\\Documents\\MobaXterm\\slash\\bin\\bash.exe",
            user_profile
        ));
    }

    candidates
        .into_iter()
        .find(|path| std::path::Path::new(path).is_file())
}

/// One entry of `%APPDATA%\bethterm\shells.json` (patch 0183).
#[derive(serde::Deserialize)]
struct CustomShell {
    id: String,
    label: String,
    args: Vec<String>,
}

/// User-defined shells, read once per process from
/// `%APPDATA%\bethterm\shells.json`:
///
/// ```json
/// [ { "id": "my.tool", "label": "My tool log", "args": ["powershell.exe", "-NoExit", "-Command", "..."] } ]
/// ```
///
/// Invalid entries (empty args, id outside `[a-z0-9._-]`, duplicate id)
/// are skipped. The strings are leaked once so `ShellEntry` can keep its
/// `&'static str` fields.
fn custom_shells() -> Vec<ShellEntry> {
    static CUSTOM: std::sync::OnceLock<Vec<(&'static str, &'static str, Vec<String>)>> =
        std::sync::OnceLock::new();
    CUSTOM
        .get_or_init(|| {
            let Ok(dir) = crate::session::session_dir() else {
                return Vec::new();
            };
            let Ok(text) = std::fs::read_to_string(dir.join("shells.json")) else {
                return Vec::new();
            };
            parse_custom_shells(&text)
                .into_iter()
                .map(|c| {
                    let id: &'static str = Box::leak(c.id.into_boxed_str());
                    let label: &'static str = Box::leak(c.label.into_boxed_str());
                    (id, label, c.args)
                })
                .collect()
        })
        .iter()
        .map(|(id, label, args)| ShellEntry {
            id,
            label,
            args: args.clone(),
        })
        .collect()
}

fn parse_custom_shells(text: &str) -> Vec<CustomShell> {
    let Ok(list) = serde_json::from_str::<Vec<CustomShell>>(text) else {
        log::warn!("bethterm: shells.json is not a valid list of {{id,label,args}}; ignored");
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    list.into_iter()
        .filter(|c| {
            !c.args.is_empty()
                && !c.label.trim().is_empty()
                && !c.id.is_empty()
                && c.id
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || "._-".contains(ch))
                && seen.insert(c.id.clone())
        })
        .collect()
}

// =============================================================================
// Cross-platform: menu item model
// =============================================================================

/// The set of commands the menu can dispatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeCommand {
    /// New tab with `default_shells()[idx]`.
    NewTab(usize),
    /// Split the current pane right with the default shell.
    SplitRight,
    /// Split the current pane down with the default shell.
    SplitDown,
    /// Split the current pane right with `default_shells()[idx]`.
    ///
    /// Dispatched when the user clicks an item inside the "Split right"
    /// submenu. Replaces the old single-entry `SplitRight` (kept for
    /// the non-Windows stub path).
    SplitRightWithShell(usize),
    /// Split the current pane down with `default_shells()[idx]`.
    SplitDownWithShell(usize),
    /// Close the focused pane.
    ClosePane,
    /// Copy the current selection to the OS clipboard (and primary
    /// selection on X11/Wayland). Equivalent to the upstream
    /// `CopyTo(ClipboardAndPrimarySelection)` assignment.
    CopySelection,
    /// Paste from the OS clipboard into the focused pane. Equivalent
    /// to the upstream `PasteFrom(Clipboard)` assignment.
    Paste,
    /// Select every line in the pane's scrollback + viewport.
    /// Mapped to the upstream `KeyAssignment::SelectAll` (added in
    /// patch 0014).
    SelectAll,
    /// Save the pane's scrollback to a file picked via a native Win32
    /// "Save As" dialog. Implemented by
    /// `wtinator::save_scrollback::save_to_file`. The wID is just an
    /// opaque index — the actual handler is `SaveScrollback`, not a
    /// `KeyAssignment`.
    SaveScrollback,
    /// Open Beth Studio SFTP window for this SSH pane (patch 0188).
    OpenSftp,
    /// Apply a built-in color scheme (patch 0016 + 0017). The
    /// `usize` selects from the `ThemeId` enum.
    SetTheme(ThemeId),
    /// Open the user's `~/.config/wezterm/` (or `%USERPROFILE%\.wezterm`)
    /// directory in the OS file manager so the user can drop a custom
    /// `*.toml` color scheme file into the `colors/` subfolder.
    OpenThemesFolder,
    /// WezTerminator (patch 0022): paste the clipboard image as
    /// an iTerm2 inline-image escape (OSC 1337) on the focused
    /// pane. Implemented by `wtinator::image_paste::paste_image_to_pane`.
    PasteImage,
    /// WezTerminator (patch 0025): capture the terminal window
    /// and save it as a JPEG through a native Save-As dialog.
    ScreenshotSave,
    /// WezTerminator (patch 0025): capture the terminal window
    /// and copy it to the Windows clipboard as a bitmap.
    ScreenshotCopy,
    /// Move the whole tab without recreating its panes/processes. `None`
    /// creates a new window; `Some` targets an existing mux window.
    MoveTabToWindow(Option<mux::window::WindowId>),
    /// WezTerminator (patch 0028): move the focused pane into
    /// a new tab belonging to the named group. `None` means
    /// "no group" (the new tab is created with
    /// `group_name = None`, putting it in the default bucket).
    /// The group name is also used as the wID address space
    /// (`0x6001..=0x60FF`) — the submenu builder enumerates
    /// the current groups via `wtinator::groups::list_groups`
    /// and assigns each one a stable hash-derived wID.
    MovePaneToGroup(Option<String>),
    /// WezTerminator (patch 0030): open the Win32 input
    /// prompt to set the per-terminal header text. The
    /// handler lives in `wtinator::header::prompt_rename`.
    /// Fixed wID `0x6100` — well outside the
    /// `MovePaneToGroup` range so there is no collision.
    RenameTerminal,
    /// WezTerminator (patch 0031): open the Win32 input
    /// prompt to set the per-tab user title (a sticky
    /// override of the OSC 0/2 title). The handler lives
    /// in `mouseevent.rs` and uses the same
    /// `wtinator::header::win32_prompt::run` dialog as
    /// `RenameTerminal`. Fixed wID `0x6200` — well outside
    /// the `RenameTerminal` range so there is no collision.
    RenameTab,
    /// WezTerminator (patch 0085): open the Win32 input
    /// prompt to set a sticky per-window name. Fixed wID
    /// `0x6700`, outside the `MoveTabToWindow` range
    /// `0x6600..=0x66FF`.
    RenameWindow,
    /// Taskbar icon color (patch 0151). `0` is the application
    /// icon. `1..` indexes [`crate::taskbar_icon::SWATCHES`].
    /// wIDs `0x6820..=0x682F`.
    SetTaskbarIcon(u8),
    /// WezTerminator (patch 0034): launch the
    /// `wtinator-config` companion app (planned for
    /// patch 0034.5). The MVP data model and IPC
    /// contract are in place; the actual React
    /// app + WebView2 host is follow-up work.
    /// Fixed wID `0x6300` — well outside the
    /// `RenameTab` range so there is no collision.
    OpenConfigApp,
    /// WezTerminator (patch 0039): grow the right-clicked pane's
    /// font (per-pane font scale). Maps to
    /// `KeyAssignment::IncreasePaneFontSize`, performed on the pane
    /// under the cursor. Fixed wID `0x6400`.
    IncreasePaneFontSize,
    /// WezTerminator (patch 0039): shrink the right-clicked pane's
    /// font. wID `0x6401`.
    DecreasePaneFontSize,
    /// WezTerminator (patch 0039): reset the right-clicked pane's
    /// font to the window size. wID `0x6402`.
    ResetPaneFontSize,
    /// WezTerminator (patch 0065): toggle per-tab "list mode" (left rail
    /// listing all panes + 1-2 panes side by side). Maps to
    /// `KeyAssignment::ToggleListMode`, performed on the current tab.
    /// Fixed wID `0x6500` — well outside the per-pane font-size range.
    ToggleListMode,
    /// Separator (no dispatch).
    Separator,
    /// Submenu title (no dispatch — the submenu's own items carry the
    /// wIDs).
    Submenu(&'static str),
}

/// The first wID in the `MovePaneToGroup` address space.
/// The first slot (`0x6000`) is reserved for the sentinel
/// "no group" entry so that a freshly-built submenu can always
/// include it as the last item.
pub const MOVE_PANE_GROUP_W_ID_BASE: u16 = 0x6000;
/// Number of wID slots reserved for `MovePaneToGroup`. 255 is
/// plenty: a typical user has 3-10 groups, and even power users
/// rarely exceed a few dozen. If a session ever has more than
/// 255 distinct group names, the submenu builder truncates
/// with a warning (see `move_pane_submenu_items`).
pub const MOVE_PANE_GROUP_W_ID_RANGE: u16 = 0x00FF;

/// WezTerminator (patch 0028): map a group name to a wID in
/// the `0x6001..=0x60FF` range. `None` (or empty string) maps
/// to `0x6000` — the "no group" sentinel slot. The hash is
/// the lower 8 bits of the FNV-1a 32-bit hash of the
/// normalized name, plus 1 (so we never collide with 0x6000).
///
/// The mapping is deterministic and stable for a given group
/// name, but it is **not** required to be unique — if two
/// groups hash to the same slot, only the first one is
/// dispatchable and the others become unreachable. This is
/// acceptable for a v1 with the 8-bit address space; if it
/// ever becomes a real problem we can widen the range (the
/// 0x6xxx range is otherwise unused).
pub fn group_name_to_w_id(name: Option<&str>) -> u16 {
    let Some(name) = name else {
        return MOVE_PANE_GROUP_W_ID_BASE;
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return MOVE_PANE_GROUP_W_ID_BASE;
    }
    // FNV-1a 32-bit. We only need the bottom 8 bits and a
    // value in 1..=255 (so we never collide with 0x6000).
    let mut hash: u32 = 0x811c_9dc5;
    for b in trimmed.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let slot = ((hash & 0xff) as u16) % MOVE_PANE_GROUP_W_ID_RANGE + 1;
    MOVE_PANE_GROUP_W_ID_BASE + slot
}

impl NativeCommand {
    /// Stable, dense `u16` command id for this command.
    pub fn w_id(&self) -> u16 {
        match *self {
            NativeCommand::NewTab(i) => 0x1000 + (i as u16) + 1,
            NativeCommand::SplitRight => 0x2001,
            NativeCommand::SplitDown => 0x2002,
            // 0x3001..=0x30FF = split right with shells[0..254]
            // 0x3101..=0x31FF = split down  with shells[0..254]
            NativeCommand::SplitRightWithShell(i) => 0x3000 + (i as u16) + 1,
            NativeCommand::SplitDownWithShell(i) => 0x3100 + (i as u16) + 1,
            NativeCommand::ClosePane => 0x2003,
            NativeCommand::CopySelection => 0x4001,
            NativeCommand::Paste => 0x4002,
            NativeCommand::SelectAll => 0x4003,
            NativeCommand::SaveScrollback => 0x4004,
            NativeCommand::OpenSftp => 0x4005,
            // 0x5001..=0x5003 = SetTheme for the 3 built-in themes.
            // The mapping ThemeId -> wID is contiguous:
            //   VsCodeLight           = 0x5001
            //   VsCodeDark            = 0x5002
            //   WindowsTerminalDark   = 0x5003
            NativeCommand::SetTheme(theme) => 0x5000 + 1 + theme as u16,
            NativeCommand::OpenThemesFolder => 0x5004,
            // 0x5005 = PasteImage (clipboard image -> OSC 1337)
            // Reserve the range 0x5005..=0x500F for future
            // image-related entries (paste-as-PDF, paste-as-SVG,
            // etc.) if they are needed.
            NativeCommand::PasteImage => 0x5005,
            NativeCommand::ScreenshotSave => 0x5006,
            NativeCommand::ScreenshotCopy => 0x5007,
            NativeCommand::MoveTabToWindow(None) => 0x6600,
            NativeCommand::MoveTabToWindow(Some(window_id)) => {
                let mut windows = mux::Mux::try_get()
                    .map(|mux| mux.iter_windows())
                    .unwrap_or_default();
                windows.sort_unstable();
                windows
                    .iter()
                    .position(|id| *id == window_id)
                    .and_then(|idx| u16::try_from(idx).ok())
                    .map(|idx| 0x6601 + idx)
                    .unwrap_or(0)
            }
            // 0x6001..=0x60FF = MovePaneToGroup with the group
            // name hash-mod-255 as the offset. The first slot
            // (0x6000) is reserved for the sentinel "no group"
            // entry. The actual hash is computed by
            // `group_name_to_w_id` below; the values here are
            // fallbacks for the (rare) case where someone
            // builds a NativeCommand by hand without going
            // through the submenu builder.
            NativeCommand::MovePaneToGroup(ref name) => group_name_to_w_id(name.as_deref()),
            // 0x6100 = RenameTerminal (patch 0030). Fixed
            // wID, well outside the `MovePaneToGroup` range
            // so there is no collision.
            NativeCommand::RenameTerminal => 0x6100,
            // 0x6200 = RenameTab (patch 0031). Fixed wID,
            // well outside the `RenameTerminal` range so
            // there is no collision.
            NativeCommand::RenameTab => 0x6200,
            // 0x6700 = RenameWindow (patch 0085). Fixed wID,
            // outside the MoveTabToWindow range 0x6600..=0x66FF.
            NativeCommand::RenameWindow => 0x6700,
            NativeCommand::SetTaskbarIcon(slot) => {
                crate::taskbar_icon::WID_BASE + slot as u16
            }
            // 0x6300 = OpenConfigApp (patch 0034). Fixed
            // wID, well outside the `RenameTab` range so
            // there is no collision.
            NativeCommand::OpenConfigApp => 0x6300,
            // 0x6400..=0x6402 = per-pane font size (patch 0039),
            // well outside the OpenConfigApp slot.
            NativeCommand::IncreasePaneFontSize => 0x6400,
            NativeCommand::DecreasePaneFontSize => 0x6401,
            NativeCommand::ResetPaneFontSize => 0x6402,
            // 0x6500 = ToggleListMode (patch 0065), outside the font range.
            NativeCommand::ToggleListMode => 0x6500,
            NativeCommand::Separator | NativeCommand::Submenu(_) => 0, // unused
        }
    }
}

/// One menu item, before it is converted to an `HMENU` entry.
#[derive(Debug, Clone)]
pub struct NativeMenuItem {
    pub w_id: u16,
    pub kind: NativeCommand,
    pub label: String,
    pub enabled: bool,
    /// Optional small icon drawn to the left of the label. The
    /// value is an identifier into `wtinator::menu_icons`; the
    /// Windows-only `show_at` resolves it to an `HBITMAP` at the
    /// moment the menu is built. The `MenuIconId` enum is
    /// re-exported as a type alias on non-Windows targets so the
    /// struct shape stays identical across platforms.
    pub icon: Option<MenuIconId>,
}

#[cfg(windows)]
use crate::menu_icons::MenuIconId;

#[cfg(not(windows))]
/// Non-Windows stub: every item is uniconed.
pub type MenuIconId = ();

/// A menu entry — either a terminal item (with a `wID` that dispatches
/// to a `KeyAssignment`) or a submenu that opens a cascading HMENU.
///
/// Used by the Windows `show_at` implementation to build the final
/// `HMENU` tree. On non-Windows targets the upstream `InputSelector`
/// overlay path does not support submenus, so the non-Windows stub
/// flattens submenus to a no-op (see `platform::show_at` stub).
#[derive(Debug, Clone)]
pub enum MenuEntry {
    Item(NativeMenuItem),
    Submenu {
        /// Display label shown on the parent menu — appears with a
        /// `▶` arrow in native Win32 menus.
        label: String,
        /// The child items rendered inside the submenu.
        items: Vec<NativeMenuItem>,
        /// WezTerminator (patch 0043): optional icon drawn to the left
        /// of the submenu's parent entry (e.g. Split right / Split down),
        /// just like a leaf item's icon. `None` = no icon.
        icon: Option<MenuIconId>,
    },
    Separator,
}

// =============================================================================
// Cross-platform: dispatch a `wID` to a `KeyAssignment`
// =============================================================================

/// A menu click can result in either a `KeyAssignment` (the common
/// case — Copy / Paste / SelectAll / Split / Close pane / etc.) or
/// one of a few WezTerminator-specific actions that need the live
/// `MuxPane` rather than a `KeyAssignment`. `classify` is the
/// single-entry point used by `wezterm-gui`'s
/// `schedule_native_menu` to route the click.
#[derive(Debug, Clone)]
pub enum DispatchAction {
    /// A `KeyAssignment` that the upstream GUI will perform on the
    /// focused pane.
    Assignment(KeyAssignment),
    /// Save the focused pane's scrollback to a file (patch 0015).
    /// The handler lives in `wtinator::save_scrollback`.
    SaveScrollback,
    /// Open Beth Studio SFTP window for a saved SSH host (patch 0188).
    OpenSftp,
    /// Apply one of the built-in `ThemeId`s to the current window
    /// (patch 0016 + 0017). The handler builds the matching
    /// `ColorPalette` and posts a `TermWindowNotif::Apply` to the
    /// GUI thread.
    SetTheme(ThemeId),
    /// Open the user's wezterm config dir in the OS file manager
    /// (patch 0017). The handler is a `std::process::Command::new`
    /// against `explorer.exe` on Windows and `xdg-open` elsewhere.
    OpenThemesFolder,
    /// WezTerminator (patch 0022): paste the clipboard image as
    /// an iTerm2 inline-image escape (OSC 1337) on the focused
    /// pane. The handler lives in `wtinator::image_paste` and
    /// requires the live `MuxPane` to write the bytes to.
    PasteImage,
    /// Save a screenshot of the terminal window as JPEG.
    ScreenshotSave,
    /// Copy a screenshot of the terminal window to the clipboard.
    ScreenshotCopy,
    /// Move the tab containing the clicked pane to a new/existing window.
    MoveTabToWindow(Option<mux::window::WindowId>),
    /// WezTerminator (patch 0028): move the focused pane into
    /// a new tab in the named group. The `Option<String>`
    /// mirrors `NativeCommand::MovePaneToGroup`. The handler
    /// is in `wtinator::groups::move_pane_to_group` (called
    /// from `wezterm-gui/src/termwindow/mouseevent.rs`).
    MovePaneToGroup(Option<String>),
    /// WezTerminator (patch 0030): open the Win32 input
    /// prompt to set the per-terminal header text. The
    /// handler is in `wezterm-gui/src/termwindow/mouseevent.rs`
    /// (it needs the live `pane_id` and `hwnd`, which the
    /// generic `DispatchAction` enum does not carry — the
    /// `mouseevent.rs` site already has both via the
    /// `pane_id` it closed over when scheduling the menu).
    RenameTerminal,
    /// WezTerminator (patch 0031): open the Win32 input
    /// prompt to set the per-tab user title (sticky
    /// override of the OSC 0/2 title). Handler is in
    /// `wezterm-gui/src/termwindow/mouseevent.rs`; it
    /// uses the same `wtinator::header::win32_prompt::run`
    /// dialog as `RenameTerminal`.
    RenameTab,
    /// WezTerminator (patch 0085): open the Win32 input
    /// prompt to set a sticky per-window name. Handler
    /// is in `wezterm-gui/src/termwindow/mouseevent.rs`.
    RenameWindow,
    /// Color of this window's taskbar icon (patch 0151).
    /// `0` restores the application icon.
    SetTaskbarIcon(u8),
    /// WezTerminator (patch 0034): launch the
    /// `wtinator-config` companion app. Handler is
    /// in `wezterm-gui/src/termwindow/mouseevent.rs`;
    /// for the MVP it just shows a Win32 messagebox
    /// saying "coming soon" because the actual
    /// standalone exe lands in patch 0034.5.
    OpenConfigApp,
}

/// Short name for the life log. Avoids dumping a whole key assignment.
pub fn describe_action(action: &DispatchAction) -> String {
    match action {
        DispatchAction::Assignment(_) => "key assignment".to_string(),
        DispatchAction::SaveScrollback => "save scrollback".to_string(),
        DispatchAction::OpenSftp => "open sftp".to_string(),
        DispatchAction::SetTheme(_) => "set theme".to_string(),
        DispatchAction::OpenThemesFolder => "open themes folder".to_string(),
        DispatchAction::PasteImage => "paste image".to_string(),
        DispatchAction::ScreenshotSave => "screenshot save".to_string(),
        DispatchAction::ScreenshotCopy => "screenshot copy".to_string(),
        DispatchAction::MoveTabToWindow(_) => "move tab to window".to_string(),
        DispatchAction::MovePaneToGroup(_) => "move pane to group".to_string(),
        DispatchAction::RenameTerminal => "rename terminal".to_string(),
        DispatchAction::RenameTab => "rename tab".to_string(),
        DispatchAction::RenameWindow => "rename window".to_string(),
        DispatchAction::SetTaskbarIcon(slot) => format!("taskbar icon color {slot}"),
        DispatchAction::OpenConfigApp => "open settings".to_string(),
    }
}

/// Resolve a `wID` from a native menu to a dispatchable action. Used
/// by the patched upstream `wezterm-gui` mouse handler.
pub fn classify(w_id: u16) -> Option<DispatchAction> {
    match w_id {
        0x4004 => Some(DispatchAction::SaveScrollback),
        0x4005 => Some(DispatchAction::OpenSftp),
        0x5001 => Some(DispatchAction::SetTheme(ThemeId::VsCodeLight)),
        0x5002 => Some(DispatchAction::SetTheme(ThemeId::VsCodeDark)),
        0x5003 => Some(DispatchAction::SetTheme(ThemeId::WindowsTerminalDark)),
        0x5004 => Some(DispatchAction::OpenThemesFolder),
        0x5005 => Some(DispatchAction::PasteImage),
        0x5006 => Some(DispatchAction::ScreenshotSave),
        0x5007 => Some(DispatchAction::ScreenshotCopy),
        0x6600 => Some(DispatchAction::MoveTabToWindow(None)),
        w if (0x6601..=0x66ff).contains(&w) => {
            let index = (w - 0x6601) as usize;
            let mut windows = mux::Mux::try_get()
                .map(|mux| mux.iter_windows())
                .unwrap_or_default();
            windows.sort_unstable();
            windows
                .get(index)
                .copied()
                .map(|id| DispatchAction::MoveTabToWindow(Some(id)))
        }
        // Patch 0030: 0x6100 = RenameTerminal. Fixed
        // wID, well outside the MovePaneToGroup range.
        0x6100 => Some(DispatchAction::RenameTerminal),
        // Patch 0031: 0x6200 = RenameTab. Fixed wID,
        // well outside the RenameTerminal range.
        0x6200 => Some(DispatchAction::RenameTab),
        // Patch 0085: 0x6700 = RenameWindow.
        0x6700 => Some(DispatchAction::RenameWindow),
        w if (crate::taskbar_icon::WID_BASE..=crate::taskbar_icon::WID_BASE + 0x0f).contains(&w) => {
            Some(DispatchAction::SetTaskbarIcon((w - crate::taskbar_icon::WID_BASE) as u8))
        }
        // Patch 0034: 0x6300 = OpenConfigApp. Fixed
        // wID, well outside the RenameTab range.
        0x6300 => Some(DispatchAction::OpenConfigApp),
        // Patch 0028: 0x6000..=0x60FF = MovePaneToGroup. The
        // wID is a hash of the group name (see
        // `group_name_to_w_id`). We reverse the mapping by
        // enumerating the live groups via
        // `wtinator::groups::list_groups()` and matching each
        // one's wID. This runs on the helper thread inside
        // `schedule_native_menu` (post WM_COMMAND), so the
        // `Mux::get()` lock is safe to take here.
        w if (MOVE_PANE_GROUP_W_ID_BASE..=MOVE_PANE_GROUP_W_ID_BASE + MOVE_PANE_GROUP_W_ID_RANGE)
            .contains(&w) =>
        {
            let target = if w == MOVE_PANE_GROUP_W_ID_BASE {
                None
            } else {
                w_id_to_group_name(w)
            };
            Some(DispatchAction::MovePaneToGroup(target))
        }
        _ => dispatch_native(w_id).map(DispatchAction::Assignment),
    }
}

/// Inverse of `group_name_to_w_id`: given a wID in the
/// `0x6001..=0x60FF` range, find the live group name that
/// hashes to it. Returns `None` if no live group matches
/// (the wID is stale — the group was deleted between menu
/// build and click). The handler treats that as a no-op.
fn w_id_to_group_name(w_id: u16) -> Option<String> {
    if !(MOVE_PANE_GROUP_W_ID_BASE + 1
        ..=MOVE_PANE_GROUP_W_ID_BASE + MOVE_PANE_GROUP_W_ID_RANGE)
        .contains(&w_id)
    {
        return None;
    }
    let listing = crate::groups::list_groups();
    // Skip the "(no group)" sentinel when matching — that one
    // owns the 0x6000 slot, not the hash range.
    listing
        .names
        .into_iter()
        .find(|n| n != crate::groups::NO_GROUP_LABEL && group_name_to_w_id(Some(n)) == w_id)
}

/// Label shown for one destination in the "Move tab to" submenu.
/// A user-chosen window name is the primary identifier; unnamed
/// windows fall back to the auto title, workspace, or a numbered
/// placeholder.
pub fn window_destination_label(
    index: usize,
    user_title: Option<&str>,
    title: &str,
    workspace: &str,
) -> String {
    if let Some(name) = user_title.map(str::trim).filter(|s| !s.is_empty()) {
        return name.to_string();
    }
    let description = if !title.is_empty() {
        title
    } else if !workspace.is_empty() {
        workspace
    } else {
        return format!("Window {}", index + 1);
    };
    format!("Window {} — {}", index + 1, description)
}

/// Map a `wID` from a native menu to a `KeyAssignment`. Used by the
/// patched upstream `wezterm-gui` mouse handler.
///
/// `classify` is the preferred entry point — it returns the full
/// `DispatchAction` enum including the `SaveScrollback` action that
/// is not a `KeyAssignment`. This function remains for callers that
/// only need assignments.
pub fn dispatch_native(w_id: u16) -> Option<KeyAssignment> {
    let cmd = match w_id {
        0x1001..=0x10FF => NativeCommand::NewTab((w_id - 0x1001) as usize),
        0x2001 => NativeCommand::SplitRight,
        0x2002 => NativeCommand::SplitDown,
        0x2003 => NativeCommand::ClosePane,
        0x3001..=0x30FF => NativeCommand::SplitRightWithShell((w_id - 0x3001) as usize),
        0x3101..=0x31FF => NativeCommand::SplitDownWithShell((w_id - 0x3101) as usize),
        0x4001 => NativeCommand::CopySelection,
        0x4002 => NativeCommand::Paste,
        0x4003 => NativeCommand::SelectAll,
        0x6400 => NativeCommand::IncreasePaneFontSize,
        0x6401 => NativeCommand::DecreasePaneFontSize,
        0x6402 => NativeCommand::ResetPaneFontSize,
        0x6500 => NativeCommand::ToggleListMode,
        _ => return None,
    };
    match cmd {
        NativeCommand::NewTab(i) => default_shells().get(i).map(shell_to_key_assignment),
        NativeCommand::SplitRight => Some(KeyAssignment::SplitHorizontal(SpawnCommand {
            args: None,
            ..Default::default()
        })),
        NativeCommand::SplitDown => Some(KeyAssignment::SplitVertical(SpawnCommand {
            args: None,
            ..Default::default()
        })),
        NativeCommand::SplitRightWithShell(i) => default_shells()
            .get(i)
            .map(|s| split_with_shell(s, SplitDir::Right)),
        NativeCommand::SplitDownWithShell(i) => default_shells()
            .get(i)
            .map(|s| split_with_shell(s, SplitDir::Down)),
        NativeCommand::ClosePane => Some(KeyAssignment::CloseCurrentPane { confirm: true }),
        NativeCommand::CopySelection => Some(KeyAssignment::CopyTo(
            ClipboardCopyDestination::ClipboardAndPrimarySelection,
        )),
        NativeCommand::Paste => Some(KeyAssignment::PasteFrom(ClipboardPasteSource::Clipboard)),
        NativeCommand::SelectAll => Some(KeyAssignment::SelectAll),
        // SaveScrollback is not a KeyAssignment; it is routed by
        // `classify` before this match is reached. If a caller does
        // invoke `dispatch_native` directly with the SaveScrollback
        // wID, return None (the caller is expected to use `classify`).
        NativeCommand::SaveScrollback => None,
        NativeCommand::OpenSftp => None,
        // Same story for SetTheme and OpenThemesFolder and
        // PasteImage — they are routed by `classify` before
        // this match is reached.
        NativeCommand::SetTheme(_) => None,
        NativeCommand::OpenThemesFolder => None,
        NativeCommand::PasteImage => None,
        NativeCommand::ScreenshotSave => None,
        NativeCommand::ScreenshotCopy => None,
        NativeCommand::MoveTabToWindow(_) => None,
        // Patch 0028: MovePaneToGroup is routed by `classify`
        // before this match is reached. If a caller does
        // invoke `dispatch_native` directly, return None.
        NativeCommand::MovePaneToGroup(_) => None,
        // Patch 0030: RenameTerminal is routed by
        // `classify` before this match is reached. Same
        // pattern as the other WezTerminator-specific
        // actions.
        NativeCommand::RenameTerminal => None,
        // Patch 0031: RenameTab follows the same pattern
        // as RenameTerminal.
        NativeCommand::RenameTab => None,
        // Patch 0085: RenameWindow follows the same pattern.
        NativeCommand::RenameWindow => None,
        NativeCommand::SetTaskbarIcon(_) => None,
        // Patch 0034: OpenConfigApp follows the same
        // pattern as RenameTab.
        NativeCommand::OpenConfigApp => None,
        // Patch 0039: per-pane font size maps straight to the
        // upstream key assignments (performed on the right-clicked
        // pane via `PerformAssignment { pane_id, .. }`).
        NativeCommand::IncreasePaneFontSize => Some(KeyAssignment::IncreasePaneFontSize),
        NativeCommand::DecreasePaneFontSize => Some(KeyAssignment::DecreasePaneFontSize),
        NativeCommand::ResetPaneFontSize => Some(KeyAssignment::ResetPaneFontSize),
        // Patch 0065: ToggleListMode maps straight to the upstream key
        // assignment (performed on the current tab via PerformAssignment).
        NativeCommand::ToggleListMode => Some(KeyAssignment::ToggleListMode),
        NativeCommand::Separator | NativeCommand::Submenu(_) => None,
    }
}

#[derive(Copy, Clone)]
enum SplitDir {
    Right,
    Down,
}

fn split_with_shell(shell: &ShellEntry, dir: SplitDir) -> KeyAssignment {
    let spawn = SpawnCommand {
        label: Some(format!("Split — {}", shell.label)),
        args: Some(shell.args.clone()),
        ..Default::default()
    };
    match dir {
        SplitDir::Right => KeyAssignment::SplitHorizontal(spawn),
        SplitDir::Down => KeyAssignment::SplitVertical(spawn),
    }
}

fn shell_to_key_assignment(shell: &ShellEntry) -> KeyAssignment {
    let spawn = SpawnCommand {
        label: Some(shell.label.to_string()),
        args: Some(shell.args.clone()),
        ..Default::default()
    };
    KeyAssignment::SpawnCommandInNewTab(spawn)
}

// =============================================================================
// Windows: native HMENU implementation (via windows-sys)
// =============================================================================

#[cfg(windows)]
pub mod platform {
    //! Build a native Win32 popup menu and show it via TrackPopupMenuEx.
    //!
    //! The caller (the patched `wezterm-gui` mouse handler) calls
    //! `show_at(hwnd, items)` with the items to render. `show_at`
    //! creates a root `HMENU` via `CreatePopupMenu`, recursively creates
    //! sub-HMENUs for `MenuEntry::Submenu` entries via the `MF_POPUP`
    //! flag of `AppendMenuW`, and shows the result via
    //! `TrackPopupMenuEx`. When the user clicks an item,
    //! `TrackPopupMenuEx` returns the `wID` of the chosen item. The
    //! caller dispatches the `KeyAssignment` via
    //! `wtinator::context_menu::dispatch_native(wid)`.

    use super::{default_shells, MenuEntry, NativeCommand, NativeMenuItem};
    use crate::menu_icons::MenuIconId;
    use windows_sys::core::PWSTR;
    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::Graphics::Gdi::HBITMAP;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, DestroyMenu, EnableMenuItem, GetCursorPos, InsertMenuItemW,
        SetForegroundWindow, TrackPopupMenuEx, MENUITEMINFOW, MFS_DISABLED, MF_DISABLED,
        MF_ENABLED, MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING, MIIM_BITMAP, MIIM_ID, MIIM_STATE,
        MIIM_STRING, MIIM_SUBMENU, TPM_LEFTALIGN, TPM_NONOTIFY, TPM_RETURNCMD, TPM_VERPOSANIMATION,
    };

    /// Hotkey letter for shell index `i`. Decorative — the menu does
    /// not actually dispatch by hotkey, only by mouse click.
    fn id_hotkey(i: usize) -> String {
        format!(
            "&{}",
            match i {
                0 => '1',
                1 => '2',
                2 => '3',
                3 => '4',
                4 => '5',
                5 => '6',
                _ => '7',
            }
        )
    }

    /// Build a single shell item (used by both the top-level shell
    /// picker and the split-direction submenus).
    fn shell_item(i: usize, shell: &super::ShellEntry) -> NativeMenuItem {
        NativeMenuItem {
            w_id: NativeCommand::NewTab(i).w_id(),
            kind: NativeCommand::NewTab(i),
            label: format!("Open {}\t{}", shell.label, id_hotkey(i)),
            enabled: true,
            icon: Some(icon_for_shell(i)),
        }
    }

    /// Map a shell index to its menu icon. Mirrors the order of
    /// `default_shells()` in `wtinator::context_menu`.
    fn icon_for_shell(i: usize) -> MenuIconId {
        use crate::menu_icons::MenuIconId;
        match i {
            0 => MenuIconId::Cmd,
            1 => MenuIconId::PowerShell,
            2 => MenuIconId::PowerShell7,
            3 => MenuIconId::WslDefault,
            4 => MenuIconId::WslUbuntu,
            5 => MenuIconId::GitBash,
            _ => MenuIconId::Cmd,
        }
    }

    /// Build a single "split <dir> with <shell>" item (used by the
    /// split-direction submenus).
    fn split_with_shell_item(
        i: usize,
        shell: &super::ShellEntry,
        kind: NativeCommand,
    ) -> NativeMenuItem {
        NativeMenuItem {
            w_id: kind.w_id(),
            kind,
            label: format!("{}\t{}", shell.label, id_hotkey(i)),
            enabled: true,
            icon: Some(icon_for_shell(i)),
        }
    }

    /// Build the items that appear inside each split-direction submenu.
    fn split_submenu_items(direction: SplitDirection) -> Vec<NativeMenuItem> {
        let shells = default_shells();
        shells
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let kind = match direction {
                    SplitDirection::Right => NativeCommand::SplitRightWithShell(i),
                    SplitDirection::Down => NativeCommand::SplitDownWithShell(i),
                };
                split_with_shell_item(i, s, kind)
            })
            .collect()
    }

    #[derive(Copy, Clone)]
    enum SplitDirection {
        Right,
        Down,
    }

    /// Build the "Open a new terminal" picker items.
    pub fn shell_picker_items() -> Vec<MenuEntry> {
        default_shells()
            .iter()
            .enumerate()
            .map(|(i, s)| MenuEntry::Item(shell_item(i, s)))
            .collect()
    }

    /// Build the "Split the current pane" picker items. Each entry is
    /// a submenu listing the available shells — clicking a shell
    /// inside the submenu dispatches `SplitHorizontal` or
    /// `SplitVertical` with the chosen shell's `SpawnCommand`.
    pub fn split_picker_items() -> Vec<MenuEntry> {
        use crate::menu_icons::MenuIconId;
        vec![
            MenuEntry::Submenu {
                label: "Split &right".to_string(),
                items: split_submenu_items(SplitDirection::Right),
                icon: Some(MenuIconId::SplitRight),
            },
            MenuEntry::Submenu {
                label: "Split &down".to_string(),
                items: split_submenu_items(SplitDirection::Down),
                icon: Some(MenuIconId::SplitDown),
            },
        ]
    }

    fn taskbar_icon_items() -> Vec<NativeMenuItem> {
        let mut items = vec![NativeMenuItem {
            w_id: NativeCommand::SetTaskbarIcon(0).w_id(),
            kind: NativeCommand::SetTaskbarIcon(0),
            label: "Padrão".to_string(),
            enabled: true,
            icon: None,
        }];
        for (i, swatch) in crate::taskbar_icon::SWATCHES.iter().enumerate() {
            let slot = (i as u8).saturating_add(1);
            items.push(NativeMenuItem {
                w_id: NativeCommand::SetTaskbarIcon(slot).w_id(),
                kind: NativeCommand::SetTaskbarIcon(slot),
                label: swatch.label.to_string(),
                enabled: true,
                icon: None,
            });
        }
        items
    }

    /// Build the "Full menu" items: shells, then a clipboard group
    /// (copy / paste), then splits (with shell submenus), then close
    /// pane. The clipboard group sits between the shells and the
    /// splits because clipboard actions are the most frequent ones
    /// performed *on the existing content* (vs. splits which change
    /// layout).
    pub fn full_menu_items() -> Vec<MenuEntry> {
        use crate::menu_icons::MenuIconId;
        let mut items = vec![];

        // WezTerminator (patch 0043): "Configure this terminal…" sits at
        // the TOP of the menu. It is now the single entry point for the
        // per-terminal theme, font FAMILY and font SIZE; the old in-menu
        // "Theme", "Font size" and "Move pane to" submenus were removed
        // in favour of it (their builders remain for tests / dispatch).
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x6300,
            kind: NativeCommand::OpenConfigApp,
            label: "&Configure this terminal…".to_string(),
            enabled: true,
            icon: Some(MenuIconId::OpenFolder),
        }));
        items.push(MenuEntry::Separator);

        // Open a new tab in one of the available shells.
        items.extend(shell_picker_items());
        // Split right / Split down (now icon-tagged submenus).
        items.extend(split_picker_items());

        // WezTerminator (patch 0065): toggle the list-mode rail (left rail
        // listing every pane + 1-2 side by side). Acts on the current tab.
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x6500,
            kind: NativeCommand::ToggleListMode,
            label: "Toggle &list mode\tCtrl+Shift+L".to_string(),
            enabled: true,
            icon: Some(MenuIconId::SplitRight),
        }));

        items.push(MenuEntry::Separator);

        // Clipboard / content actions.
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x4001,
            kind: NativeCommand::CopySelection,
            label: "&Copy selection".to_string(),
            enabled: true,
            icon: Some(MenuIconId::Copy),
        }));
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x4002,
            kind: NativeCommand::Paste,
            label: "&Paste".to_string(),
            enabled: true,
            icon: Some(MenuIconId::Paste),
        }));
        // WezTerminator (patch 0022): paste the clipboard image as an
        // iTerm2 inline-image escape on the focused pane.
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x5005,
            kind: NativeCommand::PasteImage,
            label: "Paste &image from clipboard".to_string(),
            enabled: true,
            icon: Some(MenuIconId::PasteImage),
        }));
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x4003,
            kind: NativeCommand::SelectAll,
            label: "Select &all".to_string(),
            enabled: true,
            icon: Some(MenuIconId::SelectAll),
        }));
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x4004,
            kind: NativeCommand::SaveScrollback,
            label: "Save scrollback as…".to_string(),
            enabled: true,
            icon: Some(MenuIconId::SaveScrollback),
        }));
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x4005,
            kind: NativeCommand::OpenSftp,
            label: "Transfer files (SFTP)…".to_string(),
            enabled: true,
            icon: Some(MenuIconId::SaveScrollback),
        }));
        // WezTerminator (patch 0031): "Rename tab…" sets a sticky user
        // title on the focused tab.
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x6200,
            kind: NativeCommand::RenameTab,
            label: "Rename &tab…".to_string(),
            enabled: true,
            icon: Some(MenuIconId::RenameTab),
        }));
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x6700,
            kind: NativeCommand::RenameWindow,
            label: "Rename &window…".to_string(),
            enabled: true,
            icon: Some(MenuIconId::RenameTab),
        }));
        items.push(MenuEntry::Submenu {
            label: "Cor do &ícone".to_string(),
            items: taskbar_icon_items(),
            icon: None,
        });
        items.push(MenuEntry::Submenu {
            label: "&Screenshot".to_string(),
            items: screenshot_submenu_items(),
            icon: None,
        });

        items.push(MenuEntry::Separator);
        items.push(MenuEntry::Item(NativeMenuItem {
            w_id: 0x2003,
            kind: NativeCommand::ClosePane,
            label: "&Close pane".to_string(),
            enabled: true,
            icon: Some(MenuIconId::ClosePane),
        }));
        items
    }

    /// Full menu used specifically from a tab. Adds a dynamic destination
    /// submenu while retaining the existing pane/tab actions.
    pub fn tab_menu_items(source_window_id: mux::window::WindowId) -> Vec<MenuEntry> {
        use crate::menu_icons::MenuIconId;

        let mut destinations = vec![NativeMenuItem {
            w_id: 0x6600,
            kind: NativeCommand::MoveTabToWindow(None),
            label: "&New window…".to_string(),
            enabled: true,
            icon: Some(MenuIconId::SplitRight),
        }];

        if let Some(mux) = mux::Mux::try_get() {
            let mut window_ids = mux.iter_windows();
            window_ids.sort_unstable();
            for (index, window_id) in window_ids.into_iter().take(255).enumerate() {
                let (user_title, title, workspace) = mux
                    .get_window(window_id)
                    .map(|window| {
                        (
                            window.get_user_title(),
                            window.get_title().trim().to_string(),
                            window.get_workspace().to_string(),
                        )
                    })
                    .unwrap_or_default();
                destinations.push(NativeMenuItem {
                    w_id: 0x6601 + index as u16,
                    kind: NativeCommand::MoveTabToWindow(Some(window_id)),
                    label: super::window_destination_label(
                        index,
                        user_title.as_deref(),
                        &title,
                        &workspace,
                    ),
                    enabled: window_id != source_window_id,
                    icon: Some(MenuIconId::SplitRight),
                });
            }
        }

        let mut items = full_menu_items();
        let tail_at = items.len().saturating_sub(2);
        let tail = items.split_off(tail_at);
        items.push(MenuEntry::Submenu {
            label: "Move &tab to".to_string(),
            items: destinations,
            icon: Some(MenuIconId::SplitRight),
        });
        items.extend(tail);
        items
    }

    /// Items inside the "Font size" submenu (patch 0039). Each
    /// dispatches a per-pane font-size `KeyAssignment` performed on
    /// the pane the user right-clicked (via `PerformAssignment {
    /// pane_id, .. }`). The accelerator hints in the labels mirror
    /// the default key bindings.
    pub fn font_size_submenu_items() -> Vec<NativeMenuItem> {
        use crate::menu_icons::MenuIconId;
        vec![
            NativeMenuItem {
                w_id: 0x6400,
                kind: NativeCommand::IncreasePaneFontSize,
                label: "&Increase\tCtrl+Shift+=".to_string(),
                enabled: true,
                icon: Some(MenuIconId::FontSize),
            },
            NativeMenuItem {
                w_id: 0x6401,
                kind: NativeCommand::DecreasePaneFontSize,
                label: "&Decrease\tCtrl+Shift+-".to_string(),
                enabled: true,
                icon: Some(MenuIconId::FontSize),
            },
            NativeMenuItem {
                w_id: 0x6402,
                kind: NativeCommand::ResetPaneFontSize,
                label: "&Reset\tCtrl+Shift+0".to_string(),
                enabled: true,
                icon: Some(MenuIconId::FontSize),
            },
        ]
    }

    /// Items inside the "Theme" submenu (patch 0017). Lists the
    /// three built-in schemes baked into `wtinator::vscode_theme`
    /// and an "Open themes folder…" entry that hands off to the OS
    /// file manager.
    pub fn theme_submenu_items() -> Vec<NativeMenuItem> {
        use crate::menu_icons::MenuIconId;
        use crate::vscode_theme::ThemeId;
        vec![
            NativeMenuItem {
                w_id: 0x5001,
                kind: NativeCommand::SetTheme(ThemeId::VsCodeLight),
                label: "&VSCode Light".to_string(),
                enabled: true,
                icon: Some(MenuIconId::ThemeVscodeLight),
            },
            NativeMenuItem {
                w_id: 0x5002,
                kind: NativeCommand::SetTheme(ThemeId::VsCodeDark),
                label: "VSCode &Dark".to_string(),
                enabled: true,
                icon: Some(MenuIconId::ThemeVscodeDark),
            },
            NativeMenuItem {
                w_id: 0x5003,
                kind: NativeCommand::SetTheme(ThemeId::WindowsTerminalDark),
                label: "&Windows Terminal Dark".to_string(),
                enabled: true,
                icon: Some(MenuIconId::ThemeWindowsTerminal),
            },
            NativeMenuItem {
                w_id: 0,
                kind: NativeCommand::Separator,
                label: String::new(),
                enabled: true,
                icon: None,
            },
            NativeMenuItem {
                w_id: 0x5004,
                kind: NativeCommand::OpenThemesFolder,
                label: "Open themes &folder…".to_string(),
                enabled: true,
                icon: Some(MenuIconId::OpenFolder),
            },
        ]
    }

    /// Items inside the "Screenshot" submenu (patch 0025).
    pub fn screenshot_submenu_items() -> Vec<NativeMenuItem> {
        use crate::menu_icons::MenuIconId;
        vec![
            NativeMenuItem {
                w_id: 0x5006,
                kind: NativeCommand::ScreenshotSave,
                label: "Save as &JPEG...".to_string(),
                enabled: true,
                icon: Some(MenuIconId::SaveScrollback),
            },
            NativeMenuItem {
                w_id: 0x5007,
                kind: NativeCommand::ScreenshotCopy,
                label: "&Copy to clipboard".to_string(),
                enabled: true,
                icon: Some(MenuIconId::Copy),
            },
        ]
    }

    /// Items inside the "Move pane to…" submenu (patch 0028).
    /// One item per live group, plus a sentinel "(no group)"
    /// entry. The list is rebuilt every time the user opens
    /// the menu so it always reflects the current mux state.
    /// If the live list has more groups than
    /// `MOVE_PANE_GROUP_W_ID_RANGE` slots, the rest are
    /// silently truncated with a `log::warn!` — see the note
    /// on `group_name_to_w_id` for the rationale.
    pub fn move_pane_submenu_items() -> Vec<NativeMenuItem> {
        use crate::menu_icons::MenuIconId;
        use crate::{context_menu, groups};
        let listing = groups::list_groups();
        // The "(no group)" sentinel always goes last (per the
        // contract of `list_groups`).
        let real_groups: Vec<&String> = listing
            .names
            .iter()
            .filter(|n| n.as_str() != groups::NO_GROUP_LABEL)
            .collect();

        let mut items: Vec<NativeMenuItem> = Vec::with_capacity(listing.names.len() + 1);

        for name in &real_groups {
            if (items.len() as u16) >= context_menu::MOVE_PANE_GROUP_W_ID_RANGE {
                log::warn!(
                    "wezterminator patch 0028: too many groups for the wID range \
                     ({} > {}); the rest are not reachable from the menu",
                    real_groups.len(),
                    context_menu::MOVE_PANE_GROUP_W_ID_RANGE
                );
                break;
            }
            items.push(NativeMenuItem {
                w_id: context_menu::group_name_to_w_id(Some(name)),
                kind: NativeCommand::MovePaneToGroup(Some((*name).clone())),
                label: format!("&{}", name),
                enabled: true,
                // Reuse the SplitRight icon — the visual "split
                // and move" metaphor is the closest match we
                // have without adding a new icon variant.
                icon: Some(MenuIconId::SplitRight),
            });
        }

        // Sentinel: move to the default bucket (no group).
        items.push(NativeMenuItem {
            w_id: context_menu::MOVE_PANE_GROUP_W_ID_BASE,
            kind: NativeCommand::MovePaneToGroup(None),
            label: format!("&{}", groups::NO_GROUP_LABEL),
            enabled: real_groups.is_empty()
                || listing.names.iter().any(|n| n == groups::NO_GROUP_LABEL),
            icon: Some(MenuIconId::SplitRight),
        });

        items
    }

    /// Populate an `HMENU` from a flat slice of `NativeMenuItem`s (no
    /// submenus allowed at this level — the parent caller is
    /// responsible for grouping items into sub-HMENUs and passing the
    /// resulting handle up via `MF_POPUP`). Items with `w_id == 0`
    /// are treated as separators.
    #[allow(unsafe_code)]
    unsafe fn populate_items_into(
        hmenu: windows_sys::Win32::UI::WindowsAndMessaging::HMENU,
        items: &[NativeMenuItem],
    ) -> bool {
        for item in items {
            if item.w_id == 0 {
                if AppendMenuW(hmenu, MF_SEPARATOR, 0, std::ptr::null()) == 0 {
                    return false;
                }
                continue;
            }
            let enabled_flag = if item.enabled {
                MF_ENABLED
            } else {
                MF_DISABLED | MF_GRAYED
            };
            let wide: Vec<u16> = item
                .label
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let res = AppendMenuW(
                hmenu,
                MF_STRING | enabled_flag,
                item.w_id as usize,
                wide.as_ptr(),
            );
            if res == 0 {
                return false;
            }
            if !item.enabled {
                EnableMenuItem(hmenu, item.w_id as u32, MF_DISABLED | MF_GRAYED);
            }
        }
        true
    }

    /// Recursively populate an `HMENU` from a slice of `MenuEntry`s.
    /// Returns `false` on the first `AppendMenuW` failure so the caller
    /// can tear down the partially-built tree.
    #[allow(unsafe_code)]
    unsafe fn populate_hmenu(
        hmenu: windows_sys::Win32::UI::WindowsAndMessaging::HMENU,
        entries: &[MenuEntry],
    ) -> bool {
        for entry in entries {
            match entry {
                MenuEntry::Separator => {
                    if AppendMenuW(hmenu, MF_SEPARATOR, 0, std::ptr::null()) == 0 {
                        return false;
                    }
                }
                MenuEntry::Item(item) => {
                    let enabled_flag = if item.enabled {
                        MF_ENABLED
                    } else {
                        MF_DISABLED | MF_GRAYED
                    };
                    let wide: Vec<u16> = item
                        .label
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .collect();
                    // Resolve the icon (if any) to an HBITMAP handle.
                    // The handle is cached process-wide and never
                    // freed; we hand it directly to the OS as
                    // `hbmpItem` and trust the menu to draw it
                    // alongside the label.
                    let hbm: HBITMAP = match item.icon {
                        Some(id) => crate::menu_icons::handle(id)
                            .map(|h| h as HBITMAP)
                            .unwrap_or(std::ptr::null_mut()),
                        None => std::ptr::null_mut(),
                    };
                    let mut mii = MENUITEMINFOW {
                        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                        fMask: MIIM_ID | MIIM_STRING | MIIM_STATE,
                        fType: 0,
                        fState: if item.enabled { 0 } else { MFS_DISABLED as u32 },
                        wID: item.w_id as u32,
                        hSubMenu: std::ptr::null_mut(),
                        hbmpChecked: std::ptr::null_mut(),
                        hbmpUnchecked: std::ptr::null_mut(),
                        dwItemData: 0,
                        dwTypeData: wide.as_ptr() as PWSTR,
                        cch: (wide.len() as u32).saturating_sub(1),
                        hbmpItem: hbm,
                    };
                    if hbm.is_null() {
                        // No icon — fall back to the legacy AppendMenuW
                        // path so the MIIM_BITMAP flag is not set.
                        let res = AppendMenuW(
                            hmenu,
                            MF_STRING | enabled_flag,
                            item.w_id as usize,
                            wide.as_ptr(),
                        );
                        if res == 0 {
                            return false;
                        }
                    } else {
                        mii.fMask |= MIIM_BITMAP;
                        let res = InsertMenuItemW(
                            hmenu,
                            u32::MAX,
                            1, // fByPosition: append
                            &mii,
                        );
                        if res == 0 {
                            return false;
                        }
                    }
                    if !item.enabled {
                        let _ = EnableMenuItem(hmenu, item.w_id as u32, MF_DISABLED | MF_GRAYED);
                    }
                }
                MenuEntry::Submenu { label, items, icon } => {
                    // Build the submenu first so we can hand its HMENU
                    // to the parent via the popup flag. The submenu is
                    // owned by the parent (DestroyMenu on the root
                    // recursively destroys its submenus).
                    let hsub = CreatePopupMenu();
                    if hsub.is_null() {
                        return false;
                    }
                    if !populate_items_into(hsub, items) {
                        // AppendMenuW failure inside the submenu: we
                        // own `hsub` here (it was never attached to
                        // the parent), so destroy it before bailing.
                        DestroyMenu(hsub);
                        return false;
                    }
                    let wide: Vec<u16> = label.encode_utf16().chain(std::iter::once(0)).collect();
                    // WezTerminator (patch 0043): if the submenu has an
                    // icon, attach it via MENUITEMINFOW (MIIM_BITMAP +
                    // MIIM_SUBMENU) like a leaf item; otherwise use the
                    // legacy AppendMenuW(MF_POPUP) path.
                    let hbm: HBITMAP = match icon {
                        Some(id) => crate::menu_icons::handle(*id)
                            .map(|h| h as HBITMAP)
                            .unwrap_or(std::ptr::null_mut()),
                        None => std::ptr::null_mut(),
                    };
                    if hbm.is_null() {
                        let res = AppendMenuW(hmenu, MF_POPUP, hsub as usize, wide.as_ptr());
                        if res == 0 {
                            // `hsub` is now owned by `hmenu`; the root
                            // DestroyMenu below will reclaim it.
                            return false;
                        }
                    } else {
                        let mii = MENUITEMINFOW {
                            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                            fMask: MIIM_STRING | MIIM_SUBMENU | MIIM_BITMAP,
                            fType: 0,
                            fState: 0,
                            wID: 0,
                            hSubMenu: hsub,
                            hbmpChecked: std::ptr::null_mut(),
                            hbmpUnchecked: std::ptr::null_mut(),
                            dwItemData: 0,
                            dwTypeData: wide.as_ptr() as PWSTR,
                            cch: (wide.len() as u32).saturating_sub(1),
                            hbmpItem: hbm,
                        };
                        let res = InsertMenuItemW(hmenu, u32::MAX, 1, &mii);
                        if res == 0 {
                            DestroyMenu(hsub);
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    /// BethTerm (patch 0146): `TrackPopupMenuEx` that never fails
    /// silently. Windows refuses to show a popup when the calling
    /// thread is not allowed to take the foreground (this is what
    /// happened after Explorer's tray timed out, patch 0145): the call
    /// returns 0 at once, with `GetLastError` set, and the user sees
    /// nothing. Log the code and retry once after taking the
    /// foreground the official way (`AttachThreadInput` to the
    /// current foreground thread). Same TPM flags on both tries; the
    /// caller must be the UI/main thread (see AGENTS.md).
    #[allow(unsafe_code)]
    pub unsafe fn track_popup_checked(
        hmenu: windows_sys::Win32::UI::WindowsAndMessaging::HMENU,
        flags: u32,
        x: i32,
        y: i32,
        hwnd_owner: HWND,
    ) -> i32 {
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
        use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, EndMenu, GetForegroundWindow, GetWindowThreadProcessId,
            SendMessageW, WM_CANCELMODE,
        };
        // Windows: "a menu is already active". The retry used to only
        // grab the foreground, so a stuck popup kept failing forever.
        const ERROR_POPUP_ALREADY_ACTIVE: u32 = 1446;

        SetLastError(0);
        let start = Instant::now();
        let cmd = TrackPopupMenuEx(hmenu, flags, x, y, hwnd_owner, std::ptr::null());
        if cmd != 0 {
            return cmd;
        }
        let err = GetLastError();
        let elapsed = start.elapsed();
        // A menu the user dismissed takes human time and leaves no
        // error. Anything else is Windows refusing to show it.
        if err == 0 && elapsed >= Duration::from_millis(50) {
            return 0;
        }
        log::warn!(
            "bethterm menu: TrackPopupMenuEx returned 0 after {:?} (err={}); \
             retrying with the foreground fix",
            elapsed,
            err
        );

        if err == ERROR_POPUP_ALREADY_ACTIVE {
            // Drop the menu this thread still considers open, including
            // one the user cannot see, then let the retry show the new one.
            EndMenu();
            SendMessageW(hwnd_owner, WM_CANCELMODE, 0, 0);
        }

        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let me = GetCurrentThreadId();
        let attached =
            fg_thread != 0 && fg_thread != me && AttachThreadInput(fg_thread, me, 1) != 0;
        SetForegroundWindow(hwnd_owner);
        BringWindowToTop(hwnd_owner);
        if attached {
            AttachThreadInput(fg_thread, me, 0);
        }

        SetLastError(0);
        let cmd = TrackPopupMenuEx(hmenu, flags, x, y, hwnd_owner, std::ptr::null());
        if cmd == 0 {
            let err = GetLastError();
            if err != 0 {
                log::warn!(
                    "bethterm menu: TrackPopupMenuEx failed again (err={}); \
                     use the tray entry \"Reiniciar a janela nativa\" or `bethterm gui-restart`",
                    err
                );
            } else {
                log::info!("bethterm menu: popup shown after the foreground fix");
            }
        } else {
            log::info!("bethterm menu: popup shown after the foreground fix");
        }
        cmd
    }

    /// Show the menu at the current cursor position with `hwnd_owner`
    /// as the owner window. Returns the `wID` of the chosen item, or
    /// `None` if the user cancelled.
    #[allow(unsafe_code)]
    pub unsafe fn show_at(hwnd_owner: HWND, _x: i32, _y: i32, items: &[MenuEntry]) -> Option<u16> {
        let hmenu = CreatePopupMenu();
        if hmenu.is_null() {
            return None;
        }
        if !populate_hmenu(hmenu, items) {
            DestroyMenu(hmenu);
            return None;
        }

        // Per MSDN, the calling thread must be the foreground thread
        // for TrackPopupMenuEx to behave correctly. Calling
        // SetForegroundWindow on the owner is the canonical way to
        // ensure this.
        SetForegroundWindow(hwnd_owner);

        let mut pt = POINT { x: 0, y: 0 };
        let _ = GetCursorPos(&mut pt);

        // Patch 0146: logged + retried instead of failing silently.
        let cmd = track_popup_checked(
            hmenu,
            TPM_LEFTALIGN | TPM_RETURNCMD | TPM_NONOTIFY | TPM_VERPOSANIMATION,
            pt.x,
            pt.y,
            hwnd_owner,
        );
        DestroyMenu(hmenu);

        if cmd == 0 {
            None
        } else {
            Some(cmd as u16)
        }
    }
}

// =============================================================================
// Non-Windows: empty stub
// =============================================================================

#[cfg(not(windows))]
pub mod platform {
    use super::MenuEntry;

    /// No-op on non-Windows. WezTerminator's right-click menu is
    /// Windows-only in this iteration. On macOS and Linux the upstream
    /// `InputSelector` overlay path is used (see ARCHITECTURE.md).
    pub fn shell_picker_items() -> Vec<MenuEntry> {
        Vec::new()
    }
    pub fn split_picker_items() -> Vec<MenuEntry> {
        Vec::new()
    }
    pub fn full_menu_items() -> Vec<MenuEntry> {
        Vec::new()
    }

    /// Non-Windows stub. Always returns `None` — the upstream
    /// `InputSelector` overlay is used in the macOS/Linux path.
    pub fn show_at<H>(_hwnd_owner: H, _x: i32, _y: i32, _items: &[MenuEntry]) -> Option<u16> {
        None
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shells_not_empty() {
        assert!(!default_shells().is_empty());
    }

    #[test]
    fn custom_shells_keep_valid_unique_entries() {
        let parsed = super::parse_custom_shells(
            r#"[
                {"id": "my.tool", "label": "My tool", "args": ["powershell.exe", "-NoExit"]},
                {"id": "my.tool", "label": "Duplicate", "args": ["cmd.exe"]},
                {"id": "Bad Id", "label": "Bad", "args": ["cmd.exe"]},
                {"id": "no.args", "label": "No args", "args": []},
                {"id": "no.label", "label": " ", "args": ["cmd.exe"]}
            ]"#,
        );
        let ids: Vec<&str> = parsed.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["my.tool"]);
        assert!(super::parse_custom_shells("not json").is_empty());
    }

    #[test]
    fn dispatch_native_known_ids() {
        assert!(dispatch_native(0x1001).is_some());
        assert!(dispatch_native(0x1003).is_some());
        assert!(dispatch_native(0x2001).is_some());
        assert!(dispatch_native(0x2002).is_some());
        assert!(dispatch_native(0x2003).is_some());
    }

    #[test]
    fn dispatch_native_unknown_id_is_none() {
        assert!(dispatch_native(0xFFFF).is_none());
        assert!(dispatch_native(0).is_none());
    }

    #[test]
    fn all_w_ids_are_unique() {
        // Cover every NativeCommand variant that produces a wID.
        let mut seen = std::collections::HashSet::new();
        for i in 0..default_shells().len() {
            let id = NativeCommand::NewTab(i).w_id();
            assert!(seen.insert(id), "duplicate w_id {:#x}", id);
        }
        for i in 0..default_shells().len() {
            let id = NativeCommand::SplitRightWithShell(i).w_id();
            assert!(seen.insert(id), "duplicate w_id {:#x}", id);
            let id = NativeCommand::SplitDownWithShell(i).w_id();
            assert!(seen.insert(id), "duplicate w_id {:#x}", id);
        }
        assert!(seen.insert(NativeCommand::SplitRight.w_id()));
        assert!(seen.insert(NativeCommand::SplitDown.w_id()));
        assert!(seen.insert(NativeCommand::ClosePane.w_id()));
        assert!(seen.insert(NativeCommand::CopySelection.w_id()));
        assert!(seen.insert(NativeCommand::Paste.w_id()));
        assert!(seen.insert(NativeCommand::SelectAll.w_id()));
        assert!(seen.insert(NativeCommand::SaveScrollback.w_id()));
        assert!(seen.insert(NativeCommand::OpenSftp.w_id()));
        for theme in [
            crate::vscode_theme::ThemeId::VsCodeLight,
            crate::vscode_theme::ThemeId::VsCodeDark,
            crate::vscode_theme::ThemeId::WindowsTerminalDark,
        ] {
            assert!(seen.insert(NativeCommand::SetTheme(theme).w_id()));
        }
        assert!(seen.insert(NativeCommand::OpenThemesFolder.w_id()));
        assert!(seen.insert(NativeCommand::PasteImage.w_id()));
        assert!(seen.insert(NativeCommand::ScreenshotSave.w_id()));
        assert!(seen.insert(NativeCommand::ScreenshotCopy.w_id()));
        // Patch 0028: MovePaneToGroup wIDs. The "no group"
        // sentinel always lands at `MOVE_PANE_GROUP_W_ID_BASE`;
        // a named group lands in the hash range above it.
        assert!(seen.insert(NativeCommand::MovePaneToGroup(None).w_id()));
        assert!(seen.insert(NativeCommand::MovePaneToGroup(Some("frontend".into())).w_id()));
        // Patch 0030: RenameTerminal.
        assert!(seen.insert(NativeCommand::RenameTerminal.w_id()));
        // Patch 0031: RenameTab.
        assert!(seen.insert(NativeCommand::RenameTab.w_id()));
        // Patch 0085: RenameWindow.
        assert!(seen.insert(NativeCommand::RenameWindow.w_id()));
        // Patch 0034: OpenConfigApp.
        assert!(seen.insert(NativeCommand::OpenConfigApp.w_id()));
        assert!(seen.insert(NativeCommand::SetTaskbarIcon(0).w_id()));
        assert!(seen.insert(NativeCommand::SetTaskbarIcon(1).w_id()));
    }

    #[test]
    fn group_name_w_id_is_deterministic_and_in_range() {
        // Patch 0028: the same name must always map to the
        // same wID, and the result must fall in the
        // 0x6001..=0x60FF range (never on the 0x6000 sentinel
        // slot).
        let id1 = group_name_to_w_id(Some("frontend"));
        let id2 = group_name_to_w_id(Some("frontend"));
        assert_eq!(id1, id2);
        assert!(id1 >= MOVE_PANE_GROUP_W_ID_BASE + 1);
        assert!(id1 <= MOVE_PANE_GROUP_W_ID_BASE + MOVE_PANE_GROUP_W_ID_RANGE);

        // `None` and the empty string both map to the
        // sentinel slot.
        assert_eq!(group_name_to_w_id(None), MOVE_PANE_GROUP_W_ID_BASE);
        assert_eq!(group_name_to_w_id(Some("")), MOVE_PANE_GROUP_W_ID_BASE);
        // Whitespace-only is also the sentinel.
        assert_eq!(group_name_to_w_id(Some("   ")), MOVE_PANE_GROUP_W_ID_BASE);
    }

    #[test]
    fn dispatch_native_split_with_shell_returns_split_horizontal() {
        use config::keyassignment::SpawnCommand;
        match dispatch_native(0x3001) {
            Some(KeyAssignment::SplitHorizontal(SpawnCommand { args, label, .. })) => {
                assert_eq!(args.as_deref(), Some(&["cmd.exe".to_string()][..]));
                assert!(label.is_some());
            }
            other => panic!("expected SplitHorizontal with cmd.exe, got {:?}", other),
        }
    }

    #[test]
    fn dispatch_native_split_with_shell_returns_split_vertical() {
        use config::keyassignment::SpawnCommand;
        match dispatch_native(0x3101) {
            Some(KeyAssignment::SplitVertical(SpawnCommand { args, label, .. })) => {
                assert_eq!(args.as_deref(), Some(&["cmd.exe".to_string()][..]));
                assert!(label.is_some());
            }
            other => panic!("expected SplitVertical with cmd.exe, got {:?}", other),
        }
    }

    #[test]
    fn dispatch_native_split_with_shell_all_w_ids_resolve() {
        for i in 0..default_shells().len() {
            let wid = NativeCommand::SplitRightWithShell(i).w_id();
            assert!(
                dispatch_native(wid).is_some(),
                "wID {:#x} should resolve to a Split*WithShell action",
                wid
            );
            let wid = NativeCommand::SplitDownWithShell(i).w_id();
            assert!(
                dispatch_native(wid).is_some(),
                "wID {:#x} should resolve to a Split*WithShell action",
                wid
            );
        }
    }

    #[test]
    fn dispatch_native_copy_selection_returns_copy_to() {
        use config::keyassignment::ClipboardCopyDestination;
        match dispatch_native(0x4001) {
            Some(KeyAssignment::CopyTo(ClipboardCopyDestination::ClipboardAndPrimarySelection)) => {
            }
            other => panic!(
                "expected CopyTo(ClipboardAndPrimarySelection), got {:?}",
                other
            ),
        }
    }

    #[test]
    fn dispatch_native_paste_returns_paste_from() {
        use config::keyassignment::ClipboardPasteSource;
        match dispatch_native(0x4002) {
            Some(KeyAssignment::PasteFrom(ClipboardPasteSource::Clipboard)) => {}
            other => panic!("expected PasteFrom(Clipboard), got {:?}", other),
        }
    }

    #[test]
    fn dispatch_native_select_all_returns_select_all() {
        match dispatch_native(0x4003) {
            Some(KeyAssignment::SelectAll) => {}
            other => panic!("expected SelectAll, got {:?}", other),
        }
    }

    #[test]
    fn classify_routes_save_scrollback() {
        match classify(0x4004) {
            Some(super::DispatchAction::SaveScrollback) => {}
            other => panic!("expected SaveScrollback, got {:?}", other),
        }
    }

    #[test]
    fn classify_routes_known_assignments() {
        match classify(0x4001) {
            Some(super::DispatchAction::Assignment(KeyAssignment::CopyTo(_))) => {}
            other => panic!("expected CopyTo assignment, got {:?}", other),
        }
        match classify(0x4002) {
            Some(super::DispatchAction::Assignment(KeyAssignment::PasteFrom(_))) => {}
            other => panic!("expected PasteFrom assignment, got {:?}", other),
        }
        match classify(0x4003) {
            Some(super::DispatchAction::Assignment(KeyAssignment::SelectAll)) => {}
            other => panic!("expected SelectAll assignment, got {:?}", other),
        }
    }

    #[test]
    fn classify_unknown_id_is_none() {
        assert!(classify(0xFFFF).is_none());
        assert!(classify(0).is_none());
    }

    #[test]
    fn classify_routes_themes() {
        match classify(0x5001) {
            Some(super::DispatchAction::SetTheme(crate::vscode_theme::ThemeId::VsCodeLight)) => {}
            other => panic!("expected SetTheme(VsCodeLight), got {:?}", other),
        }
        match classify(0x5002) {
            Some(super::DispatchAction::SetTheme(crate::vscode_theme::ThemeId::VsCodeDark)) => {}
            other => panic!("expected SetTheme(VsCodeDark), got {:?}", other),
        }
        match classify(0x5003) {
            Some(super::DispatchAction::SetTheme(
                crate::vscode_theme::ThemeId::WindowsTerminalDark,
            )) => {}
            other => panic!("expected SetTheme(WindowsTerminalDark), got {:?}", other),
        }
        match classify(0x5004) {
            Some(super::DispatchAction::OpenThemesFolder) => {}
            other => panic!("expected OpenThemesFolder, got {:?}", other),
        }
    }

    #[test]
    fn classify_routes_image_actions() {
        match classify(0x5005) {
            Some(super::DispatchAction::PasteImage) => {}
            other => panic!("expected PasteImage, got {:?}", other),
        }
        match classify(0x5006) {
            Some(super::DispatchAction::ScreenshotSave) => {}
            other => panic!("expected ScreenshotSave, got {:?}", other),
        }
        match classify(0x5007) {
            Some(super::DispatchAction::ScreenshotCopy) => {}
            other => panic!("expected ScreenshotCopy, got {:?}", other),
        }
    }

    #[test]
    fn classify_routes_detach_tab_to_new_window() {
        match classify(0x6600) {
            Some(super::DispatchAction::MoveTabToWindow(None)) => {}
            other => panic!("expected MoveTabToWindow(None), got {:?}", other),
        }
    }

    #[test]
    fn classify_routes_rename_window() {
        match classify(0x6700) {
            Some(super::DispatchAction::RenameWindow) => {}
            other => panic!("expected RenameWindow, got {:?}", other),
        }
    }

    #[test]
    fn window_destination_label_prefers_user_title() {
        assert_eq!(
            window_destination_label(0, Some("frontend"), "bash", "default"),
            "frontend"
        );
        assert_eq!(
            window_destination_label(1, Some("  backend  "), "", ""),
            "backend"
        );
        assert_eq!(
            window_destination_label(2, Some("   "), "pwsh", "ws"),
            "Window 3 — pwsh"
        );
        assert_eq!(
            window_destination_label(0, None, "", "coding"),
            "Window 1 — coding"
        );
        assert_eq!(window_destination_label(4, None, "", ""), "Window 5");
    }

    #[cfg(windows)]
    #[test]
    fn shell_picker_items_have_default_shell_entries() {
        let items = platform::shell_picker_items();
        assert_eq!(items.len(), default_shells().len());
        for entry in &items {
            match entry {
                MenuEntry::Item(item) => {
                    assert!(item.w_id >= 0x1001 && item.w_id <= 0x10FF);
                }
                _ => panic!("shell picker should be flat items, got {:?}", entry),
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn split_picker_items_are_2_submenus_of_default_shells() {
        let items = platform::split_picker_items();
        assert_eq!(items.len(), 2);
        for entry in &items {
            match entry {
                MenuEntry::Submenu { items, .. } => {
                    assert_eq!(
                        items.len(),
                        default_shells().len(),
                        "each split submenu should list the default shells"
                    );
                    for item in items {
                        assert!(
                            (item.w_id >= 0x3001 && item.w_id <= 0x30FF)
                                || (item.w_id >= 0x3101 && item.w_id <= 0x31FF),
                            "wID {:#x} out of SplitWithShell range",
                            item.w_id
                        );
                    }
                }
                _ => panic!("split picker entry should be a Submenu, got {:?}", entry),
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn full_menu_includes_shells_splits_and_close() {
        let items = platform::full_menu_items();
        // WezTerminator (patch 0043): the menu was slimmed down — the
        // Theme / Font size / Move-pane submenus moved into "Configure
        // this terminal…", which now sits at the TOP. Layout:
        //   1 Configure (top) + 1 separator
        //   + default_shells().len() shell items
        //   + 2 split submenus (right, down)
        //   + 1 Toggle list mode item (patch 0065)
        //   + 1 separator
        //   + 5 content items (Copy, Paste, Paste image, Select all, Save)
        //   + 2 content items (Rename tab, Rename window)
        //   + 1 icon-color submenu (patch 0151)
        //   + 1 Screenshot submenu
        //   + 1 separator
        //   + 1 close pane
        // = default_shells().len() + 17
        assert_eq!(items.len(), default_shells().len() + 17);

        // "Configure this terminal…" must be the FIRST entry.
        match &items[0] {
            MenuEntry::Item(item) => assert_eq!(
                item.w_id, 0x6300,
                "Configure this terminal must be the first menu entry"
            ),
            _ => panic!("first entry should be Configure this terminal"),
        }

        let has_close = items.iter().any(|e| match e {
            MenuEntry::Item(item) => item.w_id == 0x2003,
            _ => false,
        });
        assert!(has_close, "full menu should include a ClosePane entry");
        // WezTerminator (patch 0065): the Toggle list mode item must be present.
        let has_list_mode = items.iter().any(|e| match e {
            MenuEntry::Item(item) => item.w_id == 0x6500,
            _ => false,
        });
        assert!(
            has_list_mode,
            "full menu should include a Toggle list mode entry"
        );
        let has_rename_window = items.iter().any(|e| match e {
            MenuEntry::Item(item) => item.w_id == 0x6700,
            _ => false,
        });
        assert!(
            has_rename_window,
            "full menu should include a Rename window entry"
        );
        let has_submenu = items.iter().any(|e| matches!(e, MenuEntry::Submenu { .. }));
        assert!(has_submenu, "full menu should include split submenus");
        let has_copy = items.iter().any(|e| match e {
            MenuEntry::Item(item) => item.w_id == 0x4001,
            _ => false,
        });
        assert!(has_copy, "full menu should include a Copy selection entry");
        let has_paste = items.iter().any(|e| match e {
            MenuEntry::Item(item) => item.w_id == 0x4002,
            _ => false,
        });
        assert!(has_paste, "full menu should include a Paste entry");
        let has_save = items.iter().any(|e| match e {
            MenuEntry::Item(item) => item.w_id == 0x4004,
            _ => false,
        });
        assert!(has_save, "full menu should include a Save scrollback entry");
        let has_screenshot = items.iter().any(|e| match e {
            MenuEntry::Submenu { label, .. } => label.contains("Screenshot"),
            _ => false,
        });
        assert!(
            has_screenshot,
            "full menu should include a Screenshot submenu"
        );
        // The Theme / Font size / Move-pane submenus were removed.
        let has_theme = items.iter().any(|e| match e {
            MenuEntry::Submenu { label, .. } => label.contains("Theme"),
            _ => false,
        });
        assert!(!has_theme, "Theme submenu should have been removed");
        let has_move = items.iter().any(|e| match e {
            MenuEntry::Submenu { label, .. } => label.contains("Move pane"),
            _ => false,
        });
        assert!(!has_move, "Move pane submenu should have been removed");
    }

    #[cfg(windows)]
    #[test]
    fn theme_submenu_lists_three_themes_and_open_folder() {
        let items = platform::theme_submenu_items();
        // 3 themes + 1 separator + 1 open-folder = 5
        assert_eq!(items.len(), 5);
        let wids: Vec<u16> = items
            .iter()
            .map(|i| i.w_id)
            .filter(|&w| w != 0) // skip the separator
            .collect();
        assert!(wids.contains(&0x5001));
        assert!(wids.contains(&0x5002));
        assert!(wids.contains(&0x5003));
        assert!(wids.contains(&0x5004));
    }

    #[cfg(windows)]
    #[test]
    fn screenshot_submenu_lists_save_and_copy() {
        let items = platform::screenshot_submenu_items();
        assert_eq!(items.len(), 2);
        let wids: Vec<u16> = items.iter().map(|i| i.w_id).collect();
        assert!(wids.contains(&0x5006));
        assert!(wids.contains(&0x5007));
    }
}
