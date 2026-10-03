# 0164 — Setup option: Encerrar tudo antes de instalar

**Status:** Implemented 2026-09-23.

## What

The setup could stop hosts only when the host binary changed, and it
never stopped the interface. Leftover hosts kept the new host binary
staged as `.new`, and the running GUI reattached to them.

The window has a new checkbox, off by default:
**Encerrar tudo antes de instalar (fecha o BethTerm e todos os
terminais)**.

When it is checked, Instalar/Atualizar:

1. asks for confirmation (Cancelar is the default button)
2. terminates every `bethterm-gui.exe`, `bethterm.exe`,
   `wtinator-config.exe` (and legacy `wezterm-gui.exe`) whose image is
   in the install folder, so the interface cannot start a host again
3. signals every host's quit event and waits 10 s, then terminates the
   `bethterm-host.exe` / `wezterm-mux-server.exe` processes still
   running from the install folder
4. installs everything, including the host, and skips the "host
   changed" question

Processes running from any other folder (a dev build in
`target\release`, another install) are left alone. The final status
text reports how many processes were stopped.

## Files

- `bethterm-setup/src/main.rs`, `bethterm-setup/Cargo.toml`
  (`Win32_System_Diagnostics_ToolHelp`)

## Revert

Remove `mod stop_all`, `IDC_STOP_ALL`, the checkbox, and
`confirm_stop_all`. Restore `CLIENT_H = 392` and the progress/status
positions. Remove row 0164 and this file.
