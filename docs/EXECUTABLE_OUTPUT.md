# Seeing output from Windows executables

Some Windows executables print to stdout/stderr and any terminal can show that
output. Others are GUI-subsystem or legacy console apps whose output is visible
only when a compatibility bridge creates a hidden real console and copies its
screen/pipe output back to the terminal.

MobaXterm commonly has this bridge available through its Cygwin `conin.exe`
wrapper. In MobaXterm, `/usr/bin/winpty` is a symlink to `conin.exe`, not the
same binary/runtime as Git for Windows' `winpty.exe`. That means MobaXterm can
show output for programs that plain `cmd`, Git Bash, WSL, or a ConPTY terminal
do not show.

The examples below use a placeholder desktop application started in debug
mode:

```powershell
C:\path\to\app.exe -debug
```

## What was observed (2026-06-07, MobaXterm portable v26.3)

Working path:

- Real MobaXterm local terminal, in the application's folder, running
  `./app -debug`: the debug messages and the final "press a key to exit"
  prompt are printed in the MobaXterm terminal.

Non-working or incomplete paths:

- Git Bash: `./app.exe -debug` showed no terminal output.
- Git Bash with winpty: `winpty ./app.exe -debug` showed no terminal output.
- Beth Studio with the extracted MobaXterm local bash showed no equivalent output.
- Launching the extracted MobaXterm shell inside Beth Studio does not make Beth Studio
  become MobaXterm; the terminal backend is still ConPTY.

Reliable fallback: if the application also writes a log file, follow that file
in a terminal. A user-defined entry in `%APPDATA%\bethstudio\shells.json`
(patch 0183) can start the application and follow its log in one click, e.g.
PowerShell with `-NoExit`, `Start-Process` for the app and
`Get-Content -Tail 120 -Wait` on the log.

Working theory:

- MobaXterm is not merely running `bash.exe`; it has an additional terminal /
  console compatibility bridge around its local shell.
- MobaXterm's `/usr/bin/winpty` resolves to `conin.exe`; Git for Windows
  `winpty.exe` is not equivalent.
- The extracted MobaXterm `bash.exe` / `conin.exe` binaries alone have not
  reproduced the real MobaXterm console behavior inside BethStudio.
- This is a known limitation to study later if a native Moba-compatible console
  bridge becomes a priority.

## Quick checks

1. Verify which wrapper MobaXterm uses:

```bash
type winpty
ls -l /bin/winpty /bin/conin
```

2. Keep the shell open after exit:

```powershell
cmd /k "C:\path\to\app.exe -debug"
```

3. Capture stderr and stdout explicitly:

```powershell
& "C:\path\to\app.exe" -debug *> C:\tmp\app-output.log
Get-Content C:\tmp\app-output.log -Tail 200
```

4. Check the PE subsystem with Visual Studio tools:

```powershell
dumpbin /headers C:\path\to\app.exe
```

Look for `subsystem`.

- `Windows CUI`: the program is a console app. Empty output usually means the
  app did not write to stdout/stderr.
- `Windows GUI`: the program has no inherited console by default. It may use
  `OutputDebugString`, `AllocConsole`, or a private log file.

5. Look for debug-output APIs:

```powershell
strings C:\path\to\app.exe | Select-String OutputDebugString
```

If `OutputDebugString` appears, use Sysinternals DebugView or WinDbg. That
output is not stdout/stderr and will not appear in cmd, Git Bash, WSL, or
Beth Studio unless a debugger/debug-output listener is attached.

## Debugger path

With Windows debugging tools installed:

```powershell
cdb -g -G -o C:\tmp\app-cdb.log C:\path\to\app.exe -debug
```

For a deeper trace, set breakpoints on:

- `kernel32!OutputDebugStringA`
- `kernel32!OutputDebugStringW`
- `kernel32!WriteConsoleA`
- `kernel32!WriteConsoleW`

The stack trace tells which output path the executable is using.

## Beth Studio implication

Beth Studio displays normal stdout/stderr written through the process' inherited
console handles. For applications that only show output under MobaXterm's
bridge, follow the application's own log file (optionally through a
`shells.json` entry). If the target app uses `OutputDebugString`, even `winpty`
will not help; that requires a DebugView-style listener.
