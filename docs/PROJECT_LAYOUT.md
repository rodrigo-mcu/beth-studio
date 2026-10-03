# Project Layout

This is the *why* behind the directory structure. For the *what*, see [`HACKING.md §1`](HACKING.md#1-repository-layout).

## The one rule

> `upstream-wezterm/` is **read-only** for files that already exist. Every
> change we make to *existing* upstream files lives in
> `upstream-wezterm/patches/` with a documented exception.
> **New directories we add inside the upstream tree** (specifically
> `upstream-wezterm/wtinator/` and `upstream-wezterm/wezterminator/`)
> are not patches — they are our own code (the Beth Studio delta), and the
> upstream `Cargo.toml` is the only *existing* file that mentions them.

This is the most important rule. Every patch to *existing* upstream
files must be documented in `upstream-wezterm/PATCHES.md` with a
rationale, the exact diff, and a revert procedure.

The reason for the rule is the strategy in [`ARCHITECTURE.md §"Strategy: vendor + delta, not fork-in-place"`](ARCHITECTURE.md#strategy-vendor--delta-not-fork-in-place): forking in place is a maintenance nightmare. We pay a small cost in carrying a few documented local patches to get clean rebases against upstream.

## The directory tree

Operational files at the repository root:

- `AGENTS.md` is the local runbook for future agents.
- `run-bethstudio.cmd` (same as `run-bethstudio-release.cmd`) and
  `run-bethstudio-debug.cmd` are the supported Windows launchers for manual
  testing. They start `bethstudio-web.exe` (Beth Studio) from this checkout;
  build it first with `powershell -File bethstudio-webuild.ps1`.
  The `run-wezterminator-*.cmd` names are compatibility wrappers.
- `bethstudio-web/` is Beth Studio (Go + React); `pack-bethstudio-setup.ps1`
  builds the installer.

```
bethstudio/
│
├── CHANGELOG.md
├── LICENSE.md
├── README.md
├── clippy.toml
├── rustfmt.toml
├── docs/                       # All documentation. Always English.
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   ├── IMPLEMENTATION.md
│   ├── CONFIG.md
│   ├── THEMING.md
│   ├── HACKING.md
│   ├── ROADMAP.md
│   ├── CONTRIBUTING.md
│   ├── PROJECT_LAYOUT.md       # this file
│   ├── SECURITY.md
│   ├── PRIVACY.md
│   ├── SCREENSHOTS.md
│   ├── THIRD-PARTY-NOTICES.md
│   ├── LICENSE-NOTES.md
│   ├── changelog/
│   │   └── v0.1.0.md
│   ├── img/                    # (filled before v0.1.0)
│   └── templates/
│       └── about.hbs
│
├── upstream-wezterm/           # Vendored wezterm. Read-only EXCEPT for the
│   │                           # local patches documented in PATCHES.md.
│   ├── Cargo.toml              # (workspace root — patch 0001, 0002)
│   ├── wezterm/                # (the binary — patches 0003, 0004)
│   │   ├── Cargo.toml
│   │   └── src/main.rs
│   ├── wtinator/               # Our delta crate — added by patch 0001
│   │   ├── Cargo.toml
│   │   └── src/...
│   ├── wezterminator/          # Placeholder binary crate (package name `bethstudio`)
│   │   ├── Cargo.toml
│   │   └── src/main.rs
│   ├── PATCHES.md              # Index of local patches
│   ├── patches/
│   │   ├── 0001-workspace-members.md
│   │   ├── 0002-chrono-clock.md
│   │   ├── 0003-wezterm-main-install.md
│   │   └── 0004-wezterm-cargo-wtinator.md
│   └── ...                     # Full upstream wezterm tree
│
├── assets/                     # Icons, fonts (filled by Phase 1.F+)
└── .github/
    └── workflows/
        └── ci.yml
```

## What lives in `wtinator/` vs `wezterminator/`

- **`upstream-wezterm/wtinator/`** is a library crate. It has no `main`.
  It exposes `pub fn install() -> anyhow::Result<()>`. Everything that
  distinguishes us from upstream wezterm lives here.
- **`upstream-wezterm/wezterminator/`** is a binary crate, currently a
  thin **placeholder**. The real entry point for end users is the
  **patched upstream `wezterm` binary** (see `upstream-wezterm/patches/0003`),
  which calls `wtinator::install()` and then proceeds as a stock wezterm.
  The placeholder `wezterminator/src/main.rs` exists for test purposes
  (running `cargo run -p wezterminator` exercises the install hook
  without starting the host).

## What lives in `docs/` vs `README.md`

- **`README.md`** is a **single page**. It is the first thing a new
  visitor sees. It links into the docs and stops. We do not duplicate
  content from `docs/` in the README.
- **`docs/`** is the long form. Every doc has a single, clear purpose,
  listed in the README's "Documentation" table.
- **Comments in code** explain *why*. **Docs in `docs/`** explain *what*
  and *how to use it*. **Issues** explain *what we want to build next*.
  Don't mix.

## Adding a new doc

1. Pick the smallest existing doc that overlaps in topic.
2. Add a new file with the same general structure (heading levels, table
   style, code-block style).
3. Add a row to the README's "Documentation" table.
4. Add a link from any other doc that references the new topic.
5. Commit on a `docs/<topic>` branch.

## Adding a new local patch to an existing upstream file

1. Edit the upstream file in place.
2. Write a `upstream-wezterm/patches/NNNN-short-name.md` documenting
   the diff, the rationale, and the revert procedure.
3. Add a row to `upstream-wezterm/PATCHES.md`.
4. Commit on a `patch/<name>` branch.

## Renaming a directory

Don't. The names are short and stable. If you really must, expect a
long review.

## Adding a new sub-crate to `wtinator/`

We currently have a single crate. If `wtinator/src/lib.rs` grows past
~10 000 lines (likely around v0.5), we may split it into a workspace of
smaller crates:

```
upstream-wezterm/wtinator/
├── Cargo.toml                  # workspace
├── wtinator-core/              # the small stuff
├── wtinator-ssh/               # SSH-related
└── wtinator-sftp/              # SFTP (v0.7)
```

This is a v0.5-or-later concern. Don't pre-split.
