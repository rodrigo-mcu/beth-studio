# Checkpoint 2026-09-10 — default theme for all terminals

## Estado

Patch 0110: Settings **Usar em todos** persiste o tema em
`%APPDATA%\bethterm\default-theme.json`, aplica em todos os panes
abertos, e carimba abas/janelas novas sem `theme_id`. Splits continuam
herdando (0054).

## Evidência

- `upstream-wezterm/wtinator/src/default_theme.rs`
- IPC `set_default_theme` em `notify_ipc.rs` + `wtinator-config`
- Stamp em `wezterm-gui/src/spawn.rs` e restore
- UI: botão **Usar em todos** + badge default

## Pendências

- Teste manual: Configure this terminal → Usar em todos → nova aba

## Resultado

- `npx tsc --noEmit` + `npm run build` — ok (`dist/index.html` 166 KB)
- `cargo +nightly test -p wtinator` — 168 ok
- `cargo +nightly check -p wezterm-gui -p wtinator-config` — ok
- `cargo +nightly build --release -p wezterm-gui -p wtinator-config` — ok

## Retomada

Rodrigo valida com `run-bethterm-release.cmd`. Não empacotei o Setup.
