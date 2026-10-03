// wtinator::confirm — Phase 1.F (patch 0032).
//
// A Win32-native "are you sure?" confirmation backed by
// the modern Windows Task Dialog. Used by the per-tab close X button in
// `wezterm-gui` (so a frozen terminal UI thread does not
// block the prompt — the messagebox runs its own modal
// message loop on a dedicated `std::thread`).
//
// The existing upstream `wezterm-gui/src/overlay/confirm.rs`
// (a Skia-based overlay) is still used by:
//   - `confirm_close_pane`  (per-pane close —
//     `Close pane` right-click entry, patch 0009)
//   - `confirm_close_window` (per-window close — patch 0020)
//   - `confirm_close_tab`    (per-tab close — Skia path,
//     replaced by this module for the X-click path in
//     patch 0032)
//   - `confirm_quit_program` (Quit WezTerm)
//
// Those are follow-up candidates for this same Win32
// backend; the dispatcher in `wezterm-gui` will gain a
// `ConfirmKind::Window` / `ConfirmKind::Pane` switch in
// future patches.

/// Identifies which kind of close we are confirming.
///
/// The kind is currently used only as a debugging aid
/// (logged alongside the dialog result). Future patches
/// may branch on it to pick per-kind wording or icons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConfirmKind {
    /// Per-tab close (X button on a tab in the
    /// title/tab strip).
    Tab,
    /// Per-pane close (right-click "Close pane" entry).
    Pane,
    /// Per-window close (X button on the title bar,
    /// `Alt+F4`, system close).
    Window,
    /// Stop `bethterm-host.exe` and every PTY it owns (patch 0122).
    Host,
}

/// Show a modern Win32 native "are you sure?" confirmation.
///
/// Spawns a dedicated `std::thread` (so a frozen
/// terminal UI thread does not block the prompt) and
/// blocks the calling thread until the user dismisses
/// the messagebox. Returns `true` if the user clicked
/// the **Yes** button; `false` if the user clicked
/// **No**, pressed **Esc**, or closed the window.
///
/// `hwnd` is the parent window HWND (the terminal
/// window). Pass `0` if no parent is available; the
/// messagebox will be unowned and float on the
/// taskbar. On non-Windows, this function returns
/// `false` unconditionally — the caller should not
/// close anything if the user could not confirm.
///
/// # Threading model
///
/// The function blocks the calling thread on a
/// `mpsc::channel::recv()` until the worker thread
/// posts the result. The worker thread is the one
/// that calls `MessageBoxW`, so the Win32 modal
/// message loop runs off the calling (UI) thread.
/// This is the central property the user requested:
/// a frozen terminal UI thread cannot block the
/// confirmation prompt.
#[cfg(windows)]
pub fn confirm_close(
    hwnd: isize,
    kind: ConfirmKind,
    title: &str,
    text: &str,
) -> bool {
    match kind {
        ConfirmKind::Window => {
            // Two independent Yeses still guard an accidental X / Alt+F4.
            // Patch 0080 slept three seconds *before* the first dialog; that
            // made the close button look hung. Show the Task Dialog at once
            // (patch 0103).
            confirm_once(hwnd, kind, title, text)
                && confirm_once(
                    hwnd,
                    kind,
                    "Confirmar: fechar só a janela?",
                    "O host e os terminais continuam. O Beth Studio segue podendo abri-los.\n\n\
                     Esta é a confirmação final. Quer fechar só esta janela?",
                )
        }
        ConfirmKind::Tab => {
            // A tab can contain several live panes, so use the same two-step
            // protection while keeping the whole-window flow at two prompts.
            confirm_once(hwnd, kind, title, text)
                && confirm_once(
                    hwnd,
                    kind,
                    "Final confirmation: close tab?",
                    "All panes and programs in this tab will be killed.\n\n\
                     This is the final confirmation. Do you really want to close this tab?",
                )
        }
        ConfirmKind::Pane => confirm_once(hwnd, kind, title, text),
        ConfirmKind::Host => confirm_once(hwnd, kind, title, text),
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn confirm_once(
    hwnd: isize,
    kind: ConfirmKind,
    title: &str,
    text: &str,
) -> bool {
    use std::sync::mpsc;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Controls::{
        TaskDialog, TDCBF_NO_BUTTON, TDCBF_YES_BUTTON, TD_WARNING_ICON,
    };

    // Standard Win32 dialog-result identifier for Yes.
    const IDYES: i32 = 6;

    let title_w: Vec<u16> = std::ffi::OsStr::new(title)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let text_w: Vec<u16> = std::ffi::OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let instruction = match kind {
        ConfirmKind::Tab => "Close this tab?",
        ConfirmKind::Pane => "Close this pane?",
        ConfirmKind::Window => "Fechar esta janela?",
        ConfirmKind::Host => "Encerrar o BethTerm?",
    };
    let instruction_w: Vec<u16> = std::ffi::OsStr::new(instruction)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let (tx, rx) = mpsc::channel::<i32>();

    // The worker thread is what calls TaskDialog
    // (so the Win32 modal message loop runs there,
    // not on the caller's UI thread).
    let hwnd_for_thread = hwnd;
    let kind_for_log = kind;
    let worker = std::thread::Builder::new()
        .name("wtinator::confirm::messagebox".to_string())
        .spawn(move || {
            log::info!(
                "wtinator::confirm: spawning TaskDialog (kind={:?}, hwnd={:#x})",
                kind_for_log,
                hwnd_for_thread
            );
            // TaskDialog follows the current Windows visual style while
            // retaining the independent native modal loop we need here.
            let mut result = 0;
            let hr = unsafe {
                TaskDialog(
                    hwnd_for_thread as HWND,
                    std::ptr::null_mut(),
                    title_w.as_ptr(),
                    instruction_w.as_ptr(),
                    text_w.as_ptr(),
                    TDCBF_YES_BUTTON | TDCBF_NO_BUTTON,
                    TD_WARNING_ICON,
                    &mut result,
                )
            };
            if hr < 0 {
                log::warn!("wtinator::confirm: TaskDialog failed with HRESULT {:#x}", hr);
                result = 0;
            }
            log::info!(
                "wtinator::confirm: TaskDialog returned {} (kind={:?})",
                result,
                kind_for_log
            );
            // Best-effort send; the receiver may have
            // been dropped if the calling thread was
            // itself cancelled, in which case we
            // silently drop the result.
            let _ = tx.send(result);
        })
        .expect("failed to spawn confirm worker thread");

    // Wait for the user to dismiss the messagebox.
    // `recv()` blocks the calling thread — this is
    // intentional: the caller (a UI event handler)
    // is already running in a context that is OK
    // with blocking briefly, and `gui_window.notify`
    // cannot be called from a worker thread without
    // additional plumbing.
    let result = match rx.recv() {
        Ok(r) => r,
        Err(_) => {
            // Sender was dropped without sending;
            // treat as a "no" so the caller does not
            // close anything.
            log::warn!(
                "wtinator::confirm: worker thread dropped without sending a result"
            );
            let _ = worker.join();
            return false;
        }
    };
    // Join the worker so the thread is reaped.
    let _ = worker.join();

    result == IDYES
}

/// Stub for non-Windows platforms. Always returns
/// `false` so callers do not close anything on
/// non-Windows builds (the user cannot confirm
/// anything we could show them).
#[cfg(not(windows))]
pub fn confirm_close(
    _hwnd: isize,
    _kind: ConfirmKind,
    _title: &str,
    _text: &str,
) -> bool {
    false
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// `ConfirmKind` is a plain enum; the equality
    /// and copy semantics are what the dispatcher
    /// relies on. If a variant is added, this test
    /// is updated.
    #[test]
    fn confirm_kind_equality() {
        assert_eq!(ConfirmKind::Tab, ConfirmKind::Tab);
        assert_ne!(ConfirmKind::Tab, ConfirmKind::Pane);
        assert_ne!(ConfirmKind::Pane, ConfirmKind::Window);
        let k = ConfirmKind::Tab;
        let k2 = k; // Copy
        assert_eq!(k, k2);
    }

    /// The non-Windows stub must return `false`
    /// unconditionally so callers do not close
    /// anything on platforms that cannot show the
    /// dialog.
    #[cfg(not(windows))]
    #[test]
    fn confirm_close_returns_false_on_non_windows() {
        assert!(!confirm_close(0, ConfirmKind::Tab, "T", "body"));
        assert!(!confirm_close(0, ConfirmKind::Pane, "T", "body"));
        assert!(!confirm_close(0, ConfirmKind::Window, "T", "body"));
    }

    /// Smoke test for the `Debug` impl on
    /// `ConfirmKind`. The dispatcher logs the kind
    /// for debugging, so `Debug` must produce
    /// something readable.
    #[test]
    fn confirm_kind_debug_is_readable() {
        let s = format!("{:?}", ConfirmKind::Tab);
        assert_eq!(s, "Tab");
        let s = format!("{:?}", ConfirmKind::Pane);
        assert_eq!(s, "Pane");
        let s = format!("{:?}", ConfirmKind::Window);
        assert_eq!(s, "Window");
    }
}
