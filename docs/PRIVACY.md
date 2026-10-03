# Privacy

BethTerm is a **local** application. We do not collect, store, or transmit any data about you, your machine, or your usage.

Upstream WezTerm already states "no telemetry"; we keep that stance.

## What we don't do

- **No telemetry.** No usage events, no crash reports, no anonymous stats.
- **No remote calls without your action.** The only outbound HTTP requests BethTerm makes are:
  - Theme catalog / VS Code Marketplace, **only** when you explicitly download or browse themes.
  - Font download CDNs, **only** when you accept a first-run font prompt (if enabled).
- **No third-party analytics SDKs.**
- **No auto-update check.**

## What we store on your machine

All BethTerm state is local:

| File | What it is | Where |
| --- | --- | --- |
| `~/.wezterm.lua` | Your config (WezTerm reads this; we only extend) | platform standard |
| `session.json` | Tabs, splits, names, groups | `%APPDATA%\bethterm\` (Windows), `~/.config/bethterm/` (other) |
| `themes/` | Cached downloaded themes | same directory |
| `theme-favorites.json` | Theme favorites for the Settings app | same directory |
| `default-theme.json` | Default theme for new terminals | same directory |
| `clipboard-images/` | Temporary PNGs from image paste | temp dir |

A previous WezTerminator install used `%APPDATA%\wezterminator\`. BethTerm migrates that folder to `bethterm` on first launch when possible.

None of these files are uploaded.

## The clipboard

The clipboard is a local channel. BethTerm reads it on paste and writes it on copy. It does not sync the clipboard to any other device.

## Logging

`tracing` / `log` output is stdout, stderr, or a local file only. The default log level is `warn`. Set `WEZTERM_LOG=debug` (or `RUST_LOG=info`) to see more. No log level includes the literal contents of the clipboard or the keystrokes you type.

## Changes to this policy

If this policy ever needs to change, we will note it in the release notes and in git history. The latest version always lives in `main`.

## History

- 2026-06-06 — Page created.
- 2026-09-05 — Rebranded to BethTerm; data directory is `%APPDATA%\bethterm`.
