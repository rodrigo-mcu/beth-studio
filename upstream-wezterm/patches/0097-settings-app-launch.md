# 0097 — Settings app launch from “Configure this terminal…”

## What

“Configure this terminal…” launches `wtinator-config.exe` next to the GUI.
That binary was often missing, and errors were posted from a helper thread
so the dialog never appeared. Failures in the settings process itself also
vanished because it is a `windows` subsystem exe.

- Launch on the UI thread; look for `wtinator-config.exe` or
  `bethterm-config.exe`.
- Settings fatal errors show a MessageBox.
- Pack includes `wtinator-config.exe` when it is in the release dir.

## Revert

Restore the previous `std::thread::spawn` OpenConfigApp arm and drop the
MessageBox in `wtinator-config/src/main.rs`.
