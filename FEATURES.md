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

Last updated: 2026-10-02.

---

## Participants & Credits

BethTerm was built as a relay between **Rodrigo** and a team of AI
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

**Beth Studio** is the product. It is more than a terminal: a native window,
this studio, and a phone page for talking to agents. It is a **Windows‑focused
distribution of [wezterm](https://wezterm.org)** built as a thin **delta** on
top of a vendored upstream snapshot:

- **`upstream-wezterm/`** — a vendored, mostly read‑only copy of wezterm. It
  keeps wezterm's GPU renderer, font stack (FreeType + HarfBuzz, ligatures,
  fallback chains), true‑color, scrollback, and multiplexer.
- **`wtinator`** — the BethTerm delta crate: native Win32 menus, themes,
  clipboard/media, tab groups, headers, session persistence, etc. Wired into
  the upstream binary through a single `wtinator::install()` hook (patch 0003).
- **`wtinator-config`** — a standalone companion app (a `tao` window hosting a
  `wry`/WebView2 control that loads a React + TypeScript single‑file bundle)
  that talks to the running terminal over a named pipe.
- **Binaries**: `bethterm-gui.exe` (native window, Skia), `bethterm.exe`
  (CLI), `bethterm-host.exe` (every PTY), and `bethterm-web.exe`
  (**Beth Studio**, Go + React in WebView2). The Cargo package names are
  still `wezterm-gui`, `wezterm`, and `wezterm-mux-server`.

Build & run conventions live in `AGENTS.md` and `upstream-wezterm/PATCHES.md`;
the short version is at the end of this document.

Status legend: 🟢 shipped · ⚪ planned.

---

## 1. Native right‑click menus & mouse UX

🟢 The whole menu system is a **native Win32 popup (HMENU)** shown with
`TrackPopupMenuEx`, themed by the OS and always on top — chosen after the
upstream Skia overlay failed to appear in some Windows sessions.

- **Right‑click on a pane / the `+` button / the tab‑bar terminal icon** opens
  the BethTerm menu (patches 0005 → **0009** migration, 0006, 0007, 0008).
- **Windows stability fixes** so the menu reliably opens and never panics the
  GUI: open on button‑**up**, defer `TrackPopupMenuEx` to the UI thread, guard
  reentrant `WM_PAINT`/`WM_MOUSELEAVE`, obtain the HWND via `GetForegroundWindow`
  (patches 0010, 0011).
- **Split → shell submenu**: "Split right/down" cascade lists the available
  shells; the chosen shell spawns into the split (patch 0012).
- **Clipboard entries**: Copy selection, Paste, **Select all** (new
  `KeyAssignment::SelectAll`), **Save scrollback as…** (native `GetSaveFileNameW`
  dialog) (patches 0013, 0014, 0015).
- **Menu icons**: 16×16 monochrome icons drawn at runtime with GDI primitives,
  auto‑coloured for light/dark via `COLOR_MENUTEXT` (patch 0018).
- **Right‑click respects the clicked pane**, not just the active one (patch 0033).
- **Menu cleanup**: "Configure this terminal…" moved to the top; redundant
  submenus removed; submenu icons added (patch 0045).
- **Smarter hyperlinks** — a bare click only selects/copies (it no longer opens
  a link or hijacks double-click word-select over a URL); **Ctrl+click** opens.
  The hover underline tracks the pane **under the mouse**, not the focused split,
  and the hand cursor shows only while Ctrl is held (patch 0058).

## 2. Shells

🟢 Quick‑launch entries for **cmd.exe, PowerShell 5.1, PowerShell 7+, WSL
(default + named distros), Git Bash**, surfaced in the native picker. Optional
**MobaXterm local bash** entry appears when its local path exists (patch 0026),
and users can add their own entries in `%APPDATA%\bethterm\shells.json`
(patch 0183). Split‑menu wID ranges were generalized so the
shell count is not hard‑coded.

## 3. Themes

- 🟢 **Built‑in schemes** (VSCode Light, VSCode Dark, Windows Terminal Dark) and
  a runtime `TermWindow::set_color_scheme` that also recolours the active pane's
  terminal content, not just the chrome (patch 0016 + 0016.3).
- 🟢 **Theme submenu** + "Open themes folder…" (patch 0017).
- 🟢 **Dark‑theme cursor fix** — `cursor_bg = cursor` so the block is visible on
  dark schemes (patch 0027).
- 🟢 **Theme downloader** — one click fetches the **Gogh community catalog**
  (~365 themes: Dracula, Nord, Tokyo Night, One Dark, Catppuccin, …), slugifies
  and caches them under `%APPDATA%\bethterm\themes\` (patch 0038).
- 🟢 **Theme browser** in the config app — name search, **Light / Dark /
  Favorites / All** filters, ★ favorites, and progressive (lazy) rendering so
  hundreds of themes don't render at once (patch 0046).
- 🟢 **Favourites persist on disk** as theme+font **presets** — stored in
  `%APPDATA%\bethterm\theme-favorites.json` over IPC instead of the
  WebView's `localStorage` (which a `null` origin wiped each spawn) (patch 0060).
  ★ captures the terminal's current **font** (size / family / bold-italic) with
  the theme, applying a favourite restores both, and a ↻ button refreshes a
  favourite's saved font (patch 0062).
- 🟢 **Default theme for all terminals** — Settings **Usar em todos** saves the
  theme to `%APPDATA%\bethterm\default-theme.json`, recolours every open pane,
  and stamps new tabs/windows that have no per-pane theme. Splits still inherit
  the source pane (patch 0110).
- ⚪ **Per‑group default theme** — "new tab in group X uses theme Y" (patch 0041,
  planned).

## 4. Per‑terminal appearance — the flagship

🟢 **Each pane (terminal) can have its own theme, font size, font family, bold,
and italic — independent of its split siblings.** Set from a right‑click →
**"Configure this terminal…"** window, or via keys for size.

- **Per‑pane font size** — the split tree stays in the window's uniform base
  cell, but a pane at scale `s` gets `cols/s × rows/s` cells in the same pixel
  area, reflowed at every leaf (patch 0039).
- **Per‑terminal config window** — pick a theme + an exact font size for **one**
  pane over the named‑pipe IPC (patch 0040).
- **Per‑pane font family** — swap the typeface via an in‑memory config clone
  (`with_font_family` + `change_scaling`, never the file‑reading
  `overridden_config`), with a GUI‑derived `family_ratio` driving a two‑factor
  reflow and `ensure_pane_geometry` self‑healing the grid after restore / split
  / resize; degenerate (icon/non‑monospace) faces fall back safely (patch 0043).
- **Per‑pane bold / italic** — B / I toggles; FreeType synthesizes them when the
  face lacks the variant (patch 0047).
- **Correctness fixes that make the above actually work** (these were subtle):
  - 🟢 **No font leaks across panes** — the window‑level shape cache now keys on
    the font identity (`font_id`), so one pane's glyphs can't bleed into another
    (the "random word in the wrong typeface" bug) (patch 0051).
  - 🟢 **Family/bold/italic reach the glyphs** — the override now swaps
    `self.config` too, so `match_style` returns the override style instead of
    only changing the cell metrics (patch 0052).
  - 🟢 **Cursor stays put** in bold/italic panes — the cursor‑glide guard covers
    the full styled set (patch 0053).
- 🟢 **Splits inherit the look of the pane they grew from** — theme + font
  (size/family/bold/italic) (patch 0054).

## 5. Cursor

- 🟢 **macOS‑style smooth fade‑blink** cursor as the default (patch 0042).
- 🟢 **Cursor glide / smear** animation as the cursor moves (patch 0044), with a
  reverse‑video block that always follows the cell's colours so it's visible on
  any theme, plus a contrast guard.

## 6. Tabs, groups & naming

- 🟢 **Tab groups** — a `group_name` on each tab, a live group listing, and a
  right‑click **"Move pane to…"** that moves a pane into a (new) tab in the
  target group, removing the source tab if it empties (patch 0028).
- 🟢 **Per‑terminal header** — an always‑visible "Tab #N · group · title" bar per
  pane, with a native Win32 **rename dialog** (patches 0030, 0030.5;
  theme‑aware in 0036.1; polished in 0050).
- 🟢 **Per‑tab user title** — a sticky name that overrides the OSC 0/2 title so
  vim/claude/tmux can't clobber it; its own "Rename tab…" entry (patch 0031).
- 🟢 **Per‑tab close X** with a native Win32 `MessageBoxW` confirmation (and
  silent close for empty/idle tabs) (patch 0032 + 0032.1/0032.2 for pane/window).
- 🟢 **Tab alert when a pane is waiting** — the tab shows an attention dot when a
  pane needs you. **No hook needed**: set Claude Code's
  `preferredNotifChannel: "terminal_bell"` and it rings the bell when waiting;
  wezterminator turns that into a **blinking red ●** on the tab that clears when
  you focus it (patch 0063, works for any bell). A yellow ● driven by a
  `claude_status=waiting` OSC user var is also supported for a hook-based setup
  (patch 0061).

## 7. Session save & restore

- 🟢 **Save & restore** the open tabs, panes, splits, groups, titles, per‑pane
  headers, themes, and fonts to `%APPDATA%\bethterm\session.json`
  (auto‑save every 30 s + on close; atomic writes) (patches 0029, 0029.1/0029.2;
  per‑pane font/theme fields added through 0043/0047).
- 🟢 **Restore can't hang the window** on a now‑unreachable network/WSL cwd — a
  300 ms timeout probe drops dead cwds (patch 0049).
- 🟢 **No auto‑typed `cd`** on the first terminal — every restored tab now spawns
  fresh in its saved directory instead of the old reuse‑and‑type‑`cd` hack
  (patch 0055).
- 🟢 **Persistent PTY host** — shells live in `bethterm-host.exe`. Closing or
  updating the GUI does not kill agents. Reopening attaches to the same
  panes; `session.json` does not respawn them (patch 0121).

## 8. Drag & drop / docking

- 🟢 **Reorder tabs** by dragging them in the tab strip; **move a pane** to
  another tab by dragging its header onto a tab (patch 0035, made live by
  0036.1).
- 🟢 **VS‑style pane docking** — drag a pane by its header; a cursor "puck"
  follows, hovering a tab spring‑loads it, hovering a pane shows Left/Right/Up/
  Down/Center drop zones, and releasing docks (split) or swaps (Center) (patch
  0037). Includes the active‑pane **focus border** when a tab has >1 pane.

## 9. Title bar & window controls

🟢 **Custom integrated title bar** — the tabs and window controls (Hide /
Maximize / Close) are drawn as a single block via the upstream fancy‑tab‑bar
renderer; borderless `WS_POPUP` with manual `WM_NCHITTEST` resize zones, DWM
border suppressed; the app‑rendered Close always confirms first (patch 0020,
by Codex).
- 🟢 **Close goes to the clock-area tray** — the title-bar X hides the window
  instead of killing PTYs (patch 0105). Hidden windows are stacked on one
  icon; right-click picks which window to restore (patch 0106). Hide is
  aborted if the tray icon cannot be created (patch 0107). The icon
  reappears if Explorer restarts or the shell drops it (patch 0126).
  While the window is hidden or minimized, GPU frames are skipped
  (patch 0116). The process stays up so the tray icon remains.
  Confirming **Fechar esta janela** closes only that GUI window.
  The host, the shells, and Beth Studio stay (patch 0193).
- 🟢 **Janela nativa** — tray submenu that groups everything about the native
  terminal windows (patch 0196). Beth Studio is the first tray entry; the
  submenu holds **Usar a janela nativa** (the on/off check), **Painel**,
  **Novas janelas como**, **Desenho**, **Esconder tudo** / **Mostrar todas**
  and **Reiniciar a janela nativa**. Those items are greyed while the
  native window is off. The check turns the native terminal
  windows on or off (patches 0192, 0195, 0196). Off is saved in `%APPDATA%\bethterm\native-gui`
  and the interface restarts without creating a terminal window, so
  the renderer does not start. The icon next to the clock stays.
  The host, the shells, Beth Studio, and Sistema keep running.
  **Novo terminal** still opens a shell on the host (Beth Studio
  lists it) and does not open a drawing window. **Painel** is
  unavailable while the window is off. Turning it back on restarts
  the interface and the windows return (patch 0192).
- 🟢 **Installer shortcuts reuse the running GUI** — a second click focuses
  the existing process instead of spawning another GPU process. The WGL
  probe window is hidden and destroyed so it does not appear on the
  taskbar (patches 0108–0109). Daily launch is `run-bethterm.cmd`
  (release GUI, no args, patch 0115). Only the debug launcher uses
  `--always-new-process`.
- 🟢 **Sair leaves the host running** — tray **Sair da bandeja** exits the GUI only.
  Shells and agents stay in `bethterm-host.exe` until that process is
  stopped (patch 0121).
- 🟢 **Encerrar host** — tray **Encerrar tudo** confirms, then stops the host and
  the GUI. Theme/font/header on host panes survive a GUI reconnect
  (patch 0122). A setup while the host is live writes
  `bethterm-host.exe.new` and swaps it on the next host start.
- 🟢 **Painel** — fixed-width left list of every live terminal by
  name. Click a row to switch that terminal onto the right. The
  tab strip is hidden while the Painel is open. Optional: tray
  **Novas janelas como** picks **Abas** or **Painel** for new
  windows (saved in `%APPDATA%\bethterm\ui-mode.json`). Does not
  split and does not type into the pane (patch 0124).
- 🟢 **Esconder tudo** — tray entry hides every visible window the
  same way the title-bar X does. Shells stay (patch 0150).
- 🟢 **Reiniciar a janela nativa** — tray entry restarts only
  `bethterm-gui.exe`. Saved positions come back without panicking
  (patches 0147, 0149, 0195, 0196).
- 🟢 **Desenho GPU ou CPU** — tray **Desenho** (in **Janela nativa**) picks the graphics
  card (default) or Mesa on the CPU. Switching restarts the GUI
  only. Choice is `%APPDATA%\bethterm\render-mode` (patch 0155).
- 🟢 **Cor do ícone** — right-click sets that window's taskbar icon
  color. Stored next to the window name (patch 0151).
- 🟢 **Abrir pelo menu maximiza** — a tray-list click, or **Abrir
  todas**, shows the window maximized (patch 0156).
- 🟢 **Agente esperando nos ícones** — the tab-bar wait signal also
  puts a red dot on that window's taskbar icon, on the tray icon
  while any window is waiting, and a `●` on its tray-menu row.
  Bell, OSC 9, OSC 777, OSC 99, and `*_status=waiting` all count
  (patches 0152–0153). A stuck menu (error 1446) is dismissed
  instead of blocking later clicks (patch 0154).

## 10. Clipboard & media

- 🟢 **Image paste** — `Ctrl+V` / right‑click on a clipboard image saves it as
  PNG under `…\wezterminator\clipboard-images\` and pastes a Markdown
  `![image](path)` link (patch 0022, hardened in 0025 for DIB formats/orientation).
  In a **WSL2** pane the pasted path is rewritten `C:\…` → `/mnt/c/…` so the
  Linux side can open the file (patch 0059).
- 🟢 **Screenshot** submenu — "Save as JPEG…" (native Save‑As) and "Copy to
  clipboard", capturing the window via `PrintWindow(PW_RENDERFULLCONTENT)`
  (patch 0025).
- 🟢 **Save scrollback as…** — native Save‑As dialog writing the focused pane's
  scrollback (patch 0015).

## 11. Keybindings & input

- 🟢 **Alt+Enter sends LF** (not CR) for AI agent CLIs (Claude Code, Gemini,
  Aider) that use LF to commit a newline (patch 0019).
- 🟢 **Ctrl+C / Ctrl+V / Ctrl+Insert** work on Windows/Linux (upstream only
  bound `SUPER`) (patch 0021), and **Ctrl+C falls through to the shell** (sends
  ETX to abort) when there is no selection (patch 0027.1).
- 🟢 **Ctrl + = / − / 0 zoom just the focused terminal**; whole‑window zoom moved
  to `Super + …` (patch 0048).

## 12. Editor / appearance auto‑config

- 🟢 **VSCode font** — reads `editor.fontFamily` + `editor.fontSize` from VS Code
  / Insiders / VSCodium / Cursor `settings.json` and matches it out of the box
  (patch 0023).
- 🟢 **Auto cursor contrast** — picks a white‑or‑black cursor foreground from the
  background luminance, with a mid‑grey dead‑band to avoid churn (patch 0024).

## 13. `wtinator-config` companion app

🟢 A standalone **React + TypeScript app in a WebView2 control** (`tao` + `wry`,
single‑file Vite bundle), talking to the running terminal over a per‑pid named
pipe (`\\.\pipe\wtinator-config-<pid>`). It hosts the theme browser/downloader
and the per‑terminal theme + font configuration. The IPC contract
(`list_tabs`, `set_theme`, `set_pane_theme`, `set_pane_font_size`,
`set_pane_font_family`, `set_pane_font_style`, `list_fonts`, `download_themes`,
`set_default_theme`,
…) is served by a dedicated pipe thread that posts applies to the GUI main
thread (patches 0034, 0036, 0038, 0040, 0043, 0046, 0047, 0110).

## 14. Windows stability (no more freezes)

🟢 Patch **0113** hardens the Windows host so a busy pane or a slow disk
cannot freeze the GUI:

- `ClosePseudoConsole` runs on a helper thread **after** the ConPTY pipes
  drop (Microsoft's documented order). The hanging `INHERIT_CURSOR` flag
  is off.
- Session auto-save writes AppData in the background with a 2 s timeout.
- Sistema disk sampling times out at 250 ms and reuses the last sample.
- Shipped `conpty.dll` + `OpenConsole.exe` are the Microsoft 1.24 pair
  (`1.24.2604.02001`).
- 🟢 **Fluid UI** (patches 0114–0115) — `run-bethterm.cmd` starts the
  release GUI with no args and no debug log; Constant caret blink;
  cursor glide off unless `BETHTERM_CURSOR_GLIDE=1`.

## 15. Build / integration foundation

🟢 Workspace wiring so the vendored upstream is the workspace root, a chrono
`clock` feature fix, and the `wtinator::install()` hook in the upstream binary's
`main()` (patches 0001–0004, by Codex).

## 16. Beth Studio

🟢 A second window for the same terminals (`bethterm-web.exe`, tray label
**Beth Studio**, patches 0171–0173, 0186). It talks to `bethterm cli bridge`
and supervises the host (starts it, restarts it after a crash, never stops
it without a confirmed **Encerrar tudo**). Closing a Studio tab does
not kill a terminal; **Encerrar terminal…** asks first (patch 0180).

- 🟢 **Studio supervises the host and has its own tray icon** (2026-10-03).
  Opening the Studio without a running `bethterm-host.exe` starts it. If the
  host crashes it is restarted, at most 3 times in 10 minutes; after that a
  banner says **Host indisponível** with **Tentar de novo**. Closing the window
  hides it to the tray. The tray menu has **Beth Studio**, **Novo terminal**,
  **Sistema**, **Sair da bandeja** (terminals keep running) and **Encerrar
  tudo** (asks first, then closes every terminal). The icon gets an amber dot
  while an agent waits for you. With an old `bethterm-gui.exe` running, the
  Studio leaves the host and the tray to it.
- 🟢 Own tabs and splits (drag, new terminal to the right / below / above /
  left), views **Minha organização**, **Como no BethTerm**, **Por tipo**,
  and **Por pasta** (groups by each terminal's current folder, follows
  `cd`; same-named folders get their parent). Every card shows the folder
  name in bold and the start of the path dimmed (2026-09-29).
  Search by title, folder, tab, host window, id, and optional screen text.
- 🟢 **Tool buttons in the side panel**: SSH/Serial, open/new file, speak,
  tasks, database and settings sit in a row under "Beth Studio" in the left
  panel, so the tab bar is left to the tabs. With the side panel collapsed
  they go back to the tab bar (2026-10-02).
- 🟢 **Destacar em janela**: a terminal or SSH session can leave the tabs
  and become its own native window (button in the terminal header, or
  **Destacar em janela** in the terminal menu). The window can go to another
  monitor. Drag its title bar over a pane, tab or "+" of the Studio to put it
  back, or click **Encaixar**. Closing the window does not stop the terminal:
  it keeps running and goes back to the terminal list (PC only, not in the
  remote Studio or the phone) (2026-10-02).
- 🟢 Opening shows progress instead of a blank window: the native window
  says "Abrindo Beth Studio…", then a spinner with the current step
  (connecting, terminal list, "Abrindo os terminais desta aba (2 de 6)").
  After 10 s it offers **Tentar de novo** / **Mostrar assim mesmo**. Each
  opening logs its phase times (`abertura` in `bethterm-web.log`). Only
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
  column's size: the native window does not stretch the pane back to
  the full window, so the text in the column stays intact (patch 0194).
  **Separar no BethTerm** pulls a pane out of a host split
  (patch 0182). Scrollback stays put while a program redraws (patch 0187).
- 🟢 Shared themes and fonts. The Studio theme is pushed to the pane so
  Codex and Cursor see light backgrounds (OSC 10/11, patch 0189).
  Text whose color nearly matches the background is darkened or
  lightened until it reads (minimum contrast 3:1), so Claude Code's
  bright-white bold stays visible on light themes (2026-09-27).
- 🟢 Terminal menu: copy or save the full scrollback, and print the
  visible area (patch 0188). `http(s)` links open in the default browser. Local
  `.md` / `.txt` / `.log` and images open in a preview panel.
- 🟢 **Colar arquivo do Explorer** (Ctrl+V or Colar, 2026-10-01). A file
  copied in Explorer — PDF, video, or anything else — is copied into
  `C:\tmp\bethterm\clipboard-images` (or `%TEMP%\bethterm\clipboard-images`
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
  `%APPDATA%\bethterm\notes\`. The notebook button in the panel title
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
- 🟢 Task manager: CPU, RAM, GPU, disk, BethTerm processes, each terminal,
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
  box at the top; it filters by name, id, notes, and model.
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

## 17. SSH, serial, and SFTP

- 🟢 Saved SSH hosts and serial ports. Password and key passphrase in
  DPAPI. The terminal title is `user@host:port` (patch 0184, 0188).
- 🟢 SSH and serial opened from Studio land in workspace `beth-studio`,
  so the native window does not open a tab for them. Studio still shows
  the terminal. Local shells (PowerShell, WSL, cmd) still appear in the
  native window (patch 0190).
- 🟢 SFTP in its own taskbar window (folder icon on an SSH terminal, or
  `bethterm-web.exe --sftp`): Local | Remote panes and an upload/download
  queue (patch 0188).
- 🟢 If an SSH session prints an `http://localhost:port` link, that port
  is opened on this PC and forwarded through the SSH session already
  open (agent login).

## 18. Database

🟢 Its own taskbar window, title **Banco de dados**. The Studio toolbar
button opens it or focuses it. The palette button opens the same theme
list as a terminal (search, dark/light and origin filters, swatches).
Click a theme to paint this window and Beth Studio; click outside the
panel to close it. Hover previews and does not save.

- 🟢 PostgreSQL, MySQL, SQL Server, and SQLite. Connections in
  `db-connections.json`. Passwords in DPAPI. Optional read-only.
- 🟢 Tree: connection → database → schema → Tables, Views, Materialized
  Views (PostgreSQL), Functions, Queries.
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

## 19. BethTerm Mobile

⚪ Android/iOS skeleton (Expo). Connection list, terminal list, and an
xterm screen. Remote access from the phone is not wired on the PC yet.

## 20. Not in the product

- ⚪ A switch to turn the native GUI off and keep only Beth Studio.
- ⚪ Redis, MongoDB, and Oracle.
- ⚪ SSH tunnels for database connections.
- ⚪ ER diagram, BI, scheduling, and a Backups folder.
- ⚪ ProxyJump, agent forwarding, snippets, SFTP as a drive letter,
  folder sync.
- ⚪ X11, RDP, or VNC inside BethTerm.
- ⚪ Cloud sync of hosts.
- ⚪ Linux and macOS builds.
- ⚪ Per-group default theme (patch 0041).

---

## Build & run

```sh
# From upstream-wezterm/. Strawberry Perl MUST be on PATH (openssl-sys), and the
# GUI must be closed (the .exe is locked while running).
export PATH="/c/Strawberry/perl/bin:$PATH"
cargo +nightly build --release -p wezterm-gui -p wtinator-config

# Frontend (only when the config app's UI changed):
cd wtinator-config/frontend && npm run build   # → dist/index.html
```

Launch for manual testing with the root launchers (never plain `wezterm` from
PATH, which may resolve to an installed copy):

```
run-wezterminator-release.cmd
run-wezterminator-debug.cmd
```

Toolchain: **Rust nightly 2026‑06‑05**, **Strawberry Perl 5.36**, **MSVC
nmake**, **VS 2022 Build Tools**. Details in `upstream-wezterm/PATCHES.md`.

## Where things live

| Path | What |
| --- | --- |
| `upstream-wezterm/` | Vendored wezterm (read‑only except documented patches). |
| `upstream-wezterm/wtinator/` | The BethTerm delta crate (menus, themes, groups, headers, session, IPC). |
| `upstream-wezterm/wtinator-config/` | The React + WebView2 companion app. |
| `upstream-wezterm/PATCHES.md` | The authoritative log of every upstream change. |
| `upstream-wezterm/patches/NNNN-*.md` | Per‑patch design notes. |
| `bethterm-web/` | Beth Studio (Go + React, WebView2). |
| `bethterm-mobile/` | Phone app skeleton. |
| `docs/FEATURES.md` | The original design spec (includes planned/future ideas). |
| `docs/ARCHITECTURE.md`, `docs/PROJECT_LAYOUT.md` | How the pieces fit together. |
| `%APPDATA%\bethterm\` | Runtime data: `session.json`, downloaded `themes\`, `clipboard-images\`. |

## Full patch index

The complete, authoritative list (with diffs and revert steps) is the table in
[`upstream-wezterm/PATCHES.md`](upstream-wezterm/PATCHES.md) — patches **0001
through 0190** at the time of writing. This catalog groups those patches by
feature; the table is the source of truth for exactly what changed in each file.
