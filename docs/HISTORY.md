# Project history

How BethTerm and Beth Studio got to where they are, from the first snapshot
(2026-06-07) to 2026-10-03. This is a narrative summary of about 100 commits.
For the exact change behind any item, see the numbered patch notes in
[`upstream-wezterm/patches/`](../upstream-wezterm/patches/) (index:
[`PATCHES.md`](../upstream-wezterm/PATCHES.md)). For what ships today, see
[`FEATURES.md`](../FEATURES.md). Patch numbers below are the ones in those files.

The project began as a fork of [WezTerm](https://github.com/wezterm/wezterm)
(MIT, Wez Furlong). Its goal from day one: a Windows terminal that works with
the mouse first, without Lua or keyboard chords. It has since grown into three
parts: a native window, a persistent terminal host, and **Beth Studio**, a
separate UI for the same terminals.

## Timeline

### 2026-06-07 — First snapshot ("WezTerminator", patches 0001–0024)

- Added the `wtinator` crate as the home of all new code, and started the rule
  that every edit to an existing WezTerm file is a numbered, documented patch.
- Replaced keyboard-first menus with native Windows menus: right-click on a
  pane, the `+` button, split pickers (0005–0018). Two bugs shaped the design
  and are still the rule: the popup must be shown from the UI thread after the
  mouse callback returns (0010), and re-entrant paint messages must not borrow
  twice (0011).
- Custom title bar that holds the tabs and the window controls (0020), which
  later fixes made work with a borderless window and the taskbar.
- Everyday behavior: `Alt+Enter` newline, `Ctrl+C`/`Ctrl+V`, paste image,
  VS Code font, cursor colour that follows the theme (0019–0024).

### 2026-06-13 → 06-14 — Every terminal looks the way you want (0025–0055)

- Screenshot menu, tab groups with "move pane to…", saved layout across
  restarts, per-terminal status header, rename dialogs, drag-and-drop for
  tabs and panes, VS-style pane docking (0025–0037).
- Settings companion app (React + WebView2) talking to the GUI over a named
  pipe (0034, 0036).
- Theme downloader (Gogh catalog), theme browser with search and favourites
  (0038, 0046).
- Per-terminal font size, then family, bold and italic, then a per-terminal
  config window, persisted across restarts (0039–0047, 0054). This was the
  hardest area: shape-cache leaks, a config swap per pane, and cursor effects
  that had to be dropped. The working design is recorded in those patch notes.
- Session restore stops hanging on a missing folder (0049, 0055).

### 2026-06-22 — Checkpoint and a dead end (0056–0065)

- Smarter hyperlinks, smart paste for WSL paths, favourites that become
  presets (theme + font), and a tab alert when an agent is waiting
  (0056–0063).
- A pane-tab bar (0065) did not work and was shelved on a separate branch.
  Lesson: model sub-tabs as real tabs grouped by project, not as a custom bar.

### 2026-09-07 — Rebrand to BethTerm (0066–0104)

- Rendering and resize fixes for panes (0067–0076), detachable tabs and named
  windows (0068, 0085), two-step close confirmations (0080–0084).
- Product rename to BethTerm with `bethterm.exe` and `bethterm-gui.exe`
  (0088–0089), a native Win32 installer with embedded compression
  (0091–0094), app icon, bundled theme catalog (0095–0099).
- Repository cleanup for public release.

### 2026-09-10 → 09-16 — Tray and responsiveness (0105–0120)

- Closing a window hides it to the tray (0105–0107); shortcuts reuse the
  running GUI instead of starting another GPU process (0108–0109).
- Default theme for all terminals (0110), a tray launcher and a system panel
  (0111–0112).
- Removed Windows freezes (ConPTY close, session I/O, disk sampling) and made
  typing fluid (0113–0119).

### 2026-09-21 → 09-23 — A persistent host (0121–0160)

- **Terminals moved into `bethterm-host.exe`** (0121). Closing the GUI no
  longer loses terminals; the GUI attaches to the host. Host updates are
  staged and applied on the next start (0122, 0128, 0141–0144).
- Left-rail "Painel" listing live terminals (0124); tray watchdog and
  recovery from Explorer restarts (0126, 0145–0146); restart only the GUI
  (0147); windows come back where they were (0148).
- Hide all windows, per-window icon colour, agent-waiting alerts on icons and
  tray, CPU or GPU drawing (0150–0156).
- Diagnostics: a host life log (0157) and a click log (0158).
- Reverted: 0129. "One host per window" (0159) caused duplicated tabs,
  collapsed splits and lost hosts, and was replaced by a single host with
  automatic recovery (0167).

### 2026-09-25 — The bridge and Beth Studio (0161–0190)

- Restore fixes (shell kept for WSL, sliver panes, saved sizes), a UI stall
  watchdog that kills only the stuck host, a GDI leak fixed, latency meters
  (0161–0170, 0174, 0177).
- `bethterm cli bridge` (0171): a JSON line protocol to list, watch, resize,
  spawn and close terminals. It never starts or stops the host or the GUI.
- **Beth Studio** (Go + React in WebView2) built on that bridge: its own tabs
  and splits, search, drag-and-drop, custom frameless window, links and file
  preview, a database panel, SSH and serial sessions, voice dictation with a
  technical vocabulary (0173, 0186, 0188, 0190).
- A skeleton mobile app (Expo) for remote access; user-defined shells in a
  JSON file (0183).

### 2026-09-26 → 09-27 — Studio grows, native window becomes optional (0191–0192)

- Database window, SFTP window, grid cell editing, terminal list that follows
  the PowerShell prompt after `cd` (0191).
- **The native window can be turned off** while the host, the tray and Studio
  keep running (0192, 0193).
- Redesigned task manager with WSL2 memory and swap, clearer tray labels,
  and the first phone page served through a Linux proxy.

### 2026-09-29 → 10-01 — Studio as the daily interface

- Text editor panel and notes, sidebar grouped by folder, dictation into the
  right terminal, opening progress screen.
- The whole Studio in a browser, and a separate phone web app with its own
  build and themes.
- Folder browser, "new file", paste any file from Explorer and hand the path
  to the agent.
- Database: row insert, delete and duplicate applied in one transaction;
  many bug fixes.

### 2026-10-02 — Detached terminals and a calmer layout

- Database tree lists every database the user can reach, multi-row delete,
  saved queries and a searchable history across connections.
- Notes save themselves; the text panel is movable and resizable.
- **Detached terminals**: a terminal or SSH session can become its own native
  window, go to another monitor, and be dropped back onto the tab bar. Closing
  it never stops the terminal. Design:
  [`superpowers/specs/2026-10-02-terminal-destacado-design.md`](superpowers/specs/2026-10-02-terminal-destacado-design.md).
- Tool buttons moved to the left panel, connection LED beside the title,
  opening screen lists the terminals being assembled, a 28 px tab bar.
- The installer now packages Beth Studio.

### 2026-10-03 — Tray menu, a clean tree, and the Studio takes over the host (0194–0198)

- **Beth Studio now supervises the host** (phase A of the plan to retire the
  native window): it starts `bethterm-host.exe`, restarts it after a crash
  (3 in 10 minutes), has its own tray icon, and hides there when its window
  is closed. Stopping the host still needs a confirmed **Encerrar tudo**.
  Spec: [`superpowers/specs/2026-10-03-studio-supervisor-design.md`](superpowers/specs/2026-10-03-studio-supervisor-design.md).
  Tests use a host id so the real host is never seen.
- **Phase A2: terminals come back after a host crash.** A per-terminal recipe
  (`pane-specs.json`), a restore that recreates terminals in the same tabs and
  folders, and a WSL gate that waits for the distro, runs an optional init command
  once per boot, and waits for the folder (patch 0197: `--cd` and `-d`).
- **Phase B: the native window is gone (0198).** `wezterm-gui` and everything only
  it needed (window system, fonts, toast, the settings app, vendored C libraries,
  ANGLE/Mesa) left the tree. The host and the bridge are what remain of WezTerm,
  plus `wtinator` trimmed to what they use. The installer ships `bethterm-web.exe`;
  `start`/`ssh`/`serial`/`connect` now point to Beth Studio. 611 base files were
  removed (`UPSTREAM_REMOVED.txt`); 27 are still modified.
- Tray menu regrouped: Beth Studio first, everything about the native window
  in one submenu, and clearer exit labels (0196).
- Test fixtures made neutral (no real hosts, addresses or personal paths),
  and an importer for another product's saved connections was removed to
  keep the project free of third-party references.

## Dead ends and reversals worth remembering

| What | Outcome |
| --- | --- |
| Skia overlay for the right-click menu | Replaced by native Windows menus (0009–0010) |
| Pane-tab bar (0065) | Shelved; retry as real tabs grouped by project |
| 0129 | Reverted |
| One host per window (0159) | Reverted by a single host with recovery (0167) |
| Moving native popups to a helper thread | Fixed one crash, broke every menu; they must stay on the UI thread |

## Rules that came out of incidents

- Never stop the host while terminals are live. The host life log
  (`host-life.log`) records every start, stop and who asked.
- Test in isolation with a short temporary `APPDATA`; never install over a
  running host.
- Close views and windows never kill a terminal. Only an explicit, confirmed
  action does.
