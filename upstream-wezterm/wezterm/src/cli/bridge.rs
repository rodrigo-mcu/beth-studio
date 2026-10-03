//! BethTerm (patch 0171): `bethterm cli bridge` — a long-lived mux client
//! that speaks JSON lines on stdin/stdout, for the web front end
//! (`bethterm-web`, Go + React). One request per stdin line, one event
//! per stdout line.
//!
//! Requests:
//!   {"op":"list"}
//!   {"op":"watch","pane_id":N}      screen events for N (replaces the set)
//!   {"op":"watch","pane_ids":[N,M]} several panes
//!   {"op":"send","pane_id":N,"data":"..."}   raw bytes to the PTY
//!   {"op":"paste","pane_id":N,"data":"..."}  bracketed paste
//!   {"op":"spawn_tool","kind":"ssh"|"serial","id":"<16 hex>","window_id":W?,
//!    "request_id":"..."?}   start `bethterm-tool.exe --ssh|--serial <id>`
//!       from this exe's folder as a new terminal (patch 0184). The pane
//!       is created in workspace "beth-studio", not in the GUI's window
//!       (patch 0190); window_id is accepted and ignored.
//!   {"op":"shells"}                          the GUI's "new terminal" list
//!   {"op":"spawn","shell_id":"powershell","window_id":W?,"cwd":"..."?,
//!    "request_id":"..."?}   start a terminal in the host (patch 0176);
//!       with window_id it becomes a new tab of that host window
//!   {"op":"separate","pane_id":N}   move the pane out of its host split
//!       into a new tab of the same host window (patch 0182), so the web
//!       UI may resize it; answers {"ev":"separated",...}
//!   {"op":"kill","pane_id":N}   close the terminal in the host (patch
//!       0180); the front end must have asked the user to confirm
//!   {"op":"resize","pane_id":N,"cols":C,"rows":R}   resize the host pane
//!       (patch 0178); refused unless the pane is alone in its host tab
//!   {"op":"scrollback","pane_id":N,"request_id":"..."?}  full scrollback
//!       + viewport as plain text (patch 0188); answers
//!       {"ev":"scrollback","request_id":"...","pane_id":N,"text":"..."}
//!   {"op":"palette","pane_id":N,"background":"#fff","foreground":"#111",
//!    "cursor":"#..."?,"ansi":["#000",...16]?}  Studio theme → OSC 10/11
//!       (patch 0189) so Codex/Cursor detect light themes
//!
//! Events:
//!   {"ev":"list","panes":[...same items as `cli list --format json`...]}
//!   {"ev":"screen","pane_id":N,"cols":C,"rows":R,"cursor_x":X,
//!    "cursor_y":Y,"cursor_visible":B,"offset":K,"scrollback":S,
//!    "text":"<escapes>"}
//!   `offset` is the scroll offset actually shown (clamped); `scrollback`
//!   is how many lines exist above the live screen.
//!   {"ev":"agent","pane_id":N,"waiting":B,"reason":"bell|toast|user_var",
//!    "detail":"..."}   an agent in the pane waits for the user (patch 0175)
//!   {"ev":"shells","shells":[{"id":"powershell","label":"PowerShell 5.1"}]}
//!   {"ev":"spawned","request_id":"...","pane_id":N,"tab_id":T,"window_id":W}
//!   {"ev":"pane_gone","pane_id":N}   a watched pane no longer exists
//!       (closed); it is dropped from the watched set (patch 0179)
//!   {"ev":"scrollback","request_id":"...","pane_id":N,"text":"..."}
//!       plain-text dump of scrollback+viewport (patch 0188)
//!   {"ev":"error","message":"..."}
//!
//! The bridge always connects to the host (`--prefer-mux` is implied), so
//! a GUI restart does not affect it. If the host connection is lost it
//! exits with a non-zero code; the front end should start a new one.
//!
//! `text` is the visible screen as SGR escapes, rows joined by CRLF,
//! without a trailing newline: write "\x1b[H\x1b[2J" + text, then move
//! the cursor. A screen event is sent only when the pane changed.

use clap::Parser;
use mux::pane::PaneId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, Write};
use std::time::Duration;
use termwiz::surface::CursorVisibility;
use termwiz_funcs::lines_to_escapes;
use wezterm_client::client::Client;
use wezterm_term::StableRowIndex;

/// How often the watched panes are checked for changes.
const POLL: Duration = Duration::from_millis(30);
/// While a key waits for its echo, poll faster so the echo latency meter
/// (patch 0177) and the user both see it sooner.
const POLL_ECHO: Duration = Duration::from_millis(4);
/// A key with no screen change after this long counts as this long.
const ECHO_GIVE_UP: Duration = Duration::from_secs(3);
/// One summary per pane per minute of typing.
const ECHO_REPORT_EVERY: Duration = Duration::from_secs(30);

/// Patch 0177: key -> visible screen change, per pane, measured at the
/// bridge (so it covers host + PTY/ConPTY + the program itself, and
/// nothing of the GUI or the browser).
#[derive(Default)]
struct EchoMeter {
    pending: HashMap<PaneId, std::time::Instant>,
    samples: HashMap<PaneId, Vec<u32>>,
    rpc_max_ms: u32,
    since: Option<std::time::Instant>,
    titles: HashMap<PaneId, String>,
}

impl EchoMeter {
    fn key_sent(&mut self, pane_id: PaneId) {
        self.pending
            .entry(pane_id)
            .or_insert_with(std::time::Instant::now);
        self.since.get_or_insert_with(std::time::Instant::now);
    }

    fn screen_changed(&mut self, pane_id: PaneId) {
        if let Some(at) = self.pending.remove(&pane_id) {
            self.samples
                .entry(pane_id)
                .or_default()
                .push(at.elapsed().as_millis() as u32);
        }
    }

    fn expire(&mut self) {
        let expired: Vec<PaneId> = self
            .pending
            .iter()
            .filter(|(_, at)| at.elapsed() >= ECHO_GIVE_UP)
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            self.pending.remove(&id);
            self.samples
                .entry(id)
                .or_default()
                .push(ECHO_GIVE_UP.as_millis() as u32);
        }
    }

    fn report_if_due(&mut self) {
        let Some(since) = self.since else { return };
        if since.elapsed() < ECHO_REPORT_EVERY {
            return;
        }
        self.report_now();
    }

    /// Write what was measured so far (also on exit, so a short session
    /// is not lost).
    fn report_now(&mut self) {
        self.since = None;
        let rpc_max = std::mem::take(&mut self.rpc_max_ms);
        let mut lines = String::new();
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        for (pane_id, mut v) in self.samples.drain() {
            if v.is_empty() {
                continue;
            }
            v.sort_unstable();
            let pick = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
            let slow = v.iter().filter(|&&x| x >= 100).count();
            let title = self.titles.get(&pane_id).map(|s| s.as_str()).unwrap_or("");
            lines.push_str(&format!(
                "{stamp} pid={} pane={pane_id} keys={} echo[p50={} p95={} max={} >=100ms={slow}] host_rpc_max={rpc_max} title={title:?}
",
                std::process::id(),
                v.len(),
                pick(0.5),
                pick(0.95),
                v[v.len() - 1],
            ));
        }
        if lines.is_empty() {
            return;
        }
        let Ok(dir) = wtinator::session::session_dir() else {
            return;
        };
        let path = dir.join("bridge-latency.log");
        if std::fs::metadata(&path).map_or(false, |m| m.len() > 1024 * 1024) {
            let _ = std::fs::rename(&path, dir.join("bridge-latency.1.log"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(lines.as_bytes());
        }
    }
}
/// The pane list is re-sent at most this often when it changes.
const LIST_EVERY: Duration = Duration::from_secs(2);

#[derive(Debug, Parser, Clone)]
pub struct Bridge {}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    List,
    Watch {
        #[serde(default)]
        pane_id: Option<PaneId>,
        #[serde(default)]
        pane_ids: Vec<PaneId>,
    },
    Send {
        pane_id: PaneId,
        data: String,
    },
    Paste {
        pane_id: PaneId,
        data: String,
    },
    Scroll {
        pane_id: PaneId,
        offset: usize,
    },
    /// Patch 0188: plain-text scrollback + viewport for Studio save/copy.
    Scrollback {
        pane_id: PaneId,
        #[serde(default)]
        request_id: Option<String>,
    },
    /// Patch 0189: push the Studio theme so agents (Codex, Cursor) see
    /// light themes via OSC 10/11. The host stores this as the client palette.
    Palette {
        pane_id: PaneId,
        background: String,
        foreground: String,
        #[serde(default)]
        cursor: String,
        /// ANSI 0–15, same order as the Studio theme.
        #[serde(default)]
        ansi: Vec<String>,
    },
    Resize {
        pane_id: PaneId,
        cols: usize,
        rows: usize,
    },
    Kill {
        pane_id: PaneId,
    },
    Separate {
        pane_id: PaneId,
    },
    Shells,
    /// Patch 0184: start a companion tool (SSH or serial session) that
    /// lives next to this exe, as `bethterm-tool.exe --ssh|--serial <id>`.
    SpawnTool {
        kind: String,
        id: String,
        #[serde(default)]
        window_id: Option<mux::window::WindowId>,
        #[serde(default)]
        request_id: Option<String>,
    },
    Spawn {
        shell_id: String,
        #[serde(default)]
        window_id: Option<mux::window::WindowId>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        request_id: Option<String>,
    },
}

#[derive(Serialize)]
struct ShellInfo {
    id: &'static str,
    label: &'static str,
}

#[derive(Serialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
enum Event<'a> {
    List {
        panes: &'a [super::list::CliListResultItem],
    },
    Screen {
        pane_id: PaneId,
        cols: usize,
        rows: usize,
        cursor_x: usize,
        cursor_y: i64,
        cursor_visible: bool,
        offset: usize,
        scrollback: usize,
        text: &'a str,
    },
    Error {
        message: &'a str,
    },
    PaneGone {
        pane_id: PaneId,
    },
    Separated {
        pane_id: PaneId,
        tab_id: mux::tab::TabId,
        window_id: mux::window::WindowId,
    },
    Shells {
        shells: &'a [ShellInfo],
    },
    Spawned {
        request_id: &'a str,
        pane_id: PaneId,
        tab_id: mux::tab::TabId,
        window_id: mux::window::WindowId,
    },
    /// BethTerm (patch 0188): full scrollback as plain text.
    Scrollback {
        request_id: &'a str,
        pane_id: PaneId,
        text: &'a str,
    },
    /// BethTerm (patch 0175): an agent in the pane waits (or stopped
    /// waiting) for the user. Same rule as the GUI tab bar (patch 0152).
    Agent {
        pane_id: PaneId,
        waiting: bool,
        reason: &'a str,
        detail: &'a str,
    },
}

/// Alerts from the host, forwarded by the client's unilateral hook.
fn alert_channel() -> &'static (
    smol::channel::Sender<(PaneId, wezterm_term::Alert)>,
    smol::channel::Receiver<(PaneId, wezterm_term::Alert)>,
) {
    static CHANNEL: std::sync::OnceLock<(
        smol::channel::Sender<(PaneId, wezterm_term::Alert)>,
        smol::channel::Receiver<(PaneId, wezterm_term::Alert)>,
    )> = std::sync::OnceLock::new();
    CHANNEL.get_or_init(smol::channel::unbounded)
}

fn on_unilateral(pdu: &codec::Pdu) {
    if let codec::Pdu::NotifyAlert(codec::NotifyAlert { pane_id, alert }) = pdu {
        let _ = alert_channel().0.try_send((*pane_id, alert.clone()));
    }
}

/// Map a host alert to (waiting, reason, detail); None = not about waiting.
fn waiting_from_alert(alert: &wezterm_term::Alert) -> Option<(bool, &'static str, String)> {
    use wezterm_term::Alert;
    match alert {
        Alert::Bell => Some((true, "bell", String::new())),
        Alert::ToastNotification { title, body, .. } => Some((
            true,
            "toast",
            match title {
                Some(t) if !t.is_empty() => format!("{t}: {body}"),
                _ => body.clone(),
            },
        )),
        Alert::SetUserVar { name, value } => {
            let lname = name.to_ascii_lowercase();
            let is_agent_var = lname == "claude_status"
                || lname.ends_with("_status")
                || lname.ends_with("_waiting");
            if !is_agent_var {
                return None;
            }
            let waiting = wtinator::agent_wait::user_var_is_waiting(name, value);
            Some((waiting, "user_var", format!("{name}={value}")))
        }
        _ => None,
    }
}

fn emit(ev: &Event) {
    let mut out = std::io::stdout().lock();
    if serde_json::to_writer(&mut out, ev).is_ok() {
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

fn emit_error(message: &str) {
    emit(&Event::Error { message });
}

impl Bridge {
    pub async fn run(self, client: Client) -> anyhow::Result<()> {
        let _ = wezterm_client::client::BETHTERM_UNILATERAL.set(on_unilateral);
        let alerts = alert_channel().1.clone();
        // Panes with an agent waiting: reason + detail, re-sent on `list`.
        let mut waiting: HashMap<PaneId, (&'static str, String)> = HashMap::new();
        let (tx, rx) = smol::channel::unbounded::<Option<String>>();
        std::thread::Builder::new()
            .name("bethterm-bridge-stdin".into())
            .spawn(move || {
                let stdin = std::io::stdin();
                for line in stdin.lock().lines() {
                    match line {
                        Ok(line) => {
                            if tx.send_blocking(Some(line)).is_err() {
                                return;
                            }
                        }
                        Err(_) => break,
                    }
                }
                // stdin closed: the front end went away.
                let _ = tx.send_blocking(None);
            })?;

        let mut watched: BTreeSet<PaneId> = BTreeSet::new();
        let mut last_screen: HashMap<PaneId, u64> = HashMap::new();
        // Desired lines-above-live from the last scroll op; consumed on the
        // next screen fetch to (re)pin `anchors`.
        let mut pending_scroll: HashMap<PaneId, usize> = HashMap::new();
        // Pinned top stable row while the user is scrolled back. Keeps the
        // same history lines on screen when the live pane dumps new frames
        // into scrollback (fullscreen TUIs like Claude Code).
        let mut anchors: HashMap<PaneId, StableRowIndex> = HashMap::new();
        let mut last_list: Option<u64> = None;
        let mut list_due = std::time::Instant::now();
        let mut echo = EchoMeter::default();
        // pane -> (host tab, panes in that tab), from the last list.
        let mut tab_of: HashMap<PaneId, (mux::tab::TabId, usize)> = HashMap::new();

        loop {
            let poll = if echo.pending.is_empty() { POLL } else { POLL_ECHO };
            let next = smol::future::or(async { Some(rx.recv().await.ok().flatten()) }, async {
                smol::Timer::after(poll).await;
                None
            })
            .await;

            match next {
                // stdin closed
                Some(None) => {
                    echo.expire();
                    echo.report_now();
                    return Ok(());
                }
                Some(Some(line)) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Request>(line) {
                        Err(err) => emit_error(&format!("bad request: {err}")),
                        Ok(Request::List) => {
                            last_list = None;
                            list_due = std::time::Instant::now();
                            for (pane_id, (reason, detail)) in &waiting {
                                emit(&Event::Agent {
                                    pane_id: *pane_id,
                                    waiting: true,
                                    reason,
                                    detail,
                                });
                            }
                        }
                        Ok(Request::Watch { pane_id, pane_ids }) => {
                            watched = pane_ids.into_iter().chain(pane_id).collect();
                            // Force a fresh screen for every watched pane.
                            last_screen.clear();
                        }
                        Ok(Request::Shells) => {
                            let shells: Vec<ShellInfo> = wtinator::context_menu::default_shells()
                                .into_iter()
                                .map(|s| ShellInfo {
                                    id: s.id,
                                    label: s.label,
                                })
                                .collect();
                            emit(&Event::Shells { shells: &shells });
                        }
                        Ok(Request::SpawnTool {
                            kind,
                            id,
                            window_id,
                            request_id,
                        }) => {
                            let request_id = request_id.unwrap_or_default();
                            match spawn_tool(&client, &kind, &id, window_id).await {
                                Ok(spawned) => {
                                    emit(&Event::Spawned {
                                        request_id: &request_id,
                                        pane_id: spawned.pane_id,
                                        tab_id: spawned.tab_id,
                                        window_id: spawned.window_id,
                                    });
                                    last_list = None;
                                    list_due = std::time::Instant::now();
                                }
                                Err(err) => emit_error(&format!(
                                    "spawn_tool {kind} (request {request_id}): {err:#}"
                                )),
                            }
                        }
                        Ok(Request::Spawn {
                            shell_id,
                            window_id,
                            cwd,
                            request_id,
                        }) => {
                            let request_id = request_id.unwrap_or_default();
                            match spawn_shell(&client, &shell_id, window_id, cwd).await {
                                Ok(spawned) => {
                                    emit(&Event::Spawned {
                                        request_id: &request_id,
                                        pane_id: spawned.pane_id,
                                        tab_id: spawned.tab_id,
                                        window_id: spawned.window_id,
                                    });
                                    // Show it in the next list right away.
                                    last_list = None;
                                    list_due = std::time::Instant::now();
                                }
                                Err(err) => emit_error(&format!(
                                    "spawn {shell_id} (request {request_id}): {err:#}"
                                )),
                            }
                        }
                        Ok(Request::Separate { pane_id }) => {
                            match tab_of.get(&pane_id) {
                                None => emit_error(&format!("separate: unknown pane {pane_id}")),
                                Some((_, 1)) => emit_error(&format!(
                                    "separate: pane {pane_id} is already alone in its BethTerm tab"
                                )),
                                Some(_) => {
                                    let window_id = super::list::collect_items(&client)
                                        .await
                                        .ok()
                                        .and_then(|items| {
                                            items
                                                .into_iter()
                                                .find(|i| i.pane_id == pane_id)
                                                .map(|i| i.window_id)
                                        });
                                    match client
                                        .move_pane_to_new_tab(codec::MovePaneToNewTab {
                                            pane_id,
                                            window_id,
                                            workspace_for_new_window: None,
                                        })
                                        .await
                                    {
                                        Ok(r) => emit(&Event::Separated {
                                            pane_id,
                                            tab_id: r.tab_id,
                                            window_id: r.window_id,
                                        }),
                                        Err(err) => emit_error(&format!(
                                            "separate pane {pane_id}: {err:#}"
                                        )),
                                    }
                                    last_list = None;
                                    list_due = std::time::Instant::now();
                                }
                            }
                        }
                        Ok(Request::Kill { pane_id }) => {
                            if let Err(err) =
                                client.kill_pane(codec::KillPane { pane_id }).await
                            {
                                emit_error(&format!("kill pane {pane_id}: {err:#}"));
                            }
                            // The pane disappears from the next list; watch
                            // reports `pane_gone` (patch 0179).
                            last_list = None;
                            list_due = std::time::Instant::now();
                        }
                        Ok(Request::Resize {
                            pane_id,
                            cols,
                            rows,
                        }) => match tab_of.get(&pane_id) {
                            None => emit_error(&format!("resize: unknown pane {pane_id}")),
                            // Resizing one pane of a host split re-lays the
                            // host tree and can squeeze its neighbours (see
                            // patches 0163/0172): refuse.
                            Some((_, n)) if *n > 1 => emit_error(&format!(
                                "resize: pane {pane_id} shares its BethTerm tab with {} other pane(s)",
                                n - 1
                            )),
                            Some((tab_id, _)) => {
                                let cols = cols.clamp(10, 500);
                                let rows = rows.clamp(4, 300);
                                if let Err(err) = resize_pane(&client, pane_id, *tab_id, cols, rows).await
                                {
                                    emit_error(&format!("resize pane {pane_id}: {err:#}"));
                                }
                                last_screen.remove(&pane_id);
                            }
                        },
                        Ok(Request::Scroll { pane_id, offset }) => {
                            if offset == 0 {
                                pending_scroll.remove(&pane_id);
                                anchors.remove(&pane_id);
                            } else {
                                pending_scroll.insert(pane_id, offset);
                            }
                            last_screen.remove(&pane_id);
                        }
                        Ok(Request::Scrollback {
                            pane_id,
                            request_id,
                        }) => {
                            let request_id = request_id.unwrap_or_default();
                            match scrollback_text(&client, pane_id).await {
                                Ok(text) => emit(&Event::Scrollback {
                                    request_id: &request_id,
                                    pane_id,
                                    text: &text,
                                }),
                                Err(err) => emit_error(&format!(
                                    "scrollback pane {pane_id} (request {request_id}): {err:#}"
                                )),
                            }
                        }
                        Ok(Request::Palette {
                            pane_id,
                            background,
                            foreground,
                            cursor,
                            ansi,
                        }) => {
                            if let Err(err) = apply_agent_palette(
                                &client,
                                pane_id,
                                &background,
                                &foreground,
                                &cursor,
                                &ansi,
                            )
                            .await
                            {
                                emit_error(&format!("palette pane {pane_id}: {err:#}"));
                            }
                        }
                        Ok(Request::Send { pane_id, data }) => {
                            if pending_scroll.remove(&pane_id).is_some()
                                || anchors.remove(&pane_id).is_some()
                            {
                                last_screen.remove(&pane_id);
                            }
                            // The user answered: like focusing the pane in the GUI.
                            if waiting.remove(&pane_id).is_some() {
                                emit(&Event::Agent {
                                    pane_id,
                                    waiting: false,
                                    reason: "input",
                                    detail: "",
                                });
                            }
                            if watched.contains(&pane_id) {
                                echo.key_sent(pane_id);
                            }
                            if let Err(err) = client
                                .write_to_pane(codec::WriteToPane {
                                    pane_id,
                                    data: data.into_bytes(),
                                })
                                .await
                            {
                                emit_error(&format!("send to pane {pane_id}: {err:#}"));
                            }
                        }
                        Ok(Request::Paste { pane_id, data }) => {
                            if pending_scroll.remove(&pane_id).is_some()
                                || anchors.remove(&pane_id).is_some()
                            {
                                last_screen.remove(&pane_id);
                            }
                            if let Err(err) =
                                client.send_paste(codec::SendPaste { pane_id, data }).await
                            {
                                emit_error(&format!("paste to pane {pane_id}: {err:#}"));
                            }
                        }
                    }
                }
                // poll tick
                None => {}
            }

            while let Ok((pane_id, alert)) = alerts.try_recv() {
                let Some((is_waiting, reason, detail)) = waiting_from_alert(&alert) else {
                    continue;
                };
                let changed = if is_waiting {
                    waiting.insert(pane_id, (reason, detail.clone())).is_none()
                        || reason == "toast"
                } else {
                    waiting.remove(&pane_id).is_some()
                };
                if changed {
                    emit(&Event::Agent {
                        pane_id,
                        waiting: is_waiting,
                        reason,
                        detail: &detail,
                    });
                }
            }

            if std::time::Instant::now() >= list_due {
                list_due = std::time::Instant::now() + LIST_EVERY;
                match super::list::collect_items(&client).await {
                    Ok(items) => {
                        echo.titles = items
                            .iter()
                            .map(|i| (i.pane_id, i.title.clone()))
                            .collect();
                        let mut per_tab: HashMap<mux::tab::TabId, usize> = HashMap::new();
                        for i in &items {
                            *per_tab.entry(i.tab_id).or_default() += 1;
                        }
                        tab_of = items
                            .iter()
                            .map(|i| (i.pane_id, (i.tab_id, per_tab[&i.tab_id])))
                            .collect();
                        // Patch 0181: a bell/toast only says "look here"; Claude
                        // rings when a turn ends even while its background
                        // agents keep working. When the title shows the agent
                        // is working again (spinner glyph), clear that wait.
                        // User-var waits (`claude_status=...`) are left alone:
                        // the hook sets them back explicitly.
                        for i in &items {
                            let working = i
                                .title
                                .trim_start()
                                .starts_with(['◐', '◑', '◒', '◓']);
                            let soft = matches!(
                                waiting.get(&i.pane_id),
                                Some((reason, _)) if *reason == "bell" || *reason == "toast"
                            );
                            if working && soft {
                                waiting.remove(&i.pane_id);
                                emit(&Event::Agent {
                                    pane_id: i.pane_id,
                                    waiting: false,
                                    reason: "working",
                                    detail: "",
                                });
                            }
                        }
                        let json = serde_json::to_string(&items).unwrap_or_default();
                        let h = hash_of(&json);
                        if last_list != Some(h) {
                            last_list = Some(h);
                            emit(&Event::List { panes: &items });
                        }
                    }
                    Err(err) => {
                        // The mux connection is gone (host restarted, socket
                        // closed): exit non-zero so the front end respawns us.
                        emit_error(&format!("list: {err:#}"));
                        anyhow::bail!("lost the mux connection: {err:#}");
                    }
                }
            }

            let mut gone: Vec<PaneId> = Vec::new();
            for &pane_id in &watched {
                let want = pending_scroll.remove(&pane_id);
                let pin = anchors.get(&pane_id).copied();
                let rpc_start = std::time::Instant::now();
                let result = screen_of(&client, pane_id, want, pin).await;
                echo.rpc_max_ms = echo
                    .rpc_max_ms
                    .max(rpc_start.elapsed().as_millis() as u32);
                match result {
                    Ok(screen) => {
                        if screen.offset == 0 {
                            anchors.remove(&pane_id);
                        } else {
                            anchors.insert(pane_id, screen.top);
                        }
                        let h = hash_of(&screen);
                        if last_screen.get(&pane_id) != Some(&h) {
                            last_screen.insert(pane_id, h);
                            echo.screen_changed(pane_id);
                            emit(&Event::Screen {
                                pane_id,
                                cols: screen.cols,
                                rows: screen.rows,
                                cursor_x: screen.cursor_x,
                                cursor_y: screen.cursor_y,
                                cursor_visible: screen.cursor_visible,
                                offset: screen.offset,
                                scrollback: screen.scrollback,
                                text: &screen.text,
                            });
                        }
                    }
                    Err(err) => {
                        // A closed pane is not an error (patch 0179): the
                        // host answers "no such pane"; stop watching it.
                        if format!("{err:#}").contains("no such pane") {
                            gone.push(pane_id);
                        } else if last_screen.insert(pane_id, 0) != Some(0) {
                            // Report once per failure streak.
                            emit_error(&format!("screen of pane {pane_id}: {err:#}"));
                        }
                    }
                }
            }
            for pane_id in gone {
                watched.remove(&pane_id);
                last_screen.remove(&pane_id);
                pending_scroll.remove(&pane_id);
                anchors.remove(&pane_id);
                echo.pending.remove(&pane_id);
                emit(&Event::PaneGone { pane_id });
                // Refresh the list now so the front end drops it too.
                last_list = None;
                list_due = std::time::Instant::now();
            }
            echo.expire();
            echo.report_if_due();
        }
    }
}

/// Resize a host pane that is alone in its tab (patch 0178). Pixel sizes
/// keep the pane's current cell size.
async fn resize_pane(
    client: &Client,
    pane_id: PaneId,
    tab_id: mux::tab::TabId,
    cols: usize,
    rows: usize,
) -> anyhow::Result<()> {
    let dims = client
        .get_dimensions(codec::GetPaneRenderableDimensions { pane_id })
        .await?
        .dimensions;
    let cell_w = dims.pixel_width.checked_div(dims.cols).unwrap_or(8).max(1);
    let cell_h = dims
        .pixel_height
        .checked_div(dims.viewport_rows)
        .unwrap_or(16)
        .max(1);
    client
        .resize(codec::Resize {
            containing_tab_id: tab_id,
            pane_id,
            size: wezterm_term::TerminalSize {
                cols,
                rows,
                pixel_width: cols * cell_w,
                pixel_height: rows * cell_h,
                dpi: dims.dpi,
            },
        })
        .await?;
    Ok(())
}

/// Start one of the GUI's shells in the host (patch 0176).
/// Patch 0184: the fixed flag for each tool kind; anything else is refused.
fn tool_flag(kind: &str) -> Option<&'static str> {
    match kind {
        "ssh" => Some("--ssh"),
        "serial" => Some("--serial"),
        _ => None,
    }
}

/// A saved-profile id: exactly 16 lowercase hex digits.
fn valid_tool_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Workspace for SSH/serial panes. The GUI only opens a window for mux
/// windows in its active workspace (`default`). Beth Studio lists every
/// pane, so the session still shows there. The tray icon belongs to the
/// GUI process and is not involved.
const STUDIO_WORKSPACE: &str = "beth-studio";

/// Start `bethterm-tool.exe --ssh|--serial <id>` (next to this exe) as a
/// new terminal in the host. The command line is built here from a fixed
/// table; the client only chooses the kind and a validated profile id.
///
/// `window_id` is ignored (patch 0190): a Studio split used to pass the
/// source pane's window, which is a visible GUI window, so the SSH tab
/// appeared there too.
async fn spawn_tool(
    client: &Client,
    kind: &str,
    id: &str,
    _window_id: Option<mux::window::WindowId>,
) -> anyhow::Result<codec::SpawnResponse> {
    let flag = tool_flag(kind).ok_or_else(|| anyhow::anyhow!("unknown tool kind {kind:?}"))?;
    anyhow::ensure!(valid_tool_id(id), "invalid profile id");
    let dir = std::env::current_exe()?
        .parent()
        .ok_or_else(|| anyhow::anyhow!("exe has no parent dir"))?
        .to_path_buf();
    let tool = dir.join("bethterm-tool.exe");
    anyhow::ensure!(
        tool.is_file(),
        "bethterm-tool.exe não encontrado em {}",
        dir.display()
    );
    let config = config::configuration();
    client
        .spawn_v2(codec::SpawnV2 {
            domain: config::keyassignment::SpawnTabDomain::DefaultDomain,
            window_id: None,
            command: Some(portable_pty::cmdbuilder::CommandBuilder::from_argv(vec![
                tool.into_os_string(),
                flag.into(),
                id.into(),
            ])),
            command_dir: None,
            size: config.initial_size(0, None),
            workspace: STUDIO_WORKSPACE.to_string(),
        })
        .await
}

#[cfg(test)]
mod tool_tests {
    use super::{tool_flag, valid_tool_id};

    #[test]
    fn only_known_kinds_and_hex_ids() {
        assert_eq!(tool_flag("ssh"), Some("--ssh"));
        assert_eq!(tool_flag("serial"), Some("--serial"));
        assert_eq!(tool_flag("cmd"), None);
        assert!(valid_tool_id("0123456789abcdef"));
        assert!(!valid_tool_id("0123456789ABCDEF"));
        assert!(!valid_tool_id("0123456789abcde"));
        assert!(!valid_tool_id("../../x&calc.exe"));
    }
}

async fn spawn_shell(
    client: &Client,
    shell_id: &str,
    window_id: Option<mux::window::WindowId>,
    cwd: Option<String>,
) -> anyhow::Result<codec::SpawnResponse> {
    let shell = wtinator::context_menu::default_shells()
        .into_iter()
        .find(|s| s.id == shell_id)
        .ok_or_else(|| anyhow::anyhow!("unknown shell id {shell_id:?}"))?;
    let config = config::configuration();
    let workspace = config
        .default_workspace
        .as_deref()
        .unwrap_or(mux::DEFAULT_WORKSPACE)
        .to_string();
    client
        .spawn_v2(codec::SpawnV2 {
            domain: config::keyassignment::SpawnTabDomain::DefaultDomain,
            window_id,
            command: Some(portable_pty::cmdbuilder::CommandBuilder::from_argv(
                shell.args.iter().map(Into::into).collect(),
            )),
            command_dir: cwd.filter(|c| !c.is_empty()),
            size: config.initial_size(0, None),
            workspace,
        })
        .await
}

#[derive(Hash)]
struct Screen {
    cols: usize,
    rows: usize,
    cursor_x: usize,
    cursor_y: i64,
    cursor_visible: bool,
    offset: usize,
    scrollback: usize,
    /// Absolute top row shown (for pinning scrollback while scrolled).
    top: StableRowIndex,
    text: String,
}

fn hash_of<T: Hash + ?Sized>(v: &T) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

/// `want_offset`: fresh scroll request (lines above live). `pin`: previously
/// pinned top row. Prefer pin so new scrollback does not slide the view.
async fn screen_of(
    client: &Client,
    pane_id: PaneId,
    want_offset: Option<usize>,
    pin: Option<StableRowIndex>,
) -> anyhow::Result<Screen> {
    let info = client
        .get_dimensions(codec::GetPaneRenderableDimensions { pane_id })
        .await?;
    let dims = info.dimensions;
    let rows = dims.viewport_rows;
    let scrollback = (dims.physical_top - dims.scrollback_top).max(0) as usize;
    let top = if let Some(offset) = want_offset {
        let offset = offset.min(scrollback);
        dims.physical_top - offset as StableRowIndex
    } else if let Some(a) = pin {
        a.max(dims.scrollback_top).min(dims.physical_top)
    } else {
        dims.physical_top
    };
    let offset = (dims.physical_top - top).max(0) as usize;
    let lines = client
        .get_lines(codec::GetLines {
            pane_id,
            lines: vec![top..top + rows as StableRowIndex],
        })
        .await?;
    let lines = lines
        .lines
        .extract_data()
        .0
        .into_iter()
        .map(|(_idx, line)| line)
        .collect();
    let mut text = lines_to_escapes(lines)?;
    // Drop the CRLF after the last row so the client does not scroll.
    if let Some(pos) = text.rfind("\r\n") {
        text.replace_range(pos..pos + 2, "");
    }
    let cursor = info.cursor_position;
    Ok(Screen {
        cols: dims.cols,
        rows,
        cursor_x: cursor.x,
        cursor_y: (cursor.y - top) as i64,
        // Scrolled back, the cursor row may be off screen: hide it.
        cursor_visible: offset == 0 && cursor.visibility == CursorVisibility::Visible,
        offset,
        scrollback,
        top,
        text,
    })
}

/// Cap how many physical rows we dump at once (very large scrollbacks).
const SCROLLBACK_MAX_ROWS: StableRowIndex = 100_000;

/// Full scrollback + viewport as plain text (patch 0188).
async fn scrollback_text(client: &Client, pane_id: PaneId) -> anyhow::Result<String> {
    let info = client
        .get_dimensions(codec::GetPaneRenderableDimensions { pane_id })
        .await?;
    let dims = info.dimensions;
    let end = dims.physical_top + dims.viewport_rows as StableRowIndex;
    let mut start = dims.scrollback_top;
    if end.saturating_sub(start) > SCROLLBACK_MAX_ROWS {
        start = end - SCROLLBACK_MAX_ROWS;
    }
    if start >= end {
        return Ok(String::new());
    }
    let lines = client
        .get_lines(codec::GetLines {
            pane_id,
            lines: vec![start..end],
        })
        .await?;
    let lines = lines.lines.extract_data().0;
    let mut out = String::new();
    for (i, (_idx, line)) in lines.into_iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&line.as_str());
    }
    Ok(out)
}

/// Tell the host pane the colours Beth Studio is showing so OSC 10/11
/// (and OSC 4) queries from Codex, Cursor, and similar CLIs match that
/// theme. Light themes were invisible because the host palette stayed dark.
async fn apply_agent_palette(
    client: &Client,
    pane_id: PaneId,
    background: &str,
    foreground: &str,
    cursor: &str,
    ansi: &[String],
) -> anyhow::Result<()> {
    let bg = parse_hex_color(background).ok_or_else(|| anyhow::anyhow!("background inválido"))?;
    let fg = parse_hex_color(foreground).ok_or_else(|| anyhow::anyhow!("foreground inválido"))?;
    let mut palette = wezterm_term::color::ColorPalette::default();
    palette.background = bg;
    palette.foreground = fg;
    palette.cursor_fg = bg;
    palette.cursor_bg = fg;
    palette.cursor_border = fg;
    if let Some(c) = parse_hex_color(cursor) {
        palette.cursor_bg = c;
        palette.cursor_border = c;
        palette.cursor_fg = bg;
    }
    if ansi.len() == 16 {
        for (i, hex) in ansi.iter().enumerate() {
            if let Some(c) = parse_hex_color(hex) {
                palette.colors.0[i] = c;
            }
        }
    }
    client
        .set_configured_palette_for_pane(codec::SetPalette { pane_id, palette })
        .await?;
    Ok(())
}

fn parse_hex_color(s: &str) -> Option<wezterm_term::color::SrgbaTuple> {
    let s = s.trim().trim_start_matches('#');
    let (r, g, b) = match s.len() {
        3 => {
            let d = |i: usize| u8::from_str_radix(&s[i..i + 1], 16).ok().map(|n| n * 17);
            (d(0)?, d(1)?, d(2)?)
        }
        6 => {
            let d = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).ok();
            (d(0)?, d(2)?, d(4)?)
        }
        _ => return None,
    };
    Some(wezterm_term::color::RgbColor::new_8bpc(r, g, b).into())
}
