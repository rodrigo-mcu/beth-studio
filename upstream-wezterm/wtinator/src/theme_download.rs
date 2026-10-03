// wtinator::theme_download — Phase 1.G (patch 0038).
//
// A terminal-theme DOWNLOADER. It fetches the Gogh community theme
// catalog over HTTPS, converts every entry to the same hex-string
// shape as `notify::ThemeSnapshot`, and caches each theme as a
// pretty-printed JSON file under `%APPDATA%\wezterminator\themes\`.
// The config app's theme picker then shows the downloaded themes as
// extra cards (kind = `UserDownloaded`) alongside the 3 baked-in
// themes, and the right-click "Theme" submenu / `set_theme` IPC can
// apply them (see `notify_ipc::palette_from_theme_id`).
//
// ## Data source (Gogh)
//
// `https://raw.githubusercontent.com/Gogh-Co/Gogh/master/data/themes.json`
// is a JSON array. Each entry has the shape (verified against the
// live schema + `lua-api-crates/color-funcs/src/schemes/gogh.rs`):
//
//   {
//     "name": "Dracula",
//     "color_01": "#000000",   // normal black
//     "color_02": "#...",       // normal red
//     ...
//     "color_08": "#...",       // normal white
//     "color_09": "#...",       // bright black
//     ...
//     "color_16": "#...",       // bright white
//     "foreground": "#...",
//     "background": "#...",
//     "cursor": "#..."
//   }
//
// `color_01..08` = normal black..white, `color_09..16` =
// bright black..white. There is no per-theme selection colour in
// Gogh, so we derive `selection_fg = foreground` and
// `selection_bg = background` (the React preview only uses the 16
// ANSI colours + fg/bg anyway, and `palette_for_saved` builds a
// usable `ColorPalette` from these).
//
// ## Storage
//
// `themes_dir()` = `wtinator::session::session_dir()?.join("themes")`
// (created on demand). Each theme is written to `<id>.json` where
// `<id>` is a slug of the name ("Tokyo Night" -> "tokyo-night").
// Writes are atomic (`.tmp` + rename) mirroring
// `wtinator::session::save`.
//
// ## Networking
//
// `download_catalog()` uses `reqwest::blocking` (NOT the async
// client) because the config app — the primary caller — has no
// tokio runtime. The blocking client spins up its own runtime
// internally. One bad theme never aborts the batch: we log a
// warning and skip it.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use wezterm_term::color::{ColorPalette, SrgbaTuple};

/// The Gogh catalog URL (a JSON array of themes). Same URL used by
/// `sync-color-schemes/src/gogh.rs`.
pub const GOGH_THEMES_URL: &str =
    "https://raw.githubusercontent.com/Gogh-Co/Gogh/master/data/themes.json";

/// Mirrors of the catalog. Windows error 10013 (WSAEACCES) often
/// blocks `raw.githubusercontent.com` via Hyper-V reserved ports or
/// a filtering proxy; jsDelivr and curl/WinHTTP usually still work.
const GOGH_THEMES_MIRRORS: &[&str] = &[
    GOGH_THEMES_URL,
    "https://cdn.jsdelivr.net/gh/Gogh-Co/Gogh@master/data/themes.json",
    "https://fastly.jsdelivr.net/gh/Gogh-Co/Gogh@master/data/themes.json",
];

/// Snapshot shipped in the binary (Gogh `themes.json`). Used when
/// the network is blocked (Windows error 10013) and as the default
/// catalog on first launch.
const BUNDLED_GOGH_JSON: &[u8] = include_bytes!("../data/gogh-themes.json");

/// Result of installing the catalog into `%APPDATA%\bethstudio\themes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogSource {
    /// Fetched from the network (mirror or `BETHSTUDIO_THEMES_URL`).
    Network,
    /// Unpacked from the binary snapshot.
    Bundled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CatalogResult {
    pub count: usize,
    pub source: CatalogSource,
}

/// A downloaded theme, cached as JSON under
/// `%APPDATA%\wezterminator\themes\<id>.json`.
///
/// The field shape mirrors `notify::ThemeSnapshot` (16 ANSI hex
/// strings + fg/bg/cursor/selection) so a saved theme round-trips
/// straight into a `ThemeSnapshot` for the config app (see
/// `notify::snapshot_for_config`). `id` is a slug of `name`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedTheme {
    /// Stable slug id (e.g. "tokyo-night"). Used as the wire-format
    /// theme id and the JSON file stem.
    pub id: String,
    /// Human-readable display name (e.g. "Tokyo Night").
    pub name: String,
    /// The 16 ANSI colours as `#rrggbb` hex strings
    /// (0..7 normal black..white, 8..15 bright black..white).
    pub ansi: [String; 16],
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    pub selection_fg: String,
    pub selection_bg: String,
}

/// One entry of the Gogh `themes.json` array. We deserialize only
/// the fields we need; the `#[serde(rename = ...)]` maps the
/// `color_NN` keys to readable field names. Extra keys in the JSON
/// (if Gogh adds any) are ignored.
#[derive(Debug, Clone, Deserialize)]
struct GoghEntry {
    name: String,
    #[serde(rename = "color_01")]
    color_01: String,
    #[serde(rename = "color_02")]
    color_02: String,
    #[serde(rename = "color_03")]
    color_03: String,
    #[serde(rename = "color_04")]
    color_04: String,
    #[serde(rename = "color_05")]
    color_05: String,
    #[serde(rename = "color_06")]
    color_06: String,
    #[serde(rename = "color_07")]
    color_07: String,
    #[serde(rename = "color_08")]
    color_08: String,
    #[serde(rename = "color_09")]
    color_09: String,
    #[serde(rename = "color_10")]
    color_10: String,
    #[serde(rename = "color_11")]
    color_11: String,
    #[serde(rename = "color_12")]
    color_12: String,
    #[serde(rename = "color_13")]
    color_13: String,
    #[serde(rename = "color_14")]
    color_14: String,
    #[serde(rename = "color_15")]
    color_15: String,
    #[serde(rename = "color_16")]
    color_16: String,
    foreground: String,
    background: String,
    cursor: String,
}

/// Convert an `SrgbaTuple` to a lowercase `#rrggbb` hex string.
fn srgba_to_hex(c: SrgbaTuple) -> String {
    let r = (c.0.clamp(0.0, 1.0) * 255.0).round() as u8;
    let g = (c.1.clamp(0.0, 1.0) * 255.0).round() as u8;
    let b = (c.2.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

/// Approximate BT.601 luminance of an sRGB colour.
fn luminance(c: SrgbaTuple) -> f32 {
    0.299 * c.0 + 0.587 * c.1 + 0.114 * c.2
}

/// Derive a visible selection colour pair from a Gogh theme.
///
/// Gogh themes do not ship `selection_fg`/`selection_bg`. We mix the
/// background with the foreground and increase the mix until the
/// resulting highlight is visibly different from the background
/// (luminance delta >= 0.20). The foreground is kept for the selected
/// text so it remains legible.
fn derive_selection_colors(foreground: &str, background: &str) -> (String, String) {
    let fg = parse_hex(foreground).unwrap_or(SrgbaTuple(0.9, 0.9, 0.9, 1.0));
    let bg = parse_hex(background).unwrap_or(SrgbaTuple(0.1, 0.1, 0.1, 1.0));

    let bg_lum = luminance(bg);
    let fg_lum = luminance(fg);
    // Start with a subtle mix and push toward the foreground until we
    // have enough contrast against the background.
    let mut mix = 0.35;
    let mut selection_bg = bg.interpolate(fg, mix);
    while (luminance(selection_bg) - bg_lum).abs() < 0.20 && mix < 1.0 {
        mix += 0.05;
        selection_bg = bg.interpolate(fg, mix);
    }
    // Guard: if foreground and background have essentially the same
    // luminance (very unusual), fall back to a hard-wired highlight.
    if (fg_lum - bg_lum).abs() < 0.05 {
        let fallback = if bg_lum > 0.5 {
            SrgbaTuple(0.0, 0.0, 0.0, 1.0)
        } else {
            SrgbaTuple(1.0, 1.0, 1.0, 1.0)
        };
        selection_bg = bg.interpolate(fallback, 0.40);
    }

    (srgba_to_hex(fg), srgba_to_hex(selection_bg))
}

impl GoghEntry {
    /// Convert to a `SavedTheme`. Returns `None` (with a logged
    /// warning) if the name slugifies to nothing — every entry has
    /// all 16 colours by schema, but we still normalise/validate
    /// the hex strings lazily at palette-build time rather than
    /// dropping a whole theme over one odd colour.
    fn into_saved(self) -> Option<SavedTheme> {
        let id = slugify(&self.name);
        if id.is_empty() {
            log::warn!(
                "wezterminator patch 0038: skipping Gogh theme with \
                 empty slug (name = {:?})",
                self.name
            );
            return None;
        }
        // Gogh has no per-theme selection colour; derive a visible pair
        // from the theme's foreground/background and its bright blue
        // (ANSI 12) so the selection is never identical to the
        // background. We do this here so the config-app preview is also
        // accurate. This must happen before we move color_12 into the
        // ansi array below.
        let (selection_fg, selection_bg) =
            derive_selection_colors(&self.foreground, &self.background);
        let ansi = [
            self.color_01,
            self.color_02,
            self.color_03,
            self.color_04,
            self.color_05,
            self.color_06,
            self.color_07,
            self.color_08,
            self.color_09,
            self.color_10,
            self.color_11,
            self.color_12,
            self.color_13,
            self.color_14,
            self.color_15,
            self.color_16,
        ];
        Some(SavedTheme {
            id,
            name: self.name,
            ansi,
            foreground: self.foreground,
            background: self.background,
            cursor: self.cursor,
            selection_fg,
            selection_bg,
        })
    }
}

/// Directory where downloaded themes are cached:
/// `%APPDATA%\bethstudio\themes\` (Windows) /
/// `~/.config/bethstudio/themes/` (other). Created on demand.
pub fn themes_dir() -> Result<PathBuf> {
    let dir = crate::session::session_dir()?.join("themes");
    fs::create_dir_all(&dir)
        .with_context(|| format!("creating themes dir {}", dir.display()))?;
    Ok(dir)
}

/// Slugify a theme name into a stable, filename-safe id.
/// "Tokyo Night" -> "tokyo-night", "Solarized (dark)" ->
/// "solarized-dark", "3024 Night" -> "3024-night". Lowercases,
/// keeps `[a-z0-9]`, collapses every run of other characters into a
/// single `-`, and trims leading/trailing `-`.
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = false;
    for ch in name.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    // Trim a trailing dash (if the name ended in punctuation).
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Parse a `#rrggbb` (or `#rgb`) hex colour into an `SrgbaTuple`
/// (alpha = 1.0). Returns `None` on malformed input.
pub fn parse_hex(s: &str) -> Option<SrgbaTuple> {
    let s = s.trim();
    let hex = s.strip_prefix('#')?;
    let (r, g, b) = match hex.len() {
        6 => {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            (r, g, b)
        }
        3 => {
            // `#abc` -> `#aabbcc`
            let r = u8::from_str_radix(&hex[0..1], 16).ok()?;
            let g = u8::from_str_radix(&hex[1..2], 16).ok()?;
            let b = u8::from_str_radix(&hex[2..3], 16).ok()?;
            (r * 17, g * 17, b * 17)
        }
        _ => return None,
    };
    Some(SrgbaTuple(
        r as f32 / 255.0,
        g as f32 / 255.0,
        b as f32 / 255.0,
        1.0,
    ))
}

/// Download the Gogh theme catalog, convert each entry, and write
/// `<id>.json` for each into `themes_dir()`. Returns the number of
/// themes written. One bad theme never aborts the batch — we log a
/// warning and continue.
pub fn download_catalog() -> Result<CatalogResult> {
    for url in catalog_urls() {
        match fetch_catalog_bytes(&url) {
            Ok(body) => match parse_gogh_json(&body) {
                Ok(entries) => {
                    let count = write_catalog(entries)?;
                    log::info!("bethstudio: installed {count} theme(s) from {url}");
                    return Ok(CatalogResult {
                        count,
                        source: CatalogSource::Network,
                    });
                }
                Err(e) => log::warn!("bethstudio: catalog from {url} did not parse: {e:#}"),
            },
            Err(e) => log::warn!("bethstudio theme download via {url} failed: {e:#}"),
        }
    }
    let count = install_bundled_catalog()?;
    Ok(CatalogResult {
        count,
        source: CatalogSource::Bundled,
    })
}

/// If `%APPDATA%\bethstudio\themes` has no JSON yet, unpack the bundled
/// catalog so Settings is useful without a network click.
pub fn ensure_local_themes() {
    if load_saved_themes().is_empty() {
        match install_bundled_catalog() {
            Ok(n) => log::info!("bethstudio: seeded {n} bundled theme(s)"),
            Err(e) => log::warn!("bethstudio: could not seed bundled themes: {e:#}"),
        }
    }
}

fn catalog_urls() -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(custom) = std::env::var("BETHSTUDIO_THEMES_URL") {
        let custom = custom.trim().to_string();
        if !custom.is_empty() {
            urls.push(custom);
        }
    }
    urls.extend(GOGH_THEMES_MIRRORS.iter().map(|s| (*s).to_string()));
    urls
}

fn parse_gogh_json(body: &[u8]) -> Result<Vec<GoghEntry>> {
    serde_json::from_slice(body).context("parsing Gogh themes.json")
}

fn install_bundled_catalog() -> Result<usize> {
    let entries = parse_gogh_json(BUNDLED_GOGH_JSON).context("bundled gogh-themes.json")?;
    write_catalog(entries)
}

fn fetch_catalog_bytes(url: &str) -> Result<Vec<u8>> {
    match fetch_reqwest(url) {
        Ok(body) => return Ok(body),
        Err(e) => log::warn!("reqwest fetch {url}: {e:#}"),
    }
    if let Ok(body) = fetch_curl(url) {
        return Ok(body);
    }
    fetch_powershell(url).with_context(|| format!("fetching {url}"))
}

fn fetch_reqwest(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("BethStudio-theme-downloader/1.0")
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .context("building reqwest blocking client")?;
    let mut last = None;
    for attempt in 1..=4 {
        match client.get(url).send() {
            Ok(resp) => {
                let status = resp.status();
                let body = resp.bytes().context("reading catalog body")?;
                if !status.is_success() {
                    anyhow::bail!("HTTP {} ({} bytes)", status, body.len());
                }
                anyhow::ensure!(!body.is_empty(), "empty catalog");
                return Ok(body.to_vec());
            }
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(150 * attempt));
            }
        }
    }
    Err(last.unwrap().into())
}

fn fetch_curl(url: &str) -> Result<Vec<u8>> {
    let mut cmd = std::process::Command::new("curl.exe");
    cmd.args([
        "-fsSL",
        "--max-time",
        "60",
        "-A",
        "BethStudio-theme-downloader/1.0",
        url,
    ]);
    hide_window(&mut cmd);
    let out = cmd.output().context("curl.exe")?;
    anyhow::ensure!(
        out.status.success(),
        "curl.exe failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    anyhow::ensure!(!out.stdout.is_empty(), "curl.exe returned empty body");
    Ok(out.stdout)
}

fn fetch_powershell(url: &str) -> Result<Vec<u8>> {
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; \
         (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri '{}').Content",
        url.replace('\'', "''")
    );
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    hide_window(&mut cmd);
    let out = cmd.output().context("powershell Invoke-WebRequest")?;
    anyhow::ensure!(
        out.status.success(),
        "PowerShell download failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    anyhow::ensure!(!out.stdout.is_empty(), "PowerShell returned empty body");
    Ok(out.stdout)
}

fn hide_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Convert + write a batch of parsed Gogh entries. Split out from
/// `download_catalog` so it is unit-testable without the network.
fn write_catalog(entries: Vec<GoghEntry>) -> Result<usize> {
    let dir = themes_dir()?;
    let mut written = 0usize;
    for entry in entries {
        let Some(saved) = entry.into_saved() else {
            continue;
        };
        match write_one(&dir, &saved) {
            Ok(()) => written += 1,
            Err(e) => {
                log::warn!(
                    "wezterminator patch 0038: failed to write theme {:?}: {:#}",
                    saved.id,
                    e
                );
            }
        }
    }
    log::info!(
        "wezterminator patch 0038: wrote {} downloaded theme(s) to {}",
        written,
        dir.display()
    );
    Ok(written)
}

/// Write one `SavedTheme` to `<dir>/<id>.json` atomically
/// (`.tmp` + rename), mirroring `wtinator::session::save`.
fn write_one(dir: &std::path::Path, saved: &SavedTheme) -> Result<()> {
    let path = dir.join(format!("{}.json", saved.id));
    let bytes = serde_json::to_vec_pretty(saved).context("serialize theme")?;
    let mut tmp = path.clone();
    tmp.as_mut_os_string().push(".tmp");
    fs::write(&tmp, &bytes).with_context(|| format!("writing {}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Read every `*.json` in `themes_dir()`, parse each as a
/// `SavedTheme`, and return the ones that parsed. Unreadable /
/// malformed files are skipped (with a logged warning). Returns an
/// empty `Vec` if the directory does not exist or cannot be read.
pub fn load_saved_themes() -> Vec<SavedTheme> {
    let dir = match themes_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!(
                "wezterminator patch 0038: cannot resolve themes dir: {:#}",
                e
            );
            return Vec::new();
        }
    };
    let read_dir = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) => {
            log::warn!(
                "wezterminator patch 0038: cannot read themes dir {}: {}",
                dir.display(),
                e
            );
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<SavedTheme>(&bytes) {
                Ok(theme) => out.push(theme),
                Err(e) => {
                    log::warn!(
                        "wezterminator patch 0038: skipping unparseable theme {}: {}",
                        path.display(),
                        e
                    );
                }
            },
            Err(e) => {
                log::warn!(
                    "wezterminator patch 0038: skipping unreadable theme {}: {}",
                    path.display(),
                    e
                );
            }
        }
    }
    // Deterministic order so the config-app grid is stable.
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Load a saved theme by id and build a real `ColorPalette` from
/// its hex strings. Reuses `vscode_theme::palette256` /
/// `ansi_16` so the 240-cube + 24-grey indexed colours match the
/// baked-in themes. Returns `None` if no theme with that id exists
/// or its colours cannot be parsed.
///
/// Per patch 0027 (dark-theme cursor fix): `cursor_bg` is set to the
/// theme's `cursor` colour (NOT the background), so the
/// BlinkingBlock cursor stays visible on dark themes.
pub fn palette_for_saved(id: &str) -> Option<ColorPalette> {
    let theme = load_saved_themes().into_iter().find(|t| t.id == id)?;
    palette_from_saved(&theme)
}

/// Build a `ColorPalette` from an in-memory `SavedTheme`. Split out
/// of `palette_for_saved` so it is unit-testable without touching
/// the filesystem.
pub fn palette_from_saved(theme: &SavedTheme) -> Option<ColorPalette> {
    let mut ansi: [SrgbaTuple; 16] = [SrgbaTuple(0.0, 0.0, 0.0, 1.0); 16];
    for (i, hex) in theme.ansi.iter().enumerate() {
        ansi[i] = parse_hex(hex)?;
    }
    // Split into normal[0..8] + bright[8..16] for `ansi_16` (which
    // gives us back the same 16-array; we route through it so any
    // future tweak to the ANSI layout stays in one place).
    let mut normal: [SrgbaTuple; 8] = [SrgbaTuple(0.0, 0.0, 0.0, 1.0); 8];
    let mut bright: [SrgbaTuple; 8] = [SrgbaTuple(0.0, 0.0, 0.0, 1.0); 8];
    normal.copy_from_slice(&ansi[0..8]);
    bright.copy_from_slice(&ansi[8..16]);
    let ansi16 = crate::vscode_theme::ansi_16(normal, bright);

    let fg = parse_hex(&theme.foreground)?;
    let bg = parse_hex(&theme.background)?;
    let cursor = parse_hex(&theme.cursor)?;
    // Re-derive selection colours for older cached themes that still
    // carry the old foreground/background copy. New downloads already
    // store derived values from `derive_selection_colors`.
    let (sel_fg, sel_bg) = derive_selection_colors(&theme.foreground, &theme.background);
    let sel_fg = parse_hex(&sel_fg).unwrap_or(fg);
    let sel_bg = parse_hex(&sel_bg).unwrap_or(bg);

    Some(ColorPalette {
        colors: crate::vscode_theme::palette256(ansi16),
        foreground: fg,
        background: bg,
        // Patch 0027: cursor_bg must equal the cursor colour (not
        // the background) so the BlinkingBlock cursor is visible on
        // dark themes. cursor_fg is also the cursor colour (the
        // glyph under the block reads against bg via the block fill).
        cursor_fg: cursor,
        cursor_bg: cursor,
        cursor_border: cursor,
        selection_fg: sel_fg,
        selection_bg: sel_bg,
        scrollbar_thumb: SrgbaTuple(0.31, 0.31, 0.31, 1.0),
        split: SrgbaTuple(0.31, 0.31, 0.31, 1.0),
    })
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgba_to_hex_round_trip() {
        assert_eq!(srgba_to_hex(SrgbaTuple(0.0, 0.0, 0.0, 1.0)), "#000000");
        assert_eq!(srgba_to_hex(SrgbaTuple(1.0, 1.0, 1.0, 1.0)), "#ffffff");
        assert_eq!(srgba_to_hex(SrgbaTuple(1.0, 0.0, 0.0, 1.0)), "#ff0000");
    }

    #[test]
    fn derive_selection_colors_never_matches_background() {
        // Dark theme: foreground #c0caf5 on background #1a1b26.
        let (fg, bg) = derive_selection_colors("#c0caf5", "#1a1b26");
        assert_eq!(fg, "#c0caf5");
        assert_ne!(bg, "#1a1b26"); // must not be invisible
        assert_ne!(bg, "#c0caf5"); // should not be the text colour either

        // Light theme: foreground #000000 on background #ffffff.
        let (fg, bg) = derive_selection_colors("#000000", "#ffffff");
        assert_eq!(fg, "#000000");
        assert_ne!(bg, "#ffffff");
        assert_ne!(bg, "#000000");
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Tokyo Night"), "tokyo-night");
        assert_eq!(slugify("Dracula"), "dracula");
        assert_eq!(slugify("Solarized (dark)"), "solarized-dark");
        assert_eq!(slugify("One Dark"), "one-dark");
        assert_eq!(slugify("Gruvbox Dark Hard"), "gruvbox-dark-hard");
    }

    #[test]
    fn slugify_collapses_and_trims() {
        assert_eq!(slugify("  Catppuccin   Mocha  "), "catppuccin-mocha");
        assert_eq!(slugify("Ayu - Mirage!!!"), "ayu-mirage");
        assert_eq!(slugify("3024 Night"), "3024-night");
        // Leading digits/letters preserved; punctuation-only -> empty.
        assert_eq!(slugify("***"), "");
        assert_eq!(slugify(""), "");
    }

    #[test]
    fn slugify_handles_unicode_by_dropping() {
        // Non-ASCII alphanumerics are dropped (treated as
        // separators) so the id stays filename-safe.
        assert_eq!(slugify("Café Noir"), "caf-noir");
    }

    #[test]
    fn parse_hex_six_digit() {
        assert_eq!(parse_hex("#000000"), Some(SrgbaTuple(0.0, 0.0, 0.0, 1.0)));
        assert_eq!(parse_hex("#ffffff"), Some(SrgbaTuple(1.0, 1.0, 1.0, 1.0)));
        assert_eq!(
            parse_hex("#ff0000"),
            Some(SrgbaTuple(1.0, 0.0, 0.0, 1.0))
        );
        // Case-insensitive + surrounding whitespace tolerated.
        assert_eq!(parse_hex("  #00FF00 "), Some(SrgbaTuple(0.0, 1.0, 0.0, 1.0)));
    }

    #[test]
    fn parse_hex_three_digit() {
        // `#abc` expands to `#aabbcc`.
        assert_eq!(parse_hex("#000"), Some(SrgbaTuple(0.0, 0.0, 0.0, 1.0)));
        assert_eq!(parse_hex("#fff"), Some(SrgbaTuple(1.0, 1.0, 1.0, 1.0)));
    }

    #[test]
    fn parse_hex_rejects_bad_input() {
        assert_eq!(parse_hex(""), None);
        assert_eq!(parse_hex("000000"), None); // no leading '#'
        assert_eq!(parse_hex("#12"), None); // wrong length
        assert_eq!(parse_hex("#xyzxyz"), None); // non-hex digits
        assert_eq!(parse_hex("#1234567"), None); // too long
    }

    #[test]
    fn saved_theme_json_round_trip() {
        let ansi: [String; 16] = std::array::from_fn(|i| {
            format!("#{:02x}{:02x}{:02x}", i * 16, i * 8, i * 4)
        });
        let theme = SavedTheme {
            id: "tokyo-night".to_string(),
            name: "Tokyo Night".to_string(),
            ansi,
            foreground: "#c0caf5".to_string(),
            background: "#1a1b26".to_string(),
            cursor: "#c0caf5".to_string(),
            selection_fg: "#c0caf5".to_string(),
            selection_bg: "#283457".to_string(),
        };
        let json = serde_json::to_string_pretty(&theme).unwrap();
        assert!(json.contains("\"id\": \"tokyo-night\""));
        assert!(json.contains("\"name\": \"Tokyo Night\""));
        let parsed: SavedTheme = serde_json::from_str(&json).unwrap();
        assert_eq!(theme, parsed);
    }

    #[test]
    fn palette_from_saved_builds_a_palette() {
        // A minimal but valid Tokyo-Night-ish theme.
        let ansi: [String; 16] = [
            "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7",
            "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68",
            "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
        ]
        .map(String::from);
        let theme = SavedTheme {
            id: "tokyo-night".to_string(),
            name: "Tokyo Night".to_string(),
            ansi,
            foreground: "#c0caf5".to_string(),
            background: "#1a1b26".to_string(),
            cursor: "#c0caf5".to_string(),
            selection_fg: "#c0caf5".to_string(),
            selection_bg: "#283457".to_string(),
        };
        let palette = palette_from_saved(&theme).expect("palette builds");
        // 256 colours total.
        assert_eq!(palette.colors.0.len(), 256);
        // ANSI[0] == #15161e
        assert_eq!(palette.colors.0[0], parse_hex("#15161e").unwrap());
        // Patch 0027: cursor_bg == cursor (NOT background).
        assert_eq!(palette.cursor_bg, parse_hex("#c0caf5").unwrap());
        assert_ne!(palette.cursor_bg, palette.background);
        assert_eq!(palette.background, parse_hex("#1a1b26").unwrap());
        // The saved selection_bg is re-derived from background + bright blue
        // so older/cached themes still get a visible highlight.
        assert_ne!(palette.selection_bg, palette.background);
        assert_ne!(palette.selection_bg, palette.foreground);
    }

    #[test]
    fn palette_from_saved_rejects_bad_hex() {
        let ansi: [String; 16] = std::array::from_fn(|_| "#000000".to_string());
        let mut theme = SavedTheme {
            id: "broken".to_string(),
            name: "Broken".to_string(),
            ansi,
            foreground: "not-a-color".to_string(),
            background: "#1a1b26".to_string(),
            cursor: "#c0caf5".to_string(),
            selection_fg: "#c0caf5".to_string(),
            selection_bg: "#283457".to_string(),
        };
        assert!(palette_from_saved(&theme).is_none());
        // Fix the foreground; now it builds.
        theme.foreground = "#c0caf5".to_string();
        assert!(palette_from_saved(&theme).is_some());
    }

    #[test]
    fn gogh_entry_parses_and_converts() {
        // A single Gogh entry (the real schema). Verifies our serde
        // struct matches the catalog field names WITHOUT hitting the
        // network.
        let json = r##"[{
            "name": "Tokyo Night",
            "color_01": "#15161e",
            "color_02": "#f7768e",
            "color_03": "#9ece6a",
            "color_04": "#e0af68",
            "color_05": "#7aa2f7",
            "color_06": "#bb9af7",
            "color_07": "#7dcfff",
            "color_08": "#a9b1d6",
            "color_09": "#414868",
            "color_10": "#f7768e",
            "color_11": "#9ece6a",
            "color_12": "#e0af68",
            "color_13": "#7aa2f7",
            "color_14": "#bb9af7",
            "color_15": "#7dcfff",
            "color_16": "#c0caf5",
            "foreground": "#c0caf5",
            "background": "#1a1b26",
            "cursor": "#c0caf5"
        }]"##;
        let entries: Vec<GoghEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        let saved = entries.into_iter().next().unwrap().into_saved().unwrap();
        assert_eq!(saved.id, "tokyo-night");
        assert_eq!(saved.name, "Tokyo Night");
        assert_eq!(saved.ansi[0], "#15161e");
        assert_eq!(saved.ansi[15], "#c0caf5");
        assert_eq!(saved.foreground, "#c0caf5");
        assert_eq!(saved.background, "#1a1b26");
        assert_eq!(saved.cursor, "#c0caf5");
        // Gogh has no per-theme selection colour; we derive one from
        // background + bright blue so the selection is visible.
        assert_eq!(saved.selection_fg, "#c0caf5");
        assert_ne!(saved.selection_bg, "#1a1b26");
        assert_ne!(saved.selection_bg, "#c0caf5");
        // And it builds a palette.
        assert!(palette_from_saved(&saved).is_some());
    }
}
