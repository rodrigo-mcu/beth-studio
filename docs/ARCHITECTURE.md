# Architecture

> **Status (Phase B).** The native window (`wezterm-gui`, Skia, `wtinator-config`) was removed from the tree. The `wezterm-gui` touch points were dropped from the sections below; what remains is kept as design notes. See [`HISTORY.md`](HISTORY.md).

This document maps the upstream wezterm codebase so a new contributor (or another agent) can find the right file to change without re-discovering the layout.

> **Related docs**
> - [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — the phased plan that turns the architecture into work.
> - [`FEATURES.md`](FEATURES.md) — the spec of every Beth Studio feature.
> - [`PROJECT_LAYOUT.md`](PROJECT_LAYOUT.md) — the directory tree and the *why* behind it.
> - [`HACKING.md`](HACKING.md) — build, test, debug.

> **Conventions used below**
> - All paths are relative to the repo root.
> - `upstream-wezterm/` is a shallow git clone of wezterm at a pinned commit. We add our delta **on top of** that, not by editing files in `upstream-wezterm/` directly. See "Strategy" below.
> - Line numbers are approximate and will drift; treat them as a starting point, not a contract.

---

## Runtime architecture today

Three programs, one set of terminals:

```
bethstudio-web.exe (Beth Studio, Go + React in WebView2)
    ├─ supervises ─────────────► bethstudio-host.exe   (package wezterm-mux-server; owns every PTY)
    └─ JSON lines over stdio ──► bethstudio.exe cli bridge (package wezterm) ── mux ──► bethstudio-host.exe
```

- **`bethstudio-host.exe`** owns the PTYs. It outlives every window, so shells, agents, and WSL sessions survive a Studio restart. Nothing but the user (tray **Encerrar tudo**, after a confirmation) stops it.
- **`bethstudio.exe`** is the CLI plus `cli bridge`, the only way the Studio talks to the host. The subcommands that used to delegate to the native window (`gui-restart`, `start`, `ssh`, `serial`, `connect`) now fail with a message asking you to use Beth Studio.
- **`bethstudio-web.exe`** (Beth Studio) serves the React UI in WebView2, starts the host when none runs, restarts it after a crash, restores the terminals, and owns the tray icon. A phone web app and an optional Linux relay (`bethstudio-proxy`) reach it remotely.
- The installer (`bethstudio-setup`) packs `bethstudio.exe`, `bethstudio-host.exe`, `bethstudio-web.exe`, `bethstudio-tool.exe`, `OpenConsole.exe`, and `conpty.dll`.
- The `wtinator` delta crate keeps only host-side modules: `agent_wait`, `config_lua`, `default_theme`, `echo_latency`, `groups`, `host`, `notify`, `notify_ipc`, `pane_cmd`, `session`, `shells` (`default_shells`), `taskbar_icon`, `theme_download`, `vscode_theme`, and `window_geom`.

---

## Strategy: vendor + delta, not fork-in-place

There are two ways to build a derivative of wezterm:

1. **Fork in place** — clone wezterm, change files in-tree, push to your own remote. Pro: simple. Con: pulling upstream changes is a merge nightmare, and you can't easily track which lines you changed.
2. **Vendor + delta** — keep an unmodified `upstream-wezterm/` tree and put all our changes in a separate `wtinator/` crate that depends on wezterm's **public** crates. Pro: clean diff against upstream, easy to rebase, can publish as a Cargo workspace member. Con: we can only use what wezterm exposes through its public crate API; private internals require either upstream changes or duplication.

We use **strategy 2**. The `Cargo.toml` at the repo root is a workspace that has:

- `upstream-wezterm/` as a `path` dependency (so we can re-use its crates)
- `wtinator/` as our own crate, depending on the public wezterm crates
- `wezterminator/` as a thin entry-point binary

If at any point we need to touch a private wezterm crate, we either:
- upstream the change as a PR to wez/wezterm, **or**
- copy the relevant source into `wtinator/` and maintain a local patch (with a clear comment explaining why).

### Alternatives considered

An experimental rewrite-from-scratch in Zig (libghostty VT parser + Win32) was considered and dropped. Reimplementing the renderer, mux, font stack, and SSH stack would take many months that the WezTerm fork already gives us.

**Conclusion:** stay with strategy 2 (Rust + WezTerm vendor + delta).

---

## The wezterm codebase in 90 seconds

Wezterm is a Cargo workspace with ~50 crates. The ones that matter for Beth Studio are:

| Crate | What it does | Public API worth knowing |
| --- | --- | --- |
| `mux` | The multiplexer. Tabs, panes, domains (local / SSH / WSL), workspaces, RPC. | `Mux`, `Tab`, `Pane`, `Domain`, `Window`, `MuxNotification` |
| `wezterm` | The CLI binary (`bethstudio.exe`), including `cli bridge`. | Cargo package `wezterm` |
| `config` | Loads and merges `wezterm.lua` with default config. | `Config`, `lua::load_config` |
| `wezterm-font` | Font discovery, shaping, ligatures, fallback. | `FontConfiguration`, `LoadedFont` |
| `wezterm-surface` | The terminal "screen" abstraction (cells, attributes, dirty regions). | `Surface`, `Cell` |
| `wezterm-escape-parser` | Parses VT/ANSI escape sequences. | `Parser`, `VTAction` |
| `wezterm-ssh` | The SSH domain implementation. | `SshDomain` |
| `wezterm-mux-server` / `wezterm-mux-server-impl` | The standalone mux server (`wezterm-mux-server` binary) so clients can attach/detach. | `MuxServer` |
| `wezterm-client` | The RPC client that talks to a mux server. | `Client` |
| `term` | Pure-data terminal model (no GUI). | Used by the host and scripting |
| `color-types` | `RgbColor`, palette conversions. | `RgbColor`, `SrgbaTuple` |
| `wezterm-input-types` | Key/modifier encoding. | `KeyCode`, `Modifiers` |
| `wezterm-cell` | Cell types, attribute bits, hyperlinks. | `CellAttributes`, `Hyperlink` |
| `lua-api-crates` | The Lua bindings generator and shared glue. | `wezterm.lua_*` modules |

Everything else is supporting infrastructure (parsers, color types, FFI bindings, image codecs, etc.).

---

## Key files for WezTerminator features

This is the most important section. When you (or the next agent) start implementing, **start here**.

### Broadcast input

**Goal:** replicate keystrokes to N panes.

**Touch points:**

| File | Why we care | Approx. lines |
| --- | --- | --- |
| `upstream-wezterm/mux/src/pane.rs` | `Pane::send_paste`, `Pane::send_key`, `Pane::input` are the entry points for any input into a pane. We need to **fan out** from these to the broadcast group. | `send_paste`, `send_key` near the bottom of the file |
| `upstream-wezterm/mux/src/tab.rs` | A `Tab` is a collection of `Pane`s plus a layout. We can add a `broadcast_group_id: Option<String>` to a `Tab`, or store the group membership in a sidecar registry. | Tab struct, `Tab::panes` |
| `upstream-wezterm/mux/src/lib.rs` | The `Mux` is the global registry. We can add a sidecar `BroadcastRegistry` here, or a `Mux::broadcast_group(group_id) -> Vec<PaneId>`. | `Mux` struct, `with_mux` |

**Architectural choice:** do we add state to existing structs or keep a sidecar?

- **State in existing structs** is simpler to use but pollutes upstream types.
- **Sidecar in `Mux`** keeps wezterm's types clean but means lookups go through the mux.

**Recommendation:** sidecar. Add a `wtinator::BroadcastRegistry` that lives inside `Mux` as a `RefCell<Option<...>>` (initialized lazily by our delta crate). The registry tracks group membership and the current broadcast scope (off / all / group / selection / tagged).

### Tab groups

**Goal:** group N tabs (or N panes inside one tab) into a named, switchable, savable layout. This is the **key differentiator from Terminator**.

**Touch points:**

| File | Why we care | Approx. lines |
| --- | --- | --- |
| `upstream-wezterm/mux/src/lib.rs` | The `Mux` has workspaces. We can model tab groups as a superset of workspaces, or as a parallel concept. | `Mux::workspaces`, `Workspace` struct |
| `upstream-wezterm/mux/src/tab.rs` | Each `Tab` should know which group it belongs to. Add `group_id: Option<String>`. | Tab struct |
| `upstream-wezterm/mux/src/termwiztermtab.rs` | The `TermWizTerminalTab` wraps a `Tab` for use in the GUI. May need a parallel `group_name` accessor. | Near the top of the file |

**Architectural choice:** groups live on the tab or in a sidecar?

- Tab-as-member: simpler, but requires mutating the Tab struct (and the proto serialization in `mux/src/client.rs`).
- Sidecar: cleaner, but every lookup has to ask the mux.

**Recommendation:** **field on `Tab`** for membership (`group_id: Option<String>`), and a **`GroupRegistry` in `Mux`** for the named-group-to-tabs mapping, the saved layouts, and the active group.

### VS Code settings sync

**Goal:** read `~/.vscode/settings.json` and mirror `terminal.integrated.*` into our `Config`.

**Touch points:**

| File | Why we care | Approx. lines |
| --- | --- | --- |
| `upstream-wezterm/config/src/lib.rs` | The `Config` struct has fields like `font_size`, `font`, `color_scheme`, etc. We need a `Config::apply_vscode_settings(&Path)` method. | `Config` struct definition (long) |
| `upstream-wezterm/config/src/lua.rs` | Lua → `Config` binding. Add a `wtinator.vscode_settings_path` option that triggers the merge at config-load time. | `lua::load_config` |

We can do this entirely from the `wtinator` crate by reading the JSON ourselves and calling existing `Config` setters, **without** modifying the `config` crate.

### VS Code theme importer

**Goal:** given a VS Code `.json` theme, generate a wezterm `ColorScheme` (or extend the existing `color_scheme_name`) with the matching 16 ANSI colors.

**Touch points:**

| File | Why we care | Approx. lines |
| --- | --- | --- |
| `upstream-wezterm/color-types/src/lib.rs` | The data type we generate into. | `RgbColor`, `SrgbaTuple` |
| `upstream-wezterm/sync-color-schemes/` | A wezterm utility that already syncs wezterm's built-in color schemes with a registry. We'll either extend it or copy the pattern. | `main.rs` |
| `upstream-wezterm/config/src/lib.rs` | Where `ColorScheme` is defined (the 16-color + cursor + selection struct). | `ColorScheme` struct |

The theme importer is a pure-Rust module that takes a `serde_json::Value` of a VS Code theme and returns a `ColorScheme`. It can live entirely in `wtinator/src/vscode_theme.rs`.

### Smart clipboard

> Design note: the GUI selection and `paste` key-assignment touch points no longer exist; paste now goes through the Studio and the bridge.

**Goal:** detect what the user is doing (typing a password, in a REPL, in a heredoc, etc.) and pick the right paste behavior.

**Touch points:**

| File | Why we care | Approx. lines |
| --- | --- | --- |
| `upstream-wezterm/mux/src/pane.rs` | `Pane::send_paste` is the single chokepoint for paste. | `send_paste` |

We can implement a `wtinator::ClipboardPipeline` that wraps `Pane::send_paste` and adjusts the string before forwarding.

---

## Event flow cheat sheet

When you type in a Beth Studio terminal:

```
[xterm.js key event in WebView2]
    → bethstudio-web.exe          (WebSocket → Go)
    → bethstudio cli bridge       (JSON line: send / paste)
    → mux client → bethstudio-host.exe
    → mux::Pane::input          (writes to the PTY; output goes through the escape parser)
    → wezterm-surface           (screen state)
    → bridge screen frames      → Go → WebSocket → xterm.js
```

For the delta features:

- **Broadcast input** intercepts at **Pane::send_paste / send_key** inside the host.
- **Tab groups** intercept at the **`Mux::activate_workspace` / `Mux::activate_tab`** level.
- **VS Code settings sync** runs at **config load time**, before the host starts.
- **VS Code theme import** runs at **config load time** for theme references.

---

## How to add a new Cargo crate to the workspace

In the **root** `Cargo.toml` (the one we're going to write, in `Cargo.toml` at the repo root — not in `upstream-wezterm/Cargo.toml`):

```toml
[workspace]
members = [
    "wtinator",
    "wezterminator",
]
resolver = "2"

[workspace.dependencies]
# We mirror the relevant wezterm deps so we can pin versions consistently.
wezterm-mux = { path = "upstream-wezterm/mux" }
wezterm-config = { path = "upstream-wezterm/config" }
wezterm-font = { path = "upstream-wezterm/wezterm-font" }
wezterm-input-types = { path = "upstream-wezterm/wezterm-input-types" }
wezterm-color-types = { path = "upstream-wezterm/color-types" }
```

Then `wtinator/Cargo.toml`:

```toml
[package]
name = "wtinator"
version = "0.1.0"
edition = "2021"
license = "MIT"

[dependencies]
wezterm-mux = { workspace = true }
wezterm-config = { workspace = true }
wezterm-input-types = { workspace = true }
wezterm-color-types = { workspace = true }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
```

The first compile will be **slow** because we're building most of wezterm. Subsequent incremental builds are fast.

---

## The main binary

`wezterminator/src/main.rs` is a thin entry point. Two options:

**Option A (simpler, for v0.1.x):** re-export wezterm's `main` and register our delta via a `wezterm::plugin`-style hook.

**Option B (cleaner, for v0.2.0+):** copy `wezterm/src/main.rs` into `wezterminator/src/main.rs`, change the binary name and add `wtinator::install(...)` calls before the CLI starts.

We start with **Option A**, graduate to **B** when we need finer control.
