// wtinator::tray — hide BethTerm windows to the notification area
// (the icon next to the clock) instead of killing PTYs on the title-bar X.
//
// The icon lives as long as the GUI process, even with zero hidden
// windows: its menu is the app launcher ("Novo terminal" spawns a
// default terminal in a new OS window) plus restore/quit.
//
// Explorer restarts wipe notification-area icons. Patch 0126 re-adds
// ours on TaskbarCreated, on NIM_MODIFY failure, and on a quiet
// timer so tray-hidden windows stay reachable without the taskbar.
//
// The right-click menu lists every live terminal (hidden in the tray
// and already visible). Open windows are marked with a leading "*".
// Left-click always opens the same picker. Separate BethTerm processes
// share one tray owner via WM_COPYDATA.

#![allow(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use windows_sys::Win32::Foundation::{
    GetLastError, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyMenu, DestroyWindow, FindWindowW,
    DispatchMessageW, EnumWindows, GetClassNameW, GetCursorPos, GetMessageW, GetPropW,
    GetWindowRect, GetWindowTextW, IsIconic, IsWindow, IsWindowVisible, IsZoomed,
    PostMessageW, RegisterClassExW, RegisterWindowMessageW, RemovePropW, SendMessageTimeoutW,
    SetForegroundWindow, SetPropW, SetTimer, ShowWindow, TranslateMessage,
    MSG, WNDCLASSEXW, MF_POPUP, MF_SEPARATOR, MF_STRING, SMTO_ABORTIFHUNG,
    SW_HIDE, SW_SHOW, TPM_RIGHTBUTTON, GetWindowThreadProcessId, HWND_MESSAGE, MF_CHECKED,
    MF_GRAYED, SetMenuDefaultItem,
    SW_RESTORE, WM_APP, WM_CLOSE, WM_COMMAND, WM_COPYDATA, WM_DESTROY, WM_LBUTTONUP, WM_NULL,
    WM_RBUTTONUP, WM_TIMER, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};

const WM_TRAY: u32 = WM_APP + 42;
const WM_TRAY_SYNC: u32 = WM_APP + 43;
/// Patch 0145: the icon id is bumped on every forced re-add so Explorer
/// cannot match a stale record it kept after a timeout (err 1460).
static TRAY_UID_CUR: AtomicU32 = AtomicU32::new(1);
fn tray_uid() -> u32 {
    TRAY_UID_CUR.load(Ordering::Relaxed)
}
fn bump_tray_uid() -> u32 {
    TRAY_UID_CUR.fetch_add(1, Ordering::Relaxed) + 1
}
/// Quiet re-add while the GUI lives (Explorer can drop icons without
/// a TaskbarCreated we receive — especially on HWND_MESSAGE fallback).
const TRAY_ICON_WATCH_MS: u32 = 15_000;
const TRAY_ICON_TIMER_ID: usize = 1;
const ID_OPEN_ALL: usize = 1;
const ID_QUIT: usize = 2;
const ID_NEW_WINDOW: usize = 3;
const ID_SYS_PANEL: usize = 4;
const ID_KILL_HOST: usize = 5;
const ID_DASHBOARD: usize = 6;
const ID_MODE_CLASSIC: usize = 7;
const ID_MODE_DASHBOARD: usize = 8;
/// "Reiniciar a janela nativa" (patches 0147, 0195, 0196): restart only bethterm-gui.exe.
const ID_GUI_RESTART: usize = 9;
/// "Esconder tudo" (patch 0150). Above the shell-picker range.
const ID_HIDE_ALL: usize = 90;
/// Drawing device (patch 0155). Above the shell-picker range.
const ID_RENDER_GPU: usize = 91;
const ID_RENDER_CPU: usize = 92;
/// "Beth Studio" (patches 0173, 0186): open bethterm-web.exe.
const ID_WEB_UI: usize = 93;
/// "Usar a janela nativa" (patches 0192, 0195, 0196): terminal windows on or off.
const ID_NATIVE_GUI: usize = 94;
/// Shell picker under "Novo terminal" (patch 0117). Stays below
/// `ID_WINDOW_BASE` so hidden-window rows keep their ids.
const ID_SHELL_BASE: usize = 10;
const ID_WINDOW_BASE: usize = 100;
const CLASS_NAME: &str = "BethTermTray";
const WINDOW_TITLE: &str = "BethTermTrayOwner";
const MUTEX_NAME: &str = "Local\\BethTermTrayOwner";
const FORCE_QUIT_PROP: &str = "BethTerm.ForceQuit";
const TRAY_IPC_MAGIC: usize = 0x4254_5231; // "BTR1"
const MAX_MENU_LABEL: usize = 48;

static FORCE_QUIT: AtomicBool = AtomicBool::new(false);
static TRAY: OnceLock<Mutex<TrayState>> = OnceLock::new();
static THREAD_STARTED: OnceLock<()> = OnceLock::new();
/// `RegisterWindowMessageW("TaskbarCreated")` — Explorer broadcast after
/// a shell restart. 0 until the tray thread registers it.
static TASKBAR_CREATED_MSG: AtomicU32 = AtomicU32::new(0);
/// Handler that opens a new OS window. `None` uses the default
/// program; `Some(args)` is program + argv from the tray shell
/// picker (patch 0117). Registered once by the GUI (`init_for_gui`).
static NEW_WINDOW_HANDLER: OnceLock<fn(Option<Vec<String>>)> = OnceLock::new();
/// Opens the left-rail dashboard in a live GUI window (patch 0124).
static DASHBOARD_HANDLER: OnceLock<fn()> = OnceLock::new();
/// Windows shown in the current tray popup (hidden + visible).
static MENU_WINDOWS: OnceLock<Mutex<Vec<MenuWindow>>> = OnceLock::new();

fn tray_lock() -> std::sync::MutexGuard<'static, TrayState> {
    TRAY.get_or_init(|| {
        Mutex::new(TrayState {
            hwnd: 0,
            icon_added: false,
            hidden: Vec::new(),
        })
    })
    .lock()
    .unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone)]
struct HiddenWindow {
    hwnd: isize,
    title: String,
    was_maximized: bool,
}

/// One BethTerm GUI window in the tray picker (patch 0120).
#[derive(Clone)]
struct MenuWindow {
    hwnd: isize,
    title: String,
    was_maximized: bool,
    is_hidden: bool,
}

struct TrayState {
    hwnd: isize,
    icon_added: bool,
    hidden: Vec<HiddenWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TrayIpc {
    cmd: String,
    hwnd: i64,
    maximized: bool,
    title: String,
}

fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// True when the next title-bar X / Alt+F4 should run the real quit
/// confirmation instead of hiding to the tray.
pub fn take_force_quit() -> bool {
    FORCE_QUIT.swap(false, Ordering::SeqCst)
}

/// True when this window must really close (tray "Sair", or a force-quit
/// property set by the shared tray owner in another process).
pub fn should_really_quit(hwnd: isize) -> bool {
    let quit = take_hwnd_force_quit(hwnd) || FORCE_QUIT.load(Ordering::SeqCst);
    if quit {
        // Patch 0165: remember it, so the empty mux ends the process.
        FORCE_QUIT.store(true, Ordering::SeqCst);
    }
    quit
}

/// Patch 0165: tray "Sair" / "Encerrar BethTerm" (or a window closed
/// for real) asked this process to quit. Otherwise closing the last
/// window keeps BethTerm in the tray.
pub fn quit_requested() -> bool {
    FORCE_QUIT.load(Ordering::SeqCst)
}

fn take_hwnd_force_quit(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    let name = wide(FORCE_QUIT_PROP);
    unsafe {
        let prev = GetPropW(hwnd as HWND, name.as_ptr());
        if prev.is_null() {
            false
        } else {
            RemovePropW(hwnd as HWND, name.as_ptr());
            true
        }
    }
}

fn mark_hwnd_force_quit(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    let name = wide(FORCE_QUIT_PROP);
    unsafe {
        SetPropW(hwnd as HWND, name.as_ptr(), 1 as HANDLE);
    }
}

/// Hide `hwnd` (`SW_HIDE`) and stack it on the shared notification-area
/// icon. PTYs keep running. `mux_window_id` is used only to pick a label.
///
/// Must not create Win32 windows on the caller's thread: this runs inside
/// `WM_CLOSE` / the title-bar X handler, which already holds the window
/// borrow. Nested `CreateWindow` panics and kills the process (exit 1).
pub fn hide_window(hwnd: isize, mux_window_id: mux::window::WindowId) -> anyhow::Result<()> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        hide_window_inner(hwnd, mux_window_id)
    })) {
        Ok(result) => result,
        Err(_) => anyhow::bail!("tray hide panicked"),
    }
}

/// Register the "Novo terminal" spawn handler and make sure the
/// notification-area icon exists, even with zero hidden windows.
///
/// Call once from the GUI process at startup (BethTerm mode only).
/// When another BethTerm process already owns the tray icon, this
/// process stays in forward mode (its hides go to the owner via IPC)
/// and creates no second icon.
pub fn init_for_gui(new_window: fn(Option<Vec<String>>)) {
    let _ = NEW_WINDOW_HANDLER.set(new_window);
    ensure_tray_owner();
}

/// Register the tray "Painel" action (GUI thread hop lives in the GUI).
pub fn register_dashboard(open: fn()) {
    let _ = DASHBOARD_HANDLER.set(open);
}

/// Create the shared tray owner (and its icon) when no BethTerm
/// process owns one yet. Idempotent: safe to call on every window
/// creation and on every hide.
pub fn ensure_tray_owner() {
    with_tray_mutex(|| {
        if find_owner().is_some() {
            return;
        }
        ensure_tray_thread();
    });
}

/// Bring an already-running BethTerm GUI to the front instead of spawning
/// another window. Used when the shortcut is clicked while a GUI is live.
pub fn focus_existing_gui() -> bool {
    if let Some(owner) = find_owner() {
        let msg = TrayIpc {
            cmd: "restore_all".to_string(),
            hwnd: 0,
            maximized: false,
            title: String::new(),
        };
        let _ = send_ipc(owner, &msg);
        if !focus_bethterm_gui_windows() {
            // Patch 0192: tray only on purpose. Do not open a window.
            if !crate::native_gui::enabled() {
                crate::host::note_life(
                    "second launch: native GUI is off; tray stays, no terminal window",
                );
                return true;
            }
            // Patch 0165: tray only, no window left. Open a new one.
            let msg = TrayIpc {
                cmd: "new_window".to_string(),
                hwnd: 0,
                maximized: false,
                title: String::new(),
            };
            return send_ipc(owner, &msg);
        }
        return true;
    }
    focus_bethterm_gui_windows()
}

fn hide_window_inner(hwnd: isize, mux_window_id: mux::window::WindowId) -> anyhow::Result<()> {
    if hwnd == 0 {
        anyhow::bail!("tray::hide_window: null hwnd");
    }
    let title = label_from_mux(mux_window_id)
        .or_else(|| os_window_title(hwnd))
        .unwrap_or_else(|| "BethTerm".to_string());
    let was_maximized = unsafe { IsZoomed(hwnd as HWND) != 0 };
    hide_os_window(hwnd, title, was_maximized)
}

/// `SW_HIDE` plus the tray list. Same result as the title-bar X.
fn hide_os_window(hwnd: isize, title: String, was_maximized: bool) -> anyhow::Result<()> {
    if hwnd == 0 {
        anyhow::bail!("tray::hide_window: null hwnd");
    }
    unsafe {
        ShowWindow(hwnd as HWND, SW_HIDE);
    }
    crate::window_geom::note_hidden(hwnd);
    let ipc = TrayIpc {
        cmd: "hide".to_string(),
        hwnd: hwnd as i64,
        maximized: was_maximized,
        title,
    };
    match with_tray_mutex(|| register_hidden(ipc)) {
        Ok(()) => Ok(()),
        Err(e) => {
            unsafe {
                ShowWindow(hwnd as HWND, SW_SHOW);
            }
            crate::window_geom::clear_keep_hidden(hwnd);
            Err(e)
        }
    }
}

/// Patch 0150: hide every visible BethTerm window. Terminals stay.
fn hide_all_visible() {
    let windows = collect_menu_windows();
    for win in windows {
        if win.is_hidden {
            continue;
        }
        if unsafe { IsWindowVisible(win.hwnd as HWND) } == 0 {
            continue;
        }
        if let Err(e) = hide_os_window(win.hwnd, win.title.clone(), win.was_maximized) {
            log::warn!("bethterm tray: esconder tudo: {e:#}");
        }
    }
}

fn label_from_mux(mux_window_id: mux::window::WindowId) -> Option<String> {
    let mux = mux::Mux::try_get()?;
    let window = mux.get_window(mux_window_id)?;
    if let Some(name) = window.get_user_title() {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let title = window.get_title().trim();
    if !title.is_empty() {
        return Some(title.to_string());
    }
    if let Some(tab) = window.get_active() {
        if let Some(name) = tab.get_user_title() {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        let tab_title = tab.get_title();
        let trimmed = tab_title.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn os_window_title(hwnd: isize) -> Option<String> {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(hwnd as HWND, buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return None;
    }
    String::from_utf16(&buf[..n as usize])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn register_hidden(ipc: TrayIpc) -> anyhow::Result<()> {
    if let Some(owner) = find_owner() {
        let ours = tray_lock().hwnd;
        if ours == 0 || owner != ours {
            if send_ipc(owner, &ipc) {
                return Ok(());
            }
        }
    }
    {
        let mut state = tray_lock();
        apply_hide(&mut state, ipc);
    }
    ensure_tray_thread();
    let tray_hwnd = tray_lock().hwnd;
    if tray_hwnd != 0 {
        unsafe {
            PostMessageW(tray_hwnd as HWND, WM_TRAY_SYNC, 0, 0);
        }
    }
    Ok(())
}

/// Patch 0165: a BethTerm tray icon is running on this desktop.
pub fn owner_exists() -> bool {
    find_owner().is_some()
}

fn find_owner() -> Option<isize> {
    let class = wide(CLASS_NAME);
    let title = wide(WINDOW_TITLE);
    let hwnd = unsafe { FindWindowW(class.as_ptr(), title.as_ptr()) };
    if hwnd.is_null() {
        None
    } else {
        Some(hwnd as isize)
    }
}

fn send_ipc(owner: isize, msg: &TrayIpc) -> bool {
    let Ok(bytes) = serde_json::to_vec(msg) else {
        return false;
    };
    let mut cds = COPYDATASTRUCT {
        dwData: TRAY_IPC_MAGIC,
        cbData: bytes.len() as u32,
        lpData: bytes.as_ptr() as *mut _,
    };
    let mut result: usize = 0;
    let r = unsafe {
        SendMessageTimeoutW(
            owner as HWND,
            WM_COPYDATA,
            0,
            &mut cds as *mut COPYDATASTRUCT as LPARAM,
            SMTO_ABORTIFHUNG,
            1000,
            &mut result,
        )
    };
    r != 0
}

fn with_tray_mutex<T>(f: impl FnOnce() -> T) -> T {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};
    let name = wide(MUTEX_NAME);
    unsafe {
        let mutex = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if mutex.is_null() {
            return f();
        }
        let _ = WaitForSingleObject(mutex, 3000);
        let result = f();
        let _ = ReleaseMutex(mutex);
        let _ = CloseHandle(mutex);
        result
    }
}

fn ensure_tray_thread() {
    THREAD_STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("bethterm-tray".into())
            .spawn(tray_thread);
    });
}

fn tray_thread() {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    let class_name = wide(CLASS_NAME);
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(tray_wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: std::ptr::null_mut(),
    };
    unsafe {
        let _ = RegisterClassExW(&wc);
        // Patch 0146: let our windows take the foreground for popups.
        const ASFW_ANY: u32 = u32::MAX;
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let hwnd = create_tray_hwnd(instance);
        if hwnd.is_null() {
            log::error!(
                "bethterm tray: CreateWindowExW failed err={}",
                GetLastError()
            );
            return;
        }
        // Two BethTerm processes starting at once can both pass the
        // `ensure_tray_owner` check before either window exists. The
        // loser destroys its duplicate so only one icon stays next
        // to the clock.
        if let Some(other) = find_owner() {
            if other != hwnd as isize {
                DestroyWindow(hwnd);
                return;
            }
        }
        ShowWindow(hwnd, SW_HIDE);
        register_taskbar_created(hwnd);
        let _ = SetTimer(hwnd, TRAY_ICON_TIMER_ID, TRAY_ICON_WATCH_MS, None);
        {
            let mut state = tray_lock();
            state.hwnd = hwnd as isize;
            sync_icon(&mut state);
        }
        let mut msg = std::mem::zeroed::<MSG>();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// The hidden tray owner window. Factored out (patch 0145) so the
/// watchdog can destroy and recreate it when Explorer stops honouring
/// its icon.
unsafe fn create_tray_hwnd(instance: windows_sys::Win32::Foundation::HMODULE) -> HWND {
    let class_name = wide(CLASS_NAME);
    let window_title = wide(WINDOW_TITLE);
    let mut hwnd = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        class_name.as_ptr(),
        window_title.as_ptr(),
        WS_POPUP,
        0,
        0,
        1,
        1,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        instance,
        std::ptr::null(),
    );
    if hwnd.is_null() {
        hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            window_title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
    }
    hwnd
}

fn register_taskbar_created(hwnd: HWND) {
    let _ = hwnd;
    let name = wide("TaskbarCreated");
    let msg = unsafe { RegisterWindowMessageW(name.as_ptr()) };
    if msg != 0 {
        TASKBAR_CREATED_MSG.store(msg, Ordering::SeqCst);
        // Best-effort: let TaskbarCreated through UIPI when the GUI is
        // elevated and Explorer is not (or the reverse filter applies).
        allow_message_through_uipi(hwnd, msg);
    } else {
        log::warn!(
            "bethterm tray: RegisterWindowMessageW(TaskbarCreated) failed err={}",
            unsafe { GetLastError() }
        );
    }
}

fn allow_message_through_uipi(hwnd: HWND, msg: u32) {
    // ChangeWindowMessageFilterEx(hwnd, message, MSGFLT_ALLOW, null)
    type FnChange = unsafe extern "system" fn(HWND, u32, u32, *mut core::ffi::c_void) -> i32;
    const MSGFLT_ALLOW: u32 = 1;
    unsafe {
        let user32 = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(
            wide("user32.dll").as_ptr(),
        );
        if user32.is_null() {
            return;
        }
        let Some(proc) = windows_sys::Win32::System::LibraryLoader::GetProcAddress(
            user32,
            windows_sys::core::s!("ChangeWindowMessageFilterEx"),
        ) else {
            return;
        };
        let f: FnChange = std::mem::transmute(proc);
        let _ = f(hwnd, msg, MSGFLT_ALLOW, std::ptr::null_mut());
    }
}

unsafe extern "system" fn tray_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let taskbar_created = TASKBAR_CREATED_MSG.load(Ordering::Relaxed);
    if taskbar_created != 0 && msg == taskbar_created {
        force_readd_icon();
        return 0;
    }
    match msg {
        WM_TRAY => {
            let event = lparam as u32;
            if event == WM_LBUTTONUP {
                crate::host::note_life("tray icon left click");
                on_left_click(hwnd);
            } else if event == WM_RBUTTONUP {
                crate::host::note_life("tray icon right click, opening menu");
                show_menu(hwnd);
            }
            0
        }
        WM_TRAY_SYNC => {
            let mut state = tray_lock();
            sync_icon(&mut state);
            0
        }
        WM_TIMER if wparam == TRAY_ICON_TIMER_ID => {
            ensure_icon_present();
            0
        }
        WM_COPYDATA => handle_copydata(lparam),
        WM_COMMAND => {
            let cmd = wparam as usize & 0xffff;
            crate::host::note_life(&format!("tray menu click: {}", tray_command_label(cmd)));
            match cmd {
                ID_NEW_WINDOW => request_new_window(None),
                ID_SYS_PANEL => crate::syspanel::toggle_panel(),
                ID_DASHBOARD => request_dashboard(),
                ID_WEB_UI => open_web_ui(),
                ID_NATIVE_GUI => toggle_native_gui(),
                ID_MODE_CLASSIC => crate::dashboard::set_preferred_mode(
                    crate::dashboard::WindowMode::Classic,
                ),
                ID_MODE_DASHBOARD => crate::dashboard::set_preferred_mode(
                    crate::dashboard::WindowMode::Dashboard,
                ),
                ID_OPEN_ALL => restore_all(),
                ID_HIDE_ALL => hide_all_visible(),
                ID_RENDER_GPU => choose_render_mode(crate::render_mode::RenderMode::Gpu),
                ID_RENDER_CPU => choose_render_mode(crate::render_mode::RenderMode::Cpu),
                ID_GUI_RESTART => request_gui_restart(),
                ID_QUIT => request_quit(),
                ID_KILL_HOST => request_kill_host(),
                id if (ID_SHELL_BASE..ID_WINDOW_BASE).contains(&id) => {
                    request_new_window_shell(id - ID_SHELL_BASE)
                }
                id if id >= ID_WINDOW_BASE => focus_menu_window(id - ID_WINDOW_BASE),
                _ => {}
            }
            0
        }
        WM_DESTROY => {
            remove_icon(hwnd as isize);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn handle_copydata(lparam: LPARAM) -> LRESULT {
    if lparam == 0 {
        return 0;
    }
    let cds = unsafe { &*(lparam as *const COPYDATASTRUCT) };
    if cds.dwData != TRAY_IPC_MAGIC || cds.lpData.is_null() || cds.cbData == 0 {
        return 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize) };
    let Some(msg) = parse_tray_ipc(bytes) else {
        return 0;
    };
    if msg.cmd == "restore_all" {
        restore_all();
        return 1;
    }
    // Patch 0165: the shortcut was clicked while BethTerm sat in the
    // tray with no window; open one.
    if msg.cmd == "new_window" {
        if !crate::native_gui::enabled() {
            crate::host::note_life("new_window ignored: native GUI is off");
            return 1;
        }
        request_new_window(None);
        return 1;
    }
    {
        let mut state = tray_lock();
        match msg.cmd.as_str() {
            "hide" => apply_hide(&mut state, msg),
            "drop" => {
                state.hidden.retain(|w| w.hwnd != msg.hwnd as isize);
            }
            _ => {}
        }
        sync_icon(&mut state);
    }
    1
}

fn apply_hide(state: &mut TrayState, msg: TrayIpc) {
    let hwnd = msg.hwnd as isize;
    if hwnd == 0 {
        return;
    }
    state.hidden.retain(|w| w.hwnd != hwnd);
    state.hidden.push(HiddenWindow {
        hwnd,
        title: msg.title,
        was_maximized: msg.maximized,
    });
}

/// Run the GUI-registered "Novo terminal" handler. `None` is the
/// default program; `Some(args)` is a shell from the submenu.
fn request_new_window(args: Option<Vec<String>>) {
    if !crate::native_gui::enabled() {
        crate::host::note_life(
            "Novo terminal: native GUI is off; pane goes to the host, no drawing window",
        );
    }
    match NEW_WINDOW_HANDLER.get() {
        Some(handler) => {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(args))).is_err()
            {
                log::error!("bethterm tray: Novo terminal panicked");
            }
        }
        None => log::warn!("bethterm tray: Novo terminal sem handler (GUI não registrou)"),
    }
}

fn request_new_window_shell(index: usize) {
    match crate::context_menu::default_shells().get(index) {
        Some(shell) => request_new_window(Some(shell.args.clone())),
        None => request_new_window(None),
    }
}

fn request_dashboard() {
    if !crate::native_gui::enabled() {
        crate::host::note_life("Painel ignored: native GUI is off");
        return;
    }
    match DASHBOARD_HANDLER.get() {
        Some(handler) => {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler())).is_err() {
                log::error!("bethterm tray: Painel panicked");
            }
        }
        None => log::warn!("bethterm tray: Painel sem handler (GUI não registrou)"),
    }
}

/// Patch 0173: start `bethterm-web.exe` from our install folder, pointed
/// at the `bethterm.exe` next to it (it runs `bethterm cli bridge`).
fn open_web_ui() {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };
    let web = dir.join("bethterm-web.exe");
    if !web.is_file() {
        crate::host::note_life(&format!(
            "tray Beth Studio: {} not found",
            web.display()
        ));
        let text = format!(
            "Beth Studio não está instalado.

Falta o arquivo:
{}",
            web.display()
        );
        std::thread::spawn(move || unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND,
            };
            let text = wide(&text);
            let title = wide("BethTerm");
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND,
            );
        });
        return;
    }
    let mut cmd = std::process::Command::new(&web);
    let cli = dir.join("bethterm.exe");
    if cli.is_file() {
        cmd.arg("--bethterm").arg(&cli);
    }
    cmd.current_dir(&dir);
    // The GUI's own mux socket/pane must not leak into the web app: its
    // bridge would attach to this GUI (and break when it restarts).
    for var in ["WEZTERM_UNIX_SOCKET", "WEZTERM_PANE"] {
        cmd.env_remove(var);
    }
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    match cmd.spawn() {
        Ok(child) => crate::host::note_life(&format!(
            "tray Beth Studio: started bethterm-web pid {}",
            child.id()
        )),
        Err(e) => crate::host::note_life(&format!("tray Beth Studio: start failed: {e}")),
    }
}

fn on_left_click(owner: HWND) {
    // Always show the window list (patch 0125). Visible rows carry a
    // leading "*"; left-click used to auto-restore when only one window
    // was hidden and skipped the picker.
    show_menu(owner);
}

fn menu_windows_lock() -> std::sync::MutexGuard<'static, Vec<MenuWindow>> {
    MENU_WINDOWS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn collect_live_hwnds() -> Vec<isize> {
    let mut hwnds: Vec<isize> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_bethterm_hwnds),
            &mut hwnds as *mut Vec<isize> as LPARAM,
        );
    }
    hwnds.retain(|hwnd| window_is_picker_candidate(*hwnd));
    hwnds
}

fn window_is_picker_candidate(hwnd: isize) -> bool {
    if unsafe { IsWindow(hwnd as HWND) } == 0 {
        return false;
    }
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if unsafe { GetWindowRect(hwnd as HWND, &mut rc) } == 0 {
        return true;
    }
    let w = rc.right - rc.left;
    let h = rc.bottom - rc.top;
    w >= 80 && h >= 80
}

fn collect_menu_windows() -> Vec<MenuWindow> {
    let hidden = {
        let mut state = tray_lock();
        prune_dead(&mut state);
        state.hidden.clone()
    };
    let live = collect_live_hwnds();
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    // Hidden first (newest first), then every other live GUI window.
    for w in hidden.iter().rev() {
        if unsafe { IsWindow(w.hwnd as HWND) } == 0 {
            continue;
        }
        seen.insert(w.hwnd);
        out.push(MenuWindow {
            hwnd: w.hwnd,
            title: w.title.clone(),
            was_maximized: w.was_maximized,
            is_hidden: true,
        });
    }
    for hwnd in live {
        if !seen.insert(hwnd) {
            continue;
        }
        let title = os_window_title(hwnd).unwrap_or_else(|| "BethTerm".to_string());
        let was_maximized = unsafe { IsZoomed(hwnd as HWND) != 0 };
        let is_hidden = unsafe { IsWindowVisible(hwnd as HWND) == 0 };
        out.push(MenuWindow {
            hwnd,
            title,
            was_maximized,
            is_hidden,
        });
    }
    out
}

fn focus_menu_window(display_index: usize) {
    let win = {
        let windows = menu_windows_lock();
        windows.get(display_index).cloned()
    };
    let Some(win) = win else {
        return;
    };
    if win.is_hidden {
        {
            let mut state = tray_lock();
            state.hidden.retain(|w| w.hwnd != win.hwnd);
            sync_icon(&mut state);
        }
        show_hidden(&HiddenWindow {
            hwnd: win.hwnd,
            title: win.title,
            was_maximized: true,
        });
        return;
    }
    raise_window(win.hwnd);
}

fn raise_window(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{BringWindowToTop, SW_SHOWMAXIMIZED};
    if unsafe { IsWindow(hwnd as HWND) } == 0 {
        return;
    }
    unsafe {
        ShowWindow(hwnd as HWND, SW_SHOWMAXIMIZED);
        BringWindowToTop(hwnd as HWND);
        SetForegroundWindow(hwnd as HWND);
        force_full_paint(hwnd as HWND);
    }
}

fn restore_all() {
    let windows: Vec<HiddenWindow> = {
        let mut state = tray_lock();
        prune_dead(&mut state);
        state.hidden.drain(..).collect()
    };
    for win in windows.iter().rev() {
        show_hidden(win);
    }
    let mut state = tray_lock();
    sync_icon(&mut state);
}

fn show_hidden(win: &HiddenWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWMAXIMIZED;
    if unsafe { IsWindow(win.hwnd as HWND) } == 0 {
        return;
    }
    // Patch 0156: a window opened from this menu comes up maximized,
    // whether it was hidden in the tray or already on screen.
    let cmd = SW_SHOWMAXIMIZED;
    crate::window_geom::clear_keep_hidden(win.hwnd);
    unsafe {
        ShowWindow(win.hwnd as HWND, cmd);
        SetForegroundWindow(win.hwnd as HWND);
        force_full_paint(win.hwnd as HWND);
    }
}

fn force_full_paint(hwnd: HWND) {
    unsafe {
        windows_sys::Win32::Graphics::Gdi::InvalidateRect(hwnd, std::ptr::null(), 1);
    }
}

/// Patch 0147: restart only the GUI. A detached `bethterm.exe
/// gui-restart --wait-pid <us>` waits for this process to quit cleanly
/// (terminates it after 15 s), then starts a fresh bethterm-gui.exe,
/// which reattaches every terminal from the host.
fn request_gui_restart() {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let Some(dir) = dir else {
        log::error!("bethterm tray: gui-restart: cannot locate our exe dir");
        return;
    };
    let cli = ["bethterm.exe", "wezterm.exe"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file());
    let Some(cli) = cli else {
        log::error!("bethterm tray: gui-restart: bethterm.exe not found in {}", dir.display());
        return;
    };
    let pid = std::process::id().to_string();
    let mut cmd = std::process::Command::new(&cli);
    cmd.args(["gui-restart", "--wait-pid", &pid]);
    cmd.current_dir(&dir);
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    match cmd.spawn() {
        Ok(_) => {
            crate::host::note_life(&format!(
                "GUI pid {pid} requested gui-restart; host is not stopped"
            ));
            log::info!("bethterm tray: gui-restart helper spawned; quitting this GUI (pid {pid})");
            request_quit();
        }
        Err(e) => log::error!("bethterm tray: gui-restart helper failed: {e:#}"),
    }
}

fn tray_command_label(id: usize) -> String {
    match id {
        ID_NEW_WINDOW => "Novo terminal".to_string(),
        ID_SYS_PANEL => "Sistema (CPU, memória, disco)".to_string(),
        ID_WEB_UI => "Beth Studio".to_string(),
        ID_DASHBOARD => "Painel".to_string(),
        ID_MODE_CLASSIC => "Novas janelas como Abas".to_string(),
        ID_MODE_DASHBOARD => "Novas janelas como Painel".to_string(),
        ID_OPEN_ALL => "Mostrar todas".to_string(),
        ID_HIDE_ALL => "Esconder tudo".to_string(),
        ID_RENDER_GPU => "Desenho GPU".to_string(),
        ID_RENDER_CPU => "Desenho CPU".to_string(),
        ID_NATIVE_GUI => "Usar a janela nativa".to_string(),
        ID_GUI_RESTART => "Reiniciar a janela nativa".to_string(),
        ID_QUIT => "Sair da bandeja (so a bandeja e as janelas)".to_string(),
        ID_KILL_HOST => "Encerrar tudo (fecha os terminais)".to_string(),
        id if (ID_SHELL_BASE..ID_WINDOW_BASE).contains(&id) => {
            format!("novo terminal shell {}", id - ID_SHELL_BASE)
        }
        id if id >= ID_WINDOW_BASE => format!("abrir janela {}", id - ID_WINDOW_BASE),
        other => format!("comando {other}"),
    }
}

fn request_kill_host() {
    crate::host::note_life("tray: Encerrar host clicked, waiting for confirmation");
    let ok = crate::confirm::confirm_close(
        0,
        crate::confirm::ConfirmKind::Host,
        "BethTerm",
        "Isso encerra o host, todos os terminais e agentes abertos nele, e fecha as janelas.\n\
         Para só fechar as janelas e manter os terminais, use \"Fechar janelas\".",
    );
    crate::host::note_life(&format!("tray: Encerrar host confirmation={ok}"));
    if !ok {
        return;
    }
    if let Err(err) = crate::host::request_stop() {
        log::error!("bethterm-host: Encerrar host failed: {err:#}");
    }
    request_quit();
}

fn request_quit() {
    crate::host::note_life(&format!(
        "GUI pid {} is quitting its windows",
        std::process::id()
    ));
    FORCE_QUIT.store(true, Ordering::SeqCst);
    let hwnds: Vec<isize> = {
        let state = tray_lock();
        state.hidden.iter().map(|w| w.hwnd).collect()
    };
    for hwnd in &hwnds {
        mark_hwnd_force_quit(*hwnd);
    }
    restore_all();
    for hwnd in hwnds {
        unsafe {
            PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
        }
    }
}

fn focus_bethterm_gui_windows() -> bool {
    let mut hwnds: Vec<isize> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_bethterm_hwnds),
            &mut hwnds as *mut Vec<isize> as LPARAM,
        );
    }
    let mut any = false;
    for hwnd in hwnds {
        unsafe {
            if IsWindow(hwnd as HWND) == 0 {
                continue;
            }
            let cmd = if IsIconic(hwnd as HWND) != 0 {
                SW_RESTORE
            } else {
                SW_SHOW
            };
            ShowWindow(hwnd as HWND, cmd);
            SetForegroundWindow(hwnd as HWND);
            force_full_paint(hwnd as HWND);
        }
        any = true;
    }
    any
}

unsafe extern "system" fn enum_bethterm_hwnds(hwnd: HWND, lparam: LPARAM) -> i32 {
    if lparam == 0 {
        return 1;
    }
    let found = &mut *(lparam as *mut Vec<isize>);
    let mut class = [0u16; 64];
    let n = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
    if n <= 0 {
        return 1;
    }
    let class_name = String::from_utf16_lossy(&class[..n as usize]);
    if class_name != "org.wezfurlong.wezterm" {
        return 1;
    }
    if !process_is_bethterm_gui(hwnd) {
        return 1;
    }
    found.push(hwnd as isize);
    1
}

fn process_is_bethterm_gui(hwnd: HWND) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
    }
    if pid == 0 {
        return false;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let mut buf = [0u16; 260];
    let mut size = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) };
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 || size == 0 {
        return false;
    }
    let path = String::from_utf16_lossy(&buf[..size as usize]).to_ascii_lowercase();
    path.ends_with("bethterm-gui.exe")
}

fn prune_dead(state: &mut TrayState) {
    state
        .hidden
        .retain(|w| unsafe { IsWindow(w.hwnd as HWND) } != 0);
}

/// One row of the tray popup menu, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayMenuEntry {
    /// "Novo terminal" — submenu of shells (patch 0117).
    NewWindow,
    /// "Sistema" — open the CPU/RAM/disk panel in a separate window.
    SysPanel,
    /// "Painel" — left-rail list of live terminals (patch 0124).
    Dashboard,
    /// "Beth Studio" (patches 0173, 0186) — bethterm-web UI.
    WebUi,
    /// "Janela nativa" (patch 0196): submenu with everything that only
    /// concerns the native terminal windows.
    NativeMenu,
    /// Default for new windows: classic tabs or Painel.
    WindowMode,
    /// A live window (hidden or visible), by display index.
    Window(usize),
    /// "Abrir todas" — only when more than one window is hidden.
    OpenAll,
    /// "Esconder tudo" — when at least one window is on screen.
    HideAll,
    /// "Desenho" — GPU or CPU. Takes effect on the next GUI start.
    RenderMode,
    /// "Janelas de terminal nativas" (patches 0192, 0195) — terminal windows on or off.
    NativeGui,
    /// "Reiniciar janelas nativas" (patches 0147, 0195) — restart only the GUI.
    RestartGui,
    /// "Sair" — quit BethTerm.
    Quit,
    /// "Encerrar host" — stop the PTY process and then the GUI.
    KillHost,
    Separator,
}

/// Top-level rows (patch 0196): Beth Studio first, then the launcher and
/// the system panel, then everything native in one submenu, then every
/// live native window, then the two exits.
fn menu_entries(
    window_count: usize,
    _hidden_count: usize,
    host_running: bool,
) -> Vec<TrayMenuEntry> {
    let mut entries = vec![
        TrayMenuEntry::WebUi,
        TrayMenuEntry::NewWindow,
        TrayMenuEntry::SysPanel,
        TrayMenuEntry::Separator,
        TrayMenuEntry::NativeMenu,
    ];
    if window_count > 0 {
        entries.push(TrayMenuEntry::Separator);
        for i in 0..window_count {
            entries.push(TrayMenuEntry::Window(i));
        }
    }
    entries.push(TrayMenuEntry::Separator);
    entries.push(TrayMenuEntry::Quit);
    if host_running {
        entries.push(TrayMenuEntry::KillHost);
    }
    entries
}

/// Rows of the "Janela nativa" submenu: the on/off switch first, then the
/// settings of the native window, then hide/show and restart.
fn native_menu_entries(window_count: usize, hidden_count: usize) -> Vec<TrayMenuEntry> {
    let mut entries = vec![
        TrayMenuEntry::NativeGui,
        TrayMenuEntry::Separator,
        TrayMenuEntry::Dashboard,
        TrayMenuEntry::WindowMode,
        TrayMenuEntry::RenderMode,
        TrayMenuEntry::Separator,
    ];
    let visible = window_count.saturating_sub(hidden_count);
    if visible > 0 {
        entries.push(TrayMenuEntry::HideAll);
    }
    if hidden_count > 1 {
        entries.push(TrayMenuEntry::OpenAll);
    }
    entries.push(TrayMenuEntry::RestartGui);
    entries
}

fn append_new_terminal_submenu(menu: windows_sys::Win32::UI::WindowsAndMessaging::HMENU) {
    unsafe {
        let sub = CreatePopupMenu();
        if sub.is_null() {
            let text = wide("Novo terminal");
            AppendMenuW(menu, MF_STRING, ID_NEW_WINDOW, text.as_ptr());
            return;
        }
        let default_label = wide("Padrão");
        AppendMenuW(sub, MF_STRING, ID_NEW_WINDOW, default_label.as_ptr());
        AppendMenuW(sub, MF_SEPARATOR, 0, std::ptr::null());
        for (i, shell) in crate::context_menu::default_shells().iter().enumerate() {
            let text = wide(shell.label);
            AppendMenuW(sub, MF_STRING, ID_SHELL_BASE + i, text.as_ptr());
        }
        let text = wide("Novo terminal");
        AppendMenuW(menu, MF_STRING | MF_POPUP, sub as usize, text.as_ptr());
    }
}

fn append_window_mode_submenu(menu: windows_sys::Win32::UI::WindowsAndMessaging::HMENU, enabled: bool) {
    unsafe {
        let sub = CreatePopupMenu();
        if sub.is_null() {
            return;
        }
        let dash = crate::dashboard::preferred_mode() == crate::dashboard::WindowMode::Dashboard;
        let classic_flags = if dash { MF_STRING } else { MF_STRING | MF_CHECKED };
        let dash_flags = if dash { MF_STRING | MF_CHECKED } else { MF_STRING };
        let classic = wide("Abas (clássico)");
        AppendMenuW(sub, classic_flags, ID_MODE_CLASSIC, classic.as_ptr());
        let painel = wide("Painel");
        AppendMenuW(sub, dash_flags, ID_MODE_DASHBOARD, painel.as_ptr());
        let text = wide("Novas janelas como");
        let flags = if enabled { MF_STRING | MF_POPUP } else { MF_STRING | MF_POPUP | MF_GRAYED };
        AppendMenuW(menu, flags, sub as usize, text.as_ptr());
    }
}

fn append_render_mode_submenu(menu: windows_sys::Win32::UI::WindowsAndMessaging::HMENU, enabled: bool) {
    unsafe {
        let sub = CreatePopupMenu();
        if sub.is_null() {
            return;
        }
        let cpu = crate::render_mode::current() == crate::render_mode::RenderMode::Cpu;
        let gpu_flags = if cpu { MF_STRING } else { MF_STRING | MF_CHECKED };
        let cpu_flags = if cpu { MF_STRING | MF_CHECKED } else { MF_STRING };
        let gpu = wide("GPU (placa de vídeo)");
        AppendMenuW(sub, gpu_flags, ID_RENDER_GPU, gpu.as_ptr());
        let cpu_label = wide("CPU");
        AppendMenuW(sub, cpu_flags, ID_RENDER_CPU, cpu_label.as_ptr());
        let text = wide("Desenho (vale na próxima abertura)");
        let flags = if enabled { MF_STRING | MF_POPUP } else { MF_STRING | MF_POPUP | MF_GRAYED };
        AppendMenuW(menu, flags, sub as usize, text.as_ptr());
    }
}

fn choose_render_mode(mode: crate::render_mode::RenderMode) {
    if crate::render_mode::current() == mode {
        return;
    }
    if let Err(e) = crate::render_mode::select(mode) {
        log::error!("bethterm: render mode: {e:#}");
        return;
    }
    // The OpenGL context is chosen when the window is created.
    request_gui_restart();
}

/// Patch 0192: flip the saved choice and restart only the GUI.
/// The renderer starts with the first terminal window, so the new
/// process either creates that window or never does.
fn toggle_native_gui() {
    let next = !crate::native_gui::enabled();
    if let Err(e) = crate::native_gui::set_enabled(next) {
        log::error!("bethterm: native GUI: {e:#}");
        return;
    }
    crate::host::note_life(&format!(
        "native GUI turned {}; restarting the interface only",
        if next { "on" } else { "off" }
    ));
    request_gui_restart();
}

/// What `append_entry` needs besides the entry itself.
struct MenuCtx {
    native_on: bool,
    window_count: usize,
    hidden_count: usize,
}

fn append_entry(
    menu: windows_sys::Win32::UI::WindowsAndMessaging::HMENU,
    entry: TrayMenuEntry,
    labels: &[String],
    ctx: &MenuCtx,
) {
    unsafe {
        match entry {
            TrayMenuEntry::NewWindow => {
                append_new_terminal_submenu(menu);
            }
            TrayMenuEntry::SysPanel => {
                let text = wide("Sistema (CPU, memória, disco)");
                AppendMenuW(menu, MF_STRING, ID_SYS_PANEL, text.as_ptr());
            }
            TrayMenuEntry::Dashboard => {
                let text = wide("Painel");
                // Painel is drawn inside a native terminal window.
                let flags = if ctx.native_on { MF_STRING } else { MF_STRING | MF_GRAYED };
                AppendMenuW(menu, flags, ID_DASHBOARD, text.as_ptr());
            }
            TrayMenuEntry::WebUi => {
                let text = wide("Beth Studio");
                AppendMenuW(menu, MF_STRING, ID_WEB_UI, text.as_ptr());
            }
            TrayMenuEntry::NativeMenu => {
                let sub = CreatePopupMenu();
                if sub.is_null() {
                    return;
                }
                for e in native_menu_entries(ctx.window_count, ctx.hidden_count) {
                    append_entry(sub, e, labels, ctx);
                }
                let text = wide("Janela nativa");
                AppendMenuW(menu, MF_STRING | MF_POPUP, sub as usize, text.as_ptr());
            }
            TrayMenuEntry::WindowMode => {
                append_window_mode_submenu(menu, ctx.native_on);
            }
            TrayMenuEntry::RenderMode => {
                append_render_mode_submenu(menu, ctx.native_on);
            }
            TrayMenuEntry::NativeGui => {
                let flags = if ctx.native_on { MF_STRING | MF_CHECKED } else { MF_STRING };
                let text = wide("Usar a janela nativa (desmarcado: só o Beth Studio)");
                AppendMenuW(menu, flags, ID_NATIVE_GUI, text.as_ptr());
            }
            TrayMenuEntry::Window(i) => {
                if let Some(label) = labels.get(i) {
                    let text = wide(&menu_escape(label));
                    AppendMenuW(menu, MF_STRING, ID_WINDOW_BASE + i, text.as_ptr());
                }
            }
            TrayMenuEntry::OpenAll => {
                let text = wide("Mostrar todas");
                AppendMenuW(menu, MF_STRING, ID_OPEN_ALL, text.as_ptr());
            }
            TrayMenuEntry::HideAll => {
                let text = wide("Esconder tudo");
                AppendMenuW(menu, MF_STRING, ID_HIDE_ALL, text.as_ptr());
            }
            TrayMenuEntry::RestartGui => {
                let text = wide("Reiniciar a janela nativa (terminais continuam)");
                AppendMenuW(menu, MF_STRING, ID_GUI_RESTART, text.as_ptr());
            }
            TrayMenuEntry::Quit => {
                // Patch 0143: say what each exit does. Patch 0196: the tray
                // owner is the GUI process, so this leaves the tray and the
                // native windows; the host and every terminal keep running.
                let text = wide("Sair da bandeja (terminais continuam)");
                AppendMenuW(menu, MF_STRING, ID_QUIT, text.as_ptr());
            }
            TrayMenuEntry::KillHost => {
                let text = wide("Encerrar tudo (fecha os terminais)");
                AppendMenuW(menu, MF_STRING, ID_KILL_HOST, text.as_ptr());
            }
            TrayMenuEntry::Separator => {
                AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
            }
        }
    }
}

fn show_menu(owner: HWND) {
    let windows = collect_menu_windows();
    let hidden_count = windows.iter().filter(|w| w.is_hidden).count();
    let labels = menu_window_labels(
        &windows
            .iter()
            .map(|w| {
                (
                    w.title.as_str(),
                    !w.is_hidden,
                    crate::agent_wait::hwnd_is_waiting(w.hwnd),
                )
            })
            .collect::<Vec<_>>(),
    );
    let entries = menu_entries(
        windows.len(),
        hidden_count,
        crate::host::instance_running(),
    );
    *menu_windows_lock() = windows;
    unsafe {
        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }
        let ctx = MenuCtx {
            native_on: crate::native_gui::enabled(),
            window_count: entries.iter().filter(|e| matches!(e, TrayMenuEntry::Window(_))).count(),
            hidden_count,
        };
        for entry in &entries {
            append_entry(menu, *entry, &labels, &ctx);
        }
        // Beth Studio is the main interface: bold, and the double-click default.
        SetMenuDefaultItem(menu, ID_WEB_UI as u32, 0);
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        SetForegroundWindow(owner);
        // Patch 0146: logged + retried instead of failing silently.
        let _ = crate::context_menu::platform::track_popup_checked(
            menu,
            TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            owner,
        );
        PostMessageW(owner, WM_NULL, 0, 0);
        DestroyMenu(menu);
    }
}

fn sync_icon(state: &mut TrayState) {
    let tray_hwnd = state.hwnd;
    if tray_hwnd == 0 {
        return;
    }
    // Patch 0111: the icon lives as long as the process, even with
    // zero hidden windows — it is the app launcher ("Novo terminal")
    // and the restore/quit menu. Removal happens only in WM_DESTROY
    // when the process exits.
    // Patch 0126: if Explorer dropped the icon, NIM_MODIFY fails —
    // clear the flag and NIM_ADD again so tray-hidden windows stay
    // reachable.
    let tip = tray_tip(state.hidden.len());
    if state.icon_added {
        if let Err(e) = modify_icon(tray_hwnd, &tip) {
            log::warn!("bethterm tray: modify icon failed, re-adding: {e:#}");
            state.icon_added = false;
            remove_icon(tray_hwnd);
            match add_icon_quiet(tray_hwnd, &tip) {
                Ok(()) => state.icon_added = true,
                Err(e2) => log::error!("bethterm tray: re-add icon failed: {e2:#}"),
            }
        }
    } else {
        match add_icon(tray_hwnd, &tip) {
            Ok(()) => state.icon_added = true,
            Err(e) => log::error!("bethterm tray: add icon failed: {e:#}"),
        }
    }
}

/// Explorer / shell restart: always NIM_ADD again.
fn force_readd_icon() {
    let mut state = tray_lock();
    if state.hwnd == 0 {
        return;
    }
    log::info!("bethterm tray: TaskbarCreated — re-adding notification icon");
    state.icon_added = false;
    remove_icon(state.hwnd);
    let tip = tray_tip(state.hidden.len());
    match add_icon_quiet(state.hwnd, &tip) {
        Ok(()) => state.icon_added = true,
        Err(e) => log::error!("bethterm tray: TaskbarCreated re-add failed: {e:#}"),
    }
}

/// Patch 0145: what the watchdog does with the icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IconAction {
    /// Icon is there and the shell accepted the update.
    Keep,
    /// Delete + add again with a fresh id.
    ReAdd,
}

/// Pure decision: an icon the shell no longer lists, or one it refuses
/// to update, is re-added. `NIM_MODIFY` returning success is not enough
/// (Explorer kept saying "ok" for an icon it had dropped after a 1460
/// timeout).
fn next_icon_action(_exists: bool, modify_ok: bool) -> IconAction {
    // Patch 0166: NIM_MODIFY fails for an icon the shell does not have,
    // so it alone proves the icon is there. `Shell_NotifyIconGetRect`
    // also fails for an icon parked in the hidden-icons overflow on
    // Windows 10; trusting it re-added the icon every cycle and left a
    // ghost icon next to the clock each time.
    if modify_ok {
        IconAction::Keep
    } else {
        IconAction::ReAdd
    }
}

/// Does the shell still list our icon? `Shell_NotifyIconGetRect` only
/// succeeds for an icon the notification area really has.
fn icon_exists(tray_hwnd: isize) -> bool {
    use windows_sys::Win32::UI::Shell::{Shell_NotifyIconGetRect, NOTIFYICONIDENTIFIER};
    if tray_hwnd == 0 {
        return false;
    }
    let mut id: NOTIFYICONIDENTIFIER = unsafe { std::mem::zeroed() };
    id.cbSize = std::mem::size_of::<NOTIFYICONIDENTIFIER>() as u32;
    id.hWnd = tray_hwnd as HWND;
    id.uID = tray_uid();
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let hr = unsafe { Shell_NotifyIconGetRect(&id, &mut rect) };
    hr == 0
}

/// Periodic health check (patch 0145): verify the icon really exists,
/// re-add it with a new id if not, and as a last resort rebuild the
/// hidden tray window itself.
fn ensure_icon_present() {
    let mut state = tray_lock();
    if state.hwnd == 0 {
        return;
    }
    if !state.icon_added {
        sync_icon(&mut state);
        return;
    }
    let tray_hwnd = state.hwnd;
    let tip = tray_tip(state.hidden.len());
    let modify_ok = modify_icon(tray_hwnd, &tip).is_ok();
    let exists = icon_exists(tray_hwnd);
    match next_icon_action(exists, modify_ok) {
        IconAction::Keep => {}
        IconAction::ReAdd => {
            log::warn!(
                "bethterm tray: icon lost (listed={exists}, modify_ok={modify_ok}); re-adding with a new id"
            );
            remove_icon(tray_hwnd);
            let uid = bump_tray_uid();
            state.icon_added = false;
            match add_icon_quiet(tray_hwnd, &tip) {
                // Patch 0166: same proof as above; no rect in overflow.
                Ok(()) if modify_icon(tray_hwnd, &tip).is_ok() => {
                    state.icon_added = true;
                    log::info!("bethterm tray: icon recovered (uid {uid})");
                }
                res => {
                    if let Err(e) = res {
                        log::warn!("bethterm tray: re-add failed: {e:#}");
                    }
                    log::warn!("bethterm tray: escalating: rebuilding the tray window");
                    rebuild_tray_window(&mut state, &tip);
                }
            }
        }
    }
}

/// Last resort (patch 0145): destroy the hidden owner window and create
/// a new one, then add the icon to it. Runs on the tray thread (inside
/// its own WM_TIMER), which Win32 allows.
fn rebuild_tray_window(state: &mut TrayState, tip: &str) {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    let old = state.hwnd as HWND;
    // Patch 0166: remove the icon the old window holds right now. After
    // the bump below, its WM_DESTROY deletes a uid that was never added
    // and the real icon stayed as a ghost.
    remove_icon(state.hwnd);
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hwnd = unsafe { create_tray_hwnd(instance) };
    if hwnd.is_null() {
        log::error!(
            "bethterm tray: rebuild failed: CreateWindowExW err={}",
            unsafe { GetLastError() }
        );
        return;
    }
    unsafe {
        ShowWindow(hwnd, SW_HIDE);
        register_taskbar_created(hwnd);
        let _ = SetTimer(hwnd, TRAY_ICON_TIMER_ID, TRAY_ICON_WATCH_MS, None);
    }
    state.hwnd = hwnd as isize;
    state.icon_added = false;
    bump_tray_uid();
    match add_icon_quiet(state.hwnd, tip) {
        Ok(()) => {
            state.icon_added = true;
            log::info!("bethterm tray: tray window rebuilt; icon back (uid {})", tray_uid());
        }
        Err(e) => log::error!("bethterm tray: rebuilt window but add icon failed: {e:#}"),
    }
    unsafe {
        // WM_DESTROY on the old window would NIM_DELETE by hwnd/uid; the
        // icon now belongs to the new window, so the old delete is a no-op.
        DestroyWindow(old);
    }
}

fn tray_tip(count: usize) -> String {
    let base = if count <= 1 {
        "BethTerm".to_string()
    } else {
        format!("BethTerm ({count} janelas)")
    };
    if crate::agent_wait::any_waiting() {
        format!("{base} — agente esperando")
    } else {
        base
    }
}

/// Repaint the notification icon after an agent starts or stops waiting.
pub fn refresh_attention() {
    let hwnd = tray_lock().hwnd;
    if hwnd != 0 {
        unsafe {
            PostMessageW(hwnd as HWND, WM_TRAY_SYNC, 0, 0);
        }
    }
}

fn add_icon(tray_hwnd: isize, tip: &str) -> anyhow::Result<()> {
    add_icon_with_balloon(tray_hwnd, tip, true)
}

fn add_icon_quiet(tray_hwnd: isize, tip: &str) -> anyhow::Result<()> {
    add_icon_with_balloon(tray_hwnd, tip, false)
}

fn add_icon_with_balloon(tray_hwnd: isize, tip: &str, balloon: bool) -> anyhow::Result<()> {
    notify_icon(tray_hwnd, tip, true, false)?;
    if balloon {
        let _ = notify_icon(tray_hwnd, tip, false, true);
    }
    Ok(())
}

fn modify_icon(tray_hwnd: isize, tip: &str) -> anyhow::Result<()> {
    notify_icon(tray_hwnd, tip, false, false)
}

fn notify_icon(tray_hwnd: isize, tip: &str, add: bool, balloon: bool) -> anyhow::Result<()> {
    use windows_sys::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIIF_NOSOUND,
        NIM_ADD, NIM_MODIFY, NOTIFYICONDATAW,
    };

    let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = tray_hwnd as HWND;
    nid.uID = tray_uid();
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    nid.uCallbackMessage = WM_TRAY;
    nid.hIcon = crate::taskbar_icon::tray_icon();
    let tip_wide = wide(tip);
    for (i, ch) in tip_wide.iter().take(nid.szTip.len()).enumerate() {
        nid.szTip[i] = *ch;
    }
    if balloon {
        nid.uFlags |= NIF_INFO;
        nid.dwInfoFlags = NIIF_INFO | NIIF_NOSOUND;
        let info_title = wide("BethTerm");
        for (i, ch) in info_title.iter().take(nid.szInfoTitle.len()).enumerate() {
            nid.szInfoTitle[i] = *ch;
        }
        let info = wide(
            "O terminal continua rodando. Clique o icone perto do relogio (ou a seta ^) para reabrir.",
        );
        for (i, ch) in info.iter().take(nid.szInfo.len()).enumerate() {
            nid.szInfo[i] = *ch;
        }
    }
    let msg = if add { NIM_ADD } else { NIM_MODIFY };
    let ok = unsafe { Shell_NotifyIconW(msg, &mut nid) };
    if ok == 0 {
        if add {
            let retry = unsafe { Shell_NotifyIconW(NIM_MODIFY, &mut nid) };
            if retry != 0 {
                return Ok(());
            }
        }
        anyhow::bail!("Shell_NotifyIconW failed err={}", unsafe { GetLastError() });
    }
    Ok(())
}

fn remove_icon(tray_hwnd: isize) {
    use windows_sys::Win32::UI::Shell::{Shell_NotifyIconW, NIM_DELETE, NOTIFYICONDATAW};
    if tray_hwnd == 0 {
        return;
    }
    let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = tray_hwnd as HWND;
    nid.uID = tray_uid();
    unsafe {
        Shell_NotifyIconW(NIM_DELETE, &mut nid);
    }
}

fn parse_tray_ipc(bytes: &[u8]) -> Option<TrayIpc> {
    serde_json::from_slice(bytes).ok()
}

/// Labels in display order. Visible (already open) windows get a
/// leading `* ` (patch 0125). A window with an agent waiting gets a
/// leading `● ` (patch 0152). Duplicate titles get ` (2)`, ` (3)`, …
fn menu_window_labels(entries: &[(&str, bool, bool)]) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::with_capacity(entries.len());
    for &(title, is_open, waiting) in entries {
        let base = {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                "BethTerm"
            } else {
                trimmed
            }
        };
        let n = seen.entry(base.to_string()).or_insert(0);
        *n += 1;
        let mut label = if *n == 1 {
            base.to_string()
        } else {
            format!("{base} ({n})")
        };
        let mut prefix = String::new();
        if waiting {
            prefix.push_str("● ");
        }
        if is_open {
            prefix.push_str("* ");
        }
        let max = MAX_MENU_LABEL.saturating_sub(prefix.chars().count());
        label = truncate_label(&label, max);
        out.push(format!("{prefix}{label}"));
    }
    out
}

/// Newest hidden window first. Duplicate titles get ` (2)`, ` (3)`, …
/// Patch 0125 replaced its caller with the window picker; kept with its
/// unit tests for the stacked-menu fallback.
#[cfg_attr(not(test), allow(dead_code))]
fn stack_labels(titles_oldest_first: &[String]) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::with_capacity(titles_oldest_first.len());
    for title in titles_oldest_first.iter().rev() {
        let base = {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                "BethTerm"
            } else {
                trimmed
            }
        };
        let n = seen.entry(base.to_string()).or_insert(0);
        *n += 1;
        let mut label = if *n == 1 {
            base.to_string()
        } else {
            format!("{base} ({n})")
        };
        label = truncate_label(&label, MAX_MENU_LABEL);
        out.push(label);
    }
    out
}

fn truncate_label(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let keep = max.saturating_sub(1);
    let mut t: String = s.chars().take(keep).collect();
    t.push('…');
    t
}

fn menu_escape(s: &str) -> String {
    s.replace('&', "&&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn force_quit_flag_roundtrips() {
        FORCE_QUIT.store(false, Ordering::SeqCst);
        assert!(!take_force_quit());
        FORCE_QUIT.store(true, Ordering::SeqCst);
        assert!(take_force_quit());
        assert!(!take_force_quit());
    }

    #[test]
    fn should_really_quit_sees_sticky_flag() {
        FORCE_QUIT.store(true, Ordering::SeqCst);
        assert!(should_really_quit(0));
        FORCE_QUIT.store(false, Ordering::SeqCst);
        assert!(!should_really_quit(0));
    }

    #[test]
    fn stack_labels_newest_first_and_dedupes() {
        let titles = vec![
            "bash".to_string(),
            "frontend".to_string(),
            "bash".to_string(),
        ];
        assert_eq!(
            stack_labels(&titles),
            vec!["bash", "frontend", "bash (2)"]
        );
    }

    #[test]
    fn stack_labels_empty_becomes_bethterm() {
        assert_eq!(stack_labels(&["".to_string(), "  ".to_string()]), vec![
            "BethTerm",
            "BethTerm (2)"
        ]);
    }

    #[test]
    fn menu_escape_doubles_ampersand() {
        assert_eq!(menu_escape("A & B"), "A && B");
    }

    #[test]
    fn tray_ipc_roundtrips() {
        let msg = TrayIpc {
            cmd: "hide".to_string(),
            hwnd: 42,
            maximized: true,
            title: "frontend".to_string(),
        };
        match serde_json::to_vec(&msg) {
            Ok(bytes) => assert_eq!(parse_tray_ipc(&bytes), Some(msg)),
            Err(e) => panic!("json: {e}"),
        }
        assert_eq!(parse_tray_ipc(b"not-json"), None);
    }

    #[test]
    fn window_command_ids_stay_out_of_quit_range() {
        assert!(ID_WINDOW_BASE > ID_QUIT);
        assert!(ID_WINDOW_BASE > ID_NEW_WINDOW);
        assert!(ID_WINDOW_BASE > ID_SYS_PANEL);
        assert!(ID_WINDOW_BASE > ID_KILL_HOST);
        assert!(ID_WINDOW_BASE > ID_DASHBOARD);
        assert!(ID_WINDOW_BASE > ID_MODE_CLASSIC);
        assert!(ID_WINDOW_BASE > ID_MODE_DASHBOARD);
        assert!(ID_SHELL_BASE > ID_SYS_PANEL);
        assert!(ID_SHELL_BASE > ID_MODE_DASHBOARD);
        assert!(ID_SHELL_BASE > ID_KILL_HOST);
        assert!(ID_SHELL_BASE > ID_DASHBOARD);
        assert!(ID_KILL_HOST != ID_QUIT);
        assert!(ID_GUI_RESTART != ID_QUIT);
        assert!(ID_GUI_RESTART != ID_KILL_HOST);
        assert!(ID_SHELL_BASE > ID_GUI_RESTART);
        assert!(ID_HIDE_ALL > ID_SHELL_BASE + 40);
        assert!(ID_NATIVE_GUI > ID_WEB_UI);
        assert!(ID_NATIVE_GUI < ID_WINDOW_BASE);
        assert!(ID_NATIVE_GUI != ID_RENDER_GPU);
        assert!(ID_NATIVE_GUI != ID_RENDER_CPU);
        assert!(ID_HIDE_ALL < ID_WINDOW_BASE);
        assert!(ID_HIDE_ALL != ID_OPEN_ALL);
        assert!(ID_DASHBOARD != ID_SYS_PANEL);
        assert!(ID_DASHBOARD != ID_QUIT);
        assert!(ID_SHELL_BASE < ID_WINDOW_BASE);
        assert!(ID_NEW_WINDOW != ID_OPEN_ALL);
        assert!(ID_NEW_WINDOW != ID_QUIT);
        assert!(ID_SYS_PANEL != ID_OPEN_ALL);
        assert!(ID_SYS_PANEL != ID_QUIT);
        assert!(ID_SYS_PANEL != ID_NEW_WINDOW);
        assert_eq!(ID_WINDOW_BASE + 0, 100);
        assert!(ID_SHELL_BASE + 20 < ID_WINDOW_BASE);
    }

    #[test]
    fn menu_entries_host_running_adds_kill_host() {
        use TrayMenuEntry::*;
        assert_eq!(
            menu_entries(0, 0, true),
            vec![WebUi, NewWindow, SysPanel, Separator, NativeMenu, Separator, Quit, KillHost]
        );
    }

    #[test]
    fn menu_entries_empty_still_offers_studio_new_window_and_quit() {
        use TrayMenuEntry::*;
        assert_eq!(
            menu_entries(0, 0, false),
            vec![WebUi, NewWindow, SysPanel, Separator, NativeMenu, Separator, Quit]
        );
    }

    #[test]
    fn menu_entries_lists_native_windows_between_submenu_and_exits() {
        use TrayMenuEntry::*;
        assert_eq!(
            menu_entries(3, 2, false),
            vec![
                WebUi,
                NewWindow,
                SysPanel,
                Separator,
                NativeMenu,
                Separator,
                Window(0),
                Window(1),
                Window(2),
                Separator,
                Quit
            ]
        );
    }

    #[test]
    fn menu_entries_studio_is_first_and_native_items_are_not_top_level() {
        let entries = menu_entries(2, 0, true);
        assert_eq!(entries[0], TrayMenuEntry::WebUi);
        for native in [
            TrayMenuEntry::Dashboard,
            TrayMenuEntry::WindowMode,
            TrayMenuEntry::RenderMode,
            TrayMenuEntry::NativeGui,
            TrayMenuEntry::RestartGui,
            TrayMenuEntry::HideAll,
            TrayMenuEntry::OpenAll,
        ] {
            assert!(!entries.contains(&native), "{native:?} belongs in the submenu");
        }
    }

    #[test]
    fn native_menu_without_windows_has_switch_settings_and_restart_only() {
        use TrayMenuEntry::*;
        assert_eq!(
            native_menu_entries(0, 0),
            vec![NativeGui, Separator, Dashboard, WindowMode, RenderMode, Separator, RestartGui]
        );
    }

    #[test]
    fn native_menu_offers_hide_when_a_window_is_visible() {
        use TrayMenuEntry::*;
        assert_eq!(
            native_menu_entries(1, 0),
            vec![NativeGui, Separator, Dashboard, WindowMode, RenderMode, Separator, HideAll, RestartGui]
        );
    }

    #[test]
    fn native_menu_offers_show_all_only_when_several_are_hidden() {
        use TrayMenuEntry::*;
        assert_eq!(
            native_menu_entries(3, 2),
            vec![
                NativeGui, Separator, Dashboard, WindowMode, RenderMode, Separator, HideAll,
                OpenAll, RestartGui
            ]
        );
        assert!(!native_menu_entries(2, 1).contains(&OpenAll));
        assert!(!native_menu_entries(2, 2).contains(&HideAll));
    }

    #[test]
    fn icon_watchdog_readds_unless_listed_and_modifiable() {
        assert_eq!(next_icon_action(true, true), IconAction::Keep);
        // Patch 0166: an icon in the overflow area has no rect.
        assert_eq!(next_icon_action(false, true), IconAction::Keep);
        assert_eq!(next_icon_action(true, false), IconAction::ReAdd);
        assert_eq!(next_icon_action(false, false), IconAction::ReAdd);
    }

    #[test]
    fn tray_uid_bumps_monotonically() {
        let a = tray_uid();
        let b = bump_tray_uid();
        assert!(b > a);
        assert_eq!(tray_uid(), b);
    }

    #[test]
    fn menu_window_labels_keep_display_order() {
        assert_eq!(
            menu_window_labels(&[
                ("hidden", false, false),
                ("visible", true, false),
                ("hidden", false, false),
            ]),
            vec!["hidden", "* visible", "hidden (2)"]
        );
    }

    #[test]
    fn menu_window_labels_star_open_windows() {
        assert_eq!(
            menu_window_labels(&[
                ("MOBICHAT", true, false),
                ("devices", false, false),
                ("VIDEO", true, false),
            ]),
            vec!["* MOBICHAT", "devices", "* VIDEO"]
        );
    }

    #[test]
    fn menu_window_labels_mark_a_waiting_agent() {
        assert_eq!(
            menu_window_labels(&[("CLIENTES", true, true), ("4297", false, true)]),
            vec!["● * CLIENTES", "● 4297"]
        );
    }
}
