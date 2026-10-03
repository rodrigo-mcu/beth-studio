//! BethTerm (patch 0133): keep the GUI log directory small.
//!
//! wezterm writes one `<exe>-log-<pid>.txt` per process under
//! `config::RUNTIME_DIR` (`%USERPROFILE%\.local\share\wezterm`) and only
//! deletes files older than seven days. A single debug session can leave
//! a 300 MB file behind, and the directory was found at 609 MB. This
//! module deletes BethTerm logs that are older than [`MAX_AGE`] and then,
//! oldest first, until the BethTerm logs fit in [`MAX_TOTAL_BYTES`]. The
//! running process's own log is never touched. The work runs on a helper
//! thread so a slow disk cannot delay the first window.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Logs older than this are always removed.
pub const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Total size the BethTerm logs may occupy after pruning.
pub const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

const PREFIXES: &[&str] = &["bethterm-gui.exe-log-", "bethterm.exe-log-", "bethterm-host"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogFile {
    pub path: PathBuf,
    pub len: u64,
    pub modified: SystemTime,
}

fn is_bethterm_log(name: &str) -> bool {
    name.ends_with(".txt") && PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Enumerate BethTerm logs in `dir` (non-recursive).
pub fn list_logs(dir: &Path) -> Vec<LogFile> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_bethterm_log(name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        out.push(LogFile {
            path: entry.path(),
            len: meta.len(),
            modified,
        });
    }
    out
}

/// Pure selection: which of `logs` to delete so that everything older
/// than `max_age` (relative to `now`) goes, and the remainder fits in
/// `max_total` bytes, dropping the oldest first. `keep` is never chosen.
pub fn select_for_deletion(
    logs: &[LogFile],
    keep: Option<&Path>,
    now: SystemTime,
    max_age: Duration,
    max_total: u64,
) -> Vec<PathBuf> {
    let mut candidates: Vec<&LogFile> = logs
        .iter()
        .filter(|l| keep.map(|k| k != l.path.as_path()).unwrap_or(true))
        .collect();
    // Oldest first.
    candidates.sort_by_key(|l| l.modified);

    let mut delete = Vec::new();
    let mut total: u64 = logs.iter().map(|l| l.len).sum();

    for l in &candidates {
        let too_old = now
            .duration_since(l.modified)
            .map(|age| age > max_age)
            .unwrap_or(false);
        if too_old {
            delete.push(l.path.clone());
            total = total.saturating_sub(l.len);
        }
    }
    for l in &candidates {
        if total <= max_total {
            break;
        }
        if delete.contains(&l.path) {
            continue;
        }
        delete.push(l.path.clone());
        total = total.saturating_sub(l.len);
    }
    delete
}

/// Prune `dir` now, on the calling thread. Returns the number of files
/// removed and the bytes freed.
pub fn prune_dir(dir: &Path, keep: Option<&Path>) -> (usize, u64) {
    let logs = list_logs(dir);
    let victims = select_for_deletion(&logs, keep, SystemTime::now(), MAX_AGE, MAX_TOTAL_BYTES);
    let mut n = 0usize;
    let mut freed = 0u64;
    for path in victims {
        let len = logs
            .iter()
            .find(|l| l.path == path)
            .map(|l| l.len)
            .unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            n += 1;
            freed += len;
        }
    }
    (n, freed)
}

/// The log file wezterm's `env_bootstrap` opened for this process.
fn own_log_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let base = exe.file_name()?.to_str()?.to_string();
    Some(config::RUNTIME_DIR.join(format!("{}-log-{}.txt", base, std::process::id())))
}

/// Prune the wezterm runtime log directory on a background thread.
/// Safe to call early in GUI startup; it never blocks the caller.
pub fn prune_in_background() {
    let dir = config::RUNTIME_DIR.clone();
    let keep = own_log_path();
    let _ = std::thread::Builder::new()
        .name("bethterm-log-prune".into())
        .spawn(move || {
            let started = std::time::Instant::now();
            let (n, freed) = prune_dir(&dir, keep.as_deref());
            if n > 0 {
                log::info!(
                    "bethterm: pruned {} old log file(s), {} MiB freed in {:?}",
                    n,
                    freed / (1024 * 1024),
                    started.elapsed()
                );
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lf(name: &str, len: u64, age_secs: u64, now: SystemTime) -> LogFile {
        LogFile {
            path: PathBuf::from(name),
            len,
            modified: now - Duration::from_secs(age_secs),
        }
    }

    #[test]
    fn old_files_go_even_when_small() {
        let now = SystemTime::now();
        let logs = vec![
            lf("bethterm-gui.exe-log-1.txt", 10, 8 * 86400, now),
            lf("bethterm-gui.exe-log-2.txt", 10, 60, now),
        ];
        let del = select_for_deletion(&logs, None, now, MAX_AGE, MAX_TOTAL_BYTES);
        assert_eq!(del, vec![PathBuf::from("bethterm-gui.exe-log-1.txt")]);
    }

    #[test]
    fn size_cap_drops_oldest_first_and_keeps_own_log() {
        let now = SystemTime::now();
        let own = PathBuf::from("bethterm-gui.exe-log-me.txt");
        let logs = vec![
            lf("bethterm-gui.exe-log-a.txt", 60, 3000, now),
            lf("bethterm-gui.exe-log-b.txt", 60, 2000, now),
            lf("bethterm-gui.exe-log-c.txt", 60, 1000, now),
            LogFile {
                path: own.clone(),
                len: 60,
                modified: now - Duration::from_secs(5000),
            },
        ];
        // Cap at 150: total 240 → must drop a (→180) then b (→120).
        let del = select_for_deletion(&logs, Some(&own), now, MAX_AGE, 150);
        assert_eq!(
            del,
            vec![
                PathBuf::from("bethterm-gui.exe-log-a.txt"),
                PathBuf::from("bethterm-gui.exe-log-b.txt")
            ]
        );
    }

    #[test]
    fn nothing_to_do_when_under_cap_and_fresh() {
        let now = SystemTime::now();
        let logs = vec![lf("bethterm.exe-log-1.txt", 5, 10, now)];
        assert!(select_for_deletion(&logs, None, now, MAX_AGE, 100).is_empty());
    }

    #[test]
    fn list_and_prune_real_temp_dir() {
        let dir = std::env::temp_dir().join(format!("bethterm-log-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bethterm-gui.exe-log-1.txt"), vec![0u8; 70]).unwrap();
        std::fs::write(dir.join("bethterm-gui.exe-log-2.txt"), vec![0u8; 70]).unwrap();
        std::fs::write(dir.join("other.txt"), vec![0u8; 500]).unwrap();
        let logs = list_logs(&dir);
        assert_eq!(logs.len(), 2, "only bethterm logs are listed");
        // Cap 100 bytes: one of the two must go.
        let victims = select_for_deletion(&logs, None, SystemTime::now(), MAX_AGE, 100);
        assert_eq!(victims.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
