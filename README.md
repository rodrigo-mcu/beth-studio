# Beth Studio

**BethTerm** is a mouse-first terminal for Windows. **Beth Studio** is a second
interface for the same terminals. Together they are one product, named for
Elizabeth.

- **BethTerm** — the terminal engine (a WezTerm fork): the persistent host and the `bethterm` CLI with its bridge. It has no window of its own any more; Beth Studio is the interface.
- **`bethterm-host.exe`** — a persistent process that owns every terminal. Close any window and your shells, agents, and WSL sessions keep running.
- **Beth Studio** — a Go + React app in WebView2: its own tabs and splits, search, files and notes, a database panel, SSH / serial / SFTP, voice dictation, a task manager, detached terminal windows, a tray icon, and access from a browser or a phone. It supervises the host and restores your terminals after a crash.

## Based on WezTerm

BethTerm **started from [WezTerm](https://github.com/wezterm/wezterm)** (Wez Furlong and contributors, MIT). That is the foundation, not an optional credit.

WezTerm already has tabs, splits, a multiplexer, SSH, GPU rendering, ligatures, image protocols, and `wezterm.lua`. What it does **not** do as a default is treat the mouse as a first-class way to use the terminal on Windows. The stock UX is keyboard- and Lua-first: new tabs, splits, themes, and fonts are things you bind or configure, not things you click.

BethTerm keeps that engine and adds a Windows workflow you can use without a config file. The WezTerm tree is vendored in [`upstream-wezterm/`](upstream-wezterm/). BethTerm-specific code is the delta on top. Every edit to an existing WezTerm file is listed in [`upstream-wezterm/PATCHES.md`](upstream-wezterm/PATCHES.md).

This is an **independent** fork. It is not affiliated with or endorsed by Wez Furlong or the WezTerm project. Attribution lives in [`NOTICE.md`](NOTICE.md) and the origin policy in [`docs/ORIGIN.md`](docs/ORIGIN.md). How the project got here: [`docs/HISTORY.md`](docs/HISTORY.md). Which WezTerm commit it started from, the exact diff, and the policy for upstream changes: [`docs/UPSTREAM.md`](docs/UPSTREAM.md).

> **Language.** The Beth Studio interface and several of its documents
> (`bethterm-web/`, some files under `docs/`) are in Brazilian Portuguese.
> The rest of the documentation is in English.

---

## Features

The full list is [`FEATURES.md`](FEATURES.md). A short tour:

### The persistent host

- `bethterm-host.exe` owns the terminals. Beth Studio attaches to it through `bethterm cli bridge`, so closing the Studio never kills a terminal.
- Inherited from WezTerm, unchanged: the multiplexer, SSH domains, and the terminal emulation core.
- `host-life.log` records every start, stop, and who asked for it.

### Beth Studio

- Its own tabs and splits, drag-and-drop, per-terminal theme and font, search by title, folder, tab, or screen text; views by your layout, by host window, by type, or by folder.
- **Detached terminals**: send a terminal or SSH session to its own window (it can go to another monitor) and drop it back onto the tab bar. Closing that window does not stop the terminal.
- Text and Markdown editor, notes, file preview, and a folder browser.
- Database panel (PostgreSQL, MySQL / MariaDB, SQL Server, SQLite): browse, query, edit cells and rows, saved queries and history.
- SSH hosts, serial ports, and an SFTP window.
- Voice dictation into the focused terminal, with a technical vocabulary.
- Task manager with per-terminal and WSL memory.
- Tray icon with a system menu; supervises the host and restores terminals after a crash.
- The whole Studio in a browser, and a phone web app (see [Remote access](#remote-access)).

---

## Build from source (Windows)

### BethTerm and the host (Rust)

Requirements:

- **Rust nightly** (`rustup toolchain install nightly`). Upstream uses `edition = 2024`.
- **Strawberry Perl** and the **MSVC** toolchain on `PATH` (Perl is needed to build `openssl-sys`).

```powershell
git clone <this-repo>
cd beth-studio\upstream-wezterm

# Perl + MSVC must be on PATH (adjust the MSVC version to yours):
$env:PATH = 'C:\Strawberry\perl\bin;' + $env:PATH

cargo +nightly build --release -p wezterm -p wezterm-mux-server
```

That produces `bethterm.exe` (CLI and bridge) and `bethterm-host.exe`
(persistent PTY process). The Cargo packages are still named `wezterm` /
`wezterm-mux-server`.

From the repository root, `run-bethterm.cmd` starts this checkout's
`bethterm-web.exe` (Beth Studio). It does not use a system-installed WezTerm.

### Beth Studio (Go + React)

Requirements: **Go 1.24+**, **Node.js** with **pnpm**, and the Microsoft Edge
**WebView2 Runtime** (already on current Windows 10 and 11).

```powershell
cd bethterm-web
.\build.ps1          # builds the React frontend, then bethterm-web.exe and bethterm-tool.exe
```

`bethterm-web.exe` talks to the host through `bethterm.exe cli bridge`, so keep
it next to `bethterm.exe`, or pass `--bethterm <path>`. Run it directly (or
from a shortcut); it starts and supervises the host and puts its icon in the tray. More in [`bethterm-web/README.md`](bethterm-web/README.md).

### Installer / updater (native Win32 + embedded zstd)

The setup UI is a native Windows window (no WebView). Each `BethTerm-Setup.exe`
embeds the zstd payload in the same executable (single file). Build the Rust
binaries and Beth Studio first, then:

```cmd
pack-bethterm-setup.cmd
```

That produces `dist\BethTerm-Setup.exe` with `bethterm.exe`,
`bethterm-host.exe`, `bethterm-web.exe`, `bethterm-tool.exe`, ConPTY
(`OpenConsole.exe`, `conpty.dll`), and
licenses packed inside.

The installer suggests the machine's Public folder (typically `C:\Users\Public\BethTerm`). It is a portable install: no registry, no hidden folders; everything lives in that directory. It can update an existing copy and can create Desktop/Start Menu shortcuts. Updating while the host is running stages the new host binary and applies it on the next host start; it never stops your terminals unless you ask.

---

## Configuration

BethTerm reads your existing **`wezterm.lua`** / **`.wezterm.lua`** unchanged. BethTerm-specific options currently live under a `wtinator = { ... }` table (the historical crate name). Most features are mouse-driven and need no config.

Runtime data (session, downloaded themes, favorites, default theme, Beth Studio settings) lives in:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\bethterm\` |
| macOS / Linux | `~/.config/bethterm/` |

See [`docs/CONFIG.md`](docs/CONFIG.md) for the option reference.

---

## Remote access

Beth Studio listens only on `127.0.0.1`, on a random port, and requires a random
token on every request.

Opening the Studio from another browser or from a phone is optional and needs a
small relay that **you** run on your own Linux server:
[`bethterm-web/cmd/bethstudio-proxy`](bethterm-web/cmd/bethstudio-proxy). The
phone page is a separate build (`bethterm-web/frontend/phone.html`). Nothing
leaves your machine unless you set this up. Design notes:
[`docs/superpowers/specs/2026-09-27-celular-remoto-design.md`](docs/superpowers/specs/2026-09-27-celular-remoto-design.md).

[`bethterm-mobile/`](bethterm-mobile/) is an early Expo skeleton and is not the
phone path that ships.

---

## How the tree is laid out

| Path | What it is |
| --- | --- |
| `upstream-wezterm/` | The vendored WezTerm tree plus the BethTerm delta. |
| `upstream-wezterm/wtinator/` | The BethTerm delta crate. Almost all new Rust code lives here. |
| `upstream-wezterm/PATCHES.md` | Index of every edit to *existing* upstream files. |
| `bethterm-web/` | Beth Studio: Go backend, React frontend, SSH/serial helper, phone proxy. |
| `bethterm-mobile/` | Early Expo skeleton (not the shipped phone path). |
| `docs/` | Architecture, configuration, history, specs, and plans. |

Existing upstream files are changed only as documented patches. The crate name `wtinator` is historical and kept so the patch series stays bisectable.

---

## License

**MIT** — the same license as upstream WezTerm. See [`LICENSE.md`](LICENSE.md).

BethTerm is a derivative work of [WezTerm](https://github.com/wezterm/wezterm), © Wez Furlong and contributors. Upstream copyright notices are preserved. New code is © the BethTerm contributors, also under MIT.

Bundled fonts remain under their original OFL terms (see `upstream-wezterm/LICENSE.md`).

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/HACKING.md`](docs/HACKING.md).

Please **do not** file WezTerm-core bugs here when they also exist upstream — send those to [wezterm/wezterm](https://github.com/wezterm/wezterm). BethTerm-specific host, session, and bridge code, and Beth Studio belong here.

Security reports: see [`SECURITY.md`](SECURITY.md).

---

## Acknowledgements

- **[Wez Furlong](https://github.com/wezterm)** and the WezTerm contributors — the foundation this is built on.
- **[Terminator](https://gnome-terminator.org/)** — the split-grid UX that inspired the mouse-first layer.
- **[Gogh](https://github.com/Gogh-Co/Gogh)** — the community theme catalog.
- **[VS Code](https://github.com/microsoft/vscode)** — theme palette and font-settings conventions.
- **Elizabeth** — the name.

This project has been developed with the help of AI coding agents. The engineering log of every change lives in [`upstream-wezterm/PATCHES.md`](upstream-wezterm/PATCHES.md).
