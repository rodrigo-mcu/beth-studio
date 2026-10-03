# Console Host

This directory contains a copy of built artifacts from the Microsoft
Terminal project which is provided by Microsoft under the terms
of the MIT license.

Why are they here?  At the time of writing, the conpty implementation
that ships with windows is lacking support for mouse reporting but
that support is available in the opensource project so it is desirable
to point to that so that we can enable mouse reporting in wezterm.

It looks like we'll eventually be able to drop this once Windows
and/or the build for the terminal project make some more progress.

https://github.com/wezterm/wezterm/issues/1927

These assets were built by cloning the ms-terminal repo and running:

```
.\tools\razzle.cmd
bcz rel
```

then the files can be copied from `bin/x64/Release` to this location.

BethTerm patch 0113 ships the matched Microsoft redistributable pair
from `Microsoft.Windows.Console.ConPTY.1.24.260402001` (file version
`1.24.2604.02001`):

- `runtimes/win-x64/native/conpty.dll`
- `build/native/runtimes/x64/OpenConsole.exe`

Source: https://github.com/microsoft/terminal/releases/tag/v1.24.10921.0

It's possible that you'll need to download this runtime support package
from MS in order for this to work:
https://www.microsoft.com/en-us/download/details.aspx?id=53175
