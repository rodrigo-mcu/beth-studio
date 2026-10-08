use crate::domain::DomainId;
use crate::pane::{
    CachePolicy, CloseReason, ForEachPaneLogicalLine, LogicalLine, Pane, PaneId, Pattern,
    SearchResult, WithPaneLines,
};
use crate::renderable::*;
use crate::tmux::{TmuxDomain, TmuxDomainState};
use crate::{Domain, Mux, MuxNotification};
use anyhow::Error;
use async_trait::async_trait;
use config::keyassignment::ScrollbackEraseMode;
use config::{configuration, ExitBehavior, ExitBehaviorMessaging};
use fancy_regex::Regex;
use parking_lot::{MappedMutexGuard, Mutex, MutexGuard};
use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use procinfo::LocalProcessInfo;
use rangeset::RangeSet;
use smol::channel::{bounded, Receiver, TryRecvError};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::convert::TryInto;
use std::io::{Result as IoResult, Write};
use std::ops::Range;
use std::sync::Arc;
use std::time::{Duration, Instant};
use termwiz::escape::csi::{Sgr, CSI};
use termwiz::escape::{Action, DeviceControlMode};
use termwiz::input::KeyboardEncoding;
use termwiz::surface::{Line, SequenceNo};
use url::Url;
use wezterm_dynamic::Value;
use wezterm_term::color::ColorPalette;
use wezterm_term::{
    Alert, AlertHandler, Clipboard, DownloadHandler, KeyCode, KeyModifiers, MouseEvent, Progress,
    SemanticZone, StableRowIndex, Terminal, TerminalConfiguration, TerminalSize,
};

const PROC_INFO_CACHE_TTL: Duration = Duration::from_millis(300);

#[derive(Debug)]
enum ProcessState {
    Running {
        child_waiter: Receiver<IoResult<ExitStatus>>,
        pid: Option<u32>,
        signaller: Box<dyn ChildKiller + Sync>,
        // Whether we've explicitly killed the child
        killed: bool,
    },
    DeadPendingClose {
        killed: bool,
    },
    Dead,
}

struct CachedProcInfo {
    root: LocalProcessInfo,
    updated: Instant,
    foreground: LocalProcessInfo,
}

/// This is a bit horrible; it can take 700us to tcgetpgrp, so if we have
/// 10 tabs open and run the mouse over them, hovering them each in turn,
/// we can spend 7ms per evaluation of the tab bar state on fetching those
/// pids alone, which can easily lead to stuttering when moving the mouse
/// over all of the tabs.
///
/// This implements a cache holding that fg process and the often queried
/// cwd and process path that allows for stale reads to proceed quickly
/// while the writes can happen in a background thread.
#[cfg(unix)]
#[derive(Clone)]
struct CachedLeaderInfo {
    updated: Instant,
    fd: std::os::fd::RawFd,
    pid: u32,
    path: Option<std::path::PathBuf>,
    current_working_dir: Option<std::path::PathBuf>,
    updating: bool,
}

#[cfg(unix)]
impl CachedLeaderInfo {
    fn new(fd: Option<std::os::fd::RawFd>) -> Self {
        let mut me = Self {
            updated: Instant::now(),
            fd: fd.unwrap_or(-1),
            pid: 0,
            path: None,
            current_working_dir: None,
            updating: false,
        };
        me.update();
        me
    }

    fn can_update(&self) -> bool {
        self.fd != -1 && !self.updating
    }

    fn update(&mut self) {
        self.pid = unsafe { libc::tcgetpgrp(self.fd) } as u32;
        if self.pid > 0 {
            self.path = LocalProcessInfo::executable_path(self.pid);
            self.current_working_dir = LocalProcessInfo::current_working_dir(self.pid);
        } else {
            self.path.take();
            self.current_working_dir.take();
        }
        self.updated = Instant::now();
        self.updating = false;
    }

    fn expired(&self) -> bool {
        self.updated.elapsed() > PROC_INFO_CACHE_TTL
    }
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum LocalPaneConnectionState {
    Connecting,
    Connected,
}

pub struct LocalPane {
    pane_id: PaneId,
    terminal: Mutex<Terminal>,
    process: Mutex<ProcessState>,
    pty: Mutex<Box<dyn MasterPty>>,
    writer: Mutex<Box<dyn Write + Send>>,
    domain_id: DomainId,
    tmux_domain: Mutex<Option<Arc<TmuxDomainState>>>,
    proc_list: Arc<Mutex<Option<CachedProcInfo>>>,
    /// Patch 0200: a background refresh of `proc_list` is running.
    proc_refreshing: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(unix)]
    leader: Arc<Mutex<Option<CachedLeaderInfo>>>,
    command_description: String,
    header_text: Mutex<Option<String>>,
    /// WezTerminator (patch 0039): per-pane font scale (1.0 = window
    /// font size). See `Pane::get_font_scale`.
    font_scale: Mutex<f64>,
    /// WezTerminator (patch 0043): per-pane font family (None = window
    /// font). See `Pane::get_font_family`.
    font_family: Mutex<Option<String>>,
    /// WezTerminator (patch 0047): per-pane bold / italic. See
    /// `Pane::get_font_bold` / `get_font_italic`.
    font_bold: Mutex<bool>,
    font_italic: Mutex<bool>,
    /// WezTerminator (patch 0043): per-pane FAMILY cell-aspect ratio
    /// (width, height) RELATIVE to the *size-scaled* window cell. A
    /// different typeface has a different cell aspect than the window
    /// font; this captures ONLY that family difference, so it stays
    /// (1.0, 1.0) whenever the pane uses the window font — regardless of
    /// the pane's font *size* scale (which lives in `font_scale`). The
    /// reflow multiplies the two: `scale_size(size, scale*w, scale*h)`.
    /// Written by the GUI alone (`apply_pane_font_scale_change`).
    /// See `Pane::get_family_ratio`.
    family_ratio: Mutex<(f64, f64)>,
    /// WezTerminator (patch 0041): id of the theme explicitly applied
    /// to this pane (for session persistence). See `Pane::get_theme_id`.
    theme_id: Mutex<Option<String>>,
}

#[async_trait(?Send)]
impl Pane for LocalPane {
    fn pane_id(&self) -> PaneId {
        self.pane_id
    }

    fn get_metadata(&self) -> Value {
        #[allow(unused_mut)]
        let mut map: BTreeMap<Value, Value> = BTreeMap::new();

        #[cfg(unix)]
        if let Some(tio) = self.pty.lock().get_termios() {
            use nix::sys::termios::LocalFlags;
            // Detect whether we might be in password input mode.
            // If local echo is disabled and canonical input mode
            // is enabled, then we assume that we're in some kind
            // of password-entry mode.
            let pw_input = !tio.local_flags.contains(LocalFlags::ECHO)
                && tio.local_flags.contains(LocalFlags::ICANON);
            map.insert(
                Value::String("password_input".to_string()),
                Value::Bool(pw_input),
            );
        }

        Value::Object(map.into())
    }

    fn get_cursor_position(&self) -> StableCursorPosition {
        let mut cursor = terminal_get_cursor_position(&mut self.terminal.lock());
        if self.tmux_domain.lock().is_some() {
            cursor.visibility = termwiz::surface::CursorVisibility::Hidden;
        }
        cursor
    }

    fn get_keyboard_encoding(&self) -> KeyboardEncoding {
        if self.tmux_domain.lock().is_some() {
            KeyboardEncoding::Xterm
        } else {
            self.terminal.lock().get_keyboard_encoding()
        }
    }

    fn get_current_seqno(&self) -> SequenceNo {
        self.terminal.lock().current_seqno()
    }

    fn get_changed_since(
        &self,
        lines: Range<StableRowIndex>,
        seqno: SequenceNo,
    ) -> RangeSet<StableRowIndex> {
        terminal_get_dirty_lines(&mut self.terminal.lock(), lines, seqno)
    }

    fn for_each_logical_line_in_stable_range_mut(
        &self,
        lines: Range<StableRowIndex>,
        for_line: &mut dyn ForEachPaneLogicalLine,
    ) {
        terminal_for_each_logical_line_in_stable_range_mut(
            &mut self.terminal.lock(),
            lines,
            for_line,
        );
    }

    fn with_lines_mut(&self, lines: Range<StableRowIndex>, with_lines: &mut dyn WithPaneLines) {
        terminal_with_lines_mut(&mut self.terminal.lock(), lines, with_lines)
    }

    fn get_lines(&self, lines: Range<StableRowIndex>) -> (StableRowIndex, Vec<Line>) {
        crate::pane::impl_get_lines_via_with_lines(self, lines)
    }

    fn get_logical_lines(&self, lines: Range<StableRowIndex>) -> Vec<LogicalLine> {
        crate::pane::impl_get_logical_lines_via_get_lines(self, lines)
    }

    fn get_dimensions(&self) -> RenderableDimensions {
        terminal_get_dimensions(&mut self.terminal.lock())
    }

    fn copy_user_vars(&self) -> HashMap<String, String> {
        self.terminal.lock().user_vars().clone()
    }

    fn exit_behavior(&self) -> Option<ExitBehavior> {
        // If we are ssh, and we've not yet fully connected,
        // then override exit_behavior so that we can show
        // connection issues
        let mut pty = self.pty.lock();
        let is_ssh_connecting = pty
            .downcast_mut::<crate::ssh::WrappedSshPty>()
            .map(|s| s.is_connecting())
            .unwrap_or(false);
        let is_failed_spawn = pty.is::<crate::domain::FailedSpawnPty>();

        if is_ssh_connecting || is_failed_spawn {
            Some(ExitBehavior::CloseOnCleanExit)
        } else {
            None
        }
    }

    fn kill(&self) {
        let mut proc = self.process.lock();
        log::debug!(
            "killing process in pane {}, state is {:?}",
            self.pane_id,
            proc
        );
        match &mut *proc {
            ProcessState::Running {
                signaller, killed, ..
            } => {
                let _ = signaller.kill();
                *killed = true;
            }
            ProcessState::DeadPendingClose { killed } => {
                *killed = true;
            }
            _ => {}
        }
    }

    fn is_dead(&self) -> bool {
        let mut proc = self.process.lock();

        const EXIT_BEHAVIOR: &str = "This message is shown because \
            \x1b]8;;https://wezterm.org/\
            config/lua/config/exit_behavior.html\
            \x1b\\exit_behavior\x1b]8;;\x1b\\";

        let mut terse = String::new();
        let mut brief = String::new();
        let mut trailer = String::new();
        let cmd = &self.command_description;

        match &mut *proc {
            ProcessState::Running {
                child_waiter,
                killed,
                ..
            } => {
                let status = match child_waiter.try_recv() {
                    Ok(Ok(s)) => Some(s),
                    Err(TryRecvError::Empty) => None,
                    _ => Some(ExitStatus::with_exit_code(1)),
                };

                if let Some(status) = status {
                    let success = match status.success() {
                        true => true,
                        false => configuration()
                            .clean_exit_codes
                            .contains(&status.exit_code()),
                    };

                    match (
                        self.exit_behavior()
                            .unwrap_or_else(|| configuration().exit_behavior),
                        success,
                        killed,
                    ) {
                        (ExitBehavior::Close, _, _) => *proc = ProcessState::Dead,
                        (ExitBehavior::CloseOnCleanExit, false, _) => {
                            brief = format!("⚠️  Process {cmd} didn't exit cleanly");
                            terse = format!("{status}.");
                            trailer = format!("{EXIT_BEHAVIOR}=\"CloseOnCleanExit\"");

                            *proc = ProcessState::DeadPendingClose { killed: false }
                        }
                        (ExitBehavior::CloseOnCleanExit, ..) => *proc = ProcessState::Dead,
                        (ExitBehavior::Hold, success, false) => {
                            trailer = format!("{EXIT_BEHAVIOR}=\"Hold\"");

                            if success {
                                brief = format!("👍 Process {cmd} completed.");
                                terse = "done".to_string();
                            } else {
                                brief = format!("⚠️  Process {cmd} didn't exit cleanly");
                                terse = format!("{status}");
                            }
                            *proc = ProcessState::DeadPendingClose { killed: false }
                        }
                        (ExitBehavior::Hold, _, true) => *proc = ProcessState::Dead,
                    }
                    log::debug!("child terminated, new state is {:?}", proc);
                }
            }
            ProcessState::DeadPendingClose { killed } => {
                if *killed {
                    *proc = ProcessState::Dead;
                    log::debug!("child state -> {:?}", proc);
                }
            }
            ProcessState::Dead => {}
        }

        let mut notify = None;
        if !terse.is_empty() {
            match configuration().exit_behavior_messaging {
                ExitBehaviorMessaging::Verbose => {
                    if terse == "done" {
                        notify = Some(format!("\r\n{brief}\r\n{trailer}"));
                    } else {
                        notify = Some(format!("\r\n{brief}\r\n{terse}\r\n{trailer}"));
                    }
                }
                ExitBehaviorMessaging::Brief => {
                    if terse == "done" {
                        notify = Some(format!("\r\n{brief}"));
                    } else {
                        notify = Some(format!("\r\n{brief}\r\n{terse}"));
                    }
                }
                ExitBehaviorMessaging::Terse => {
                    notify = Some(format!("\r\n[{terse}]"));
                }
                ExitBehaviorMessaging::None => {}
            }
        }

        if let Some(notify) = notify {
            emit_output_for_pane(self.pane_id, &notify);
        }

        match &*proc {
            ProcessState::Running { .. } => false,
            ProcessState::DeadPendingClose { .. } => false,
            ProcessState::Dead => true,
        }
    }

    fn set_clipboard(&self, clipboard: &Arc<dyn Clipboard>) {
        self.terminal.lock().set_clipboard(clipboard);
    }

    fn set_download_handler(&self, handler: &Arc<dyn DownloadHandler>) {
        self.terminal.lock().set_download_handler(handler);
    }

    fn set_config(&self, config: Arc<dyn TerminalConfiguration>) {
        self.terminal.lock().set_config(config);
    }

    fn get_config(&self) -> Option<Arc<dyn TerminalConfiguration>> {
        Some(self.terminal.lock().get_config())
    }

    fn perform_actions(&self, actions: Vec<termwiz::escape::Action>) {
        self.terminal.lock().perform_actions(actions)
    }

    fn mouse_event(&self, event: MouseEvent) -> Result<(), Error> {
        Mux::get().record_input_for_current_identity();
        self.terminal.lock().mouse_event(event)
    }

    fn key_down(&self, key: KeyCode, mods: KeyModifiers) -> Result<(), Error> {
        Mux::get().record_input_for_current_identity();
        if self.tmux_domain.lock().is_some() {
            log::trace!("key: {:?}", key);
            if key == KeyCode::Char('q') {
                self.terminal.lock().send_paste("detach\n")?;
            }
            return Ok(());
        } else {
            self.terminal.lock().key_down(key, mods)
        }
    }

    fn key_up(&self, key: KeyCode, mods: KeyModifiers) -> Result<(), Error> {
        Mux::get().record_input_for_current_identity();
        self.terminal.lock().key_up(key, mods)
    }

    fn resize(&self, size: TerminalSize) -> Result<(), Error> {
        self.pty.lock().resize(PtySize {
            rows: size.rows.try_into()?,
            cols: size.cols.try_into()?,
            pixel_width: size.pixel_width.try_into()?,
            pixel_height: size.pixel_height.try_into()?,
        })?;
        self.terminal.lock().resize(size);
        Ok(())
    }

    fn writer(&self) -> MappedMutexGuard<'_, dyn std::io::Write> {
        Mux::get().record_input_for_current_identity();
        MutexGuard::map(self.writer.lock(), |writer| {
            let w: &mut dyn std::io::Write = writer;
            w
        })
    }

    fn reader(&self) -> anyhow::Result<Option<Box<dyn std::io::Read + Send>>> {
        Ok(Some(self.pty.lock().try_clone_reader()?))
    }

    fn send_paste(&self, text: &str) -> Result<(), Error> {
        Mux::get().record_input_for_current_identity();
        if self.tmux_domain.lock().is_some() {
            Ok(())
        } else {
            self.terminal.lock().send_paste(text)
        }
    }

    fn get_title(&self) -> String {
        let title = self.terminal.lock().get_title().to_string();
        // If the title is the default pane title, then try to spice
        // things up a bit by returning the process basename instead
        if title == "wezterm" {
            if let Some(proc_name) = self.get_foreground_process_name(CachePolicy::AllowStale) {
                let proc_name = std::path::Path::new(&proc_name);
                if let Some(name) = proc_name.file_name() {
                    return name.to_string_lossy().to_string();
                }
            }
        }

        title
    }

    fn get_progress(&self) -> Progress {
        self.terminal.lock().get_progress()
    }

    fn palette(&self) -> ColorPalette {
        self.terminal.lock().palette()
    }

    /// WezTerminator (patch 0016.3): set the cached palette on the
    /// underlying terminal so the renderer picks it up on the next
    /// paint. The trait signature returns `()`; we discard the
    /// `bool` from `TerminalState::set_palette` because the
    /// upstream `Pane` trait has no return value here.
    fn set_palette(&self, scheme: ColorPalette) {
        let _ = self.terminal.lock().set_palette(scheme);
    }

    fn get_header_text(&self) -> Option<String> {
        self.header_text.lock().clone()
    }
    fn set_header_text(&self, text: Option<String>) {
        *self.header_text.lock() = text;
    }

    /// WezTerminator (patch 0039): per-pane font scale. Clamped to a
    /// sane range so a runaway shortcut can't make a pane 0px or
    /// gigantic. The GUI re-reads this each paint and re-derives the
    /// pane's cell metrics from it.
    fn get_font_scale(&self) -> f64 {
        *self.font_scale.lock()
    }
    fn set_font_scale(&self, scale: f64) {
        // SIZE only — identical to patch 0039/0040. The reflow reads
        // this directly (`scale_size(size, scale*ratio_w, scale*ratio_h)`
        // in mux/src/tab.rs); `family_ratio` defaults to (1.0, 1.0), so a
        // pure size change reduces exactly to the proven uniform
        // `scale_size(size, scale)`. The family ratio is a SEPARATE
        // concern, written only by the GUI when a family is set.
        *self.font_scale.lock() = scale.clamp(0.25, 6.0);
    }

    /// WezTerminator (patch 0043): per-pane font family. An empty /
    /// whitespace-only name is normalised to `None` (= the window
    /// font) so a blank pick from the config UI clears the override.
    fn get_font_family(&self) -> Option<String> {
        self.font_family.lock().clone()
    }
    fn set_font_family(&self, family: Option<String>) {
        let normalised = family.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });
        *self.font_family.lock() = normalised;
    }

    fn get_font_bold(&self) -> bool {
        *self.font_bold.lock()
    }
    fn set_font_bold(&self, bold: bool) {
        *self.font_bold.lock() = bold;
    }
    fn get_font_italic(&self) -> bool {
        *self.font_italic.lock()
    }
    fn set_font_italic(&self, italic: bool) {
        *self.font_italic.lock() = italic;
    }

    /// WezTerminator (patch 0043): per-pane FAMILY cell-aspect ratio,
    /// relative to the size-scaled window cell ((1.0, 1.0) = same aspect
    /// as the window font). Each axis is clamped to a sane range so a bad
    /// font (or a runaway computed aspect) can never make a pane 0 cells
    /// or absurdly many.
    fn get_family_ratio(&self) -> (f64, f64) {
        *self.family_ratio.lock()
    }
    fn set_family_ratio(&self, width: f64, height: f64) {
        let clamp = |v: f64| {
            if v.is_finite() && v > 0.0 {
                v.clamp(0.1, 10.0)
            } else {
                1.0
            }
        };
        *self.family_ratio.lock() = (clamp(width), clamp(height));
    }

    fn get_theme_id(&self) -> Option<String> {
        self.theme_id.lock().clone()
    }
    fn set_theme_id(&self, id: Option<String>) {
        *self.theme_id.lock() = id;
    }

    /// WezTerminator (patch 0022): write raw bytes to the
    /// underlying PTY. Used by the right-click "Paste image" entry
    /// to send an OSC 1337 iTerm2 inline-image escape.
    fn write(&self, bytes: &[u8]) -> anyhow::Result<()> {
        let mut writer = self.writer();
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    fn domain_id(&self) -> DomainId {
        self.domain_id
    }

    fn erase_scrollback(&self, erase_mode: ScrollbackEraseMode) {
        match erase_mode {
            ScrollbackEraseMode::ScrollbackOnly => {
                self.terminal.lock().erase_scrollback();
            }
            ScrollbackEraseMode::ScrollbackAndViewport => {
                self.terminal.lock().erase_scrollback_and_viewport();
            }
        }
    }

    fn focus_changed(&self, focused: bool) {
        self.terminal.lock().focus_changed(focused);
    }

    fn has_unseen_output(&self) -> bool {
        self.terminal.lock().has_unseen_output()
    }

    fn is_mouse_grabbed(&self) -> bool {
        if self.tmux_domain.lock().is_some() {
            false
        } else {
            self.terminal.lock().is_mouse_grabbed()
        }
    }

    fn is_alt_screen_active(&self) -> bool {
        if self.tmux_domain.lock().is_some() {
            false
        } else {
            self.terminal.lock().is_alt_screen_active()
        }
    }

    fn get_current_working_dir(&self, policy: CachePolicy) -> Option<Url> {
        // Windows PowerShell updates $PWD (the `PS C:\...>` prompt) on cd,
        // but leaves the Win32 process directory at the folder where
        // powershell.exe started. OSC 7 is absent on the default prompt, so
        // the process directory stays wrong for the whole session. Read the
        // prompt when the foreground process is powershell/pwsh.
        #[cfg(windows)]
        if let Some(url) = self.windows_powershell_prompt_cwd(policy) {
            return Some(url);
        }
        self.terminal
            .lock()
            .get_current_dir()
            .cloned()
            .or_else(|| self.divine_current_working_dir(policy))
    }

    fn tty_name(&self) -> Option<String> {
        #[cfg(unix)]
        {
            let name = self.pty.lock().tty_name()?;
            Some(name.to_string_lossy().into_owned())
        }

        #[cfg(windows)]
        {
            None
        }
    }

    fn get_foreground_process_info(&self, policy: CachePolicy) -> Option<LocalProcessInfo> {
        #[cfg(unix)]
        if let Some(pid) = self.pty.lock().process_group_leader() {
            return LocalProcessInfo::with_root_pid(pid as u32);
        }

        self.divine_foreground_process(policy)
    }

    fn get_foreground_process_name(&self, policy: CachePolicy) -> Option<String> {
        #[cfg(unix)]
        {
            let leader = self.get_leader(policy);
            if let Some(path) = &leader.path {
                return Some(path.to_string_lossy().to_string());
            }
            return None;
        }

        #[cfg(windows)]
        if let Some(fg) = self.divine_foreground_process(policy) {
            return Some(fg.executable.to_string_lossy().to_string());
        }

        #[allow(unreachable_code)]
        None
    }

    fn can_close_without_prompting(&self, _reason: CloseReason) -> bool {
        if let Some(info) = self.divine_process_list(CachePolicy::FetchImmediate) {
            log::trace!(
                "can_close_without_prompting? procs in pane {:#?}",
                info.root
            );

            let hook_result = config::run_immediate_with_lua_config(|lua| {
                let lua = match lua {
                    Some(lua) => lua,
                    None => return Ok(None),
                };
                let v = config::lua::emit_sync_callback(
                    &*lua,
                    ("mux-is-process-stateful".to_string(), (info.root.clone())),
                )?;
                match v {
                    mlua::Value::Nil => Ok(None),
                    mlua::Value::Boolean(v) => Ok(Some(v)),
                    _ => Ok(None),
                }
            });

            fn default_stateful_check(proc_list: &LocalProcessInfo) -> bool {
                // Fig uses `figterm` a pseudo terminal for a lot of functionality, it runs between
                // the shell and terminal. Unfortunately it is typically named `<shell> (figterm)`,
                // which prevents the statuful check from passing. This strips the suffix from the
                // process name to allow the check to pass.
                let names = proc_list
                    .flatten_to_exe_names()
                    .into_iter()
                    .map(|s| match s.strip_suffix(" (figterm)") {
                        Some(s) => s.into(),
                        None => s,
                    })
                    .collect::<HashSet<_>>();

                let skip = configuration()
                    .skip_close_confirmation_for_processes_named
                    .iter()
                    .cloned()
                    .collect::<HashSet<_>>();

                if !names.is_subset(&skip) {
                    // There are other processes running than are listed,
                    // so we consider this to be stateful
                    return true;
                }
                false
            }

            let is_stateful = match hook_result {
                Ok(None) => default_stateful_check(&info.root),
                Ok(Some(s)) => s,
                Err(err) => {
                    log::error!(
                        "Error while running mux-is-process-stateful \
                         hook: {:#}, falling back to default behavior",
                        err
                    );
                    default_stateful_check(&info.root)
                }
            };

            !is_stateful
        } else {
            #[cfg(unix)]
            {
                // If the process is dead but exit_behavior is holding the
                // window, we don't need to prompt to confirm closing.
                // That is detectable as no longer having a process group leader.
                if self.pty.lock().process_group_leader().is_none() {
                    return true;
                }
            }

            false
        }
    }

    fn get_semantic_zones(&self) -> anyhow::Result<Vec<SemanticZone>> {
        let mut term = self.terminal.lock();
        term.get_semantic_zones()
    }

    async fn search(
        &self,
        pattern: Pattern,
        range: Range<StableRowIndex>,
        limit: Option<u32>,
    ) -> anyhow::Result<Vec<SearchResult>> {
        let term = self.terminal.lock();
        let screen = term.screen();

        enum CompiledPattern {
            CaseSensitiveString(String),
            CaseInSensitiveString(String),
            Regex(Regex),
        }

        let pattern = match pattern {
            Pattern::CaseSensitiveString(s) => CompiledPattern::CaseSensitiveString(s),
            Pattern::CaseInSensitiveString(s) => {
                // normalize the case so we match everything lowercase
                CompiledPattern::CaseInSensitiveString(s.to_lowercase())
            }
            Pattern::Regex(r) => CompiledPattern::Regex(Regex::new(&r)?),
        };

        let mut results = vec![];
        let mut uniq_matches: HashMap<String, usize> = HashMap::new();

        screen.for_each_logical_line_in_stable_range(range, |sr, lines| {
            if let Some(limit) = limit {
                if results.len() == limit as usize {
                    // We've reach the limit, stop iteration.
                    return false;
                }
            }

            if lines.is_empty() {
                // Nothing to do on this iteration, carry on with the next.
                return true;
            }
            let haystack = if lines.len() == 1 {
                lines[0].as_str()
            } else {
                let mut s = String::new();
                for line in lines {
                    s.push_str(&line.as_str());
                }
                Cow::Owned(s)
            };
            let stable_idx = sr.start;

            if haystack.is_empty() {
                return true;
            }

            let haystack = match &pattern {
                CompiledPattern::CaseInSensitiveString(_) => Cow::Owned(haystack.to_lowercase()),
                _ => haystack,
            };
            let mut coords = None;

            match &pattern {
                CompiledPattern::CaseInSensitiveString(s)
                | CompiledPattern::CaseSensitiveString(s) => {
                    for (idx, s) in haystack.match_indices(s) {
                        found_match(
                            s,
                            idx,
                            lines,
                            stable_idx,
                            &mut uniq_matches,
                            &mut coords,
                            &mut results,
                        );
                    }
                }
                CompiledPattern::Regex(re) => {
                    // Allow for the regex to contain captures
                    for capture_res in re.captures_iter(&haystack) {
                        if let Ok(c) = capture_res {
                            // Look for the captures in reverse order, as index==0 is
                            // the whole matched string.  We can't just call
                            // `c.iter().rev()` as the capture iterator isn't double-ended.
                            for idx in (0..c.len()).rev() {
                                if let Some(m) = c.get(idx) {
                                    found_match(
                                        m.as_str(),
                                        m.start(),
                                        lines,
                                        stable_idx,
                                        &mut uniq_matches,
                                        &mut coords,
                                        &mut results,
                                    );
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Keep iterating
            true
        });

        #[derive(Copy, Clone, Debug)]
        struct Coord {
            byte_idx: usize,
            grapheme_idx: usize,
            stable_row: StableRowIndex,
        }

        fn found_match(
            text: &str,
            byte_idx: usize,
            lines: &[&Line],
            stable_idx: StableRowIndex,
            uniq_matches: &mut HashMap<String, usize>,
            coords: &mut Option<Vec<Coord>>,
            results: &mut Vec<SearchResult>,
        ) {
            if coords.is_none() {
                coords.replace(make_coords(lines, stable_idx));
            }
            let coords = coords.as_ref().unwrap();

            let match_id = match uniq_matches.get(text).copied() {
                Some(id) => id,
                None => {
                    let id = uniq_matches.len();
                    uniq_matches.insert(text.to_owned(), id);
                    id
                }
            };
            let (start_x, start_y) = haystack_idx_to_coord(byte_idx, coords);
            let (end_x, end_y) = haystack_idx_to_coord(byte_idx + text.len(), coords);
            results.push(SearchResult {
                start_x,
                start_y,
                end_x,
                end_y,
                match_id,
            });
        }

        fn make_coords(lines: &[&Line], stable_row: StableRowIndex) -> Vec<Coord> {
            let mut byte_idx = 0;
            let mut coords = vec![];

            for (row_idx, line) in lines.iter().enumerate() {
                for cell in line.visible_cells() {
                    coords.push(Coord {
                        byte_idx,
                        grapheme_idx: cell.cell_index(),
                        stable_row: stable_row + row_idx as StableRowIndex,
                    });
                    byte_idx += cell.str().len();
                }
            }

            coords
        }

        fn haystack_idx_to_coord(idx: usize, coords: &[Coord]) -> (usize, StableRowIndex) {
            let c = coords
                .binary_search_by(|ele| ele.byte_idx.cmp(&idx))
                .or_else(|i| -> Result<usize, usize> { Ok(i) })
                .unwrap();
            let coord = coords.get(c).map(|c| *c).unwrap_or_else(|| {
                let last = coords.last().unwrap();
                Coord {
                    grapheme_idx: last.grapheme_idx + 1,
                    ..*last
                }
            });
            (coord.grapheme_idx, coord.stable_row)
        }

        Ok(results)
    }
}

struct LocalPaneDCSHandler {
    pane_id: PaneId,
    tmux_domain: Option<Arc<TmuxDomainState>>,
}

pub(crate) fn emit_output_for_pane(pane_id: PaneId, message: &str) {
    let mut parser = termwiz::escape::parser::Parser::new();
    let mut actions = vec![Action::CSI(CSI::Sgr(Sgr::Reset))];
    parser.parse(message.as_bytes(), |action| actions.push(action));

    promise::spawn::spawn_into_main_thread(async move {
        let mux = Mux::get();
        if let Some(pane) = mux.get_pane(pane_id) {
            pane.perform_actions(actions);
            mux.notify(MuxNotification::PaneOutput(pane_id));
        }
    })
    .detach();
}

impl wezterm_term::DeviceControlHandler for LocalPaneDCSHandler {
    fn handle_device_control(&mut self, control: termwiz::escape::DeviceControlMode) {
        match control {
            DeviceControlMode::Enter(mode) => {
                if !mode.ignored_extra_intermediates
                    && mode.params.len() == 1
                    && mode.params[0] == 1000
                    && mode.intermediates.is_empty()
                {
                    log::info!("tmux -CC mode requested");

                    // Create a new domain to host these tmux tabs
                    let domain = TmuxDomain::new(self.pane_id);
                    let tmux_domain = Arc::clone(&domain.inner);

                    let domain: Arc<dyn Domain> = Arc::new(domain);
                    let mux = Mux::get();
                    mux.add_domain(&domain);

                    if let Some(pane) = mux.get_pane(self.pane_id) {
                        let pane = pane.downcast_ref::<LocalPane>().unwrap();
                        pane.tmux_domain.lock().replace(Arc::clone(&tmux_domain));

                        emit_output_for_pane(
                            self.pane_id,
                            "\r\n[This pane is running tmux control mode. Press q to detach]",
                        );
                    }

                    self.tmux_domain.replace(tmux_domain);

                // TODO: do we need to proactively list available tabs here?
                // if so we should arrange to call domain.attach() and make
                // it do the right thing.
                } else if configuration().log_unknown_escape_sequences {
                    log::warn!("unknown DeviceControlMode::Enter {:?}", mode,);
                }
            }
            DeviceControlMode::Exit => {
                if let Some(tmux) = self.tmux_domain.take() {
                    let mux = Mux::get();
                    if let Some(pane) = mux.get_pane(self.pane_id) {
                        let pane = pane.downcast_ref::<LocalPane>().unwrap();
                        pane.tmux_domain.lock().take();
                    }
                    mux.domain_was_detached(tmux.domain_id);
                }
            }
            DeviceControlMode::Data(c) => {
                if configuration().log_unknown_escape_sequences {
                    log::warn!(
                        "unhandled DeviceControlMode::Data {:x} {}",
                        c,
                        (c as char).escape_debug()
                    );
                }
            }
            DeviceControlMode::TmuxEvents(events) => {
                if let Some(tmux) = self.tmux_domain.as_ref() {
                    tmux.advance(events);
                } else {
                    log::warn!("unhandled DeviceControlMode::TmuxEvents {:?}", &events);
                }
            }
            _ => {
                if configuration().log_unknown_escape_sequences {
                    log::warn!("unhandled: {:?}", control);
                }
            }
        }
    }
}

struct LocalPaneNotifHandler {
    pane_id: PaneId,
}

impl AlertHandler for LocalPaneNotifHandler {
    fn alert(&mut self, alert: Alert) {
        let pane_id = self.pane_id;
        promise::spawn::spawn_into_main_thread(async move {
            let mux = Mux::get();
            match &alert {
                Alert::WindowTitleChanged(title) => {
                    if let Some((_domain, window_id, _tab_id)) = mux.resolve_pane_id(pane_id) {
                        if let Some(mut window) = mux.get_window_mut(window_id) {
                            window.set_title(title);
                        }
                    }
                }
                Alert::TabTitleChanged(title) => {
                    if let Some((_domain, _window_id, tab_id)) = mux.resolve_pane_id(pane_id) {
                        if let Some(tab) = mux.get_tab(tab_id) {
                            tab.set_title(title.as_deref().unwrap_or(""));
                        }
                    }
                }
                _ => {}
            }

            mux.notify(MuxNotification::Alert { pane_id, alert });
        })
        .detach();
    }
}

/// This is a little gross; on some systems, our pipe reader will continue
/// to be blocked in read even after the child process has died.
/// We need to wake up and notice that the child terminated in order
/// for our state to wind down.
/// This block schedules a background thread to wait for the child
/// to terminate, and then nudge the muxer to check for dead processes.
/// Without this, typing `exit` in `cmd.exe` would keep the pane around
/// until something else triggered the mux to prune dead processes.
fn split_child(
    mut process: Box<dyn Child>,
) -> (
    Receiver<IoResult<ExitStatus>>,
    Box<dyn ChildKiller + Sync>,
    Option<u32>,
) {
    let pid = process.process_id();
    let signaller = process.clone_killer();

    let (tx, rx) = bounded(1);

    std::thread::spawn(move || {
        let status = process.wait();
        tx.try_send(status).ok();
        promise::spawn::spawn_into_main_thread(async move {
            let mux = Mux::get();
            mux.prune_dead_windows();
        })
        .detach();
    });

    (rx, signaller, pid)
}

impl LocalPane {
    pub fn new(
        pane_id: PaneId,
        mut terminal: Terminal,
        process: Box<dyn Child + Send>,
        pty: Box<dyn MasterPty>,
        writer: Box<dyn Write + Send>,
        domain_id: DomainId,
        command_description: String,
    ) -> Self {
        let (process, signaller, pid) = split_child(process);

        terminal.set_device_control_handler(Box::new(LocalPaneDCSHandler {
            pane_id,
            tmux_domain: None,
        }));
        terminal.set_notification_handler(Box::new(LocalPaneNotifHandler { pane_id }));

        Self {
            pane_id,
            terminal: Mutex::new(terminal),
            process: Mutex::new(ProcessState::Running {
                child_waiter: process,
                pid,
                signaller,
                killed: false,
            }),
            pty: Mutex::new(pty),
            writer: Mutex::new(writer),
            domain_id,
            tmux_domain: Mutex::new(None),
            proc_list: Arc::new(Mutex::new(None)),
            proc_refreshing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            #[cfg(unix)]
            leader: Arc::new(Mutex::new(None)),
            command_description,
            header_text: Mutex::new(None),
            font_scale: Mutex::new(1.0),
            font_family: Mutex::new(None),
            font_bold: Mutex::new(false),
            font_italic: Mutex::new(false),
            family_ratio: Mutex::new((1.0, 1.0)),
            theme_id: Mutex::new(None),
        }
    }

    #[cfg(unix)]
    fn get_leader(&self, policy: CachePolicy) -> CachedLeaderInfo {
        let mut leader = self.leader.lock();

        if policy == CachePolicy::FetchImmediate {
            leader.replace(CachedLeaderInfo::new(self.pty.lock().as_raw_fd()));
        } else if let Some(info) = leader.as_mut() {
            // If stale, queue up some work in another thread to update.
            // Right now, we'll return the stale data.
            if info.expired() && info.can_update() {
                info.updating = true;
                let leader_ref = Arc::clone(&self.leader);
                std::thread::spawn(move || {
                    let mut leader = leader_ref.lock();
                    if let Some(leader) = leader.as_mut() {
                        leader.update();
                    }
                });
            }
        } else {
            leader.replace(CachedLeaderInfo::new(self.pty.lock().as_raw_fd()));
        }

        (*leader).clone().unwrap()
    }

    /// Folder from the last default PowerShell prompt on the primary screen.
    /// None when the foreground process is not powershell/pwsh, the alt
    /// screen is up, or no `PS C:\...>` prompt is visible.
    #[cfg(windows)]
    fn windows_powershell_prompt_cwd(&self, policy: CachePolicy) -> Option<Url> {
        let fg = self.divine_foreground_process(policy)?;
        if !is_powershell_process(&fg) {
            return None;
        }
        let term = self.terminal.lock();
        if term.is_alt_screen_active() {
            return None;
        }
        let screen = term.screen();
        let end = screen.scrollback_rows();
        let start = end.saturating_sub(80);
        let lines = screen.lines_in_phys_range(start..end);
        let mut text = String::new();
        for line in &lines {
            text.push_str(line.as_str().trim_end());
            if !line.last_cell_was_wrapped() {
                text.push('\n');
            }
        }
        drop(term);
        let path = last_powershell_prompt_path(&text)?;
        Url::from_directory_path(path).ok()
    }

    fn divine_current_working_dir(&self, policy: CachePolicy) -> Option<Url> {
        #[cfg(unix)]
        {
            let leader = self.get_leader(policy);
            if let Some(path) = &leader.current_working_dir {
                return Url::from_directory_path(path).ok();
            }
            return None;
        }

        #[cfg(windows)]
        if let Some(fg) = self.divine_foreground_process(policy) {
            return Url::from_directory_path(fg.cwd).ok();
        }

        #[allow(unreachable_code)]
        None
    }

    fn divine_process_list(
        &self,
        policy: CachePolicy,
    ) -> Option<MappedMutexGuard<'_, CachedProcInfo>> {
        let pid = match &*self.process.lock() {
            ProcessState::Running { pid: Some(pid), .. } => *pid,
            _ => return None,
        };
        let mut proc_list = self.proc_list.lock();

        let age = proc_list.as_ref().map(|info| info.updated.elapsed());
        let expired = policy == CachePolicy::FetchImmediate
            || age.map(|a| a > PROC_INFO_CACHE_TTL).unwrap_or(true);

        if expired {
            if policy == CachePolicy::AllowStale && age.is_some() {
                // Patch 0200: a stale answer is fine here. The refresh walks
                // the whole process table (snapshot + a PEB read per
                // process), about a second for 30 panes, and callers such
                // as ListPanes run on the host main thread, which also
                // moves keystrokes. Refresh off-thread, answer from cache.
                if !self
                    .proc_refreshing
                    .swap(true, std::sync::atomic::Ordering::AcqRel)
                {
                    let cache = Arc::clone(&self.proc_list);
                    let flag = Arc::clone(&self.proc_refreshing);
                    std::thread::spawn(move || {
                        if let Some(fresh) = build_cached_proc_info(pid) {
                            cache.lock().replace(fresh);
                        }
                        flag.store(false, std::sync::atomic::Ordering::Release);
                    });
                }
            } else {
                log::trace!("CachedProcInfo expired, refresh");
                proc_list.replace(build_cached_proc_info(pid)?);
                log::trace!("CachedProcInfo updated");
            }
        }

        Some(MutexGuard::map(proc_list, |info| info.as_mut().unwrap()))
    }

    #[allow(dead_code)]
    fn divine_foreground_process(&self, policy: CachePolicy) -> Option<LocalProcessInfo> {
        if let Some(info) = self.divine_process_list(policy) {
            Some(info.foreground.clone())
        } else {
            None
        }
    }
}

/// Patch 0200: the process-table walk behind `divine_process_list`.
fn build_cached_proc_info(pid: u32) -> Option<CachedProcInfo> {
    let root = LocalProcessInfo::with_root_pid(pid)?;

    // Windows doesn't have any job control or session concept,
    // so we infer that the equivalent to the process group
    // leader is the most recently spawned program running
    // in the console
    let mut youngest = &root;

    fn find_youngest<'a>(proc: &'a LocalProcessInfo, youngest: &mut &'a LocalProcessInfo) {
        if proc.start_time >= youngest.start_time {
            *youngest = proc;
        }

        for child in proc.children.values() {
            #[cfg(windows)]
            if child.console == 0 {
                continue;
            }
            find_youngest(child, youngest);
        }
    }

    find_youngest(&root, &mut youngest);
    let mut foreground = youngest.clone();
    foreground.children.clear();

    Some(CachedProcInfo {
        root,
        foreground,
        updated: Instant::now(),
    })
}

impl Drop for LocalPane {
    fn drop(&mut self) {
        // Avoid lingering zombies if we can, but don't block forever.
        // <https://github.com/wezterm/wezterm/issues/558>
        if let ProcessState::Running { signaller, .. } = &mut *self.process.lock() {
            let _ = signaller.kill();
        }
    }
}

#[cfg(windows)]
fn is_powershell_process(info: &LocalProcessInfo) -> bool {
    fn matches(name: &str) -> bool {
        let n = name.to_ascii_lowercase();
        n == "powershell.exe" || n == "pwsh.exe"
    }
    if matches(&info.name) {
        return true;
    }
    info.executable
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(matches)
}

/// Last default PowerShell prompt (`PS C:\dir>` or `PS \\server\share>`) in
/// `text`. Nested prompts (`>>`) and a command typed after the prompt are
/// ignored. Non-filesystem locations (`PS HKLM:\...`) are skipped.
#[cfg(windows)]
fn last_powershell_prompt_path(text: &str) -> Option<String> {
    let mut found = None;
    for raw in text.lines() {
        let line = raw.trim_end();
        let Some(rest) = line.strip_prefix("PS ") else {
            continue;
        };
        let Some(gt) = rest.find('>') else {
            continue;
        };
        let path = rest[..gt].trim();
        let bytes = path.as_bytes();
        let drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/');
        let unc = path.starts_with("\\\\");
        if drive || unc {
            found = Some(path.replace('/', "\\"));
        }
    }
    found
}

#[cfg(all(test, windows))]
mod powershell_cwd_tests {
    use super::last_powershell_prompt_path;

    #[test]
    fn uses_the_latest_prompt_not_the_startup_folder() {
        let text = "\
PS C:\\src\\app>  cd ..
PS C:\\src> cd ..
PS C:\\Tools\\demo> .\\demo.exe
PS C:\\Tools\\demo>
";
        assert_eq!(
            last_powershell_prompt_path(text).as_deref(),
            Some("C:\\Tools\\demo")
        );
    }

    #[test]
    fn home_startup_does_not_hide_a_later_cd() {
        let text = "PS C:\\Users\\dev> cd C:\\src\\project\nPS C:\\src\\project>\n";
        assert_eq!(
            last_powershell_prompt_path(text).as_deref(),
            Some("C:\\src\\project")
        );
    }

    #[test]
    fn nested_prompt_and_spaces() {
        assert_eq!(
            last_powershell_prompt_path("PS C:\\Program Files\\SDK>> ").as_deref(),
            Some("C:\\Program Files\\SDK")
        );
    }

    #[test]
    fn skips_non_filesystem_and_unrelated_text() {
        let text = "PS HKLM:\\Software>\nnot a prompt\n";
        assert_eq!(last_powershell_prompt_path(text), None);
    }
}
