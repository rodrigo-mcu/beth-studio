# 0191 — PowerShell cwd follows the prompt

**Status:** Implemented 2026-09-26.

## Why

The terminal list showed the folder where PowerShell was started, not the
folder after `cd`. Windows PowerShell updates `$PWD` (the `PS C:\...>`
prompt) and does not update the Win32 process current directory. BethTerm
was reading that process directory, and the default prompt does not emit
OSC 7, so the list stayed on the startup folder for the whole session.

Example: a shell opened in `C:\src\app` and then `cd`'d to
`C:\Tools\demo` still listed `C:\src\app`. A shell opened
in the user profile and then `cd`'d to `C:\src\project` still
listed `~`.

## What

`LocalPane::get_current_working_dir` on Windows, when the foreground
process is `powershell.exe` or `pwsh.exe` and the primary screen shows a
filesystem prompt, uses that path. A full-screen app (alternate screen) and
any other foreground process keep the previous behavior: OSC 7, otherwise
the process directory. A child such as `snyk-win.exe` still reports its own
directory, which PowerShell set from `$PWD` when it launched the child.

Beth Studio no longer uses a title that is only the shell executable path
(`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`) as the
terminal name. That line is the console title, not the folder. The folder
row stays the cwd reported by the host.

## Revert

Restore `get_current_working_dir` to OSC 7 or `divine_current_working_dir`
only, and remove `windows_powershell_prompt_cwd`, `is_powershell_process`,
`last_powershell_prompt_path`, and `powershell_cwd_tests`.
