# Features

This document is the **spec**. Every Beth Studio feature is described here in enough detail to implement, test, and document for end users.

The features are split into three groups:

1. **Core (v0.1.x)** — what we ship in the first public release.
2. **Workflow delta (v0.2.x – v0.4.x)** — the things that make us better than stock wezterm/terminator.
3. **Future (v0.5.x+)** — features that need a real backend, a native dialog, or a network protocol.

Status legend: 🟢 done · 🟡 in progress · ⚪ planned · 🔵 research.

---

## 1. Core (v0.1.x) — we ship these in the first release

### 1.1 The terminal itself

| Property | Value | Source | Status |
| --- | --- | --- | --- |
| Renderer | GPU (Skia) — inherited from wezterm | upstream | 🟢 done |
| Font rendering | FreeType + HarfBuzz, ligatures, fallback chains | upstream | 🟢 done |
| Color depth | 24-bit true color + 256-color palette + 16-color ANSI | upstream | 🟢 done |
| Scrollback | Configurable, default 10 000 lines | upstream | 🟢 done |
| Performance target | 60 fps at 200×50 cells on integrated GPU | upstream | 🟢 done (verified) |
| Hidden / minimized | Skip GPU paint; PTY and session keep running | patch 0116 | 🟢 done |
| Persistent host | `bethstudio-host.exe` owns PTYs; GUI attaches | patch 0121 | 🟢 done |
| Pane dashboard | Fixed list of names; click switches the terminal | patch 0124 | 🟢 done |
| Output floods (Tab) | Paint frames; keep line caches; coalesce PTY | patch 0119 | 🟢 done |

Beth Studio ships **the same renderer** as wezterm. There is no rewrite, no rewrite-into-wgpu, no "we'll do it later." If the wezterm GPU pipeline ever changes upstream, we follow it. While a window is minimized or hidden in the notification area, the GPU does not paint; restore invalidates so the first frame is current.

### 1.2 Connect to any local shell

Beth Studio must be able to spawn a terminal backed by any of the following, selectable per pane. **In v0.1.0, the shell picker is exposed as a native Win32 popup menu** (see §1.4 below) when the user clicks the `+` button on the tab bar, and as the **Novo terminal** submenu on the notification-area icon (patch 0117).

| Backend | Spawn command (Windows) | Notes | Status |
| --- | --- | --- | --- |
| **Windows Console (cmd.exe)** | `cmd.exe` | The traditional Windows shell. | 🟢 done |
| **PowerShell 5.1** | `powershell.exe -NoLogo` | Default on Windows 10/11. | 🟢 done |
| **PowerShell 7+** | `pwsh.exe -NoLogo` | If installed. | 🟢 done |
| **WSL 2 (default distro)** | `wsl.exe` | Wezterm already supports WSL as a domain; we just expose it in the menu. | 🟢 done |
| **WSL 2 (Ubuntu)** | `wsl.exe -d Ubuntu` | For multi-distro setups. | 🟢 done |
| **Git Bash** | `C:\Program Files\Git\bin\bash.exe --login` | If installed. | 🟢 done |
| **Nushell** | `nu.exe` | If installed. | ⚪ planned (not in picker yet) |
| **Custom** | User-defined command | Per-pane override. | ⚪ planned (Lua config) |
| **Git Bash** | `"C:\\Program Files\\Git\\bin\\bash.exe" --login` | Optional, only if `bash.exe` is on PATH. |
| **Nushell** | `nu.exe` | If installed. |
| **Custom** | User-defined command | Per-pane override in the right-click menu. |

The right-click context menu on the **tab bar** and on any **pane** exposes these as quick choices. See [§1.4](#14-right-click-context-menu) below.

### 1.3 Tabs

- A window can have N tabs.
- A tab has a tab bar with one button per tab.
- A tab contains **one or more panes** arranged in a split layout (wezterm's existing `SplitDirection`).
- Closing a tab closes all of its panes (with a confirm dialog if any pane is busy).
- Tabs are reorderable via drag in the tab bar.
- Each tab can be named ("rename tab" via right-click → Rename).
- **Painel** (patch 0124): fixed-width list of terminal names. Click
  a row to switch that terminal onto the right. Tab chips are hidden
  while the Painel is open. Tray menu **Painel**. Does not split.

### 1.4 Right-click context menu

**Status: 🟢 done in v0.1.0 (using a native Win32 HMENU, see "Implementation note" below).**

A first-class context menu. We initially planned to render it in
Skia (for HiDPI control and theme consistency) but discovered that
the upstream `InputSelector` Skia overlay did not appear for some
users in some Windows sessions. We migrated to a **native Win32
HMENU popup** instead. The native menu is themed by the OS, always
on top of the wezterm window, and is visible in every Windows
session. The visual is "Windows 10/11 default context menu" — a
light gray background with a black border, just like right-clicking
on File Explorer.

The context menu is available in four places:

#### 1.4.1 On the `+` button (left-click) — "Open a new terminal"

```
┌──────────────────────────────────┐
│ Open cmd.exe                  &1 │  ← native Win32 HMENU
│ Open PowerShell 5.1           &2 │
│ Open PowerShell 7+            &3 │
│ Open WSL (default distro)     &4 │
│ Open WSL — Ubuntu            &5  │
│ Open Git Bash                 &6 │
└──────────────────────────────────┘
```

After picking an item, the corresponding shell is spawned into a
new tab using `KeyAssignment::SpawnCommandInNewTab`.

#### 1.4.2 On the `+` button (right-click) — full menu

```
┌──────────────────────────────────┐
│ Open cmd.exe                  &1 │
│ Open PowerShell 5.1           &2 │
│ Open PowerShell 7+            &3 │
│ Open WSL (default distro)     &4 │
│ Open WSL — Ubuntu            &5  │
│ Open Git Bash                 &6 │
│ ─── ─── ─── ─── ─── ─── ─── ───  │
│ Split right   (vertical)         │  ← via KeyAssignment::SplitHorizontal
│ Split down    (horizontal)       │  ← via KeyAssignment::SplitVertical
│ ─── ─── ─── ─── ─── ─── ─── ───  │
│ Close pane                 Ctrl+W│
└──────────────────────────────────┘
```

#### 1.4.3 On a pane (right-click inside the terminal)

Same as §1.4.2: the full menu with shells, splits, and close pane.
The previous "Copy / Paste" sub-menu is **not** in v0.1.0 (it is
upstream wezterm behavior; we do not change the upstream right-click
text-selection logic).

#### 1.4.4 On the `│ Split` label (left-click) — split picker

The label is automatically rendered on the tab bar (top-left) by
`patch 0008`. Clicking it opens:

```
┌──────────────────────────────────┐
│ Split right   (vertical)      &S │
│ Split down    (horizontal)    &D │
└──────────────────────────────────┘
```

#### Implementation note: native Win32 menu, not Skia

The menu is built with `CreatePopupMenu` + `AppendMenuW` and shown
with `TrackPopupMenuEx`. The HWND is obtained with
`GetForegroundWindow` to avoid a `RefCell already mutably borrowed`
panic in `Window::raw_window_handle`. The item dispatch is by
`wID` (a stable `u16` in the `0x1000..` range). See
`upstream-wezterm/patches/0009-native-menu.md` for the migration story,
plus patches 0010 and 0011 for the Windows right-click stability fixes.
The working rule is: open the terminal-pane menu on right-button release,
defer `TrackPopupMenuEx` to the UI/main thread after the mouse callback,
and guard reentrant `WM_PAINT` / `WM_MOUSELEAVE` messages.

### 1.5 Splits — horizontal and vertical

**Status: 🟢 done for the right-click menu and the `│ Split` label. The hotkeys are upstream defaults.**

Two operations, two right-click entries, one `│ Split` label:

- **Split right** (vertical split) — current pane shrinks horizontally, a new pane appears on the right with the default shell.
- **Split down** (horizontal split) — current pane shrinks vertically, a new pane appears below with the default shell.

Default hotkeys (configurable, upstream defaults):

| Action | Default |
| --- | --- |
| Split right | `Ctrl+Shift+D` (wezterm default) |
| Split down  | `Ctrl+Shift+O` (wezterm default) |
| Close pane  | `Ctrl+Shift+W` |

Both directions support **N-level nesting**. A 2×2 grid is two horizontal splits inside two vertical splits. The internal storage is a `SplitDirection` tree (already in `mux/src/tab.rs`); we don't change the data model.

### 1.6 Tab groups (the key differentiator from Terminator)

> This is why someone installs Beth Studio over Terminator and over wezterm.

**Definition.** A **tab group** is a named, switchable, saveable collection of **N tabs**, where each tab has its own layout. Switching groups brings all the tabs in that group to the foreground in the current window.

**Key terms.**

- **Group** — a named set of tabs.
- **Active group** — the group whose tabs are currently visible.
- **Group shortcut** — a hotkey that activates the group in one keystroke.

**Default hotkeys.**

| Action | Default | Notes |
| --- | --- | --- |
| New group from current tabs | `Ctrl+Shift+G N` | Prompts for a name. |
| Activate group 1..9 | `Alt+1` … `Alt+9` | Browser-style. |
| Next group | `Ctrl+Shift+G >` | |
| Previous group | `Ctrl+Shift+G <` | |
| Save group as layout | `Ctrl+Shift+G S` | Persists to disk. |
| Restore layout | `Ctrl+Shift+G R` | |
| Show group picker | `Ctrl+Shift+G P` | Searchable UI. |

**Storage.** Groups live in a `wtinator::GroupRegistry` (a sidecar in `Mux`). The registry is serialized to `~/.local/share/wezterminator/groups.json` (Linux), `~/Library/Application Support/wezterminator/groups.json` (macOS), and `%APPDATA%\wezterminator\groups.json` (Windows) on graceful exit and on explicit save.

**Schema (groups.json):**

```json
{
  "version": 1,
  "active_group_id": "dev",
  "groups": [
    {
      "id": "dev",
      "name": "Dev",
      "tabs": [
        {
          "title": "Editor",
          "active_pane_index": 0,
          "panes": [
            { "shell": "pwsh", "cwd": "C:\\src\\app", "size": 0.5, "direction": "vertical" },
            { "shell": "pwsh", "cwd": "C:\\src\\app", "size": 0.5, "direction": "vertical" }
          ]
        },
        {
          "title": "DB",
          "panes": [
            { "shell": "wsl:Ubuntu", "cwd": "~", "size": 1.0 }
          ]
        }
      ]
    },
    {
      "id": "ops",
      "name": "Ops",
      "tabs": [ /* … */ ]
    }
  ]
}
```

### 1.7 Beautiful fonts and copy/paste

**Fonts.** Wezterm's font subsystem is preserved as-is. We add three opinionated presets in `wtinator::font_presets`:

| Preset | Family | Size | Ligatures | Notes |
| --- | --- | --- | --- | --- |
| `Cascadia Code` (default) | Cascadia Code | 11 | yes | Ships with Windows Terminal. |
| `JetBrains Mono` | JetBrains Mono | 11 | yes | Download-bundled. |
| `Fira Code` | Fira Code | 11 | yes | Download-bundled. |
| `Hack` | Hack | 11 | no | |
| `Iosevka` | Iosevka | 11 | yes | Powerline-ready. |

Bundled fonts are downloaded **on first run** with a clear consent dialog, and stored in `%LOCALAPPDATA%\wezterminator\fonts\`.

**Copy/paste pipeline.**

| Action | Behavior |
| --- | --- |
| **Copy** (selected text, no `Ctrl+Shift+C` modifier) | Writes plain text + RTF to the system clipboard. |
| **Copy as HTML** | Wraps the selection in a `<pre>` with inline `color` styles. |
| **Paste** | Reads the system clipboard, strips trailing whitespace by default. |
| **Paste as quoting** | Prefixes each line with `> `. |
| **Paste as Base64** | Useful for SSH key material. |
| **Bracketed paste** | Always on, sends the `?2004h` / `?2004l` wrap so shells know what's coming. |
| **Smart paste detection** | See [§1.8](#18-smart-paste-detection). |

### 1.8 Smart paste detection

Before forwarding a paste, we inspect the **last few lines of the scrollback** to detect context. The detector returns one of:

| Context | Paste mode |
| --- | --- |
| Plain shell prompt (e.g. `PS C:\src> `, `$ `, `user@host:~$ `) | Plain. |
| Password prompt (regex: `password:`, `passphrase:`, `[sudo] password`) | Strips newlines, disables echo in the local echo if the shell supports it. |
| y/N prompt | Inserts `y` + Enter. |
| REPL continuation (e.g. `…`, `> `, `    ` after a `def`/`if`/`(`) | Inserts literal newlines. |
| Heredoc (`<<EOF`, `<<-EOF`, `<TAG>`) | Strips leading `>` continuation markers from the pasted text. |
| Vim/Neovim normal mode | Tries to leave insert mode first. |
| Vim/Neovim insert mode | Sends paste. |
| `less`/`more` pager | Quits the pager first. |
| Nothing matched | Falls back to **plain**. |

The detector runs entirely on the **scrollback text** we already have in `Surface`; no PTY peeking, no extra process. It is a pure function from `(recent_scrollback: &str) -> PasteMode`.

The default is "prompt detected → ask the user" via a small toast in the corner of the pane. The user can pin a default per pane via right-click → "Always paste as …".

### 1.9 VS Code theme support

See [`THEMING.md`](THEMING.md) for the full spec. The short version:

- We ship with wezterm's 200+ built-in color schemes.
- **VS Code theme search**: `Settings → Themes → Browse VS Code themes` opens an in-app browser over the [VS Code Marketplace Theme API](https://marketplace.visualstudio.com/search?target=VSCode&category=Themes&sortBy=Installs).
- **VS Code theme import**: a theme URL or extension identifier is downloaded, the theme JSON is extracted, and we generate a wezterm `ColorScheme` on the fly.
- **VS Code settings sync**: `terminal.integrated.fontFamily`, `fontSize`, `fontWeight`, `cursorStyle`, `cursorBlink`, `padding`, `scrollback` are read from `%APPDATA%\Code\User\settings.json` and applied at config load time.

---

## 2. Workflow delta (v0.2.x – v0.4.x)

### 2.1 Broadcast groups (Terminator parity)

A **broadcast group** is a **set of panes** that all receive the same keystrokes simultaneously. The set is a **sidecar registry** keyed by group id, not a field on `Pane`.

**Scope modes** (cycled with `Alt+B`):

| Mode | Behavior |
| --- | --- |
| **Off** | Normal — only the focused pane receives input. |
| **All panes** | Every pane in the window, including hidden tabs. |
| **Tab group** | Every pane in the current tab group. |
| **Explicit selection** | The panes the user tagged via `Ctrl+Click`. |
| **Tagged panes** | All panes whose tag set includes the active tag (`prod`, `staging`, `build`, …). |

**Status indicator.** When broadcast is on, the focused pane gets a **border** in the scope's color:

| Mode | Border color |
| --- | --- |
| Off | (none) |
| All | Red |
| Group | Blue |
| Selection | Yellow |
| Tagged | Green |

The status bar (new in v0.2) shows the current scope and the number of panes receiving input.

### 2.2 Saved layouts

A **layout** is a group plus the contents of every pane. Layouts can be:

- **Saved to a file** (JSON) — shareable, version-controllable.
- **Restored from a file**.
- **Tagged with a project root** — Beth Studio detects a `.bethstudio/` directory in the cwd and offers to restore the layout.

### 2.3 Per-pane tags

Right-click → "Tag pane" → pick a tag from the list, or create one. Tags are global (per `Mux`), not per pane. Used by [§2.1](#21-broadcast-groups-terminator-parity) and by the group picker.

### 2.4 Status bar

A thin, configurable status bar at the bottom of the window:

```
[Dev | tab1* tab2 tab3]   scope:all(8)   shell:pwsh   group:dev   ⏱ 14:32
```

The fields are configurable via `wtinator.status_bar = { ... }`.

### 2.5 Quick switcher

`Ctrl+Shift+K` (VS Code style) opens a fuzzy-search picker over **all panes, tabs, groups, and saved layouts**. Type to filter; Enter to activate.

### 2.6 Reload config without restart

`Ctrl+Shift+R` reloads the Lua config file. The active window and tabs survive; only settings like fonts, colors, and keybindings change.

---

## 3. Future (v0.5.x+)

These are listed so future contributors know what we plan, but **they are not in v0.1 / v0.2 / v0.3 / v0.4**. The README does not claim them as shipped.

### 3.1 SSH (v0.5)

Reuse wezterm's `wezterm-ssh` crate. Add:

- A connection dialog: host, port, user, key, jump host.
- A **hosts** list persisted to `~/.ssh/config` parse + a BethStudio-side cache.
- Per-host thumbnails (screenshot of last session).
- A **"recent hosts"** list in the right-click menu.

### 3.2 Profiles (v0.6)

A **profile** is a named bundle of:

- Default shell (e.g. PowerShell 7 with a particular `$PROFILE`).
- Default working directory.
- Environment variables.
- A set of panes to open (e.g. "Editor + REPL + Server logs").
- Optional post-startup commands (run after the shell is ready).

Profiles are exposed in the right-click menu as a top-level section. `~/.bethstudio/profiles/` is scanned for Lua/JSON files.

### 3.3 Graphical SCP — "Bitvise-like" file transfer (v0.7+)

> This is a long-term feature. It is **not** a v0.x goal.

A two-pane file browser:

```
┌─ Local ──────────────────┬─ Remote (user@host) ───────┐
│ .. /                     │ .. /                         │
│   src/                   │   var/                       │
│   docs/                  │   etc/                       │
│   README.md   3 KB       │   log/                       │
│   Cargo.toml  1 KB       │   opt/                       │
│ [drwxr-xr-x] src/        │ [drwxr-xr-x] var/            │
│ ─────────────────────── │ ─────────────────────────── │
│ 4 items · 2 directories │ 6 items · 1 selected         │
└──────────────────────────┴──────────────────────────────┘
```

- Drag-and-drop or `F5` to copy.
- Queue with progress bars.
- Resume on disconnect.
- Permission editor (chmod UI).

The transport is **`wezterm-ssh` for SFTP** (wezterm already has SFTP primitives, see `wezterm-ssh/src/sftp.rs` in the upstream tree). The UI is a custom widget in `wtinator-gui` that does **not** reuse any file-explorer library — we draw it ourselves with Skia, the same way we draw the context menu.

This is a **v0.7+** feature because:

1. SFTP over wezterm-ssh needs API extensions upstream.
2. The Bitvise-style UX needs significant UX work.
3. We want to ship the core terminal features first and earn user trust before tackling this.

---

## 4. Out of scope

These are **explicitly not** planned. We say no so future contributors don't re-litigate:

- **tmux compatibility.** wezterm has `tmux_commands.rs`; we don't extend it.
- **Wayland/X11 native support on Linux.** wezterm handles it; we don't add a new backend.
- **Mobile (iOS/Android).** wezterm doesn't have it; neither do we.
- **A built-in editor.** That's VS Code's job.
- **A plugin marketplace.** Everything is config + a few Lua hooks.
