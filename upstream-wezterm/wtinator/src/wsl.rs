// wtinator::wsl — shared WSL2 detection + path-conversion helpers.
//
// `pane_is_wsl` was introduced for image paste (patch 0059) and is moved here
// so it can be reused; patch 0064 adds the WSL -> Windows path conversion used
// when OPENING a file link clicked in a WSL2 pane.
//
// Two directions:
//   * Windows -> WSL (`C:\..` -> `/mnt/c/..`) lives in `image_paste`
//     (`windows_path_to_wsl_mount`) — used when pasting an image path INTO a
//     WSL shell.
//   * WSL -> Windows (`/mnt/c/..` -> `C:\..`, `/home/..` ->
//     `\\wsl.localhost\<distro>\..`) lives HERE — used when opening a file link
//     so Windows Explorer / the editor can reach it.

use mux::pane::{CachePolicy, Pane};
use mux::Mux;
use std::sync::Arc;

/// Best-effort: is `pane` running a WSL2 shell? Either it lives in a wezterm
/// WSL domain (`WSL:<distro>`) or its foreground process is `wsl.exe` (the user
/// ran `wsl` in a plain local pane).
pub fn pane_is_wsl(pane: &Arc<dyn Pane>) -> bool {
    if let Some(mux) = Mux::try_get() {
        if let Some(domain) = mux.get_domain(pane.domain_id()) {
            if domain.domain_name().starts_with("WSL:") {
                return true;
            }
        }
    }
    if let Some(name) = pane.get_foreground_process_name(CachePolicy::FetchImmediate) {
        let exe = name
            .rsplit(|c| c == '/' || c == '\\')
            .next()
            .unwrap_or(name.as_str())
            .to_ascii_lowercase();
        if exe == "wsl.exe" || exe == "wsl" {
            return true;
        }
    }
    false
}

/// Convert a drive-letter Windows path to the default WSL automount form.
/// Non-drive paths are returned with slash normalization only.
pub fn windows_path_to_wsl_mount(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/'
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = normalized[3..].trim_start_matches('/');
        if rest.is_empty() {
            format!("/mnt/{drive}")
        } else {
            format!("/mnt/{drive}/{rest}")
        }
    } else {
        normalized
    }
}

/// The WSL distro for `pane`: from a `WSL:<distro>` domain name if present,
/// else the default distro reported by `wsl.exe -l -q`.
#[cfg(windows)]
fn distro_for_pane(pane: &Arc<dyn Pane>) -> Option<String> {
    if let Some(mux) = Mux::try_get() {
        if let Some(domain) = mux.get_domain(pane.domain_id()) {
            if let Some(d) = domain.domain_name().strip_prefix("WSL:") {
                if !d.is_empty() {
                    return Some(d.to_string());
                }
            }
        }
    }
    default_wsl_distro()
}

/// The default WSL distro (`wsl.exe -l -q`). `wsl.exe` emits UTF-16LE, so we
/// decode it as such — the previous UTF-8 parse produced NUL-laced garbage.
#[cfg(windows)]
fn default_wsl_distro() -> Option<String> {
    let out = std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .output()
        .ok()?;
    let utf16: Vec<u16> = out
        .stdout
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&utf16)
        .lines()
        .map(|l| l.trim().trim_matches('\0').trim())
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

/// Convert a Linux path seen in a WSL2 pane into a Windows path that Explorer /
/// an editor can open: `/mnt/<drive>/..` -> `<DRIVE>:\..`; any other absolute
/// path -> `\\wsl.localhost\<distro>\..`. Falls back to a slash-normalised copy.
#[cfg(windows)]
pub fn unix_path_to_windows(unix_path: &str, pane: &Arc<dyn Pane>) -> String {
    unix_to_windows_with_distro(unix_path, distro_for_pane(pane).as_deref())
}

#[cfg(not(windows))]
pub fn unix_path_to_windows(unix_path: &str, _pane: &Arc<dyn Pane>) -> String {
    unix_path.to_string()
}

/// Pure conversion (testable without a pane/mux). `distro` is used only for the
/// WSL-native (`\\wsl.localhost\..`) fallback.
fn unix_to_windows_with_distro(unix_path: &str, distro: Option<&str>) -> String {
    // /mnt/<drive>/rest -> <DRIVE>:\rest  (a Windows drive mounted in WSL).
    if let Some(rest) = unix_path.strip_prefix("/mnt/") {
        let b = rest.as_bytes();
        if !b.is_empty() && b[0].is_ascii_alphabetic() && (b.len() == 1 || b[1] == b'/') {
            let drive = (b[0] as char).to_ascii_uppercase();
            let tail = rest[1..].trim_start_matches('/').replace('/', "\\");
            return format!("{}:\\{}", drive, tail);
        }
    }
    // A WSL-native absolute path -> \\wsl.localhost\<distro>\...
    if unix_path.starts_with('/') {
        if let Some(distro) = distro {
            let tail = unix_path.trim_start_matches('/').replace('/', "\\");
            return format!("\\\\wsl.localhost\\{}\\{}", distro, tail);
        }
    }
    unix_path.replace('/', "\\")
}

/// Patch 0161: what a pane restored from `session.json` should run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreCommand {
    /// Full argv. `None` runs the default shell.
    pub argv: Option<Vec<String>>,
    /// Windows directory to start in, still to be validated. `None`
    /// when the directory went into `wsl.exe --cd` or none was saved.
    pub windows_cwd: Option<String>,
}

fn is_wsl_argv(argv: &[String]) -> bool {
    argv.first().is_some_and(|a0| {
        let exe = a0.rsplit(['/', '\\']).next().unwrap_or(a0).to_ascii_lowercase();
        exe == "wsl.exe" || exe == "wsl"
    })
}

/// A WSL pane reports its cwd through OSC 7 as `file://<host>/<path>`,
/// which Windows sees as `\\<host>\<path>`. Map it back to the Linux
/// path. `<host>` is the WSL hostname (the computer name by default),
/// or `wsl.localhost` / `wsl$` followed by the distro.
fn wsl_cwd_from_unc(cwd: &str, computer_name: Option<&str>) -> Option<(Option<String>, String)> {
    let rest = cwd.strip_prefix("\\\\")?;
    let (host, rest) = rest.split_once('\\').unwrap_or((rest, ""));
    let to_linux = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/');
        format!("/{}", p.trim_start_matches('/'))
    };
    if host.eq_ignore_ascii_case("wsl.localhost") || host.eq_ignore_ascii_case("wsl$") {
        let (distro, path) = rest.split_once('\\').unwrap_or((rest, ""));
        if distro.is_empty() {
            return None;
        }
        return Some((Some(distro.to_string()), to_linux(path)));
    }
    let computer = computer_name?;
    if !host.is_empty() && host.eq_ignore_ascii_case(computer) {
        return Some((None, to_linux(rest)));
    }
    None
}

/// Decide the command for a restored pane. `args` is the recorded argv
/// (patch 0161), `program` the older foreground-process field.
pub fn restore_command(
    args: &[String],
    program: Option<&str>,
    cwd: Option<&str>,
    computer_name: Option<&str>,
) -> RestoreCommand {
    let mut argv = if args.is_empty() {
        program.map(|p| vec![p.to_string()])
    } else {
        Some(args.to_vec())
    };
    let Some((distro, linux_cwd)) = cwd.and_then(|c| wsl_cwd_from_unc(c, computer_name)) else {
        return RestoreCommand {
            argv,
            windows_cwd: cwd.map(str::to_string),
        };
    };
    // A WSL directory with no saved command: sessions written before
    // patch 0161 never recorded `wsl.exe`.
    if argv.is_none() {
        let mut v = vec!["wsl.exe".to_string()];
        if let Some(d) = distro {
            v.extend(["-d".to_string(), d]);
        }
        argv = Some(v);
    }
    match argv {
        Some(mut v) if is_wsl_argv(&v) => {
            // The saved directory wins over a `--cd` recorded from an
            // earlier restore, else the pane would return to where it
            // was first restored instead of where the user left it.
            if let Some(i) = v.iter().position(|a| a == "--cd") {
                let end = (i + 2).min(v.len());
                v.drain(i..end);
            }
            // A missing directory only makes wsl start in `/`.
            v.splice(1..1, ["--cd".to_string(), linux_cwd]);
            RestoreCommand {
                argv: Some(v),
                windows_cwd: None,
            }
        }
        other => RestoreCommand {
            argv: other,
            windows_cwd: cwd.map(str::to_string),
        },
    }
}

#[cfg(test)]
mod restore_tests {
    use super::{restore_command, RestoreCommand};

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn recorded_wsl_gets_linux_cwd() {
        let r = restore_command(
            &s(&["wsl.exe", "-d", "Debian"]),
            None,
            Some("\\\\my-pc\\mnt\\data\\projects\\app\\"),
            Some("MY-PC"),
        );
        assert_eq!(
            r,
            RestoreCommand {
                argv: Some(s(&["wsl.exe", "--cd", "/mnt/data/projects/app", "-d", "Debian"])),
                windows_cwd: None,
            }
        );
    }

    #[test]
    fn old_session_with_wsl_cwd_becomes_wsl() {
        let r = restore_command(&[], None, Some("\\\\DESKTOP-X\\home\\rod"), Some("desktop-x"));
        assert_eq!(r.argv, Some(s(&["wsl.exe", "--cd", "/home/rod"])));
        let r = restore_command(&[], None, Some("\\\\wsl.localhost\\Ubuntu\\srv\\"), None);
        assert_eq!(r.argv, Some(s(&["wsl.exe", "--cd", "/srv", "-d", "Ubuntu"])));
        let r = restore_command(&[], None, Some("\\\\wsl$\\Debian"), None);
        assert_eq!(r.argv, Some(s(&["wsl.exe", "--cd", "/", "-d", "Debian"])));
    }

    #[test]
    fn windows_panes_are_unchanged() {
        let r = restore_command(&[], None, Some("C:\\Users\\someone\\"), Some("PC"));
        assert_eq!(r.argv, None);
        assert_eq!(r.windows_cwd.as_deref(), Some("C:\\Users\\someone\\"));
        let r = restore_command(&s(&["pwsh.exe"]), None, Some("\\\\PC\\share"), Some("pc"));
        assert_eq!(r.argv, Some(s(&["pwsh.exe"])));
        assert_eq!(r.windows_cwd.as_deref(), Some("\\\\PC\\share"));
        // Another machine's share is not WSL.
        let r = restore_command(&[], None, Some("\\\\nas\\data"), Some("pc"));
        assert_eq!(r.argv, None);
    }

    #[test]
    fn saved_cwd_replaces_recorded_cd() {
        let r = restore_command(
            &s(&["wsl.exe", "--cd", "/old", "-d", "Debian"]),
            None,
            Some("\\\\pc\\new\\dir"),
            Some("PC"),
        );
        assert_eq!(r.argv, Some(s(&["wsl.exe", "--cd", "/new/dir", "-d", "Debian"])));
        // No WSL cwd saved: the recorded --cd is left alone.
        let r = restore_command(&s(&["wsl.exe", "--cd", "~"]), None, None, Some("PC"));
        assert_eq!(r.argv, Some(s(&["wsl.exe", "--cd", "~"])));
    }
}

#[cfg(test)]
mod tests {
    use super::unix_to_windows_with_distro as conv;

    #[test]
    fn mnt_drive_to_windows_drive() {
        assert_eq!(conv("/mnt/c/Users/foo/bar.rs", None), "C:\\Users\\foo\\bar.rs");
        assert_eq!(conv("/mnt/d/a/b", Some("Ubuntu")), "D:\\a\\b");
        assert_eq!(conv("/mnt/c", None), "C:\\");
    }

    #[test]
    fn wsl_native_to_unc() {
        assert_eq!(
            conv("/home/user/main.rs", Some("Ubuntu")),
            "\\\\wsl.localhost\\Ubuntu\\home\\user\\main.rs"
        );
        // /mnt/wsl is NOT a single-letter drive -> treated as a WSL-native path.
        assert_eq!(
            conv("/mnt/wsl/foo", Some("Debian")),
            "\\\\wsl.localhost\\Debian\\mnt\\wsl\\foo"
        );
    }

    #[test]
    fn no_distro_falls_back_to_backslashes() {
        assert_eq!(conv("/home/user/x", None), "\\home\\user\\x");
    }
}
