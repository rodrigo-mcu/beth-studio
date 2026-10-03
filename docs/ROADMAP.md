# Roadmap

This is the Beth Studio release plan. Versions follow semver. The "we ship in this release" column is the **user-visible** scope — internal refactors don't appear here.

| Version | Codename | Theme | Status |
| --- | --- | --- | --- |
| **v0.1.0** | "Groups" | Tab groups + right-click menu + tabbed/split shells | 🔵 in progress |
| **v0.2.0** | "Broadcast" | Broadcast input + scope modes | ⚪ Planned |
| **v0.3.0** | "Themes" | VS Code theme search & import + settings sync | ⚪ Planned |
| **v0.4.0** | "Polish" | Status bar, quick switcher, saved layouts, per-pane tags | ⚪ Planned |
| **v0.5.0** | "SSH" | Hosts UI + connection dialog | ⚪ Future |
| **v0.6.0** | "Profiles" | Profile bundles | ⚪ Future |
| **v0.7.0** | "Bitvise" | Graphical SFTP | ⚪ Future |
| **v1.0.0** | "Stable" | Locked feature set, API stability promise | ⚪ Future |

`Status: ⚪` means **planned but not implemented**. The README does not list shipped features until they are merged.

---

## v0.1.0 — "Groups"

**Goal:** ship a usable terminal that you can switch on and have a noticeably better time than stock wezterm.

### Required

- [x] Workspace + crates wired (`wtinator`, `wezterminator`). **Done in Phase 0.**
- [x] First-run setup, no config needed. **Done in Phase 0.**
- [x] Right-click context menu (native Win32 HMENU, see `FEATURES.md §1.4`). **Done in Phase 1.B/1.D with patch 0009.**
- [x] `Split right` (vertical) and `split down` (horizontal) from the `│ Split` label and from the right-click menu. **Done in Phase 1.B with patches 0007/0008/0009.**
- [x] Connect to: `cmd.exe`, `powershell.exe`, `pwsh.exe`, `wsl.exe`, WSL — Ubuntu, Git Bash. **Done in Phase 1.D with patch 0006 (via `+` button menu).** Nushell not in the picker yet.
- [ ] Tabs: open, close, rename, reorder, focus next/prev. (open and close are upstream; rename/reorder/focus are not yet wired)
- [ ] Tab groups: create, name, activate by hotkey (Alt+1..9), persist, restore.
- [ ] Group picker (`Ctrl+Shift+G P`).
- [ ] Save / restore groups to a JSON file.
- [ ] Clipboard: copy, copy as HTML, paste, paste as quote, paste as base64.
- [ ] Bracketed paste on by default.
- [ ] Smart paste detection (at minimum: shell prompt, password, y/N, heredoc).
- [ ] Bundled font presets (Cascadia Code default; prompt to download JetBrains Mono / Fira Code).
- [ ] Reload config without restart.
- [ ] `cargo clippy -- -D warnings` clean.
- [x] `cargo test --workspace` green. **Done: 7/7 unit tests passing.**
- [x] `docs/FEATURES.md`, `docs/CONFIG.md`, `docs/THEMING.md`, `docs/HACKING.md` complete. **Done in Phase 0.**
- [ ] CI: Windows + Linux + macOS builds pass. (CI workflow is written; not yet run end-to-end on GitHub.)
- [ ] `cargo deny check licenses` clean.
- [ ] THIRD-PARTY-NOTICES.md generated.

### Out of scope for v0.1.0

- Broadcast input → v0.2.0.
- VS Code theme import → v0.3.0.
- Status bar → v0.4.0.
- SSH, profiles, SFTP → v0.5+.

### Acceptance criteria

A user with the v0.1.0 release binary can:

1. Run `wezterminator` and see a single tab with PowerShell. ✅ **Done**
2. Click the `+` button on the tab bar → "Open a new terminal" menu → pick a shell (cmd / PowerShell 5.1 / PowerShell 7+ / WSL / WSL — Ubuntu / Git Bash) → a new tab opens with that shell. ✅ **Done via patch 0006 + 0009**
3. Right-click in the new tab → menu with splits (right/down) and close pane → click "Split right" → a new pane appears on the right. ✅ **Done via patch 0009**
4. Click the `│ Split` label in the tab bar → native split picker. ✅ **Done via patches 0007/0008/0009**
5. Press `Ctrl+Shift+G N`, type "dev", press Enter → a new group "dev" is created with the current tabs. (pending — groups feature)
6. Press `Alt+1` → the "dev" group is shown. (pending)
7. Press `Ctrl+Shift+G P` → the picker opens; type a partial name and Enter to switch. (pending)
8. Quit, restart → groups are restored. (pending)

Items 1-4 pass with the current release. Items 5-8 are blocked on the tab-groups feature (Phase 1.C in `IMPLEMENTATION.md`).

If any of items 5-8 fails, v0.1.0 is not done.

---

## v0.2.0 — "Broadcast"

**Goal:** the Terminator parity feature.

### Required

- [ ] `wtinator.features.broadcast = true` enables broadcast.
- [ ] Scope modes: off / all / group / selection / tagged.
- [ ] `Alt+B` cycles scope; visible status indicator (border color + status-bar text).
- [ ] `Ctrl+Click` to add a pane to the explicit selection.
- [ ] Per-pane tags.
- [ ] Broadcast filtering happens at the `Pane::send_key` / `Pane::send_paste` chokepoint — see `ARCHITECTURE.md` §"Broadcast input".
- [ ] Settings: `wtinator.broadcast.default_scope`, `wtinator.broadcast.border_color`.
- [ ] New unit tests for the broadcast filter.

### Out of scope

- Visual per-character indicator on the focused pane (just the border for now).
- Cross-window broadcast (across two wezterminator processes) — out of scope for v0.2.

### Acceptance criteria

1. Open three panes on three different hosts.
2. Set scope to "all", type `uname -a` in one → all three receive it.
3. Set scope to "group", open a different group, type → only the panes in the active group receive it.
4. Set scope to "tagged", tag two of the three panes `prod`, type → only those two receive it.
5. Set scope to "off", type → only the focused pane receives it.

---

## v0.3.0 — "Themes"

**Goal:** match whatever theme the user has in VS Code.

### Required

- [ ] `wtinator.features.vscode_theme_import = true` enables the importer.
- [ ] `wtinator.features.vscode_settings_sync = true` enables the settings sync.
- [ ] The `vscode:` prefix on `color_scheme` works for: local `.json` paths, marketplace URLs, `publisher.name` ids.
- [ ] In-app theme picker (`Ctrl+Shift+T`) with fuzzy search.
- [ ] Browse VS Code themes in-app (uses the Marketplace API).
- [ ] Drag-and-drop a `.vsix` to install a theme.
- [ ] The default `wtinator.vscode_settings_path` resolves to the right location on Windows / macOS / Linux.
- [ ] Tests for the importer using the fixtures in `assets/test-themes/`.

### Out of scope

- High-contrast / accessibility-specific themes — defer to a future minor.

### Acceptance criteria

1. With `vscode_settings_sync = true`, restart the app; the font and font size match VS Code's `terminal.integrated.*` keys.
2. With `color_scheme = 'vscode:dracula-theme.theme-dracula'`, restart; the colors match Dracula.
3. In the picker, type "solar" → only matching themes appear; click one → colors update live.
4. Drag a `.vsix` onto the window → a new theme appears in the picker.

---

## v0.4.0 — "Polish"

**Goal:** make the daily-driver feel right.

### Required

- [ ] Status bar with default widgets.
- [ ] Quick switcher (`Ctrl+Shift+K`).
- [ ] Per-pane tags (already added in v0.2, but UI polish in v0.4).
- [ ] Saved layouts — export/import JSON, version-controllable in git.
- [ ] `.wezterminator/`-directory auto-detection (suggest restoring layout when entering a project).
- [ ] UX review pass: every new feature has a keyboard shortcut, a menu item, and a tooltip.

### Out of scope

- Plugin / extension API.
- Themes marketplace beyond VS Code.

### Acceptance criteria

1. Open 6 panes in a 2x3 grid, save as a layout named "demo".
2. Export to JSON, share it.
3. In a fresh window, restore the layout → the panes are recreated.
4. `Ctrl+Shift+K` opens the picker; type a partial pane title, Enter → focus moves.

---

## v0.5.0 — "SSH"

**Goal:** a first-class SSH host manager.

### Required

- [ ] Connection dialog (host, port, user, key, jump host).
- [ ] Hosts list built from `~/.ssh/config` plus a WezTerminator-side cache.
- [ ] Recent hosts in the right-click menu.
- [ ] Per-host thumbnail of last session.
- [ ] No GUI SFTP yet (that's v0.7).

### Out of scope

- Agent forwarding UI (use `~/.ssh/config`).
- Port-forwarding UI.

---

## v0.6.0 — "Profiles"

**Goal:** named bundles that can be launched with one click.

### Required

- [ ] Profile schema (shell, cwd, env, panes, post-startup commands).
- [ ] Profiles directory `~/.wezterminator/profiles/` scanned at startup.
- [ ] Right-click → "Profiles" submenu lists them.
- [ ] Hotkey for the first 9 profiles (Alt+Shift+1..9).

---

## v0.7.0 — "Bitvise"

**Goal:** a graphical SFTP client, embedded in WezTerminator.

### Required

- [ ] Two-pane file browser widget.
- [ ] SFTP transport over `wezterm-ssh`.
- [ ] Drag-and-drop and `F5` to copy.
- [ ] Queue with progress bars.
- [ ] Resume on disconnect.
- [ ] Permission editor (chmod UI).

### Out of scope

- SFTP over an arbitrary TCP connection (we always go through SSH).
- Mounting a remote filesystem locally (FUSE, etc.) — use WinFsp or sshfs separately.

---

## v1.0.0 — "Stable"

**Goal:** the version we recommend to non-technical users.

### Required

- [ ] All v0.x features are stable.
- [ ] Config schema is frozen (`wtinator = { ... }` is documented as stable).
- [ ] We commit to backward-compat for the `wtinator` namespace.
- [ ] A test matrix covers Windows 10 / 11, macOS 12+ (Intel and Apple Silicon), Ubuntu 22.04+.
- [ ] Performance budget: cold start < 500 ms on a mid-range Windows 11 machine.
- [ ] Security review of the SSH layer (we ship wezterm's; we just need to confirm).
- [ ] SBOM published with every release.

### Out of scope (forever)

- Plugin / extension system beyond Lua config.
- Mobile.
- A web version.
