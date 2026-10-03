# License Notes

This document explains the licensing situation so a contributor can answer "can I do X?" without re-reading the LICENSE text.

## TL;DR

- Beth Studio is MIT. You can do almost anything.
- Beth Studio is based on WezTerm. That origin is documented in [`NOTICE.md`](../NOTICE.md) and [`ORIGIN.md`](ORIGIN.md) and must not be omitted.
- The two hard rules are: (1) keep the LICENSE, NOTICE, and copyright notice, (2) don't use the WezTerm project name to endorse derived products.
- All third-party deps we link against keep their original licenses. We do **not** relicense anything.

## What MIT lets us do

The MIT license grants, in plain language:

1. Use the software for any purpose, including commercial.
2. Modify the source and ship the modifications.
3. Distribute the original or modified versions.
4. Sublicense (as long as we keep the MIT notice).

It also requires:

1. The original copyright notice and the MIT permission notice must be included in **all copies or substantial portions** of the software.

There is no copyleft obligation and no requirement to disclose source, though this project is public source on purpose.

## What we explicitly don't do

- **No CLA.** By submitting a PR, you assert you have the right to submit the code under MIT, same as upstream.
- **No re-licensing.** Beth Studio stays MIT.
- **No "WezTerm" branding in our product or package name.** The GUI binary remains `wezterm-gui.exe` because it is a patched upstream binary; the product name is BethStudio.

## Files we don't relicense

- `upstream-wezterm/` — WezTerm source, vendored. Copyright headers in unmodified files stay Wez Furlong's.
- `upstream-wezterm/licenses/` and bundled fonts — third-party rights.

Our delta lives in:

- `upstream-wezterm/wtinator/`
- `upstream-wezterm/wtinator-config/`
- `upstream-wezterm/wezterminator/` (Cargo package `bethstudio`)

Edits to *existing* upstream files are listed in `upstream-wezterm/PATCHES.md`.

## How to add a new third-party dependency

If you `cargo add foo` and `foo` is not MIT/Apache-2.0/BSD-compatible, you need to:

1. Add the license text to `upstream-wezterm/licenses/` (or a root `licenses/` folder).
2. Update `docs/THIRD-PARTY-NOTICES.md`.
3. Call out the new license in the PR.

PRs that add GPL, AGPL, SSPL, or other copyleft licenses will be **rejected** unless there is a strong, documented reason.

## Pre-flight checklist for binary releases

Before tagging a release:

- [ ] `cargo deny check licenses` passes (when wired in CI).
- [ ] `LICENSE.md` and `NOTICE.md` are present in the release artifact.
- [ ] `upstream-wezterm/LICENSE.md` is present in the release artifact.
- [ ] README still says Beth Studio is based on WezTerm, in the first screenful.
- [ ] Release notes do not present Beth Studio as official WezTerm.

## Resources

- SPDX: https://spdx.org/licenses/
- Choose a License (MIT): https://choosealicense.com/licenses/mit/
- Open Source Initiative MIT: https://opensource.org/license/mit
