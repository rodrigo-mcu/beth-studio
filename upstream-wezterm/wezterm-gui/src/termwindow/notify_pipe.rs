// notify_pipe — the named-pipe SERVER runtime (patch 0036).
//
// This is the write side of the JSON-over-named-pipe contract
// defined in `wtinator::notify_ipc`. The companion app
// (`wtinator-config.exe`) is the client; it opens
// `\\.\pipe\wtinator-config-<pid>` and sends `list_tabs` /
// `set_theme` / `ping` requests.
//
// Threading model (mirrors patches 0029 / 0030 / 0031 / 0032):
//   - A dedicated `std::thread` owns the pipe. It creates one pipe
//     instance, blocks in `ConnectNamedPipe` until a client opens
//     the pipe, wraps the HANDLE as a `std::fs::File`, and hands the
//     reader/writer to `wtinator::notify_ipc::handle_client`.
//   - The `notify_apply` callback passed to `handle_client` does NOT
//     touch the mux directly. It posts a `TermWindowNotif::Apply`
//     closure to the GUI main thread via `Window::notify`. The
//     closure runs on the main thread where `mux::Mux::get()` and
//     `pane.set_palette()` are safe. This is exactly the
//     `gui_window.notify(TermWindowNotif::Apply(...))` pattern used
//     by the right-click "Rename tab" dispatch (mouseevent.rs).
//   - After applying the palette we post a `WindowInvalidated`
//     notification so the terminal repaints with the new colors.
//   - The accept loop re-arms after each client disconnects, so the
//     config app can be opened/closed/re-opened repeatedly.
//
// Read-side requests (`list_tabs`, `ping`) are handled inside
// `handle_request` on the pipe thread; `snapshot_for_config` takes
// the mux lock, which is safe from any thread.

#![cfg(windows)]

use crate::termwindow::TermWindowNotif;
use std::io::BufReader;
use std::os::windows::io::FromRawHandle;
use window::{Window, WindowOps};

/// Spawn the named-pipe server thread. Call once per window from
/// `TermWindow::new_window` (near the patch 0029 auto-save timer).
///
/// `gui_window` is a clone of the `window::Window` handle; the
/// server thread keeps it to post `TermWindowNotif::Apply` closures
/// to the GUI main thread for `set_theme` requests.
pub fn start(gui_window: Window) {
    let pid = std::process::id();
    let pipe_name = wtinator::notify_ipc::pipe_name_for_pid(pid);
    log::info!(
        "wezterminator patch 0036: starting config pipe server on {}",
        pipe_name
    );

    std::thread::Builder::new()
        .name("wtinator-config-pipe".to_string())
        .spawn(move || {
            serve_loop(&pipe_name, gui_window);
        })
        .map(|_| ())
        .unwrap_or_else(|e| {
            log::warn!(
                "wezterminator patch 0036: failed to spawn pipe server thread: {}",
                e
            );
        });
}

/// Accept clients forever, one at a time. Each iteration creates a
/// fresh pipe instance (the simplest correct model — a client
/// connects, does its request/response exchange, and disconnects;
/// then we re-arm for the next client).
fn serve_loop(pipe_name: &str, gui_window: Window) {
    loop {
        match accept_one(pipe_name, &gui_window) {
            Ok(()) => {}
            Err(e) => {
                log::warn!(
                    "wezterminator patch 0036: pipe accept failed: {} — \
                     retrying in 500ms",
                    e
                );
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
    }
}

/// Create one pipe instance, wait for a client, and service it.
fn accept_one(pipe_name: &str, gui_window: &Window) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, ERROR_PIPE_CONNECTED};
    use windows_sys::Win32::Storage::FileSystem::{
        PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
        PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT, PIPE_UNLIMITED_INSTANCES,
    };

    let wide: Vec<u16> = pipe_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: standard CreateNamedPipeW call with a valid wide name
    // and sane buffer sizes. We validate the returned handle.
    let handle = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            std::ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }

    // Block until a client connects. `ConnectNamedPipe` returning 0
    // with `ERROR_PIPE_CONNECTED` means the client connected between
    // CreateNamedPipeW and ConnectNamedPipe — that is success.
    // SAFETY: `handle` is a valid pipe instance we just created.
    let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
    if connected == 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
            // SAFETY: closing the handle we own on error.
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Err(err);
        }
    }

    // Wrap the HANDLE as a File for I/O. We clone it so we have one
    // for the buffered reader and one for the writer. `File` owns the
    // handle and closes it on drop; the clone duplicates the handle.
    // SAFETY: `handle` is a valid, connected pipe instance we own.
    let file = unsafe { std::fs::File::from_raw_handle(handle as _) };
    let read_file = file.try_clone()?;
    let reader = BufReader::new(read_file);
    let writer = file;

    // The apply callback posts the closure to the GUI main thread.
    let gui_for_cb = gui_window.clone();
    let notify_apply: wtinator::notify_ipc::ApplyCallback =
        Box::new(move |inner: Box<dyn FnOnce() + Send>| {
            // `TermWindowNotif::Apply` requires a `Send + Sync`
            // closure, but `inner` is only `Send` (a boxed FnOnce).
            // Wrap it in a `Mutex<Option<..>>` so the outer closure
            // is `Sync`; the closure takes it out and calls it once
            // on the main thread.
            let cell = std::sync::Mutex::new(Some(inner));
            gui_for_cb.notify(TermWindowNotif::Apply(Box::new(move |_tw| {
                // Run the mux-side apply work (set_theme / set_pane_theme
                // / set_pane_font_size / set_pane_font_family) on the
                // main thread first.
                if let Ok(mut guard) = cell.lock() {
                    if let Some(f) = guard.take() {
                        f();
                    }
                }
                // WezTerminator (patch 0043): finish the apply through the
                // TermWindow. For a per-pane FONT change this is mandatory
                // — only the GUI (`_tw`) can (a) recompute the override's
                // per-axis cell scale from `wezterm-font` metrics and
                // push it to the pane before reflow, and (b) clear the
                // line/shape caches (a same-size family change does not
                // move the geometry-derived cache keys). For a theme
                // change it is a harmless extra invalidation. The mux-side
                // `f()` above only recorded intent (e.g. the family
                // string); this turns it into geometry + a repaint.
                _tw.apply_pane_font_scale_change();
                // Repaint every window so the change shows up immediately
                // (e.g. a palette change on a non-active tab still needs a
                // paint; `apply_pane_font_scale_change` only invalidates
                // this window).
                if let Some(mux) = mux::Mux::try_get() {
                    for window_id in mux.iter_windows() {
                        mux.notify(mux::MuxNotification::WindowInvalidated(window_id));
                    }
                }
            })));
        });

    let result = wtinator::notify_ipc::handle_client(reader, writer, notify_apply);

    // Disconnect so the next CreateNamedPipeW/ConnectNamedPipe cycle
    // starts clean. The File (writer) drop closes the original
    // handle; DisconnectNamedPipe on an already-closed handle is a
    // no-op error we ignore.
    // SAFETY: best-effort disconnect; handle may already be closed.
    unsafe {
        let _ = DisconnectNamedPipe(handle);
    }

    result
}
