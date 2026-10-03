# Contributing to BethTerm

Thanks for wanting to make BethTerm better. For build, test, and debug details, see [`docs/HACKING.md`](docs/HACKING.md).

## Code of conduct

We follow the [Contributor Covenant](CODE_OF_CONDUCT.md) 2.1. Be kind. Disagreement is fine; disrespect is not.

## How to contribute

1. **File an issue first** for non-trivial changes.
2. **Open a PR** against `main` from a feature branch. Include:
   - The motivation.
   - The approach.
   - Screenshots or a short video for UI changes.
   - The test plan.
3. **Wait for review.**
4. **Squash-merge** is the default.

## What we accept

- Bug fixes for documented behavior.
- New features that match the mouse-first Windows workflow.
- Performance improvements with a before/after note.
- Documentation improvements.
- Test additions.

## What we don't accept

- GPL / AGPL / SSPL dependencies. See [`docs/LICENSE-NOTES.md`](docs/LICENSE-NOTES.md).
- Telemetry or phone-home of any kind.
- Using the WezTerm name as our binary or package name.
- Omitting the WezTerm origin. BethTerm is based on WezTerm; see [`NOTICE.md`](NOTICE.md) and [`docs/ORIGIN.md`](docs/ORIGIN.md).
- A plugin marketplace. Lua config is the extension surface.
- Unrelated patches to WezTerm core — those go to [wezterm/wezterm](https://github.com/wezterm/wezterm).

## Coding rules

- Existing files under `upstream-wezterm/` that are not our crates may be changed **only** as a documented patch: add a row to `upstream-wezterm/PATCHES.md` and a matching `upstream-wezterm/patches/NNNN-*.md`.
- New BethTerm code belongs in `upstream-wezterm/wtinator/` (or `wtinator-config/`) whenever possible.
- The crate is still named `wtinator` on purpose. Do not mass-rename it in a drive-by PR.
- `cargo fmt` before every commit.
- No `unwrap()` outside `#[cfg(test)]` in `wtinator/`.
- Public items have doc comments.

## Testing

From `upstream-wezterm/`:

```powershell
$env:PATH = 'C:\Strawberry\perl\bin;' + $env:PATH
cargo +nightly test -p wtinator
cargo +nightly check -p wezterm-gui
```

Manual Windows tests must use `run-bethterm-release.cmd` or `run-bethterm-debug.cmd` so a system WezTerm does not absorb the run.

## License of contributions

By opening a PR you offer the change under the MIT License, the same as the rest of the tree. There is no CLA.
