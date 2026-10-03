# 0144 — A stale `.new` must not overwrite a fresh install

**Status:** Implemented 2026-09-22.

## Symptom

Setup run with **Sim** (close the host): the host was replaced in place
with the newest build. On the next GUI start the log said
`applied staged bethterm-host.exe`, and the running host was an
**older** build, with the newest one moved to `bethterm-host.exe.bak`.

## Cause

An earlier install (script or setup with the host running) had left
`bethterm-host.exe.new`. The direct replace did not remove it, and
`apply_pending_binary` applied whatever `.new` it found, regardless of
age.

## Fix

- `bethterm-setup`: after replacing a file in place, delete any
  `<name>.new` next to it.
- `wtinator::host::apply_pending_binary`: only apply a `.new` whose
  modification time is newer than the installed file; otherwise delete
  it and log "discarding stale staged".

## Revert

Remove the two guards. Remove row 0144 and this file.
