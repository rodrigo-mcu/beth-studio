// wtinator-config::ipc_client — named-pipe CLIENT (patch 0036).
//
// The companion app is the *client* side of the JSON-over-named-pipe
// contract defined in `wtinator::notify_ipc`. The *server* side runs
// inside wezterm-gui (see
// `wezterm-gui/src/termwindow/notify_pipe.rs`).
//
// Windows named pipes are openable as files: we `CreateFileW` the
// pipe path (`\\.\pipe\wtinator-config-<pid>`), wrap the resulting
// HANDLE as a `std::fs::File`, write one line of JSON, and read one
// line of JSON back. Each call is a fresh connect/request/read/drop
// cycle — the server loops over `ConnectNamedPipe` so it re-arms for
// the next request.
//
// Robustness: if the pipe does not exist (wezterm-gui not running,
// wrong pid, server thread not started), `connect` returns an error
// that the caller turns into a "not connected to a terminal" notice
// rather than crashing the UI.

use anyhow::{anyhow, Context, Result};
use std::io::{BufRead, BufReader, Write};

#[cfg(windows)]
use std::os::windows::io::FromRawHandle;

/// Open the named pipe for the given pid, send one request line, and
/// read one response line back. Returns the raw JSON response string.
///
/// `request_json` must be a single JSON object with no trailing
/// newline (we add the `\n` terminator ourselves to match the
/// line-oriented server).
#[cfg(windows)]
pub fn round_trip(pid: u32, request_json: &str) -> Result<String> {
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

    let pipe_name = wtinator::notify_ipc::pipe_name_for_pid(pid);
    let wide: Vec<u16> = pipe_name.encode_utf16().chain(std::iter::once(0)).collect();

    // Try a few times if the pipe is momentarily busy (the server is
    // mid-handshake with a previous client).
    let mut attempts = 0;
    let handle = loop {
        attempts += 1;
        // SAFETY: standard CreateFileW call against a known-shape
        // wide string; we check the returned handle below.
        let h = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if h != INVALID_HANDLE_VALUE {
            break h;
        }
        // SAFETY: GetLastError has no preconditions.
        let err = unsafe { GetLastError() };
        if err == ERROR_PIPE_BUSY && attempts < 5 {
            // Wait up to 1s for the server to free an instance.
            // SAFETY: WaitNamedPipeW with a valid wide name.
            unsafe {
                WaitNamedPipeW(wide.as_ptr(), 1000);
            }
            continue;
        }
        return Err(anyhow!(
            "could not connect to wezterm-gui pipe {} (win32 error {})",
            pipe_name,
            err
        ));
    };

    // Wrap the HANDLE as a File for the write side, and clone it for
    // the buffered read side.
    // SAFETY: `handle` is a valid pipe HANDLE we just opened and own.
    let mut write_file = unsafe { std::fs::File::from_raw_handle(handle as _) };
    let read_file = write_file
        .try_clone()
        .context("failed to clone pipe handle for reading")?;

    write_file
        .write_all(request_json.as_bytes())
        .context("failed to write request to pipe")?;
    write_file
        .write_all(b"\n")
        .context("failed to write request terminator")?;
    write_file.flush().context("failed to flush request")?;

    let mut reader = BufReader::new(read_file);
    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .context("failed to read response from pipe")?;
    if n == 0 {
        return Err(anyhow!("pipe closed before a response was received"));
    }
    Ok(line.trim().to_string())
}

#[cfg(not(windows))]
pub fn round_trip(_pid: u32, _request_json: &str) -> Result<String> {
    Err(anyhow!("named-pipe IPC is only supported on Windows"))
}
