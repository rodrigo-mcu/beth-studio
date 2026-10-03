# Hacking — building, testing, debugging, releasing

This is the contributor's guide. If you just want to **use** Beth Studio, see the [README](../README.md) and the [user-facing config docs](CONFIG.md). If you want to **change** it, you're in the right place.

---

## 1. Repository layout

```
bethstudio/
├── README.md
├── LICENSE.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── run-bethstudio-release.cmd
├── run-bethstudio-debug.cmd
├── docs/                       # Product and contributor docs
├── .github/workflows/ci.yml
└── upstream-wezterm/           # Vendored WezTerm + Beth Studio delta
    ├── Cargo.toml              # Workspace root
    ├── wtinator/               # Beth Studio delta crate (historical name)
    ├── wtinator-config/        # Settings app
    ├── wezterminator/          # Placeholder binary (package `bethstudio`)
    ├── PATCHES.md
    └── patches/
```

See [PROJECT_LAYOUT.md](PROJECT_LAYOUT.md) for the rationale and the "what lives where" rules.

---

## 2. Prerequisites

### All platforms

- **Rust nightly 2026-06-05 or newer.** We track nightly because upstream
  wezterm uses `edition = "2024"`, which is not yet stable. Install with:
  ```bash
  rustup toolchain install nightly
  ```
  All `cargo` invocations below should be prefixed with `+nightly` or
  preceded by `rustup default nightly` for the duration of the session.
- **Git**. `upstream-wezterm/` is a vendored snapshot, not a live submodule.
- A C/C++ toolchain (wezterm's `get-deps` script will tell you what's needed).
- **cmake** and **ninja**.

### Windows

- **Visual Studio 2022 Build Tools** with the "Desktop development with C++" workload.
- **WebView2 Runtime** (preinstalled on Windows 11; ships with the Edge installer on Windows 10).
- **PowerShell 5.1** (already on the box) and optionally **PowerShell 7+** (`winget install Microsoft.PowerShell`).
- **Windows SDK 10.0.22621 or newer.**
- **Strawberry Perl** at `C:\Strawberry\perl\bin\perl.exe`. Required to build
  OpenSSL via `openssl-sys`'s perl `Configure` script. MSYS2's perl 5.36 is
  missing the `Locale::Maketext::Simple` module and will fail. Install with:
  ```powershell
  winget install StrawberryPerl.StrawberryPerl
  ```
- **MSVC `nmake.exe`** on PATH. Sourced by the VS Dev Shell, or added to
  PATH manually.

### macOS

- **Xcode 15+** command-line tools (`xcode-select --install`).
- macOS 12 (Monterey) or newer to build; macOS 11 to run the produced binary.

### Linux

- A `libfontconfig`, `libfreetype`, `libharfbuzz`, `libxkbcommon`, `libxcb`, `libwayland` development package set.
- A working OpenGL or Vulkan driver.

### 2.1 Get the wezterm snapshot

The first time you clone:

```bash
git clone https://github.com/<OWNER>/wezterminator
cd wezterminator
```

The `upstream-wezterm/` directory is **a vendored snapshot with its own
`.git/`** (not a submodule). To bump to a new upstream version, see
§10.

---

## 3. Building

### Debug build

```powershell
cd upstream-wezterm
$env:PATH = "C:\Strawberry\perl\bin;C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64;$env:PATH"
cargo +nightly build -p wezterm -p wezterm-gui -p wezterm-mux-server
cd ..
.\run-wezterminator-debug.cmd
```

The first build will take **10–30 minutes** because you're compiling
wezterm, FreeType, HarfBuzz, Skia, OpenSSL, and the SSH stack from
source. Subsequent builds are fast (incremental).

On Windows, you may need to set the PATH for OpenSSL to build:

```powershell
$env:PATH = "C:\Strawberry\perl\bin;C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64;$env:PATH"
cargo +nightly build -p wezterm -p wezterm-gui -p wezterm-mux-server
```

### Release build

```bash
cargo +nightly build --release -p wezterm -p wezterm-gui -p wezterm-mux-server
```

On Windows, launch the release build from the repository root with:

```powershell
.\run-wezterminator-release.cmd
```

### Build only our delta (fast iteration)

```bash
cargo build -p wtinator
```

Useful when you're working on `wtinator/src/...` and don't need a full GUI rebuild.

### Cross-compile notes

- **Windows → Linux/macOS**: doable with the right cross toolchain, but you also need the native deps for Skia. We don't ship CI for this; document it if you set it up.
- **Linux → Windows**: easier on Windows-host runners. We do this in CI.
- **macOS → anything**: not possible without a Mac. Universal binaries (`aarch64-apple-darwin` + `x86_64-apple-darwin`) are built on a Mac runner.

---

## 4. Running

```bash
cargo +nightly run --release -p wezterm -- start --always-new-process
```

The end-user binary is **`wezterm`**, not `wezterminator`. The
`wezterminator` binary is a thin placeholder that exists only for
test purposes (running `cargo +nightly run -p wezterminator` exercises
the install hook without launching the full GUI). When you launch
`wezterm`, the patched `main()` (patch 0003 in
`upstream-wezterm/PATCHES.md`) calls `wtinator::install()` before any
config or GUI state is initialized.

Configuration lives in `~/.wezterm.lua` (wezterm-compatible) with
WezTerminator extensions under `wtinator = { ... }`. See [CONFIG.md](CONFIG.md).

### Windows local launch rule

Recorded by: Codex gpt-5.5 on 2026-06-06.

For manual Windows testing, always start a new process. Do not run plain
`wezterm` from PATH, because this machine also has a system-installed WezTerm
at `C:\Program Files\WezTerm\wezterm.exe`.

Use the launchers from the repository root:

```powershell
.\run-wezterminator-release.cmd
.\run-wezterminator-debug.cmd
```

They set `WTINATOR_ACTIVE=1`, enable debug logging, switch into the selected
`upstream-wezterm\target\...\` directory, and execute:

```cmd
wezterm.exe start --always-new-process
```

This is the project default for manual testing. It avoids reusing a stale GUI
process and guarantees that the test run uses the binaries from this checkout.

### Logs

WezTerminator respects `RUST_LOG`. Useful values:

| Value | What you get |
| --- | --- |
| `error` | Only errors. |
| `warn` | Errors and warnings. |
| `info` | Startup, config load, mux connections. |
| `debug` | Key events, pane actions. |
| `trace` | Everything. **Very** chatty. |

Examples:

```bash
# Windows (PowerShell)
$env:RUST_LOG = "info"
cargo run

# Linux/macOS
RUST_LOG=info cargo run
```

---

## 5. Testing

### Unit tests

```bash
cargo test --workspace
```

Covers the deterministic, no-IO parts:

- `wtinator::vscode_theme::tests` — feed real VS Code theme JSON, assert the resulting `ColorScheme` matches expectations.
- `wtinator::clipboard::tests` — paste-context detection.
- `wtinator::groups::tests` — round-trip JSON.

### Integration tests

```bash
cargo test -p wtinator --test '*'
```

Tests that spawn a real `wezterm-mux-server` and talk to it via RPC. These are slow; we mark them `#[ignore]` and run them in CI.

```bash
cargo test -p wtinator --test '*' -- --ignored --test-threads=1
```

### Smoke test (manual)

Current Windows flow:

1. Build release: `cargo +nightly build --release -p wezterm -p wezterm-gui -p wezterm-mux-server`.
2. Launch from the repository root: `.\run-bethstudio.cmd`.
3. Left-click the `+` button. The native shell picker appears; selecting a shell opens a new tab.
4. Right-click inside the pane. The native full menu appears; `Split right` splits vertically.
5. Click the `| Split` label. The native split picker appears.
6. Confirm the window does not close while opening or dismissing any native menu.

If steps 3-6 all work, the Windows native menu path is good. If they do not,
see [§9](#9-debugging).

Legacy v0.1 checklist:

On Windows, keep using `.\run-bethstudio.cmd` instead of
`cargo run --release`. That starts the release GUI with no arguments.

1. `cargo run --release`
2. Right-click the tab bar → "New tab" → "PowerShell" — a new tab opens with PowerShell.
3. Right-click inside the pane → "Split right" — the pane splits vertically.
4. Right-click the new pane → "Broadcast to all panes" — the title bar gets a red border.
5. Type in one pane; both panes receive the input.
6. Press `Alt+B` three times — the scope indicator cycles: all → group → selection → off.
7. Press `Ctrl+Shift+R` — the config reloads without closing the window.
8. Quit (Ctrl+Shift+Q). Restart. The tabs and groups are restored.

If steps 2–8 all work, v0.1 is good. If they don't, see [§9](#9-debugging).

---

## 6. Coding conventions

We follow the upstream wezterm style for files in `wtinator/` that mirror upstream types, and a slightly tighter style for files that don't:

- **Rustfmt** with the project `rustfmt.toml` (copied from upstream).
- **Clippy** clean. Run `cargo clippy --workspace --all-targets -- -D warnings` before pushing.
- **No `unwrap()` in `wtinator/`** outside tests. Use `anyhow::Result` and propagate.
- **No `unsafe`** without a `// SAFETY: …` comment.
- **Lua API surface** matches wezterm's pattern: one `pub fn` per `wezterm.lua_*` module, registered in `wtinator::install`.
- **Comments** explain *why*, not *what*. If the code says what it does, the comment is redundant.
- **Public items have doc comments.** Users see them via `cargo doc`.

---

## 7. Git workflow

- We follow a **trunk-based** model on `main`.
- Short-lived feature branches: `feat/<thing>`, `fix/<thing>`, `docs/<thing>`.
- PRs need at least one approval from a maintainer. CI must be green.
- Commit messages: present tense, 50-char subject, 72-char body. Reference issues with `(#123)`.
- **Never commit to `main` directly.** Even maintainers open PRs.
- `upstream-wezterm/` is a submodule pinned to a known commit. To bump it, see [§10](#10-bumping-upstream-wezterm).

---

## 8. Release process

1. Bump versions in `wtinator/Cargo.toml`, `wezterminator/Cargo.toml`, and the workspace `Cargo.toml`. Commit `chore: bump to v0.X.Y`.
2. Update `CHANGELOG.md` with the user-visible changes.
3. Push the tag: `git tag v0.X.Y && git push --tags`.
4. CI builds binaries for Windows / Linux / macOS and uploads to the GitHub release.
5. The release is auto-published; smoke test the binaries on a clean VM.

The first release (v0.1.0) is **manually promoted** by a maintainer because we want to make sure the announcement copy is right.

---

## 9. Debugging

### The window opens and immediately closes

Set `RUST_LOG=info` and look at stderr. The most common causes:

- A bad Lua config — look for `lua::load_config` errors.
- A `wtinator` key that we don't recognize — should print a warning with the key name.

### The right-click menu doesn't appear

- Confirm the app was launched with `.\run-wezterminator-release.cmd` or
  `.\run-wezterminator-debug.cmd`, not plain `wezterm` from PATH.
- Check the newest log under `%USERPROFILE%\.local\share\wezterm` for:
  `wezterminator patch 0010: deferring native menu to main thread` and
  `wezterminator patch 0010: main thread is showing HMENU`.
- Confirm `show_native_full_menu`, `show_native_shell_picker`, or
  `show_native_split_picker` reaches `schedule_native_menu` in
  `wezterm-gui/src/termwindow/mouseevent.rs`.
- Do not move `TrackPopupMenuEx` to a helper thread. That stops the crash but
  also prevents all native menus from appearing. The menu must be shown from
  the UI/main thread after the current mouse callback returns.

### Splits are off-center

- The `SplitDirection` splitter uses fractional sizes. Check that we don't accidentally clamp to `[0.05, 0.95]`.

### VS Code theme import gives the wrong colors

- Print the parsed theme's tokenColors and the resulting `ColorScheme` side by side.
- Check that we resolve `workbench.colorCustomizations` after the base theme.

### Broadcast isn't reaching a pane

- The pane is in a different `Mux` (detached window). Verify the registry's `mux_id` matches.
- The scope is wrong. Check the status bar.

### Cargo build is slow

- Use `cargo build -p wtinator` for delta-only changes.
- `sccache` is supported. Set `RUSTC_WRAPPER=sccache` in the environment.
- On Windows, disable Windows Defender real-time scanning on `target/`.

---

## 10. Bumping upstream wezterm

We track wezterm as a **git submodule**. To bump:

```bash
cd upstream-wezterm
git fetch
git checkout <new-pinned-commit-sha>
cd ..
git add upstream-wezterm
git commit -m "chore: bump upstream wezterm to <sha>"
```

Then run `cargo build` and address any breakages. The `ARCHITECTURE.md` map references specific lines in upstream files; those will drift. After a bump, do a quick pass to update the line numbers.

If the bump is more than ~20 commits, write a `docs/changelog/upstream-<date>.md` summarizing what changed that we care about.

---

## 11. CI

- **`.github/workflows/ci.yml`** runs on every PR: build on Windows / Linux / macOS, run unit tests, run clippy.
- **`.github/workflows/release.yml`** runs on tag push: build release binaries, attach to the GitHub release.

CI runners are GitHub-hosted. The Windows runner has the VS 2022 Build Tools pre-installed; the macOS runner is `macos-14` (Apple Silicon) plus a separate `macos-13` (Intel) for the universal build; the Linux runner is `ubuntu-22.04`.

---

## 12. Where to get help

- **File an issue** on GitHub with the template that matches your bug/feature.
- **Open a discussion** for design questions.
- **Read the upstream wezterm docs** at https://wezfurlong.org/wezterm/ — most of it applies unchanged.
