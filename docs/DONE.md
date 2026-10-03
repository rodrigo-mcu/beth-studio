# WezTerminator — O que foi feito (snapshot 2026-06-08)

**Data:** 2026-06-08 (snapshot final do dia)
**Autor:** Claude (Opus 4.8), em colaboração com o Codex (GPT-5) que entregou a base do titlebar

Este documento lista **tudo o que foi implementado e está em produção** no
WezTerminator, com referência rápida aos patches, arquivos, e tests.

## Índice de features

| # | Patch | Feature | Onde mexer |
|---|-------|---------|------------|
| 0001 | [docs](upstream-wezterm/patches/0001-workspace-members.md) | Workspace wiring: `wtinator` + `wezterminator` viram membros do workspace | `upstream-wezterm/Cargo.toml` |
| 0002 | [docs](upstream-wezterm/patches/0002-chrono-clock.md) | `chrono` com feature `clock` (era bug upstream) | `upstream-wezterm/Cargo.toml` |
| 0003 | [docs](upstream-wezterm/patches/0003-wezterm-main-install.md) | `wtinator::install()` no `main.rs` do wezterm | `upstream-wezterm/wezterm/src/main.rs` |
| 0004 | [docs](upstream-wezterm/patches/0004-wezterm-cargo-wtinator.md) | `wtinator` dep no `wezterm` | `upstream-wezterm/wezterm/Cargo.toml` |
| 0005 | [docs](upstream-wezterm/patches/0005-right-click-menu.md) | Right-click menu v1 (skia overlay, legado) | `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` |
| 0006 | [docs](upstream-wezterm/patches/0006-plus-button-shell-picker.md) | Botão `+` no tab bar → native picker | `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` |
| 0007 | [docs](upstream-wezterm/patches/0007-status-split-picker.md) | Status area no tab bar → split picker | `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` |
| 0008 | [docs](upstream-wezterm/patches/0008-split-label-render.md) | Ícone `[>_]` no lugar de label text | `upstream-wezterm/wezterm-gui/src/tabbar.rs` |
| 0009 | [docs](upstream-wezterm/patches/0009-native-menu.md) | Right-click menu v2 (native Win32 HMENU) | `upstream-wezterm/wtinator/src/context_menu.rs` |
| 0010 | [docs](upstream-wezterm/patches/0010-right-click-release-menu.md) | Re-entrant guard para menu | `upstream-wezterm/wtinator/src/context_menu.rs` + `upstream-wezterm/window/src/os/windows/window.rs` |
| 0011 | [docs](upstream-wezterm/patches/0011-windows-reentrant-message-guards.md) | Re-entrant guards adicionais (WM_PAINT/WM_MOUSELEAVE) | `upstream-wezterm/window/src/os/windows/window.rs` |
| 0012 | [docs](upstream-wezterm/patches/0012-split-shell-submenu.md) | Split right/down → submenus de shell | `upstream-wezterm/wtinator/src/context_menu.rs` |
| 0013 | [docs](upstream-wezterm/patches/0013-clipboard-menu.md) | Copy / Paste no menu | `upstream-wezterm/wtinator/src/context_menu.rs` |
| 0014 | [docs](upstream-wezterm/patches/0014-select-all.md) | `KeyAssignment::SelectAll` (upstream enum) + menu entry | `upstream-wezterm/config/src/keyassignment.rs` + `upstream-wezterm/wtinator/src/context_menu.rs` |
| 0015 | [docs](upstream-wezterm/patches/0015-save-scrollback.md) | Save scrollback to file (native Save dialog) | `upstream-wezterm/wtinator/src/save_scrollback.rs` (new) |
| 0016 | [docs](upstream-wezterm/patches/0016-baked-themes.md) | 3 temas built-in (VSCode Light, VSCode Dark, Windows Terminal Dark) | `upstream-wezterm/wtinator/src/vscode_theme.rs` (new) |
| 0017 | [docs](upstream-wezterm/patches/0017-theme-submenu.md) | Submenu "Theme" no right-click | `upstream-wezterm/wtinator/src/context_menu.rs` |
| 0018 | [docs](upstream-wezterm/patches/0018-menu-icons.md) | Ícones 16x16 GDI-rendered nos menus | `upstream-wezterm/wtinator/src/menu_icons.rs` (new) |
| 0019 | [docs](upstream-wezterm/patches/0019-alt-enter-newline.md) | `Alt+Enter` envia LF (newline) | `upstream-wezterm/wezterm-gui/src/commands.rs` |
| 0020 | [docs](upstream-wezterm/patches/0020-custom-titlebar.md) | Custom title/tab bar (sem native Win32 caption) | `upstream-wezterm/wtinator/src/titlebar.rs` (new) + 5 outros arquivos |
| 0021 | [docs](upstream-wezterm/patches/0021-ctrl-c-v-on-windows.md) | `Ctrl+C` / `Ctrl+V` / `Ctrl+Insert` defaults | `upstream-wezterm/wezterm-gui/src/commands.rs` |
| 0022 | [docs](upstream-wezterm/patches/0022-paste-image.md) | Paste image from clipboard (Markdown link) | `upstream-wezterm/wtinator/src/image_paste.rs` (new) |
| 0023 | [docs](upstream-wezterm/patches/0023-vscode-font.md) | Aplica `editor.fontFamily` + `editor.fontSize` do VSCode | `upstream-wezterm/wtinator/src/vscode_font.rs` (new) |
| 0024 | [docs](upstream-wezterm/patches/0024-cursor-color.md) | Cursor color auto-picks contrast | `upstream-wezterm/wtinator/src/cursor_color.rs` (new) |
| 0025 | [docs](upstream-wezterm/patches/0025-screenshot.md) | Screenshot submenu (save JPEG / copy CF_DIB) | `upstream-wezterm/wtinator/src/screenshot.rs` (new) + `upstream-wezterm/window/src/os/windows/window.rs` (`Window::hwnd()` getter) |
| 0026 | [docs](upstream-wezterm/patches/0026-mobaxterm-local-bash.md) | MobaXterm local bash shell entry | `upstream-wezterm/wtinator/src/context_menu.rs` |
| 0027 | [docs](upstream-wezterm/patches/0027-cursor-bg-invisible-dark-themes.md) | Fix cursor invisível nos dark baked themes | `upstream-wezterm/wtinator/src/vscode_theme.rs` |
| 0027.1 | [docs](upstream-wezterm/patches/0027.1-ctrl-c-fall-through.md) | Ctrl+C fall-through pro shell quando sem seleção | `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs` |
| 0028 | [docs](upstream-wezterm/patches/0028-tab-groups.md) | Tab groups + "Move pane to…" submenu | `upstream-wezterm/mux/src/tab.rs` + `upstream-wezterm/wtinator/src/groups.rs` (new) + `upstream-wezterm/wtinator/src/context_menu.rs` + `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` |
| 0029 | [docs](upstream-wezterm/patches/0029-session-save-restore.md) | Save/restore da organização de groups (auto-save 30s) | `upstream-wezterm/wtinator/src/session.rs` (new) + `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs` |
| 0030 | [docs](upstream-wezterm/patches/0030-terminal-header.md) | Per-terminal status header (data model + Win32 rename dialog + persistência) | `upstream-wezterm/mux/src/tab.rs` + `upstream-wezterm/wtinator/src/header/` (new sub-dir) + `upstream-wezterm/wtinator/src/context_menu.rs` + `upstream-wezterm/wezterm-gui/src/termwindow/mouseevent.rs` + `upstream-wezterm/wtinator/src/session.rs` + `upstream-wezterm/wtinator/Cargo.toml` |
| 0105 | [docs](upstream-wezterm/patches/0105-close-to-tray.md) | X esconde no ícone do relógio | `wtinator/src/tray.rs` |
| 0106 | [docs](upstream-wezterm/patches/0106-tray-window-stack.md) | Menu do tray empilha janelas escondidas | `wtinator/src/tray.rs` |
| 0107 | [docs](upstream-wezterm/patches/0107-tray-icon-must-exist.md) | Hide só se o ícone existir | `wtinator/src/tray.rs` |
| 0108 | [docs](upstream-wezterm/patches/0108-reuse-running-gui.md) | Atalho reusa o GUI em execução | `bethterm-setup/src/main.rs` |
| 0109 | [docs](upstream-wezterm/patches/0109-focus-existing-and-hide-wgl-probe.md) | Foca GUI existente; esconde probe WGL | `wezterm-gui/src/main.rs`, `window/.../wgl.rs` |
| 0110 | [docs](upstream-wezterm/patches/0110-default-theme.md) | Tema default em todos os terminais | `wtinator/src/default_theme.rs`, Settings |
| 0111 | [docs](upstream-wezterm/patches/0111-tray-always-on-and-new-window.md) | Tray sempre visível + Novo terminal | `wtinator/src/tray.rs` |
| 0112 | [docs](upstream-wezterm/patches/0112-system-panel.md) | Painel Sistema (CPU/RAM/disco) | `wtinator/src/sysmon.rs`, `syspanel.rs` |
| 0113 | [docs](upstream-wezterm/patches/0113-conpty-stability.md) | Para congeladas: ConPTY 1.24 + close off-UI | `pty/src/win/*`, `session.rs`, `sysmon.rs` |
| 0114 | [docs](upstream-wezterm/patches/0114-fluid-ui.md) | UI fluida: sem log debug, cursor barato | `cursor_anim.rs`, `pane.rs`, launchers |
| 0115 | [docs](upstream-wezterm/patches/0115-release-default-no-args.md) | Release GUI sem args é o launch padrão | `run-bethterm.cmd`, setup shortcuts |
| 0116 | [docs](upstream-wezterm/patches/0116-skip-paint-when-hidden.md) | Sem paint GPU no tray/minimizado | `window.rs`, `termwindow/mod.rs`, `tray.rs` |
| 0117 | [docs](upstream-wezterm/patches/0117-tray-new-terminal-picker.md) | Novo terminal do tray escolhe o shell | `tray.rs`, `spawn.rs` |
| 0118 | [docs](upstream-wezterm/patches/0118-tray-spawn-on-gui-thread.md) | Spawn do tray não derruba o processo | `spawn.rs`, `tray.rs` |
| 0119 | [docs](upstream-wezterm/patches/0119-fluid-output-frames.md) | Tab/output fluido: cache quente + frames | `termwindow/mod.rs`, `cursor_anim.rs` |
| 0120 | [docs](upstream-wezterm/patches/0120-tray-list-visible-windows.md) | Tray lista janelas visíveis também | `tray.rs` |
| 0121 | [docs](upstream-wezterm/patches/0121-persistent-pty-host.md) | Host persistente: GUI pode fechar sem matar PTYs | `host.rs`, `wezterm-mux-server`, `wezterm-gui` |
| 0122 | [docs](upstream-wezterm/patches/0122-host-quit-visual-update.md) | Encerrar host + tema/fonte no reconnect + .exe.new | `host_meta.rs`, `clientpane.rs`, `tray.rs` |
| 0123 | [docs](upstream-wezterm/patches/0123-no-session-respawn-on-host.md) | Restore não respawna session.json no host | `session_restore.rs`, `domain.rs` |
| 0124 | [docs](upstream-wezterm/patches/0124-pane-dashboard.md) | Dashboard lateral dos painéis abertos | `dashboard.rs`, `tray.rs`, `termwindow` |
| 0125 | [docs](upstream-wezterm/patches/0125-tray-star-open-windows.md) | Tray sempre lista janelas; `*` nas abertas | `tray.rs` |
| 0126 | [docs](upstream-wezterm/patches/0126-tray-icon-survive-explorer.md) | Ícone do tray sobrevive ao Explorer | `tray.rs` |

Notas de teste 2026-09-10: [`docs/changelog/2026-09-10-patches-0105-0110.md`](changelog/2026-09-10-patches-0105-0110.md).

## Detalhes por feature

### 0020 — Custom title/tab bar (a grande feature da semana)

A barra de título nativa do Windows foi removida; o tab bar e os botões (Hide, Maximize, Close) são renderizados pelo upstream `fancy_tab_bar` renderer. O window é `WS_POPUP` (borderless) com redimensionamento manual via `WM_NCHITTEST`. Suporta `WTINATOR_ACTIVE=1` env var + detecção por nome do executável.

### 0022/0025 — Paste image + Screenshot

Paste image lê `CF_DIB` / `CF_DIBV5` do clipboard Windows, converte para PNG, salva em `C:\tmp\wezterminator\clipboard-images\` (fallback `%TEMP%`), e cola um `![image](...)` Markdown no pane ativo. Screenshot usa `PrintWindow(PW_RENDERFULLCONTENT)` + `GetDIBits` para capturar o window; salva como JPEG via `GetSaveFileNameW` ou copia como `CF_DIB` para o clipboard.

### 0024/0027 — Cursor contrast

`cursor_color.rs` calcula luminância do `colors.background` (BT.601 weights) e sobrescreve `cursor_fg` com branco ou preto conforme o caso. Patch 0027 corrigiu o bug onde `cursor_bg` estava igual ao `background` em `vscode_dark` e `windows_terminal_dark` (cursor invisível — user "qd o mudo de terminal o cursor some, mas se eu digitar funciona").

### 0027.1 — Ctrl+C fall-through

O default `Ctrl+C → CopyTo` (patch 0021) engole o byte 0x03 (ETX) que o shell precisa para abortar processo. Fix: se `selection_text(pane).is_empty()`, retorna `PerformAssignmentResult::Unhandled` para que o upstream fall-through envie o byte ao pane.

### 0028 — Tab groups + "Move pane to…"

- `mux::tab::Tab` ganha campo `group_name: Option<String>` (com `get_group_name` / `set_group_name`)
- `wtinator::groups::list_groups()`, `move_pane_to_group()` (cria novo tab no group alvo, sized ao source, remove source se vazio)
- Submenu "Move pane to" com wIDs `0x6001..=0x60FF` (FNV-1a hash do group name) + sentinel `0x6000` para "(no group)"
- A submenu é reconstruída a cada right-click (sempre reflete mux state atual)
- Group vazio some do menu naturalmente (não tem tabs)

### 0029 — Session save/restore

- `wtinator::session` persiste `(tab_id, group_name)` em `%APPDATA%\wezterminator\session.json` (Windows) / `$XDG_CONFIG_HOME/wezterminator/session.json` (Linux/macOS)
- JSON schema v1; aceita versões ≤ 1, rejeita > 1
- Auto-save a cada 30s via `smol::Timer::at(Instant::now() + Duration::from_secs(30))` (NÃO `tokio::time::interval` — o wezterm não tem runtime tokio!)
- Save também em `close_requested` e `close_requested_with_confirmation`
- Load em `new_window` após o mux estar populado
- Write atômico (`.tmp` + rename)
- **Bug fix importante durante implementação:** o `tokio::time::interval` panicava com "there is no reactor running" — o wezterm usa `smol`/`async_task`, não tokio. Fix: trocar para `smol::Timer::at` em loop.

### 0030 — Per-terminal header (data model + Win32 rename)

- `mux::tab::Tab` ganha `header_text: Option<String>` (com `get_header_text` / `set_header_text`)
- `wtinator::header::build_header(tab, tab_index)` formata `"Tab #N · group: X · title: Y"`
- `wtinator::header::normalize_header_text` valida input (max 80 chars, no control chars)
- `wtinator::header::prompt_rename` (em `header/win32_prompt.rs`) abre um dialog Win32 nativo:
  - Janela 520×170 com `WS_EX_DLGMODALFRAME` (visual de dialog real)
  - Label "New name:" em cinza médio
  - EDIT 496×32 com `WS_EX_CLIENTEDGE`
  - Botões OK (Enter) e Cancel (Esc), 110×36
  - Fonte **Segoe UI 9pt** (criada via `CreateFontW`, cache em `OnceLock<usize>`)
  - Background off-white `#FAFAFA` via `CreateSolidBrush` + `WM_CTLCOLOR*` (criado em `OnceLock<usize>`)
  - Texto `#1F1F1F` (EDIT/botões) e `#606060` (label)
  - Função `const fn rgb(r, g, b) -> u32` que reproduz a macro `RGB()` do `<wingdi.h>` (não exposta pelo `windows-sys 0.61`)
- **Threading model**: dialog roda em `std::thread::spawn` separada (não na main thread) — main thread continua processando paint/input do wezterm enquanto dialog está aberto. Resultado volta via `gui_window.notify(TermWindowNotif::Apply(...))`.
- **Bugs corrigidos durante iteração**:
  - Dialog invisível (faltava `WS_VISIBLE` no `CreateWindowExW`)
  - Main thread congelada (dialog rodava inline no `spawn_into_main_thread` — virou `std::thread::spawn`)
  - Segundo rename não abria (cada chamada re-registrava a window class e a segunda chamada retornava 0 — refatorado para `OnceLock<()>` no nível do módulo)
  - Tipos `*mut c_void` (`HBRUSH`, `HFONT`) não são `Send + Sync` — armazenados como `usize` raw nos `OnceLock<usize>`
- **lint policy**: `unsafe_code` mudado de `deny` (em `lib.rs`) para `warn` (em `Cargo.toml`); `#[allow(unsafe_code)]` no sub-módulo `win32_prompt` silencia o warning para esse único arquivo
- `session.rs` schema bump: v1 → v2 (campo `header_text` adicionado; `serde(default)` permite upgrade transparente de v1 files)
- **Limitação conhecida**: o render visual do header DENTRO do terminal (linha na primeira row do viewport) ainda NÃO está implementado — ver `done.md` lista de "what's missing" / TODO 0030.5

## Tabela de módulos do `wtinator`

| Módulo | Propósito | Tests |
|--------|-----------|-------|
| `groups` | Tab groups (patch 0028) | 5 |
| `header/mod.rs` | Header data model + formatação (patch 0030) | 7 |
| `header/win32_prompt.rs` | Dialog Win32 nativo para rename (patch 0030) | 0 (unsafe-only, dialog só testável em runtime) |
| `image_paste` | Paste image from clipboard (patch 0022 + 0025) | 5 |
| `menu_icons` | Ícones 16x16 GDI-rendered (patch 0018) | 4 |
| `save_scrollback` | Save scrollback to file (patch 0015) | 2 |
| `screenshot` | Screenshot submenu (patch 0025) | 4 |
| `session` | Save/restore group layout (patch 0029, v2) | 8 |
| `vscode_font` | Aplica `editor.fontFamily` + `editor.fontSize` (patch 0023) | 4 |
| `vscode_theme` | 3 temas built-in (patch 0016, 0027 fix) | 6 |
| `cursor_color` | Auto-pick cursor_fg (patch 0024) | 4 |
| `titlebar` | Custom title/tab bar (patch 0020) | 4 |
| `broadcast` | Stub | 0 |
| `clipboard` | Stub (smart-paste pipeline) | 0 |
| `config_lua` | Inicializa config do WezTerminator | 0 |
| `layout_io` | Stub | 0 |
| `picker` | Stub | 0 |
| `shell_menu` | Stub | 0 |
| `status_bar` | Stub (a ser preenchido pelo render do patch 0030.5) | 0 |
| `themes_folder` | Open themes folder in OS file manager (patch 0017) | 4 |
| `vscode_settings` | Stub | 0 |

**Total:** 79/79 tests `wtinator` passam (count: 2026-06-08 15:05 build).

## Validação

```powershell
# Tests (79 passing)
cargo +nightly test -p wtinator

# Type check
cargo +nightly check -p mux
cargo +nightly check -p wezterm-gui

# Release build
cargo +nightly build --release -p wezterm -p wezterm-gui
```

**Final binary:**
```text
upstream-wezterm\target\release\wezterm-gui.exe
LastWriteTime: 2026-06-08 15:05
Size: 70748672 bytes
```

## Documentação existente

- `STATUS.md` — snapshot de status, tabela de features, validação
- `HANDOFF.md` — handoff document com delta Codex + delta Claude
- `upstream-wezterm/PATCHES.md` — tabela detalhada de cada patch com arquivos e rationale
- `upstream-wezterm/patches/00XX-*.md` — 30+ docs individuais (um por patch, com "What / Why / How / Revert / Risk")
- `docs/EXECUTABLE_OUTPUT.md` — como capturar output de apps GUI / MobaXterm
- `docs/2026-06-07-codex-titlebar-window-controls.md` — handoff original do Codex

## Lint policy

- `unsafe_code = "warn"` em `Cargo.toml` (era `deny` em `lib.rs` antes do patch 0030)
- `#[allow(unsafe_code)]` apenas em `header::win32_prompt` (único módulo que precisa de `unsafe` direto da Win32 API)
- Resto do `wtinator` é safe-by-default
- Upstream `wezterm-gui` e `mux` continuam permitindo `unsafe` (são os crates originais)
