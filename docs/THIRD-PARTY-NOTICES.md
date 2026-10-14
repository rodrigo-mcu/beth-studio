# Third-Party Notices

Beth Studio contains or links the third-party software below. Every release
zip carries the full license texts in its `licenses/` folder, produced by
`tools/collect-licenses.py` (see [`RELEASING.md`](../RELEASING.md)). This file
is the human-readable summary; it was reviewed on 2026-10-08.

One dependency is LGPL-2.1 (libssh, see below) and two Go modules are MPL-2.0. Nothing is GPL, AGPL or SSPL.

## Our own code

| Part | License |
| --- | --- |
| `upstream-wezterm/` (WezTerm and our patches, `wtinator`, `bethstudio-setup`) | MIT (Wez Furlong, and Rodrigo Peres Assis / Beth Studio contributors) |
| `bethstudio-web/` (Beth Studio, phone page) and `bethstudio-mobile/` | MIT (Rodrigo Peres Assis / Beth Studio contributors) |

## Bundled with the installer

| Component | License | Notes |
| --- | --- | --- |
| `OpenConsole.exe`, `conpty.dll` (Microsoft Windows Terminal) | MIT | Lives in `upstream-wezterm/assets/windows/conhost/` (see its README). Needed for mouse reporting in the host. |
| Gogh theme catalog (`wtinator/data/gogh-themes.json`) | MIT, theme authors credited in the data | Snapshot of <https://github.com/Gogh-Co/Gogh>; kept in the source tree and compiled into `wtinator`. |
| Microsoft Edge WebView2 Runtime | Microsoft license | **Not bundled.** The Studio window uses the runtime already installed with Windows 10/11. |

## Go (bethstudio-web)

| Module | License |
| --- | --- |
| `github.com/go-sql-driver/mysql` | **MPL-2.0** (file-level copyleft; used unmodified) |
| `github.com/hashicorp/yamux` | **MPL-2.0** (file-level copyleft; used unmodified) |
| `github.com/pkg/sftp`, `github.com/kr/fs`, `github.com/dustin/go-humanize`, `github.com/golang-sql/*`, `github.com/jackc/*`, `github.com/jchv/*`, `github.com/mattn/go-isatty`, `github.com/microsoft/go-mssqldb`, `github.com/ncruces/go-strftime`, `github.com/remyoudompheng/bigfft`, `github.com/boombuler/barcode`, `github.com/google/uuid`, `filippo.io/edwards25519`, `golang.org/x/*`, `modernc.org/*` | MIT, BSD-2/3-Clause, ISC or Apache-2.0 |

MPL-2.0 requires that the source of the **MPL-covered files** stay available.
We do not modify them; the unmodified source is at the module URLs above, at
the versions in `bethstudio-web/go.mod`. Our own files are not covered by the
MPL.

## Frontend (npm, runtime dependencies)

`react`, `react-dom`, `clsx`, `lucide-react`, `marked`, `@xterm/xterm` and
`@xterm/addon-unicode11`: MIT or ISC. Development-only tools (Vite, Tailwind,
TypeScript, Vitest) are not shipped.

## Rust (host and CLI)

About 480 crates, all permissive: MIT, Apache-2.0, BSD-2/3-Clause, ISC,
Zlib, Unlicense or Unicode-3.0 (many with dual licensing). The workspace
crates are WezTerm's own, under MIT. The native window was removed, so
FreeType, HarfBuzz, Cairo and the GPU/rendering stack are no longer part of
the build.

## libssh (LGPL-2.1), inside `bethstudio.exe` and `bethstudio-host.exe`

`wezterm-ssh` uses the `libssh-rs` crate with the **vendored** `libssh` C
library (LGPL-2.1-or-later, with BSD-licensed parts), statically linked into
the host and the CLI. Its license texts are in
`licenses/rust/libssh-rs-sys-*/libssh/` in every release.

What the LGPL asks of us: keep the library's notices (done), make its source
available (the exact source is the `libssh-rs-sys` crate on crates.io, which
contains `vendored/`), and let you relink the program with a modified libssh.
Because the whole Beth Studio source and the build steps (`README.md`,
`RELEASING.md`) are public, you can rebuild the host with your own libssh.
The Studio's own SSH/SFTP (Go) does not use libssh.

Follow-up worth doing: turn off the `libssh-rs` feature of `wezterm-ssh`
(the `ssh2`/libssh2 backend is BSD-3) if the host does not need SSH domains.
That is a patch to a workspace dependency and needs a full rebuild test, so it
is tracked as a task and not done here.

## Fonts and icons

The Studio uses the fonts installed on the machine and does not bundle font
files. The application icons may derive from WezTerm artwork; see the
exception in `bethstudio-web/LICENSE`.

## Adding a new third-party dependency

If the license is **not** MIT, Apache-2.0, BSD, ISC, Zlib or similar:

1. Add the license text to `upstream-wezterm/licenses/` (Rust) or let
   `tools/collect-licenses.py` pick it up (Go and npm).
2. Update this file.
3. Call out the new license in the pull request.

PRs that add GPL, AGPL, SSPL or other copyleft licenses will be rejected
unless there is a documented reason.
