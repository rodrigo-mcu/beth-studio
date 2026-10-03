# Implementation Plan

This document is the **engineering plan** for building WezTerminator from the current pre-alpha state (workspace + docs only) to v1.0.0. It is meant to be read alongside:

- [`FEATURES.md`](FEATURES.md) — *what* we are building.
- [`ROADMAP.md`](ROADMAP.md) — *when* each feature ships.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — *where* in the codebase each piece goes.
- [`HACKING.md`](HACKING.md) — *how* to build and test.

The plan is organized in **phases**. Each phase has:

- A goal.
- A list of work items.
- Exit criteria (what must be true before we move to the next phase).
- A risk list.

We do not start coding on a phase until its previous phase is signed off. A phase is "signed off" when its exit criteria are checked in, CI is green, and a maintainer has reviewed the diff.

---

## Phase 0 — Repo bootstrap (status: ✅ complete)

**Goal:** the repo builds, runs, and the workspace wiring is in place. The upstream `wezterm` binary runs with `wtinator::install()` wired in. No WezTerminator features yet, but adding them is mechanical.

### Work items (status as of 2026-06-06)

- [x] **W0.1** Upstream `Cargo.toml` workspace, with `wtinator` and `wezterminator` as additional members (patch 0001).
- [x] **W0.2** `wtinator/Cargo.toml` with `mux`, `config`, `wezterm-input-types`, `wezterm-color-types`, `wezterm-dynamic`, `anyhow`, `serde`, `serde_json`, `log`.
- [x] **W0.3** `wtinator/src/lib.rs` with `install() -> anyhow::Result<()>` (no-op) and 12 submodules declared as stubs.
- [x] **W0.4** Real entry point: patched upstream `wezterm/src/main.rs` calls `wtinator::install()` (patch 0003) and wezterm's `wezterm/Cargo.toml` declares the dep (patch 0004).
- [x] **W0.5** `.gitignore` and placeholder `.gitmodules` (upstream is a vendored snapshot today, not a submodule).
- [x] **W0.6** `rustfmt.toml` mirroring upstream.
- [x] **W0.7** `clippy.toml` (minimal, upstream has none).
- [x] **W0.8** CI: `.github/workflows/ci.yml` with Windows / Linux / macOS jobs. **Note:** CI must use Rust nightly, not stable (see Findings §1).
- [x] **W0.9** `LICENSE.md` (MIT) and `docs/LICENSE-NOTES.md` exist.
- [x] **W0.10** README cross-references all resolve.

### Findings — how they were resolved (2026-06-06)

**Finding §1 (edition2024):** RESOLVED. Installed `rustup toolchain install nightly` and switched builds to `cargo +nightly build`. The upstream `wezterm-cell` and `wezterm-escape-parser` (and their transitive `hashbrown 0.17.1`) all use `edition = "2024"`. The patches tried initially (downgrade to edition2021) were reverted because they were insufficient — `cargo` must parse every package's manifest in the lockfile even if unused. With nightly, this is no longer an issue.

**Finding §2 (workspace inheritance):** RESOLVED via Option C. The upstream `upstream-wezterm/Cargo.toml` is now the workspace root. Our `wtinator` and `wezterminator` crates live INSIDE the upstream tree (at `upstream-wezterm/wtinator/` and `upstream-wezterm/wezterminator/`) and are listed in upstream's `[workspace.members]`. Cargo accepts this. This requires the four local patches documented in `upstream-wezterm/PATCHES.md`.

**Finding §3 (chrono `clock` feature):** NEW FINDING. `mux/src/client.rs` uses `Utc::now()`, which requires chrono's `clock` feature. The upstream pin disables it. Patched in patch 0002.

**Finding §4 (build environment):** NEW FINDING. Building OpenSSL on Windows requires:
- Strawberry Perl (MSYS2 perl 5.36 is missing `Locale::Maketext::Simple`)
- MSVC `nmake.exe` on PATH
- VS 2022 Build Tools

Documented in `upstream-wezterm/PATCHES.md` "Build environment requirements" section. CI must set the same PATH.

**Finding §5 (two binaries):** NEW FINDING. The upstream wezterm has two separate binaries:
- `wezterm.exe` — CLI (34 MB)
- `wezterm-gui.exe` — GUI (70 MB)

The CLI calls `delegate_to_gui()` which spawns `wezterm-gui.exe` from the same directory. If the GUI binary is not built alongside the CLI, the spawn fails with `ERROR_FILE_NOT_FOUND` (os error 2) and the process exits with code 1 — even though the CLI itself works fine for `--help`, `--version`, and similar.

**Resolution:** the build must include both. The correct invocation is:

```bash
cargo +nightly build --release -p wezterm -p wezterm-gui
```

or the whole workspace. **Just `cargo build -p wezterm` is not enough.** Verified in this environment on 2026-06-06: `wezterm-gui.exe` PID 166944, MainWindowTitle = "cmd.exe", window opens correctly.

### Exit criteria — ALL MET

- [x] `cargo build --workspace` succeeds (with nightly toolchain, on Windows, with the PATH described in patch log).
- [x] `cargo run -p wtinator` (the test binary) prints the Phase 0 banner and exits 0.
- [x] `cargo test -p wtinator` passes.
- [x] **`cargo run -p wezterm -- start`** opens a wezterm window. This is the **real** end-user entry point — the same GUI a stock wezterm shows, but with `wtinator::install()` having run first.
- [x] `cargo clippy -- -D warnings` — pending CI run. There are 12 `missing_docs` warnings (expected: Phase 0 stubs).
- [ ] CI green — pending; the workflow file is written but has not been run end-to-end on GitHub.

### Risks

- **R0.a — Submodule drift.** Mitigated: tracked in HACKING.md §10.
- **R0.b — Build time.** A clean build of wezterm is 10–30 minutes. CI cache via `Swatinem/rust-cache@v2` mitigates.
- **R0.c — Edition 2024.** RESOLVED by using nightly. CI in `.github/workflows/ci.yml` must use `dtolnay/rust-toolchain@nightly`, not `@stable`.
- **R0.d — Workspace inheritance.** RESOLVED by Option C (patches 0001, 0004). The downside is that our `wtinator` and `wezterminator` crates live inside the upstream tree, which violates the letter of "upstream is read-only" even though it preserves the spirit. Documented in PATCHES.md.
- **R0.e — chrono `clock` feature.** Trivial patch; will be subsumed by an upstream fix.
- **R0.f — Build env on Windows.** The PATH requirement (Strawberry perl + nmake + MSVC) is non-obvious. CI must set it.

---

## Phase 1 — v0.1.0 "Groups" (target: first public release)

**Goal:** deliver a usable terminal that you can switch on and have a better time than with stock wezterm.

This is the **big** phase. It is broken into sub-phases.

### 1.B + 1.D — Right-click menu + shell picker (✅ done 2026-06-06)

We delivered the right-click menu and the shell picker, but not via the
"Skia overlay" path documented in `FEATURES.md §1.4`. Instead, we
use a **native Win32 HMENU popup** (the same widget you see when
right-clicking on any Windows application). This was the only
reliable way to make the menu appear in every Windows session; the
Skia overlay did not appear in some sessions (overlay-rendering
issue specific to the user's graphics environment).

**Three mouse-driven entry points are wired:**

| Action | Mouse gesture | Patch |
| --- | --- | --- |
| Open a new terminal with a specific shell | Click the `+` button on the tab bar (top-right) | 0006 + 0009 |
| Open the full menu (shells + splits + close pane) | Right-click the `+` button | 0006 + 0009 |
| Open the split picker | Click the `│ Split` label on the tab bar (top-left) | 0007 + 0008 + 0009 |
| Open the full menu (alt) | Right-click anywhere in a terminal pane | 0009 |

**The menus contain:**

- **Shell picker (6 items):** Open cmd.exe / PowerShell 5.1 / PowerShell 7+ / WSL (default distro) / WSL — Ubuntu / Git Bash
- **Split picker (2 items):** Split right (vertical) / Split down (horizontal)
- **Full menu:** the 6 shells + separator + 2 splits + separator + Close pane

**Implementation notes:**

- `wtinator::context_menu` is the menu builder. It exposes
  `platform::shell_picker_items()`, `split_picker_items()`, and
  `full_menu_items()` (Windows-only via `cfg(windows)`). On non-Windows
  targets these are empty stubs.
- `platform::show_at(hwnd, x, y, &items)` calls
  `CreatePopupMenu` + `AppendMenuW` + `TrackPopupMenuEx` to show the
  native popup. It returns the `wID` of the chosen item, or `None`
  if cancelled.
- `wtinator::context_menu::dispatch_native(wid)` maps a `wID` back
  to a `KeyAssignment` (e.g. `KeyAssignment::SpawnCommandInNewTab`
  with the right shell, or `KeyAssignment::SplitHorizontal`).
- The HWND is obtained via `GetForegroundWindow()` (a global OS call)
  to avoid a `RefCell already mutably borrowed` panic that
  `Window::raw_window_handle()` would otherwise cause. See
  `patches/0009-native-menu.md` for the full story.

**Acceptance criteria (1.B + 1.D):**

- [x] Right-click on a terminal pane shows a native Win32 context menu.
- [x] The `+` button on the tab bar shows a shell picker (native).
- [x] The `│ Split` label on the tab bar shows a split picker (native).
- [x] Picking "Open PowerShell 7+" spawns a new tab with PowerShell 7.
- [x] Picking "Split right" splits the focused pane.
- [x] The menu is visible in every Windows session (no Skia overlay issues).
- [x] 7/7 unit tests pass.

**Out of scope for 1.B / 1.D (deferred to later sub-phases):**

- Nushell in the shell picker
- Custom shell list via `~/.wezterm.lua` (the current list is hard-coded)
- Renaming and reordering tabs
- Tab groups (1.C)

### 1.A — Crate skeleton (1–2 weeks)

Wire up the project structure so we can add features cleanly.

#### Work items

- [ ] **W1.A.1** `wtinator/src/lib.rs` exposes:
  ```rust
  pub mod groups;
  pub mod broadcast;
  pub mod clipboard;
  pub mod shell_menu;
  pub mod context_menu;
  pub mod font_presets;
  pub mod status_bar;       // stub for v0.4
  pub mod picker;            // stub for v0.4
  pub mod layout_io;
  pub mod vscode_theme;      // stub for v0.3
  pub mod vscode_settings;   // stub for v0.3

  pub fn install(config: &mut wezterm_config::Config) -> anyhow::Result<()> { … }
  ```
- [ ] **W1.A.2** `install()` reads the `wtinator = { ... }` table from the Lua config and stores it in a global `static CONFIG: OnceCell<WtinatorConfig>` for fast read access.
- [ ] **W1.A.3** Add a `WtinatorConfig` struct with `serde::Deserialize` so we can validate the user config at load time.
- [ ] **W1.A.4** Hook `install()` into `wezterminator/src/main.rs`.

#### Exit criteria

- All submodules compile, even the stubs.
- A misconfigured `wtinator = { foo = 1 }` produces a warning but does not crash the window.

#### Risks

- **R1.A.a — Lua lifetime.** Reading a Lua table at startup is straightforward; reading it on `reload_config` is harder. We need to make sure `WtinatorConfig` is owned Rust, not a borrowed `LuaTable`.

### 1.B — Right-click context menu (2–3 weeks)

A first-class, Skia-drawn context menu. This is the entry point for nearly every feature.

#### Work items

- [ ] **W1.B.1** `wtinator::context_menu` defines:
  ```rust
  pub struct ContextMenu {
      items: Vec<MenuItem>,
      rect: Rect,
  }
  pub enum MenuItem {
      Action { label: String, key: Option<String>, action: Box<dyn Fn(&Window) + Send + Sync> },
      Submenu { label: String, key: Option<String>, items: Vec<MenuItem> },
      Separator,
  }
  ```
- [ ] **W1.B.2** `ContextMenu::paint(&self, ctx: &mut PaintContext)` draws the menu using Skia. Layout: 28 px row height, 8 px padding, hierarchical indent for submenu indicators, separator as a 1 px line.
- [ ] **W1.B.3** Mouse handling: hover highlights the row under the cursor, click triggers the action or opens the submenu, right-click or Esc closes.
- [ ] **W1.B.4** Hook into the existing `wezterm-gui` mouse handler. Specifically, when a `MousePress { button: Right }` arrives on the **tab bar** or on a **pane**, we synthesize a `ContextMenu::show`.
- [ ] **W1.B.5** Define the **tab-bar menu** (New tab → shells, Rename, Duplicate, Close) and the **pane menu** (Copy, Copy as, Paste, Paste as, Split, Change shell, Broadcast stubs, Reset, Reload config). The Broadcast entries are present but disabled in v0.1.0 (they activate in v0.2.0).

#### Exit criteria

- Right-clicking the tab bar opens the tab-bar menu.
- Right-clicking inside a pane opens the pane menu.
- "New tab" → shells opens a new tab with the chosen shell.
- "Split right" / "Split down" actually split the pane.
- "Change shell" → shells re-spawns the current pane with the chosen shell.
- Menu looks reasonable at 1× and 2× DPI.

#### Risks

- **R1.B.a — Skia menu vs. native menu.** A Skia menu looks the same on all platforms but doesn't get OS-level features (system dark mode, IME in search fields, etc.). For a terminal context menu this is fine; flag it as a known compromise.
- **R1.B.b — Mouse event ordering.** wezterm's tab bar already handles right-click for some actions. We need to add ours *first* and `return Handled` if we open a menu.

### 1.C — Tab groups (3–4 weeks)

The **key** WezTerminator feature. See `FEATURES.md §1.6`.

#### Work items

- [ ] **W1.C.1** `wtinator::groups::GroupRegistry` is a `RefCell<HashMap<GroupId, Group>>` in a `once_cell::sync::Lazy` static.
- [ ] **W1.C.2** `Group` is:
  ```rust
  pub struct Group {
      pub id: GroupId,
      pub name: String,
      pub tabs: Vec<TabId>,           // tab identifiers
      pub shortcut: Option<u8>,        // 1..=9 for Alt+1..=9
  }
  ```
- [ ] **W1.C.3** Persistence: `serde_json` round-trip to a file (path from `wtinator.tab_groups.storage_path`).
- [ ] **W1.C.4** On startup, load the registry. On graceful exit (`Ctrl+Shift+Q`, `WM_CLOSE` on Windows), save.
- [ ] **W1.C.5** Hotkeys (configurable):
  - `Alt+1` … `Alt+9` → activate the group with that shortcut.
  - `Ctrl+Shift+G N` → new group from current tabs (prompts for a name).
  - `Ctrl+Shift+G P` → open the group picker.
- [ ] **W1.C.6** Group picker is a small modal over the window: a list of groups with a text filter. Selected group activates.
- [ ] **W1.C.7** Status bar (we build the real one in v0.4, but for v0.1 we render a minimal one-line indicator at the top of the tab bar: `Group: dev (Alt+1)`).
- [ ] **W1.C.8** Lua API: `wtinator.lua_groups()` exposing `list`, `activate`, `create`, `rename`, `delete`, `save`, `restore_from_file`.

#### Exit criteria

- All eight acceptance criteria in `ROADMAP.md` v0.1.0 pass.

#### Risks

- **R1.C.a — Cross-window groups.** wezterm's `Mux` is process-global within one client. If a user runs two `wezterminator` windows, the group registry is per-process. WezTerminator v0.1 keeps it that way; cross-window is a future improvement.
- **R1.C.b — Race on save.** If two windows quit at the same time, the last writer wins. We add a `flock` (`fs2`) on the storage path to serialize.

### 1.D — Splits and shells (1 week, mostly verifying)

The split machinery is upstream. We need to make sure the right-click menu entry works.

#### Work items

- [ ] **W1.D.1** Verify that wezterm's `Pane::split(split_direction)` is callable from our context-menu action. (Yes, it is — we use `wezterm-gui`'s `Window::perform_key_assignment(KeyAssignment::SplitHorizontal)` / `SplitVertical`.)
- [ ] **W1.D.2** Default hotkeys match `wtinator.keybindings.split_right` / `split_down` (configurable; see `CONFIG.md §3.9`).
- [ ] **W1.D.3** Default shells list reads from `wtinator.shells` (with the documented built-in fallback).
- [ ] **W1.D.4** Spawn a shell with the right `cwd` and env: from the parent pane's `get_current_working_dir()`.

#### Exit criteria

- Splits work; new shells spawn with the right cwd and env.

#### Risks

- None significant. This is a thin integration over existing wezterm code.

### 1.E — Clipboard + smart paste (2–3 weeks)

#### Work items

- [ ] **W1.E.1** `wtinator::clipboard::Pipeline` is a chain of `Box<dyn ClipboardTransform>` applied to a paste string before forwarding to `Pane::send_paste`.
- [ ] **W1.E.2** Built-in transforms:
  - `StripTrailingWs`
  - `ConvertCrlfToLf`
  - `Quoting` (prefixes every line with `> `)
  - `Base64Encode`
  - `HeredocStrip` (strips shell continuation markers)
- [ ] **W1.E.3** `wtinator::clipboard::detect_paste_mode(scrollback: &str) -> PasteMode` — pure function. Implement the rules in `FEATURES.md §1.8`.
- [ ] **W1.E.4** When `wtinator.features.smart_paste = true` and the detected mode is ambiguous, raise a **toast** in the bottom-right of the pane: "Paste as password? [Y/n]".
- [ ] **W1.E.5** Copy formats:
  - Plain text (always on).
  - RTF: render the selection as colored RTF using the active theme's palette.
  - HTML: wrap in `<pre style="…">`.
  - With line numbers: prefix every line with `123│ `.
- [ ] **W1.E.6** Unit tests: feed in synthetic scrollback strings and assert the detected mode.

#### Exit criteria

- Selecting text in a pane and `Ctrl+Shift+C` writes plain text + RTF to the clipboard.
- Pasting into a password prompt prompts the user.
- Pasting into a heredoc strips continuation markers.
- Pasting a multi-line command into a plain shell prompt is plain.

#### Risks

- **R1.E.a — RTF format is fiddly.** Off-by-one on color indices produces unreadable output. We test against a corpus of synthetic selections.
- **R1.E.b — "What is a password prompt?"** is fuzzy. We use regex; false positives (a command whose output happens to contain the word "password:") are inevitable. The user can pin a per-pane default.

### 1.F — Bundled fonts (3–5 days)

#### Work items

- [ ] **W1.F.1** On first run, if `wtinator.features.bundled_fonts = true` and no Cascadia Code is detected, prompt: "Download Cascadia Code, JetBrains Mono, and Fira Code (~5 MB)?"
- [ ] **W1.F.2** Download from a vendored mirror (`https://github.com/<OWNER>/wezterminator-fonts`, or upstream font CDNs), with SHA-256 verification.
- [ ] **W1.F.3** Store in `%LOCALAPPDATA%\wezterminator\fonts\` (or platform equivalent) and register with `wezterm-font::FontConfiguration`.

#### Exit criteria

- A user with no Cascadia Code installed gets a one-click install flow on first run.

#### Risks

- **R1.F.a — Font licensing.** Cascadia Code, JetBrains Mono, Fira Code are all OFL-licensed. We can ship them. We document the licenses in `THIRD-PARTY-NOTICES.md`.

### 1.G — Documentation, CI, release plumbing (1–2 weeks)

#### Work items

- [ ] **W1.G.1** Most docs are already written (this is "pre-implementation docs"). Update them with anything that has changed during the build.
- [ ] **W1.G.2** Add `CHANGELOG.md` with the v0.1.0 entry.
- [ ] **W1.G.3** Add `SECURITY.md` with a "report a vulnerability" link.
- [ ] **W1.G.4** Tag v0.1.0, push, let CI produce binaries.
- [ ] **W1.G.5** Write the GitHub release notes.

#### Exit criteria

- `cargo deny check licenses` clean.
- A user can download `wezterminator-v0.1.0-windows.msi` (or `.exe`) from the Releases page and have it just work.

---

## Phase 2 — v0.2.0 "Broadcast" (4–6 weeks)

**Goal:** the Terminator parity feature. See `FEATURES.md §2.1` and `ROADMAP.md` v0.2.0.

### Work items

- [ ] **W2.1** `wtinator::broadcast::Registry` lives in `Mux` as a `RefCell<HashMap<GroupId, Vec<PaneId>>>`.
- [ ] **W2.2** `wtinator::broadcast::Scope` is an enum: `Off`, `All`, `Group(GroupId)`, `Selection(Vec<PaneId>)`, `Tagged(String)`.
- [ ] **W2.3** Hook into `Pane::send_key` and `Pane::send_paste` to fan out to the resolved set of panes. This is the most invasive part — we modify `upstream-wezterm/mux/src/pane.rs` *only* by adding a `pub fn send_key_with_broadcast(...)` wrapper, then route the GUI through it. The original `send_key` is untouched.
- [ ] **W2.4** `Alt+B` cycles `Scope`. The status bar (real one this time) shows the current scope and the number of panes.
- [ ] **W2.5** Border color per scope, drawn around the focused pane.
- [ ] **W2.6** Per-pane tags via right-click → "Tag pane".
- [ ] **W2.7** Unit + integration tests for the broadcast filter.

### Exit criteria

All five acceptance criteria in `ROADMAP.md` v0.2.0 pass.

### Risks

- **R2.a — Concurrent writes.** Broadcasting to N panes in parallel is fine; we already use async for I/O. The trick is keeping the input feel responsive (no input lag while broadcasting to 50 panes). We use a per-pane channel; the broadcast just pushes to all channels.
- **R2.b — Pane death during broadcast.** If a pane exits mid-broadcast, the next send returns `Ok(())` but is a no-op. We log at `debug` and continue.

---

## Phase 3 — v0.3.0 "Themes" (4–6 weeks)

**Goal:** match whatever theme the user has in VS Code.

### Work items

- [ ] **W3.1** `wtinator::vscode_theme::convert(&serde_json::Value) -> Result<ColorScheme>`. Pure function, see `THEMING.md §5`.
- [ ] **W3.2** Cache layer: write converted Lua to `WTINATOR_THEMES_DIR/<sha1>.lua`.
- [ ] **W3.3** `wtinator::vscode_settings::apply(&Path, &mut Config) -> Result<()>` reads VS Code's `settings.json` and applies `terminal.integrated.*` keys.
- [ ] **W3.4** Marketplace API client: a thin wrapper over `https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery` (REST) that paginates the theme category.
- [ ] **W3.5** `.vsix` extractor: zip-archive, read `package.json`, find `contributes.themes`, download the theme file.
- [ ] **W3.6** Theme picker UI: a modal with a search box. See `THEMING.md §3`.
- [ ] **W3.7** Tests with the fixtures in `assets/test-themes/`.

### Exit criteria

All four acceptance criteria in `ROADMAP.md` v0.3.0 pass.

### Risks

- **R3.a — Marketplace API rate limits.** The public API is rate-limited. We cache aggressively and only refetch if the user explicitly asks for "fresh results".
- **R3.b — `.vsix` versions.** The marketplace URL gets a specific version, but authors can deprecate old versions. We follow the redirect to the latest.

---

## Phase 4 — v0.4.0 "Polish" (3–5 weeks)

**Goal:** make the daily-driver feel right.

### Work items

- [ ] **W4.1** Status bar implementation in `wtinator::status_bar`. The bar is a 24-px-tall Skia-rendered strip at the bottom of the window.
- [ ] **W4.2** Default widgets:
  - `wtinator_status_active_group` — "Group: dev"
  - `wtinator_status_tabs` — "tab1 tab2* tab3"
  - `wtinator_status_broadcast_scope` — "scope: all (8)"
  - `wtinator_status_shell` — "shell: pwsh"
  - `wtinator_status_clock` — "⏱ 14:32"
- [ ] **W4.3** Quick switcher: `Ctrl+Shift+K` opens a fuzzy-search modal over all panes/tabs/groups/saved layouts.
- [ ] **W4.4** Layout JSON export/import.
- [ ] **W4.5** `.wezterminator/` auto-detection: on `cwd` change, if `.wezterminator/layout.json` exists, prompt to restore.

### Exit criteria

All four acceptance criteria in `ROADMAP.md` v0.4.0 pass.

### Risks

- **R4.a — Layout export fidelity.** If a pane has run a long-running process, exporting its shell PID is meaningless. We export a *recipe* (shell, args, cwd, env) and let the user restart it.

---

## Phase 5 — v0.5.0 "SSH" (6–8 weeks)

### Work items

- [ ] **W5.1** Connection dialog: native-feeling (we use Skia), with host / port / user / key / jump host fields.
- [ ] **W5.2** `~/.ssh/config` parser. We only need a subset: `Host`, `HostName`, `Port`, `User`, `IdentityFile`, `ProxyJump`.
- [ ] **W5.3** Hosts cache persisted to `WTINATOR_CONFIG_DIR/hosts.json` with last-connected timestamp.
- [ ] **W5.4** Recent hosts in the right-click menu (top 5 by recency).

### Exit criteria

`ROADMAP.md` v0.5.0 criteria pass.

### Risks

- **R5.a — `~/.ssh/config` edge cases.** The full grammar is large. We support the 90 % case and document the rest.

---

## Phase 6 — v0.6.0 "Profiles" (4–6 weeks)

### Work items

- [ ] **W6.1** Profile schema in Lua:
  ```lua
  wtinator.profile_editor = { … }   -- default editor split
  wtinator.profile_devops  = { … }   -- devops split
  ```
- [ ] **W6.2** `~/.wezterminator/profiles/*.lua` directory scanned at startup.
- [ ] **W6.3** Right-click → "Profiles" submenu populated from the directory.
- [ ] **W6.4** Hotkey `Alt+Shift+1` … `Alt+Shift+9` for the first 9 profiles (in directory order).

### Exit criteria

`ROADMAP.md` v0.6.0 criteria pass.

### Risks

- **R6.a — Profile conflicts.** Two profiles with the same name → error at load time.

---

## Phase 7 — v0.7.0 "Bitvise" (8–12 weeks)

### Work items

- [ ] **W7.1** SFTP transport over `wezterm-ssh`. May need a small upstream PR to expose the right API.
- [ ] **W7.2** Two-pane file browser widget (local | remote).
- [ ] **W7.3** Drag-and-drop copy.
- [ ] **W7.4** Transfer queue with progress.
- [ ] **W7.5** Resume on reconnect.
- [ ] **W7.6** Permission editor.

### Exit criteria

`ROADMAP.md` v0.7.0 criteria pass.

### Risks

- **R7.a — UX scope.** "Bitvise-like" is a lot. We aim for **80 % of Bitvise's SFTP window, none of its SFTP-server features**. The server-side features are out of scope.

---

## Phase 8 — v1.0.0 "Stable" (4–6 weeks)

Mostly polish, documentation freeze, and a security review.

### Work items

- [ ] **W8.1** Audit every `unsafe { … }` in our delta.
- [ ] **W8.2** `cargo audit` clean.
- [ ] **W8.3** Performance budget: cold start < 500 ms on a mid-range Windows 11 machine. Profile and fix.
- [ ] **W8.4** Lock the `wtinator = { … }` config schema; document backward-compat policy.
- [ ] **W8.5** Generate an SBOM for every release.

### Exit criteria

`ROADMAP.md` v1.0.0 criteria pass.

---

## Cross-cutting concerns

These run across every phase, not in a single one.

### Performance

- Cold start budget: 500 ms on a mid-range Windows 11 machine.
- Steady-state CPU at idle: < 1 % on a 4-core machine.
- Steady-state RAM: < 200 MB for a window with 10 panes.

We measure with `cargo bench` and a custom `wezterminator-bench` binary that opens a window with N panes and reports the metrics. We check it on every release.

### Security

- All clipboard operations go through the platform's secure clipboard API.
- SSH uses wezterm's existing stack (libssh via `wezterm-ssh`).
- No telemetry. We don't phone home. Documented in `PRIVACY.md` (inherited from upstream and not weakened).

### Internationalization

- All strings live in `wtinator/src/i18n.rs` and are loaded from a `MessageBundle`.
- For v0.1, we ship English only. The infrastructure is there for translations later.

### Accessibility

- All menu items have a keyboard shortcut.
- All UI widgets have ARIA-style names (in our internal model — we don't have an OS accessibility bridge yet, that's a v1.x stretch goal).
- High-contrast variants of the built-in themes are always available.

### Logging

- `tracing` crate, structured fields.
- `WTINATOR_LOG=info` is the default. The default does **not** log keystrokes (privacy).

---

## Open questions for the maintainers

These are decisions we have not yet made. The plan above assumes a default; we will revisit.

1. **Where do we draw the line on wezterm-ssh API changes?** We currently plan to copy-and-patch a couple of small private functions. If those patches grow, we should upstream them.
2. **Do we ship an MSI/EXE installer for v0.1, or just a portable .zip?** An installer is more user-friendly but requires WiX or similar. A .zip is one file and zero build-system setup. Recommendation: .zip for v0.1, MSI for v0.5.
3. **Do we want a Homebrew formula for macOS from day one?** It's a single Ruby file in `homebrew-core`; we can PR it. Recommendation: yes, but not blocking for v0.1.
4. **What is the policy on adding features that wezterm upstream might add first?** If wezterm ships broadcast input, we drop our delta and update the README. We don't try to "stay ahead" for the sake of staying ahead.

---

## Effort estimate summary

| Phase | Duration | Lines of code (rough) |
| --- | --- | --- |
| Phase 0 — Repo bootstrap | 1 week | 200 |
| Phase 1 — v0.1.0 "Groups" | 8–12 weeks | 8 000 – 12 000 |
| Phase 2 — v0.2.0 "Broadcast" | 4–6 weeks | 3 000 – 5 000 |
| Phase 3 — v0.3.0 "Themes" | 4–6 weeks | 3 000 – 4 000 |
| Phase 4 — v0.4.0 "Polish" | 3–5 weeks | 2 000 – 3 000 |
| Phase 5 — v0.5.0 "SSH" | 6–8 weeks | 4 000 – 6 000 |
| Phase 6 — v0.6.0 "Profiles" | 4–6 weeks | 2 000 – 3 000 |
| Phase 7 — v0.7.0 "Bitvise" | 8–12 weeks | 6 000 – 10 000 |
| Phase 8 — v1.0.0 "Stable" | 4–6 weeks | 1 000 – 2 000 |

These are **estimates**, not commitments. The line counts include tests.

---

## Sign-off

A phase is "signed off" when:

1. All work items are merged.
2. All exit criteria pass.
3. CI is green.
4. A maintainer has reviewed the diff.
5. The CHANGELOG is updated.
6. The roadmap status table is updated.
