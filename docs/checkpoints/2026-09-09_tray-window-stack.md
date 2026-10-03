# Checkpoint 2026-09-09 — tray window stack

## Estado

O X da janela já ia para o ícone perto do relógio (patch 0105), mas o
menu só tinha Abrir/Sair e restaurava todas as janelas de uma vez.

Patch 0106 empilha cada janela escondida no clique direito do ícone.

## Evidência

- `upstream-wezterm/wtinator/src/tray.rs` — menu por janela, IPC entre processos
- `upstream-wezterm/wezterm-gui/src/termwindow/mod.rs` — hide passa o mux window id
- `upstream-wezterm/patches/0106-tray-window-stack.md`

## Resultado

- `cargo +nightly test -p wtinator` — 161 ok, incluindo `tray::tests::*`
- `cargo +nightly check -p wezterm-gui` — ok

## Pendências

- Teste manual: abrir 2+ janelas, fechar cada X, conferir o menu do ícone

## Retomada

Release `bethterm-gui` já compilou (`Finished release` em ~1 min).
Rodrigo valida com `run-bethterm-release.cmd`.
