# BethTerm — drive the "Claude is waiting" tab indicator (patch 0061).
#
# Emits  OSC 1337 ; SetUserVar=claude_status=<status>  to the terminal so
# BethTerm lights (status "waiting") or clears (any other value) the
# yellow dot on the tab. See upstream-wezterm/patches/0061-tab-alert-claude-waiting.md.
#
# Wire it from Claude Code hooks (e.g. ~/.claude/settings.json).
# Replace <bethterm-clone> with this repository's path:
#
#   "hooks": {
#     "Notification":     [ { "matcher": "", "hooks": [ { "type": "command",
#       "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"<bethterm-clone>\\hooks\\claude-tab-status.ps1\" waiting" } ] } ],
#     "UserPromptSubmit": [ {                "hooks": [ { "type": "command",
#       "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"<bethterm-clone>\\hooks\\claude-tab-status.ps1\" idle" } ] } ]
#   }
#
# Notes:
#   * Only emits inside a WezTerm / BethTerm pane (WEZTERM_PANE is set), so
#     it is a harmless no-op in any other terminal.
#   * The sequence is written to the console device (CONOUT$), NOT stdout,
#     because a hook's stdout is captured by Claude Code and never reaches the
#     terminal. Whether CONOUT$ is forwarded by the ConPTY to WezTerminator is
#     the one thing to confirm visually on your machine — prove the indicator
#     itself first with the manual command in the patch note.
param([string]$Status = "waiting")

if (-not $env:WEZTERM_PANE) { exit 0 }

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Status))
$esc = [char]27
$bel = [char]7
$seq = "$esc]1337;SetUserVar=claude_status=$b64$bel"

try {
    $stream = [System.IO.File]::Open(
        'CONOUT$',
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::ReadWrite)
    $bytes = [Text.Encoding]::ASCII.GetBytes($seq)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
} catch {
    # No console device available (e.g. fully redirected) — nothing to do.
    exit 0
}
