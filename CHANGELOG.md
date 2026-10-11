# Changelog

All notable changes to Beth Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- PostgreSQL and SQL Server connections with an **Banco inicial** filled in open only that database (tree and query panel) instead of listing every database the user can reach.

### Added
- Phone web app: grid view of all terminals (screen print, name, folder, type, tab), toggled from the list header. The grid has the desktop's search (name, folder, type, tab, #id, optional screen text) and the Em abas / Sem aba / Encerrados filters.
- **Todos os terminais**: a grid button next to **+** opens a searchable popup with a screen print, name, type, folder and tab of every terminal, including those in closed tabs.
- The Beth Studio screen can be updated on its own (`bethstudio-web/deploy-ui.ps1`, **Configurações > Sobre > Recarregar interface**), without restarting the Studio or the host. A package that needs a newer Studio is ignored.
- `release.ps1`, `RELEASING.md` and a GitHub Actions workflow produce the installer, a portable zip, a UI-only zip and `SHA256SUMS.txt`, with the third-party license texts included.
- `bethstudio-web/` and `bethstudio-mobile/` are now BSD-3-Clause; the rest stays MIT. `SUPPORT.md` says what is supported.
- Tray **Esconder tudo** hides every visible window. Shells stay in the host (patch 0150).
- Right-click **Cor do ícone** colors that window's taskbar button. The swatch is stored with the window name (patch 0151).
- An agent waiting for you (bell, OSC 9, OSC 777, OSC 99, or a `*_status=waiting` user var) marks the window icon, the tray icon, and that window's tray-menu row (patches 0152–0153).
- Tray **Desenho** picks GPU (OpenGL) or CPU (Mesa). Switching restarts only the GUI (patch 0155). Notes: `docs/changelog/2026-09-23-patches-0149-0156.md`.
- Settings **Usar em todos** sets a default theme for every terminal (`%APPDATA%\bethterm\default-theme.json`). It recolours live panes and stamps new tabs/windows that have no per-pane theme. Splits still inherit (patch 0110). Notes: `docs/changelog/2026-09-10-patches-0105-0110.md`.
- The notification-area menu (icon next to the clock) offers **Novo terminal** as its first entry: it opens a default terminal in a brand-new window, so a new terminal is one click away even with nothing minimized (patch 0111).
- The notification-area menu offers **Sistema** (second entry): it opens a separate **BethTerm — Sistema** window with CPU/RAM/disk usage bars refreshed every second (patch 0112).

### Fixed
- The voice panel no longer closes (and loses what you said) when you click outside it while recording, transcribing, correcting or reviewing; only its buttons and Esc close it.
- The terminal list follows the PowerShell prompt after `cd`. Windows PowerShell leaves the process directory at the folder where it started, so the list kept showing that startup folder (patch 0191). A title that is only the path of `powershell.exe` is no longer shown as the terminal name in Beth Studio.
- Restoring saved window positions on a GUI restart no longer panics the new interface (patch 0149).
- A stuck native menu (Windows error 1446) is cancelled before the next menu opens (patch 0154).
- Opening a window from the tray list, or **Abrir todas**, shows it maximized (patch 0156).
- Closing a pane, tab, or a busy agent CLI no longer freezes the whole window. ConPTY now closes off the UI thread after the pipes drop, skips the hanging `INHERIT_CURSOR` flag, and ships Microsoft's 1.24 host (`conpty.dll` + `OpenConsole.exe`). Session auto-save and disk sampling no longer block the GUI if AppData or a volume stalls (patch 0113).
- Daily use stays fluid: the release launcher no longer enables paint/mouse debug logs, the caret blinks without a GPU fade, and the cursor glide is off unless `BETHTERM_CURSOR_GLIDE=1` (patch 0114).
- Default launch is release `bethterm-gui.exe` with no arguments (`run-bethterm.cmd`). A second click focuses the same GPU process; installer shortcuts and Abrir match (patch 0115).
- Minimized or tray-hidden windows no longer run GPU paint. PTY and session stay alive; restore forces one full redraw (patch 0116).
- **Novo terminal** in the notification-area menu opens a shell picker (cmd, PowerShell, WSL, …) instead of launching the default program immediately (patch 0117).
- Choosing a shell from that tray submenu no longer closes BethTerm. Spawn runs on the GUI thread (patch 0118).
- Tab completion and other PTY floods no longer freeze the window: line caches stay warm, output is painted as frames, not per-chunk full redraws (patch 0119).
- The notification-area menu keeps every open terminal in the list, even when the window is already visible, so a click focuses it (patch 0120).
- Shells and agents live in `bethterm-host.exe`. Closing or updating the GUI no longer kills the PTYs; the next launch attaches to the same panes (patch 0121).
- Tray **Encerrar host** stops the PTY process (after confirm). Theme, font, and header survive reconnect. A live host update stages `bethterm-host.exe.new` (patch 0122).
- Opening a second GUI next to a live host no longer crashes during session restore (patch 0123).
- Tray **Painel** opens a fixed-width list of live terminals by name. Click a row to switch that terminal onto the right. Tray **Janela nova como** picks classic tabs or Painel for new windows (patch 0124).
- Tray left-click always shows the window list; already-open windows are marked with `*` (patch 0125).
- The notification-area icon reappears after Explorer restarts (or if the shell drops it): `TaskbarCreated`, failed `NIM_MODIFY` fallback, and a quiet 15s health check (patch 0126).
- Double-click rename on the pane header uses black text on a white field with a blinking caret, so the typed name stays readable on dark themes.
- Clicking the window X (or Alt+F4) shows the close confirmation immediately instead of waiting three seconds with no dialog.
- “Save as JPEG…” suggests `bethterm-screenshot-YYYYMMDD-HHMMSS.jpg` (not `wezterm-screenshot-<unix>.jpg`) and opens in Pictures. Scrollback Save-As uses the same `bethterm-` prefix and civil timestamp.
- Clicking the window X (or Alt+F4) hides BethTerm to the notification area next to the clock instead of killing the session. Click the icon to restore; right-click picks a hidden window or **Sair** to quit (patches 0105–0107).
- The notification-area icon next to the clock now stays visible as long as BethTerm runs, even with no minimized terminal — its menu is always available (patch 0111).
- A second Desktop/Start Menu shortcut click no longer starts another GPU process or a huge white WGL probe window. It focuses the running GUI. Installer shortcuts omit `--always-new-process` (patches 0108–0109).

### Changed
- Product renamed from WezTerminator to **BethTerm** (named for Elizabeth). Launchers, Settings UI, data directory (`%APPDATA%\bethterm`), and public docs use the new name. The internal crate remains `wtinator`. The previous `%APPDATA%\wezterminator` directory is migrated on first launch. `BETHTERM_ACTIVE=1` enables product mode; `WTINATOR_ACTIVE=1` still works.
- Shipped binaries are `bethterm.exe`, `bethterm-gui.exe`, and `bethterm-host.exe` (Cargo packages still `wezterm` / `wezterm-gui` / `wezterm-mux-server`).
- App menu About reads **BethTerm (based on WezTerm …)**. Quit copy uses BethTerm. `TERM_PROGRAM` stays `WezTerm` so shells still detect the engine.
- Mouse text selection uses the same pixel origin as painting (list-mode strip + per-pane font), so the highlight tracks the click.
- Native Win32 installer/updater `BethTerm-Setup.exe` (no WebView). Each setup embeds the zstd package in the same executable. Suggests the Windows Public folder (detected via `SHGetKnownFolderPath`, not hardcoded), states it writes no registry and uses no hidden folders, can update an existing copy, optional Desktop/Start Menu shortcuts (`pack-bethterm-setup.cmd`).
- App icon is a large **B** over a split-pane window, replacing WezTerm’s `$w`.

### Added (Phase 0 + Phase 1.B/1.D)
- Documentation set: `FEATURES.md`, `CONFIG.md`, `THEMING.md`, `HACKING.md`, `ARCHITECTURE.md`, `IMPLEMENTATION.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `PROJECT_LAYOUT.md`, `SCREENSHOTS.md` (placeholder), `SECURITY.md`, `PRIVACY.md`.
- `IMPLEMENTATION.md` with a phased plan and acceptance criteria.
- `docs/LICENSE-NOTES.md` covering MIT obligations.
- Repository layout documentation in `PROJECT_LAYOUT.md`.
- Cargo workspace at `upstream-wezterm/Cargo.toml` (the upstream is the workspace root) with two new members: `wtinator/` and `wezterminator/`.
- `wtinator` crate: `groups`, `broadcast`, `clipboard`, `config_lua`, `context_menu`, `font_presets`, `shell_menu`, `status_bar`, `picker`, `layout_io`, `vscode_theme`, `vscode_settings`. `context_menu` is fully implemented (native Win32 HMENU builder + dispatch).
- `install()` entry point on `wtinator` that sets `WTINATOR_ACTIVE` env var and runs `config_lua::initialize()`.
- **Patched upstream `wezterm` binary** (patches 0003 and 0004 in `upstream-wezterm/PATCHES.md`) calls `wtinator::install()` before config loads. Verified by `cargo run -p wezterm -- start` opening a wezterm window.
- **Right-click context menu** (Phase 1.B, patch 0009) — a **native Win32 HMENU** built with `CreatePopupMenu` + `AppendMenuW` + `TrackPopupMenuEx`. Three pickers: shell picker (6 shells), split picker (2 directions), and a full menu. Always visible, OS-themed, never occluded.
- **`+` button on the tab bar** (Phase 1.D, patches 0006 + 0009) shows the shell picker on left-click and the full menu on right-click.
- **`│ Split` label on the tab bar** (Phase 1.B, patches 0007 + 0008 + 0009) shows the split picker on left-click.
- Root launchers `run-wezterminator-release.cmd` and `run-wezterminator-debug.cmd`. Both launch this checkout's `wezterm.exe start --always-new-process` and set `WTINATOR_ACTIVE=1` plus debug logging for manual testing.
- `AGENTS.md` with the local agent runbook: use `upstream-wezterm/` as the Rust workspace, build both `wezterm` and `wezterm-gui`, and always launch manual Windows tests with a new process.
- The Windows menu/runbook documentation above was recorded by Codex gpt-5.5.
- CI workflow at `.github/workflows/ci.yml` with Windows / Linux / macOS matrix and `cargo deny` job. **CI must use `nightly-2026-06-05` toolchain.**
- `rustfmt.toml`, `clippy.toml`, `.gitignore`, `.gitmodules` (placeholder).
- Cross-project memory `gterminator-vs-wezterminator.md` documenting the architectural comparison with the sibling Zig project.
- Build-environment memory `phase-0-build-environment.md` documenting the nightly toolchain, Windows PATH (Strawberry perl + nmake), and the dual-binary insight (wezterm.exe + wezterm-gui.exe).
- Local patches tracked in `upstream-wezterm/PATCHES.md` and `upstream-wezterm/patches/`:
  - **0001**: workspace members and dependencies
  - **0002**: chrono `clock` feature (upstream build bug)
  - **0003**: wezterm main calls `wtinator::install()`
  - **0004**: wezterm depends on wtinator
  - **0005**: right-click on terminal pane → Skia overlay context menu (**superseded by 0009**)
  - **0006**: `+` button shows the picker
  - **0007**: LeftStatus/RightStatus opens the split picker
  - **0008**: render `│ Split` label on the tab bar
  - **0009**: **native Win32 HMENU context menu** (the active path)
  - **0010**: right-click opens on button-up; native menus are deferred to the UI/main thread after the mouse callback; `TPM_RIGHTBUTTON` removed
  - **0011**: reentrant `WM_PAINT` and `WM_MOUSELEAVE` use `try_borrow_mut()` guards instead of panic-closing the GUI

### Changed
- `README.md` cross-references resolve to the new docs (16 entries in the Documentation table).
- `docs/ARCHITECTURE.md` adds a section "Alternatives considered" with the gterminator comparison.
- `LICENSE.md` links to `docs/templates/about.hbs` and `docs/THIRD-PARTY-NOTICES.md`.
- `docs/PROJECT_LAYOUT.md` rewritten to reflect the new directory layout (wtinator/ and wezterminator/ live inside `upstream-wezterm/`).
- `docs/IMPLEMENTATION.md` Phase 0 status flipped from ⚠️ partial to ✅ complete. Phase 1.B/1.D added as a new sub-section.
- `docs/ROADMAP.md` v0.1.0 status flipped to 🔵 in progress. Acceptance criteria items 1-4 marked done.
- `docs/FEATURES.md` §1.1-1.5 status tables updated. §1.4 rewritten to describe the native Win32 HMENU (rather than the Skia overlay originally planned).

- `docs/HACKING.md` now documents the Windows launcher rule: always test with `--always-new-process` via the root launchers, never plain `wezterm` from PATH.

### Build environment
- Requires **Rust nightly** (currently 2026-06-05) because upstream uses `edition = "2024"`. `rustup toolchain install nightly` is the only setup step.
- On Windows, `PATH` must include `C:\Strawberry\perl\bin` and the MSVC `nmake.exe` directory, in that order, for OpenSSL to build via `openssl-sys`.
- VS 2022 Build Tools are required for the linker (preinstalled on `windows-latest` GitHub Actions).
- The upstream wezterm build produces **two binaries** (wezterm.exe CLI + wezterm-gui.exe). `cargo build -p wezterm` alone is **not** enough; you must build both: `cargo build --release -p wezterm -p wezterm-gui`.

- Manual Windows runs must use `--always-new-process`; the root launchers enforce this.

### Known limitations (as of 2026-06-06)
- 12 `missing_docs` warnings in `wtinator/` (expected: Phase 0 stubs).
- CI has not been run end-to-end on GitHub Actions yet.
- The `wezterminator` binary (separate from the patched `wezterm`) is a thin placeholder; end users run the patched `wezterm.exe`. On Windows manual tests should use `run-wezterminator-release.cmd` or `run-wezterminator-debug.cmd`.
- The right-click-on-terminal-pane menu (patch 0009) does **not** include "Copy / Paste" sub-menus — those are upstream wezterm text-selection behavior and we do not modify them.
- Nushell and custom shell commands are not yet in the picker.
- Tab groups, broadcast, and the other 1.C-1.D-1.E sub-phases are pending.

### Verified (2026-06-06)
- `cargo +nightly build --release -p wezterm -p wezterm-gui` succeeds.
- `cargo +nightly test -p wtinator` → 7/7 tests pass.
- `run-wezterminator-release.cmd` opens this checkout's release build with `wezterm.exe start --always-new-process`.
- Clicking the `+` button shows a native Win32 popup menu with 6 shells. Selecting one spawns the corresponding shell in a new tab.
- Clicking the `│ Split` label shows a native split picker (Split right / Split down).
- Right-clicking in a terminal pane shows the full menu (shells + splits + close pane).
- Selecting an item from any picker executes the corresponding `KeyAssignment` and the change is visible in the UI.
- The right-click close/crash regression is fixed by patches 0010 and 0011. A helper-thread attempt fixed the panic but broke all menu entry points; the working implementation defers to the UI/main thread.

## [0.0.0] - 2026-06-06

### Added
- Initial repository bootstrap.
- Vendored wezterm as `upstream-wezterm/` (git submodule).
- `LICENSE.md` (MIT).
- `README.md` (draft).
- `docs/ARCHITECTURE.md`.
- `docs/LICENSE-NOTES.md`.

[Unreleased]: https://github.com/<OWNER>/bethterm/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/<OWNER>/bethterm/releases/tag/v0.0.0
