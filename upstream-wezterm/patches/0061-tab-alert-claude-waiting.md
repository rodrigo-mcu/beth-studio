# Patch 0061 — Tab alert when a pane is waiting for the user (Claude Code)

**Status:** Terminal-side implemented 2026-06-22. Claude-side hook: candidate, needs testing.

## Goal

> "tem como implementar uma forma de dar um alerta na aba se tiver algum claude
> code aguardando o usuario?"

Light up a tab when a program in it (typically Claude Code) is waiting for the
user — a permission prompt or an idle "your turn" state.

## Design — user var driven

The program signals its state by setting a terminal **user var** via the iTerm2
OSC 1337 sequence:

```
ESC ] 1337 ; SetUserVar=claude_status=<base64 value> BEL
```

- `claude_status=waiting` → the tab shows a yellow `●`.
- any other value (e.g. `idle`) or the var being unset → no indicator.

This was chosen over the terminal bell because it carries explicit state
(waiting vs. not), is sticky, and clears cleanly — and because wezterm already
has the entire plumbing wired:

- OSC 1337 `SetUserVar` → `TerminalState.user_vars` (`term/.../performer.rs`),
  also fires `Alert::SetUserVar`.
- `Alert::SetUserVar` → `emit_user_var_event()` → `update_title()` →
  `get_tab_information()` → `TabBarState::new()` (`wezterm-gui/.../mod.rs`), so
  the tab bar repaints live when the var changes.
- `PaneInformation.user_vars` already carries the map to the tab-bar builder.

## Terminal-side change (this patch)

`wezterm-gui/src/tabbar.rs` — in `compute_tab_title()`, when the active pane's
`user_vars["claude_status"] == "waiting"`, prepend a yellow `●` to the tab
title items. Because both the classic and the fancy tab bars build their tab
text from `compute_tab_title()`, the indicator shows in both.

Files: `wezterm-gui/src/tabbar.rs`.

**Limitation (v1):** only the tab's **active** pane is checked. A Claude in a
non-active split won't light the tab yet — see "Possible extensions".

## Trying it without Claude (manual test)

After rebuilding the GUI, run this **in a wezterminator pane** (PowerShell) to
make the tab's `●` appear, then clear:

```powershell
$e=[char]27; $b=[char]7
# set waiting  (d2FpdGluZw== = base64 "waiting")
Write-Host -NoNewline "$e]1337;SetUserVar=claude_status=d2FpdGluZw==$b"
# clear        (aWRsZQ==     = base64 "idle")
Write-Host -NoNewline "$e]1337;SetUserVar=claude_status=aWRsZQ==$b"
```

bash equivalent:

```bash
printf '\033]1337;SetUserVar=claude_status=%s\007' "$(printf waiting | base64)"
printf '\033]1337;SetUserVar=claude_status=%s\007' "$(printf idle    | base64)"
```

## Driving it from Claude Code (hook) — NEEDS TESTING

Claude Code's **Notification** hook fires when it needs attention
(`permission_prompt`, `idle_prompt`); **UserPromptSubmit** / **PreToolUse** fire
when work resumes. Wire them to set / clear the var.

**Windows caveat:** a hook's stdout is captured by Claude Code (for the JSON
protocol), so a plain `echo`/`printf` of the escape does NOT reach the terminal.
The hook must write the bytes to the **console device** (`CONOUT$`), which the
ConPTY forwards to wezterminator. Candidate (`~/.claude/settings.json`):

```jsonc
{
  "hooks": {
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command",
      "command": "powershell -NoProfile -Command \"$e=[char]27;$b=[char]7;[IO.File]::WriteAllText('CONOUT$', \\\"$e]1337;SetUserVar=claude_status=d2FpdGluZw==$b\\\")\"" }]}],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "powershell -NoProfile -Command \"$e=[char]27;$b=[char]7;[IO.File]::WriteAllText('CONOUT$', \\\"$e]1337;SetUserVar=claude_status=aWRsZQ==$b\\\")\"" }]}]
  }
}
```

A ready-made helper that does the `CONOUT$` write (and no-ops outside a wezterm
pane, since it checks `WEZTERM_PANE`) is committed at `hooks/claude-tab-status.ps1`
(repo root); the hook `command` calls it as
`powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\hooks\claude-tab-status.ps1 waiting|idle`.

Before enabling it globally, weigh: (1) whether `CONOUT$` actually reaches the
terminal under Claude's hook execution must be confirmed **visually** — prove
the indicator with the manual command above first; (2) the `UserPromptSubmit`
hook spawns PowerShell on *every* prompt in *every* Claude session, adding a
small latency, so enable it deliberately. If `CONOUT$` doesn't work, fall back
to Claude Code's own notification/bell channel.

## Build / verify

```
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly check -p wezterm-gui
cargo +nightly build --release -p wezterm -p wezterm-gui
```

Then use the manual test above; the `●` should appear on the tab and clear.

## Possible extensions

- Check **all** panes of a tab (not just the active one): aggregate
  `claude_status` across `tab.iter_panes()` in `get_tab_information()` and store
  it on `TabInformation`.
- Make the user-var name / glyph / colour configurable.
- Bubble the state onto the group label (patch 0030 header).
