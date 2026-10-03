# 0098 — Setup Open button and theme-download mirrors

## What

- The installer keeps an **Abrir** button. It is enabled when
  `bethterm-gui.exe` is already in the chosen folder, and after a
  successful install/update. After success the window stays open
  (Cancel becomes Fechar) so the user can launch without a console.
- Theme download no longer depends on a single `reqwest` call to
  `raw.githubusercontent.com`. Windows error 10013 (WSAEACCES) is
  common there. We retry, then try jsDelivr mirrors, `curl.exe`, and
  PowerShell `Invoke-WebRequest`.

## Files

- `bethterm-setup/src/main.rs`
- `wtinator/src/theme_download.rs`

## Revert

Remove the Abrir button and restore the single-URL reqwest fetch.
