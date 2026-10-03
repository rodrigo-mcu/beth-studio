//! Which windows have an agent waiting for the user (patch 0152).
//!
//! The tab bar already shows this (bell, OSC 9, or `claude_status=waiting`).
//! The taskbar icon, the notification-area icon and the tray menu read
//! the same set.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn waiting() -> std::sync::MutexGuard<'static, HashSet<isize>> {
    static WAITING: OnceLock<Mutex<HashSet<isize>>> = OnceLock::new();
    WAITING
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Record whether `hwnd` has an agent waiting. Returns whether the
/// process-wide "anyone waiting" flag changed.
pub fn set_hwnd(hwnd: isize, is_waiting: bool) -> bool {
    if hwnd == 0 {
        return false;
    }
    let mut set = waiting();
    let before = !set.is_empty();
    if is_waiting {
        set.insert(hwnd);
    } else {
        set.remove(&hwnd);
    }
    let after = !set.is_empty();
    before != after
}

pub fn hwnd_is_waiting(hwnd: isize) -> bool {
    waiting().contains(&hwnd)
}

pub fn any_waiting() -> bool {
    !waiting().is_empty()
}

/// True when a pane user-var means an agent is blocked on the user.
///
/// Claude's hook uses `claude_status=waiting`. Other CLIs (OpenCode,
/// Codex hooks, Cursor, Grok) use the same shape with their own name.
pub fn user_var_is_waiting(name: &str, value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    let waiting = matches!(
        value.as_str(),
        "waiting" | "yes" | "true" | "1" | "approval" | "question" | "permission" | "needs_input"
            | "blocked"
    );
    if !waiting {
        return false;
    }
    let name = name.to_ascii_lowercase();
    name == "claude_status"
        || name.ends_with("_status")
        || name.ends_with("_waiting")
        || name.contains("agent")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_waiting_tracks_the_set() {
        let hwnd = 0x0152_0001;
        assert!(!hwnd_is_waiting(hwnd));
        set_hwnd(hwnd, true);
        assert!(hwnd_is_waiting(hwnd));
        set_hwnd(hwnd, false);
        assert!(!hwnd_is_waiting(hwnd));
    }

    #[test]
    fn user_vars_from_any_agent_count() {
        assert!(user_var_is_waiting("claude_status", "waiting"));
        assert!(user_var_is_waiting("opencode_status", "approval"));
        assert!(user_var_is_waiting("codex_waiting", "yes"));
        assert!(user_var_is_waiting("cursor_agent", "blocked"));
        assert!(!user_var_is_waiting("claude_status", "idle"));
        assert!(!user_var_is_waiting("cwd", "waiting"));
    }
}
