# Theming

WezTerminator supports three sources of color themes:

1. **Built-in wezterm schemes** (the same 200+ that ship with upstream wezterm).
2. **VS Code theme import** — convert a VS Code `.json` theme to a wezterm `ColorScheme`.
3. **VS Code marketplace browse** — pick a theme from inside WezTerminator.

This document describes how each source works and how the priority / override rules combine.

---

## 1. Built-in schemes (unchanged)

Set `config.color_scheme` to any of the upstream names. Examples:

```lua
config.color_scheme = 'Dracula'
config.color_scheme = 'Catppuccin Mocha'
config.color_scheme = 'Solarized Light'
config.color_scheme = 'OneHalfLight'
```

A full list is at https://wezfurlong.org/wezterm/colorschemes/index.html. The list is also exposed at runtime in the theme picker (right-click the title bar → "Theme").

---

## 2. VS Code theme import

A VS Code color theme is a JSON file with this shape (simplified):

```json
{
  "name": "My Theme",
  "type": "dark",
  "colors": {
    "editor.background":              "#1e1e1e",
    "editor.foreground":              "#d4d4d4",
    "editorCursor.foreground":        "#ffffff",
    "editor.selectionBackground":     "#264f78",
    "terminal.background":            "#1e1e1e",
    "terminal.foreground":            "#d4d4d4",
    "terminal.ansiBlack":             "#000000",
    "terminal.ansiRed":               "#cd3131",
    "terminal.ansiGreen":             "#0dbc79",
    "terminal.ansiYellow":            "#e5e510",
    "terminal.ansiBlue":              "#2472c8",
    "terminal.ansiMagenta":           "#bc3fbc",
    "terminal.ansiCyan":              "#11a8cd",
    "terminal.ansiWhite":             "#e5e5e5",
    "terminal.ansiBrightBlack":       "#666666",
    "terminal.ansiBrightRed":         "#f14c4c",
    "terminal.ansiBrightGreen":       "#23d18b",
    "terminal.ansiBrightYellow":      "#f5f543",
    "terminal.ansiBrightBlue":        "#3b8eea",
    "terminal.ansiBrightMagenta":     "#d670d6",
    "terminal.ansiBrightCyan":        "#29b8db",
    "terminal.ansiBrightWhite":       "#e5e5e5",
    "terminalCursor.foreground":      "#ffffff"
  },
  "tokenColors": [
    {
      "scope": ["comment", "punctuation.definition.comment"],
      "settings": { "foreground": "#6A9955", "fontStyle": "italic" }
    }
    /* … */
  ]
}
```

### 2.1 What we map

WezTerminator maps VS Code theme keys to a wezterm `ColorScheme`:

| VS Code key | WezTerm `ColorScheme` field |
| --- | --- |
| `terminal.background` | `background` |
| `terminal.foreground` | `foreground` |
| `terminal.cursor` or `editorCursor.foreground` | `cursor_bg` / `cursor_fg` |
| `terminal.selectionBackground` or `editor.selectionBackground` | `selection_bg` / `selection_fg` |
| `terminal.ansiBlack` … `terminal.ansiBrightWhite` | `ansi[0]` … `ansi[15]` |
| `terminal.border` | (not directly used) |
| `tab.activeBackground` (workbench) | tab-bar background |
| `tab.inactiveBackground` (workbench) | tab-bar background when unfocused |

Anything not in `colors.terminal.*` falls back to `colors.editor.*` and then to wezterm defaults.

### 2.2 Where the theme JSON comes from

A VS Code extension packs its themes as JSON files. Typical locations:

- Windows: `%USERPROFILE%\.vscode\extensions\<publisher>.<name>-<version>\themes\*.json`
- macOS:   `~/.vscode/extensions/<publisher>.<name>-<version>/themes/*.json`
- Linux:   `~/.vscode/extensions/<publisher>.<name>-<version>/themes/*.json`

The full `colors` object is read and converted. WezTerminator keeps a per-theme cache at:

| OS | Cache path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\wezterminator\themes\<sha1>.lua` |
| macOS   | `~/Library/Caches/wezterminator/themes/<sha1>.lua` |
| Linux   | `~/.cache/wezterminator/themes/<sha1>.lua` |

The cache is a **Lua file** containing a `wezterm.color_scheme` definition, which is then loaded with `wezterm.color.load_scheme` (wezterm's existing API). That keeps the runtime path identical to a stock built-in scheme.

### 2.3 How to import a theme

#### 2.3.1 From a local file

```lua
config.color_scheme = 'vscode:C:/Users/me/.vscode/extensions/dracula-theme.theme-dracula-2.25.1/themes/dracula.json'
```

#### 2.3.2 From a marketplace URL

```lua
config.color_scheme = 'vscode:https://marketplace.visualstudio.com/items?itemName=dracula-theme.theme-dracula'
```

WezTerminator downloads the extension `.vsix`, extracts the JSON, and caches it.

#### 2.3.3 At runtime via the picker

Right-click the title bar → "Theme" → "Browse VS Code themes…". A modal opens with a search box. The list is paginated from the [VS Code Marketplace Theme API](https://marketplace.visualstudio.com/search?target=VSCode&category=Themes&sortBy=Installs). Clicking a theme installs it and applies it immediately.

#### 2.3.4 From a packed `.vsix` you already downloaded

Drag-and-drop a `.vsix` onto the WezTerminator window. The theme JSONs inside are extracted and added to the picker.

### 2.4 Theme URL/identifier format

The `vscode:` prefix is parsed as:

| Form | Example | Behavior |
| --- | --- | --- |
| Local path ending in `.json` | `vscode:C:/path/to/theme.json` | Read the file directly. |
| Marketplace item URL | `vscode:https://marketplace.visualstudio.com/items?itemName=…` | Fetch the `.vsix`, extract themes. |
| Bare `publisher.name` | `vscode:dracula-theme.theme-dracula` | Search the marketplace. |
| Bare `name` (no publisher) | `vscode:dracula` | Best-match search. |

---

## 3. Theme picker

`Ctrl+Shift+T` (default) opens the in-app theme picker. The picker is a fuzzy-search list of:

- All built-in wezterm schemes.
- All themes we have in cache.
- Marketplace results (loaded lazily as you type).

The currently active scheme is highlighted. The picker is **live**: scrolling changes the active scheme in real time, so you can preview. Press Enter to keep the choice; Esc to revert.

---

## 4. VS Code settings sync (separate from theming)

`terminal.integrated.*` keys are merged into the wezterm config — see [CONFIG.md §4](CONFIG.md#4-vs-code-settings-sync--what-we-read). This is not strictly "theming" but it lives next to it because both touch colors and fonts.

We do **not** import `workbench.colorCustomizations` automatically; you can opt in with:

```lua
wtinator = {
  features = { vscode_workbench_colors = true },
}
```

When on, the `workbench.colorCustomizations` map is folded into the active scheme at config load time, overriding individual fields.

---

## 5. The conversion algorithm

The `wtinator::vscode_theme` module is a pure function:

```rust
pub fn convert(theme_json: &serde_json::Value) -> Result<ColorScheme, VscodeThemeError>
```

Steps:

1. **Resolve base.** If `type == "light"`, the base is wezterm's `Default Light`; otherwise `Default Dark`. This is the fallback for any missing key.
2. **Apply `colors.terminal.*`** (highest priority).
3. **Apply `colors.editor.*`** (fallback for any `terminal.*` we didn't find).
4. **Apply `workbench.colorCustomizations`** (last writer wins, optional).
5. **Map token colors.** We don't render the token colors directly, but we use `editor.tokenColorCustomizations` to set the **search-match** and **selection-match** highlights so the user gets a theme-consistent "find" highlight.
6. **Write the result** to a `.lua` file in the cache and `return` the parsed `ColorScheme`.

### 5.1 Error handling

| Error | When | What we do |
| --- | --- | --- |
| `Io` | file missing / unreadable | Log, fall back to default. |
| `Parse` | JSON malformed | Log, fall back to default. |
| `MissingTerminalColors` | none of `colors.terminal.*` is set | Log a warning, fall back to `colors.editor.*` and defaults. |
| `UnknownColorFormat` | a value is not `#RRGGBB` or `rgba()` | Log the offending key, skip. |

The picker marks broken themes with a "broken" badge and shows the error in a tooltip.

---

## 6. Testing the importer

The unit tests in `wtinator::vscode_theme::tests` ship with a corpus of real-world themes:

- `assets/test-themes/dracula.json` (Dracula)
- `assets/test-themes/catppuccin-mocha.json` (Catppuccin Mocha)
- `assets/test-themes/solarized-dark.json` (Solarized Dark)
- `assets/test-themes/github-light.json` (GitHub Light)
- `assets/test-themes/malformed.json` (intentional errors)

Each test asserts that:

- The 16 ANSI colors match a hand-verified expected set.
- `background` and `foreground` are correct.
- Cursor color resolves to a non-default value when the theme provides one.

Adding a new theme fixture: drop the JSON in `assets/test-themes/`, run the tests, and **copy the expected values from the test output** into the assertion. This is the only way we know the converter is right.

---

## 7. Out of scope

- **VS Code icon themes** — not used by a terminal.
- **VS Code workbench UI** — we don't render VS Code's UI; we render our own.
- **Custom `.tmTheme` files** (TextMate format) — supported only indirectly, by VS Code extensions that include them. Use the `.json` themes instead.
