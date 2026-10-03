# 0112 — "Sistema" tray entry + CPU/RAM/disk panel window

## What

The notification-area menu gains a **Sistema** entry (second row, after
**Novo terminal**). It opens **"BethTerm — Sistema"**, a separate
modeless Win32 window with CPU / RAM / fixed-disk usage, refreshed
once a second:

```text
CPU  12%
[bar]
RAM  9,3 / 31,9 GB (29%)
[bar]
C:  211 / 476 GB (44%)
[bar]
```

- Re-clicking **Sistema** (or the taskbar button) brings the open panel
  to the front instead of opening a second one; the X closes it.
- Painted with GDI in system colors (`COLOR_WINDOW` / `COLOR_HIGHLIGHT`),
  so it follows light/dark mode with no theming code.
- No new crates. Sampling is raw Win32: `GetSystemTimes` (CPU, via
  idle-vs-total delta between consecutive samples — the first sample in
  the process reports 0.0), `GlobalMemoryStatusEx` (RAM),
  `GetDiskFreeSpaceExW` over `DRIVE_FIXED` drives (disks).

## How

- `wtinator/src/sysmon.rs` (new): `SystemStats` / `DiskStat`,
  `sample()`, plus pure helpers (`cpu_pct_from_times`, `usage_pct`,
  `fmt_gb`) covered by unit tests. Windows-only parts are
  `#[cfg(windows)]`; other platforms get a zeroed stub so CI compiles.
- `wtinator/src/syspanel.rs` (new, Windows-only): `toggle_panel()`,
  the `BethTermSysPanel` window class, 1s `SetTimer` → `InvalidateRect`
  repaint, GDI bars + text. Created and pumped on the tray owner
  thread, which already runs a message loop — the tray menu's
  `WM_COMMAND` runs on that same thread, so no cross-thread window
  creation (cf. the patch 0107 lesson).
- `wtinator/src/tray.rs`: `ID_SYS_PANEL = 4`, `TrayMenuEntry::SysPanel`
  as the second menu row, `WM_COMMAND` → `syspanel::toggle_panel()`.
  `menu_entries` unit tests updated for the new row.
- `wtinator/src/lib.rs`: `pub mod sysmon` (+ doc), `#[cfg(windows)]
  pub mod syspanel`.
- `wtinator/Cargo.toml`: `windows-sys` gains
  `Win32_System_SystemInformation` and `Win32_Storage_FileSystem`.

## Revert

Delete `sysmon.rs` / `syspanel.rs` and their `lib.rs` lines, drop the
two `windows-sys` features, and remove `ID_SYS_PANEL`,
`TrayMenuEntry::SysPanel`, and its menu/`WM_COMMAND` arms from
`tray.rs`.
