//! Beth Studio (patch 0203): end every process a terminal started, not only
//! its shell. `TerminateProcess` on the shell alone left agents, MCP servers
//! (each in its own console) and `wsl.exe` relays running after the pane
//! was gone.

/// One process from a system snapshot.
#[derive(Debug, Clone)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    /// Creation time (FILETIME); 0 when it could not be read.
    pub start: u64,
    pub name: String,
}

/// Never ended through a pane, even when launched from one: the Studio, the
/// host and the bridge (installed names and the Cargo names in target\).
const PROTECTED: &[&str] = &[
    "bethstudio-host.exe",
    "bethstudio-web.exe",
    "bethstudio.exe",
    "wezterm-mux-server.exe",
    "wezterm.exe",
];

fn is_protected(name: &str) -> bool {
    PROTECTED.iter().any(|p| p.eq_ignore_ascii_case(name))
}

/// Descendants of `root`, deepest first. A child counts only if it was
/// created after its parent (Windows reuses PIDs, and the parent id of an
/// orphan may now name an unrelated process). A process whose start time is
/// unknown is left alone, and so is a protected process with its subtree.
pub fn descendants(root: u32, procs: &[ProcEntry]) -> Vec<ProcEntry> {
    let Some(root) = procs.iter().find(|p| p.pid == root) else {
        return vec![];
    };
    if root.start == 0 {
        return vec![];
    }
    let mut out: Vec<ProcEntry> = vec![];
    let mut queue = vec![root.clone()];
    let mut seen = std::collections::HashSet::from([root.pid]);
    while let Some(parent) = queue.pop() {
        for kid in procs {
            if kid.ppid != parent.pid || kid.pid == parent.pid || seen.contains(&kid.pid) {
                continue;
            }
            if kid.start == 0 || kid.start < parent.start || is_protected(&kid.name) {
                continue;
            }
            seen.insert(kid.pid);
            out.push(kid.clone());
            queue.push(kid.clone());
        }
    }
    out.reverse();
    out
}

#[cfg(windows)]
mod imp {
    use super::{descendants, ProcEntry};
    use winapi::shared::minwindef::FILETIME;
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::processthreadsapi::{GetProcessTimes, OpenProcess, TerminateProcess};
    use winapi::um::tlhelp32::*;
    use winapi::um::winnt::{HANDLE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE};

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn open(pid: u32, access: u32) -> Option<Handle> {
        let h = unsafe { OpenProcess(access, 0, pid) };
        (!h.is_null()).then(|| Handle(h))
    }

    fn start_time(h: &Handle) -> u64 {
        let mut t = [FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        }; 4];
        let [c, e, k, u] = &mut t;
        if unsafe { GetProcessTimes(h.0, c, e, k, u) } == 0 {
            return 0;
        }
        (t[0].dwHighDateTime as u64) << 32 | t[0].dwLowDateTime as u64
    }

    fn snapshot() -> Vec<ProcEntry> {
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return vec![];
        }
        let snap = Handle(snap);
        let mut out = vec![];
        let mut e: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as _;
        let mut ok = unsafe { Process32FirstW(snap.0, &mut e) };
        while ok != 0 {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            let start = open(e.th32ProcessID, PROCESS_QUERY_LIMITED_INFORMATION)
                .map(|h| start_time(&h))
                .unwrap_or(0);
            out.push(ProcEntry {
                pid: e.th32ProcessID,
                ppid: e.th32ParentProcessID,
                start,
                name: String::from_utf16_lossy(&e.szExeFile[..len]),
            });
            ok = unsafe { Process32NextW(snap.0, &mut e) };
        }
        out
    }

    /// The PID may have been reused between the snapshot and now: only a
    /// process with the same creation time is ended.
    fn terminate(p: &ProcEntry) -> bool {
        let Some(h) = open(p.pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION) else {
            return false;
        };
        start_time(&h) == p.start && unsafe { TerminateProcess(h.0, 1) } != 0
    }

    /// Ends every descendant of `root` (not `root` itself). Repeats while new
    /// ones show up, so a parent that spawns a child mid-kill is followed.
    pub fn kill_descendants(root: u32) -> usize {
        let mut ended = 0;
        for _ in 0..3 {
            let found = descendants(root, &snapshot());
            if found.is_empty() {
                break;
            }
            for p in &found {
                if terminate(p) {
                    log::info!("kill_tree: ended {} pid {} (pane root {})", p.name, p.pid, root);
                    ended += 1;
                }
            }
        }
        ended
    }
}

#[cfg(windows)]
pub use imp::kill_descendants;

#[cfg(not(windows))]
pub fn kill_descendants(_root: u32) -> usize {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, ppid: u32, start: u64, name: &str) -> ProcEntry {
        ProcEntry {
            pid,
            ppid,
            start,
            name: name.into(),
        }
    }

    fn pids(v: Vec<ProcEntry>) -> Vec<u32> {
        v.into_iter().map(|e| e.pid).collect()
    }

    #[test]
    fn whole_tree_deepest_first() {
        let procs = vec![
            p(10, 1, 100, "pwsh.exe"),
            p(11, 10, 110, "cmd.exe"),
            p(12, 11, 120, "node.exe"),
            p(13, 12, 130, "python.exe"),
            p(14, 12, 131, "wsl.exe"),
            p(99, 1, 50, "explorer.exe"),
        ];
        let got = pids(descendants(10, &procs));
        assert_eq!(got.len(), 4);
        assert_eq!(got.last(), Some(&11));
        assert!(got.iter().position(|&x| x == 13) < got.iter().position(|&x| x == 12));
        assert!(!got.contains(&10) && !got.contains(&99));
    }

    #[test]
    fn reused_parent_pid_is_not_followed() {
        // 20 is older than the shell that now holds pid 10: its real parent died long ago.
        let procs = vec![p(10, 1, 100, "pwsh.exe"), p(20, 10, 90, "chrome.exe")];
        assert!(descendants(10, &procs).is_empty());
    }

    #[test]
    fn protected_process_and_its_subtree_survive() {
        let procs = vec![
            p(10, 1, 100, "pwsh.exe"),
            p(11, 10, 110, "BethStudio-Web.exe"),
            p(12, 11, 120, "bethstudio-host.exe"),
            p(13, 10, 130, "node.exe"),
        ];
        assert_eq!(pids(descendants(10, &procs)), vec![13]);
    }

    #[test]
    fn unknown_start_time_is_left_alone() {
        let procs = vec![p(10, 1, 100, "pwsh.exe"), p(11, 10, 0, "svc.exe")];
        assert!(descendants(10, &procs).is_empty());
        let procs = vec![p(10, 1, 0, "pwsh.exe"), p(11, 10, 110, "node.exe")];
        assert!(descendants(10, &procs).is_empty());
    }

    #[test]
    fn missing_root_kills_nothing() {
        assert!(descendants(10, &[p(11, 10, 110, "node.exe")]).is_empty());
    }
}
