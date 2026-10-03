# 0188 — Bridge `scrollback` + Studio history/screenshot + SFTP window

**Status:** Implemented 2026-09-26.

## Why

Beth Studio lacked parity with the classic GUI for **save/copy scrollback**
and **terminal screenshot**, and SFTP lived only inside the SSH/Serial
screen. Users coming from Bitvise expect `user@host:port` titles and a
**separate SFTP window** with dual-pane + transfer queues.

## What

### Bridge (`wezterm/src/cli/bridge.rs`)

- New op: `{"op":"scrollback","pane_id":N,"request_id":"…"}`
- Event: `{"ev":"scrollback","request_id":"…","pane_id":N,"text":"…"}`
  (plain text, scrollback + viewport, capped at 100 000 rows)

### bethterm-web

- SSH title / kind label = `user@host:port` (`ssh_helper`, `ssh_argv`,
  `panekind` + `ssh_host_id` on list panes)
- Studio context menu: Copiar histórico / Salvar histórico… / Copiar
  print / Salvar print…
- APIs: `/api/pane/scrollback`, `/api/pane/scrollback/save`,
  `/api/pane/screenshot/save`
- CLI: `bethterm-web.exe --sftp <hostId>` — dedicated WebView2 window
  (no mux bridge)
- API: `POST /api/ssh/sftp/window` launches another process
- Dual-pane UI + upload/download job queue (`/api/ssh/sftp/jobs*`,
  `/api/local-fs/*`)
- Toolbar folder icon on SSH panes with a saved host id

### Docs

- Passwords remain DPAPI in `secrets.dat` (not in `ssh-hosts.json`)
- Gaps vs Bitvise listed in `bethterm-web/docs/FEATURES-gaps.md`

## Files

- `upstream-wezterm/wezterm/src/cli/bridge.rs`
- `bethterm-web/` (Go + React as above)

## Revert

Remove the `Scrollback` request/event from the bridge; drop the new
Go/React surfaces; restore `setTitle("SSH · " + h.Name)`.
