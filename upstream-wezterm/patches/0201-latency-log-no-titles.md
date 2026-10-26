# 0201 — The echo latency log no longer records terminal titles

**Status:** Implemented 2026-10-24.

## Why

`bridge-latency.log` (patch 0177) wrote the pane title on every line. A
terminal title is free text set by the program or by the user, and it can
carry what was typed. On 2026-10-24 a log on another machine held a title
with a password hint ("... senha ..."). The title was only there to tell
which program a pane runs (Claude, Grok, PowerShell...).

## What

- Each line now ends with `prog=<label>` instead of `title="..."`. The label
  is one of a fixed list (`claude`, `grok`, `cursor`, `codex`, `gemini`,
  `kimi`, `opencode`, `aider`, `powershell`, `pwsh`, `wsl`, `ssh`, `cmd.exe`,
  `bash`) found in the title, otherwise `other`. No title text is written.
- Once per bridge process, `bridge-latency.log` and `bridge-latency.1.log`
  that still contain ` title=` lines are deleted. The file is only a
  diagnostic; nothing reads it back.

```
2026-10-24 12:20:01.123 pid=1234 pane=10 keys=180 echo[p50=35 p95=240 max=900 >=100ms=40] host_rpc_max=6 prog=claude
```

## Files

- `wezterm/src/cli/bridge.rs` — `program_label`, `scrub_old_titles`, the log
  line, two unit tests (`latency_log_privacy_tests`)

## Revert

Restore `title={title:?}` in `report_now` and remove `program_label`,
`scrub_old_titles` and the tests. Remove row 0201 and this file.
