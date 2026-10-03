# 0197 — Bridge: WSL com `-d <distro>` e `--cd <pasta>`; o CLI respeita `BETHTERM_HOST_ID`

**Status:** Implemented 2026-10-03.

## What

1. **`spawn` aceita `distro` e usa `--cd` para pastas Linux** (`wezterm/src/cli/bridge.rs`).
   Um terminal WSL aberto pelo Studio recebia a pasta como diretório de trabalho do
   Windows (`command_dir`). Uma pasta Linux (`/home/x`, `/mnt/d/y`) não existe no Windows, o
   host a descartava e o terminal abria no lugar errado. Agora, para shells cujo `argv[0]`
   é `wsl.exe`:
   - pasta que começa com `/` (ou `~`) vira `--cd <pasta>` e **não** é usada como diretório do Windows;
   - `distro` vira `-d <distro>` (substitui um `-d` que já esteja no `argv`);
   - o nome da distro só aceita letras, números, `.`, `_` e `-` (até 64 caracteres);
   - pasta do Windows continua sendo diretório de trabalho; qualquer outro shell fica como estava.
   O helper puro `wsl_spawn_args` tem testes (`wsl_spawn_tests`). O campo novo é opcional, então
   uma ponte antiga ignora `distro` sem erro.

2. **O CLI respeita `BETHTERM_HOST_ID`** (`wezterm-client/src/client.rs`,
   `bethterm_host_socket`). O host já usa esse id (outro mutex, outro evento de saída, outro
   socket `hosts\<id>.sock`). O cliente agora também, com o mesmo filtro (letras, números, `-`, `_`,
   até 48). Serve para testar o Studio contra um host de teste sem nunca enxergar o host do usuário.
   Sem a variável, nada muda: `host.sock` como sempre.

## Files

- `wezterm/src/cli/bridge.rs`
- `wezterm-client/src/client.rs`

## Revert

Remover `wsl_spawn_args`, o campo `distro` da op `spawn` e voltar `command_dir: cwd.filter(..)` em
`spawn_shell`; voltar `bethterm_host_socket` para só `host.sock`. Remover a linha 0197 de
`PATCHES.md` e este arquivo.
