// wtinator::sysmon — CPU / RAM / disk sampling for the system panel.
//
// Windows implementation uses raw Win32 APIs (no new crates):
// `GetSystemTimes` (CPU, via idle-vs-total delta between two samples),
// `GlobalMemoryStatusEx` (RAM), `GetDiskFreeSpaceExW` over fixed drives
// (disks). Non-Windows builds get a zeroed stub so CI keeps compiling.

#![allow(unsafe_code)]

#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

/// One fixed disk: `label` is `"C:"`, `"D:"`, …
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskStat {
    /// Drive label without backslash, e.g. `"C:"`.
    pub label: String,
    /// Bytes in use (`total - free`).
    pub used_bytes: u64,
    /// Total bytes on the volume.
    pub total_bytes: u64,
}

impl DiskStat {
    /// Used percentage in 0.0–100.0.
    pub fn pct(&self) -> f32 {
        usage_pct(self.used_bytes, self.total_bytes)
    }
}

/// One full sample: CPU load plus RAM and disk usage.
#[derive(Debug, Clone, PartialEq)]
pub struct SystemStats {
    /// CPU busy percentage in 0.0–100.0 (0.0 on the very first sample).
    pub cpu_pct: f32,
    /// RAM bytes in use.
    pub ram_used_bytes: u64,
    /// Total physical RAM bytes.
    pub ram_total_bytes: u64,
    /// Fixed disks, in drive-letter order.
    pub disks: Vec<DiskStat>,
}

impl SystemStats {
    /// RAM used percentage in 0.0–100.0.
    pub fn ram_pct(&self) -> f32 {
        usage_pct(self.ram_used_bytes, self.ram_total_bytes)
    }
}

/// Used percentage in 0.0–100.0; 0.0 when the total is unknown.
pub fn usage_pct(used: u64, total: u64) -> f32 {
    if total == 0 {
        return 0.0;
    }
    ((used as f64 / total as f64) * 100.0) as f32
}

/// CPU busy percentage from two `GetSystemTimes` snapshots. Times are in
/// 100ns units; on Windows the kernel time already includes idle, so
/// `busy = total_delta - idle_delta` with `total = kernel + user`.
pub fn cpu_pct_from_times(prev_idle: u64, prev_total: u64, cur_idle: u64, cur_total: u64) -> f32 {
    let total = cur_total.saturating_sub(prev_total);
    if total == 0 {
        return 0.0;
    }
    let idle = cur_idle.saturating_sub(prev_idle);
    let busy = total.saturating_sub(idle);
    (busy as f64 / total as f64 * 100.0) as f32
}

/// Short `12.3 GB` rendering for byte counts.
pub fn fmt_gb(bytes: u64) -> String {
    let gb = bytes as f64 / 1_073_741_824.0;
    if gb >= 100.0 {
        format!("{gb:.0} GB")
    } else {
        format!("{gb:.1} GB")
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Take one full sample. CPU needs two samples to form a delta, so the
/// first call in the process reports 0.0 and later calls report the load
/// since the previous call.
#[cfg(windows)]
pub fn sample() -> SystemStats {
    SystemStats {
        cpu_pct: cpu_sample(),
        ram_used_bytes: ram_sample().0,
        ram_total_bytes: ram_sample().1,
        disks: disk_sample(),
    }
}

/// Zeroed stub for non-Windows CI builds.
#[cfg(not(windows))]
pub fn sample() -> SystemStats {
    SystemStats {
        cpu_pct: 0.0,
        ram_used_bytes: 0,
        ram_total_bytes: 0,
        disks: Vec::new(),
    }
}

#[cfg(windows)]
static LAST_CPU: OnceLock<Mutex<Option<(u64, u64)>>> = OnceLock::new();

#[cfg(windows)]
fn last_cpu() -> std::sync::MutexGuard<'static, Option<(u64, u64)>> {
    LAST_CPU
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(windows)]
fn filetime_to_u64(ft: &windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

#[cfg(windows)]
fn cpu_sample() -> f32 {
    use windows_sys::Win32::System::Threading::GetSystemTimes;
    unsafe {
        let mut idle = std::mem::zeroed();
        let mut kernel = std::mem::zeroed();
        let mut user = std::mem::zeroed();
        if GetSystemTimes(&mut idle, &mut kernel, &mut user) == 0 {
            return 0.0;
        }
        let idle_u = filetime_to_u64(&idle);
        let total = filetime_to_u64(&kernel).saturating_add(filetime_to_u64(&user));
        let mut last = last_cpu();
        let pct = match *last {
            None => 0.0,
            Some((prev_idle, prev_total)) => {
                cpu_pct_from_times(prev_idle, prev_total, idle_u, total)
            }
        };
        *last = Some((idle_u, total));
        pct
    }
}

#[cfg(windows)]
fn ram_sample() -> (u64, u64) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut st: MEMORYSTATUSEX = std::mem::zeroed();
        st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut st) == 0 {
            return (0, 0);
        }
        (st.ullTotalPhys.saturating_sub(st.ullAvailPhys), st.ullTotalPhys)
    }
}

#[cfg(windows)]
static LAST_DISKS: OnceLock<Mutex<Vec<DiskStat>>> = OnceLock::new();

#[cfg(windows)]
fn last_disks() -> std::sync::MutexGuard<'static, Vec<DiskStat>> {
    LAST_DISKS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(windows)]
fn disk_sample() -> Vec<DiskStat> {
    // GetDiskFreeSpaceExW / GetDriveTypeW can stall for seconds on a
    // wedged volume. Never do that on the tray/UI thread.
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("bethterm-disk".into())
        .spawn(move || {
            let _ = tx.send(disk_sample_inner());
        });
    match rx.recv_timeout(std::time::Duration::from_millis(250)) {
        Ok(disks) => {
            *last_disks() = disks.clone();
            disks
        }
        Err(_) => last_disks().clone(),
    }
}

#[cfg(windows)]
fn disk_sample_inner() -> Vec<DiskStat> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
    };
    const DRIVE_FIXED: u32 = 3;
    let mut out = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let root_w = wide(&root);
        let drive_type = unsafe { GetDriveTypeW(root_w.as_ptr()) };
        if drive_type != DRIVE_FIXED {
            continue;
        }
        let mut _avail = 0u64;
        let mut total = 0u64;
        let mut _free = 0u64;
        let ok =
            unsafe { GetDiskFreeSpaceExW(root_w.as_ptr(), &mut _avail, &mut total, &mut _free) };
        if ok == 0 || total == 0 {
            continue;
        }
        let used = total.saturating_sub(_free);
        out.push(DiskStat {
            label: format!("{letter}:"),
            used_bytes: used,
            total_bytes: total,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_all_idle_is_zero() {
        assert_eq!(cpu_pct_from_times(100, 200, 200, 300), 0.0);
    }

    #[test]
    fn cpu_all_busy_is_hundred() {
        assert_eq!(cpu_pct_from_times(100, 200, 100, 300), 100.0);
    }

    #[test]
    fn cpu_half_busy_is_fifty() {
        assert_eq!(cpu_pct_from_times(0, 0, 50, 100), 50.0);
    }

    #[test]
    fn cpu_zero_total_delta_is_zero() {
        assert_eq!(cpu_pct_from_times(50, 100, 50, 100), 0.0);
    }

    #[test]
    fn usage_pct_guards_zero_total() {
        assert_eq!(usage_pct(10, 0), 0.0);
        assert_eq!(usage_pct(1, 2), 50.0);
    }

    #[test]
    fn fmt_gb_shapes() {
        assert_eq!(fmt_gb(0), "0.0 GB");
        assert_eq!(fmt_gb(1_073_741_824), "1.0 GB");
        assert_eq!(fmt_gb(211_000_000_000), "197 GB");
    }

    #[test]
    fn disk_pct_delegates_to_usage() {
        let d = DiskStat {
            label: "C:".to_string(),
            used_bytes: 1,
            total_bytes: 4,
        };
        assert_eq!(d.pct(), 25.0);
    }
}
