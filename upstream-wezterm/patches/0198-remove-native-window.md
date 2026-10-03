# 0198 — Remove a janela nativa (wezterm-gui) e tudo que só existia para ela

**Status:** Implemented 2026-10-03.

## What

O Beth Studio (Go + React em WebView2) passou a ser a única interface. O host
(`bethterm-host.exe`) continua dono dos PTYs e a ponte (`bethterm cli bridge`) continua
sendo o caminho do Studio. A janela nativa (`bethterm-gui.exe`, Skia) saiu da árvore.

1. **Crates removidos do workspace** (`Cargo.toml`): `wezterm-gui`, `window`,
   `lua-api-crates/window-funcs`, `wezterm-font`, `wezterm-toast-notification`,
   `wtinator-config`, `wezterminator`, `deps/` (freetype, harfbuzz, cairo, fontconfig),
   `frecency`, `lfucache`, `strip-ansi-escapes`, `sync-color-schemes`, `bidi/generate`.
   Saem também as dependências de workspace e o `[patch.crates-io]` do cairo. `base91`
   fica (o `codec` usa).
2. **Assets removidos:** `assets/fonts`, `assets/windows/angle`, `assets/windows/mesa`,
   `assets/macos`. Ficam `OpenConsole.exe` e `conpty.dll`.
3. **`wtinator` podado** para o que o host e a ponte usam: `agent_wait`, `config_lua`,
   `default_theme`, `echo_latency`, `groups`, `host`, `notify`, `notify_ipc`, `pane_cmd`,
   `session`, `shells`, `taskbar_icon`, `theme_download`, `vscode_theme`, `window_geom`.
   `default_shells` (e a leitura de `shells.json`) saiu de `context_menu.rs` para o novo
   `shells.rs`, com os mesmos testes.
4. **CLI** (`wezterm/src/main.rs`, `wezterm/src/cli/bridge.rs`): some o subcomando
   `gui-restart`; `start`, `ssh`, `serial` e `connect` (que delegavam à GUI) agora falham
   com uma mensagem apontando para o Beth Studio; a ponte usa `wtinator::shells`.
5. **Instalador** (`bethterm-setup`): empacota `bethterm-web.exe` em vez de
   `bethterm-gui.exe`/`wtinator-config.exe`/libEGL/mesa; atalhos e o botão **Abrir** apontam
   para o Studio; uma atualização por cima ainda fecha os nomes antigos da GUI.

## Files

- `Cargo.toml`, `Cargo.lock`
- `wtinator/src/lib.rs`, `wtinator/src/shells.rs` (novo) e os módulos removidos
- `wezterm/src/main.rs`, `wezterm/src/cli/bridge.rs`
- `bethterm-setup/build.rs`, `bethterm-setup/src/main.rs`
- scripts da raiz: `run-bethterm*.cmd`, `pack-bethterm-setup.ps1`, `install-bethterm-release.ps1`

## Revert

Os arquivos removidos continuam na base congelada (`UPSTREAM_BASE`) e a lista está em
`UPSTREAM_REMOVED.txt`. A janela nativa só volta restaurando esses crates e o patch 0196.
