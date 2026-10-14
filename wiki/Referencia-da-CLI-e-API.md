# Referência da CLI e da API

Esta página lista os comandos do `bethstudio.exe`, o protocolo da ponte, as opções do `bethstudio-web.exe` e do `bethstudio-tool.exe` e as rotas HTTP e WebSocket do Studio. Para o uso diário você não precisa de nada disto: tudo se faz com o mouse no Studio.

## bethstudio.exe

`bethstudio.exe` é o WezTerm sem a janela nativa. Sem subcomando, ele tenta abrir a janela e falha com uma mensagem (veja abaixo).

Opções globais: `-n` / `--skip-config` (não lê o `wezterm.lua`), `--config-file <arquivo>` e `--config nome=valor`.

| Subcomando | O que faz |
| --- | --- |
| `cli` | Fala com o host. Veja a tabela de `cli` abaixo. |
| `ls-fonts`, `show-keys` | Delegam à janela nativa. Hoje falham com a mensagem abaixo. |
| `start`, `ssh`, `serial`, `connect` | Também falham com a mesma mensagem. |
| `imgcat` | Escreve uma imagem no terminal (protocolo iTerm). |
| `set-working-directory` | Informa a pasta atual ao terminal (OSC 7). |
| `record` | Grava uma sessão de terminal como asciicast. |
| `replay` | Reproduz uma gravação asciicast. |
| `shell-completion --shell <bash|elvish|fish|power-shell|zsh|fig>` | Gera o arquivo de completar comandos. |

Os subcomandos que dependiam da janela nativa respondem: "esta versão não tem janela nativa: abra o Beth Studio (bethstudio-web) ou use `bethstudio cli` para falar com o host".

### bethstudio.exe cli

Opções de `cli`: `--no-auto-start` (não inicia o servidor), `--prefer-mux` (prefere o host em segundo plano) e `--class <nome>`.

| Subcomando de `cli` | O que faz |
| --- | --- |
| `list` | Lista janelas, abas e painéis. Aceita `--format table` ou `--format json`. |
| `bridge` | A ponte em JSON-lines usada pelo Studio (próxima seção). |
| `list-clients` | Lista os clientes conectados. |
| `proxy` | Inicia o proxy de RPC. |
| `tlscreds` | Obtém credenciais TLS. |
| `spawn` | Cria um comando em nova janela ou aba e imprime o id do painel. |
| `split-pane` | Divide um painel e imprime o id do novo. |
| `send-text` | Envia texto a um painel como se fosse colado. |
| `get-text` | Imprime o texto de um painel. |
| `kill-pane` | Fecha um painel. |
| `move-pane-to-new-tab` | Move um painel para uma aba nova. |
| `activate-pane`, `activate-pane-direction`, `get-pane-direction` | Foco e vizinhança de painéis. |
| `adjust-pane-size` | Ajusta o tamanho de um painel numa direção. |
| `activate-tab` | Ativa uma aba. |
| `set-tab-title`, `set-window-title`, `rename-workspace` | Mudam títulos e o nome do workspace. |
| `zoom-pane` | Amplia, restaura ou alterna o zoom. |

Para ver as opções de cada um, use `bethstudio.exe cli <subcomando> --help`.

## A ponte: `bethstudio.exe cli bridge`

Cliente de longa duração do host. Lê um pedido JSON por linha em stdin e escreve um evento JSON por linha em stdout. Conecta sempre ao host. Se perder a conexão, sai com código diferente de zero.

### Pedidos

| `op` | Campos | O que faz |
| --- | --- | --- |
| `list` | | Lista os painéis. |
| `watch` | `pane_id` ou `pane_ids` | Passa a enviar eventos `screen` desses painéis (substitui o conjunto anterior). |
| `send` | `pane_id`, `data` | Envia bytes crus ao PTY. |
| `paste` | `pane_id`, `data` | Cola com bracketed paste. |
| `scroll` | `pane_id`, `offset` | Define o deslocamento de rolagem mostrado. |
| `scrollback` | `pane_id`, `request_id?` | Pede o histórico completo e a tela visível em texto simples. |
| `palette` | `pane_id`, `background`, `foreground`, `cursor?`, `ansi?` (16 cores) | Envia o tema do Studio ao host (OSC 10/11), para agentes detectarem temas claros. |
| `resize` | `pane_id`, `cols`, `rows` | Redimensiona o painel no host (recusado se o painel não estiver sozinho em sua aba do host). |
| `kill` | `pane_id` | Fecha o terminal no host. O Studio pede confirmação antes. |
| `separate` | `pane_id` | Tira o painel de um split do host, para uma aba nova da mesma janela. |
| `shells` | | Pede a lista de shells para "novo terminal". |
| `spawn` | `shell_id`, `window_id?`, `cwd?`, `distro?`, `request_id?` | Abre um terminal no host. `distro` vale para shells WSL. |
| `spawn_tool` | `kind` (`ssh` ou `serial`), `id`, `window_id?`, `request_id?` | Abre `bethstudio-tool.exe --ssh|--serial <id>` como terminal novo, no workspace `beth-studio`. |

### Eventos

| `ev` | Campos | Significado |
| --- | --- | --- |
| `list` | `panes` | Mesmos itens de `cli list --format json`. |
| `screen` | `pane_id`, `cols`, `rows`, `cursor_x`, `cursor_y`, `cursor_visible`, `offset`, `scrollback`, `text` | A tela como instantâneo em SGR. Só é enviado quando o painel mudou. |
| `agent` | `pane_id`, `waiting`, `reason`, `detail` | Um agente no painel espera por você (`reason`: `bell`, `toast` ou `user_var`). |
| `shells` | `shells` (`id`, `label`) | Os shells disponíveis. |
| `spawned` | `request_id`, `pane_id`, `tab_id`, `window_id` | Resposta a `spawn` e `spawn_tool`. |
| `separated` | `pane_id`, `tab_id`, `window_id` | Resposta a `separate`. |
| `scrollback` | `request_id`, `pane_id`, `text` | Resposta a `scrollback`. |
| `pane_gone` | `pane_id` | Um painel observado não existe mais. |
| `error` | `message` | Erro ao tratar um pedido. |

Como desenhar o `text` de um `screen`: escreva `ESC[H ESC[2J` seguido de `text`, depois posicione o cursor. Veja também [Arquitetura](Arquitetura).

## bethstudio-web.exe

O Studio. Sem opções, abre a janela, sobe e vigia o host e põe o ícone na bandeja. O Studio é único: um segundo clique traz a janela já aberta.

| Opção | Efeito |
| --- | --- |
| `--bethstudio <caminho>` | Caminho do `bethstudio.exe`. Padrão: variável `BETHSTUDIO_EXE`, depois o arquivo ao lado do Studio, depois o build do repositório. |
| `--no-window` | Não abre a janela WebView2. Só imprime a URL (com token) e fica rodando. |
| `--read-only` | Recusa `send` e `paste` (só `list` e `watch`). Para testes. |
| `--port <n>` | Porta fixa na interface local (loopback). `0` (padrão) escolhe uma aleatória. |
| `--devtools` | Liga as DevTools do WebView2. |
| `--dev-origin <origem>` | Aceita uma origem extra (por exemplo o servidor de desenvolvimento do Vite). |
| `--open <ids>` | Painéis para abrir na interface, como `9` ou `9,10`. |
| `--window-size <LxA>` | Tamanho inicial da janela. Padrão `1440x900`. |
| `--diag` | A interface envia diagnósticos para o log. |
| `--sftp <id>` | Abre só a janela SFTP do host salvo (id hexadecimal de 16 dígitos). |
| `--db` | Abre só a janela Banco de dados. |
| `--term <pane>` | Abre só a janela destacada do terminal indicado (aberta pelo Studio). |
| `--supervise` | Liga a supervisão do host mesmo com `--no-window` (para testes). |

O log fica em `%LOCALAPPDATA%\bethstudio-web\bethstudio-web.log`. Veja [Instalação](Instalacao).

## bethstudio-tool.exe

O mesmo pacote do Studio como programa de console, sem janela e sem porta. É o que o host executa dentro de um terminal de ferramenta:

```
bethstudio-tool.exe --ssh <id>       sessão SSH de um host salvo
bethstudio-tool.exe --serial <id>    sessão de uma porta serial salva
```

Você não costuma chamá-lo à mão: o Studio o abre pelo pedido `spawn_tool`. Veja [SSH, serial e SFTP](SSH-serial-e-SFTP).

## bethstudio-proxy (Linux)

Programa opcional do acesso pelo celular. Opções: `--listen` (um endereço local com porta ou `unix:/caminho`), `--domain` (domínio aceito), `--data` (pasta da instalação) e `--service` (instala e inicia como serviço do systemd). Veja [Celular e acesso remoto](Celular-e-acesso-remoto).

## API HTTP e WebSocket do Studio

O Studio escuta só na interface local (loopback), em uma porta aleatória. Toda rota exige o token da execução (parâmetro `t`, cabeçalho `X-BethStudio-Token` ou o cookie definido no primeiro acesso) e confere o `Origin`. A interface é a única cliente prevista. A lista abaixo é para referência, não um contrato estável.

| Rota | Para que serve |
| --- | --- |
| `/` e arquivos estáticos | A interface React embutida. |
| `/ws` | WebSocket: o Studio recebe eventos da ponte e envia os pedidos permitidos. |
| `/healthz` | Responde `ok`. |
| `/api/about` | Sobre: executáveis, datas de build e arquivos de log. |
| `/api/update/check` | Há versão mais nova no GitHub? Não instala nada. |
| `/api/update/apply-ui`, `/api/update/prepare-setup`, `/api/update/open-setup` | Instalar só a interface, ou baixar e abrir o instalador. Só no Studio deste computador, depois de confirmar. |
| `/api/host/state`, `/api/host/retry` | Estado do host e "Tentar de novo". |
| `/api/term/list`, `detach`, `focus`, `close`, `drag` | Janelas de terminal destacadas. |
| `/api/themes`, `/api/fonts` | Catálogos de temas e fontes. |
| `/api/settings`, `/default`, `/pane`, `/pane-names`, `/sidebar`, `/ui`, `/ui-css`, `/clear-panes` | Configurações do Studio e por terminal. |
| `/api/favorites/theme`, `/api/favorites/font` | Favoritos. |
| `/api/layout` | Organização das abas e splits. |
| `/api/pane/scrollback`, `/api/pane/screenshot/save` | Histórico e captura de um terminal. |
| `/api/paste-image`, `/api/paste-file`, `/api/paste-clipboard` | Colar imagem ou arquivo. |
| `/api/local-file`, `/open-default`, `/save-as`, `/reveal`, `/write`, `/create`, `/open-dialog` | Editor e pré-visualização de arquivos. |
| `/api/local-fs/list`, `mkdir`, `remove`, `reveal` | Navegador de pastas. |
| `/api/notes`, `/read`, `/save`, `/delete` | Notas. |
| `/api/pick-folder`, `/api/open-link` | Escolher pasta e abrir um link. |
| `/api/ssh/hosts` (e `save`, `delete`, `duplicate`, `test`, `trust`, `forget-key`), `/api/ssh/config-import` | Hosts SSH salvos. |
| `/api/ssh/sftp/list`, `download`, `upload`, `mkdir`, `rename`, `remove`, `window`, `jobs` (e `enqueue`, `cancel`, `clear`) | SFTP e a fila de transferências. |
| `/api/serial/ports`, `profiles` (e `save`, `delete`, `duplicate`) | Portas e perfis seriais. |
| `/api/db/connections/save`, `delete`, `test`, `databases`, `schemas`, `objects`, `columns`, `table`, `query`, `row`, `apply`, `assist`, `more`, `cancel`, `queries`, `history`, `window` | Painel de banco de dados. |
| `/api/voice` e sub-rotas (`settings`, `key`, `test`, `models`, `transcribe`, `correct`, `catalog`, `tech-vocab` e outras) | Voz e IA. |
| `/api/ai-usage`, `/export`, `/open` | Consumo de IA. |
| `/api/sysmon` | Gerenciador de tarefas. |
| `/api/content` | Texto visível da tela dos terminais, para a busca "procurar também no conteúdo da tela". |
| `/api/phone/setup`, `/api/remote`, `/totp`, `/revoke` | Configuração do celular e do Studio remoto, e sessões remotas. |
| `/api/log`, `/api/diag` | Log e diagnóstico da interface. |

A página do celular tem um conjunto menor de rotas, atrás de login: `/api/phone/login`, `logout`, `me`, `names`, `image`, as rotas `/api/voice` permitidas e `/ws`. Rotas que abririam algo na tela do computador (seletor de pasta, Explorer, janelas nativas) não existem no Studio remoto. Detalhes em [Celular e acesso remoto](Celular-e-acesso-remoto) e [Segurança e privacidade](Seguranca-e-privacidade).

## Variáveis de ambiente

Veja a lista em [Instalação](Instalacao).
