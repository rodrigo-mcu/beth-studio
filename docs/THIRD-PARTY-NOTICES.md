# Third-Party Notices

This file is **regenerated** by `cargo about` and `cargo deny` at release time. The list below is a **placeholder** that names the categories of third-party software BethTerm links against.

The authoritative list is in `THIRD-PARTY-NOTICES.md` (to be generated before v0.1.0 ships):

```bash
cargo install cargo-about
cargo about generate docs/templates/about.hbs > THIRD-PARTY-NOTICES.md
```

## Categories of third-party software

| Category | Examples | License(s) |
| --- | --- | --- |
| Terminal emulator core | wezterm (Wez Furlong) | MIT |
| Font rendering | FreeType, HarfBuzz | FreeType License, MIT |
| GPU rendering | Skia | BSD 3-clause |
| Image codecs | libpng, libjpeg, libwebp | Per-library |
| SSH | libssh | BSD 3-clause |
| TLS | rustls | Apache-2.0 / ISC / MIT |
| Compression | zlib, brotli | zlib License, MIT |
| Bundled fonts | Cascadia Code, JetBrains Mono, Fira Code, Hack, Iosevka | OFL-1.1 |

A complete inventory is generated at release time and committed to the root of the repo as `THIRD-PARTY-NOTICES.md`.

## Adding a new third-party dependency

If you `cargo add foo` and `foo` is **not** MIT / Apache-2.0 / BSD / OFL / ISC, you need to:

1. Add the license text to `upstream-wezterm/licenses/` (or our `licenses/` if the dep is new).
2. Update `THIRD-PARTY-NOTICES.md`.
3. Open a PR that calls out the new license in the description.

PRs that add GPL, AGPL, SSPL, or other "copyleft" or "source-disclosure" licenses will be **rejected** unless there is a strong, documented reason.
