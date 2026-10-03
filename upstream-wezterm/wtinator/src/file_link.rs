use std::path::Path;

enum EditorKind {
    VsCode,
    Unknown,
}

fn detect_editor() -> EditorKind {
    if which_code() {
        EditorKind::VsCode
    } else {
        EditorKind::Unknown
    }
}

#[cfg(windows)]
fn which_code() -> bool {
    std::process::Command::new("where")
        .arg("code")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn which_code() -> bool {
    std::process::Command::new("which")
        .arg("code")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Open a file link in the best available editor.
/// On Windows, the URI format is `file:///C:/Users/foo/bar.rs:42:10`.
/// This function extracts the file path and line/column numbers,
/// then opens with `code --goto` if VS Code is available,
/// falling back to the OS default handler.
pub fn open_file_link(uri: &str, pane_id: usize) -> bool {
    let (raw, line, col) = parse_file_uri(uri);
    let raw = match raw {
        Some(p) => p,
        None => return false,
    };
    let path = to_native_path(&raw, pane_id);
    if Path::new(&path).exists() {
        return open_with_code(&path, line, col);
    }
    log::warn!(
        "wezterminator: file_link path does not exist: {} (from {})",
        path,
        raw
    );
    false
}

/// Turn the raw URI path into a native Windows path. A Unix path clicked in a
/// WSL2 pane is converted via `wtinator::wsl` (`/mnt/c/..` -> `C:\..`,
/// `/home/..` -> `\\wsl.localhost\<distro>\..`); otherwise slashes are
/// normalised. `pane_id` is the pane the link was clicked in.
#[cfg(windows)]
fn to_native_path(raw: &str, pane_id: usize) -> String {
    if raw.starts_with('/') {
        if let Some(pane) = mux::Mux::try_get().and_then(|m| m.get_pane(pane_id)) {
            if crate::wsl::pane_is_wsl(&pane) {
                return crate::wsl::unix_path_to_windows(raw, &pane);
            }
        }
    }
    raw.replace('/', "\\")
}

#[cfg(not(windows))]
fn to_native_path(raw: &str, _pane_id: usize) -> String {
    raw.to_string()
}

fn open_with_code(path: &str, line: Option<u32>, col: Option<u32>) -> bool {
    match detect_editor() {
        EditorKind::VsCode => {
            let goto = format_file_goto(path, line, col);
            match std::process::Command::new("code")
                .args(&["--goto", &goto])
                .spawn()
            {
                Ok(_) => true,
                Err(e) => {
                    log::warn!("wezterminator: failed to open VS Code: {:#}", e);
                    open_with_os(path)
                }
            }
        }
        EditorKind::Unknown => open_with_os(path),
    }
}

fn format_file_goto(path: &str, line: Option<u32>, col: Option<u32>) -> String {
    match (line, col) {
        (Some(l), Some(c)) => format!("{}:{}:{}", path, l, c),
        (Some(l), None) => format!("{}:{}", path, l),
        _ => path.to_string(),
    }
}

#[cfg(windows)]
fn open_with_os(path: &str) -> bool {
    std::process::Command::new("cmd")
        .args(&["/c", "start", "", path])
        .spawn()
        .is_ok()
}

#[cfg(not(windows))]
fn open_with_os(path: &str) -> bool {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .is_ok()
}

/// Parse a `file://` URI, returning the RAW path (un-mangled; a Unix path keeps
/// its leading `/`, a Windows drive path drops the URI's leading `/`) plus an
/// optional `:LINE[:COL]` suffix. The Unix->Windows / slash conversion happens
/// later in `to_native_path` (which knows whether the pane is WSL).
fn parse_file_uri(uri: &str) -> (Option<String>, Option<u32>, Option<u32>) {
    let after = match uri.strip_prefix("file://") {
        Some(rest) => rest,
        None => return (None, None, None),
    };
    // `file:///home/x` -> "/home/x" (Unix absolute, keep the slash).
    // `file:///C:/x`   -> "/C:/x" -> strip the drive's leading slash -> "C:/x".
    let path_part = strip_drive_leading_slash(after);
    let (path_str, line, col) = parse_path_with_linenr(path_part);
    (Some(path_str), line, col)
}

/// `/C:/Users/..` -> `C:/Users/..` (a Windows drive letter); else unchanged.
fn strip_drive_leading_slash(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        &s[1..]
    } else {
        s
    }
}

/// Parse a path string that may end with `:LINE` or `:LINE:COL`.
fn parse_path_with_linenr(s: &str) -> (String, Option<u32>, Option<u32>) {
    let bytes = s.as_bytes();
    let len = bytes.len();
    let mut last_colon: Option<usize> = None;
    let mut prev_colon: Option<usize> = None;

    for i in (0..len).rev() {
        if bytes[i] == b':' {
            if last_colon.is_none() {
                last_colon = Some(i);
            } else if prev_colon.is_none() {
                prev_colon = Some(i);
                break;
            }
        }
    }

    if let (Some(pc), Some(lc)) = (prev_colon, last_colon) {
        if let (Some(path), Some(line_str), Some(col_str)) =
            (s.get(..pc), s.get(pc + 1..lc), s.get(lc + 1..))
        {
            if let (Ok(line), Ok(col)) = (line_str.parse::<u32>(), col_str.parse::<u32>()) {
                return (path.to_string(), Some(line), Some(col));
            }
        }
    }

    if let Some(lc) = last_colon {
        if let (Some(path), Some(line_str)) = (s.get(..lc), s.get(lc + 1..)) {
            if let Ok(line) = line_str.parse::<u32>() {
                return (path.to_string(), Some(line), None);
            }
        }
    }

    (s.to_string(), None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_windows_path_with_linecol() {
        // parse_file_uri now returns the RAW path (un-mangled); the slash ->
        // backslash conversion happens later in to_native_path.
        let (path, line, col) = parse_file_uri("file:///C:/Users/foo/bar.rs:42:10");
        assert_eq!(path, Some("C:/Users/foo/bar.rs".to_string()));
        assert_eq!(line, Some(42));
        assert_eq!(col, Some(10));
    }

    #[test]
    fn parse_unix_path_keeps_leading_slash() {
        let (path, line, col) = parse_file_uri("file:///home/user/main.rs:15");
        assert_eq!(path, Some("/home/user/main.rs".to_string()));
        assert_eq!(line, Some(15));
        assert!(col.is_none());
    }

    #[test]
    fn format_goto_with_line_col() {
        assert_eq!(format_file_goto("foo.rs", Some(10), Some(5)), "foo.rs:10:5");
        assert_eq!(format_file_goto("foo.rs", Some(10), None), "foo.rs:10");
        assert_eq!(format_file_goto("foo.rs", None, None), "foo.rs");
    }

    #[test]
    fn parse_path_with_linenr_linecol() {
        let (p, l, c) = parse_path_with_linenr("src/main.rs:42:10");
        assert_eq!(p, "src/main.rs");
        assert_eq!(l, Some(42));
        assert_eq!(c, Some(10));
    }

    #[test]
    fn parse_path_with_linenr_line_only() {
        let (p, l, c) = parse_path_with_linenr("src/main.rs:42");
        assert_eq!(p, "src/main.rs");
        assert_eq!(l, Some(42));
        assert!(c.is_none());
    }

    #[test]
    fn parse_path_with_linenr_no_line() {
        let (p, l, c) = parse_path_with_linenr("src/main.rs");
        assert_eq!(p, "src/main.rs");
        assert!(l.is_none());
        assert!(c.is_none());
    }

    #[test]
    fn parse_not_a_file_uri() {
        let (p, l, c) = parse_file_uri("https://example.com");
        assert!(p.is_none());
        assert!(l.is_none());
        assert!(c.is_none());
    }

    #[test]
    fn parse_windows_drive_letter_not_confused() {
        let (p, l, c) = parse_path_with_linenr("C:/Users/foo/bar.rs:15");
        assert_eq!(p, "C:/Users/foo/bar.rs");
        assert_eq!(l, Some(15));
        assert!(c.is_none());
    }
}