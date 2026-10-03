# Relação com o WezTerm

O Beth Studio começou como um fork do [WezTerm](https://github.com/wezterm/wezterm) (Wez Furlong e colaboradores, licença MIT). O motor de terminal, o multiplexador e o host vêm de lá. A interface é nova.

O Beth Studio é um projeto independente. Não é afiliado nem endossado por Wez Furlong ou pelo projeto WezTerm.

## De onde veio

O WezTerm já tem abas, splits, multiplexador, SSH, renderização por GPU e configuração em Lua. O que ele não faz por padrão é tratar o mouse como forma principal de uso no Windows: abas, splits, temas e fontes são coisas que você configura ou liga a teclas. O Beth Studio manteve o motor e acrescentou um fluxo de trabalho para Windows que funciona sem arquivo de configuração. A história completa está em `docs/HISTORY.md`.

O Beth Studio ainda lê o seu `wezterm.lua` sem mudanças. As opções próprias ficam numa tabela `wtinator = { ... }`, o nome histórico do crate de delta.

## O que mudou

- **Janela nativa removida (patch 0198).** O Studio (Go + React em WebView2) virou a única interface. Saíram o GUI (`wezterm-gui`), a camada de janelas, as fontes, as bibliotecas C vendorizadas e o app de configurações antigo. O host e a ponte ficaram.
- **Nomes (patch 0199).** O nome técnico `bethterm` passou a `bethstudio`: `bethstudio.exe`, `bethstudio-host.exe`, `bethstudio-web.exe`, `bethstudio-tool.exe` e `BethStudio-Setup.exe`. Os pacotes do Cargo (`wezterm`, `wezterm-mux-server`) e o crate `wtinator` não foram renomeados.
- **Host persistente.** Os terminais vivem em `bethstudio-host.exe`. Fechar qualquer janela não os encerra.
- **Ponte.** `bethstudio cli bridge` é um subcomando novo, em JSON-lines, que o Studio usa para falar com o host.
- **Subcomandos que dependiam da janela** (`start`, `ssh`, `serial`, `connect`) agora falham com uma mensagem que aponta para o Beth Studio.
- **Delta em Rust** no crate `wtinator`: sessão, temas, notificações de agente, formas de abrir shells e outros módulos que o host e a ponte usam. Veja [Arquitetura](Arquitetura).

## Como a diferença é registrada

Segundo `docs/UPSTREAM.md`, o que difere da base está em quatro lugares, dentro de `upstream-wezterm/`:

| Arquivo | O que guarda |
| --- | --- |
| `UPSTREAM_DIFF.patch` | O diff exato, contra a base, dos 27 arquivos do WezTerm que ainda estão alterados (cerca de 2.900 linhas). |
| `UPSTREAM_ADDED.txt` | Os 25 arquivos que não existem no WezTerm (sobretudo `wtinator/` e `bethstudio-setup/`). Nunca conflitam. |
| `UPSTREAM_REMOVED.txt` | Os 611 arquivos da base que saíram com a janela nativa. |
| `PATCHES.md` e `patches/` | O motivo de cada mudança, uma nota numerada por patch. |

Ficam de fora do diff, de propósito, o `Cargo.lock`, os binários de `assets/` (ícones, `OpenConsole.exe`, `conpty.dll`) e a configuração local `.cargo/config.toml`.

## A base congelada

A base é o commit do WezTerm registrado em `upstream-wezterm/UPSTREAM_BASE`:

| | |
| --- | --- |
| Repositório | `https://github.com/wez/wezterm.git` |
| Commit | `05c5c9cc15e7bc195cd1938fdc7ba2f7dad26590` |
| Data | 2026-06-06 |
| Assunto | `docs: changelog for #7137 & #7710` |

**O Beth Studio não acompanha o WezTerm.** A árvore copiada fica no commit base. Uma correção do WezTerm entra à mão, só quando importa (segurança ou um defeito que afeta o Beth Studio). Os motivos: o delta mexe no multiplexador e no cliente em vários pontos, e a interface principal não depende do GUI do WezTerm.

Você não precisa do repositório do WezTerm para compilar nem para rodar o Beth Studio. Não há submódulo nem `.git` aninhado. Veja [Compilar do código](Compilar-do-codigo).

## Como portar uma correção do WezTerm

1. Clone `https://github.com/wez/wezterm` e leia o commit com a correção.
2. Aplique a mesma mudança no arquivo correspondente de `upstream-wezterm/`.
3. Se o arquivo aparece em `UPSTREAM_DIFF.patch`, confira que a sua edição não colide com um trecho do Beth Studio.
4. Registre como patch numerado em `PATCHES.md`, com a nota em `patches/NNNN-*.md`, como qualquer outra edição de arquivo existente.

Para migrar para um WezTerm mais novo no futuro, o caminho descrito em `docs/UPSTREAM.md` é: clonar o WezTerm no commit base, aplicar `UPSTREAM_DIFF.patch`, copiar os arquivos de `UPSTREAM_ADDED.txt` e fazer o rebase. Espere conflitos reais nos arquivos de multiplexador e cliente. Esse é o custo que o congelamento evita.

## Licenças

- O Beth Studio usa a licença **MIT**, a mesma do WezTerm. O texto está em `LICENSE.md`.
- Os direitos de cópia: 2018 em diante, Wez Furlong; 2026 em diante, colaboradores do Beth Studio. Os avisos originais do WezTerm foram preservados.
- `NOTICE.md` traz a atribuição para quem redistribui. O instalador empacota `LICENSE.md` e `NOTICE.md` junto com os executáveis.
- A licença original, sem alterações, está em `upstream-wezterm/LICENSE.md`.
- As fontes empacotadas pelo WezTerm continuam sob os termos originais (OFL).
- Contribuições entram sob MIT. Não há CLA. O projeto não aceita dependências GPL, AGPL ou SSPL, nem telemetria.

## Onde reportar um defeito

Defeitos do núcleo do WezTerm que também existem lá devem ir para [wezterm/wezterm](https://github.com/wezterm/wezterm). Defeitos do host, da sessão, da ponte e do Studio ficam neste repositório. Veja [Perguntas frequentes](Perguntas-frequentes).
