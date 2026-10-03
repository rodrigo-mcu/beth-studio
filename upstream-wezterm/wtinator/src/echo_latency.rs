//! BethTerm (patch 0170): measure typing latency in the running GUI.
//!
//! Every key sent to the host carries an `InputSerial`; the host echoes
//! it on the next render delta. That gives the key -> host -> key round
//! trip (`rtt`). The GUI then paints; the time from that delta to the end
//! of the next painted frame is `paint_gap`. `rtt + paint_gap` is what the
//! user feels as echo delay.
//!
//! Once a minute (only when keys were typed) one summary line is appended
//! to `%APPDATA%\bethterm\echo-latency.log`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

const REPORT_EVERY: Duration = Duration::from_secs(60);
const LOG_MAX: u64 = 1024 * 1024;

struct Stats {
    since: Instant,
    rtt_ms: Vec<u32>,
    gap_ms: Vec<u32>,
    frame_ms: Vec<u32>,
    /// A delta tagged with a key arrived; waiting for the next frame.
    echo_pending: Option<Instant>,
}

static STATS: Mutex<Option<Stats>> = Mutex::new(None);

fn with_stats<T>(f: impl FnOnce(&mut Stats) -> T) -> T {
    let mut guard = STATS.lock().unwrap_or_else(|e| e.into_inner());
    let stats = guard.get_or_insert_with(|| Stats {
        since: Instant::now(),
        rtt_ms: Vec::new(),
        gap_ms: Vec::new(),
        frame_ms: Vec::new(),
        echo_pending: None,
    });
    f(stats)
}

/// Register the ClientPane hook (once per GUI process).
pub fn install() {
    let _ = wezterm_client::pane::BETHTERM_ECHO_RTT.set(record_rtt);
}

/// A render delta answering a key arrived after `rtt_ms`.
fn record_rtt(rtt_ms: u64) {
    with_stats(|s| {
        s.rtt_ms.push(rtt_ms.min(u32::MAX as u64) as u32);
        s.echo_pending.get_or_insert_with(Instant::now);
    });
}

/// A frame finished painting; `took` is the whole paint_impl time.
pub fn record_frame(took: Duration) {
    let line = with_stats(|s| {
        if let Some(at) = s.echo_pending.take() {
            s.gap_ms.push(at.elapsed().as_millis() as u32);
            s.frame_ms.push(took.as_millis() as u32);
        }
        if s.since.elapsed() < REPORT_EVERY {
            return None;
        }
        let line = summary(s);
        s.since = Instant::now();
        s.rtt_ms.clear();
        s.gap_ms.clear();
        s.frame_ms.clear();
        line
    });
    if let Some(line) = line {
        write_line(&line);
    }
}

fn summary(s: &mut Stats) -> Option<String> {
    if s.rtt_ms.is_empty() {
        return None;
    }
    Some(format!(
        "keys={} rtt[{}] paint_gap[{}] frame[{}]",
        s.rtt_ms.len(),
        describe(&mut s.rtt_ms, 100),
        describe(&mut s.gap_ms, 50),
        describe(&mut s.frame_ms, 50),
    ))
}

/// `p50 p95 max` in ms plus how many samples reached `slow_ms`.
fn describe(v: &mut [u32], slow_ms: u32) -> String {
    if v.is_empty() {
        return "none".to_string();
    }
    v.sort_unstable();
    let pick = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
    let slow = v.iter().filter(|&&x| x >= slow_ms).count();
    format!(
        "p50={} p95={} max={} >={}ms={}",
        pick(0.5),
        pick(0.95),
        v[v.len() - 1],
        slow_ms,
        slow
    )
}

fn write_line(line: &str) {
    let Ok(dir) = crate::session::session_dir() else {
        return;
    };
    let path = dir.join("echo-latency.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_MAX).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("echo-latency.1.log"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(
            file,
            "{} pid={} {line}",
            crate::host::life_stamp(),
            std::process::id()
        );
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn describe_reports_percentiles_and_slow_count() {
        let mut v = vec![10, 20, 30, 40, 200];
        assert_eq!(describe(&mut v, 100), "p50=30 p95=200 max=200 >=100ms=1");
        let mut empty: Vec<u32> = vec![];
        assert_eq!(describe(&mut empty, 100), "none");
    }
}
