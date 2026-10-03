# 0145 — Tray watchdog verifies the icon really exists

**Status:** Implemented 2026-09-22.

## Symptom

After ~3 h the GUI logged

```
bethterm tray: modify icon failed, re-adding: Shell_NotifyIconW failed err=1460
```

(`ERROR_TIMEOUT`: Explorer's notification area did not answer). Patch
0126 re-added the icon and Windows returned success, but the icon never
came back: every 15 s the watchdog's `NIM_MODIFY` kept "succeeding" for
an icon Explorer had dropped. The tray-hidden windows became
unreachable.

## Fix (`wtinator/src/tray.rs`)

- The 15 s watchdog (`ensure_icon_present`) now **verifies** the icon
  with `Shell_NotifyIconGetRect` (it only succeeds for an icon the
  shell really lists) besides trying `NIM_MODIFY`.
- `next_icon_action(exists, modify_ok)` (pure, unit-tested): anything
  but "listed and modifiable" means `ReAdd`: `NIM_DELETE`, bump the
  icon **uID** (`TRAY_UID_CUR`) so Explorer cannot match a stale
  record, `NIM_ADD`, verify again.
- If that still fails, escalate: destroy the hidden tray owner window
  and create a new one (`create_tray_hwnd`, factored out of the tray
  thread), re-register `TaskbarCreated`, re-arm the timer and add the
  icon there. INFO on recovery, WARN on escalation.
- `TaskbarCreated` handling is unchanged.

## Revert

Restore `TRAY_UID` and the old `ensure_icon_present`; remove
`icon_exists`, `next_icon_action`, `rebuild_tray_window`,
`create_tray_hwnd`. Remove row 0145 and this file.
