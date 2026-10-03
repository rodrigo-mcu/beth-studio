// Shells offered when a terminal is opened (Beth Studio's "novo terminal" list).
//
// Extracted from the old native context menu (patch 0198) so the host CLI
// bridge keeps the same list after the native window was removed.

/// One shell entry for the "New tab" picker.
pub struct ShellEntry {
    pub id: &'static str,
    pub label: &'static str,
    /// Full command line: program + args. Stored as `Vec<String>` because
    /// `config::keyassignment::SpawnCommand::args` takes `Vec<String>`.
    pub args: Vec<String>,
}

/// Default shells offered in the "New tab" picker.
///
/// On Windows, the available shells are:
///   - `cmd.exe` (the Windows console)
///   - `powershell.exe` (Windows PowerShell 5.1)
///   - `pwsh.exe` (PowerShell 7+)
///   - `wsl.exe` (WSL2 — default distro)
///   - `wsl.exe -d <DistroName>` (named WSL distros)
///   - Git Bash (if installed)
pub fn default_shells() -> Vec<ShellEntry> {
    let mut shells = vec![
        ShellEntry {
            id: "cmd",
            label: "cmd.exe",
            args: vec!["cmd.exe".to_string()],
        },
        ShellEntry {
            id: "powershell",
            label: "PowerShell 5.1",
            args: vec!["powershell.exe".to_string(), "-NoLogo".to_string()],
        },
        ShellEntry {
            id: "pwsh",
            label: "PowerShell 7+",
            args: vec!["pwsh.exe".to_string(), "-NoLogo".to_string()],
        },
        ShellEntry {
            id: "wsl.default",
            label: "WSL (default distro)",
            args: vec!["wsl.exe".to_string()],
        },
        ShellEntry {
            id: "wsl.ubuntu",
            label: "WSL — Ubuntu",
            args: vec![
                "wsl.exe".to_string(),
                "-d".to_string(),
                "Ubuntu".to_string(),
            ],
        },
        ShellEntry {
            id: "gitbash",
            label: "Git Bash",
            args: vec![
                "C:\\Program Files\\Git\\bin\\bash.exe".to_string(),
                "--login".to_string(),
            ],
        },
    ];

    if let Some(path) = moba_local_bash_path() {
        shells.push(ShellEntry {
            id: "mobaxterm.local",
            label: "MobaXterm local bash",
            args: vec![path, "--login".to_string()],
        });
    }

    // Patch 0183: user-defined entries from %APPDATA%\bethstudio\shells.json.
    shells.extend(custom_shells());

    shells
}

fn moba_local_bash_path() -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        candidates.push(format!(
            "{}\\Documents\\MobaXterm\\slash\\bin\\bash.exe",
            user_profile
        ));
    }

    candidates
        .into_iter()
        .find(|path| std::path::Path::new(path).is_file())
}

/// One entry of `%APPDATA%\bethstudio\shells.json` (patch 0183).
#[derive(serde::Deserialize)]
struct CustomShell {
    id: String,
    label: String,
    args: Vec<String>,
}

/// User-defined shells, read once per process from
/// `%APPDATA%\bethstudio\shells.json`:
///
/// ```json
/// [ { "id": "my.tool", "label": "My tool log", "args": ["powershell.exe", "-NoExit", "-Command", "..."] } ]
/// ```
///
/// Invalid entries (empty args, id outside `[a-z0-9._-]`, duplicate id)
/// are skipped. The strings are leaked once so `ShellEntry` can keep its
/// `&'static str` fields.
fn custom_shells() -> Vec<ShellEntry> {
    static CUSTOM: std::sync::OnceLock<Vec<(&'static str, &'static str, Vec<String>)>> =
        std::sync::OnceLock::new();
    CUSTOM
        .get_or_init(|| {
            let Ok(dir) = crate::session::session_dir() else {
                return Vec::new();
            };
            let Ok(text) = std::fs::read_to_string(dir.join("shells.json")) else {
                return Vec::new();
            };
            parse_custom_shells(&text)
                .into_iter()
                .map(|c| {
                    let id: &'static str = Box::leak(c.id.into_boxed_str());
                    let label: &'static str = Box::leak(c.label.into_boxed_str());
                    (id, label, c.args)
                })
                .collect()
        })
        .iter()
        .map(|(id, label, args)| ShellEntry {
            id,
            label,
            args: args.clone(),
        })
        .collect()
}

fn parse_custom_shells(text: &str) -> Vec<CustomShell> {
    let Ok(list) = serde_json::from_str::<Vec<CustomShell>>(text) else {
        log::warn!("bethstudio: shells.json is not a valid list of {{id,label,args}}; ignored");
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    list.into_iter()
        .filter(|c| {
            !c.args.is_empty()
                && !c.label.trim().is_empty()
                && !c.id.is_empty()
                && c.id
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || "._-".contains(ch))
                && seen.insert(c.id.clone())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shells_not_empty() {
        assert!(!default_shells().is_empty());
    }

    #[test]
    fn custom_shells_keep_valid_unique_entries() {
        let parsed = parse_custom_shells(
            r#"[
                {"id": "my.tool", "label": "My tool", "args": ["powershell.exe", "-NoExit"]},
                {"id": "my.tool", "label": "Duplicate", "args": ["cmd.exe"]},
                {"id": "Bad Id", "label": "Bad", "args": ["cmd.exe"]},
                {"id": "no.args", "label": "No args", "args": []},
                {"id": "no.label", "label": " ", "args": ["cmd.exe"]}
            ]"#,
        );
        let ids: Vec<&str> = parsed.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["my.tool"]);
        assert!(parse_custom_shells("not json").is_empty());
    }
}
