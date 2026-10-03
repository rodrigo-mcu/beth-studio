# Arquitetura

O Beth Studio tem três programas e um conjunto de terminais. O host é dono dos terminais, a ponte conversa com ele e o Studio mostra tudo na tela.

## Visão geral

```
 navegador / WebView2 (React + xterm.js)
        |
        |  HTTP + WebSocket   (só local, porta aleatória, token)
        v
 bethstudio-web.exe  (Studio, Go)  -------- supervisiona / reinicia ------+
        |                                                                 |
        |  JSON em linhas (stdin / stdout)                                |
        v                                                                 v
 bethstudio.exe cli bridge  ------------ mux (socket) ------->  bethstudio-host.exe
        (ponte)                                                (dono dos PTYs)
                                                                   |
                                                       ConPTY (OpenConsole.exe)
                                                                   |
                                                    PowerShell, cmd, WSL, agentes...
```

Pontos importantes:

- Fechar o Studio não encerra terminal. Os shells vivem no host.
- A ponte nunca fala com o Studio por rede: é um processo filho, ligado por entrada e saída padrão.
- O navegador nunca fala direto com a ponte nem com provedores externos. Todas as chamadas de rede saem do Go.
- Existe um único host. A ideia de "um host por janela" foi testada e revertida (patch 0167).

## Responsabilidades

| Executável | Pacote | O que faz |
| --- | --- | --- |
| `bethstudio-host.exe` | Cargo `wezterm-mux-server` | Dono dos terminais (PTYs). Sobrevive a qualquer janela. Só sai quando o usuário confirma **Encerrar tudo**. |
| `bethstudio.exe` | Cargo `wezterm` | A CLI e o `cli bridge`, o único caminho do Studio até o host. Veja [Referência da CLI e da API](Referencia-da-CLI-e-API). |
| `bethstudio-web.exe` | Go (`bethstudio-web/`) | O Studio. Serve a interface React embutida, abre a janela WebView2, sobe o host se não houver um, reinicia o host após uma queda, restaura os terminais e cuida do ícone da bandeja. |
| `bethstudio-tool.exe` | Go (mesmo pacote) | Versão de console do Studio, usada como terminal de ferramenta (SSH e serial) dentro de um terminal do host. |
| `BethStudio-Setup.exe` | Cargo `bethstudio-setup` | Instalador e atualizador (janela Win32 com o pacote zstd embutido). Veja [Instalação](Instalacao). |
| `bethstudio-proxy` | Go (`bethstudio-web/cmd/bethstudio-proxy`) | Programa Linux opcional para o acesso pelo celular e pelo navegador remoto. Veja [Celular e acesso remoto](Celular-e-acesso-remoto). |

O Studio supervisiona o host (sobe, reinicia no máximo 3 vezes em 10 minutos), mas nunca o encerra por conta própria. Detalhes em [Host persistente e restauração](Host-persistente-e-restauracao) e [Bandeja e supervisão](Bandeja-e-supervisao).

## Fluxo de uma tecla

```
tecla no xterm.js (WebView2)
  -> Studio (WebSocket)
  -> ponte (linha JSON: send ou paste)
  -> cliente do mux -> host
  -> terminal (escreve no PTY; a saída passa pelo parser de escapes)
  -> tela do terminal
  -> evento "screen" da ponte -> Studio -> WebSocket -> xterm.js
```

## Protocolo da ponte

A ponte (`bethstudio cli bridge`) é um cliente do mux de longa duração. Cada linha de entrada é um pedido JSON; cada linha de saída é um evento JSON. Ela sempre se liga ao host. Se a conexão com o host cair, a ponte sai com código diferente de zero e o Studio inicia uma nova.

- Pedidos (campo `op`): `list`, `watch`, `send`, `paste`, `scroll`, `scrollback`, `palette`, `resize`, `kill`, `separate`, `shells`, `spawn`, `spawn_tool`.
- Eventos (campo `ev`): `list`, `screen`, `error`, `pane_gone`, `separated`, `shells`, `spawned`, `scrollback`, `agent`.
- O evento `screen` traz o terminal como um instantâneo em SGR. O campo `text` é a tela visível como sequências SGR, com as linhas separadas por CRLF e sem quebra no fim. Para desenhar: escreva `ESC[H ESC[2J` mais o `text` e depois posicione o cursor. Um `screen` só é enviado quando o terminal mudou.
- Outros campos de `screen`: `pane_id`, `cols`, `rows`, `cursor_x`, `cursor_y`, `cursor_visible`, `offset` (rolagem mostrada) e `scrollback` (linhas acima da tela).

A lista completa, com campos, está em [Referência da CLI e da API](Referencia-da-CLI-e-API).

## Estratégia: base congelada e delta

O código do WezTerm que o Beth Studio compila está copiado em `upstream-wezterm/`. O que é novo vive principalmente no crate `wtinator`. Cada edição de um arquivo que já existia no WezTerm é um patch numerado e documentado. Veja [Relação com o WezTerm](Relacao-com-o-WezTerm).

## Pastas do repositório

| Caminho | O que é |
| --- | --- |
| `upstream-wezterm/` | A árvore do WezTerm (copiada) mais o delta do Beth Studio. Raiz do workspace Cargo. |
| `upstream-wezterm/wtinator/` | O crate do delta (nome histórico, mantido). |
| `upstream-wezterm/wezterm/` | A CLI e a ponte (`bethstudio.exe`). |
| `upstream-wezterm/wezterm-mux-server/` | O host (`bethstudio-host.exe`). |
| `upstream-wezterm/bethstudio-setup/` | O instalador. |
| `upstream-wezterm/PATCHES.md` e `patches/` | Índice e notas de cada patch. |
| `bethstudio-web/` | O Studio: backend Go, `frontend/` (React), `cmd/bethstudio-proxy`, `tools/`. |
| `bethstudio-mobile/` | Esqueleto de um app Expo. Não é o caminho do celular que funciona. |
| `docs/` | Documentação de arquitetura, configuração, histórico e especificações. |
| `dist/` | Saída do empacotador (`BethStudio-Setup.exe`). |

## Módulos que sobraram no wtinator

Depois que a janela nativa saiu (patch 0198), o `wtinator` guarda só o que o host e a ponte usam:

`agent_wait`, `config_lua`, `default_theme`, `echo_latency`, `groups`, `host`, `notify`, `notify_ipc`, `pane_cmd`, `session`, `shells`, `taskbar_icon`, `theme_download`, `vscode_theme` e `window_geom`.

## Veja também

- [Home](Home)
- [Compilar do código](Compilar-do-codigo)
- [Segurança e privacidade](Seguranca-e-privacidade)
