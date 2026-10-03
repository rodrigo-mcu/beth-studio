# Patch 0084 — Two-step confirmation for closing tabs

**Applied:** 2026-08-30

## What

Closing a tab now requires two independent **Yes** confirmations. The second
dialog explicitly states that all programs and panes in that tab will be
killed.

## Notes

The confirmation backend was separated into `confirm_once` plus the public
policy wrapper so whole-window close remains exactly two confirmations (after
its existing three-second cooling period), rather than recursively becoming
four prompts.

## Files

- `wtinator/src/confirm.rs`
- `PATCHES.md`

## Verification

```powershell
cargo +nightly check -p wtinator
```

Manual: click a tab's X; choose Yes in the first modern Windows dialog and
confirm the second dialog appears. Choose No in either dialog and confirm the
tab remains open.

## Revert

Restore the one-step Tab arm in `confirm_close`, delete this file, and remove
the 0084 entry from `PATCHES.md`.
