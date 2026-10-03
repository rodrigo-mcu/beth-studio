# Screenshots

> Placeholder — pre-alpha. Real screenshots will be added before the first public release.

When the first binaries are ready, this page will hold:

1. **The default look** — Cascadia Code, Catppuccin Mocha, a single tab with PowerShell.
2. **Splits** — 2×2 grid with one tab in PowerShell, one in WSL, one in cmd.
3. **Tab groups** — two groups ("Dev", "Ops") shown side by side, switching with `Alt+1` / `Alt+2`.
4. **Right-click menu** — close-up of the menu in its three locations.
5. **VS Code theme import** — before/after switching from a built-in scheme to a marketplace-downloaded theme.
6. **Broadcast input** — three panes on three hosts, all receiving the same keystrokes.
7. **Smart paste** — toast notification asking "is this a password paste?".
8. **Status bar** — bottom bar with active group, broadcast scope, shell, clock.

The image files will live in `docs/img/` and be referenced with relative paths so the README on GitHub renders them.

### File naming

`docs/img/v0.X.Y-<short-name>.png`. Lower-case, hyphen-separated. Example: `docs/img/v0.1.0-tab-groups.png`.

### Required dimensions

- HiDPI: capture at 200 % scale (Windows setting) so the text is crisp at 1× and 2× display densities.
- Color profile: sRGB. Don't include the developer's monitor ICC.

### Accessibility

- Every screenshot has a text caption that describes what is shown.
- High-contrast variants are captured for the default look.
