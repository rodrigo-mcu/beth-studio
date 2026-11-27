# Contributing to Beth Studio

Thanks for wanting to make Beth Studio better. For build, test, and debug details, see [`docs/HACKING.md`](docs/HACKING.md).

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
- New features that match the mouse-first workflow, on Windows and on Mac.
- Performance improvements with a before/after note.
- Documentation improvements.
- Test additions.

## What we don't accept

- GPL / AGPL / SSPL dependencies. See [`docs/LICENSE-NOTES.md`](docs/LICENSE-NOTES.md).
- Telemetry or phone-home of any kind.
- Using the WezTerm name as our binary or package name.
- Omitting the WezTerm origin. Beth Studio is based on WezTerm; see [`NOTICE.md`](NOTICE.md) and [`docs/ORIGIN.md`](docs/ORIGIN.md).
- A plugin marketplace. Lua config is the extension surface.
- Unrelated patches to WezTerm core — those go to [wezterm/wezterm](https://github.com/wezterm/wezterm).

## Working together

Beth Studio is built by people on Windows and on Mac, often with help from AI
agents, and it is used all day by people on both. These habits keep it easy
for everyone to contribute without stepping on each other.

- **Keep both platforms working.** Put platform-specific behavior behind a
  check (`isMacOS()` in the page, a build tag or `runtime.GOOS` in Go, `cfg`
  in Rust) and leave the other platform's path as it was. If you think a
  feature should go away on one platform, open an issue first so we can
  talk about it.
- **Check CI after you push.** The `CI` workflow runs the Windows tests
  (`pnpm test`, `pnpm build`, `go test`) and the Rust tests. If it turns red,
  fixing it comes first; it is fine to ask for help. When code changes on
  purpose, update its test in the same commit and say why in the message.
- **New looks are welcome as options.** Beth Studio has a recognizable look:
  its themes and colors, the logo at the top, the sidebar, the tab bar, the
  fonts and the spacing. Ideas for a different look (glass, cards, new
  colors, a different layout) are great: add them as a theme, a preset or a
  choice in Configurações, so anyone can try them. The current look stays
  the default; changing a default is a product decision, so talk to Rodrigo
  first. Configurações > Aparência > Estilo da interface (Original or Mac)
  is an example.
- **Keep visual changes in their own commit**, starting with `Visual:`, so
  they are easy to review and to turn into an option.
- **A few tests protect the defaults.** `bethstudio-web/frontend/tests/identity.test.ts`
  (interface theme colors) and `TestIdentityDefaultsStayClassic` in
  `bethstudio-web/uitheme_test.go` (default theme, vibrancy off, default
  sidebar look). If one fails, your change touched the default look: offer
  it as an option instead, or, if we agreed to change the default, update
  the value in the same commit.
- **Talk early about big changes.** A short message before a large change
  (layout, defaults, removing something people use) saves rework for
  everyone.

## Coding rules

- Existing files under `upstream-wezterm/` that are not our crates may be changed **only** as a documented patch: add a row to `upstream-wezterm/PATCHES.md` and a matching `upstream-wezterm/patches/NNNN-*.md`.
- New Beth Studio code belongs in `upstream-wezterm/wtinator/` whenever possible; Beth Studio code lives in `bethstudio-web/`.
- The crate is still named `wtinator` on purpose. Do not mass-rename it in a drive-by PR.
- `cargo fmt` before every commit.
- No `unwrap()` outside `#[cfg(test)]` in `wtinator/`.
- Public items have doc comments.

## Testing

From `upstream-wezterm/`:

```powershell
$env:PATH = 'C:\Strawberry\perl\bin;' + $env:PATH
cargo +nightly test -p wtinator
cargo +nightly check -p wezterm -p wezterm-mux-server
```

Manual Windows tests must use `run-bethstudio.cmd` (or `run-bethstudio-debug.cmd`), which start `bethstudio-web.exe` from this checkout, so a system WezTerm does not absorb the run. Build the Studio first with `powershell -File bethstudio-webuild.ps1`.

## License of contributions

By opening a PR you offer the change under the MIT License, the same as the rest of the tree. There is no CLA.
