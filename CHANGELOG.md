# Changelog

All notable changes to Beth Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Indicator for the whole-screen zoom: a "Zoom N%" pill when it is not 100% (click to reset) and a "Redefinir para 100%" button in Configurações > Aparência.

### Fixed
- Patch 0202: the host no longer takes a snapshot of every process on the machine once per pane every 2 s. All panes share one snapshot per second; with 30 panes and ~580 processes the host went from ~6 cores to 0.04 while the Studio is open.
- Switching between terminal tabs no longer flickers or leaves the text scaled wrong when the WebGL renderer loads.

## [0.3.1] - 2026-10-26

### Added
- **Falar**: history of the last 20 transcriptions inside the voice window (copy, paste again, remove, clear). Each speech is saved right after transcription, before being pasted into the terminal.
- **Configurações > Terminais > Desempenho**: choose how the terminal is drawn (Automático, Sempre WebGL, Modo compatível) and set up the Windows Defender exclusions for the Studio folders, with a step-by-step guide, a button that opens Windows Security and a button that asks for administrator permission (UAC) to add or remove them. Never available in the remote browser or read-only mode.

### Changed
- The terminal uses the WebGL renderer when the graphics card allows it, with automatic fallback to the DOM renderer (`@xterm/addon-webgl` 0.19.0). Terminals beyond 8 at once use DOM.
- The terminal redraws only the lines that changed instead of the whole screen on every frame.
- With the window hidden in the tray or minimized, the Studio's WebView2 is set to not visible and to low memory use, and back to normal when shown. Turn off with `BETHSTUDIO_WEBVIEW_NO_BG=1`.
- Patch 0201: `bridge-latency.log` records `prog=<program>` instead of the terminal title; old logs with titles are deleted once.

### Fixed
- A hyperlink (OSC 8) still open at the end of the last screen line no longer leaks to the first line of the next frame (the whole line was drawn underlined).

## [0.3.0] - 2026-10-18

### Added
- Phone: **Conectar um celular** (Configurações → Celular → Aparelhos conectados) shows a QR code and a link that sign the phone in without typing the domain or password. The link is single use and valid for 5 minutes; the token travels in the URL fragment and is exchanged by a POST for a normal session cookie. (Studio update needed.)
- Phone: **Aparelhos conectados**. Each phone that enters is a named device (suggested from the browser, editable) with creation date, last use and last IP. Rename, revoke one (its session and open WebSocket drop at once) or revoke all. Sessions expire after 90 days without use (365 at most); the old phone password still works, creates a device too, and changing it does not revoke paired devices. Sessions of the old `phone-sessions.json` are migrated to devices. (Studio update needed.)
- Phone: the offline page and screen show "Visto pela última vez às HH:MM de dd/mm" and retry by themselves. (Studio update needed for the screen; server (`bethstudio-proxy`) update needed for the time.)
- Phone link: `bethstudio-proxy` caps `/api/phone/login` and `/api/phone/pair` at 20 attempts per minute per address. (server (`bethstudio-proxy`) update needed.)
- **Instalar servidor** (Configurações > Celular): a wizard that installs the phone server on a clean, dedicated Debian/Ubuntu VPS, in two independent parts: an optional "Endereço (DNS)" (Cloudflare token + server IP creates the name; skip it if your DNS is elsewhere) and "Servidor (VPS)" (the SSH login, asks you to confirm the server fingerprint, checks the VPS is clean and compatible (and stops without changing anything if not), checks the name points to the VPS and says which record to create if not (the DNS record made in part 1 is DNS only; the orange cloud is not offered), installs `bethstudio-proxy` (embedded in the Studio for linux/amd64 and linux/arm64, SHA-256 checked) as the only program on the server, with automatic HTTPS from the proxy itself (no Caddy, no extra apt repository), enables ufw (SSH, 80, 443) and unattended security upgrades, pairs this Studio by itself and tests end to end, ending with a QR code). Rerunning fixes instead of duplicating; update, state/logs, change phone password and remove are available afterwards. SSH passwords and the Cloudflare token are never written to disk or logs. (Studio update needed; `build.ps1` now cross-compiles the proxy and embeds it.)
- Native phone app (`bethstudio-mobile/`, Expo, Android and iOS): a thin shell that loads the phone web app from your domain in a WebView. It asks for the domain and the phone password once (secure storage, HTTPS only) and logs in by itself. The microphone permission is asked once by the system (`NSMicrophoneUsageDescription` / `RECORD_AUDIO`).
- Native audio recording straight to files on the device, in closed 2-minute pieces, so a suspended or killed app does not lose what was already recorded. Recordings go to a persistent queue and are sent to the PC with the same retry policy as the web app (2, 4, 8, 15, 30 s, 6 attempts); **Tentar de novo**, **Baixar** and **Descartar** stay on screen. The text is put in the open terminal message field.
- Quick reconnection in the native app: coming back to the app or the network coming back retries the queue at once, reloads a page that failed to load and wakes the web app connection watchdog.
- EAS build profiles for internal distribution (`eas.json`) and the publishing guide `bethstudio-mobile/docs/PUBLICACAO.md`. Bundle identifiers are placeholders (`com.exemplo.bethstudio`).

- `bethstudio-proxy` **own HTTPS mode** (`-tls`): serves 443 and 80 by itself with a Let's Encrypt certificate obtained and renewed automatically (`golang.org/x/crypto/acme/autocert`, one domain only, cache in `<data>/certs` with mode 0700, `-acme-email`, `-acme-staging`), redirects HTTP to HTTPS, TLS 1.2+, HSTS (180 days, no subdomains, off in staging) and `nosniff`, HTTP/2 off so WebSocket stays on HTTP/1.1. The client IP is the TCP peer, never `X-Forwarded-For`. With `-service` the unit runs as the `bethstudio` user with `CAP_NET_BIND_SERVICE` only. The `-listen` modes behind your own HTTPS proxy are unchanged. (server (`bethstudio-proxy`) update needed.)

### Changed
- **Instalar servidor** no longer installs Caddy: the owner decided that no extra program may live on the server. The proxy serves HTTPS itself; the wizard now creates the `bethstudio` service user, installs the unit in `-tls` mode, waits for the certificate and tests end to end. Remove also deletes the service user and the certificates. The orange-cloud DNS option was removed (it gets in the way of the certificate challenge). (Studio update and server (`bethstudio-proxy`) update needed.)
- Phone: a wrong, used or expired QR link counts as a failed login for the per-address lock (5 errors, then 1 to 15 minutes). (Studio update needed.)
- `bethstudio-mobile` no longer contains the unused WebSocket client and xterm terminal skeleton (it stays in the repository history up to commit 349c55a). The architecture is in `bethstudio-mobile/docs/ARQUITETURA.md`.

### Known limits
- The native app was not built or run on a device yet. Notifications with the phone locked are not part of this version (they need a push sender on the PC).

## [0.2.5] - 2026-10-17

### Fixed
- Phone: a recorded audio is no longer lost when sending fails. It is kept (in memory and in the browser storage) until the transcription works. If the network or the PC does not answer, the app retries by itself (2, 4, 8, 15, 30 s, up to 6 times) and shows the countdown; afterwards **Tentar de novo**, **Baixar** and **Descartar** stay on screen, also after reloading the page.
- Phone: the connection no longer stays dead after the screen turns off or the network changes. The app probes the PC every 20 s and reconnects at once when the socket does not answer, when the network comes back and when you return to the app.
- Phone: "O PC está desconectado do servidor" appears only after three failed checks in a row (3 s apart), not after a single failed one.
- Phone link: the keepalive of the PC-to-server link is 10 s (was 30 s), so a dead session is noticed and replaced sooner. (Studio update needed; the server program `bethstudio-proxy` needs the new build too.)

## [0.2.4] - 2026-10-16

### Added
- WSL init on restore: when the folder of a WSL terminal does not exist after a restart (the WSL has not mounted its disks), the banner asks whether to run the distro's init command; it runs in a visible WSL terminal and the Studio waits for it before opening that distro's terminals. Terminals whose folder still does not exist wait in the banner (**Continuar tentando**, **Guardar**, **Abrir na pasta padrão**, **Descartar**) instead of opening in the home folder, and their recipe is kept. Configured in **Configurações > Terminais > WSL** (per distro, with **Testar agora**). (Studio update needed.)
- The **Falar** window floats without dimming or blocking the screen and is dragged by its title bar, so it no longer covers the text you are reading. It remembers where you left it.
- Diagnostic log lines `layout: …` record every time a terminal moves from one tab to another (and which action did it), what the interface saved, and what it loaded at startup. They go to `bethstudio-web.log`, and also to `host-life.log` once the Studio is updated.

### Changed
- The silent init command of `wsl-distros.json` no longer runs before every WSL terminal; the file is imported once into Configurações > Terminais > WSL and renamed `wsl-distros.json.migrado`. (Studio update needed.)
- Grid: a terminal that is in no tab now says "Sem aba — clique para abrir" instead of "Não organizado".

### Fixed
- Terminals appeared as PowerShell when they were WSL (and the reverse) in the grid and in the restore recipe: an old `pane-commands.json` from before the rename (domain `bethterm-host`) overrode the real type of terminals that reused those ids. Entries of other domains are now ignored, and the Studio's own record of what it spawned takes priority over that file. (Studio update needed.)
- The restore recipe no longer forgets the work folder of a WSL terminal that opened broken (`wslhost.exe`, folder `/`): it keeps the folder the recipe had until the shell really starts. (Studio update needed.)
- Reloading the interface no longer puts terminal 0 side by side with the terminal in the active tab: a missing or empty `open=` was read as terminal 0 (`Number("")` is 0). Also, `--open <ids>` no longer pulls a terminal out of the tab it was already in, and the parameter is applied once and removed from the address.

## [0.2.3] - 2026-10-15

### Added
- Terminal: a folder path in the output (absolute and without extension, such as `/mnt/data/dir/` or `~/dir`) is now a link that opens the folder in Explorer. In a WSL terminal it opens the WSL folder on Windows. The folder path in the terminal header opens the terminal's current folder the same way. Slash commands, dates and `and/or` are not links.
- Tray icon menu: **Reiniciar interface** reloads the Studio page without touching the host, the terminals or the Studio process.

### Fixed
- Terminal cursor: a theme whose cursor color has little contrast with its background (32 of the 455 bundled themes) is pushed to black or white so the cursor is always visible, and the cursor block over dim text (placeholders) is no longer drawn at half opacity.
- A terminal saved in two tabs (a corrupt layout) used to vanish from one of them silently, which looked like two terminals side by side in the wrong tab. The Studio now keeps it in the tab where it is alone (else the first), saves the fixed layout and shows a notice saying where it stayed.
- Text that reaches a terminal without a key press (Windows voice typing, touch keyboard, emoji picker, some input methods) was silently dropped when the terminal had been idle for 1.5 s. It now counts as user input.

### Changed
- **Todos os terminais**: a terminal alone in a tab (or in a closed tab) is shown with the tab's name, the same one the tab bar shows. Search still matches the terminal's own title.

## [0.2.2] - 2026-10-14

### Added
- **Todos os terminais** and the phone grid: a second chip row filters by terminal type (WSL, PowerShell, cmd, SSH, Serial and the other groups the sidebar already uses, plus Agentes). Chips are only the types present, in the sidebar's group order. State, type and search combine. Each row's counts follow the other filters. An ended terminal has no stored type and only matches Todos. **Limpar filtros** clears state, type and search. The grid filter does not change the sidebar filter.
- Site: a "Se a interface travar, os terminais continuam" section with a before/after proof, a GitHub button and MIT badge in the header, and screenshots of the database panel and SSH.

### Fixed
- Pasting a file or image into a WSL terminal opened by the Studio now converts the path to `/mnt/c/...`. The host lists such a terminal's cwd as a Windows folder, so the check looked only at the cwd and treated the pane as Windows; it now also uses the pane's WSL flag.
- The restore progress could be delivered out of order when several terminals started at once, so the bar could move backwards. Updates are now delivered in order.

### Changed
- The copyright notice carries the author's full name (licenses, third-party notices and the site footer).

## [0.2.1] - 2026-10-14

### Fixed
- The installer, the wiki install page and the phone page use Brazilian Portuguese ("arquivo", "Registro", "Área de Trabalho", "conexão") instead of European Portuguese.
- Clicking a file path in terminal output opens more than preview types: PDF, Office documents, archives and other existing files open in the Windows default program. Text and images still open in the preview panel. Programs and scripts are shown in Explorer instead of being launched.
- With mouse tracking on, Ctrl+click (or Cmd+click) opens the link and the hover hint says so; a plain click still goes to the program. OSC 8 hyperlinks open their real http(s) target in the default browser.

### Added
- Site (`site/`, Portuguese and English) with real screenshots of the Studio on Windows 11, and a `Pages` workflow that publishes it to GitHub Pages.
- Settings → About → **Verificar atualização** checks the latest published GitHub release. You can install only the interface (the Studio and the host keep running) or download the installer for the Studio and the host. Nothing is installed until you choose. Read-only mode and the remote browser only report that a newer version exists. The phone page does not offer this.
- README links to the site (GitHub Pages), in Portuguese and English.

## [0.2.0] - 2026-10-14

### Changed
- Docs: the README and the FAQ say that Linux and macOS ports are planned (no date, no commitment).
- Docs: the whole project is MIT; `LICENSE.md`, `NOTICE.md` and the README say so.
- Docs: the README now opens with the problem it solves (terminals dying when the interface hangs) and highlights the persistent host, interface reload without stopping the hosts, daily use with about 35 terminals (the author's experience, not a benchmark), the built-in task manager, and image and file paste for agents.

### Added
- Database connection form: a **Selecionar** button next to **Banco inicial** connects with the form's data and lists the databases to pick from (PostgreSQL and SQL Server).

### Fixed
- PostgreSQL and SQL Server connections with an **Banco inicial** filled in open only that database (tree and query panel) instead of listing every database the user can reach.

### Added
- Phone web app: grid view of all terminals (screen print, name, folder, type, tab), toggled from the list header. The grid has the desktop's search (name, folder, type, tab, #id, optional screen text) and the Em abas / Sem aba / Encerrados filters.
- **Todos os terminais**: a grid button next to **+** opens a searchable popup with a screen print, name, type, folder and tab of every terminal, including those in closed tabs.
- The Beth Studio screen can be updated on its own (`bethstudio-web/deploy-ui.ps1`, **Configurações > Sobre > Recarregar interface**), without restarting the Studio or the host. A package that needs a newer Studio is ignored.
- `release.ps1`, `RELEASING.md` and a GitHub Actions workflow produce the installer, a portable zip, a UI-only zip and `SHA256SUMS.txt`, with the third-party license texts included.
- `SUPPORT.md` says what is supported.
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
