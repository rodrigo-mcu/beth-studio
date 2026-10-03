# 0142 — Setup offers to close the host and update at once

**Status:** Implemented 2026-09-22.

## Symptom

"I ran the setup with nothing open and it did not update by itself."
The persistent host (`bethterm-host.exe`, patch 0121) has no window,
so it is still running after every GUI window is closed. The setup
found it locked and only staged `bethterm-host.exe.new` (patch 0128),
leaving the old host in place until someone used **Encerrar host**.

## Fix (`bethterm-setup/src/main.rs`)

Before extracting, if the host mutex `Local\BethTermHost` exists the
setup asks:

- **Sim** — signals `Local\BethTermHostQuit` (the same event the
  tray's **Encerrar host** uses), waits up to 10 s for the mutex to
  disappear, then installs every file in place. The terminals that
  lived in the host are closed; the final message says so and points
  at **Abrir**.
- **Não** — installs and stages the host as before.
- **Cancelar** — aborts the install.

If the host does not exit within 10 s the setup says so and falls back
to staging.

## Files

- `bethterm-setup/src/main.rs` (`mod host`, `ask_close_host`,
  `start_install`)
- `bethterm-setup/Cargo.toml` (`Win32_System_Threading`)

## Revert

Remove `mod host`, the prompt and the Cargo feature. Remove row 0142
and this file.
