# Beth Studio — Complete Feature Catalog

> **What this document is.** A catalog of **everything that was actually built
> and shipped** in Beth Studio, organized by area, with the patch numbers
> that implement each feature and a short user-facing description.
>
> For the original forward-looking **design spec** (with planned/future ideas),
> see [`docs/FEATURES.md`](docs/FEATURES.md). For the exact diffs, rationale and
> revert procedure of every change, see
> [`upstream-wezterm/PATCHES.md`](upstream-wezterm/PATCHES.md) and the
> per-patch notes in [`upstream-wezterm/patches/`](upstream-wezterm/patches/).
>
> When a user-facing feature is added, changed, or removed, update this
> file in the same change (`.cursor/rules/features-catalog.mdc`).

Last updated: 2026-10-14.

---

## Participants & Credits

Beth Studio was built as a relay between **Rodrigo** and a team of AI
collaborators. Every feature was requested, directed, and acceptance-tested by
Rodrigo; the AI models did the design and implementation under his direction.

| Participant | Role / known contributions |
| --- | --- |
| **Rodrigo** | Owner, product director, and tester. Drove every feature request, made the design/UX calls, ran every build on real hardware, and signed off (or sent back) each result. The whole product is his vision; he is the committer of record on the entire history. |
| **Codex (GPT‑5.5 / GPT‑5)** | Phase‑0 build environment and toolchain (nightly + Strawberry Perl + MSVC), vendoring of upstream wezterm, the custom **integrated title bar & Windows window controls** (patch 0020), and the manual Windows launch/testing conventions. See `HANDOFF.md`, `AGENTS.md`, `docs/2026-06-07-codex-titlebar-window-controls.md`. |
| **Claude (Opus 4.8)** | The post‑titlebar delta onward: image paste & screenshots, dark‑theme cursor fixes, tab groups / session save‑restore / per‑terminal headers / rename dialogs, drag‑and‑drop & VS‑style pane docking, the theme downloader & browser, the full **per‑terminal font & theme system** with all of its correctness fixes, and the later UX round — smarter hyperlink open + per‑pane hover, WSL image‑paste path rewrite, on‑disk favourites that became theme+font **presets**, and the Claude‑waiting **tab alert** (patches ~0025 and 0028–0063). |
| **MiniMax M3** | Collaborator across the native‑menu, theming, tab‑groups and IPC groundwork. |
| **GLM 5.1** | Collaborator across the native‑menu, theming, tab‑groups and IPC groundwork. |

> Per‑commit authorship lives in the git history and the `HANDOFF*.md` /
> `STATUS.md` notes. Where the repo records a specific author for an area, it
> is noted above; the remaining groundwork was a shared effort across the AI
> collaborators listed.

---

## What Beth Studio is

**Beth Studio** is the product. It is more than a terminal: the Studio and a
phone page for talking to agents, on top of a persistent host. The native
window that used to exist was removed in Phase B (see
[`docs/HISTORY.md`](docs/HISTORY.md)). It is a **Windows‑focused
distribution of [wezterm](https://wezterm.org)** built as a thin **delta** on
top of a vendored upstream snapshot:

- **`upstream-wezterm/`** — a vendored, mostly read‑only copy of wezterm. It
  keeps wezterm's terminal core and multiplexer.
- **`wtinator`** — the Beth Studio delta crate: host helpers, themes, groups,
  session persistence, notifications, etc. Wired into the upstream binary
  through a single `wtinator::install()` hook (patch 0003).
- **Binaries**: `bethstudio.exe` (CLI and `cli bridge`), `bethstudio-host.exe`
  (every PTY), and `bethstudio-web.exe` (**Beth Studio**, Go + React in
  WebView2, supervises the host). The Cargo package names are still
  `wezterm` and `wezterm-mux-server`.

Build & run conventions live in `AGENTS.md` and `upstream-wezterm/PATCHES.md`;
the short version is at the end of this document.

Status legend: 🟢 shipped · ⚪ planned.

---

- 🟢 **Interface atualizável sem reiniciar** — the Beth Studio screen can be replaced on its own: `bethstudio-web\deploy-ui.ps1` installs a new interface package under `%APPDATA%\bethstudio\ui\current`, and **Configurações > Sobre > Recarregar interface** (or F5) applies it. The Studio process, the host and the terminals are not restarted. The previous package is kept for `-Rollback`. A package that needs a newer Studio, or a broken one, is ignored and the interface built into the executable is used.
- 🟢 **Verificar atualização** — **Configurações > Sobre > Verificar atualização** compares the running version with the latest published GitHub release. If a newer one exists, you choose: install only the interface (no restart) or download the installer for the Studio and the host. Nothing is installed until you confirm. Read-only mode and the remote browser only say that a newer version exists. The phone page does not have this.
- 🟢 **Painel de voz não fecha por clique fora** — while recording, transcribing, correcting or reviewing text, a click outside the voice panel no longer cancels it; only the buttons or Esc do.

## 1. Removed in Phase B (native window)

The native window (`bethterm-gui.exe`, crate `wezterm-gui`) and its companion
Settings app (`wtinator-config`) were removed in Phase B. Everything that only
existed there is gone: the native right‑click menus and their shell, clipboard
and hyperlink behavior, per‑pane font size / family / bold / italic, the
smooth cursor, tab groups and per‑terminal headers with native rename and
close dialogs, drag‑and‑drop tab reordering and VS‑style docking, the custom
title bar and window controls, the window‑level tray (**Janela nativa**,
**Painel**, **Esconder tudo**, **Reiniciar a janela nativa**, **Desenho**
GPU/CPU), image paste and screenshots, Ctrl+C / Ctrl+V and zoom keybindings,
VS Code font auto‑config, and the config app's theme browser. The subcommands
`bethstudio gui-restart`, `start`, `ssh`, `serial`, and `connect` now fail with
a message asking you to use Beth Studio. See `docs/HISTORY.md`.

## 2. Shells

🟢 Quick‑launch entries for **cmd.exe, PowerShell 5.1, PowerShell 7+, WSL
(default + named distros), Git Bash**, surfaced in Beth Studio's new‑terminal menu. Optional
**MobaXterm local bash** entry appears when its local path exists (patch 0026),
and users can add their own entries in `%APPDATA%\bethstudio\shells.json`
(patch 0183).

## 3. Themes

- 🟢 **Theme catalog from disk** — the Studio lists the built-in themes plus every
  `.json` theme saved under `%APPDATA%\bethstudio\themes\` (Gogh format) and VS Code
  themes. It does **not** download them: the one-click Gogh downloader (patch 0038)
  belonged to the removed native app, so the folder has to be filled by hand.
- 🟢 **Favourites persist on disk** as theme presets in
  `%APPDATA%\bethstudio\theme-favorites.json`, shared with Beth Studio.
- 🟢 **Default theme for all terminals** — saved to
  `%APPDATA%\bethstudio\default-theme.json` and applied to new terminals that
  have no theme of their own (patch 0110).

## 4. Session & persistent host

- 🟢 **Persistent PTY host** — shells live in `bethstudio-host.exe`. Closing or
  updating Beth Studio does not kill agents. Reopening attaches to the same
  panes (patch 0121). The Studio also recreates terminals after a host crash
  (see section 7).
- 🟢 **Session file** — `%APPDATA%\bethstudio\session.json` is written
  atomically in the background with a 2 s timeout, and restore drops
  unreachable network/WSL working directories after a 300 ms probe
  (patches 0029, 0049).

## 5. Windows stability

🟢 Patch **0113** hardens the Windows host so a busy pane or a slow disk
cannot freeze it:

- `ClosePseudoConsole` runs on a helper thread **after** the ConPTY pipes
  drop (Microsoft's documented order). The hanging `INHERIT_CURSOR` flag
  is off.
- Sistema disk sampling times out at 250 ms and reuses the last sample.
- Shipped `conpty.dll` + `OpenConsole.exe` are the Microsoft 1.24 pair
  (`1.24.2604.02001`).
- 🟢 **Encerrar host** — tray **Encerrar tudo** confirms, then stops the
  host (patch 0122). A setup while the host is live writes
  `bethstudio-host.exe.new` and swaps it on the next host start.

## 6. Build / integration foundation

🟢 Workspace wiring so the vendored upstream is the workspace root, a chrono
`clock` feature fix, and the `wtinator::install()` hook in the upstream binary's
`main()` (patches 0001–0004, by Codex).

## 7. Beth Studio

🟢 The interface for the terminals (`bethstudio-web.exe`, tray label
**Beth Studio**, patches 0171–0173, 0186). It talks to `bethstudio cli bridge`
and supervises the host (starts it, restarts it after a crash, never stops
it without a confirmed **Encerrar tudo**). Closing a Studio tab does
not kill a terminal; **Encerrar terminal…** asks first (patch 0180).

- 🟢 **Alt does not open the window menu** (2026-10-03) — a tap on Alt (or Alt+letter) no
  longer opens the Windows system menu over the Studio and detached terminal windows, so it
  does not steal focus while you type in a terminal. Alt+Space still opens it.
- 🟢 **Studio supervises the host and has its own tray icon** (2026-10-03).
  Opening the Studio without a running `bethstudio-host.exe` starts it. If the
  host crashes it is restarted, at most 3 times in 10 minutes; after that a
  banner says **Host indisponível** with **Tentar de novo**. Closing the window
  hides it to the tray. The tray menu has **Beth Studio**, **Novo terminal**,
  **Sistema**, **Sair da bandeja** (terminals keep running) and **Encerrar
  tudo** (asks first, then closes every terminal). The icon gets an amber dot
  while an agent waits for you.
- 🟢 **Terminals come back after a host crash** (2026-10-03). The Studio keeps a recipe
  for every live terminal in `%APPDATA%\bethstudio\pane-specs.json` (shell, folder, WSL
  distro, saved SSH host or serial port). When the host comes back **empty and as a
  different process**, it recreates them in the same tabs and folders and re-links names
  and themes to the new ids. A terminal closed on purpose never comes back. A banner
  shows the progress and, at the end, anything that did not return.
- 🟢 **Smart WSL start** (2026-10-03). Before a WSL terminal opens, the Studio waits for
  the distro to answer, runs the optional per-distro init command once per VM boot
  (`%APPDATA%\bethstudio\wsl-distros.json`: `{"Debian":{"init":"...","user":"root","timeout_sec":60}}`)
  and waits for the folder to exist; if it never does, the terminal opens in the home folder,
  not in `/`. The same wait applies to **Novo terminal** on a stopped distro (patch 0197 makes
  `--cd` and `-d` work).
- 🟢 Own tabs and splits (drag, new terminal to the right / below / above /
  left), views **Minha organização**, **Como no Beth Studio**, **Por tipo**,
  and **Por pasta** (groups by each terminal's current folder, follows
  `cd`; same-named folders get their parent). Every card shows the folder
  name in bold and the start of the path dimmed (2026-09-29).
  Search by title, folder, tab, host window, id, and optional screen text.
- 🟢 **Tool buttons in the side panel**: SSH/Serial, open/new file, speak,
  tasks, database and settings sit in a row under "Beth Studio" in the left
  panel, so the tab bar is left to the tabs. With the side panel collapsed
  they go back to the tab bar (2026-10-02).
- 🟢 **Destacar em janela**: a terminal or SSH session can leave the tabs
  and become its own window (button in the terminal header, or
  **Destacar em janela** in the terminal menu). The window can go to another
  monitor. Drag its title bar over a pane, tab or "+" of the Studio to put it
  back, or click **Encaixar**. Closing the window does not stop the terminal:
  it keeps running and goes back to the terminal list (PC only, not in the
  remote Studio or the phone) (2026-10-02).
- 🟢 Opening shows progress instead of a blank window: the Studio window
  says "Abrindo Beth Studio…", then a spinner with the current step
  (connecting, terminal list, "Abrindo os terminais desta aba (2 de 6)").
  After 10 s it offers **Tentar de novo** / **Mostrar assim mesmo**. Each
  opening logs its phase times (`abertura` in `bethstudio-web.log`). Only
  one Studio runs: opening it again brings the open window to the front
  (2026-09-29).
- 🟢 **Nova aba** → **Pasta inicial** has **Procurar…**. It opens the Windows
  folder dialog and fills the path. A WSL shell receives `/mnt/…` when the
  chosen folder is on a drive letter, and `/home/…` when it is inside the
  Linux distro (`\\wsl.localhost\<distro>\…`). In the remote Studio it opens
  the in-page folder browser instead.
- 🟢 **Navegador de pastas** inside the page (remote Studio "Procurar…" and
  "Abrir arquivo", and "Salvar" of a new text): shortcuts for the user
  folder, every drive and every WSL distro; clickable path trail (click the
  empty part to type or paste a path); **Nova pasta**; double-click enters
  a folder or opens a file (2026-09-30).
- 🟢 **Celular** is its own web app, not the Studio page: a separate build
  (`frontend/phone.html`, `src/phone/`, output `dist/phone`) and the only
  thing the phone domain serves. It can be installed on the home screen
  (manifest, icons, service worker; opens even when the PC is offline and
  says so). Theme: Automático (follows the phone), Claro or Escuro, plus
  Grafite, Nord, Dracula, Solarized escuro, Solarized claro and Alto
  contraste (each checked for text contrast), in the list menu and the text
  menu, saved on the phone. The message field uses the terminal's
  monospace font and follows its text size. It lists each running terminal
  once, with agents waiting on you first and how long they have waited,
  then one terminal in large text with history scroll, text size and
  line-wrap options, and the agent's `───` rules drawn as thin dividers.
  Quick keys send 1, 2, 3, ↑, ↓, Enter and Esc for agent menus.
  **Falar** records with a live level meter; the transcription (and the
  AI correction, streamed) lands in the composer for review, with
  **Voltar ao que foi transcrito** and **Apagar**. Nothing goes to the
  terminal until **Enviar**, which pastes and presses Enter. Dictating
  again adds to the text. Drafts survive leaving and returning to a
  terminal. Audio goes to this computer and is transcribed here; the phone
  never gets the provider address or key. On iPhone, when Safari's
  recorder returns an empty file, the phone sends the audio as WAV
  recorded in parallel. An expired session returns to the login screen.
  The list shows the tab name given in Studio and the terminal's folder,
  has a search box (name, folder, type, host; accents ignored) and type
  chips (Agentes, WSL, PowerShell, cmd, Git Bash, SSH) showing only the
  types present, and puts the terminal opened last on this phone at the
  top (agents waiting on you stay in their own section above). **Anexar
  imagem ou print** saves the picture on this computer (large photos are
  reduced to JPEG first) and adds its link to the message; it goes to the
  terminal only with **Enviar**. Tapping the terminal text opens the
  keyboard in the message field, and the app follows the visible area
  when the keyboard opens.
  The Studio **Falar** button still pastes without Enter.
- 🟢 **Studio completo pelo navegador**: the whole Studio opens on another
  computer at `https://<phone domain>/studio/`, through the same
  `bethstudio-proxy`. Off by default; turned on in Configurações → Celular
  after setting up a second factor (authenticator app, QR shown there).
  Sign-in is the phone password plus the 6-digit code; the session closes
  after 12 h without use and after 7 days. The same screen lists open
  sessions (browser, IP, last use) with **Encerrar** and **Encerrar todas**,
  and the PC Studio shows "Studio remoto conectado" while one is in use.
  Changing the phone password or the second factor, or turning it off,
  ends every remote session. Anything that would open on the PC screen
  (folder picker, Explorer, native Banco/SFTP windows) is not available
  remotely: links open in the remote browser, Banco and SFTP open in a new
  tab, and "Salvar uma cópia" downloads the file. The remote Studio never
  resizes terminals on the host. Wrong passwords are limited per address
  and overall (also for the phone login), and every sign-in, failure and
  ended session goes to `remote-access.log` (listed in Configurações →
  Sobre).
- 🟢 **Acesso pelo celular** uses `bethstudio-proxy`, a Linux program you
  install on a server you already have. It listens on a TCP port or a Unix
  socket and accepts one domain. Your existing HTTPS proxy forwards that
  domain, including WebSocket, to it. Beth Studio dials out to the domain.
  Configurações → Celular shows whether this computer is connected,
  still connecting, or disconnected. The server prints one line starting
  with bethstudio://link; that line is pasted there, and the phone password
  is created on the same screen. The remote page
  only reads agents and sends text or audio. Database, SSH and files stay
  on the Studio window.
- 🟢 Fit the pane to the Studio window when it is alone in its host tab
  (patch 0178). A split that exists only in Beth Studio keeps that
  column's size, so the text in the column stays intact (patch 0194).
  **Separar no Beth Studio** pulls a pane out of a host split
  (patch 0182). Scrollback stays put while a program redraws (patch 0187).
- 🟢 Shared themes and fonts. The Studio theme is pushed to the pane so
  Codex and Cursor see light backgrounds (OSC 10/11, patch 0189).
  Text whose color nearly matches the background is darkened or
  lightened until it reads (minimum contrast 3:1), so Claude Code's
  bright-white bold stays visible on light themes (2026-09-27).
- 🟢 Terminal menu: copy or save the full scrollback, and print the
  visible area (patch 0188). `http(s)` links, including an OSC 8 hyperlink
  whose visible text is only "here", open in the default browser. Local
  `.md` / `.txt` / `.log` and images open in a preview panel. Any other
  existing file (PDF, Office, archive, and the rest) opens in the Windows
  default program. Programs and scripts (`.exe`, `.bat`, `.ps1`, `.lnk`,
  `.js` and the like) are shown in Explorer and are not launched. While a
  fullscreen program has mouse tracking on, a plain click still goes to
  that program; the hover hint says **Ctrl+click** to open the link.
- 🟢 **Colar arquivo do Explorer** (Ctrl+V or Colar, 2026-10-01). A file
  copied in Explorer — PDF, video, or anything else — is copied into
  `C:\tmp\bethstudio\clipboard-images` (or `%TEMP%\bethstudio\clipboard-images`
  when `C:\tmp` is missing) and the path is pasted for the agent. Images
  still arrive as `![image](path)`; other files arrive as the path, quoted
  when it contains a space. In a WSL pane the path is rewritten
  `C:\…` → `/mnt/c/…`. Up to 8 files. A folder, or a file over 2 GB, pastes
  the original path instead of a copy. Letters outside ASCII in the copied
  name become `_`. The remote Studio does not read this computer's clipboard.
  Dropping a file on the terminal still uploads a copy the same way, up to
  25 MB.
- 🟢 **Abrir arquivo** (tab bar) opens the Windows file dialog in the
  focused terminal's folder. The file panel edits `.md` / `.txt` / `.log`:
  **Editar**, **Salvar** / Ctrl+S write the file itself (line endings and
  symlinks kept), Markdown toggles source / formatted (formatted shows the
  unsaved text). Closing or opening another file with changes asks
  first; if the file changed on disk meanwhile, it asks before
  overwriting (2026-09-29).
- 🟢 **Novo arquivo** (tab bar, and the file panel) opens the editor blank
  ("Sem título") to type right away. Saving is optional: **Salvar** /
  Ctrl+S asks for the folder and name (`.md` or `.txt`, never overwrites)
  and keeps editing the saved file. Closing a "Sem título" does not ask;
  the next **Novo arquivo** offers **Recuperar** for the last text closed
  without saving (2026-09-30).
- 🟢 **Notas** (2026-10-02). What you type in **Novo arquivo** is saved by
  itself, 1.5 s after the last key and again on Fechar, as one `.md` per
  note named by its creation time (`AAAA-MM-DD_HH-MM-SS.md`) in
  `%APPDATA%\bethstudio\notes\`. The notebook button in the panel title
  shows a side list (title = first line, date and time); click a note to
  open and keep editing it, **+** starts a blank note, and the trash icon
  on a row deletes it after an inline "Apagar esta nota?". Opening another
  note or file saves the current note first. If saving fails, the text
  still goes to **Recuperar**.
- 🟢 **Janela do painel de arquivo/notas** (2026-10-02): drag the title bar
  to move it, drag any edge or corner to resize, double-click the title
  to maximize, and the two panel buttons dock it to the left or right
  edge at full height. Position and size are remembered and the panel
  comes back inside the window if the app window shrinks.
- 🟢 **Reparar visualização** no topo de cada terminal reconstrói apenas o
  xterm.js local. Não envia `reset` nem altera o host; pode ser usado com
  Claude Code em execução. Quadros de tela recebidos rapidamente são
  condensados para evitar uma fila de imagens antigas (2026-09-27).
- 🟢 Agent-waiting dot (patches 0175, 0181). A bell at the end of a turn
  does not stay “waiting” while the title still shows a working spinner.
- 🟢 Voice: record, transcribe, and optionally correct with an LLM before
  paste (no Enter). Per-call cost in `ai-usage.jsonl`; audio and text are
  not stored. API keys stay in DPAPI `secrets.dat`.
- 🟢 Task manager: CPU, RAM, GPU, disk, Beth Studio processes, each terminal,
  and WSL distros that are already running. The system section shows one
  card per metric (large percentage, absolute value beside it, bar that
  turns yellow at 75 % and red at 90 %), then the WSL2 card: a memory
  gauge whose full width is the VM limit, filled with what Linux uses and
  what the VM holds in Windows RAM (use + cache), with the room left to
  grow; under it, the swap areas in the order Linux uses them (zram
  first, with the RAM it really takes and its compression ratio, then a
  disk swap file); a 60-second CPU graph; and the distro's virtual disk. RAM columns in the tables carry a small bar
  scaled to the largest row.
- 🟢 Settings: Aparência, Terminais, Voz e IA, Provedores de IA, Banco de
  dados, Uso e custos, Barra lateral, Sobre. Provedores de IA has a search
  box at the top; it filters by name, id, notes, and model. Sobre has
  **Verificar atualização** (GitHub releases; install the interface or
  download the installer only after you confirm).
- 🟢 A new terminal or SSH/serial session opens with the Beth Studio
  theme: the terminal default theme if one is set, otherwise the
  interface theme (Claro uses VS Code Light; Escuro and Azul-marinho use
  the factory dark). A theme picked in that terminal wins and stays;
  changing the Studio theme later recolours only terminals without their
  own theme. A terminal the Studio just opened never inherits the theme
  of an old terminal from a previous host with the same number, and a
  chosen theme no longer reverts to dark when another Beth Studio process
  saves settings at the same time (updated 2026-09-27).
- 🟢 **Grok Build** and **Codex** sign in with a code on Provedores de IA.
  Beth Studio shows the code, with a button to copy it, and opens the
  authorization page in the browser. The token stays encrypted on this
  PC (same device-code flow as claude-router-go). The account can
  correct text and answer in the database assistant.
- 🟢 When a process exits, the leaf shows **terminal encerrado** and can
  be removed.
- 🟢 **Todos os terminais** (grid button next to **+** in the tab bar): a popup
  grid with one card per terminal, showing a text print of the screen (last
  lines), name, type, folder path and tab. Includes terminals in closed tabs,
  loose ones and ended ones. Search by name, folder, type, tab or `#id` (and
  optionally the screen text); filters Todos / Em abas / Sem aba / Encerrados.
  Click opens the terminal (a closed tab is reopened, a loose terminal gets a
  new tab); Enter opens the first match (2026-10-09).
- 🟢 **Phone web app: grid view** (button in the list header, remembered on the
  phone). Same cards as the Studio popup: screen print, name, folder, type and
  tab (or "Aba fechada"), with the same search as the desktop popup (name,
  folder, type, tab or #number; optional "search the screen too"), the
  Todos / Em abas / Sem aba / Encerrados filters with counts, and the `#id` on
  each card. Needs the Studio build with `/api/phone/layout` and
  `/api/phone/content`; with an older Studio the cards show without print and
  tab (2026-10-10).

## 8. SSH, serial, and SFTP

- 🟢 Saved SSH hosts and serial ports. Password and key passphrase in
  DPAPI. The terminal title is `user@host:port` (patch 0184, 0188).
- 🟢 SSH and serial opened from Studio land in workspace `beth-studio`
  (patch 0190).
- 🟢 SFTP in its own taskbar window (folder icon on an SSH terminal, or
  `bethstudio-web.exe --sftp`): Local | Remote panes and an upload/download
  queue (patch 0188).
- 🟢 If an SSH session prints an `http://localhost:port` link, that port
  is opened on this PC and forwarded through the SSH session already
  open (agent login).

## 9. Database

🟢 Its own taskbar window, title **Banco de dados**. The Studio toolbar
button opens it or focuses it. The palette button opens the same theme
list as a terminal (search, dark/light and origin filters, swatches).
Click a theme to paint this window and Beth Studio; click outside the
panel to close it. Hover previews and does not save.

- 🟢 PostgreSQL, MySQL, SQL Server, and SQLite. Connections in
  `db-connections.json`. Passwords in DPAPI. Optional read-only.
- 🟢 Tree: connection → database → schema → Tables, Views, Materialized
  Views (PostgreSQL), Functions, Queries.
  PostgreSQL and SQL Server list every reachable database, unless the
  connection has an **Banco inicial**: then only that one opens (2026-10-10).
  The connection form has a **Selecionar** button next to **Banco inicial**
  that lists the reachable databases to pick from (2026-10-10).
- 🟢 SQL editor with autocomplete, saved queries (`db-queries.json`), and
  export.
- 🟢 Database assistant: a model chosen under Settings → Banco de dados,
  separate from the voice model. It corrects SQL or answers a question
  about the open database. It does not run the SQL and does not send
  rows or passwords.
- 🟢 Cell editing in the result grid. Double-click or F2 a cell in the
  table browser, or in a simple one-table SELECT that includes every
  primary-key column. Enter saves, Esc cancels, and the cell menu can
  set NULL. A read-only connection, a JOIN, or a table without a primary
  key stays read-only. Only columns that come straight from the table can
  be edited (not `nome AS id` or `upper(nome)`). In the SQL editor the
  update changes one column and only commits when exactly one row
  matches the key.
- 🟢 **Inserir, apagar e duplicar linha** in the table browser (Dados):
  **Nova linha**, **Duplicar** (copies the row without the key) and
  **Apagar** in the toolbar and in the right-click menu. Edits, new rows
  and deleted rows stay pending and highlighted (new rows show `+` and
  `(padrão)` for columns that will use the database default; deleted rows
  are struck through) until **Aplicar**, which writes everything in one
  transaction: every UPDATE/DELETE must match exactly one row by its
  primary key, and if anything fails nothing is written. **Descartar**
  drops it all. While changes are pending, paging, sorting, filters and
  reload wait (2026-10-01).
- 🟢 **Apagar várias linhas** (table browser and SQL results). Click a row
  number to mark it, Shift+click to mark a range, click the `#` header to
  mark all. **Apagar N** opens a confirmation popup showing the table, the
  key column(s) that identify each row, and a sample of the rows; from 20
  rows up it asks to type the count. It deletes right away, in one
  transaction that only commits if every row matches its key exactly
  (nothing is deleted otherwise). In the SQL editor it only works when the
  result is a simple one-table SELECT with a primary key that is in the
  result (and not an alias or expression); otherwise the button is disabled
  and its tooltip says what is missing, e.g. to add `id` to the SELECT
  (2026-10-02).
- 🟢 **Histórico geral de consultas** (scroll icon in the SQL editor,
  2026-10-02). Every execution, from any connection and database, is
  recorded on the server in `db-history.jsonl` (last 5,000; SQL, connection,
  database, time, duration, rows, error). The dialog lists them newest
  first and searches as you type (every term must appear in the SQL, the
  connection name or the database; matches are highlighted), filters by
  connection or "só as que deram erro", and pages 200 at a time. Click a row
  to open its SQL in the connection and database where it ran; **Só o SQL**
  pastes it into the current editor; copy; remove one; **Limpar tudo**
  asks first. Only statements that actually ran are recorded (a pending
  confirmation is not).
- 🟢 The tree lists every database the user can access (PostgreSQL, SQL
  Server), even when the connection has an initial database; that one is
  bold (2026-10-02).
- 🟢 **Consultas salvas para todas as conexões** (2026-10-02). In the SQL
  editor, the bookmark button (or the saved-queries panel) saves the
  current SQL under a name, with a choice of **Todas as conexões**
  (default) or **Só esta conexão**. A query for all connections shows in
  the saved list of any connection and database, tagged "todas", and in
  the tree's **Queries** folder. The same name can exist for all
  connections and for one connection. Stored in `db-queries.json` with an
  empty `connId`.

## 10. Beth Studio Mobile

⚪ Android/iOS skeleton (Expo). Connection list, terminal list, and an
xterm screen. Remote access from the phone is not wired on the PC yet.

## 11. Not in the product

- ⚪ Redis, MongoDB, and Oracle.
- ⚪ SSH tunnels for database connections.
- ⚪ ER diagram, BI, scheduling, and a Backups folder.
- ⚪ ProxyJump, agent forwarding, snippets, SFTP as a drive letter,
  folder sync.
- ⚪ X11, RDP, or VNC inside BethStudio.
- ⚪ Cloud sync of hosts.
- ⚪ Linux and macOS builds.

---

## Build & run

```sh
# From upstream-wezterm/. Strawberry Perl MUST be on PATH (openssl-sys).
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm -p wezterm-mux-server

# Then, from the repository root (PowerShell):
#   powershell -File bethstudio-web\build.ps1   # Beth Studio
#   pack-bethstudio-setup.ps1                   # installer
```

Daily launch: `run-bethstudio.cmd` (starts `bethstudio-web.exe`). Never use plain
`wezterm` from PATH, which may resolve to an installed copy.

Toolchain: **Rust nightly 2026‑06‑05**, **Strawberry Perl 5.36**, **MSVC
nmake**, **VS 2022 Build Tools**. Details in `upstream-wezterm/PATCHES.md`.

## Where things live

| Path | What |
| --- | --- |
| `upstream-wezterm/` | Vendored wezterm (read‑only except documented patches). |
| `upstream-wezterm/wtinator/` | The Beth Studio delta crate (host helpers, themes, groups, session, notifications). |
| `upstream-wezterm/PATCHES.md` | The authoritative log of every upstream change. |
| `upstream-wezterm/patches/NNNN-*.md` | Per‑patch design notes. |
| `bethstudio-web/` | Beth Studio (Go + React, WebView2). |
| `bethstudio-mobile/` | Phone app skeleton. |
| `docs/FEATURES.md` | The original design spec (includes planned/future ideas). |
| `docs/ARCHITECTURE.md`, `docs/PROJECT_LAYOUT.md` | How the pieces fit together. |
| `%APPDATA%\bethstudio\` | Runtime data: `session.json`, downloaded `themes\`, Studio settings. |

## Full patch index

The complete, authoritative list (with diffs and revert steps) is the table in
[`upstream-wezterm/PATCHES.md`](upstream-wezterm/PATCHES.md) — patches **0001
through 0198** at the time of writing. This catalog groups those patches by
feature; the table is the source of truth for exactly what changed in each file.
