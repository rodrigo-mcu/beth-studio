# 0199 — O produto passa a se chamar Beth Studio (bethstudio)

**Status:** Implemented 2026-10-03.

## What

O nome técnico `bethterm` foi trocado por `bethstudio` em todo o projeto. O nome de exibição é
**Beth Studio**. Não há migração: a pasta de dados nova começa vazia e a antiga
(`%APPDATA%\bethterm`) é apagada à mão onde existir.

- **Executáveis:** `bethstudio.exe` (CLI e ponte), `bethstudio-host.exe`, `bethstudio-web.exe`,
  `bethstudio-tool.exe` e o instalador `BethStudio-Setup.exe`.
- **Pastas:** `bethstudio-web/`, `bethstudio-mobile/`, `upstream-wezterm/bethstudio-setup/`; pasta
  de instalação padrão `C:\Users\Public\BethStudio`; dados em `%APPDATA%\bethstudio`.
- **Identificadores:** variáveis `BETHSTUDIO_*`, mutex e evento do host (`Local\BethStudioHost`,
  `Local\BethStudioHostQuit`), cabeçalho `X-BethStudio-Token`, esquema `bethstudio://`, módulo Go
  `bethstudio-web`, chaves do navegador `bethstudio.*`.
- **Não mudou:** o crate `wtinator`, os pacotes Cargo `wezterm` e `wezterm-mux-server`, e o texto
  histórico (patches 0001–0198, changelog, checkpoints, specs datadas).
- Scripts da raiz: `run-bethstudio*.cmd`, `pack-bethstudio-setup.*`, `install-bethstudio-release.*`.

## Files

Quase todos os arquivos do repositório fora do histórico; o diff contra o WezTerm foi gerado de novo.

## Revert

Trocar `bethstudio` por `bethterm` (e `BethStudio` por `BethTerm`) nos mesmos arquivos.
