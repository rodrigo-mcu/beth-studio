# Configuration

Beth Studio uses the **same** `wezterm.lua` / `.wezterm.lua` config file as upstream WezTerm. Every WezTerm key works unchanged. BethStudio-specific keys are namespaced under `wtinator = { ... }` (historical crate name).

This document covers both:

- A **quick reference** of the `wtinator = { ... }` schema.
- A **set of recipes** for common configurations.

For a full reference of upstream wezterm keys, see https://wezfurlong.org/wezterm/config/files.html.

---

## 1. Where the config lives

| OS | Path |
| --- | --- |
| Windows | `%USERPROFILE%\.wezterm.lua` |
| macOS | `~/.wezterm.lua` |
| Linux | `~/.wezterm.lua` |

The config is loaded at startup. After editing, press `Ctrl+Shift+R` to reload without restarting.

---

## 2. Top-level shape

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- Standard wezterm keys
config.font_size = 11
config.color_scheme = 'Dracula'

-- Beth Studio keys (historical table name)
config.wtinator = {
  features = {
    tab_groups = true,
    broadcast = true,
    vscode_theme_import = true,
    smart_paste = true,
  },
  -- …the rest of the WezTerminator keys
}

return config
```

---

## 3. `wtinator` schema

### 3.1 `wtinator.features` (table, default: all off)

Turn individual features on or off. Every feature is **off by default** so wezterm users upgrading don't see surprising behavior.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `tab_groups` | bool | `false` | Enable the tab-group registry and the group-switch hotkeys. |
| `broadcast` | bool | `false` | Enable broadcast input. The `Alt+B` scope cycle works only if this is on. |
| `vscode_theme_import` | bool | `false` | Read `~/.vscode/extensions/**/themes/*.json` and synthesize a `color_scheme`. |
| `vscode_settings_sync` | bool | `false` | Mirror `terminal.integrated.*` from VS Code's `settings.json`. |
| `smart_paste` | bool | `false` | Detect paste context (shell prompt, password, y/N, REPL, heredoc, vim, less). |
| `status_bar` | bool | `false` | Show the bottom status bar. |
| `picker` | bool | `true` | Enable `Ctrl+Shift+K` quick switcher (off by default? actually on). |
| `bundled_fonts` | bool | `true` | Prompt to download JetBrains Mono / Fira Code on first run. |
| `context_menu` | bool | `true` | Show the right-click menu (you can always disable if you prefer the original). |

### 3.2 `wtinator.vscode_settings_path` (string, optional)

Path to VS Code's user `settings.json`. WezTerminator reads this at config load time and applies the `terminal.integrated.*` keys. The default on Windows is:

```lua
wtinator.vscode_settings_path = wezterm.home_dir .. '/AppData/Roaming/Code/User/settings.json'
```

If the file doesn't exist (VS Code not installed), we log a warning and continue.

### 3.3 `wtinator.vscode_theme_search_endpoint` (string, default: VS Code Marketplace)

Override the marketplace URL used by "Browse VS Code themes". Useful for self-hosted indexes.

### 3.4 `wtinator.broadcast` (table)

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `default_scope` | string | `'off'` | One of `off`, `all`, `group`, `selection`, `tagged`. |
| `default_tag` | string | `''` | Tag used when `default_scope == 'tagged'`. |
| `border_color` | table | `{ Red = { 220, 50, 47 } }` | The border color per scope. |
| `indicator_text` | string | `'BCAST: {scope} ({count})'` | The status-bar text. |

### 3.5 `wtinator.tab_groups` (table)

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `storage_path` | string | (platform default) | Where to persist the group registry. |
| `auto_save` | bool | `true` | Save on quit and every 60s. |
| `default_group_shortcut_digits` | int | `1` … `9` mapped to `Alt+1` … `Alt+9` | Up to 9 quick groups. |
| `group_switcher_hotkey` | table | `Ctrl+Shift+G` | Opens the group picker. |

### 3.6 `wtinator.clipboard` (table)

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `paste_action` | string | `'prompt'` | One of `'prompt'`, `'plain'`, `'quote'`, `'base64'`, `'heredoc'`. |
| `copy_format` | string | `'plain+rtf'` | One of `'plain'`, `'plain+rtf'`, `'html'`, `'with-line-numbers'`. |
| `strip_trailing_whitespace` | bool | `true` | On paste. |
| `convert_crlf_to_lf` | bool | `true` | On paste. |
| `bracketed_paste` | bool | `true` | Send the `?2004h` wrap. |

### 3.7 `wtinator.status_bar` (table)

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | bool | follows `features.status_bar` | |
| `left` | list | `{ 'wtinator_status_active_group', 'wtinator_status_tabs' }` | Widgets shown on the left. |
| `right` | list | `{ 'wtinator_status_broadcast_scope', 'wtinator_status_shell', 'wtinator_status_clock' }` | Widgets shown on the right. |
| `foreground` | color | `'#cdd6f4'` | |
| `background` | color | `'#1e1e2e'` | |

You can write your own widgets; see [§5.5](#55-custom-status-bar-widgets).

### 3.8 `wtinator.shells` (table)

Quick-pick list for the right-click "Change shell" menu. Each entry has a `label` and a `program` (with optional `args`).

```lua
wtinator.shells = {
  { label = 'PowerShell 7',  program = 'pwsh.exe',          args = { '-NoLogo' } },
  { label = 'PowerShell 5',  program = 'powershell.exe',    args = { '-NoLogo' } },
  { label = 'WSL Ubuntu',    program = 'wsl.exe',           args = { '-d', 'Ubuntu' } },
  { label = 'cmd',           program = 'cmd.exe' },
  { label = 'Git Bash',      program = 'C:/Program Files/Git/bin/bash.exe', args = { '--login' } },
  { label = 'Nu',            program = 'nu.exe' },
}
```

This is the list that appears in the "Change shell" submenu and in the "New tab" submenu on the tab bar.

### 3.9 `wtinator.keybindings` (table)

Overrides for WezTerminator-specific keybindings. The values follow wezterm's `KeyAssignment` format.

```lua
wtinator.keybindings = {
  split_right           = { key = 'd', mods = 'CTRL|SHIFT' },
  split_down            = { key = 'o', mods = 'CTRL|SHIFT' },
  close_pane            = { key = 'w', mods = 'CTRL|SHIFT' },
  new_tab_menu          = { key = 't', mods = 'CTRL|SHIFT' },
  new_tab_default       = { key = 't', mods = 'CTRL' },
  broadcast_toggle_all  = { key = 'b', mods = 'ALT' },
  broadcast_cycle_scope = { key = 'b', mods = 'ALT|SHIFT' },
  broadcast_toggle_group= { key = 'g', mods = 'ALT' },
  group_picker          = { key = 'g', mods = 'CTRL|SHIFT' },
  new_group_from_tabs   = { key = 'g', mods = 'CTRL|SHIFT', and = { key = 'n' } }, -- chord
  save_layout           = { key = 's', mods = 'CTRL|SHIFT' },
  restore_layout        = { key = 'r', mods = 'CTRL|SHIFT' },
  reload_config         = { key = 'r', mods = 'CTRL|SHIFT' },
  quick_switcher        = { key = 'k', mods = 'CTRL|SHIFT' },
}
```

If you don't set a value here, the defaults in the right column are used.

---

## 4. VS Code settings sync — what we read

WezTerminator reads these keys from `settings.json` and maps them:

| VS Code key | WezTerminator effect |
| --- | --- |
| `terminal.integrated.fontFamily` | `config.font` (and `config.font_rules`) |
| `terminal.integrated.fontSize` | `config.font_size` |
| `terminal.integrated.fontWeight` | `config.font_weight` (best-effort mapping) |
| `terminal.integrated.fontWeightBold` | `config.font_weight_bold` |
| `terminal.integrated.letterSpacing` | `config.cell_width_padding` (best-effort) |
| `terminal.integrated.lineHeight` | `config.line_height` |
| `terminal.integrated.cursorStyle` | `config.default_cursor_style` |
| `terminal.integrated.cursorBlink` | `config.cursor_blink` |
| `terminal.integrated.scrollback` | `config.scrollback_lines` |
| `terminal.integrated.padding` (left/right) | `config.window_padding` |
| `terminal.integrated.copyOnSelection` | `config.copy_on_select` (wezterm has this directly) |
| `terminal.integrated.enableBell` | `config.audio_bell` |
| `terminal.integrated.commandsToSkipShell` | merged into the same wezterm key |
| `terminal.integrated.defaultProfile.*` | platform-specific default shell |
| `workbench.colorTheme` | `config.color_scheme` (after running it through the theme importer if needed) |

If a key is **not** present, we leave the existing wezterm value alone. The merge is `vscode → wtinator → wezterm-defaults` (left to right, last writer wins, but a key absent in any layer is skipped).

---

## 5. Recipes

### 5.1 Minimal — what gets you a working WezTerminator

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.wtinator = {
  features = {
    tab_groups = true,
    broadcast = true,
  },
}

return config
```

### 5.2 Power-user — VS Code sync, broadcast, status bar, custom shells

```lua
local wezterm = require 'wezterm'
local act = wezterm.action
local config = wezterm.config_builder()

config.color_scheme = 'Catppuccin Mocha'
config.font_size = 12

config.wtinator = {
  features = {
    tab_groups = true,
    broadcast = true,
    vscode_theme_import = true,
    vscode_settings_sync = true,
    smart_paste = true,
    status_bar = true,
  },
  vscode_settings_path = wezterm.home_dir .. '/AppData/Roaming/Code/User/settings.json',
  shells = {
    { label = 'pwsh',   program = 'pwsh.exe',       args = { '-NoLogo' } },
    { label = 'wsl',    program = 'wsl.exe',        args = { '-d', 'Ubuntu-22.04' } },
    { label = 'cmd',    program = 'cmd.exe' },
  },
  broadcast = {
    default_scope = 'off',
    border_color  = { all = '#dc322f', group = '#268bd2', selection = '#b58900', tagged = '#859900' },
  },
  status_bar = {
    left  = { 'wtinator_status_active_group', 'wtinator_status_tabs' },
    right = { 'wtinator_status_broadcast_scope', 'wtinator_status_shell', 'wtinator_status_clock' },
  },
}

return config
```

### 5.3 Use a VS Code theme by name

```lua
config.color_scheme = 'vscode:GitHub Dark'
-- or with a marketplace URL
config.color_scheme = 'vscode:https://marketplace.visualstudio.com/items?itemName=dracula-theme.theme-dracula'
```

The `vscode:` prefix tells WezTerminator to fetch the theme at startup (cached in `%LOCALAPPDATA%\wezterminator\themes\`).

### 5.4 Disable features wholesale (compatibility mode)

```lua
config.wtinator = {
  features = {
    tab_groups = false,
    broadcast  = false,
    -- all keys omitted → off
  },
}
```

This makes WezTerminator behave like stock wezterm. Useful for testing whether a problem is ours or upstream's.

### 5.5 Custom status bar widgets

A widget is a function that takes `(window, pane)` and returns a `wezterm.Format` item or a string:

```lua
wtinator.status_bar = {
  left = {
    {
      widget = function(window, pane)
        local cwd = pane:get_current_working_dir()
        return wezterm.format { { Attribute = { Intensity = 'Bold' } }, { Text = ' ' .. (cwd and cwd.file_path or '~') .. ' ' } }
      end,
    },
  },
}
```

The convenience names starting with `wtinator_status_` are aliases for the widgets we ship.

---

## 6. Environment variables

| Variable | Effect |
| --- | --- |
| `WTINATOR_DISABLE_RC` | Skip loading any user config. Useful for debugging. |
| `WTINATOR_LOG` | Equivalent to `RUST_LOG` but scoped to our crate. |
| `WTINATOR_THEMES_DIR` | Override the cached VS Code theme directory. |
| `WTINATOR_FONTS_DIR` | Override the bundled-fonts directory. |

---

## 7. Validation

When we load a config, we validate it. The following produce **errors** (window does not start):

- `wtinator.shells` is not a list of tables.
- A `wtinator.keybindings` value is not a table with `key` and `mods`.

The following produce **warnings** (window starts, but the bad key is ignored):

- An unknown key in `wtinator`.
- A shell whose `program` is not on `PATH` at config-load time.
- A `vscode_settings_path` that does not exist.

Warnings are printed to stderr at `info` level and to a one-time in-window toast.
